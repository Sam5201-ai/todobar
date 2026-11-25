//! 全局速记（随手记）独立录入窗 + 全局快捷键。
//!
//! 范式照抄 clipboard.rs：Rust 后台线程建窗（visible:false + BROWSER_ARGS 一致 +
//! probe_alive 探活）→ 前端定位居中 → show。绝不同步命令内联 build()（死锁铁律）。
//! 快捷键触发后直接显示窗口，会员闸门在前端（需要 hasFullAccess 与提示文案）。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const WINDOW_LABEL: &str = "quick-note";
const WIN_W: f64 = 460.0;
const WIN_H: f64 = 360.0;

/// 当前托管的「全局速记」快捷键，供下次注册前注销。
#[derive(Default)]
pub struct QuickNoteShortcutState {
    managed: Mutex<String>,
}

/// ★2026-11-24 压掉 Win11 给无边框透明窗叠加的系统级「窗口矩形」圆角+阴影环：
/// DWM 默认按窗口矩形绘制圆角（≈8px）与阴影，小于卡片 14px CSS 圆角的部分
/// 会透出为四角直角阴影。改为 DONOTROUND + 边框透明后，系统不再绘制窗口级
/// 圆角/阴影，视觉只剩卡片自身 CSS 圆角与 box-shadow。属性持久，resize 无需重设。
#[cfg(windows)]
fn suppress_quick_note_dwm_frame(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND,
    };
    let raw = match win.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    let hwnd = HWND(raw.0);
    unsafe {
        let pref = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
        // DWMWA_COLOR_NONE = 0xFFFFFFFE：窗口边框完全不画
        let none: u32 = 0xFFFF_FFEE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &none as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
#[cfg(not(windows))]
fn suppress_quick_note_dwm_frame(_win: &WebviewWindow) {}

/// ★2026-11-24 全局速记：正文文本框拉伸 → 窗口高度跟随。
/// 由前端 ResizeObserver 驱动（卡片实际高度换算的逻辑像素），Rust 侧直接
/// set_size 自己的窗口——不依赖 capability 通配匹配，`resizable(false)` 只拦
/// 用户拖拽边缘、不影响程序化 resize。钳制 [360, 600] 双保险（CSS 侧
/// max-height: 340 才是真正的拉伸上限）。
#[tauri::command]
pub async fn quick_note_resize(
    app: tauri::AppHandle,
    height: f64,
) -> Result<(), String> {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("quick-note window not found".into());
    };
    let h = height.clamp(WIN_H, 600.0);
    win.set_size(tauri::LogicalSize::new(WIN_W, h))
        .map_err(|e| e.to_string())
}

/// ★2026-11-23：一次性"允许显示"意图。只有新建录入窗（首次创建）时才置位；
/// 前端挂载时 take 消费。WebView 因热重载/崩溃恢复而重新挂载时意图为空 →
/// 前端保持窗口隐藏，杜绝「没操作却自己弹出随手记窗」。
/// 复用路径由 Rust 直接 show + emit reposition，前端不重新挂载，故不置位。
#[derive(Default)]
pub struct QuickNoteShowIntent(pub std::sync::atomic::AtomicBool);

/// 前端首挂载调用：取走并清空显示意图。返回 true 才允许 show。
#[tauri::command]
pub fn quick_note_take_show_intent(
    intent: tauri::State<'_, QuickNoteShowIntent>,
) -> bool {
    intent.0.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// ★2026-11-24 归档页「编辑随手记」：待编辑卡片载荷（归档页 → quick-note 窗）。
/// 归档页 invoke quick_note_open_for_edit(整卡 JSON) 存入；quick-note 窗挂载 /
/// 收到 quick-note-edit 事件时 invoke quick_note_take_pending_edit 取走（取走即清空）。
#[derive(Default)]
pub struct QuickNotePendingEdit(pub Mutex<Option<serde_json::Value>>);

/// 归档页编辑随手记：存载荷 + 唤起（或复用）quick-note 窗并通知前端进入编辑模式。
#[tauri::command]
pub fn quick_note_open_for_edit(
    app: tauri::AppHandle,
    card: serde_json::Value,
) -> Result<(), String> {
    match app.try_state::<QuickNotePendingEdit>() {
        Some(st) => *st.0.lock().unwrap() = Some(card),
        None => return Err("quick-note pending edit state missing".into()),
    }
    let existing = app.get_webview_window(WINDOW_LABEL);
    let visible = existing
        .as_ref()
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        // 窗已可见：直接通知前端（前端 reset 后取 pending 填入编辑内容）。
        if let Some(win) = existing {
            let _ = win.emit("quick-note-edit", ());
        }
        return Ok(());
    }
    // 隐藏/不存在：走常规唤起（open_inner 会 show + emit reposition → 前端 reset），
    // 延迟补发 edit 事件，确保 reset（清空旧内容）完成后再填入编辑内容。
    open_inner(app.clone(), true);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
            let _ = win.emit("quick-note-edit", ());
        }
    });
    Ok(())
}

/// quick-note 窗取走待编辑卡片（取走即清空，避免下次唤起误入编辑模式）。
#[tauri::command]
pub fn quick_note_take_pending_edit(
    app: tauri::AppHandle,
) -> Option<serde_json::Value> {
    let st = app.try_state::<QuickNotePendingEdit>()?;
    let value = st.0.lock().unwrap().take();
    value
}

/// build() Ok 不等于窗口真的可用（0.4.38 ghost 事故）；探活一次。
fn probe_alive(win: &WebviewWindow) -> bool {
    win.title().is_ok()
}

/// 显示（或 toggle 收起）录入窗。快捷键走 toggle；顶栏入口传 force_show=true。
#[tauri::command]
pub fn quick_note_open(app: tauri::AppHandle, force_show: bool) {
    open_inner(app, force_show)
}

fn open_inner(app: tauri::AppHandle, force_show: bool) {
    std::thread::spawn(move || {
        if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
            if probe_alive(&existing) {
                if !force_show && existing.is_visible().unwrap_or(false) {
                    crate::append_app_log("[quick-note] toggle hide");
                    let _ = existing.hide();
                } else {
                    let visible_before = existing.is_visible().unwrap_or(false);
                    // ★2026-11-25：先 emit 再 show（留 35ms 让前端处理完 reset + 入场
                    // 动画类）。此前「先 show 再 emit」会让窗口以全尺寸旧帧先绘一帧、
                    // 前端收到事件后再缩到 0.6 重开 —— 即「先缩小再重新打开」的观感。
                    // 复用路径前端早已挂载并注册监听，隐藏窗口的 emit 不会丢。
                    let _ = existing.emit("quick-note-reposition", ());
                    std::thread::sleep(Duration::from_millis(35));
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = existing.show();
                        let _ = existing.set_focus();
                    }
                    crate::append_app_log(&format!(
                        "[quick-note] show existing (force={force_show}, visible_before={visible_before})"
                    ));
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
        .title("Tacco 随手记")
        // ⚠️ 必须与主窗口 additionalBrowserArgs 完全一致（0.4.38 血案根因）。
        .additional_browser_args(crate::BROWSER_ARGS)
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
                    crate::append_app_log("[quick-note] window created");
                    // ★2026-11-24 压掉 Win11 系统级窗口圆角+阴影环（四角直角阴影根源）
                    suppress_quick_note_dwm_frame(&win);
                    // ★2026-11-23：首次真实建窗才置显示意图。前端首挂载 take 后 show；
                    //   WebView 重载（隐藏态重新挂载）取到 false → 保持隐藏，杜绝误弹。
                    if let Some(st) = app.try_state::<QuickNoteShowIntent>() {
                        st.0.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    #[cfg(target_os = "macos")]
                    center_and_show_on_main_monitor(&win);
                } else {
                    crate::append_app_log("[quick-note] build() Ok 但探活失败(ghost)");
                    let _ = win.close();
                }
            }
            Err(e) => crate::append_app_log(&format!("[quick-note] window 创建失败: {e}")),
        }
    });
}

/// macOS：Rust 侧直接居中主显示器并 show（绕开前端 cursorPosition 坐标系差异）。
#[cfg(target_os = "macos")]
fn center_and_show_on_main_monitor(win: &WebviewWindow) {
    use tauri::PhysicalPosition;
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        let sf = monitor.scale_factor();
        let w = (WIN_W * sf).round() as i32;
        let h = (WIN_H * sf).round() as i32;
        let x = pos.x + ((size.width as i32) - w) / 2;
        let y = pos.y + ((size.height as i32) - h) / 2;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// 收起录入窗（前端保存 / Esc 调用）。
#[tauri::command]
pub fn quick_note_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

/// 注册 / 注销全局速记快捷键。触发后向主窗发 `quick-note-open-trigger`，
/// 主窗做会员闸门后调用 quick_note_open（快捷键路径也要过闸门）。
#[tauri::command]
pub fn register_quick_note_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, QuickNoteShortcutState>,
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
            let _ = app.emit_to("main", "quick-note-open-trigger", ());
        }
    })
    .map_err(|e| format!("随手记快捷键 “{sc}” 注册失败: {e}"))?;
    crate::append_app_log(&format!("[quick-note] 快捷键已注册: {sc}"));
    *state.managed.lock().unwrap() = sc;
    Ok(())
}
