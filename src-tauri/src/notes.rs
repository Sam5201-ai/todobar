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

        // ② 新建窗口
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            label.as_str(),
            WebviewUrl::App(PathBuf::new()),
        )
        .title("TickTask 便利签")
        // ⚠️ 必须与主窗口 (tauri.conf.json app.windows[0].additionalBrowserArgs) 完全一致,
        // 否则第二个便利签起创建必失败(0.4.38 同款根因)。
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream",
        )
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
                } else {
                    crate::append_app_log(&format!(
                        "[notes] build() Ok 但探活失败 label={label}(ghost)"
                    ));
                    let _ = win.close();
                }
            }
            Err(e) => crate::append_app_log(&format!("[notes] 窗口创建失败 label={label}: {e}")),
        }
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
