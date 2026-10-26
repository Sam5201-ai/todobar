//! 系统剪贴板历史(Clipboard History)后台模块。
//!
//! 设计要点:
//! - **后台常驻监听**:Rust 线程用 `GetClipboardSequenceNumber` 轮询(250ms),
//!   只有序号变化才真正读剪贴板 —— 不调用 `OpenClipboard` 时零竞争、零 CPU 占用,
//!   比 `AddClipboardFormatListener`(需隐藏 HWND + 消息循环、与 Tauri 事件循环耦合)更稳。
//! - **只记纯文本**:仅读取 `CF_UNICODETEXT`,图片/文件直接跳过,且不覆盖已有历史。
//! - **跳过密码(概率行为)**:三级启发式 —— ① 系统排除标记
//!   (`ExcludeClipboardContentFromMonitorProcessing`,即 Win+V 同款机制) ② 来源进程是
//!   密码管理器 ③ 内容评分(长度/字符类别/是否 URL·邮箱·路径等)。
//! - **不记录自身写入**:`clipboard_write_text` / `copy_back` 写入系统剪贴板时打
//!   self-write 时间戳 + 内容指纹,监听线程在 2s 窗口内识别为自身写入并跳过。
//! - **独立浮窗**:`clipboard` 窗口由快捷键/托盘菜单唤起,隐藏式复用(探活 ghost)。
//!
//! ⚠️ 与既有坑一致:Rust 侧**绝不在同步命令内联 build 窗口**(死锁);新窗口
//! `additional_browser_args` 必须与主窗口完全一致;build() Ok ≠ 创建成功(需探活)。
//! 这些铁律在 `open_clipboard_window` 里逐条遵守,改动本文件时务必沿用。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 剪贴板浮窗 label。
const WINDOW_LABEL: &str = "clipboard";

/// 浮窗尺寸(窗口比卡片四周各大 14px 透明边距,卡片 440×572)。
const WIN_W: f64 = 468.0;
const WIN_H: f64 = 600.0;

/// CF_UNICODETEXT 的数值常数(避免依赖具体导出位置)。
const CF_UNICODETEXT: u32 = 13;

// ——————————————————————————— 数据模型 ———————————————————————————

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct ClipItem {
    id: String,
    text: String,
    preview: String,
    created_at: i64,
    source: Option<String>,
    pinned: bool,
    #[serde(default)]
    pinned_at: i64,
    len: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct ClipConfig {
    /// 总开关。
    enabled: bool,
    /// 暂停记录(用户临时不想记)。
    paused: bool,
    /// 保留条数上限。
    max_count: usize,
    /// 跳过密码(概率行为)。
    skip_password: bool,
    /// 显示来源进程名。
    show_source: bool,
    /// 选中后自动粘贴到上一个窗口(默认关,受 UAC 隔离风险)。
    auto_paste: bool,
    /// 单条最大字符数,超过则跳过。
    max_chars: usize,
}

impl Default for ClipConfig {
    fn default() -> Self {
        ClipConfig {
            enabled: true,
            paused: false,
            max_count: 50,
            skip_password: true,
            show_source: true,
            auto_paste: false,
            max_chars: 20000,
        }
    }
}

// ——————————————————————————— 进程级状态 ———————————————————————————

fn history_cell() -> &'static Mutex<Vec<ClipItem>> {
    static H: OnceLock<Mutex<Vec<ClipItem>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(Vec::new()))
}

fn config_cell() -> &'static Mutex<ClipConfig> {
    static C: OnceLock<Mutex<ClipConfig>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(ClipConfig::default()))
}

/// 自身写入闸门:写入时刻 + 内容指纹(hash),2s 内相同内容判为自身写入。
fn self_write_cell() -> &'static Mutex<Option<(Instant, u64)>> {
    static S: OnceLock<Mutex<Option<(Instant, u64)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

/// 全局 AppHandle(setup 阶段写入),供后台线程向浮窗发事件。
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// 浮窗托管的快捷键与「上一个前台窗口」(自动粘贴用)。
pub struct ClipboardState {
    shortcut: Mutex<String>,
    prev_hwnd: Mutex<Option<usize>>,
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self {
            shortcut: Mutex::new(String::new()),
            prev_hwnd: Mutex::new(None),
        }
    }
}

// ——————————————————————————— 磁盘持久化 ———————————————————————————

fn clipboard_path(ext: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    Some(
        PathBuf::from(home)
            .join(".ticktask")
            .join(format!("clipboard-history.{ext}")),
    )
}

fn load_history() {
    if let Some(p) = clipboard_path("json") {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Vec<ClipItem>>(&s) {
                *history_cell().lock().unwrap() = v;
            }
        }
    }
}

fn save_history() {
    if let Some(p) = clipboard_path("json") {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string(history_cell().lock().unwrap().as_slice()) {
            // 原子写:先写 .tmp 再 rename,避免半截文件。
            let tmp = p.with_extension("json.tmp");
            if std::fs::write(&tmp, &s).is_ok() {
                let _ = std::fs::rename(&tmp, &p);
            }
        }
    }
}

// ——————————————————————————— 工具函数 ———————————————————————————

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// FNV-1a 64 位哈希,仅用于 self-write 内容指纹比对。
fn hash_text(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 单行化预览:折叠空白,截断到 140 字符。
fn preview_of(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() > 140 {
        let mut out = String::new();
        for c in flat.chars() {
            if out.chars().count() >= 137 {
                break;
            }
            out.push(c);
        }
        format!("{out}…")
    } else {
        flat
    }
}

// ——————————————————————————— Windows 剪贴板访问 ———————————————————————————

#[cfg(windows)]
fn clipboard_excluded() -> bool {
    use windows::Win32::System::DataExchange::{EnumClipboardFormats, RegisterClipboardFormatW};
    let id = unsafe { RegisterClipboardFormatW(windows::core::w!("ExcludeClipboardContentFromMonitorProcessing")) };
    if id == 0 {
        return false;
    }
    let mut fmt = 0u32;
    unsafe {
        loop {
            fmt = EnumClipboardFormats(fmt);
            if fmt == 0 {
                break;
            }
            if fmt == id {
                return true;
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn clipboard_excluded() -> bool {
    false
}

/// 读取当前前台进程文件名(来源应用),best-effort。
#[cfg(windows)]
fn foreground_app_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let h = match OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return None,
        };
        if h.is_invalid() {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let name = if QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
        {
            let s = String::from_utf16_lossy(&buf[..size as usize]);
            std::path::Path::new(&s)
                .file_name()
                .and_then(|f| f.to_str())
                .map(|s| s.to_string())
        } else {
            None
        };
        let _ = CloseHandle(h);
        name
    }
}

#[cfg(not(windows))]
fn foreground_app_name() -> Option<String> {
    None
}

/// 读取剪贴板纯文本;同时做排除标记检查。返回 (文本, 来源进程名)。
#[cfg(windows)]
fn read_clipboard_text() -> Option<(String, Option<String>)> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::GlobalLock;
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        if clipboard_excluded() {
            let _ = CloseClipboard();
            return None;
        }
        let h = match GetClipboardData(CF_UNICODETEXT) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return None;
            }
        };
        let p = GlobalLock(HGLOBAL(h.0)) as *const u16;
        if p.is_null() {
            let _ = CloseClipboard();
            return None;
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
        let _ = windows::Win32::System::Memory::GlobalUnlock(HGLOBAL(h.0));
        let _ = CloseClipboard();
        if text.is_empty() {
            return None;
        }
        let source = foreground_app_name();
        Some((text, source))
    }
}

#[cfg(not(windows))]
fn read_clipboard_text() -> Option<(String, Option<String>)> {
    None
}

// ——————————————————————————— 密码启发式 ———————————————————————————

/// 是否明显不是密码(URL / 邮箱 / 路径 / 纯数字 / UUID / 日期 / 版本号 / JSON / 代码)。
fn obvious_non_password(t: &str) -> bool {
    if t.starts_with("http") || t.starts_with("www.") || t.starts_with("mailto:") {
        return true;
    }
    if t.contains("://") {
        return true;
    }
    // 邮箱:含 @ 且 @ 后有 '.'
    if let Some(at) = t.find('@') {
        if t[at + 1..].contains('.') {
            return true;
        }
    }
    // 路径:含 \ 或 /(且非纯 http 已判)
    if t.contains('\\') || (t.contains('/') && t.len() > 1) {
        return true;
    }
    // 纯数字
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // JSON / 代码块
    if t.starts_with('{') || t.starts_with('[') || t.starts_with('(') {
        return true;
    }
    // UUID(8-4-4-4-12 十六进制)
    if t.len() == 36
        && t.chars().enumerate().all(|(i, c)| {
            c.is_ascii_hexdigit() || c == '-' && matches!(i, 8 | 13 | 18 | 23)
        })
    {
        return true;
    }
    false
}

/// 内容评分:≥6 判为疑似密码(仅当 skip_password 时调用)。
fn looks_like_password(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || obvious_non_password(t) {
        return false;
    }
    let len = t.chars().count();
    if len < 6 || len > 64 {
        return false;
    }
    if t.contains(char::is_whitespace) {
        return false;
    }
    if t.chars().any(|c| ('一'..='鿿').contains(&c)) {
        return false;
    }
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let mut has_lower = false;
    let mut has_upper = false;
    let mut has_digit = false;
    let mut has_sym = false;
    for c in t.chars() {
        if c.is_ascii_lowercase() {
            has_lower = true;
        } else if c.is_ascii_uppercase() {
            has_upper = true;
        } else if c.is_ascii_digit() {
            has_digit = true;
        } else {
            has_sym = true;
        }
    }
    let classes = [has_lower, has_upper, has_digit, has_sym]
        .iter()
        .filter(|x| **x)
        .count();

    let mut score = 1; // 长度 6..64
    score += 1; // 无空白
    score += 1; // 非 CJK
    if classes >= 3 {
        score += 2;
    }
    if has_lower && has_upper && has_digit && has_sym {
        score += 2;
    }
    score >= 6
}

/// 来源进程是否属于已知密码管理器。
fn is_password_manager(source: &Option<String>) -> bool {
    match source {
        Some(s) => {
            let s = s.to_ascii_lowercase();
            ["bitwarden.exe", "1password.exe", "keepass.exe", "keepassxc.exe", "enpass.exe"]
                .iter()
                .any(|m| s == *m)
        }
        None => false,
    }
}

// ——————————————————————————— 入历史主流程 ———————————————————————————

fn is_self_write(text_hash: u64) -> bool {
    let mut g = self_write_cell().lock().unwrap();
    if let Some((t, h)) = *g {
        if t.elapsed() < Duration::from_millis(2000) {
            if h == text_hash {
                *g = None; // 消费闸门
                return true;
            }
            // 窗口内但内容不同:视为其他程序的真实复制,不消费(留待到期)
        }
    }
    false
}

fn push_item(text: String, source: Option<String>) {
    let cfg = config_cell().lock().unwrap().clone();
    if text.trim().is_empty() {
        return;
    }
    let hash = hash_text(&text);
    if is_self_write(hash) {
        return;
    }
    if text.chars().count() > cfg.max_chars {
        return;
    }
    if cfg.skip_password {
        if is_password_manager(&source) {
            return;
        }
        if looks_like_password(&text) {
            crate::append_app_log("[clipboard] 跳过疑似密码内容");
            return;
        }
    }

    let mut hist = history_cell().lock().unwrap();
    // 与最新一条完全相同 → 跳过(去抖)
    if let Some(front) = hist.first() {
        if front.text == text {
            return;
        }
    }
    // 与历史中第 k 条相同 → 移到顶部并刷新时间戳(保持"最近使用")
    for i in 0..hist.len() {
        if hist[i].text == text {
            let mut item = hist.remove(i);
            item.created_at = now_ms();
            hist.insert(0, item);
            drop(hist);
            save_history();
            emit_changed();
            return;
        }
    }

    let id = format!("{}-{}", now_ms(), hash % 100000);
    let preview = preview_of(&text);
    let len = text.chars().count();
    let source = if cfg.show_source { source } else { None };
    hist.insert(
        0,
        ClipItem {
            id,
            text,
            preview,
            created_at: now_ms(),
            source,
            pinned: false,
            pinned_at: 0,
            len,
        },
    );

    // 淘汰:超上限时从尾部移除最旧的非置顶项;若剩余全置顶则不强行淘汰。
    while hist.len() > cfg.max_count {
        if let Some(pos) = hist.iter().rposition(|it| !it.pinned) {
            hist.remove(pos);
        } else {
            break;
        }
    }
    drop(hist);
    save_history();
    emit_changed();
}

fn emit_changed() {
    // 浮窗不存在时 emit 为 no-op,安全。
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit_to(WINDOW_LABEL, "clipboard-changed", ());
    }
}

// ——————————————————————————— 后台监听线程 ———————————————————————————

/// 启动后台监听(在 setup 阶段调用一次)。
pub fn start_monitor(app: tauri::AppHandle) {
    if MONITOR_RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已启动
    }
    let _ = APP_HANDLE.get_or_init(|| app.clone());
    load_history();
    std::thread::spawn(move || {
        crate::append_app_log("[clipboard] monitor started");
        #[cfg(windows)]
        let mut last_seq = unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        #[cfg(not(windows))]
        let mut last_seq: u32 = 0;
        while MONITOR_RUNNING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
            let cfg_enabled = config_cell().lock().unwrap().enabled;
            let cfg_paused = config_cell().lock().unwrap().paused;
            if !cfg_enabled || cfg_paused {
                #[cfg(windows)]
                {
                    last_seq = unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() };
                }
                continue;
            }
            #[cfg(windows)]
            let seq = unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() };
            #[cfg(not(windows))]
            let seq: u32 = 0;
            if seq == last_seq {
                continue;
            }
            last_seq = seq;
            if let Some((text, source)) = read_clipboard_text() {
                push_item(text, source);
            }
        }
        crate::append_app_log("[clipboard] monitor stopped");
    });
}

// ——————————————————————————— 窗口探活/打开 ———————————————————————————

fn probe_alive(win: &WebviewWindow) -> bool {
    for _ in 0..3 {
        if win.is_visible().is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 唤起 / 收起剪贴板浮窗。
///
/// 快捷键 / 托盘菜单调用。捕获「上一个前台窗口」(用户的真实目标 app)用于自动粘贴。
/// 窗已在且可见 → 收起;否则(复用/新建)显示。
pub fn open_clipboard_window(app: tauri::AppHandle) {
    // 唤起瞬间,前台是用户正在用的目标 app,记下 HWND 供自动粘贴用。
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let hwnd = unsafe { GetForegroundWindow().0 as usize };
        *app.state::<ClipboardState>().prev_hwnd.lock().unwrap() = Some(hwnd);
    }

    std::thread::spawn(move || {
        // 已有活窗口 → 复用(可见则收起,否则显示)
        if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
            if probe_alive(&existing) {
                if existing.is_visible().unwrap_or(false) {
                    let _ = existing.hide();
                } else {
                    let _ = existing.show();
                    let _ = existing.set_focus();
                }
                return;
            }
            let _ = existing.close();
            std::thread::sleep(Duration::from_millis(120));
        }

        let builder = WebviewWindowBuilder::new(
            &app,
            WINDOW_LABEL,
            WebviewUrl::App(PathBuf::new()),
        )
        .title("TickTask 剪贴板")
        // ⚠️ 必须与主窗口 additionalBrowserArgs 完全一致(0.4.38 血案根因)。
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream",
        )
        .inner_size(WIN_W, WIN_H)
        .decorations(false)
        .transparent(true)
        .visible(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false);

        match builder.build() {
            Ok(win) => {
                if probe_alive(&win) {
                    crate::append_app_log("[clipboard] window created");
                } else {
                    crate::append_app_log("[clipboard] build() Ok 但探活失败(ghost)");
                    let _ = win.close();
                }
            }
            Err(e) => crate::append_app_log(&format!("[clipboard] window 创建失败: {e}")),
        }
    });
}

/// 收起浮窗(前端 Esc / 失焦调用)。
#[tauri::command]
pub fn clipboard_hide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

// ——————————————————————————— 命令 ———————————————————————————

#[tauri::command]
pub fn clipboard_list() -> Vec<ClipItem> {
    let mut v = history_cell().lock().unwrap().clone();
    // 置顶项恒在最前;组内:pinned 按置顶时刻倒序(刚置顶最前),未置顶按创建时刻倒序(最新在前)。
    v.sort_by(|a, b| {
        if a.pinned != b.pinned {
            return if a.pinned {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if a.pinned && b.pinned {
            return b.pinned_at.cmp(&a.pinned_at);
        }
        b.created_at.cmp(&a.created_at)
    });
    v
}

#[tauri::command]
pub fn clipboard_delete(id: String) -> Result<(), String> {
    let mut hist = history_cell().lock().unwrap();
    if let Some(pos) = hist.iter().position(|it| it.id == id) {
        hist.remove(pos);
        drop(hist);
        save_history();
        emit_changed();
        Ok(())
    } else {
        Err("未找到该条目".to_string())
    }
}

#[tauri::command]
pub fn clipboard_clear() -> Result<(), String> {
    history_cell().lock().unwrap().clear();
    save_history();
    emit_changed();
    Ok(())
}

#[tauri::command]
pub fn clipboard_pin(id: String, pinned: bool) -> Result<(), String> {
    let mut hist = history_cell().lock().unwrap();
    if let Some(it) = hist.iter_mut().find(|it| it.id == id) {
        it.pinned = pinned;
        it.pinned_at = if pinned { now_ms() } else { 0 };
        drop(hist);
        save_history();
        emit_changed();
        Ok(())
    } else {
        Err("未找到该条目".to_string())
    }
}

#[tauri::command]
pub fn clipboard_set_paused(paused: bool) -> Result<(), String> {
    config_cell().lock().unwrap().paused = paused;
    Ok(())
}

#[tauri::command]
pub fn clipboard_set_config(value: String) -> Result<(), String> {
    let parsed: ClipConfig = serde_json::from_str(&value)
        .map_err(|e| format!("剪贴板配置解析失败: {e}"))?;
    *config_cell().lock().unwrap() = parsed;
    Ok(())
}

/// 写入系统剪贴板(供前端统一复制通道:任务复制、激活码复制等)。
/// 写入时打 self-write 标记,监听线程据此跳过自身内容。
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    set_clipboard_text(&text);
    *self_write_cell().lock().unwrap() = Some((Instant::now(), hash_text(&text)));
    Ok(())
}

/// 选中某条 → 写回系统剪贴板(自带 self-write 标记,不污染历史)。
/// 若开启自动粘贴,则收起窗口并把内容粘贴到上一个前台窗口。
#[tauri::command]
pub fn clipboard_copy_back(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let text = {
        let hist = history_cell().lock().unwrap();
        hist.iter().find(|it| it.id == id).map(|it| it.text.clone())
    };
    let text = match text {
        Some(t) => t,
        None => return Err("未找到该条目".to_string()),
    };

    set_clipboard_text(&text);
    *self_write_cell().lock().unwrap() = Some((Instant::now(), hash_text(&text)));

    let auto_paste = config_cell().lock().unwrap().auto_paste;
    if !auto_paste {
        return Ok(false);
    }

    // 收起浮窗 → 还原焦点 → 发送 Ctrl+V。
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.hide();
    }
    let pasted = paste_to_prev(&app);
    Ok(pasted)
}

/// 设置页注册 / 注销「唤出剪贴板」全局快捷键(空串表示注销)。
#[tauri::command]
pub fn register_clipboard_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClipboardState>,
    shortcut: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    let prev = state.shortcut.lock().unwrap().clone();
    if !prev.trim().is_empty() {
        let _ = gs.unregister(prev.as_str());
    }
    let sc = shortcut.trim().to_string();
    if sc.is_empty() {
        *state.shortcut.lock().unwrap() = String::new();
        return Ok(());
    }
    gs.on_shortcut(sc.as_str(), move |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            open_clipboard_window(app.clone());
        }
    })
    .map_err(|e| format!("剪贴板快捷键 “{sc}” 注册失败: {e}"))?;
    crate::append_app_log(&format!("[clipboard] 快捷键已注册: {sc}"));
    *state.shortcut.lock().unwrap() = sc;
    Ok(())
}

// ——————————————————————————— 系统剪贴板写入 / 粘贴 ———————————————————————————

#[cfg(windows)]
fn set_clipboard_text(text: &str) {
    use arboard::Clipboard;
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(text);
    }
}

#[cfg(not(windows))]
fn set_clipboard_text(_text: &str) {}

/// 把焦点还给上一个前台窗口并发送 Ctrl+V;失败(如提权窗口)返回 false。
#[cfg(windows)]
fn paste_to_prev(app: &tauri::AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_CONTROL, VIRTUAL_KEY, VkKeyScanW,
    };

    let prev = *app.state::<ClipboardState>().prev_hwnd.lock().unwrap();
    if let Some(hwnd) = prev {
        unsafe {
            let _ = SetForegroundWindow(windows::Win32::Foundation::HWND(hwnd as *mut core::ffi::c_void));
        }
    }
    // 稍等窗口切换完成再发键。
    std::thread::sleep(Duration::from_millis(120));

    let vk_v = (unsafe { VkKeyScanW('v' as u16) } & 0xff) as u16;
    let mut inputs: [INPUT; 4] = unsafe { std::mem::zeroed() };
    // Ctrl down
    inputs[0].r#type = INPUT_KEYBOARD;
    inputs[0].Anonymous.ki.wVk = VK_CONTROL;
    // V down
    inputs[1].r#type = INPUT_KEYBOARD;
    inputs[1].Anonymous.ki.wVk = VIRTUAL_KEY(vk_v);
    // V up
    inputs[2].r#type = INPUT_KEYBOARD;
    inputs[2].Anonymous.ki.wVk = VIRTUAL_KEY(vk_v);
    inputs[2].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
    // Ctrl up
    inputs[3].r#type = INPUT_KEYBOARD;
    inputs[3].Anonymous.ki.wVk = VK_CONTROL;
    inputs[3].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;

    let n = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if n == 0 {
        crate::append_app_log("[clipboard] SendInput 失败(可能目标为提权窗口)");
        return false;
    }
    true
}

#[cfg(not(windows))]
fn paste_to_prev(_app: &tauri::AppHandle) -> bool {
    false
}
