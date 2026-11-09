//! 便利签 (Sticky Notes) 桌面窗口。
//!
//! 设计原则:**数据是本体,窗口只是视图**。
//! - 收起 = 销毁窗口 + 保留数据(数据在前端 `src/notes/store.ts` 双持久化)
//! - 召回 = 按数据重建窗口
//! 这样「用户有 50 个便利签」不会变成「50 个常驻 WebView2 进程」拖垮内存。
//!
//! ⚠️ 以下三条来自项目真实踩坑,改动本文件时务必逐条守住:
//!
//! 1. **绝不能在同步命令里内联 `WebviewWindowBuilder::build()`**
//!    (见 lib.rs:1023 完整说明):同步命令占着主线程,而 Windows 下 WebView2
//!    控制器创建完成回调需主线程投递 → 死锁。症状为窗口 HWND 建出来但永不全透明、
//!    后续 IPC 全部无响应。**必须放进 `std::thread::spawn`。**
//!
//! 2. **`additional_browser_args` 必须与主窗口完全一致**(0.4.38 血案根因)。
//!    WebView2 硬性约束:同一进程、同一用户数据目录,两个 webview 的环境参数不一致时,
//!    第二个环境创建必失败(HRESULT 0x8007139F ERROR_INVALID_STATE,已实测复现)。
//!
//! 3. **`build()` 返回 Ok ≠ 创建成功**(fire-and-forget)。必须探活确认;
//!    探活失败的 label 会成为 ghost 死句柄,后续需 close 清理。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 便利签窗口 label 前缀。前端 main.tsx 用 `/^note-/` 前缀路由到便利签 UI。
const LABEL_PREFIX: &str = "note-";

fn note_label(note_id: &str) -> String {
    format!("{LABEL_PREFIX}{note_id}")
}

/// 探活:窗口对象存在 ≠ 真的能显示。
/// 0.4.38 排障经验:`is_visible()` 能成功调用说明底层 WebView2 环境真的建起来了;
/// 反之即使 build() Ok 也只是个 ghost 句柄。
fn probe_alive(win: &WebviewWindow) -> bool {
    for _ in 0..3 {
        if win.is_visible().is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    false
}

// ————————————————————————— L2 预建窗口池 —————————————————————————
//
// 冷启动一次「新建便利签」实测 4.1s、之后 0.2~1.2s,主因是每次都要新建
// WebView2 窗口。这里在启动后预建 1 个隐藏窗口,其 label 自带预留 note id,
// 前端创建数据时直接用这个 id —— 按键瞬间只剩「写数据 → 事件 → 前端 show」。
//
// ⚠️ 只做「预建 + show/hide」,不做 warmup/park(0.4.56 截图池窗已证伪回退)。
// ⚠️ 池窗 label 仍是 note-<id>,前端 main.tsx 的 /^note-/ 路由与
//    NoteWindow 的 NOTE_ID 解析完全不用改。

#[derive(Default)]
pub struct NotePoolState {
    /// 已建好、尚未绑定数据的隐藏窗口预留 id。
    free: Mutex<Vec<String>>,
    /// 正在创建中的池窗数,防止并发重复预建。
    pending: AtomicUsize,
}

static POOL_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_pool_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = POOL_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("pool_{ms}_{seq}")
}

/// 建窗唯一实现(池窗与常规开窗共用),返回是否真的可用。
/// ⚠️ 必须在子线程调用:同步命令里内联 build() 会死锁(见文件头第 1 条)。
fn build_note_window(app: &tauri::AppHandle, label: &str, pinned: bool) -> bool {
    let builder = tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::App(PathBuf::new()))
        .title("Tacco 便利签")
        // ⚠️ 必须与主窗口 (tauri.conf.json app.windows[0].additionalBrowserArgs) 完全一致,
        // 否则第二个便利签起创建必失败(0.4.38 同款根因)。
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(240.0, 220.0)
        .decorations(false)
        .transparent(true)
        .visible(false)
        .always_on_top(pinned)
        .skip_taskbar(true)
        .focused(false)
        .resizable(true)
        .shadow(false);

    match builder.build() {
        Ok(win) => {
            if probe_alive(&win) {
                crate::append_app_log(&format!("[notes] 窗口创建成功 label={label}"));
                true
            } else {
                crate::append_app_log(&format!(
                    "[notes] build() Ok 但探活失败 label={label} (ghost)"
                ));
                let _ = win.close();
                false
            }
        }
        Err(e) => {
            crate::append_app_log(&format!("[notes] 窗口创建失败 label={label}: {e}"));
            false
        }
    }
}

/// 保证「最多 1 个空闲池窗」。启动后与每次领取后各调用一次;
/// 内部检查 free + pending,不会堆积出多个常驻 WebView2 进程。
pub fn spawn_pool_window(app: tauri::AppHandle) {
    {
        let Some(state) = app.try_state::<NotePoolState>() else {
            return;
        };
        let free = state.free.lock().unwrap();
        if free.len() + state.pending.load(Ordering::Relaxed) >= 1 {
            return;
        }
        state.pending.fetch_add(1, Ordering::Relaxed);
    }

    let id = new_pool_id();
    let label = note_label(&id);
    crate::append_app_log(&format!("[notes] 预建池窗 label={label}"));
    std::thread::spawn(move || {
        let ok = build_note_window(&app, label.as_str(), true);
        if let Some(state) = app.try_state::<NotePoolState>() {
            if ok {
                state.free.lock().unwrap().push(id);
                crate::append_app_log("[notes] 池窗就绪");
            }
            state.pending.fetch_sub(1, Ordering::Relaxed);
        }
    });
}

/// 领取一个预建窗口的预留 id;没有可用池窗时返回 None(前端回落常规开窗)。
#[tauri::command]
pub fn notes_claim_window(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let id = app
        .try_state::<NotePoolState>()
        .and_then(|s| s.free.lock().unwrap().pop());
    crate::append_app_log(&format!(
        "[notes] claim pool: {}",
        id.as_deref().unwrap_or("miss")
    ));
    // 无论命中与否都补建下一个,下一次按键仍有池窗可用。
    spawn_pool_window(app.clone());
    Ok(id)
}

/// 打开(或复用)某个便利签的窗口。
///
/// - `pinned`:是否「始终置顶」(用户口中的"钉住"),默认 true。
/// - 幂等:已有活窗口时只更新置顶状态并显示,不 close 重建
///   —— close 是异步销毁,立刻按同 label 重建会撞「窗口已存在」。
///
/// ⚠️ 窗口以 `visible(false)` 创建,由前端读取保存的位置/尺寸后自行 `show()`,
/// 避免在 Windows 默认级联位置闪现未定位的窗口(0.4.44 经验)。
#[tauri::command]
pub fn notes_open_window(
    app: tauri::AppHandle,
    note_id: String,
    pinned: Option<bool>,
) -> Result<(), String> {
    let label = note_label(&note_id);
    let pinned = pinned.unwrap_or(true);
    crate::append_app_log(&format!("[notes] open id={note_id} pinned={pinned}"));

    std::thread::spawn(move || {
        // ① 已有活窗口 → 复用
        if let Some(existing) = app.get_webview_window(&label) {
            if probe_alive(&existing) {
                let _ = existing.set_always_on_top(pinned);
                let _ = existing.unminimize();
                crate::append_app_log("[notes] 复用现有窗口");
                return;
            }
            // ghost 死句柄:清理后重建同 label
            crate::append_app_log("[notes] 发现 ghost 句柄,清理后重建");
            let _ = existing.close();
            std::thread::sleep(std::time::Duration::from_millis(120));
        }

        // ② 新建窗口(与池窗共用同一套构建参数,避免两份实现漂移)
        let _ = build_note_window(&app, label.as_str(), pinned);
    });

    Ok(())
}

/// 收起:销毁窗口。**不触碰数据**(数据由前端管理),可从管理器召回重建。
#[tauri::command]
pub fn notes_close_window(app: tauri::AppHandle, note_id: String) -> Result<(), String> {
    let label = note_label(&note_id);
    crate::append_app_log(&format!("[notes] close id={note_id}"));
    let handle = app.clone();
    // 同样不能在主线程同步 close 后立即重建的场景里卡住,统一丢到子线程。
    std::thread::spawn(move || {
        if let Some(win) = handle.get_webview_window(&label) {
            let _ = win.close();
        }
    });
    Ok(())
}

/// 探活:该便利签当前是否真的有活着的窗口。
#[tauri::command]
pub fn notes_window_exists(app: tauri::AppHandle, note_id: String) -> bool {
    let label = note_label(&note_id);
    match app.get_webview_window(&label) {
        None => false,
        Some(win) => probe_alive(&win),
    }
}

/// 切换「始终置顶」。
#[tauri::command]
pub fn notes_set_pinned(
    app: tauri::AppHandle,
    note_id: String,
    pinned: bool,
) -> Result<(), String> {
    let label = note_label(&note_id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_always_on_top(pinned);
    }
    Ok(())
}

// ————————————————————————— 全局快捷键 —————————————————————————

/// 当前托管的「新建便利签」快捷键,供下次注册前注销(模式同 ScreenshotShortcutState)。
#[derive(Default)]
pub struct NoteShortcutState {
    managed: std::sync::Mutex<String>,
}

/// 注册 / 注销「新建便利签」全局快捷键(由前端在设置变化时调用)。
///
/// - `shortcut` 为空字符串表示注销且不注册。
/// - 注册失败(如与系统/其他快捷键冲突)返回错误,前端据此标红提示。
/// - 触发后向主窗口发 `note-create-trigger` 事件,由前端决定是否真的创建
///   (**会员闸门在前端**,因为需要 `hasFullAccess()` 与会员提示文案)。
#[tauri::command]
pub fn register_note_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, NoteShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();

    let prev = state.managed.lock().unwrap().clone();
    if !prev.trim().is_empty() {
        let _ = gs.unregister(prev.as_str());
    }

    let sc = shortcut.trim().to_string();
    if sc.is_empty() {
        *state.managed.lock().unwrap() = String::new();
        return Ok(());
    }

    gs.on_shortcut(sc.as_str(), move |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit_to("main", "note-create-trigger", ());
        }
    })
    .map_err(|e| format!("便利签快捷键 “{sc}” 注册失败: {e}"))?;

    crate::append_app_log(&format!("[notes] 快捷键已注册: {sc}"));
    *state.managed.lock().unwrap() = sc;
    Ok(())
}
