//! 截图 / 贴图功能所需的 Rust 侧能力。
//!
//! - `stash_image` / `take_image`:进程内键值存储,用于在「主窗口 → 覆盖层 → 贴图窗口」
//!   之间传递截图数据(避免大块 base64 走 localStorage 的体积限制)。
//! - `capture_screen`:仅 Windows,按**光标所在显示器**抓屏(GDI BitBlt,物理像素,
//!   逐屏 DPI),并携带该屏 scaleFactor —— 根治多屏混合缩放错位。
//! - `show_capture_overlay` / `hide_window`:预热常驻覆盖层窗口的定位显示 / 隐藏。
//! - `show_pin_window` / `dismiss_pin_window` / `find_pin_window`:贴图窗口池
//!   (静态预热 pin-1/pin-2 复用,超出时 Rust 动态建窗,与主窗 additionalBrowserArgs
//!   严格一致 —— WebView2 同进程同数据目录环境一致性铁律,否则 0x8007139F)。
//! - `write_clipboard_image` / `save_image` / `read_clipboard_image`:PNG(base64)的剪贴板与落盘。
//! - `window_at_point`:窗口截图模式下,返回光标下方(排除自身窗口)的顶层窗口矩形。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

/// 进程内共享状态:截图数据暂存区 + 贴图窗口注册表(pinId → 窗口 label)。
#[derive(Default)]
pub struct AppState {
    pub stash: Mutex<HashMap<String, String>>,
    pub pins: Mutex<HashMap<String, String>>,
}

/// 一次抓屏结果(光标所在显示器)。
///
/// 注意:整屏 PNG 体积可能很大(高分屏可达数 MB)。
/// 早期实现把整张图 base64 后通过 Tauri IPC 返回,在真实机器上会撑爆 WebView
/// 内存 / 卡死 IPC,表现为「一直显示截图中」「应用整个消失」。
/// 现改为:截屏后直接写临时文件,这里只回传路径 + 尺寸 + 缩放比,前端用 convertFileSrc
/// 走 asset:// 协议加载,彻底绕开大体积 IPC。
#[derive(Serialize, Clone)]
pub struct ScreenCapture {
    /// 抓取的显示器左上角物理 X(虚拟屏坐标系,可能为负,对应副屏在左)。
    pub left: i32,
    /// 抓取的显示器左上角物理 Y。
    pub top: i32,
    /// 物理像素宽。
    pub width: u32,
    /// 物理像素高。
    pub height: u32,
    /// 该显示器逻辑缩放比(scaleFactor,如 125% => 1.25)。
    /// 前端用它对整屏物理尺寸做逻辑换算,确保覆盖层与屏幕 1:1 对齐。
    pub scale: f64,
    /// 截屏 PNG 的本地临时文件路径(前端用 convertFileSrc 转成 asset:// 加载)。
    pub path: String,
}

/// 矩形区域。
#[derive(Serialize, Clone)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn stash_image(state: tauri::State<AppState>, key: String, value: String) {
    state.stash.lock().unwrap().insert(key, value);
}

#[tauri::command]
pub fn take_image(state: tauri::State<AppState>, key: String) -> Option<String> {
    state.stash.lock().unwrap().remove(&key)
}

/// 读取本工具生成的临时截图 PNG,返回 base64。
/// 前端改用 data: URL 加载整屏图:asset:// 协议跨源会把 canvas 标记为 tainted,
/// 之后 toDataURL() 抛 SecurityError(复制/贴图/保存全军覆没的根因)。
/// 安全:只接受文件名为 ticktask_shot_*.png 的路径,防止任意文件读取。
#[tauri::command]
pub fn read_capture_png(path: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use std::path::Path;

    let p = Path::new(&path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "非法路径".to_string())?;
    if !name.starts_with("ticktask_shot_") || !name.ends_with(".png") {
        return Err("拒绝读取非截图临时文件".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取截图失败: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

/// 设置指定窗口是否忽略鼠标事件(用于贴图窗口的「鼠标穿透」)。
#[tauri::command]
pub fn set_window_ignore_cursor_events(
    app: tauri::AppHandle,
    label: String,
    value: bool,
) -> Result<(), String> {
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口 {label} 不存在"))?;
    w.set_ignore_cursor_events(value)
        .map_err(|e| e.to_string())
}

/// 关闭指定窗口(真销毁;贴图池窗口请用 `dismiss_pin_window` 区分处理)。
#[tauri::command]
pub fn close_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        w.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

// ===========================================================================
// 预热窗口管理(平台无关,基于 tauri 窗口 API)
// ===========================================================================

/// 静态预热贴图窗口池的 label(tauri.conf.json 中定义,启动即创建并隐藏)。
const PIN_POOL_LABELS: [&str; 2] = ["pin-1", "pin-2"];

/// 上次覆盖层的定位矩形(物理像素)。相同目标屏重复截图时跳过 set_position/set_size,
/// 避免 WebView2 窗口每次重排引发的可感知闪烁/缩放弹动。
static LAST_OVERLAY_RECT: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None);

/// 仅定位覆盖层(**隐藏态**下按物理像素设置位置与尺寸),不显示。
/// 拆分自 show_capture_overlay(0.4.41):旧实现定位与显示同帧执行,WebView2
/// 首帧可能还是按旧窗口尺寸栅格化的画面 —— 用户看到「先出现一个框,再快速
/// 闪烁成全屏截图」。现在前端在加载/绘制冻结帧**之前**先调本命令,隐藏态完成
/// 重排(数百毫秒),首帧上屏就是正确尺寸,零闪框。同一矩形重复截图则跳过重排。
#[tauri::command]
pub fn position_capture_overlay(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let w = app
        .get_webview_window("capture-overlay")
        .ok_or_else(|| "覆盖层窗口未预热(请重启应用)".to_string())?;
    let mut last = LAST_OVERLAY_RECT.lock().unwrap();
    if *last != Some((left, top, width, height)) {
        w.set_position(tauri::PhysicalPosition::new(left, top))
            .map_err(|e| e.to_string())?;
        w.set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        *last = Some((left, top, width, height));
    }
    Ok(())
}

/// 显示截图覆盖层(此前已由 position_capture_overlay 定位、前端已画好冻结帧)。
///
/// 0.4.41 再修:**只显示覆盖层,绝不动主窗**。主窗与覆盖层同为 alwaysOnTop,
/// 覆盖层后显示必然盖在主窗之上 —— 旧实现隐藏主窗纯属多余,反而引入两个 bug:
/// ① 主窗 hide 后 WebView2 渲染挂起,退出时 show 首帧跳变 → 「退出弹动」;
/// ② 「覆盖层出现」与「主窗消失」之间需要靠冻结帧遮盖,任何时序抖动都闪屏。
/// 不碰主窗后:冻结帧内容 = 抓屏时的桌面(含主窗),与真实桌面逐像素一致,
/// 显示/隐藏覆盖层都是无感过渡。
#[tauri::command]
pub fn show_capture_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("capture-overlay")
        .ok_or_else(|| "覆盖层窗口未预热(请重启应用)".to_string())?;
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

/// 结束截图:仅隐藏覆盖层(0.4.41 终版)。
///
/// 前端在调用本命令前已把覆盖层复位为**透明待命帧**并等待两帧合成上屏 ——
/// 此时窗口内容与真实桌面逐像素一致(主窗全程未被隐藏,一直在覆盖层下方),
/// 隐藏窗口不产生任何视觉变化 → 退出零弹动、零闪烁。
/// 主窗也不再被 show/set_focus:它从未消失;且不抢焦点可让**刚钉出的贴图
/// 保持焦点(蓝色边框)**,用户一眼看到贴图在哪(参考 PixPin)。
/// 兜底:若主窗因历史路径处于隐藏态,恢复其可见性(不抢焦点)。
#[tauri::command]
pub fn finish_capture_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("capture-overlay") {
        let _ = w.hide();
    }
    if let Some(m) = app.get_webview_window("main") {
        if !m.is_visible().unwrap_or(true) {
            let _ = m.show();
        }
    }
    Ok(())
}

/// 查询截图覆盖层是否处于激活(可见)状态 —— 贴图快捷键据此决定:
/// 激活时把动作转发给覆盖层(钉当前选区),否则走剪贴板/上次截图流程。
#[tauri::command]
pub fn is_overlay_active(app: tauri::AppHandle) -> bool {
    app.get_webview_window("capture-overlay")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 隐藏指定窗口(覆盖层 / 贴图池窗口用,不销毁,下次直接复用,零冷启动)。
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        w.hide().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// 显示贴图窗口:优先复用静态预热池(pin-1/pin-2,隐藏即空闲),池满则动态建窗。
/// 返回实际使用的窗口 label —— 前端以 `pin-meta:<label>` 写入元数据后
/// emit `pin-set` 事件通知(已挂载的池窗)或由挂载时读取(动态新窗)。
#[tauri::command]
pub fn show_pin_window(
    app: tauri::AppHandle,
    pin_id: String,
    x: Option<i32>,
    y: Option<i32>,
    width: i32,
    height: i32,
) -> Result<String, String> {
    let (w, h) = (width.max(80) as u32, height.max(80) as u32);
    // 默认位置:光标附近(贴图快捷键从剪贴板钉出时无选区坐标)。
    let (px, py) = match (x, y) {
        (Some(x), Some(y)) => (x, y),
        _ => {
            let (cx, cy) = imp::cursor_pos().unwrap_or((200, 200));
            (cx - (w as i32) / 2, cy - (h as i32) / 2)
        }
    };
    // 边界保护:别钉到屏幕外太远。
    let px = px.clamp(-((w as i32) / 2), 32767);
    let py = py.clamp(-((h as i32) / 2), 32767);

    // ① 池窗复用:隐藏 = 空闲。只做物理定位 + 尺寸,**不在此处 show**——
    //    由前端 PinWindow 装载完新图后自行 show:旧实现立即 show,窗口内容还是
    //    上一张贴图(或空白),被拉伸到新窗口尺寸 → 用户看到「先变形后恢复」。
    for cand in PIN_POOL_LABELS {
        if let Some(win) = app.get_webview_window(cand) {
            if win.is_visible().unwrap_or(true) {
                continue; // 被占用
            }
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
            let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
            app.state::<AppState>()
                .pins
                .lock()
                .unwrap()
                .insert(pin_id.clone(), cand.to_string());
            return Ok(cand.to_string());
        }
    }

    // ② 动态建窗(线程内 build —— 0.4.21 死锁铁律:同步命令内联 build() 会卡死主线程)。
    //    additionalBrowserArgs 必须与主窗口完全一致(0x8007139F 铁律),也因此
    //    与主窗共享 WebView2 用户数据目录 → localStorage 跨窗口共享,贴图历史可用。
    let label = format!("pin-dyn-{pin_id}");
    if app.get_webview_window(&label).is_some() {
        return Ok(label);
    }
    let build_label = label.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let builder = tauri::WebviewWindowBuilder::new(
            &app_for_thread,
            build_label.as_str(),
            tauri::WebviewUrl::App(std::path::PathBuf::new()),
        )
        .title("TickTask 贴图")
        // ⚠️ 与主窗口 additionalBrowserArgs 完全一致(WebView2 环境一致性铁律)!
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream",
        )
        .inner_size(w as f64, h as f64)
        .position(px as f64, py as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible(false);
        match builder.build() {
            Ok(win) => {
                // 物理尺寸 / 位置精确对齐(builder 用的是逻辑值,此处以物理值覆盖)。
                // 不在此处 show:等前端 PinWindow 装载完图片后自行 show(同池窗)。
                let _ = win.set_size(tauri::PhysicalSize::new(w, h));
                let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
            }
            Err(e) => {
                eprintln!("[screenshot] 贴图动态窗口创建失败: {e}");
            }
        }
    });
    app.state::<AppState>()
        .pins
        .lock()
        .unwrap()
        .insert(pin_id.clone(), label.clone());
    Ok(label)
}

/// 关闭贴图窗口:池窗(pin-1/pin-2)只隐藏归还池;动态窗(pin-dyn-*)真销毁。
#[tauri::command]
pub fn dismiss_pin_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    // 联动清理:贴图关闭时同步关掉它的穿透控制条窗口(若开着)。
    if let Some(ctl) = app.get_webview_window(&format!("pinctl-{label}")) {
        let _ = ctl.close();
    }
    // 反查注册表,清理 pinId → label 映射。
    {
        let state = app.state::<AppState>();
        let mut pins = state.pins.lock().unwrap();
        pins.retain(|_, l| l != &label);
    }
    if PIN_POOL_LABELS.contains(&label.as_str()) {
        if let Some(w) = app.get_webview_window(&label) {
            // 归还池前复位穿透状态,避免复用时残留「点不动」。
            let _ = w.set_ignore_cursor_events(false);
            let _ = w.hide();
        }
        Ok(())
    } else if let Some(w) = app.get_webview_window(&label) {
        w.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// 显示贴图的「穿透控制条」窗口(参考 PixPin):鼠标穿透开启后,贴图窗口本身
/// 收不到任何鼠标事件(WS_EX_TRANSPARENT 是整窗级),控制条必须做成**独立
/// 不穿透小窗**才能交互(调节不透明度 / 拖动贴图 / 关闭贴图)。
///
/// - label 规则:`pinctl-{贴图label}`,前端控制窗组件从自身 label 反推目标贴图。
/// - 前端传**物理像素** px/py/pw/ph(与贴图窗口所在屏同 scale)。
/// - 已存在则只重定位/重设尺寸(不代 show:前端挂载后自显,复用时前端 emit
///   `pinctl-show` 通知自显,避免内容未就绪先闪空窗)。
#[tauri::command]
pub fn show_pin_control(
    app: tauri::AppHandle,
    target: String,
    px: i32,
    py: i32,
    pw: i32,
    ph: i32,
) -> Result<(), String> {
    let label = format!("pinctl-{target}");
    if let Some(w) = app.get_webview_window(&label) {
        // 复用:重定位 + 重设尺寸(前端 emit pinctl-show 后自显)。
        let _ = w.set_size(tauri::PhysicalSize::new(pw.max(80) as u32, ph.max(40) as u32));
        let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
        return Ok(());
    }
    // 线程内 build(死锁铁律:同步命令内联 build() 卡死主线程)。
    // additionalBrowserArgs 必须与主窗一致(WebView2 环境一致性铁律)。
    let build_label = label.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let builder = tauri::WebviewWindowBuilder::new(
            &app_for_thread,
            build_label.as_str(),
            tauri::WebviewUrl::App(std::path::PathBuf::new()),
        )
        .title("贴图控制条")
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream",
        )
        .inner_size(pw.max(80) as f64, ph.max(40) as f64)
        .position(px as f64, py as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible(false);
        if let Ok(win) = builder.build() {
            let _ = win.set_size(tauri::PhysicalSize::new(pw.max(80) as u32, ph.max(40) as u32));
            let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        }
    });
    Ok(())
}

/// 隐藏(销毁)贴图的控制条窗口:穿透关闭 / 贴图关闭时调用。
#[tauri::command]
pub fn hide_pin_control(app: tauri::AppHandle, target: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&format!("pinctl-{target}")) {
        let _ = w.close();
    }
    Ok(())
}

/// 拖动穿透贴图:控制条的拖拽把手拖动时,把**贴图窗口**与**控制条窗口**一起
/// 平移物理 delta(前端 pointermove 累计 screenX/screenY 乘 scaleFactor)。
#[tauri::command]
pub fn move_pin_control(
    app: tauri::AppHandle,
    target: String,
    dx: i32,
    dy: i32,
) -> Result<(), String> {
    if dx == 0 && dy == 0 {
        return Ok(());
    }
    if let Some(t) = app.get_webview_window(&target) {
        if let Ok(p) = t.outer_position() {
            let _ = t.set_position(tauri::PhysicalPosition::new(p.x + dx, p.y + dy));
        }
    }
    if let Some(c) = app.get_webview_window(&format!("pinctl-{target}")) {
        if let Ok(p) = c.outer_position() {
            let _ = c.set_position(tauri::PhysicalPosition::new(p.x + dx, p.y + dy));
        }
    }
    Ok(())
}

/// 查询某张贴图当前所在窗口 label(设置页历史管理用)。
#[tauri::command]
pub fn find_pin_window(app: tauri::AppHandle, pin_id: String) -> Option<String> {
    app.state::<AppState>()
        .pins
        .lock()
        .unwrap()
        .get(&pin_id)
        .cloned()
}

// ===========================================================================
// Windows 实现
// ===========================================================================
#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};

    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::HiDpi::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::BOOL;

    fn b64_encode(bytes: &[u8]) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.encode(bytes)
    }

    fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD
            .decode(s)
            .map_err(|e| format!("base64 解码失败: {e}"))
    }

    fn local_timestamp() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        secs.to_string()
    }

    /// 截屏临时文件序号:保证连续截图互不覆盖(早期固定文件名,快速连按会被旧图覆盖)。
    static SHOT_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 获取当前光标物理坐标(虚拟屏坐标系)。
    pub fn cursor_pos() -> Option<(i32, i32)> {
        unsafe {
            let mut pt = POINT::default();
            if GetCursorPos(&mut pt).is_err() {
                return None;
            }
            Some((pt.x, pt.y))
        }
    }

    /// 抓取给定物理像素矩形(虚拟屏坐标系)为 PNG 临时文件。
    /// GDI BitBlt + BGRA→RGBA + image 编码;采集的是已渲染的桌面合成帧。
    fn capture_rect_to_png(
        left: i32,
        top: i32,
        width: i32,
        height: i32,
        scale: f64,
    ) -> Result<ScreenCapture, String> {
        if width <= 0 || height <= 0 {
            return Err("抓取区域尺寸非法".into());
        }
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("无法获取屏幕 DC".into());
            }

            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            let prev = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

            if BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                Some(screen_dc),
                left,
                top,
                SRCCOPY,
            )
            .is_err()
            {
                let _ = SelectObject(mem_dc, prev);
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err("屏幕捕获(BitBlt)失败".into());
            }

            let header = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负数 => 自上而下,无需翻转
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut info = BITMAPINFO {
                bmiHeader: header,
                bmiColors: Default::default(),
            };
            let mut buf: Vec<u8> = vec![0u8; width as usize * height as usize * 4];
            let copied = GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if copied == 0 {
                let _ = SelectObject(mem_dc, prev);
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err("读取位图数据(GetDIBits)失败".into());
            }

            // GDI 返回 BGRA,逐像素换序为 RGBA。
            let mut rgba: Vec<u8> = Vec::with_capacity(buf.len());
            for chunk in buf.chunks_exact(4) {
                rgba.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]]);
            }

            let _ = SelectObject(mem_dc, prev);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);

            let img = match image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(
                width as u32,
                height as u32,
                rgba,
            ) {
                Some(v) => v,
                None => return Err("图像缓冲构建失败".into()),
            };
            let dyn_img = image::DynamicImage::ImageRgba8(img);
            let mut png_bytes: Vec<u8> = Vec::new();
            {
                let mut cursor = std::io::Cursor::new(&mut png_bytes);
                dyn_img
                    .write_to(&mut cursor, image::ImageFormat::Png)
                    .map_err(|e| format!("PNG 编码失败: {e}"))?;
            }

            // 落地为临时文件,再回传路径(避免把整屏图经 IPC 以 base64 传出导致卡死)。
            // 文件名含序号:连续截图不覆盖。
            let seq = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("ticktask_shot_{}_{seq}.png", std::process::id()));
            std::fs::write(&path, &png_bytes).map_err(|e| format!("写入截图临时文件失败: {e}"))?;

            Ok(ScreenCapture {
                left,
                top,
                width: width as u32,
                height: height as u32,
                scale,
                path: path.to_string_lossy().into_owned(),
            })
        }
    }

    /// 抓取**光标所在显示器**(整屏物理像素 + 该屏 scaleFactor)。
    ///
    /// 这是 B 路线对多屏混合 DPI 错位的根治点:旧实现抓整块虚拟屏、却只用主窗
    /// 所在屏的 scaleFactor 做除法 → 100%/125%/150% 混接时覆盖层必错位。
    /// 现在抓哪块屏就带哪块屏的 scale,且窗口定位全走物理像素,不再做前端换算。
    #[tauri::command]
    pub fn capture_screen() -> Result<ScreenCapture, String> {
        unsafe {
            // 让进程按每显示器 DPI 感知,这样所有 GDI / monitor API 返回物理像素。
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            // ① 光标 → 所在显示器 → 物理矩形 + 有效 DPI。
            if let Some((cx, cy)) = cursor_pos() {
                let hmon = MonitorFromPoint(POINT { x: cx, y: cy }, MONITOR_DEFAULTTONEAREST);
                if !hmon.is_invalid() {
                    let mut info = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if GetMonitorInfoW(hmon, &mut info).as_bool() {
                        let r = info.rcMonitor; // 物理像素矩形(虚拟屏坐标系)
                        let mut dpi_x: u32 = 96;
                        let mut dpi_y: u32 = 96;
                        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
                        let scale = dpi_x as f64 / 96.0;
                        return capture_rect_to_png(
                            r.left,
                            r.top,
                            r.right - r.left,
                            r.bottom - r.top,
                            if scale > 0.0 { scale } else { 1.0 },
                        );
                    }
                }
            }

            // ② 兜底:光标 / 显示器信息获取失败 → 整块虚拟屏 + 主屏 DPI。
            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("无法获取虚拟屏幕尺寸".into());
            }
            let scale = {
                let hdc = GetDC(None);
                let dpi = if hdc.is_invalid() {
                    96
                } else {
                    let d = GetDeviceCaps(Some(hdc), LOGPIXELSX);
                    let _ = ReleaseDC(None, hdc);
                    if d > 0 { d } else { 96 }
                };
                dpi as f64 / 96.0
            };
            capture_rect_to_png(left, top, width, height, if scale > 0.0 { scale } else { 1.0 })
        }
    }

    #[tauri::command]
    pub fn write_clipboard_image(png_base64: String) -> Result<(), String> {
        let bytes = b64_decode(&png_base64)?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("解码 PNG 失败: {e}"))?;
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let data = rgba.into_raw();
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("剪贴板初始化失败: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: std::borrow::Cow::Owned(data),
            })
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        Ok(())
    }

    #[tauri::command]
    pub fn read_clipboard_image() -> Option<String> {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return None,
        };
        let img = match clipboard.get_image() {
            Ok(i) => i,
            Err(_) => return None,
        };
        let width = img.width as u32;
        let height = img.height as u32;
        let rgba = img.bytes.into_owned();
        let img_buf =
            match image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba) {
                Some(v) => v,
                None => return None,
            };
        let dyn_img = image::DynamicImage::ImageRgba8(img_buf);
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            if dyn_img
                .write_to(&mut cursor, image::ImageFormat::Png)
                .is_err()
            {
                return None;
            }
        }
        Some(b64_encode(&png_bytes))
    }

    #[tauri::command]
    pub fn save_image(png_base64: String, dir: Option<String>) -> Result<String, String> {
        let bytes = b64_decode(&png_base64)?;
        let base = match dir {
            Some(d) => d,
            None => {
                let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
                format!("{}\\Pictures\\TickTask", home)
            }
        };
        std::fs::create_dir_all(&base).map_err(|e| format!("创建目录失败: {e}"))?;
        let stamp = local_timestamp();
        let name = format!("TickTask-截屏-{}.png", stamp);
        let path = std::path::Path::new(&base).join(&name);
        std::fs::write(&path, &bytes).map_err(|e| format!("保存文件失败: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// 「另存为」:把选区 PNG 写入用户在保存对话框中选择的路径。
    /// 仅接受 .png 扩展名(前端对话框已过滤,这里兜底校验)。
    #[tauri::command]
    pub fn save_image_to(png_base64: String, path: String) -> Result<String, String> {
        let bytes = b64_decode(&png_base64)?;
        let p = std::path::Path::new(&path);
        let is_png = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if !is_png {
            return Err("仅支持保存为 PNG 文件".to_string());
        }
        std::fs::write(p, &bytes).map_err(|e| format!("保存文件失败: {e}"))?;
        Ok(path)
    }

    // ---- 窗口检测(窗口截图模式) ----
    static WINDOW_RESULT: Mutex<Option<Rect>> = Mutex::new(None);

    struct EnumCtx {
        point: POINT,
    }

    extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &*(lparam.0 as *const EnumCtx);
            if !IsWindowVisible(hwnd).as_bool() {
                return TRUE;
            }
            if IsIconic(hwnd).as_bool() {
                return TRUE;
            }
            // 跳过自身窗口(标题以 TickTask 开头)。
            let mut buf: Vec<u16> = vec![0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            if len > 0 {
                let t: String = buf[..len as usize]
                    .iter()
                    .map(|&c| char::from_u32(c as u32).unwrap_or(' '))
                    .collect();
                if t.starts_with("TickTask") {
                    return TRUE;
                }
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let x = ctx.point.x;
                let y = ctx.point.y;
                if x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom {
                    *WINDOW_RESULT.lock().unwrap() = Some(Rect {
                        x: rect.left,
                        y: rect.top,
                        width: (rect.right - rect.left) as u32,
                        height: (rect.bottom - rect.top) as u32,
                    });
                }
            }
            TRUE
        }
    }

    #[tauri::command]
    pub fn window_at_point(x: i32, y: i32) -> Option<Rect> {
        unsafe {
            *WINDOW_RESULT.lock().unwrap() = None;
            let ctx = EnumCtx {
                point: POINT { x, y },
            };
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM((&ctx as *const EnumCtx) as *const c_void as isize),
            );
            WINDOW_RESULT.lock().unwrap().clone()
        }
    }
}

// ===========================================================================
// 非 Windows 占位实现
// ===========================================================================
#[cfg(not(windows))]
mod imp {
    use super::*;

    /// 非平台目标:仅保证编译完整,截图功能入口在 capture_screen 处报错。
    pub fn cursor_pos() -> Option<(i32, i32)> {
        None
    }

    #[tauri::command]
    pub fn capture_screen() -> Result<ScreenCapture, String> {
        Err("截图功能仅支持 Windows".into())
    }

    #[tauri::command]
    pub fn write_clipboard_image(_png_base64: String) -> Result<(), String> {
        Err("截图功能仅支持 Windows".into())
    }

    #[tauri::command]
    pub fn read_clipboard_image() -> Option<String> {
        None
    }

    #[tauri::command]
    pub fn save_image(_png_base64: String, _dir: Option<String>) -> Result<String, String> {
        Err("截图功能仅支持 Windows".into())
    }

    #[tauri::command]
    pub fn window_at_point(_x: i32, _y: i32) -> Option<Rect> {
        None
    }
}

pub use imp::*;
