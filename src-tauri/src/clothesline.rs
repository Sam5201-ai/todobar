//! 顶部晾衣绳 (Clothesline) —— 第三个独立桌面层。阶段 0：技术验证分支。
//!
//! 本阶段只做「安全地基」，**不渲染任何卡片**：一条空绳 + 总开关 + 截图防污染 +
//! 独立命中循环 + 稳定屏身份。卡片 / 排序 / 飞入 / 配额在后续阶段接入。
//!
//! ⚠️ 以下铁律来自 0.4.64 真实源码核对（PRD §14.4 / §14.5），改动本文件务必逐条守住：
//!
//! 1. **数据独立**：只读写 `~/.ticktask/clothesline/`，绝不调用 `crate::set_pref`。
//!    `set_pref` 是「读整 prefs.json → 改一键 → 整文件覆盖」，多窗口并发会互相覆盖，
//!    把主题 / 宽度 / 快捷键 / 登录态丢掉（R60）。
//! 2. **截图防污染 R54（最高危）**：`capture_screen` 用 GDI BitBlt 抓「桌面合成帧」，
//!    默认 TOPMOST 的绳窗会被拍进每一张截图 / 贴图 / OCR。抓屏前必须 `capture_suspend`
//!    隐藏绳窗并等 DWM 合成生效，抓完（含所有错误路径，用 RAII guard）再 `capture_resume`。
//! 3. **独立命中循环 R68**：Rust 侧没有可挂的 48ms 循环（主窗的是 App.tsx 前端 setInterval）。
//!    绳窗自建独立线程，48ms 无条件重发 `set_ignore_cursor_events`（防穿透锁死），
//!    **绝不改主窗 syncHitTest / dock.ts**。
//! 4. **双端编译 R65**：所有平台相关代码严格 `#[cfg(windows)]` / `#[cfg(not(windows))]`。
//!    macOS 无抓屏实现（screenshot.rs 占位报错），本模块在 mac 上必须能编译且不建窗。
//! 5. **动态建窗**：子线程 build + `crate::BROWSER_ARGS` 逐字一致 + `probe_alive`
//!    （同步命令内联 build 会死锁、build() Ok ≠ 成功）。总开关关闭 = 进程级零残留。
//! 6. **零新依赖**：FFI 用 `windows` crate 已启用 feature 直接声明；不新增 cargo 依赖。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow};

/// 晾衣绳窗口 label（前端 main.tsx 用等值路由到 ClotheslineView）。
pub const LABEL: &str = "clothesline";

// ————————————————————————— 配置（独立存储，绝不写 prefs.json）—————————————————————————

/// 绳窗偏好。对应 v1.6 配置页 6 项 + 内部字段（配置页不镜像内部字段）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClotheslineSettings {
    /// 总开关（唯一熔断点）。默认 false：老用户升级后完全不建窗、不建线程。
    pub enabled: bool,
    /// 开机自动显示（默认 true，但受 enabled 闸门约束）。
    pub auto_show_on_boot: bool,
    /// 展开态（默认 true；收起态只留把手竖条 + 下拉绳）。
    pub expanded: bool,
    /// 上次实际落屏的稳定 ID（"" = 首次启用，跟随主屏并立即自固化）。
    pub monitor_stable_id: String,
    /// 清风动效（默认 true；产品日常用极淡摆动档）。
    pub wind_effect: bool,
    /// 截图自动飞入（默认 true）。
    pub auto_fly_shot: bool,
    /// 是否置顶（v1.3 唯一真源；配置页不镜像，入口在 ＋ 菜单第 7 行）。
    pub always_on_top: bool,
    /// 绳带垂直位置（物理像素，距目标屏工作区顶部）。
    pub anchor_y: i32,
    /// 收起态下拉绳把手水平位置（0.0~1.0）。
    pub pulltab_x_ratio: f64,
}

impl Default for ClotheslineSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_show_on_boot: true,
            expanded: true,
            monitor_stable_id: String::new(),
            wind_effect: true,
            auto_fly_shot: true,
            always_on_top: true,
            anchor_y: 72,
            pulltab_x_ratio: 0.5,
        }
    }
}

/// 越界 / 脏值回落默认，避免手动改坏 settings.json 后崩溃。
fn sanitize(raw: ClotheslineSettings) -> ClotheslineSettings {
    let mut s = raw;
    if s.anchor_y < 0 {
        s.anchor_y = 72;
    }
    s.anchor_y = s.anchor_y.min(360);
    if !s.pulltab_x_ratio.is_finite() {
        s.pulltab_x_ratio = 0.5;
    }
    s.pulltab_x_ratio = s.pulltab_x_ratio.clamp(0.05, 0.95);
    s.monitor_stable_id = s.monitor_stable_id.chars().take(200).collect();
    s
}

fn base_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".ticktask"))
}

fn settings_path(base: &Path) -> PathBuf {
    base.join("clothesline").join("settings.json")
}

/// tmp + rename 原子写：中途断电 / 崩溃不会留下半截 JSON。
fn save_settings_to(base: &Path, s: &ClotheslineSettings) -> Result<(), String> {
    let dir = base.join("clothesline");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建晾衣绳数据目录失败: {e}"))?;
    let final_path = settings_path(base);
    let tmp = dir.join("settings.json.tmp");
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("写 settings 临时文件失败: {e}"))?;
    // Windows 上 rename 到已存在目标会失败，先删目标（删失败也继续，让 rename 报错再到日志）。
    if final_path.exists() {
        let _ = std::fs::remove_file(&final_path);
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| format!("settings 原子替换失败: {e}"))?;
    Ok(())
}

fn load_settings_from(base: &Path) -> ClotheslineSettings {
    match std::fs::read_to_string(settings_path(base)) {
        Ok(s) => match serde_json::from_str::<ClotheslineSettings>(&s) {
            Ok(v) => sanitize(v),
            Err(e) => {
                crate::append_app_log(&format!("[clothesline] settings 解析失败，回落默认: {e}"));
                ClotheslineSettings::default()
            }
        },
        Err(_) => ClotheslineSettings::default(),
    }
}

fn load_settings() -> ClotheslineSettings {
    base_dir().map(|b| load_settings_from(&b)).unwrap_or_default()
}

// ————————————————————————— 托管状态 —————————————————————————

/// Arc 内层：让 ClotheslineState 可廉价 clone 进子线程（Mutex/Atomic 本身不 Clone）。
/// Deref 到内层后，所有 `state.enabled` 等字段访问保持不变。
#[derive(Clone, Default)]
pub struct ClotheslineState(std::sync::Arc<ClotheslineStateInner>);

impl std::ops::Deref for ClotheslineState {
    type Target = ClotheslineStateInner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[derive(Default)]
pub struct ClotheslineStateInner {
    /// 总开关内存镜像（仅 enabled 时存在窗口 / 循环 / 挂起逻辑）。
    pub enabled: AtomicBool,
    /// 可点矩形（**屏幕绝对物理坐标**），由前端布局后上报。
    /// - 非空：仅当光标落在任一矩形内才可点，其余区域穿透（收起态 = 只有把手竖条）。
    /// - 空数组：整窗可点（展开态），穿透恒 false。
    /// ⚠️ 光标命中判定必须在 Rust 侧用 OS 轮询，**绝不能靠前端 pointermove 写回**：
    ///    窗口一旦 set_ignore_cursor_events(true) 就收不到任何鼠标事件，前端无法把自己
    ///    改回可点 → 点击穿透永久锁死（PRD R68 / 项目 MEMORY 铁律）。
    pub hit_rects: Mutex<Vec<HitRect>>,
    /// 前端拖拽期间的「临时强制可点」请求（退出拖拽会清）。每轮循环以 OS 命中为准覆盖。
    pub force_clickable_until: Mutex<Option<std::time::Instant>>,
    /// 独立命中循环的停止标志。关闭总开关即置 true，线程下一轮 48ms 自行退出。
    pub stop_loop: AtomicBool,
    /// 命中循环是否已启动（防止重复 spawn 堆积线程）。
    pub loop_running: AtomicBool,
    /// 截图挂起深度（支持前端会话级 + capture_screen 自守卫嵌套）。
    pub suspend_depth: AtomicU32,
    /// 挂起前绳窗是否可见（resume 时据此决定是否 show）。
    pub was_visible: AtomicBool,
    /// cards.json 唯一写锁：排序 / 增删 / 软删除共用同一临界区，
    /// 杜绝「多 WebView 各自读整文件→改→覆盖」丢数据（PRD R60/R82 同类）。
    pub cards_write_lock: Mutex<()>,
}

/// 可点矩形，屏幕绝对物理坐标（与 GetCursorPos 同一坐标系，无需 IPC 查窗口位置）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct HitRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

// ————————————————————————— 稳定屏身份 —————————————————————————

/// 供前端选屏 / 重启恢复使用的一块显示器信息（全物理像素）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorInfo {
    /// 稳定硬件 ID（Windows 取设备接口路径的硬件段；重启 / 换接口名不变）。
    /// ⚠️ 绝不用 Tauri 的 name（DISPLAY1 重启 / 换线会变，R77）。
    pub stable_id: String,
    /// Tauri 名称，仅日志与调试，不作为持久化键。
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// 由显示器名 + 物理尺寸生成稳定 ID。
/// Windows：优先 `EnumDisplayDevicesW(EDD_GET_DEVICE_INTERFACE_NAME)` 的 DeviceID 硬件段
/// （形如 `\\?\DISPLAY#DELA0A2#5&...#{guid}` → 取 `DELA0A2`），比 name 稳。
/// macOS：无该 API，用 name + 物理尺寸指纹（阶段 2 可换 CGDisplaySerialNumber）。
#[cfg(windows)]
fn stable_id_for(name: &str, width: u32, height: u32) -> String {
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    use windows::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;
    let target = name.trim_start_matches(r"\\.\").trim_end_matches('\0');
    let mut hw: Option<String> = None;
    unsafe {
        for i in 0..16u32 {
            let mut d: DISPLAY_DEVICEW = std::mem::zeroed();
            d.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            if !EnumDisplayDevicesW(None, i, &mut d, EDD_GET_DEVICE_INTERFACE_NAME).as_bool() {
                break;
            }
            let dev_name = String::from_utf16_lossy(&d.DeviceName)
                .trim_end_matches('\0')
                .to_string();
            if dev_name.trim_start_matches(r"\\.\") == target {
                let id = String::from_utf16_lossy(&d.DeviceID)
                    .trim_end_matches('\0')
                    .to_string();
                // DISPLAY#<VEN&DEV>#<instance>#{guid} → 取第 2 段硬件号。
                if let Some(seg) = id.split('#').nth(1) {
                    if !seg.is_empty() {
                        hw = Some(seg.to_string());
                    }
                }
                break;
            }
        }
    }
    let core = hw.unwrap_or_else(|| target.to_string());
    format!("{}:{}x{}", core, width, height)
}

#[cfg(not(windows))]
fn stable_id_for(name: &str, width: u32, height: u32) -> String {
    let core = name
        .trim_start_matches(r"\\.\")
        .trim_end_matches('\0');
    format!("{}:{}x{}", core, width, height)
}

// ————————————————————————— 动态建窗 + 几何 —————————————————————————

/// 探活：build() Ok ≠ WebView2 环境真的可用（ghost 句柄）。same as notes.rs::probe_alive。
fn probe_alive(win: &WebviewWindow) -> bool {
    for _ in 0..3 {
        if win.is_visible().is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 建窗唯一实现。**必须在子线程调用**（同步命令内联 build 会死锁主线程）。
/// ⚠️ 仅 Windows 建窗：macOS 端编译通过但**不创建**绳窗（与截图功能「仅支持 Windows」
/// 的既有平台策略一致），从根上保证 mac 端零负面影响（PRD §14.5 双端铁律）。
#[cfg(windows)]
fn build_window(app: &tauri::AppHandle) -> bool {
    // 幂等 + ghost 清理：关闭是异步的，快速「关→开」时句柄可能仍残留。
    // 必须探活确认它是真窗口；ghost 则 close 并等它从注册表消失，再走新建。
    if let Some(existing) = app.get_webview_window(LABEL) {
        if probe_alive(&existing) {
            return true;
        }
        crate::append_app_log("[clothesline] 检测到 ghost 残留句柄，先清理再重建");
        let _ = existing.close();
        for _ in 0..12 {
            if app.get_webview_window(LABEL).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PathBuf::new()))
        .title("Tacco 晾衣绳")
        // ⚠️ 必须与主窗口 / 其余 8 个窗口逐字符一致，否则 0x8007139F。
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(1280.0, 120.0)
        .decorations(false)
        .transparent(true)
        .visible(false) // 由前端定位完成 + 首帧绘制后调用 clothesline_show 才显示。
        .always_on_top(load_settings().always_on_top)
        .skip_taskbar(true)
        .focused(false) // 绝不抢焦点（与 capture-overlay 同款克制）。
        .resizable(false)
        .shadow(false);

    match builder.build() {
        Ok(win) => {
            if probe_alive(&win) {
                let _ = win.set_ignore_cursor_events(true); // 收起态默认全穿透。
                crate::append_app_log("[clothesline] 窗口创建成功");
                true
            } else {
                crate::append_app_log("[clothesline] build() Ok 但探活失败 (ghost)，关闭");
                let _ = win.close();
                false
            }
        }
        Err(e) => {
            crate::append_app_log(&format!("[clothesline] 窗口创建失败: {e}"));
            false
        }
    }
}

/// 非 Windows：不建窗（配置仍可写，便于将来双端开启时零改动切换）。
#[cfg(not(windows))]
fn build_window(_app: &tauri::AppHandle) -> bool {
    crate::append_app_log("[clothesline] 当前平台不建晾衣绳窗口（仅 Windows）");
    false
}

/// 绳窗自有几何写入：物理像素 + alive 守卫 + 连写 3 次（混合 DPI 冷启动防 /1.5）。
/// ⚠️ 绝不调用 / 修改主窗 `applyBounds`（PRD I13）。
fn apply_bounds_inner(app: &tauri::AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    for i in 0..3 {
        let win = app
            .get_webview_window(LABEL)
            .ok_or_else(|| "晾衣绳窗口不存在".to_string())?;
        if win.is_visible().is_err() {
            return Err("晾衣绳窗口句柄失效 (ghost)".to_string());
        }
        win.set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| format!("设置位置失败: {e}"))?;
        win.set_size(tauri::PhysicalSize::new(w, h))
            .map_err(|e| format!("设置尺寸失败: {e}"))?;
        if i < 2 {
            std::thread::sleep(Duration::from_millis(16));
        }
    }
    Ok(())
}

// ————————————————————————— 独立 48ms 命中循环 —————————————————————————

/// 取当前光标屏幕绝对物理坐标。仅 Windows 建绳窗，故只实现 Windows 分支；
/// 其余平台返回 None（命中循环在这些平台根本不会启动，见 spawn_if_enabled）。
#[cfg(windows)]
fn cursor_physical() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return None;
        }
        Some((pt.x, pt.y))
    }
}
#[cfg(not(windows))]
fn cursor_physical() -> Option<(i32, i32)> {
    None
}

/// 光标是否落在任一可点矩形内（屏幕绝对坐标直接比对，零窗口位置 IPC）。
fn cursor_on_clickable(cx: i32, cy: i32, rects: &[HitRect]) -> bool {
    rects
        .iter()
        .any(|r| cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height)
}

/// 启动绳窗自有命中循环。**在 Rust 侧用 OS 光标轮询自主算穿透**，不由前端写回——
/// 这是防「穿透锁死」的关键（PRD R68 / I14）。只对**本窗口**发 set_ignore_cursor_events，
/// 绝不触碰主窗 48ms 循环、dock.ts、零 RPC 快路径。
///
/// 判定：
/// - 挂起截图期间 / 窗口不可达 → 跳过本轮（保留上次状态，避免闪烁）。
/// - 拖拽临时强制可点且未过期 → ignore=false。
/// - hit_rects 为空（展开态整窗可点）→ ignore=false。
/// - 否则 → 光标在任一矩形内才 ignore=false，其余 ignore=true。
/// 每轮**无条件重发**，任何一次 set_ignore 丢失都能在下一轮补回，永不锁死。
fn spawn_hit_loop(app: tauri::AppHandle, state: ClotheslineState) {
    if state.loop_running.swap(true, Ordering::SeqCst) {
        // 关→开快速切换时，上一轮线程可能还在 48ms sleep 里、尚未执行结尾的
        // loop_running=false。直接 return 会导致「重新开启后命中循环永远不再启动」。
        // 等它真正退出再抢一次；仍被占用才放弃（防止重复 spawn 堆积）。
        for _ in 0..12 {
            if !state.loop_running.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if state.loop_running.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    state.stop_loop.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        crate::append_app_log("[clothesline] 独立命中循环启动 (48ms, OS 轮询)");
        let mut last_seen = std::time::Instant::now();
        while !state.stop_loop.load(Ordering::Relaxed) {
            // 截图挂起期间不干预穿透，避免与 hide/show 竞态。
            let suspended = state.suspend_depth.load(Ordering::Relaxed) > 0;
            if !suspended {
                let force = state
                    .force_clickable_until
                    .lock()
                    .unwrap()
                    .map(|t| std::time::Instant::now() < t)
                    .unwrap_or(false);
                let rects = state.hit_rects.lock().unwrap().clone();
                let on_clickable = match cursor_physical() {
                    Some((cx, cy)) => rects.is_empty() || cursor_on_clickable(cx, cy, &rects),
                    None => true, // 拿不到光标（非 Windows / 异常）→ 保守可点，绝不锁死。
                };
                let ignore = !(force || on_clickable);
                if let Some(win) = app.get_webview_window(LABEL) {
                    let _ = win.set_ignore_cursor_events(ignore);
                    last_seen = std::time::Instant::now();
                }
            }
            if last_seen.elapsed() > Duration::from_millis(1500) {
                crate::append_app_log("[clothesline] 命中循环: 窗口不可达 (>1.5s)");
                last_seen = std::time::Instant::now();
            }
            std::thread::sleep(Duration::from_millis(48));
        }
        state.loop_running.store(false, Ordering::SeqCst);
        crate::append_app_log("[clothesline] 独立命中循环已停止");
    });
}

// ————————————————————————— 截图防污染（R54，最高危）—————————————————————————

/// 挂起绳窗：隐藏 + 等 DWM 合成生效，确保这一帧 BitBlt 不含绳窗。
/// 用深度计数支持「前端会话级 suspend」与「capture_screen 自守卫」嵌套。
pub fn capture_suspend(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return;
    };
    let prev = state.suspend_depth.fetch_add(1, Ordering::SeqCst);
    if prev != 0 {
        return; // 已挂起，不重复 hide / 不重复等待。
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        state.was_visible.store(visible, Ordering::SeqCst);
        if visible {
            let _ = win.hide();
            // ⚠️ hide 是异步窗口消息，必须给 DWM 一帧合成时间，否则 BitBlt 仍可能拍到绳窗。
            std::thread::sleep(Duration::from_millis(90));
        }
    }
    crate::append_app_log("[clothesline] 截图挂起：绳窗已隐藏");

    // 看门狗：前端崩溃 / Esc 未走到 resume 时，3s 后强制恢复，避免绳窗永久消失。
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        if let Some(s) = handle.try_state::<ClotheslineState>() {
                if s.suspend_depth.load(Ordering::SeqCst) > 0 {
                    crate::append_app_log("[clothesline] 截图挂起看门狗触发：强制恢复绳窗");
                    s.suspend_depth.store(0, Ordering::SeqCst);
                    resume_window(&handle, s.inner());
                }
        }
    });
}

fn resume_window(app: &tauri::AppHandle, state: &ClotheslineState) {
    if state.was_visible.swap(false, Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.show();
            crate::append_app_log("[clothesline] 截图恢复：绳窗已显示");
        }
    }
}

/// 恢复绳窗（深度归零才真正 show）。
pub fn capture_resume(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return;
    };
    // fetch_sub 返回旧值；旧值 <=1 表示本次归零（饱和：已为 0 时不再减）。
    let prev = state.suspend_depth.load(Ordering::SeqCst);
    if prev > 0 {
        state.suspend_depth.fetch_sub(1, Ordering::SeqCst);
    }
    if prev <= 1 {
        resume_window(app, state.inner());
    }
}

/// RAII 守卫：capture_screen 内 `let _g = CaptureGuard::new(&app);`，
/// 任何 return（含 Err / 提前返回）离开作用域都自动 resume，杜绝「截图失败后绳窗永久隐藏」。
pub struct CaptureGuard(tauri::AppHandle);

impl CaptureGuard {
    pub fn new(app: &tauri::AppHandle) -> Self {
        capture_suspend(app);
        Self(app.clone())
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        capture_resume(&self.0);
    }
}

// ————————————————————————— Tauri 命令 —————————————————————————

/// 读取绳窗配置（配置页 6 项 + 内部字段）。
#[tauri::command]
pub fn clothesline_get_settings() -> ClotheslineSettings {
    load_settings()
}

/// 总开关。开：写盘 + 子线程建窗 + 启动独立命中循环；关：停循环 + 关窗 + 清挂起态。
/// ⚠️ 关闭时**不删数据**（settings.json / 后续 cards.json 保留，重新开启读盘还原）。
#[tauri::command]
pub fn clothesline_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = load_settings();
    s.enabled = enabled;
    save_settings_to(&base_dir().ok_or_else(|| "无法定位用户目录".to_string())?, &s)?;

    let state = app.state::<ClotheslineState>();
    state.enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        let handle = app.clone();
        let st = app.state::<ClotheslineState>().inner().clone();
        // 建窗必须在子线程（同步命令内联 build 死锁）。
        std::thread::spawn(move || {
            if build_window(&handle) {
                spawn_hit_loop(handle, st);
            }
        });
    } else {
        state.stop_loop.store(true, Ordering::SeqCst);
        state.suspend_depth.store(0, Ordering::SeqCst);
        state.was_visible.store(false, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.close(); // 异步销毁；幂等重建由 build_window 的存在检查兜底。
        }
        crate::append_app_log("[clothesline] 总开关关闭：窗口与命中循环已停，数据保留");
    }
    Ok(())
}

/// 更新单个偏好（配置页 6 项走这里；always_on_top 单独命令，配置页不镜像）。
/// ⚠️ 写盘后必须广播 `clothesline-settings-changed`：绳窗的 settings state 只在启动恢复时
///    读一次，若不广播，配置页改「展开 / 换屏 / 清风」本次会话不生效、要重启才生效。
#[tauri::command]
pub fn clothesline_update_settings(
    app: tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<ClotheslineSettings, String> {
    let mut s = load_settings();
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            match k.as_str() {
                "auto_show_on_boot" => {
                    if let Some(b) = v.as_bool() { s.auto_show_on_boot = b }
                }
                "expanded" => { if let Some(b) = v.as_bool() { s.expanded = b } }
                "wind_effect" => { if let Some(b) = v.as_bool() { s.wind_effect = b } }
                "auto_fly_shot" => { if let Some(b) = v.as_bool() { s.auto_fly_shot = b } }
                "monitor_stable_id" => {
                    if let Some(id) = v.as_str() { s.monitor_stable_id = id.to_string() }
                }
                "anchor_y" => { if let Some(n) = v.as_i64() { s.anchor_y = n as i32 } }
                "pulltab_x_ratio" => {
                    if let Some(n) = v.as_f64() { s.pulltab_x_ratio = n }
                }
                _ => {} // 未知键忽略，防止前端误写污染。
            }
        }
    }
    s = sanitize(s);
    if let Some(base) = base_dir() {
        save_settings_to(&base, &s)?;
    }
    // 广播给绳窗（若开着）：本次会话内即时生效展开/收起、换屏、清风等，无需重启。
    // 总开关 enabled 走单独命令(建窗/销毁)，不经过这里。
    let _ = app.emit("clothesline-settings-changed", &s);
    Ok(s)
}

/// 置顶开关（＋菜单第 7 行唯一写入口；配置页不镜像，避免两处状态打架 R85）。
#[tauri::command]
pub fn clothesline_set_always_on_top(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let mut s = load_settings();
    if s.always_on_top == on {
        return Ok(()); // 幂等：同值不重复 SetWindowPos。
    }
    s.always_on_top = on;
    if let Some(base) = base_dir() {
        save_settings_to(&base, &s)?;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        win.set_always_on_top(on).map_err(|e| e.to_string())?;
        // 层级切换不改窗口矩形、不碰 GWL_EXSTYLE（PRD v1.3）；命中由独立循环
        // 下一轮 48ms 自动重算重发，这里不需要手动写穿透态。
    }
    let _ = app.emit("clothesline-topmost-changed", on);
    Ok(())
}

/// 前端首帧就绪后：三连写物理矩形 → 显示。顺序保证「先定位再 show」，零闪现错位。
#[tauri::command]
pub fn clothesline_apply_bounds_and_show(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    apply_bounds_inner(&app, x, y, width, height)?;
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "晾衣绳窗口不存在".to_string())?;
    if !win.is_visible().unwrap_or(false) {
        win.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 前端布局完成后上报「可点矩形」（屏幕绝对物理坐标）。独立命中循环据此自主判定。
/// - 传空数组 [] = 展开态整窗可点（穿透恒 false）。
/// - 传若干矩形 = 收起态仅有把手竖条 / 下拉绳 / 卡片可点，其余穿透。
/// ⚠️ 绝不让前端根据 pointermove 写穿透布尔值——窗口穿透后收不到鼠标事件会永久锁死（R68）。
#[tauri::command]
pub fn clothesline_set_hit_rects(app: tauri::AppHandle, rects: Vec<HitRect>) {
    if let Some(state) = app.try_state::<ClotheslineState>() {
        *state.hit_rects.lock().unwrap() = rects;
    }
}

/// 拖拽 / 编辑期间的「临时强制可点」请求（避免拖到一半因光标离开把手区而穿透）。
/// duration_ms 后自动过期，命中循环恢复 OS 判定。
#[tauri::command]
pub fn clothesline_set_force_clickable(app: tauri::AppHandle, duration_ms: u64) {
    if let Some(state) = app.try_state::<ClotheslineState>() {
        *state.force_clickable_until.lock().unwrap() =
            Some(std::time::Instant::now() + Duration::from_millis(duration_ms));
    }
}

/// 前端会话级截图挂起 / 恢复（覆盖层整个生命周期保持隐藏；capture_screen 另有自守卫）。
#[tauri::command]
pub fn clothesline_capture_suspend(app: tauri::AppHandle) {
    capture_suspend(&app);
}

#[tauri::command]
pub fn clothesline_capture_resume(app: tauri::AppHandle) {
    capture_resume(&app);
}

/// 枚举显示器 + 稳定 ID（前端选屏 / 重启解析用）。
#[tauri::command]
pub fn clothesline_get_monitors(app: tauri::AppHandle) -> Vec<MonitorInfo> {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|m| m.name()).map(|s| s.to_string());
    monitors
        .iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            let name = m.name().map(|s| s.to_string()).unwrap_or_default();
            let is_primary = primary_name.as_deref() == Some(name.as_str());
            MonitorInfo {
                stable_id: stable_id_for(&name, size.width, size.height),
                name,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor: m.scale_factor(),
                is_primary,
            }
        })
        .collect()
}

// ————————————————————————— 卡片数据层（阶段 2：重启原位恢复）—————————————————————————

/// 卡片类型。阶段 2 只是数据地基，渲染 / 接入在阶段 2b~4 补齐。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    Note,       // 便利签引用（订阅 Note.items，绝不落内容快照）
    Shot,       // 截图飞入（previews/{id}.webp 副本）
    Clipboard,  // 剪贴板条目引用
    Pin,        // 贴图引用
    Image,      // 本地图片（明信片卡）
    Task,       // 待办引用
    Text,       // 纯文字卡（cards.json 自持 text）
    Timer,      // 番茄计时（endAt 绝对时间戳）
}

/// 晾衣绳上一张卡片的持久化形态。
/// ⚠️ `order` 是**唯一顺序真源**（稀疏整数，读盘按升序 + id 字典序 tie-break），
///    与 createdAt / updatedAt / pinned / kind 彻底解耦（PRD R78）。
/// ⚠️ `deletedAt` 存在 = 软删除（10s 撤销窗口）；恢复时只取「无 deletedAt」的卡。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClotheslineCard {
    pub id: String,
    pub kind: CardKind,
    /// 稀疏顺序键。写入按 index×1024，相邻插入仅重排必要区间。
    pub order: i64,
    #[serde(default)]
    pub pinned: bool,
    /// 附加到某张卡的 id（关联关系；目标被删则降级为独立卡，槽位不变）。
    #[serde(default)]
    pub attach_to: Option<String>,
    /// 便利签 id（kind=note）。卡片只存 refId，不存 items 快照。
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub pin_id: Option<String>,
    #[serde(default)]
    pub clip_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// 纯文字卡 / 备注 / 失效占位时的文字。
    #[serde(default)]
    pub text: String,
    /// 明信片卡标题 / 截图备注。
    #[serde(default)]
    pub title: String,
    /// 媒体来源：截图飞入 / 贴图 / 本地图统一指向 `previews/{id}.webp` 副本，
    /// 重启后进程内 stash 失效也能预览（PRD 5.16.4）。
    #[serde(default)]
    pub src_path: Option<String>,
    /// 计时卡：绝对结束时间戳（ms），重启后续算而非重开。
    #[serde(default)]
    pub end_at: Option<i64>,
    #[serde(default)]
    pub elapsed_before_pause_ms: i64,
    #[serde(default = "default_timer_direction")]
    pub timer_direction: String, // countdown | countup
    #[serde(default = "default_timer_mode")]
    pub timer_elapsed_mode: String, // wallclock | runtime
    #[serde(default)]
    pub fired_at: Option<i64>, // 提醒已触发去重，防重启重复弹
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 软删除时间戳（ms）。有值 = 10s 撤销窗口内；正常退出提交为已删。
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

fn default_timer_direction() -> String { "countdown".into() }
fn default_timer_mode() -> String { "wallclock".into() }

/// 一次会话的瞬时状态（单独文件，退出时写，启动读；不算卡片数据）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(default)]
    pub scroll_x: i32,
    #[serde(default = "default_true")]
    pub collapsed: bool,
    #[serde(default)]
    pub last_exit_at: i64,
    #[serde(default)]
    pub clean_exit: bool,
    /// 退出前的几何签名（工作区 + 缩放），用于启动时判断是否需要等比映射。
    #[serde(default)]
    pub geo_sig: String,
    #[serde(default)]
    pub anchor_y: i32,
    #[serde(default = "default_pull")]
    pub pulltab_x_ratio: f64,
    #[serde(default)]
    pub monitor_stable_id: String,
}
fn default_true() -> bool { true }
fn default_pull() -> f64 { 0.5 }

impl Default for SessionState {
    fn default() -> Self {
        Self {
            scroll_x: 0,
            collapsed: true, // 崩溃退出回退收起更安全，不遮挡屏幕（PRD 5.16.4）。
            last_exit_at: 0,
            clean_exit: false,
            geo_sig: String::new(),
            anchor_y: 72,
            pulltab_x_ratio: 0.5,
            monitor_stable_id: String::new(),
        }
    }
}

/// 启动恢复状态（Rust 一次读齐，前端 mount 前消费；`recovered_from_backup` 用于 Toast）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreState {
    pub settings: ClotheslineSettings,
    /// 无 deletedAt 的卡片，已按 (order asc, id asc) 排好。
    pub cards: Vec<ClotheslineCard>,
    pub session: SessionState,
    pub monitors: Vec<MonitorInfo>,
    /// cards.json 主文件解析失败、改用 bak 时为 true。
    pub recovered_from_backup: bool,
    /// 落屏解析结果在前端做（Rust 只给 monitors + 已存 stable_id），此处回传解析后的屏。
    pub target_monitor_stable_id: String,
    /// 上次记忆的屏已不在（拔屏 / 换线），前端据此弹一次 Toast。
    pub monitor_fallback: bool,
}

fn cards_dir(base: &Path) -> PathBuf { base.join("clothesline") }
fn cards_path(base: &Path) -> PathBuf { cards_dir(base).join("cards.json") }
fn cards_bak_path(base: &Path) -> PathBuf { cards_dir(base).join("cards.json.bak") }
fn session_path(base: &Path) -> PathBuf { cards_dir(base).join("session.json") }

/// tmp + rename 原子写；保留上一版为 .bak（写新文件前把旧主文件复制成 bak）。
fn atomic_write_json<T: Serialize>(final_path: &Path, bak_path: Option<&Path>, value: &T) -> Result<(), String> {
    let dir = final_path.parent().ok_or_else(|| "非法路径".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    // 先把现有主文件备份成 .bak（崩溃安全：任何时刻至少有一份完整数据）。
    if let Some(bak) = bak_path {
        if final_path.exists() {
            let _ = std::fs::copy(final_path, bak);
        }
    }
    let tmp = dir.join(format!(
        "{}.tmp",
        final_path.file_name().and_then(|n| n.to_str()).unwrap_or("data")
    ));
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("写临时文件失败: {e}"))?;
    if final_path.exists() {
        let _ = std::fs::remove_file(final_path);
    }
    std::fs::rename(&tmp, final_path).map_err(|e| format!("原子替换失败: {e}"))?;
    Ok(())
}

/// 解析卡片数组 + 过滤软删除 + 稳定排序（order asc, id asc tie-break）。
fn parse_cards(raw: &str) -> Result<Vec<ClotheslineCard>, String> {
    let mut cards: Vec<ClotheslineCard> =
        serde_json::from_str(raw).map_err(|e| format!("cards.json 解析失败: {e}"))?;
    cards.retain(|c| c.deleted_at.is_none()); // 「没删就一定在」；软删除的卡不恢复。
    cards.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    Ok(cards)
}

fn load_cards(base: &Path) -> (Vec<ClotheslineCard>, bool) {
    match std::fs::read_to_string(cards_path(base)) {
        Ok(raw) => match parse_cards(&raw) {
            Ok(cards) => (cards, false),
            Err(e) => {
                crate::append_app_log(&format!("[clothesline] {e}; 尝试 cards.json.bak"));
                match std::fs::read_to_string(cards_bak_path(base)) {
                    Ok(bak) => match parse_cards(&bak) {
                        Ok(cards) => {
                            crate::append_app_log("[clothesline] 已从 cards.json.bak 恢复");
                            (cards, true)
                        }
                        Err(_) => (Vec::new(), true),
                    },
                    Err(_) => (Vec::new(), true),
                }
            }
        },
        Err(_) => (Vec::new(), false), // 首次启用，无文件 = 空绳，不算错误。
    }
}

fn load_session(base: &Path) -> SessionState {
    match std::fs::read_to_string(session_path(base)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => SessionState::default(),
    }
}

/// 几何签名：目标屏工作区尺寸 + 缩放。签名未变则锚点原样，不改一个像素。
fn geometry_signature(mon: &MonitorInfo) -> String {
    format!("{}x{}@{}", mon.width, mon.height, mon.scale_factor)
}

/// 启动恢复：一次读齐 settings + cards(+bak) + session + monitors，并解析目标屏。
/// ⚠️ 只读不写 cards.json（PRD 5.16.3）；唯一可能的写是自固化 monitor id（由前端调
/// clothesline_update_settings 触发），不在这里做。
#[tauri::command]
pub fn clothesline_get_restore_state(app: tauri::AppHandle) -> RestoreState {
    let settings = load_settings();
    let base = base_dir().unwrap_or_else(|| PathBuf::from("."));
    let (cards, recovered_from_backup) = load_cards(&base);
    let mut session = load_session(&base);

    // 几何签名若与上次不同，等比映射锚点（PRD 5.16.5）；签名相同原样。
    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|p| p.name().map(|s| s.to_string()));
    let monitors: Vec<MonitorInfo> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            let name = m.name().map(|s| s.to_string()).unwrap_or_default();
            let is_primary = primary_name.as_deref() == Some(name.as_str());
            MonitorInfo {
                stable_id: stable_id_for(&name, size.width, size.height),
                name,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor: m.scale_factor(),
                is_primary,
            }
        })
        .collect();

    // 解析目标屏（五级，Rust 侧完成核心三级 + 几何指纹兜底）。
    let target: Option<&MonitorInfo> = if monitors.len() == 1 {
        monitors.first()
    } else if let Some(hit) = monitors.iter().find(|m| m.stable_id == settings.monitor_stable_id) {
        Some(hit)
    } else if !session.monitor_stable_id.is_empty() {
        monitors.iter().find(|m| m.stable_id == session.monitor_stable_id)
    } else {
        None
    };
    let target = target
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .or_else(|| monitors.first());

    let (target_monitor_stable_id, anchor_y) = if let Some(t) = target {
        let sig = geometry_signature(t);
        let anchor = if !session.geo_sig.is_empty() && session.geo_sig != sig {
            // 分辨率/工作区高度变化 → 等比映射。用屏高比例，clamp 到 40%/360 上限。
            let old_h = session
                .geo_sig
                .split('x')
                .nth(1)
                .and_then(|s| s.split('@').next())
                .and_then(|s| s.parse::<i32>().ok())
                .unwrap_or(0);
            let max_anchor = (t.height as i32 * 2 / 5).min(360);
            if old_h > 0 {
                ((session.anchor_y as f64 * t.height as f64 / old_h as f64).round() as i32)
                    .clamp(0, max_anchor)
            } else {
                session.anchor_y.clamp(0, max_anchor)
            }
        } else {
            session.anchor_y.clamp(0, (t.height as i32 * 2 / 5).min(360))
        };
        (t.stable_id.clone(), anchor)
    } else {
        (String::new(), session.anchor_y)
    };
    session.anchor_y = anchor_y;

    let remembered = if !settings.monitor_stable_id.is_empty() {
        settings.monitor_stable_id.clone()
    } else {
        session.monitor_stable_id.clone()
    };
    let monitor_fallback = monitors.len() > 1
        && !remembered.is_empty()
        && !monitors.iter().any(|m| m.stable_id == remembered);

    let state = RestoreState {
        settings,
        cards,
        session,
        monitors,
        recovered_from_backup,
        target_monitor_stable_id,
        monitor_fallback,
    };
    crate::append_app_log(&format!(
        "[clothesline] restore: cards={}, monitor={}, anchorY={}, sig={}",
        state.cards.len(),
        state.target_monitor_stable_id,
        state.session.anchor_y,
        state.session.geo_sig
    ));
    state
}

/// 退出时写 session.json（干净退出标记 lastExitAt / cleanExit）。软删除在此提交。
#[tauri::command]
pub fn clothesline_save_session(app: tauri::AppHandle, session: SessionState) -> Result<(), String> {
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut s = session;
    s.last_exit_at = now_ms();
    s.clean_exit = true;
    atomic_write_json(&session_path(&base), None, &s)?;
    // 正常退出：提交所有挂起的软删除（deleted_at 有值 → 视为已删，写回后不再恢复）。
    if let Ok(raw) = std::fs::read_to_string(cards_path(&base)) {
        if let Ok(mut cards) = serde_json::from_str::<Vec<ClotheslineCard>>(&raw) {
            let before = cards.len();
            cards.retain(|c| c.deleted_at.is_none());
            if cards.len() != before {
                // 提交软删除：无 .bak 覆盖语义（这是用户明确删的），但仍走原子写。
                atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &cards)?;
                crate::append_app_log(&format!(
                    "[clothesline] 正常退出提交软删除 {} 张",
                    before - cards.len()
                ));
            }
        }
    }
    let _ = &app; // 保留签名一致，便于将来 emit。
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 卡片拖动排序：**全程唯一一次 IPC + 一次原子写**（PRD §5.17.3）。
/// - 校验 ordered_ids 与磁盘上「活跃卡（无 deletedAt）」的 id 集合完全一致：
///   无丢失 / 无重复 / 无陌生 id，否则拒绝并保持原序（返回 Err，前端回滚）。
/// - 只改 order（index×1024 稀疏），绝不改卡片内容 / 数量 / pinned / attachTo / 计时 / 配额。
/// - 软删除的卡 order 不动；主文件解析失败同样拒绝，不写空数组。
#[tauri::command]
pub fn clothesline_reorder_cards(
    app: tauri::AppHandle,
    ordered_ids: Vec<String>,
) -> Result<Vec<(String, i64)>, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let raw = std::fs::read_to_string(cards_path(&base))
        .map_err(|e| format!("读取 cards.json 失败: {e}"))?;
    let mut all: Vec<ClotheslineCard> =
        serde_json::from_str(&raw).map_err(|e| format!("cards.json 解析失败: {e}"))?;

    let active_ids: std::collections::HashSet<&str> = all
        .iter()
        .filter(|c| c.deleted_at.is_none())
        .map(|c| c.id.as_str())
        .collect();
    // 集合一致性：长度相等（挡重复）+ 每个 id 都是活跃卡（挡陌生 / 已删）。
    let submitted: std::collections::HashSet<&str> =
        ordered_ids.iter().map(|s| s.as_str()).collect();
    if submitted.len() != ordered_ids.len()
        || submitted.len() != active_ids.len()
        || !submitted.iter().all(|id| active_ids.contains(id))
    {
        crate::append_app_log("[clothesline] reorder 拒绝：id 集合不一致（已回滚）");
        return Err("卡片集合已变化，排序已取消".into());
    }

    // 稀疏 order：index×1024；相邻插入时大部分卡 order 不变，减少无谓改写语义。
    let new_order: std::collections::HashMap<&str, i64> = ordered_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as i64 * 1024))
        .collect();
    let ts = now_ms();
    for card in all.iter_mut() {
        if card.deleted_at.is_some() {
            continue;
        }
        if let Some(o) = new_order.get(card.id.as_str()) {
            card.order = *o;
        }
        card.updated_at = ts;
    }

    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let result: Vec<(String, i64)> = ordered_ids
        .iter()
        .map(|id| (id.clone(), *new_order.get(id.as_str()).unwrap_or(&0)))
        .collect();
    crate::append_app_log(&format!("[clothesline] reorder 提交 {} 张卡", result.len()));
    let _ = app.emit("clothesline-order-changed", &result);
    Ok(result)
}

// ————————————————————————— 阶段 4：卡片增删 / 配额 / 预览落盘 —————————————————————————

/// 免费 12 / 会员 24 / 进程硬顶 32（含演示卡）。硬顶在 Rust 侧不可被前端参数绕过。
const FREE_CARD_LIMIT: usize = 12;
const MEMBER_CARD_LIMIT: usize = 24;
const HARD_CARD_LIMIT: usize = 32;

fn card_limit(member: bool) -> usize {
    if member { MEMBER_CARD_LIMIT } else { FREE_CARD_LIMIT }.min(HARD_CARD_LIMIT)
}

/// 读原始卡片数组（**含软删除**，与 parse_cards 的「只返回活跃卡」语义区分）。
fn read_all_cards(base: &Path) -> Result<Vec<ClotheslineCard>, String> {
    let raw = match std::fs::read_to_string(cards_path(base)) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取 cards.json 失败: {e}")),
    };
    serde_json::from_str(&raw).map_err(|e| format!("cards.json 解析失败: {e}"))
}

fn active_snapshot(all: &[ClotheslineCard]) -> Vec<ClotheslineCard> {
    let mut v: Vec<ClotheslineCard> = all.iter().filter(|c| c.deleted_at.is_none()).cloned().collect();
    v.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    v
}

/// `Option<Option<T>>` 的正确反序列化：区分「字段缺失（不改）」与「显式 null（清空）」。
///
/// serde 对 `Option<Option<T>>` 的默认实现会把 JSON `null` 解成**外层 None**，
/// 与 `#[serde(default)]` 的「字段缺失」撞成同一状态 → 「清空」永远失效。
/// 这里先把值解成 `Option<T>`（null → 内层 None / 值 → Some），再统一包一层外层 Some：
/// - 字段缺失 → `#[serde(default)]` 给外层 None → 「不改」
/// - 显式 null → `Some(None)` → 「清空」
/// - 具体值   → `Some(Some(v))` → 「设置为 v」
/// 零新依赖（本环境 crates.io TLS 被拦，不能用 serde_with::DoubleOption）。
fn de_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    let inner: Option<T> = Option::deserialize(deserializer)?;
    Ok(Some(inner))
}

/// 卡片增量更新。`Option<Option<T>>` 才能区分「不改」与「清空为 null」。
#[derive(Debug, Deserialize)]
pub struct CardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub src_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub end_at: Option<Option<i64>>,
    #[serde(default)]
    pub elapsed_before_pause_ms: Option<i64>,
    #[serde(default)]
    pub timer_direction: Option<String>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub fired_at: Option<Option<i64>>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// 新增卡片：order 永远追加到尾部（不动已有卡的槽位）。
/// 达上限时默认**拒绝**并提示；仅截图自动飞入传 auto_drop_oldest=true，
/// 此时撕下「最旧的非置顶卡」（软删除，10s 可撤销），全部置顶则拒绝。
#[tauri::command]
pub fn clothesline_add_card(
    app: tauri::AppHandle,
    card: ClotheslineCard,
    member: bool,
    auto_drop_oldest: bool,
) -> Result<ClotheslineCard, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let limit = card_limit(member);
    let active_count = all.iter().filter(|c| c.deleted_at.is_none()).count();

    // 计时卡额外约束：同时运行（有未来结束时间且未触发）最多 3 张，
    // 与总额度独立；超出的计时仍可创建为「已结束」草稿，避免误吞用户操作。
    if card.kind == CardKind::Timer {
        let running = all
            .iter()
            .filter(|c| {
                c.deleted_at.is_none()
                    && c.kind == CardKind::Timer
                    && c.end_at.map(|t| t > now_ms()).unwrap_or(false)
                    && c.fired_at.is_none()
            })
            .count();
        if running >= 3 && card.end_at.map(|t| t > now_ms()).unwrap_or(false) {
            return Err("同时运行的计时最多 3 张，先停掉一张".into());
        }
    }

    let mut dropped: Option<String> = None;
    if active_count >= limit {
        if !auto_drop_oldest {
            return Err(format!("晾衣绳最多挂 {limit} 张卡片，先取下一张再来"));
        }
        let victim = all
            .iter()
            .filter(|c| c.deleted_at.is_none() && !c.pinned)
            .min_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.order.cmp(&b.order))
            })
            .map(|c| c.id.clone());
        let Some(victim) = victim else {
            return Err("晾衣绳已满，现有卡片全部置顶，请先手动取下一张".into());
        };
        let ts = now_ms();
        if let Some(c) = all.iter_mut().find(|c| c.id == victim) {
            c.deleted_at = Some(ts);
            c.updated_at = ts;
        }
        dropped = Some(victim);
    }

    // 同 id 复用：先物理移除旧行（可能是软删除的），再追加新行，避免重复槽位。
    all.retain(|c| c.id != card.id);
    let max_order = all
        .iter()
        .filter(|c| c.deleted_at.is_none())
        .map(|c| c.order)
        .max()
        .unwrap_or(-1024);
    let ts = now_ms();
    let mut fresh = card;
    fresh.order = max_order + 1024;
    fresh.created_at = ts;
    fresh.updated_at = ts;
    fresh.deleted_at = None;
    all.push(fresh.clone());

    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    if let Some(id) = dropped {
        crate::append_app_log(&format!("[clothesline] 满额自动撕下最旧非置顶卡 {id}"));
        let _ = app.emit("clothesline-card-dropped", &id);
    }
    crate::append_app_log(&format!("[clothesline] 新增卡片 {}/{}", fresh.kind_to_log(), limit));
    Ok(fresh)
}

impl ClotheslineCard {
    fn kind_to_log(&self) -> String {
        format!("{:?}@{}", self.kind, self.id)
    }
}

/// 改卡片内容 / 置顶 / 计时字段；**绝不改 order / createdAt / id**（顺序只归排序命令管）。
#[tauri::command]
pub fn clothesline_update_card(
    app: tauri::AppHandle,
    id: String,
    patch: CardPatch,
) -> Result<ClotheslineCard, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let pos = all
        .iter()
        .position(|c| c.id == id && c.deleted_at.is_none())
        .ok_or_else(|| "卡片不存在或已取下".to_string())?;
    let c = &mut all[pos];
    if let Some(v) = patch.title { c.title = v; }
    if let Some(v) = patch.text { c.text = v; }
    if let Some(v) = patch.src_path { c.src_path = v; }
    if let Some(v) = patch.end_at { c.end_at = v; }
    if let Some(v) = patch.elapsed_before_pause_ms { c.elapsed_before_pause_ms = v; }
    if let Some(v) = patch.timer_direction { c.timer_direction = v; }
    if let Some(v) = patch.fired_at { c.fired_at = v; }
    if let Some(v) = patch.pinned { c.pinned = v; }
    c.updated_at = now_ms();
    let updated = c.clone();
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    Ok(updated)
}

/// 取下卡片 = 软删除（保留 order 与内容，10s 内可原位撤销）。
#[tauri::command]
pub fn clothesline_remove_card(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    {
        let c = all
            .iter_mut()
            .find(|c| c.id == id && c.deleted_at.is_none())
            .ok_or_else(|| "卡片不存在或已取下".to_string())?;
        let ts = now_ms();
        c.deleted_at = Some(ts);
        c.updated_at = ts;
    }
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    let _ = app.emit("clothesline-card-removed", &id);
    Ok(())
}

/// 撤销取下：清 deleted_at，**原 order 不变 → 回到原槽位**（PRD「位置不可以改变」）。
#[tauri::command]
pub fn clothesline_restore_card(app: tauri::AppHandle, id: String) -> Result<ClotheslineCard, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let restored = {
        let c = all
            .iter_mut()
            .find(|c| c.id == id && c.deleted_at.is_some())
            .ok_or_else(|| "没有可撤销的卡片".to_string())?;
        c.deleted_at = None;
        c.updated_at = now_ms();
        c.clone()
    };
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    Ok(restored)
}

/// 图片预览落盘：`previews/{id}.png`（无新依赖，不转 webp；stash 进程内数据失效后仍可预览）。
/// ⚠️ 绝不写主窗 `shot-last`，也不进 localStorage。单图上限 8MB。
#[tauri::command]
pub fn clothesline_save_preview(
    app: tauri::AppHandle,
    id: String,
    data_url: String,
) -> Result<String, String> {
    let _ = &app;
    let clean_id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if clean_id.is_empty() {
        return Err("非法预览 ID".into());
    }
    let b64 = data_url.split_once(',').map(|(_, b)| b).unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("预览图解码失败: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("预览图超过 8MB，未保存".into());
    }
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = cards_dir(&base).join("previews");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建预览目录失败: {e}"))?;
    let final_path = dir.join(format!("{clean_id}.png"));
    let tmp = dir.join(format!("{clean_id}.png.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写预览临时文件失败: {e}"))?;
    if final_path.exists() {
        let _ = std::fs::remove_file(&final_path);
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| format!("预览原子替换失败: {e}"))?;
    Ok(final_path.to_string_lossy().to_string())
}

/// 读回预览缩略图（data URL）。不用 asset://：capabilities 未授权 asset scope，
/// 且 asset 跨源图会污染 canvas（项目铁律）。缩略图已在前端压到 ≤480px。
#[tauri::command]
pub fn clothesline_read_preview(app: tauri::AppHandle, id: String) -> Option<String> {
    let _ = &app;
    let clean_id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if clean_id.is_empty() {
        return None;
    }
    let base = base_dir()?;
    let bytes = std::fs::read(cards_dir(&base).join("previews").join(format!("{clean_id}.png"))).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 只读用量（配置页状态条用）。**不写任何文件**，也不按会员过滤——上限由 add 命令把关。
#[tauri::command]
pub fn clothesline_get_card_usage(app: tauri::AppHandle) -> Result<usize, String> {
    let _ = &app;
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let all = read_all_cards(&base)?;
    Ok(all.iter().filter(|c| c.deleted_at.is_none()).count())
}

/// 启动期调用：仅当配置 enabled 时延迟建窗（默认 false → 老用户零残留）。
/// 延迟 ≥1.8s 避开主窗 / WebView2 初始化峰值（notes.rs 同款）。
pub fn spawn_if_enabled(app: tauri::AppHandle) {
    if !load_settings().enabled {
        crate::append_app_log("[clothesline] 总开关关闭：跳过建窗 / 命中循环（零残留）");
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1800));
        // ⚠️ 入口检查距今已 1.8s，期间用户可能已在配置页关闭总开关（磁盘 settings.json
        //   已写 enabled=false）。这里必须复查磁盘真源——state.enabled 只写不读、不能作为
        //   判断依据；否则「启动时开、1.8s 内关」会变成「关了又自己弹出来」。
        if !load_settings().enabled {
            crate::append_app_log("[clothesline] 启动延迟期间总开关已关闭：取消建窗");
            return;
        }
        let st = app.state::<ClotheslineState>().inner().clone();
        st.enabled.store(true, Ordering::SeqCst);
        if build_window(&app) {
            // 建窗期间用户又关了开关：立刻撤销这次建窗，避免 Setting 已关却残留窗口。
            if !load_settings().enabled {
                if let Some(w) = app.get_webview_window(LABEL) {
                    let _ = w.close();
                }
                crate::append_app_log("[clothesline] 建窗期间总开关被关闭：已撤销建窗");
                return;
            }
            spawn_hit_loop(app.clone(), st);
        }
    });
}

// ————————————————————————— 单元测试（纯逻辑，不依赖 GUI）—————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tacco_cl_test_{}_{}", tag, std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn settings_roundtrip_and_atomic_write() {
        let base = tmp_base("roundtrip");
        let _ = std::fs::remove_dir_all(&base);
        let mut s = ClotheslineSettings::default();
        assert!(!s.enabled, "总开关必须默认关闭");
        s.enabled = true;
        s.anchor_y = 128;
        s.monitor_stable_id = "DELA0A2:2560x1440".into();
        save_settings_to(&base, &s).unwrap();
        // 原子写后不应残留 tmp。
        assert!(!settings_path(&base).with_extension("json.tmp").exists());
        let got = load_settings_from(&base);
        assert_eq!(got, s);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sanitize_clamps_dirty_values() {
        let mut s = ClotheslineSettings::default();
        s.anchor_y = -50;
        s.pulltab_x_ratio = 9.9;
        s.monitor_stable_id = "x".repeat(500);
        let s = sanitize(s);
        assert_eq!(s.anchor_y, 72);
        assert_eq!(s.pulltab_x_ratio, 0.95);
        assert_eq!(s.monitor_stable_id.len(), 200);
    }

    #[test]
    fn corrupt_json_falls_back_to_default() {
        let base = tmp_base("corrupt");
        std::fs::create_dir_all(base.join("clothesline")).unwrap();
        std::fs::write(settings_path(&base), "{bad json").unwrap();
        let s = load_settings_from(&base);
        assert_eq!(s, ClotheslineSettings::default());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn stable_id_shape() {
        let id = stable_id_for("\\\\.\\DISPLAY1", 2560, 1440);
        // 必须带尺寸后缀、且不等于裸 name（防止只存 DISPLAY1）。
        assert!(id.ends_with(":2560x1440"));
        assert!(!id.starts_with("\\\\.\\"));
    }

    fn sample_card(id: &str, order: i64, pinned: bool, deleted: bool) -> ClotheslineCard {
        ClotheslineCard {
            id: id.into(),
            kind: CardKind::Text,
            order,
            pinned,
            attach_to: None,
            note_id: None,
            pin_id: None,
            clip_id: None,
            task_id: None,
            text: id.into(),
            title: String::new(),
            src_path: None,
            end_at: None,
            elapsed_before_pause_ms: 0,
            timer_direction: "countdown".into(),
            timer_elapsed_mode: "wallclock".into(),
            fired_at: None,
            created_at: 1000,
            updated_at: 1000,
            deleted_at: if deleted { Some(2000) } else { None },
        }
    }

    #[test]
    fn quota_is_capped_by_hard_limit() {
        assert_eq!(card_limit(false), 12);
        assert_eq!(card_limit(true), 24);
        assert!(card_limit(true) <= HARD_CARD_LIMIT);
    }

    #[test]
    fn active_snapshot_sorts_stably_and_filters_soft_deleted() {
        let all = vec![
            sample_card("c", 2048, false, false),
            sample_card("a", 1024, false, false),
            sample_card("b", 1024, false, false),
            sample_card("gone", 0, true, true),
        ];
        let snapshot = active_snapshot(&all);
        let ids: Vec<&str> = snapshot.iter().map(|c| c.id.as_str()).collect();
        // order 相同用 id 字典序兜底；软删除不参与展示但仍留在 all 中可撤销。
        assert_eq!(ids, vec!["a", "b", "c"]);
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn card_patch_distinguishes_missing_from_null() {
        // 三态：字段缺失=不改(外层 None) / 显式 null=清空(Some(None)) / 值=设置(Some(Some(v)))。
        let patch: CardPatch = serde_json::from_str(
            r#"{"text":"hi","src_path":null,"end_at":null,"fired_at":123,"pinned":true}"#,
        )
        .unwrap();
        assert_eq!(patch.text.as_deref(), Some("hi"));
        assert!(patch.title.is_none(), "未传字段必须表示「不改」");
        assert!(matches!(patch.src_path, Some(None)), "显式 null 必须表示「清空」");
        assert!(matches!(patch.end_at, Some(None)), "end_at 显式 null 必须表示「清空」");
        assert!(matches!(patch.fired_at, Some(Some(123))), "具体值必须表示「设置」");
        assert_eq!(patch.pinned, Some(true));

        // 只传需要的字段：其余必须仍是「不改」（外层 None），不能被误判成清空。
        let only_text: CardPatch = serde_json::from_str(r#"{"text":"x"}"#).unwrap();
        assert!(only_text.src_path.is_none());
        assert!(only_text.end_at.is_none());
        assert!(only_text.fired_at.is_none());

        // 空对象也合法（幂等 touch，仅刷新 updated_at）。
        let empty: CardPatch = serde_json::from_str(r#"{}"#).unwrap();
        assert!(empty.title.is_none() && empty.src_path.is_none() && empty.pinned.is_none());

        // 具体字符串值走「设置」态。
        let with_val: CardPatch = serde_json::from_str(r#"{"src_path":"C:\\x.png"}"#).unwrap();
        assert_eq!(with_val.src_path, Some(Some("C:\\x.png".to_string())));
    }

    #[test]
    fn atomic_write_keeps_backup_and_parse_filters_deleted() {
        let base = tmp_base("cards");
        let _ = std::fs::remove_dir_all(&base);
        let all = vec![sample_card("keep", 1024, false, false), sample_card("del", 2048, false, true)];
        atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all).unwrap();
        // 再写一次：上一版应被复制成 .bak（崩溃时至少有一份完整数据）。
        atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all).unwrap();
        assert!(cards_bak_path(&base).exists());
        let raw = std::fs::read_to_string(cards_path(&base)).unwrap();
        let parsed = parse_cards(&raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "keep");
        // 破坏主文件后应能读 bak（bak 里同样保留软删除行）。
        std::fs::write(cards_path(&base), "{broken").unwrap();
        let (recovered, from_bak) = load_cards(&base);
        assert!(from_bak);
        assert_eq!(recovered.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
