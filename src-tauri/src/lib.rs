use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod notes;
mod screenshot;
mod clipboard;

/// 截图 / 贴图快捷键托管状态:记录本轮已注册的全局快捷键,便于下次注册前注销。
#[derive(Default)]
struct ScreenshotShortcutState {
    managed: Mutex<Vec<String>>,
}

/// 窗口开 / 关(呼出 / 收起主窗口)全局快捷键托管状态:记录当前生效的快捷键串,
/// 便于设置变更时注销旧键后再注册新键。
#[derive(Default)]
struct ToggleWindowShortcutState {
    current: Mutex<Option<String>>,
}

/// 应用内更新:把前端用「浏览器」下载好的安装包字节落盘到临时目录。
///
/// 注意:下载改由前端 fetch 完成,不再用 Rust 直连。
/// 原因:此前用 ureq 直连在代理/特殊网络环境下会失败(浏览器能下、Rust 下不动),
/// 且下载代码编译进已安装的旧版 exe,无法靠发新版自我修复——旧版下载失败就只能手动下。
/// 改为浏览器下载后,网络走用户浏览器,稳定可靠。
#[tauri::command]
fn save_update_file(data: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|e| format!("解码安装包失败: {e}"))?;
    let dest = std::env::temp_dir().join("TickTask-setup.exe");
    // 上一次更新中断可能留下被占用的残留文件(如安装向导还开着),先尝试删除。
    let _ = std::fs::remove_file(&dest);
    let mut file = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败: {e}"))?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    file.flush().ok();
    drop(file);
    Ok(dest.to_string_lossy().into_owned())
}

/// 应用内更新:拉起 NSIS 安装程序并退出当前应用。
///
/// 直用 `Command::spawn(path)` 有三个坑,正是此前「点了下载安装却毫无反应」的原因:
/// 1) 安装向导启动时本程序仍在运行,待覆盖的 exe 被占用,NSIS 会以「应用正在运行」拦截;
/// 2) 子进程由本程序派生,常因 Windows 前台激活策略被挡在其他窗口后面,看起来像没启动;
/// 3) 需要 UAC 提权时 CreateProcess 会直接失败(os error 740),只有 ShellExecute 才会正常弹 UAC。
///
/// 因此改为:先开一个 DETACHED 的 cmd,等本程序退出后再用 `start`(走 ShellExecute 语义)
/// 拉起安装向导,本程序随即退出以释放待覆盖的文件。
#[tauri::command]
fn install_update(path: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // 延时约 3 秒再拉起安装程序,确保本进程已经退出、文件不再被占用。
        // 用 `ping -n 4` 做延时:`timeout` 在无控制台的 DETACHED 进程里会报
        // 「输入重定向不受支持」直接失效,ping 不依赖控制台输入。
        //
        // 必须用 `raw_arg` 原样传整段脚本:普通 .args() 会把脚本内的引号按
        // MSVCRT 约定转义成 \",而 cmd 不认 \" 转义,导致 `start` 把目标解析成
        // `\`,弹出「Windows 找不到 '\' 文件」。
        let script = format!(
            "ping -n 4 127.0.0.1 >nul & start \"\" \"{}\"",
            path.replace('"', "")
        );
        let detached = std::process::Command::new("cmd")
            .arg("/C")
            .raw_arg(script)
            .creation_flags(DETACHED_PROCESS)
            .spawn();

        if let Err(e) = detached {
            // 兜底:直接拉起安装程序(非延时),失败才向上报错。
            std::process::Command::new(&path)
                .spawn()
                .map_err(|e2| format!("启动安装程序失败: {e}({e2})"))?;
        }

        // 立即退出当前应用,释放待覆盖的 exe;延时的 cmd 已脱离本进程,不受影响。
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            app.exit(0);
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (&path, &app);
        Err("应用内安装更新仅支持 Windows".to_string())
    }
}

// ============================================================================
// [0.4.10] Windows 自愈三件套:提权降权、自启动注册表自愈、WebView2 启动看门狗。
//
// 背景:应用内更新拉起 NSIS 安装器(UAC 提权)后,安装器完成页会以提权上下文启动应用,
// 产生「管理员权限」的实例。提权实例隐藏在托盘常驻并锁死 WebView2 用户数据目录
// (%LOCALAPPDATA%\<identifier>\EBWebView),之后所有普通权限实例的 WebView2 环境创建
// 都会失败——主进程活着、窗口有画面(死帧),但任何点击都无响应,且卸载重装均无效。
// 另外 productName 从 0.1.x 的 Todobar 改为 TickTask 后,旧版写入的自启动注册表条目
// (Todobar -> D:\电脑软件\Todobar\todobar.exe)永远不会被新版的自愈逻辑覆盖,
// 导致每次开机自启的都是旧版本。
// ============================================================================

/// 检测当前进程是否以管理员(提权)令牌运行。
#[cfg(windows)]
fn is_elevated() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = Default::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elev = TOKEN_ELEVATION::default();
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elev.TokenIsElevated != 0
    }
}

fn win_msg_box(text: &str) {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
        let mut w: Vec<u16> = text.encode_utf16().collect();
        w.push(0);
        let mut t: Vec<u16> = "TickTask".encode_utf16().collect();
        t.push(0);
        unsafe {
            MessageBoxW(None, PCWSTR(w.as_ptr()), PCWSTR(t.as_ptr()), MB_OK | MB_ICONWARNING);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = text;
    }
}

/// 提权自检:若当前进程以管理员运行,改由 explorer 代理降权重启,然后退出本进程。
///
/// explorer 以普通用户令牌运行,由它代为启动的应用继承普通权限,从源头杜绝
/// 「提权实例锁死 WebView2 数据目录」。flag 文件防止极端环境下的无限重启循环。
#[cfg(windows)]
fn handle_elevation(app: &tauri::AppHandle) {
    // [0.4.48] 开发构建一律直通,不降权重启。
    // `tauri dev` 常在「管理员 PowerShell」里启动;若沿用 release 的降权自愈,
    // 会出现「提权实例 + explorer 启动的降权实例」同时抢同一个 WebView2 用户数据目录,
    // 表现为前端初始化失败、show_main_window_ready 发不出、窗口空白或不显示。
    // 该自愈逻辑只对 release(应用内更新提权)有意义。
    if cfg!(debug_assertions) {
        return;
    }
    if !is_elevated() {
        // 正常启动:清理可能残留的标记。
        if let Some(home) = std::env::var("USERPROFILE").ok() {
            let _ = std::fs::remove_file(
                PathBuf::from(home).join(".ticktask").join("elevated_relaunch.flag"),
            );
        }
        return;
    }

    let flag = std::env::var("USERPROFILE")
        .ok()
        .map(|h| PathBuf::from(h).join(".ticktask").join("elevated_relaunch.flag"));

    if let Some(flag) = flag {
        if flag.exists() {
            // 上一次降权重启后仍是提权(异常环境),不再循环,给出指引后继续运行。
            let _ = std::fs::remove_file(&flag);
            win_msg_box(
                "TickTask 正以管理员身份运行,这可能导致界面假死。\n\
                 请关闭本程序后,直接双击桌面图标启动(不要右键\"以管理员身份运行\")。",
            );
            return;
        }
        if let Some(parent) = flag.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&flag, b"1");

        // 由 explorer 代理启动(降权),随后退出当前提权进程。
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new("explorer.exe").arg(&exe).spawn();
        }
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            handle.exit(0);
        });
    }
}

/// 自启动注册表自愈:
/// 1) 删除 productName 改名前(Todobar 0.1.x)遗留的 Run 条目——它指向旧安装位置,
///    是「每次开机自启旧版本」的直接原因;
/// 2) 按 ~/.ticktask/prefs.json 的 sidebar.launchAtLogin **无条件**重写自启条目。
///    旧逻辑只在 is_enabled 时重写,而新版条目从未建立过时永远不会纠正。
#[cfg(windows)]
fn fix_autostart(app: &tauri::AppHandle) {
    // 1) 清理改名前遗留的旧条目(仅删值,不动旧安装的文件;旧版可随时在系统里正常卸载)。
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(run) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        ) {
            let _ = run.delete_value("Todobar");
        }
    }

    // 2) 按持久化偏好重写当前版本的自启条目。
    let launch_at_login = read_prefs_map()
        .get("sidebar")
        .and_then(|v| v.get("launchAtLogin"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if launch_at_login {
        // 无条件重写:每次启动都用当前 exe 路径覆盖,杜绝「路径指向旧版本」。
        let _ = autostart.disable();
        let _ = autostart.enable();
    } else {
        let _ = autostart.disable();
    }
}

/// 枚举系统进程,判断是否存在父进程为本进程的 WebView2 渲染子进程。
#[cfg(windows)]
fn has_webview_child() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let my_pid = std::process::id();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return true, // 快照失败时不误报
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(&entry.szExeFile);
                let name = name.trim_end_matches('\0');
                if name.eq_ignore_ascii_case("msedgewebview2.exe")
                    && entry.th32ParentProcessID == my_pid
                {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// WebView2 启动看门狗:12 秒后若仍没有任何 WebView2 子进程,说明用户数据目录
/// 很可能被残留进程锁死(典型于更新/重装后)。弹原生提示框给出恢复指引,
/// 不再让窗口停留在「有画面但点不动」的静默假死状态。
#[cfg(windows)]
fn spawn_webview_watchdog() {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(12));
        if has_webview_child() {
            return;
        }
        win_msg_box(
            "主界面未能加载:WebView2 无法启动。\n\n\
             最常见原因是上一次更新/重装残留的后台进程仍占用数据目录。\n\n\
             恢复方法(二选一):\n\
             1. 重启电脑后再次打开 TickTask(推荐);\n\
             2. 打开任务管理器,结束所有 todobar.exe 进程后重新打开本程序。",
        );
    });
}

#[cfg(not(windows))]
fn handle_elevation(_app: &tauri::AppHandle) {}
#[cfg(not(windows))]
fn fix_autostart(_app: &tauri::AppHandle) {}
#[cfg(not(windows))]
fn spawn_webview_watchdog() {}

/// 本地数据存储位置。
///
/// plugin-sql 的 `sqlite:` 方案永远相对 `app_config_dir`,无法直接用绝对路径,
/// 因此自定义目录通过 `app_config_dir/todobar_data` 这个**目录 junction** 间接指向用户目录。
///
/// - `target = null`:重置为默认位置(把 junction 里的数据搬回 app_config_dir,移除 junction)。
/// - `target = 某目录`:把当前数据迁移到该目录(若该目录已有数据则直接采用),并建立 junction。
///
/// 返回 JS 应当使用的 `sqlite:` 相对路径键。
#[tauri::command]
fn set_data_dir(app: tauri::AppHandle, target: Option<String>) -> Result<String, String> {
    let cfg = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let db = "todobar.db";
    let link = cfg.join("todobar_data");

    if target.is_none() {
        // 重置:若曾建立 junction,把数据搬回默认位置并移除 junction。
        if link.exists() {
            for ext in ["", "-wal", "-shm"] {
                let src = link.join(format!("{db}{ext}"));
                let dst = cfg.join(format!("{db}{ext}"));
                if src.exists() {
                    std::fs::copy(&src, &dst).map_err(|e| format!("恢复数据失败: {e}"))?;
                }
            }
            remove_junction(&link)?;
        }
        // 持久化:清除自定义目录指针(跨更新存活)。
        let mut pc = read_persist();
        pc.data_dir = None;
        let _ = write_persist(&pc);
        // 注意:返回值不带 `sqlite:` 前缀——JS 侧 connectionPath() 会自动补,
        // 这里若再带前缀会变成 `sqlite:sqlite:...` 导致加载失败(历史缺陷)。
        return Ok("todobar.db".to_string());
    }

    let target_str = target.unwrap();
    let target_dir = std::path::PathBuf::from(&target_str);
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    // 目标目录已有数据 -> 直接采用(保留用户既有数据);否则从默认位置迁移过来。
    let adopt_existing = target_dir.join(db).exists();
    if !adopt_existing {
        for ext in ["", "-wal", "-shm"] {
            let src = cfg.join(format!("{db}{ext}"));
            let dst = target_dir.join(format!("{db}{ext}"));
            if src.exists() {
                std::fs::copy(&src, &dst).map_err(|e| format!("迁移数据失败: {e}"))?;
            }
        }
    }

    // 建立 junction:cfg/todobar_data -> target_dir
    if link.exists() {
        remove_junction(&link)?;
    }
    create_junction(&link, &target_dir)?;

    // 迁移成功后删除默认位置的旧文件(仅当是从默认迁出时)。
    if !adopt_existing {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(cfg.join(format!("{db}{ext}")));
        }
    }

    // 持久化:记录自定义目录指针(跨更新存活,不再依赖 WebView localStorage)。
    let mut pc = read_persist();
    pc.data_dir = Some(target_str);
    write_persist(&pc)?;

    // 不带 `sqlite:` 前缀(JS 侧 connectionPath() 会自动补,见上方说明)。
    Ok("todobar_data/todobar.db".to_string())
}

/// 在文件管理器中打开指定路径(用于「打开数据文件夹」)。
/// path 为空时打开默认应用数据目录。
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => app
            .path()
            .app_config_dir()
            .map_err(|e| format!("无法定位数据目录: {e}"))?
            .to_string_lossy()
            .into_owned(),
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &target])
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn create_junction(link: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    let out = std::process::Command::new("cmd")
        .args([
            "/c",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &target.to_string_lossy(),
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW: 避免启动期弹出 conhost 控制台窗口(程序启动框)
        .output()
        .map_err(|e| format!("创建目录链接失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "创建目录链接失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_junction(link: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("创建目录链接失败: {e}"))
}

#[cfg(windows)]
fn remove_junction(link: &std::path::Path) -> Result<(), String> {
    let out = std::process::Command::new("cmd")
        .args(["/c", "rmdir", &link.to_string_lossy()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW: 同上,避免启动期弹出 conhost 控制台窗口
        .output()
        .map_err(|e| format!("移除目录链接失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "移除目录链接失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn remove_junction(link: &std::path::Path) -> Result<(), String> {
    std::fs::remove_dir(link).map_err(|e| format!("移除目录链接失败: {e}"))
}

// ===========================================================================
// 跨更新持久化配置:把「数据位置指针」与「登录态」从 WebView 的 localStorage
// (更新会被清掉)迁移到用户主目录下的 ~/.ticktask/config.json。
// 这样应用更新、清理浏览器数据都不会再丢失存储位置与登录态。
// ===========================================================================
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct PersistConfig {
    data_dir: Option<String>,
    account: Option<String>,
    /// 设备唯一 ID(每台物理机一次生成,跨更新/清缓存存活)。
    /// 之前只存 WebView localStorage,被清后会生成新 ID,同一台机器被云端
    /// 当成新设备,幽灵设备积满 3 台导致无法登录(0.3.2 修复)。
    #[serde(default)]
    device_id: Option<String>,
    /// 旧 localStorage 状态是否已迁移进本文件(只做一次,避免每次启动覆盖新值)。
    #[serde(default)]
    legacy_migrated: bool,
    /// WebView2 缓存是否已清理过一次(只做一次;旧版本前端资源被缓存导致
    /// 更新后界面仍旧/状态错乱,见 0.2.9 修复说明)。
    #[serde(default)]
    cache_cleared: bool,
}

/// 应用运行日志(~/.ticktask/logs/app.log):窗口生命周期、截图流程、崩溃现场。
/// 排查「应用整个消失」这类无法本地复现的问题全靠它。
pub(crate) fn append_app_log(msg: &str) {
    let Some(cfg_path) = home_ticktask_config() else { return };
    let Some(dir) = cfg_path.parent() else { return };
    let dir = dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let usec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{usec}] {msg}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// [0.4.38] 极简 log 捕获器:把 tauri/wry/tao 内部的 Warn/Error 落到 app.log。
/// 背景:子线程建窗是 fire-and-forget,主线程实际创建失败时 tauri 只走
/// log::error! —— 应用此前从未安装 logger,真实失败原因(如 WebView2 数据
/// 目录被锁死)被彻底吞掉,导致组件「开关已开但桌面上什么都没有」却查无对证。
struct RustLog;

impl log::Log for RustLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            append_app_log(&format!("[rs:{}] {}", record.level(), record.args()));
        }
    }
    fn flush(&self) {}
}

static RUST_LOG: RustLog = RustLog;

/// 前端诊断日志:截图 / 贴图全流程打点(任何一步丢失都能从日志定位断点)。
#[tauri::command]
fn screenshot_log(message: String) -> Result<(), String> {
    append_app_log(&format!("[shot] {message}"));
    Ok(())
}

/// 通用前端诊断日志(0.4.37):计薪组件等链路打点,落 ~/.ticktask/logs/app.log。
#[tauri::command]
fn app_log(message: String) -> Result<(), String> {
    append_app_log(&format!("[app] {message}"));
    Ok(())
}

fn home_ticktask_config() -> Option<std::path::PathBuf> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    home.map(|h| std::path::Path::new(&h).join(".ticktask").join("config.json"))
}

fn read_persist() -> PersistConfig {
    if let Some(p) = home_ticktask_config() {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(c) = serde_json::from_str::<PersistConfig>(&s) {
                return c;
            }
        }
    }
    PersistConfig::default()
}

fn write_persist(cfg: &PersistConfig) -> Result<(), String> {
    let p = home_ticktask_config().ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取主目录持久化配置(JSON 字符串)。
#[tauri::command]
fn get_persist_config() -> Result<String, String> {
    Ok(serde_json::to_string(&read_persist()).unwrap_or_else(|_| "{}".to_string()))
}

/// 写入主目录持久化配置。
/// - `data_dir` / `account`:传非空字符串=写入;传空字符串=显式清除(退出登录用);不传=保持不变。
/// - `legacy_migrated` / `cache_cleared`:一次性标记,传 true 置位。
#[tauri::command]
fn set_persist_config(
    data_dir: Option<String>,
    account: Option<String>,
    device_id: Option<String>,
    legacy_migrated: Option<bool>,
    cache_cleared: Option<bool>,
) -> Result<(), String> {
    let mut cfg = read_persist();
    if let Some(v) = data_dir {
        cfg.data_dir = if v.trim().is_empty() { None } else { Some(v) };
    }
    if let Some(v) = account {
        cfg.account = if v.trim().is_empty() { None } else { Some(v) };
    }
    if let Some(v) = device_id {
        cfg.device_id = if v.trim().is_empty() { None } else { Some(v) };
    }
    if legacy_migrated == Some(true) {
        cfg.legacy_migrated = true;
    }
    if cache_cleared == Some(true) {
        cfg.cache_cleared = true;
    }
    write_persist(&cfg)
}

/// 清理 WebView2 全部浏览数据(缓存/localStorage/IndexedDB)。
/// 用途:旧版本前端资源被 WebView2 缓存,应用更新后界面仍显示旧文案/旧逻辑
/// (如「同步 (Cloudflare)」标题在源码早已移除却仍显示)。启动时一次性清理。
#[tauri::command]
fn clear_webview_cache(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.clear_all_browsing_data()
            .map_err(|e| format!("清理 WebView 缓存失败: {e}"))
    } else {
        Err("主窗口不存在".to_string())
    }
}

/// 启动时根据主目录持久化配置重建 junction / 决定连接路径。
/// 即便更新清掉了 WebView 的 localStorage,存储位置也能自愈,不再回退到空库。
#[tauri::command]
fn init_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = read_persist();
    let app_cfg = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let link = app_cfg.join("todobar_data");
    if let Some(dir) = cfg.data_dir.clone() {
        let target = std::path::PathBuf::from(&dir);
        std::fs::create_dir_all(&target).map_err(|e| format!("创建目录失败: {e}"))?;
        if link.exists() {
            let _ = remove_junction(&link);
        }
        create_junction(&link, &target)?;
        return Ok("todobar_data/todobar.db".to_string());
    }
    // 无自定义目录:清理可能残留的 junction,避免指向已失效位置。
    if link.exists() {
        let _ = remove_junction(&link);
    }
    Ok("todobar.db".to_string())
}

/// 扫描常见位置,找出包含 todobar.db 的目录,辅助用户找回误丢失的数据。
#[tauri::command]
fn scan_data_locations(app: tauri::AppHandle) -> Result<String, String> {
    let mut found: Vec<String> = Vec::new();
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(h) = &home {
        roots.push(std::path::PathBuf::from(h));
        for sub in ["Desktop", "Documents", "Downloads", "Pictures", "桌面", "文档", "下载"] {
            let p = std::path::Path::new(h).join(sub);
            if p.exists() {
                roots.push(p);
            }
        }
    }
    if let Ok(cfg) = app.path().app_config_dir() {
        roots.push(cfg.clone());
        roots.push(cfg.join("todobar_data"));
    }
    for r in roots {
        if let Ok(entries) = std::fs::read_dir(&r) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    let db = p.join("todobar.db");
                    if db.exists() {
                        let s = p.to_string_lossy().into_owned();
                        if !found.contains(&s) {
                            found.push(s);
                        }
                    }
                }
            }
        }
    }
    Ok(serde_json::to_string(&found).unwrap_or_else(|_| "[]".to_string()))
}

const TRAY_TOGGLE_EVENT: &str = "todobar-tray-toggle";
const TRAY_SETTINGS_EVENT: &str = "todobar-tray-settings";

// 主窗口是否已显示(0.4.44 启动残影修复):
// 主窗口改为 visible:false 启动,页面加载完成后才显示,避免 WebView2
// 首帧未就绪时 DWM 合成出「黑条 + 残影」。此标志供看门狗兜底判断。
static MAIN_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 显示主窗口(不带焦点,供启动显示与看门狗兜底共用)。
fn show_main_window_no_focus(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        MAIN_SHOWN.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = window.show();
    }
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn emit_to_main(app: &tauri::AppHandle, event: &str) {
    focus_main_window(app);
    let _ = app.emit_to("main", event, ());
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        "打开 / 关闭 TickTask",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let clipboard = MenuItem::with_id(app, "clipboard", "剪贴板历史", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 TickTask", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &clipboard, &quit])?;
    let icon = app.default_window_icon().cloned();

    let mut tray = TrayIconBuilder::with_id("todobar")
        .tooltip("TickTask")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => emit_to_main(app, TRAY_TOGGLE_EVENT),
            "settings" => emit_to_main(app, TRAY_SETTINGS_EVENT),
            "clipboard" => clipboard::open_clipboard_window(app.clone()),
            "quit" => {
                append_app_log("quit from tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                emit_to_main(tray.app_handle(), TRAY_TOGGLE_EVENT);
            }
        });

    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

fn setup_global_shortcuts(app: &tauri::App) {
    // 主开关键:从磁盘偏好(~/.ticktask/prefs.json 的 sidebar.toggleWindowShortcut)读取,
    // 读不到 / 为空时回退默认 CommandOrControl+Shift+T。这样用户改过的快捷键在重启后依然生效。
    let primary = read_toggle_window_shortcut();
    register_toggle_shortcut(app, &primary);
    // 把当前生效键记进托管状态,便于设置页修改时先注销旧键。
    {
        let state = app.state::<ToggleWindowShortcutState>();
        *state.current.lock().unwrap() = Some(primary.clone());
    }
    // 始终保留一个备用呼出快捷键(用户误改 / 误删配置仍能呼出窗口);若主开关键恰好就是它,
    // 则不再重复注册(避免 Tauri 报重复绑定)。
    let secondary = "CommandOrControl+Alt+T";
    if normalize_shortcut(primary.as_str()) != normalize_shortcut(secondary) {
        register_toggle_shortcut(app, secondary);
    }
    // 托盘菜单的快捷键显示文字与当前生效键保持一致(用户已改过快捷键时不再显示默认键)。
    update_tray_toggle_accelerator(app.handle(), &primary);
}

/// 读取用户配置的「打开 / 关闭窗口」快捷键;无配置或为空时回退默认。
fn read_toggle_window_shortcut() -> String {
    let map = read_prefs_map();
    if let Some(serde_json::Value::Object(sidebar)) = map.get("sidebar") {
        if let Some(serde_json::Value::String(s)) = sidebar.get("toggleWindowShortcut") {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "CommandOrControl+Shift+T".to_string()
}

/// 注册一个「打开 / 关闭窗口」全局快捷键(按下触发 todobar-tray-toggle 事件)。
fn register_toggle_shortcut(app: &tauri::App, shortcut: &str) {
    let sc = shortcut.to_string();
    let result = app.global_shortcut().on_shortcut(sc.as_str(), move |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            emit_to_main(app, TRAY_TOGGLE_EVENT);
        }
    });
    match result {
        Ok(()) => append_app_log(&format!("toggle window shortcut registered: {sc}")),
        Err(e) => append_app_log(&format!("failed to register toggle window shortcut {sc}: {e}")),
    }
}

/// 把快捷键串归一化(去空格 + 小写),用于比较是否重复。
fn normalize_shortcut(s: &str) -> String {
    s.replace([' ', '\t'], "").to_lowercase()
}

/// 更新托盘菜单中「打开 / 关闭 TickTask」项的快捷键显示文字(纯展示,实际由全局快捷键触发)。
fn update_tray_toggle_accelerator(app: &tauri::AppHandle, shortcut: &str) {
    // Tauri 加速器格式用 CmdOrCtrl,而非 CommandOrControl。
    let accel = shortcut.replace("CommandOrControl", "CmdOrCtrl");
    if let Some(tray) = app.tray_by_id("todobar") {
        if let (Ok(toggle), Ok(settings), Ok(quit)) = (
            MenuItem::with_id(app, "toggle", "打开 / 关闭 TickTask", true, Some(accel.clone())),
            MenuItem::with_id(app, "settings", "设置", true, None::<&str>),
            MenuItem::with_id(app, "quit", "退出 TickTask", true, None::<&str>),
        ) {
                if let Ok(menu) = Menu::with_items(app, &[&toggle, &settings, &quit]) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

/// 设置页修改「打开 / 关闭窗口」快捷键:注销旧键、注册新键,并同步托盘菜单文字。
#[tauri::command]
fn set_toggle_window_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, ToggleWindowShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    // 注销当前生效的键。
    if let Some(prev) = state.current.lock().unwrap().take() {
        let _ = gs.unregister(prev.as_str());
    }
    let sc = shortcut.trim().to_string();
    if sc.is_empty() {
        update_tray_toggle_accelerator(&app, "CommandOrControl+Shift+T");
        return Ok(());
    }
    gs.on_shortcut(sc.as_str(), move |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            emit_to_main(app, TRAY_TOGGLE_EVENT);
        }
    })
    .map_err(|e| format!("窗口快捷键 “{sc}” 注册失败: {e}"))?;
    *state.current.lock().unwrap() = Some(sc.clone());
    update_tray_toggle_accelerator(&app, &sc);
    Ok(())
}

/// 注册 / 注销截图与贴图的全局快捷键(由前端在设置变化时调用)。
///
/// - `unregister`:上一轮托管、需要在本次注册前先注销的快捷键(前端传入)。
/// - `shot` / `pin`:本次要注册的「截图」「贴图」快捷键;为空字符串表示不注册。
/// - 注册失败时返回错误(如与系统 / 其他快捷键冲突),前端据此标红提示。
/// - 注册成功后通过 `screenshot-trigger` 事件把触发动作( shot / pin )发往主窗口,
///   由前端决定是启动截图还是钉出最近截图。
#[tauri::command]
fn register_screenshot_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScreenshotShortcutState>,
    unregister: Vec<String>,
    shot: String,
    pin: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();

    // 收集需要注销的快捷键:上一轮托管 + 本次传入的上一批。
    let mut to_unreg: Vec<String> = unregister.into_iter().filter(|s| !s.trim().is_empty()).collect();
    {
        let prev = state.managed.lock().unwrap();
        for s in prev.iter() {
            if !to_unreg.contains(s) {
                to_unreg.push(s.clone());
            }
        }
    }
    for s in &to_unreg {
        let _ = gs.unregister(s.as_str());
    }

    let mut managed: Vec<String> = Vec::new();
    for (sc, kind) in [(shot, "shot"), (pin, "pin")] {
        if sc.trim().is_empty() {
            continue;
        }
        let kind = kind.to_string();
        gs.on_shortcut(sc.as_str(), move |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit_to("main", "screenshot-trigger", kind.clone());
            }
        })
        .map_err(|e| format!("快捷键 “{sc}” 注册失败: {e}"))?;
        managed.push(sc);
    }

    *state.managed.lock().unwrap() = managed;
    Ok(())
}

/// 显示并聚焦主窗口(供覆盖层 / 编辑器等子窗口结束时调用)。
/// JS 侧 `WebviewWindow.getByLabel` 只能找到当前窗口自己创建的窗口,
/// 跨窗口恢复主窗口必须走 Rust 命令。
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        Ok(())
    } else {
        Err("主窗口不存在".to_string())
    }
}

/// [0.4.44] 前端把主窗口定位到屏幕右缘并绘制首帧后调用:此刻才显示主窗口。
/// (启动残影根治:显示前窗口已就位,不存在默认位置闪现。)
#[tauri::command]
fn show_main_window_ready(app: tauri::AppHandle) -> Result<(), String> {
    append_app_log("main window shown by frontend after layout");
    show_main_window_no_focus(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// [0.4.38] 计薪组件 ghost label 事故修复
//
// 根因(源码级确认,0.4.37 干净复现):open_salary_widget 在子线程 build() 时,
// tauri 的 create_window 只把创建消息投递给主线程事件循环就立即返回 Ok
// (fire-and-forget,无回执)。主线程实际创建失败(如 WebView2 数据目录被锁)
// 时错误只走 log::error! → 无 logger 被吞;更糟的是 tauri manager 已把 label
// 登记进窗口表 → 留下「幽灵 label」:get_webview_window 返回 Some 但 HWND 根本
// 不存在(Win32 枚举已证实),后续所有 open 都在死句柄上「复用并 show」= 静默
// 空转,表现为「开关已开、toast 已弹、桌面上什么都没有」。
//
// 修复策略:
// 1. 装 logger(见 RustLog)→ 创建失败的真实原因落 app.log;
// 2. WidgetState 追踪当前 label + open_lock 串行化并发 open;
// 3. 复用前用 is_visible() 探活 —— ghost 的任何 getter 都因事件循环侧无此
//    窗口而回执通道被丢弃(is_visible 返回 Err),以此区分真窗口/死句柄;
// 4. 死句柄 → 换下一个候选 label(salary_widget → _r2.._r5)重建,
//    绕开「同 label 已存在」的管理表冲突(ghost 进程内无法注销);
// 5. build 后必须探活确认:消息 FIFO 保证探活消息排在创建消息之后,
//    build() 返回 Ok ≠ 创建成功;
// 6. salary_widget_exists 同样探活,不再被 ghost 骗过返回假 true。
// ---------------------------------------------------------------------------

/// 组件窗口状态(托管 state):当前生效 label 与 open 串行锁。
struct WidgetState {
    label: std::sync::Mutex<String>,
    open_lock: std::sync::Mutex<()>,
}

impl Default for WidgetState {
    fn default() -> Self {
        Self {
            label: std::sync::Mutex::new("salary_widget".to_string()),
            open_lock: std::sync::Mutex::new(()),
        }
    }
}

/// 组件窗口候选 label 序列。ghost 残留会占用管理表里的 label 且进程内无法
/// 注销,只能换新 label 绕开;5 个候选覆盖反复失败重试的场景。
fn widget_label_candidates() -> Vec<String> {
    let mut v = vec!["salary_widget".to_string()];
    for i in 2..=5 {
        v.push(format!("salary_widget_r{i}"));
    }
    v
}

/// 窗口活性探测:ghost 在事件循环侧不存在,getter 的同步回执通道会被丢弃,
/// is_visible() 返回 Err;真窗口(哪怕处于 hide)返回 Ok(false)。
fn widget_window_alive(w: &tauri::WebviewWindow<tauri::Wry>) -> bool {
    w.is_visible().is_ok()
}

/// 带短重试的探活:FIFO 下 build() 返回后的探活消息必然排在创建消息之后,
/// 理论一次即准;留重试兜底异常时序。
fn widget_probe_alive(w: &tauri::WebviewWindow<tauri::Wry>) -> bool {
    for attempt in 0..3 {
        if w.is_visible().is_ok() {
            return true;
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    false
}

/// 打开「牛马计薪器 · 桌面组件」独立透明窗口(label 见 widget_label_candidates)。
///
/// ⚠️ 死锁铁律(0.4.21 踩坑): 绝不能在同步命令里内联 `WebviewWindowBuilder::build()`!
/// 同步命令运行在主线程上,而 Windows 下 WebView2 控制器的异步创建完成回调需要主线程
/// 消息循环来投递 —— 内联 build() 会把主线程卡死在等待里,形成死锁。实测症状:
/// 组件窗口 HWND 建出来但渲染树只挂了一半(有 WRY_WEBVIEW,无 RenderWidgetHost),
/// 永远全透明不可见;且主线程被卡死后一切后续 IPC(关窗口/把手原生调用)全部无响应。
/// 正确做法: 命令立即返回,窗口创建放到独立线程(build() 内部会投递回主线程,
/// 此时主线程空闲,可正常完成创建)。
///
/// 其余设计要点(规避历史上「透明置顶窗盖住右缘 Dock 把手→主程序点不动」的坑):
/// - 透明、无边框、不进任务栏、不抢焦点(`focused:false`);
/// - 0.4.24: 不置顶(`always_on_top:false`)—— 组件是桌面小工具,不应悬浮在
///   所有应用之上盖住其他软件;普通窗口层级,被前台应用遮挡属预期;
/// - 初始位置交给前端 WidgetView 用显示器 API 居中(Rust 侧 current_monitor 实测不可靠);
/// - 尺寸随风格变化,窗口比卡片四周各大 14px 透明边距给圆角+阴影留渲染空间
///   (candy 440×316→468×344、wide 560×220→588×248、sunset 560×210→588×238);
/// - 幂等: 有活窗口时只改尺寸并显示(不 close 重建 —— close 是异步销毁,
///   立刻按同 label 重建会撞「窗口已存在」;风格内容变化由组件页轮询 localStorage
///   自行刷新)。死句柄(ghost)则换新 label 重建(见上修复策略)。
#[tauri::command]
fn open_salary_widget(app: tauri::AppHandle, style: String, raise: Option<bool>) -> Result<(), String> {
    // 0.4.37 排障:组件「开关已开但桌面上看不到」无法远程定位,全链路写 app.log。
    append_app_log(&format!("[widget] open_salary_widget style={style} raise={:?}", raise.is_some()));
    let raise = raise.unwrap_or(false);
    std::thread::spawn(move || {
        let state = app.state::<WidgetState>();
        // 串行化:创建含探活等待(最长 ~1s),并发 open 会互相插队抢 label。
        let _guard = state.open_lock.lock().unwrap();

        let (w, h): (f64, f64) = match style.as_str() {
            "wide" => (588.0, 248.0),
            "sunset" => (588.0, 238.0),
            _ => (468.0, 344.0), // candy 默认
        };

        // ① 任何候选 label 下有活窗口 → 复用(只调尺寸+show,不重建)。
        //   0.4.37 补 unminimize —— 若窗口曾被最小化,只 show 可能仍在任务栏外不可见。
        for cand in widget_label_candidates() {
            if let Some(existing) = app.get_webview_window(&cand) {
                if widget_window_alive(&existing) {
                    let _ = existing.set_size(tauri::LogicalSize::new(w, h));
                    let _ = existing.unminimize();
                    let _ = existing.show();
                    *state.label.lock().unwrap() = cand;
                    append_app_log("[widget] 复用现有窗口(探活通过)");
                    return;
                }
                append_app_log(&format!(
                    "[widget] label={cand} 是创建失败残留的死句柄(ghost),跳过换新 label 重建"
                ));
            }
        }

        // ② 换 label 重建:找第一个未被占用(含 ghost 占用)的候选。
        for cand in widget_label_candidates() {
            if app.get_webview_window(&cand).is_some() {
                continue;
            }
            let builder = tauri::WebviewWindowBuilder::new(
                &app,
                cand.as_str(),
                tauri::WebviewUrl::App(std::path::PathBuf::new()),
            )
            .title("TickTask 计薪组件")
            // ⚠️ [0.4.38 根因修复] 必须与主窗口 additionalBrowserArgs 完全一致!
            // WebView2 硬性约束:同一进程内、同一用户数据目录,两个 webview 的
            // CoreWebView2EnvironmentOptions 不一致时,第二个环境创建必失败
            // (HRESULT 0x8007139F ERROR_INVALID_STATE,已实测复现)。
            // 0.4.34 随录音机功能给主窗口加了 --use-fake-ui-for-media-stream,
            // 组件窗口沿用 wry 默认参数(缺它)→ 此后组件窗口创建必失败,
            // 再叠加 fire-and-forget+无 logger 被吞 → 「开关已开但桌面无组件」。
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream",
            )
            .inner_size(w, h)
            .decorations(false)
            .transparent(true)
            // 0.4.44: visible:false —— 组件窗口也不再「创建即显示」。
            // 实测创建后窗口先以 Windows 默认级联位置闪现(内容未画/黑底),
            // 再被前端挪到保存位置,形成「启动框残影」。改由前端定位后显示。
            .visible(false)
            // 0.4.24: 去掉置顶 —— 组件是桌面小工具,不应悬浮在所有应用之上
            // (用户反馈盖住了其他软件界面)。普通窗口层级,被遮挡属预期。
            .always_on_top(false)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .shadow(false);

            match builder.build() {
                Ok(win) => {
                    // build() Ok ≠ 创建成功(fire-and-forget)。探活确认;
                    // 失败则此 label 也成 ghost,继续尝试下一个候选。
                    if widget_probe_alive(&win) {
                        append_app_log(&format!("[widget] 窗口创建成功 label={cand}(探活通过)"));
                        *state.label.lock().unwrap() = cand;
                        if raise {
                            // 0.4.44: 窗口已改为 visible(false),由前端定位后显示;
                            // 这里延迟 1.5s 再置顶露脸(此时前端已完成定位 + show)。
                            // 不能立即 show —— 会在默认位置闪现未定位的窗口。
                            let win2 = win.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(1500));
                                let _ = win2.show();
                                let _ = win2.set_always_on_top(true);
                                let _ = win2.set_focus();
                                std::thread::sleep(std::time::Duration::from_millis(800));
                                let _ = win2.set_always_on_top(false);
                            });
                        }
                        return;
                    }
                    append_app_log(&format!(
                        "[widget] build() Ok 但探活失败 label={cand}:主线程实际创建失败(ghost),尝试下一 label"
                    ));
                }
                Err(e) => append_app_log(&format!("[widget] 窗口创建失败 label={cand}: {e}")),
            }
        }
        append_app_log("[widget] 所有候选 label 均创建失败,放弃(前端将提示重启)");
    });
    Ok(())
}

/// 前端校验组件窗口是否真的存在且活着(0.4.38 增强):open 是线程内异步 build,
/// invoke 立即返回 Ok 不代表窗口创建成功;前端延迟后用本命令核实并 toast 用户。
/// ghost 死句柄在此被识破(此前对 ghost 返回假 true → 误报「已启用」)。
#[tauri::command]
fn salary_widget_exists(app: tauri::AppHandle) -> bool {
    let state = app.state::<WidgetState>();
    let label = state.label.lock().unwrap().clone();
    let exists = match app.get_webview_window(&label) {
        None => false,
        Some(w) => {
            let mut alive = widget_window_alive(&w);
            if !alive {
                // 短重试:open 线程可能尚在创建中(前端 1200ms 后才查询,通常已完成)。
                std::thread::sleep(std::time::Duration::from_millis(400));
                alive = widget_window_alive(&w);
            }
            alive
        }
    };
    append_app_log(&format!("[widget] salary_widget_exists(label={label}) -> {exists}"));
    exists
}

/// 关闭「牛马计薪器 · 桌面组件」窗口(用户在 SalaryView 关闭开关、或切换风格时调用)。
/// 0.4.38: 按当前生效 label 关(不再写死 salary_widget);死句柄无真实窗口可关,
/// 如实记录后正常返回。
#[tauri::command]
fn close_salary_widget(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<WidgetState>();
    let label = state.label.lock().unwrap().clone();
    if let Some(w) = app.get_webview_window(&label) {
        if widget_window_alive(&w) {
            w.close().map_err(|e| format!("关闭计薪组件窗口失败: {e}"))?;
        } else {
            append_app_log(&format!("[widget] close:label={label} 是死句柄,无真实窗口可关"));
        }
    }
    Ok(())
}

/// 读取截图 / 贴图设置(存 ~/.ticktask/screenshot-settings.json)。
/// localStorage 在 WebView 清缓存 / 异常退出时会丢,设置类数据一律落盘。
#[tauri::command]
fn get_screenshot_settings() -> Result<Option<String>, String> {
    let path = home_ticktask_config()
        .map(|p| p.with_file_name("screenshot-settings.json"))
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(std::fs::read_to_string(path).ok())
}

/// 写入截图 / 贴图设置(JSON 字符串)。
#[tauri::command]
fn save_screenshot_settings(json: String) -> Result<(), String> {
    let path = home_ticktask_config()
        .map(|p| p.with_file_name("screenshot-settings.json"))
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 录音机(0.4.35):音频仅保存在本地,不接入云端同步。
//
// - 0.4.36 起支持自定义保存目录:文件定位从「id」改为「dir + file」二元组,
//   每条录音的 dir/file 存在前端元数据里,旧记录回填 dir="" file="<id>.mp3";
// - 文件名 = 用户可见标题.mp3(重命名时同步改磁盘文件名),文件名校验只挡
//   Windows 非法字符/控制字符/路径分隔符/"..",无路径穿越面;
// - 分片追加落盘:前端每约 8 秒把 mp3 分片 base64 送来追加,内存占用有界,
//   异常退出时最多损失最后一个未落盘分片;
// - 回放走系统默认播放器(cmd /C start),定位走 explorer /select。
// ---------------------------------------------------------------------------

/// 默认录音根目录:文档\TickTask录音(不存在时由各命令按需创建)。
fn recordings_dir_path() -> Result<PathBuf, String> {
    let doc = dirs::document_dir().ok_or_else(|| "无法定位「文档」目录".to_string())?;
    Ok(doc.join("TickTask录音"))
}

/// 解析录音目录:dir 为空 → 默认目录;自定义目录必须为绝对路径。
fn resolve_recordings_dir(dir: &str) -> Result<PathBuf, String> {
    if dir.trim().is_empty() {
        return recordings_dir_path();
    }
    let p = PathBuf::from(dir);
    if !p.is_absolute() {
        return Err("非法的录音目录".to_string());
    }
    Ok(p)
}

/// 录音文件名校验:挡 Windows 非法字符、控制字符、路径分隔符与 ".."。
fn valid_recording_file(file: &str) -> bool {
    if file.is_empty() || file.len() > 120 || file.ends_with('.') || file.ends_with(' ') {
        return false;
    }
    if file.contains("..") {
        return false;
    }
    !file
        .chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
}

/// dir + file 双重校验后拼出录音文件绝对路径。
fn recording_file_path(dir: &str, file: &str) -> Result<PathBuf, String> {
    if !valid_recording_file(file) {
        return Err("非法的录音文件名".to_string());
    }
    Ok(resolve_recordings_dir(dir)?.join(file))
}

/// 同名冲突时生成「名字 (2).mp3」式候选名(最多试到 999,失败退回原名)。
fn next_available_name(dir: &Path, file: &str) -> String {
    let (stem, ext) = match file.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (file.to_string(), String::new()),
    };
    let mut candidate = file.to_string();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
        if n > 999 {
            return file.to_string();
        }
    }
    candidate
}

/// 创建(截断)一个录音文件;同名已存在时自动加序号,返回实际使用的文件名。
#[tauri::command]
fn recording_begin(dir: String, file: String) -> Result<String, String> {
    if !valid_recording_file(&file) {
        return Err("非法的录音文件名".to_string());
    }
    let base = resolve_recordings_dir(&dir)?;
    std::fs::create_dir_all(&base).map_err(|e| format!("创建录音目录失败: {e}"))?;
    let name = next_available_name(&base, &file);
    std::fs::File::create(base.join(&name))
        .map_err(|e| format!("创建录音文件失败: {e}"))?;
    Ok(name)
}

/// 追加一段 mp3 分片。返回追加后的文件总字节数。
#[tauri::command]
fn recording_append(dir: String, file: String, data: String) -> Result<u64, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|e| format!("录音分片解码失败: {e}"))?;
    let path = recording_file_path(&dir, &file)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开录音文件失败: {e}"))?;
    std::io::Write::write_all(&mut f, &bytes)
        .map_err(|e| format!("写入录音数据失败: {e}"))?;
    f.flush().ok();
    drop(f);
    Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(bytes.len() as u64))
}

/// 删除指定录音文件(取消录音 / 用户删除记录共用)。
#[tauri::command]
fn recording_delete(dir: String, file: String) -> Result<(), String> {
    let path = recording_file_path(&dir, &file)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除录音文件失败: {e}"))
    } else {
        Ok(())
    }
}

/// 批量检查录音文件是否仍存在(前端用于标记「文件丢失」)。dirs 与 files 一一对应。
#[tauri::command]
fn recordings_check(dirs: Vec<String>, files: Vec<String>) -> Result<Vec<bool>, String> {
    if dirs.len() != files.len() {
        return Err("参数长度不一致".to_string());
    }
    Ok(dirs
        .iter()
        .zip(files.iter())
        .map(|(d, f)| recording_file_path(d, f).map(|p| p.exists()).unwrap_or(false))
        .collect())
}

/// 用系统默认播放器打开录音;文件不存在时返回 Err(前端据此标记丢失)。
#[tauri::command]
fn recording_open(dir: String, file: String) -> Result<(), String> {
    let path = recording_file_path(&dir, &file)?;
    if !path.exists() {
        return Err("录音文件不存在或已被移动".to_string());
    }
    let path_str = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        // `start "" "路径"`:空标题占位,防止带空格/中文的路径被 start 当成标题。
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path_str])
            .spawn()
            .map_err(|e| format!("打开录音失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("打开录音失败: {e}"))?;
    }
    Ok(())
}

/// 在资源管理器中定位到指定录音文件。
#[tauri::command]
fn recording_reveal(dir: String, file: String) -> Result<(), String> {
    let path = recording_file_path(&dir, &file)?;
    if !path.exists() {
        return Err("录音文件不存在或已被移动".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        if let Some(parent) = path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("打开文件夹失败: {e}"))?;
        }
    }
    Ok(())
}

/// 打开录音目录(不存在则先创建),方便用户自行备份/取用。dir 为空时打开默认目录。
#[tauri::command]
fn recordings_open_folder(dir: String) -> Result<String, String> {
    let dir = resolve_recordings_dir(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建录音目录失败: {e}"))?;
    let dir_str = dir.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {e}"))?;
    }
    Ok(dir_str)
}

/// 重命名录音文件(保持「磁盘文件名 = 页面标题」一致);目标名冲突时自动加
/// 序号,返回实际生效的文件名(前端须以返回值回写元数据)。
#[tauri::command]
fn recording_rename(dir: String, old_file: String, new_file: String) -> Result<String, String> {
    let from = recording_file_path(&dir, &old_file)?;
    if !valid_recording_file(&new_file) {
        return Err("非法的录音文件名".to_string());
    }
    if !from.exists() {
        return Err("录音文件不存在或已被移动".to_string());
    }
    if new_file == old_file {
        return Ok(new_file);
    }
    let base = from.parent().ok_or_else(|| "录音目录异常".to_string())?;
    let name = next_available_name(base, &new_file);
    std::fs::rename(&from, base.join(&name))
        .map_err(|e| format!("重命名录音文件失败: {e}"))?;
    Ok(name)
}

/// 返回默认录音目录(前端「保存位置」弹窗展示用)。
#[tauri::command]
fn recordings_default_dir() -> Result<String, String> {
    recordings_dir_path().map(|p| p.to_string_lossy().into_owned())
}

/// 打开 Windows 麦克风隐私设置页(getUserMedia 报 NotAllowedError 时的引导入口)。
#[tauri::command]
fn open_mic_privacy_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|e| format!("打开系统设置失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        // 非 Windows 无对应设置页,静默成功即可(本项目仅发 Windows 版)。
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 偏好 / 外观设置 的磁盘持久化
//
// 背景、字体、主题(待办设置页)以及计薪/浮窗配置原本只存在 WebView localStorage。
// localStorage 会在「清理 WebView 缓存」或重装应用(卸载会清掉 WebView2 用户数据目录)
// 时被抹掉,表现为「每次重装都要重新设置背景和字体」。
// 这里把它们额外镜像到主目录 ~/.ticktask/prefs.json(与登录态同机制),重装后自动回灌。
// ---------------------------------------------------------------------------

fn prefs_path() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".ticktask").join("prefs.json"))
}

fn read_prefs_map() -> HashMap<String, serde_json::Value> {
    if let Some(p) = prefs_path() {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(m) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&s) {
                return m;
            }
        }
    }
    HashMap::new()
}

/// 读取某个偏好键的 JSON 字符串(无则返回 null)。
#[tauri::command]
fn get_pref(key: String) -> Result<Option<String>, String> {
    let v = read_prefs_map().remove(&key);
    Ok(v.and_then(|v| serde_json::to_string(&v).ok()))
}

/// 写入某个偏好键(JSON 字符串)。
#[tauri::command]
fn set_pref(key: String, value: String) -> Result<(), String> {
    let mut m = read_prefs_map();
    let parsed = serde_json::from_str::<serde_json::Value>(&value)
        .map_err(|e| format!("偏好值无法解析: {e}"))?;
    m.insert(key, parsed);
    let p = prefs_path().ok_or_else(|| "无法定位用户主目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::to_string(&m).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 崩溃日志:任何 Rust panic 都落盘,排查「应用整个消失」类问题(0.3.2)。
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            append_app_log(&format!("PANIC: {info}"));
            default_hook(info);
        }));
    }
    append_app_log("app starting");

    // [0.4.38] 安装 Rust 日志捕获:tauri 建窗失败等错误此前只走 log::error!,
    // 而应用从未装 logger,错误被彻底吞掉(组件 ghost label 事故根因之一)。
    // 发布版把 Warn 及以上落 app.log;debug 构建仍走 tauri_plugin_log(控制台)。
    if !cfg!(debug_assertions) {
        if log::set_logger(&RUST_LOG).is_ok() {
            log::set_max_level(log::LevelFilter::Warn);
        }
    }

    tauri::Builder::default()
        .manage(screenshot::AppState::default())
        .manage(ScreenshotShortcutState::default())
        .manage(ToggleWindowShortcutState::default())
        .manage(WidgetState::default())
        .manage(notes::NoteShortcutState::default())
        .manage(clipboard::ClipboardState::default())
        // 窗口生命周期日志 + 主窗口关闭拦截(改为隐藏,托盘应用标准做法):
        // 之前截图流程若误触发主窗口关闭,进程随最后一个窗口销毁直接退出,
        // 表现为「应用整个消失」。现在主窗口 close 一律拦截成 hide 并留日志。
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                append_app_log(&format!("window close-requested: {}", window.label()));
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                append_app_log(&format!("window destroyed: {}", window.label()));
            }
            _ => {}
        })
        // [0.4.44] 主窗口启动残影修复:main 窗口 visible:false 启动。
        // ⚠️ 绝不能在 page load 时就 show —— 实测(窗口枚举探针)证明此时前端尚未
        // 把窗口摆到屏幕右缘,窗口会以 Windows 默认位置(级联坐标)+白色不透明背景
        // 闪现 1.5~2.5s,即用户看到的「工具残影 + 程序启动框」。
        // 显示时机由前端在「定位完成 + 双 rAF 首帧绘制后」调用 show_main_window_ready;
        // 此处仅留日志,配合 setup 中的 15s 看门狗兜底(页面加载异常时强制显示)。
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                append_app_log("main page load finished (waiting for frontend layout before show)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_update_file,
            install_update,
            set_data_dir,
            reveal_path,
            show_main_window_ready,
            get_persist_config,
            set_persist_config,
            get_pref,
            set_pref,
            clear_webview_cache,
            init_data_dir,
            scan_data_locations,
            screenshot::stash_image,
            screenshot::take_image,
            screenshot::capture_screen,
            screenshot::write_clipboard_image,
            screenshot::save_image,
            screenshot::save_image_to,
            screenshot::window_at_point,
            screenshot::read_clipboard_image,
            screenshot::set_window_ignore_cursor_events,
            screenshot::close_window,
            screenshot::show_capture_overlay,
            screenshot::position_capture_overlay,
            screenshot::finish_capture_overlay,
            screenshot::is_overlay_active,
            screenshot::read_capture_png,
            screenshot::hide_window,
            screenshot::show_pin_window,
            screenshot::dismiss_pin_window,
            screenshot::show_pin_control,
            screenshot::hide_pin_control,
            screenshot::move_pin_control,
            screenshot::find_pin_window,
            register_screenshot_shortcuts,
            set_toggle_window_shortcut,
            show_main_window,
            open_salary_widget,
            close_salary_widget,
            salary_widget_exists,
            notes::notes_open_window,
            notes::notes_close_window,
            notes::notes_window_exists,
            notes::notes_set_pinned,
            notes::register_note_shortcut,
            clipboard::clipboard_list,
            clipboard::clipboard_delete,
            clipboard::clipboard_clear,
            clipboard::clipboard_pin,
            clipboard::clipboard_set_paused,
            clipboard::clipboard_set_config,
            clipboard::clipboard_write_text,
            clipboard::clipboard_copy_back,
            clipboard::clipboard_hide_window,
            clipboard::register_clipboard_shortcut,
            app_log,
            get_screenshot_settings,
            save_screenshot_settings,
            recording_begin,
            recording_append,
            recording_delete,
            recordings_check,
            recording_open,
            recording_reveal,
            recordings_open_folder,
            recording_rename,
            recordings_default_dir,
            open_mic_privacy_settings,
            screenshot_log
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // [0.4.10] 提权自检必须最先执行:安装器完成页以提权上下文启动应用时,
            // 提权实例会锁死 WebView2 数据目录,导致后续所有普通实例假死。
            handle_elevation(app.handle());
            setup_tray(app)?;
            setup_global_shortcuts(app);
            // 启动后台剪贴板监听(监听线程随进程存活,不随窗口开关而停)。
            clipboard::start_monitor(app.handle().clone());

            // [0.4.10] 自启动注册表自愈:清理 productName 改名前遗留的旧条目,
            // 并按持久化偏好无条件重写当前 exe 路径(修复「开机自启旧版本」)。
            fix_autostart(app.handle());

            // [0.4.10] WebView2 启动看门狗:数据目录被残留进程锁死时给出恢复指引。
            spawn_webview_watchdog();

            // [0.4.44] 主窗口显示看门狗:页面加载事件若 15 秒内未触发(页面加载
            // 异常 / 事件丢失),强制显示主窗口,避免「窗口永远不出现」。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(15));
                if !MAIN_SHOWN.load(std::sync::atomic::Ordering::SeqCst) {
                    append_app_log("main window force-shown by watchdog (page load event missing)");
                    show_main_window_no_focus(&handle);
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let _ = window.set_resizable(false);
                let _ = window.set_always_on_top(true);
                let _ = window.set_skip_taskbar(true);
                let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));

                if let Ok(Some(monitor)) = window.current_monitor() {
                    let monitor_size = monitor.size();
                    let monitor_position = monitor.position();
                    let scale_factor = monitor.scale_factor();
                    let window_width = (382.0_f64 * scale_factor).round() as u32;
                    let tab_width = (42.0_f64 * scale_factor).round() as u32;
                    let closed_offset = (2.0_f64 * scale_factor).round() as i32;

                    let _ = window
                        .set_size(tauri::PhysicalSize::new(window_width, monitor_size.height));
                    let _ = window.set_position(tauri::PhysicalPosition::new(
                        monitor_position.x + monitor_size.width as i32 - tab_width as i32
                            + closed_offset,
                        monitor_position.y,
                    ));
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
