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
//! 2. **截图期间绳窗保持可见（2026-11-12 用户明确要求，取代旧 R54）**：
//!    `capture_screen` 用 GDI BitBlt 抓桌面合成帧，旧版抓屏前 `capture_suspend` 隐藏绳窗
//!    + sleep 90ms + show，会肉眼闪烁并与 DWM 合成竞争。现在 suspend/resume 只维护深度
//!    计数，**绝不 hide/show 窗口**；代价是绳身可能被拍进截图，用户已明确接受。
//! 3. **独立命中循环 R68**：Rust 侧没有可挂的 48ms 循环（主窗的是 App.tsx 前端 setInterval）。
//!    绳窗自建独立线程，48ms 轮询 OS 光标自主判定穿透，**绝不改主窗 syncHitTest / dock.ts**。
//!    ⚠️ **禁止在命中循环里调 tao 的 set_ignore_cursor_events**：tao 的该 API 会把
//!    `WS_EX_LAYERED` + `WS_EX_TRANSPARENT` 作为 `IGNORE_CURSOR_EVENT` 的副作用位一起
//!    写入，且每次都从 `to_window_styles()`（`window_state.rs:239`）重建整个 GWL_EXSTYLE
//!    并发 `SWP_FRAMECHANGED`——这会破坏本模块「WS_EX_LAYERED 恒置位」的不变式（见下），
//!    导致死区无法穿透或卡片透底。历史做法是穿透走自写 `set_click_through`（第十九轮
//!    改为 SetWindowRgn 区域裁剪，第二十轮进一步退役——见下文铁律演进）。
//!    透明本身靠 `transparent:true` → tao 在 `on_create` 调 `DwmEnableBlurBehindWindow`
//!    空 region（window.rs:1204-1215）；但 tao 的 `to_window_styles()` **从不为 transparent
//!    窗口加 `WS_EX_LAYERED`**（LAYERED 只随 IGNORE_CURSOR_EVENT 一起加）。
//!    【历史·铁律演进】★★两条铁律（已对照 tao 0.37.2 源码验证）★★：
//!      (A) 死区点击穿透【必须】`WS_EX_LAYERED`：它提供逐像素 alpha 命中测试
//!          （透明像素透传、实色像素捕获）。无 LAYERED → 矩形命中 → 整窗吞点击 → 副屏冻死。
//!          0.4.69~0.4.72 反复冻屏正是把 LAYERED 去掉、只切 TRANSPARENT，LAYERED 始终缺席。
//!      (B) `WS_EX_LAYERED`【绝不】随 hover 翻转：翻转（任何运行期 GWL_EXSTYLE 写入）
//!          触发 DWM 重建「分层窗口」绘制路径，WebView2 的 alpha 被错算 → 卡片实色
//!          漏画 → hover 透底。
//!    → ★★2026-11-14 第十九轮（已证伪，勿回退）★★：SetWindowRgn 区域裁剪——region
//!      让 DWM 走旧式裁剪合成路径、区域内 alpha 通道失效：收起态横带白色底框恒定现形，
//!      hover 重提交帧时卡片纸底 alpha 画丢（透底依旧）。
//!    → ★★2026-11-14 第二十轮（已证伪，勿回退）★★：恒 WS_EX_LAYERED + 恒整屏窗——
//!      逐像素 alpha 命中只存在于 UpdateLayeredWindow 的 GDI 分层路径；WebView2/DWM
//!      合成窗挂 LAYERED 后仍按**矩形**命中 → 整屏窗口启动即整窗捕获点击 → 全屏冻结。
//!    → ★★2026-11-14 第二十一轮定案（绳带窄窗，与便利签/贴图窗同构）★★：窗口本体 =
//!      内容矩形（展开 = 顶部 mon.width×ropeH 横带；收起 = 拉杆处 180×96 小窗；
//!      预览 = 临时放大整屏）。**不依赖任何穿透机制**：窗口矩形外点击天然直达桌面；
//!      EXSTYLE / region 全进程零写入（便利签 / 剪贴板 / 贴图从不写窗口样式也从不
//!      透底 / 冻屏，即同构证明）。窗口几何由前端 placeAndArm / 拖拽路径驱动，
//!      见 clothesline_set_bounds / clothesline_set_position。
//!    ⚠️ 便利签 / 剪贴板 / 贴图 / 主窗同为 `transparent:true`（notes.rs / clipboard.rs /
//!      screenshot.rs），差异不在透明度，而在它们**从不随光标动态切换窗口样式**——
//!      这就是 hover 透底只发生在绳窗、其他类似工具没有此问题的原因。
//! 4. **双端编译 R65**：所有平台相关代码严格 `#[cfg(windows)]` / `#[cfg(not(windows))]`。
//!    macOS 无抓屏实现（screenshot.rs 占位报错），但 0.4.81 起全平台建窗；层级分层
//!    见 `apply_mac_level`（主窗 3 > 绳窗置顶 2 > 普通窗口 0），Windows 逻辑零改动。
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
    /// 整条绳窗在「可用区」内的水平位置（0.0=贴可用区左缘, 0.5=居中, 1.0=贴右缘）。
    /// 问题1/4/11：旧版只有 anchor_y（垂直）与 pulltab_x_ratio（窗口内百分比，不移动窗口），
    /// 导致绳子无法水平移动、收起态拖两次命中矩形错位卡死。统一用本字段驱动整窗 X。
    #[serde(default = "default_half")]
    pub win_x_ratio: f64,
    /// 2026-11-13 问题4：收起态拉杆皮肤（porcelain / brass / glass）。配置页三选一，默认素瓷。
    /// `#[serde(default)]` 必须保留：老档没有此字段时不能整份回落默认（会丢用户全部设置）。
    #[serde(default = "default_pulltab_style")]
    pub pulltab_style: String,
    /// 一次性迁移标记：旧版 clamp bug 会把 win_x_ratio 写成 1.0（视觉却仍居中），
    /// 新版把它按像素真源落位就会把绳窗钉在可移范围最右端 → 「无法向右拖」。
    /// 升级后首次加载把极端脏值归位到 0.5 并写回磁盘，之后永不再迁移，
    /// 用户此后主动拖到最右是合法偏好，不会被误重置。
    #[serde(default)]
    pub win_x_migrated_v2: bool,
    /// 一次性迁移标记：0.4.68 把两个水平位置解绑后，pulltab_x_ratio 的语义从
    /// 「拉杆在绳身上的位置」变成「收起态整窗的水平位置」。老档里的 0.92 之类的
    /// 旧值若直接沿用，升级后拉杆会从居中突然跳到偏右（用户从未设置过的位置）。
    /// 首次加载归位到 0.5 并写盘，之后用户各自拖动的偏好不再被重置。
    #[serde(default)]
    pub x_ratio_split_v1: bool,
    /// 晾衣绳长度（可用区宽度占比 0.3~1.0，默认 0.86）。直接影响单屏可挂卡片数量。
    #[serde(default = "default_rope_ratio")]
    pub rope_width_ratio: f64,
    /// 卡片尺寸缩放（1.0=当前最小尺寸，2.0=放大一倍）。前端按 CSS zoom 整组缩放。
    #[serde(default = "default_card_size")]
    pub card_size: f64,
    /// 0.4.81 上线一次性迁移：所有安装本版本的用户首次启动，晾衣绳总开关一律默认关闭，
    /// 覆盖开发版 / 0.4.80 遗留的 enabled=true。写盘打标记后永不再重置；用户此后
    /// 在配置页手动启用由 clothesline_set_enabled 正常写盘记忆，重启后保持启用。
    #[serde(default)]
    pub default_off_v0481: bool,
}
fn default_half() -> f64 { 0.5 }
fn default_pulltab_style() -> String { "porcelain".to_string() }
fn default_rope_ratio() -> f64 { 0.86 }
fn default_card_size() -> f64 { 1.0 }

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
            win_x_ratio: 0.5,
            pulltab_style: default_pulltab_style(),
            win_x_migrated_v2: true, // 全新安装无需迁移
            x_ratio_split_v1: true,  // 全新安装无需迁移
            rope_width_ratio: default_rope_ratio(),
            card_size: default_card_size(),
            default_off_v0481: true, // 全新安装无需迁移（enabled 本就 false）
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
    if !s.win_x_ratio.is_finite() {
        s.win_x_ratio = 0.5;
    }
    s.win_x_ratio = s.win_x_ratio.clamp(0.0, 1.0);
    if !matches!(s.pulltab_style.as_str(), "porcelain" | "brass" | "glass") {
        s.pulltab_style = default_pulltab_style();
    }
    if !s.rope_width_ratio.is_finite() {
        s.rope_width_ratio = default_rope_ratio();
    }
    s.rope_width_ratio = s.rope_width_ratio.clamp(0.3, 1.0);
    if !s.card_size.is_finite() {
        s.card_size = default_card_size();
    }
    s.card_size = s.card_size.clamp(1.0, 2.0);
    s.monitor_stable_id = s.monitor_stable_id.chars().take(200).collect();
    s
}

/// 升级后一次性迁移旧版 clamp bug 留下的极端 win_x_ratio（实测脏值 1.0，画面却居中）。
/// 用进程内 Once 保证只写一次盘，避免启动期多个加载点并发 remove+rename 竞态。
static WINX_MIGRATION_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn migrate_dirty_winx(base: &Path, s: &mut ClotheslineSettings) {
    if s.win_x_migrated_v2 || WINX_MIGRATION_DONE.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    WINX_MIGRATION_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
    if s.win_x_ratio >= 0.999 || s.win_x_ratio <= 0.001 {
        crate::append_app_log(&format!(
            "[clothesline] 迁移旧版脏 win_x_ratio={} → 0.5（用户画面原本居中）",
            s.win_x_ratio
        ));
        s.win_x_ratio = 0.5;
    }
    s.win_x_migrated_v2 = true;
    // 写回磁盘后下次启动读到的就是 0.5 / true，天然幂等；用户此后主动拖到边缘是合法偏好。
    if let Err(e) = save_settings_to(base, s) {
        crate::append_app_log(&format!("[clothesline] win_x 迁移写盘失败: {e}"));
    }
}

/// 0.4.68 两态位置解绑的存量迁移：老档 pulltab_x_ratio 语义完全不同，归位居中。
static SPLIT_X_MIGRATION_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn migrate_split_x_ratios(base: &Path, s: &mut ClotheslineSettings) {
    if s.x_ratio_split_v1
        || SPLIT_X_MIGRATION_DONE.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    crate::append_app_log(&format!(
        "[clothesline] 两态位置解绑：旧 pulltab_x_ratio={} 归位 0.5（语义已变更）",
        s.pulltab_x_ratio
    ));
    s.pulltab_x_ratio = 0.5;
    s.x_ratio_split_v1 = true;
    if let Err(e) = save_settings_to(base, s) {
        crate::append_app_log(&format!("[clothesline] 两态位置迁移写盘失败: {e}"));
    }
}

/// 0.4.81 上线一次性迁移：所有安装本版本的用户首次启动，晾衣绳总开关强制归位关闭，
/// 覆盖开发版 / 0.4.80 遗留的 enabled=true。用进程内 Once 保证只写一次盘，
/// 与上面两次迁移同款，避免启动期多个加载点并发 remove+rename 竞态。
static DEFAULT_OFF_0481_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn migrate_default_off_0481(base: &Path, s: &mut ClotheslineSettings) {
    if s.default_off_v0481
        || DEFAULT_OFF_0481_DONE.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    crate::append_app_log(&format!(
        "[clothesline] 0.4.81 首次启动：总开关强制默认关闭（原 enabled={}）",
        s.enabled
    ));
    s.enabled = false;
    s.default_off_v0481 = true;
    // 写回磁盘后天然幂等；此后用户手动启用写盘时标记仍在，不会被再次重置。
    if let Err(e) = save_settings_to(base, s) {
        crate::append_app_log(&format!("[clothesline] 0.4.81 默认关闭迁移写盘失败: {e}"));
    }
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
            Ok(v) => {
                let mut v = sanitize(v);
                migrate_dirty_winx(base, &mut v);
                migrate_split_x_ratios(base, &mut v);
                migrate_default_off_0481(base, &mut v);
                v
            }
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
    /// ★第二十一轮起**只服务浮层关闭检测**（问题13「左键点在面板外」判定），不再参与
    /// OS 命中测试——命中由绳带窄窗的普通矩形窗口语义天然完成。
    /// - 非空：常态（展开面板矩形 / 收起拉绳横带）。
    /// - 空数组：预览 / 拖放会话期间暂停窗外判定；超时 8s 自动回退到最近一次非空
    ///          矩形（见 empty_hit_since）。
    /// ⚠️ 命中判定必须在 Rust 侧用 OS 轮询，**绝不能靠前端 pointermove 写回**：
    ///    窗外点击永远到不了前端，前端自写会永久锁死（PRD R68 / 项目 MEMORY 铁律）。
    pub hit_rects: Mutex<Vec<HitRect>>,
    /// 空 hit_rects（预览/拖放会话）的起算时刻；仅用于异常残留兜底，前端正常关闭会清空。
    pub empty_hit_since: Mutex<Option<std::time::Instant>>,
    /// 最近一次非空命中矩形快照：空列表超时后自动回退，保证 dismiss 判定始终有效。
    pub last_non_empty_rects: Mutex<Vec<HitRect>>,
    /// force 兼容桩的计时器（第二十轮起命中循环已不读取；保留仅为命令接口稳定）。
    pub force_clickable_until: Mutex<Option<std::time::Instant>>,
    /// 独立命中循环的停止标志。关闭总开关即置 true，线程下一轮 48ms 自行退出。
    pub stop_loop: AtomicBool,
    /// 命中循环是否已启动（防止重复 spawn 堆积线程）。
    pub loop_running: AtomicBool,
    /// 截图挂起深度（支持前端会话级 + capture_screen 自守卫嵌套）。
    pub suspend_depth: AtomicU32,
    /// 浮层（右键菜单 / ＋菜单）打开期间置 true：命中循环据此检测「左键点在可点区外」，
    /// 发 cl-dismiss-overlay 让前端关闭浮层（问题13：透明穿透窗收不到窗外 click，必须 OS 轮询）。
    pub dismiss_on_outside: AtomicBool,
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
/// 0.4.81 起全平台建窗：透明浮窗用 Tauri 跨平台 API（与 notes.rs::build_note_window
/// 同构，便利签在 mac 已验证可用），不再仅限 Windows。平台差异只在 builder 的可选方法。
// ————————————————————————— macOS 窗口层级分层 —————————————————————————
// tao 在 mac 上把 `set_always_on_top(true)` 映射为 NSFloatingWindowLevel(3)，而主窗
// 恒为该层（tauri.conf alwaysOnTop:true + setup / 焦点 / 托盘事件都会重设）。绳窗若
// 同为 3，后建 / 后设的绳窗会盖住主窗；Mac 透明窗按**矩形**命中（无 Windows 的
// 逐像素穿透），横带覆盖区就会把主窗顶部按钮点击全部吞掉。
//
// 修复不是关掉置顶（那会让用户勾选的「置顶」失效），而是分层：
//   主窗 3(NSFloatingWindowLevel) > 绳窗置顶 2 > 普通窗口 0(NSNormalWindowLevel)
// → ① 绳窗任何情况下都不遮主窗；② 用户主动置顶时仍浮于其他普通窗口之上，
//    与 Windows 的置顶语义一致。
//
// 绳窗 build 时 `.always_on_top(false)` 让 tao 内部状态保持 normal，避免 tao 后续
// apply_diff 把我们写入的 2 覆盖回 3；level 只由本函数写。NSWindow 的 setLevel:
// 必须在主线程调用，故经 run_on_main_thread 派发。
#[cfg(target_os = "macos")]
const CL_LEVEL_TOP: isize = 2;
#[cfg(target_os = "macos")]
const CL_LEVEL_NORMAL: isize = 0;

#[cfg(target_os = "macos")]
fn apply_mac_level(app: &tauri::AppHandle, win: tauri::WebviewWindow, top: bool) {
    let level = if top { CL_LEVEL_TOP } else { CL_LEVEL_NORMAL };
    let _ = app.run_on_main_thread(move || {
        use std::ffi::{c_char, c_void};
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_msgSend(receiver: *mut c_void, selector: *const c_char, level: isize);
            fn sel_registerName(name: *const c_char) -> *const c_char;
        }
        let Ok(ptr) = win.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            // NSWindow 的 setLevel: 返回 void，参数 NSInteger（64 位 = isize）。
            let sel = sel_registerName(b"setLevel:\0".as_ptr() as *const c_char);
            objc_msgSend(ptr, sel, level);
        }
    });
}

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
        // ⚠️ 必须与主窗口 / 其余 8 个窗口逐字符一致，否则 0x8007139F（Windows WebView2）。
        // 便利签在 mac 同样无 cfg 传此参数，跨平台 builder 接受、mac 侧忽略。
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(1280.0, 120.0)
        .decorations(false)
        .transparent(true)
        .visible(false) // 由前端定位完成 + 首帧绘制后调用 clothesline_show 才显示。
        // ★Mac 层级：主窗恒为 NSFloatingWindowLevel(3)，绳窗置顶用自定义 level 2
        //   （见上方 apply_mac_level 注释），既低于主窗、又高于普通窗口。这里给 false
        //   是让 tao 内部状态保持 normal，避免它后续 apply_diff 覆盖我们写入的 2/0。
        //   Windows 维持原置顶策略零改动，直接读用户偏好。
        .always_on_top({
            #[cfg(windows)]
            { load_settings().always_on_top }
            #[cfg(not(windows))]
            { false }
        })
        .skip_taskbar(true)
        .focused(false) // 绝不抢焦点（与 capture-overlay 同款克制）。
        .resizable(false)
        .shadow(false);

    // 问题9：Windows 上把拖放交还 WebView DOM（wry 原生接管会让 onDrop 拿不到 files）。
    // drag_and_drop 仅 Windows 需要；mac 分支不调用，避免平台 API 差异。
    #[cfg(windows)]
    let builder = builder.drag_and_drop(false);
    #[cfg(not(windows))]
    let builder = builder;

    match builder.build() {
        Ok(win) => {
            if probe_alive(&win) {
                // ★第二十一轮（绳带窄窗）：EXSTYLE / region 全进程零写入。窗口本体 =
                //   内容矩形（冷启动由前端 placeAndArm 写横带 / 小窗矩形），命中 =
                //   普通矩形窗口语义，窗口外点击天然直达桌面，无需任何穿透机制
                //   （与便利签 / 贴图窗完全同构）。历史教训见文件头铁律演进。
                crate::append_app_log("[clothesline] 窗口创建成功（绳带窄窗 · 零窗口样式写入）");
                // Mac：建窗时 tao 给的 normal(0) 需按用户偏好升到分层值（置顶 2 / 普通 0）。
                // Windows 的层级已由 builder 的 always_on_top 设置，无需后续写入。
                #[cfg(target_os = "macos")]
                apply_mac_level(app, win.clone(), load_settings().always_on_top);
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

/// 鼠标左键此刻是否按下（边沿检测用）。仅 Windows 建绳窗，故只实现 Windows 分支。
#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    // GetAsyncKeyState 高位(0x8000)表示当前按下。
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}
#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

/// 光标是否落在任一可点矩形内（屏幕绝对坐标直接比对，零窗口位置 IPC）。
fn cursor_on_clickable(cx: i32, cy: i32, rects: &[HitRect]) -> bool {
    rects
        .iter()
        .any(|r| cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height)
}

/// ★2026-11-14 第十四轮：hover 透底 / 副屏冻屏的统一解释（app.log 实证 + 全项目差异比对）。
///
/// 【证据链】
/// · 前端 `.cl-card:hover` 为空、`opacity:1 !important`、无 JS hover state、清风动画只改
///   transform；CSS 方向十余轮修改全部无效 → 问题不在 CSS，也不在 GPU 开关。
/// · `app.log` 中每次鼠标移入 / 离开卡片都伴随一条「穿透切换 → 可点/穿透」：hover 真正
///   触发的是 Rust 侧 48ms 命中循环改写 `GWL_EXSTYLE`。
/// · 全项目只有本文件有「随光标切窗口样式 + `SetWindowPos`」这条路径。便利签 / 剪贴板 /
///   贴图 / 主窗同为 `transparent(true)`，但从不动态切样式 → 这正是「为什么桌面便利签
///   置顶在其他页面上不会出现该问题，而晾衣绳会」的答案。
///
/// 【两条铁律，缺一则死】
///  (A) 死区穿透【必须】`WS_EX_LAYERED` 恒置位：缺位 → 窗口按矩形命中 → 整窗吞点击 →
///      副屏冻死（0.4.69~0.4.72 反复冻屏即因只切 TRANSPARENT、LAYERED 始终缺席）。
///      tao 的 `to_window_styles()`（window_state.rs:239-298）从不为 transparent 窗口自动
///      加该位，且 `set_always_on_top` / `show()` 经 apply_diff 会抹掉它 → 调用后须即时补回。
///  (B) `WS_EX_LAYERED`【绝不】翻转：翻转触发 DWM 重建分层窗口绘制路径 → WebView2 提交的
///      alpha 被错算 → 卡片实色纸底漏画（0.4.68 在「可点态」移除 LAYERED 即此病）。
///
/// 【0.4.77 写法，0.4.79 保留】hover 切换只写 `GWL_EXSTYLE` 的 `WS_EX_TRANSPARENT`
/// 一位、不调 `SetWindowPos`，仅首次补 LAYERED 时调一次。它消除了 0.4.73 起每次切换
/// 补 `SWP_FRAMECHANGED` 带来的额外整窗重绘，但**并未**解决 hover 透底（0.4.77 实机
/// 证伪）。保留只因为它稳定、不冻屏、可交互。
///
/// ★2026-11-14 第十八轮：hover 透底经 17 轮排除，已确认与 CSS（:hover 为空、
///   opacity:1、无滤镜/混合模式）、清风动画（关掉仍复现）、GPU 开关、SetWindowPos
///   重绘（0.4.77 零重绘仍复现）均无关。剩余最强差异：只有本窗是**整屏**透明窗，
///   卡片仅占顶部一条，其余为大面积 alpha=0 死区。详见下方输入通道注释。
///   日志仍打印「首次建层 / 零重绘」与 EXSTYLE 实值作为诊断证据。
///
/// 写入仅在状态翻转时发生，交互锁（force / overlay）期间连这一位都不写；命中循环每轮
/// 回读 OS 真实样式自愈，不留 48ms 空窗。
// ★2026-11-14 第十九轮（已证伪，勿回退）：SetWindowRgn 区域裁剪实测引入两个新症状——
// ① 收起态横带内出现恒定白色底框（DOM 无任何元素能画出它）：DWM 对带 region 的窗口
//    走旧式裁剪合成路径，区域内 alpha 通道失效，WebView 空白底色 + 裁剪边缘现形；
// ② hover 透底依旧：app.log 证实 hover 期间零 SetWindowRgn，但 hover 触发 WebView2
//    重提交合成帧时，被 region 毒化的合成路径把卡片纸底的 alpha 画丢。
//
// ★★2026-11-14 第二十轮（已证伪，勿回退）：恒 WS_EX_LAYERED + 恒整屏窗——
// 上述「全程零运行期窗口写入」形态实测**启动即全屏冻结**：逐像素 alpha 命中只存在于
// UpdateLayeredWindow 的 GDI 分层路径；WebView2/DWM 合成窗挂 LAYERED 后命中测试仍是
// **矩形** → 整屏窗口把整个桌面罩住、整窗捕获点击 → 全屏无法操作。铁律 A「死区穿透
// 必须 LAYERED」对整屏合成窗不成立，已随第二十一轮一并作废。
//
// ★★★ 2026-11-14 第二十一轮定案（绳带窄窗 · 零穿透机制 · 零窗口样式写入）★★★
// 窗口本体 = 内容矩形（与便利签 / 贴图 / 剪贴板窗同构）：
//  · 展开 = 顶部一条 mon.width × ropeH 横带；收起 = 拉杆处 180×96 小窗；
//    大图预览 = 临时放大整屏，关闭即恢复横带（均为离散 resize，可接受）；
//  · 命中回归普通矩形窗口语义：窗口矩形外点击天然直达桌面，窗口内透明区随窗存在
//    （展开横带仅占屏幕顶部一条，可接受；收起小窗不再阻挡桌面——旧 complaint 的根因）；
//  · EXSTYLE / region 全进程零写入：透底的两大触发源（运行期 EXSTYLE 写入、region
//    毒化 alpha）在架构上不存在；冻屏触发源（整屏矩形窗）同样不存在。

/// ★第二十轮函数 apply_constant_layered 已随第二十一轮拆除（勿回退）：恒 LAYERED 在
/// WebView2/DWM 合成窗上没有逐像素命中（那只存在于 UpdateLayeredWindow 的 GDI 路径），
/// 整屏窗 + 恒 LAYERED 实测启动即整窗捕获点击 → 全屏冻结。绳带窄窗架构下命中回归
/// 普通矩形窗口语义，任何 EXSTYLE 写入都不再需要——这也正是便利签 / 贴图窗的形态。

// ————————————————— 输入通道（0.4.78 低级钩子方案：已证伪、已移除）—————————————————
//
// ★2026-11-14 第十八轮 app.log 实测结论，勿再重试此路线：
//   `WH_MOUSE_LL` 全局钩子「hover 恒穿透、按键瞬间切可点」在本窗失效且引入严重回归：
//   1) 钩子回调发生时系统已完成命中测试，按键时才清 WS_EX_TRANSPARENT，来不及把
//      目标已定为下层窗口的消息改投给本窗；
//   2) 命中循环在 86% 的情况下 100~150ms 后就把窗口切回穿透（本次启动 21 组
//      「钩子按下→命中循环穿透」配对，平均 440ms），down/move/up 序列断裂，
//      卡片点击、拖动排序、拉杆展开全部无反应；
//   3) 钩子回调里做 EXSTYLE 写入 + 磁盘日志 I/O，拖慢系统鼠标输入 → 体感整屏冻住。
//   4) 用户仍报告 hover 透底，但本轮测试伴随反复点击（21 组按下配对）触发了
//      可点态脉冲，日志无法区分「纯 hover 透明」与「点击瞬间透明」，因此 0.4.78
//      不能作为「恒穿透能否消除透底」的干净判定，勿据此下结论或推翻前轮推断。
//   ⇒ 窗口穿透时收不到鼠标消息，「恒穿透 + 事后补发输入」在本实现下不可用。
//   ⇒ 已确定事实：0.4.77 下「可点态=卡片透明 / 穿透态=正常」稳定复现；且
//      只有本窗是**整屏**透明窗（卡片仅占顶部一条，其余为大面积 alpha=0 死区），
//      便利签 / 剪贴板 / 贴图窗口内容铺满、无大面积全透明区，从不复现。
//      具体合成机制未定，但差异点明确落在「窗口几何 + 大面积透明区」上。
//   ★2026-11-14 第十九轮 SetWindowRgn 区域裁剪已证伪（勿回退）：region 让 DWM 走旧式
//   裁剪合成路径、alpha 通道在区域内失效 → 收起态横带白色底框现形 + hover 透底依旧。
//   ★2026-11-14 第二十一轮定案：绳带窄窗（窗口本体 = 内容矩形，与便利签 / 贴图窗同构），
//   EXSTYLE / region 全进程零写入，命中 = 普通矩形窗口语义，无需任何穿透机制。
//   第二十轮「恒 LAYERED 逐像素命中」已证伪（整屏窗 + LAYERED = 启动即全屏冻结），
//   第二十轮两处定案注释（此处与 rects_sig 旧址）以本轮为准。

/// 启动绳窗自有命中循环（48ms OS 轮询）。★第二十一轮起职责收敛为两件事：
/// 1. **命中矩形簿记**：维护 hit_rects / 最近非空快照（仅服务浮层关闭检测）；
///    空矩形超时 8s → 回退最近非空快照。命中由绳带窄窗的普通矩形窗口语义天然完成，
///    循环对 hover / 光标移动**零窗口操作**（第二十轮形态保留）。
/// 2. **浮层关闭检测**（问题13）：菜单打开时轮询「左键按下边沿 + 光标在矩形外」
///    → 发 cl-dismiss-overlay（透明区域外收不到 click，必须 OS 轮询）。
///
/// 只作用于本窗，绝不触碰主窗 48ms 循环、dock.ts、零 RPC 快路径。
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
        crate::append_app_log("[clothesline] 独立命中循环启动 (48ms · 绳带窄窗 · 零窗口操作)");
        let mut last_seen = std::time::Instant::now();
        let mut prev_lbuttondown = false; // 左键上一帧状态，用于边沿检测（问题13）。
        while !state.stop_loop.load(Ordering::Relaxed) {
            // 截图挂起期间不干预，避免与 hide/show 竞态。
            let suspended = state.suspend_depth.load(Ordering::Relaxed) > 0;
            if !suspended {
                let mut rects = state.hit_rects.lock().unwrap().clone();
                // 空矩形兜底：矩形表只服务浮层关闭检测，前端正常永远上报面板矩形；
                // 若前端异常停在空列表（预览/拖放会话丢失收尾），8s 后回退最近非空
                // 快照，保证 dismiss 检测始终有有效的「面板内/外」判定依据。
                if rects.is_empty() {
                    let expired = state
                        .empty_hit_since
                        .lock()
                        .unwrap()
                        .map(|t| t.elapsed() >= Duration::from_secs(8))
                        .unwrap_or(false);
                    if expired {
                        let fallback = state.last_non_empty_rects.lock().unwrap().clone();
                        if !fallback.is_empty() {
                            *state.hit_rects.lock().unwrap() = fallback.clone();
                            *state.empty_hit_since.lock().unwrap() = None;
                            rects = fallback;
                            crate::append_app_log(
                                "[clothesline] 空命中矩形超时，已自动回退到面板矩形",
                            );
                        }
                    }
                }
                // ★第二十一轮：循环内零窗口操作——命中由绳带窄窗的矩形窗口语义天然完成，
                if app.get_webview_window(LABEL).is_some() {
                    last_seen = std::time::Instant::now();
                }

                // 问题13：右键菜单 / ＋菜单打开时，区域外点击（事件直达桌面）收不到
                // click。用 OS 轮询检测「左键按下边沿」且光标不在任何可点矩形内 →
                // 发关闭事件。只在浮层打开时检测；一次按下只发一次（清标志），避免连发。
                let cursor = cursor_physical();
                if state.dismiss_on_outside.load(Ordering::Relaxed) {
                    let ldown = left_button_down();
                    let just_pressed = ldown && !prev_lbuttondown;
                    let outside = match cursor {
                        Some((cx, cy)) => !rects.is_empty() && !cursor_on_clickable(cx, cy, &rects),
                        None => false,
                    };
                    if just_pressed && outside {
                        state.dismiss_on_outside.store(false, Ordering::SeqCst);
                        let _ = app.emit("cl-dismiss-overlay", ());
                    }
                    prev_lbuttondown = ldown;
                } else {
                    prev_lbuttondown = false;
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

/// 截图会话开始：★2026-11-12 用户明确要求「操作截图时晾衣绳不要自动隐藏」。
///
/// 旧版 capture_screen 首行挂 CaptureGuard → hide 绳窗 + sleep 90ms + show，
/// 造成肉眼可见的闪烁，且 hide/show 与 DWM 合成竞争还会诱发透底 / 抖动。
/// 现在只维护深度计数（供命中循环识别「截图会话中」），**绝无任何窗口可见性副作用**。
/// 代价：绳身可能被拍进截图 / 贴图，用户已明确接受。
pub fn capture_suspend(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return;
    };
    state.suspend_depth.fetch_add(1, Ordering::SeqCst);
    crate::append_app_log("[clothesline] 截图会话开始：绳窗保持可见");
}

/// 截图会话结束：只减深度计数，绝不 show / hide 窗口。
pub fn capture_resume(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return;
    };
    let prev = state.suspend_depth.load(Ordering::SeqCst);
    if prev > 0 {
        state.suspend_depth.fetch_sub(1, Ordering::SeqCst);
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
                "win_x_ratio" => {
                    if let Some(n) = v.as_f64() { s.win_x_ratio = n }
                }
                "pulltab_style" => {
                    if let Some(v) = v.as_str() { s.pulltab_style = v.to_string() }
                }
                "rope_width_ratio" => {
                    if let Some(n) = v.as_f64() { s.rope_width_ratio = n }
                }
                "card_size" => {
                    if let Some(n) = v.as_f64() { s.card_size = n }
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
        // ★Windows：tao 原生置顶（WS_EX_TOPMOST），行为不变。
        #[cfg(windows)]
        win.set_always_on_top(on).map_err(|e| e.to_string())?;
        // ★Mac：写入分层 level（置顶 2 / 普通 0）。绝不调用 tao 的 set_always_on_top，
        //   那会升到 3 与主窗同层、重新遮住主窗顶部按钮（见 apply_mac_level 注释）。
        #[cfg(target_os = "macos")]
        apply_mac_level(&app, win, on);
    }
    let _ = app.emit("clothesline-topmost-changed", on);
    Ok(())
}

/// 一次性写入窗口矩形（物理像素）：Windows 侧用**一条** `SetWindowPos` 同时改位置 + 尺寸。
///
/// ★2026-11-13 问题3「每点一次大图预览晾衣绳都晃一下 / 像重新调整位置」的根因：
///   `apply_bounds_inner` 是「set_position → sleep 16ms → set_size」×3 的三连写，
///   中间必然出现「新位置 + 旧尺寸」的过渡帧。冷启动首帧必须这么写（混合 DPI 下
///   `set_size` 可能被 `/1.5` 吞掉，需要重复校验），但**运行期的预览放大 / 复原**
///   走三连写就是纯抖动源。这里提供单次原子写入的通道，供预览与稳态重定位使用。
#[cfg(windows)]
fn set_bounds_one_shot(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    let raw = win.hwnd().map_err(|e| format!("取窗口句柄失败: {e}"))?;
    // tauri 与业务代码各用一版 windows crate，HWND 是同构 newtype，按裸指针重建即可。
    let hwnd = HWND(raw.0);
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            w as i32,
            h as i32,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
        .map_err(|e| format!("设置窗口矩形失败: {e}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_bounds_one_shot(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())
}

/// 运行期重定位 / 预览放大复原：单次写入，**不 show、不重试**。
#[tauri::command]
pub fn clothesline_set_bounds(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "晾衣绳窗口不存在".to_string())?;
    if win.is_visible().is_err() {
        return Err("晾衣绳窗口句柄失效 (ghost)".to_string());
    }
    set_bounds_one_shot(&win, x, y, width, height)
}

/// 拖拽逐帧移动（第二十一轮绳带窄窗）：只改位置、**绝不改尺寸**。
/// set_position 不触碰窗口宽度 / 高度 → WebView2 视口恒定 → 零重排零重绘，
/// 逐帧调用也只产生一次普通 SetWindowPos。收起态拉杆拖动 / 展开态垂直 anchor
/// 拖动走这条通道；展开态水平拖动仍走纯 CSS 变量（窗口恒为整屏宽横带，不动）。
#[tauri::command]
pub fn clothesline_set_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "晾衣绳窗口不存在".to_string())?;
    if win.is_visible().is_err() {
        return Err("晾衣绳窗口句柄失效 (ghost)".to_string());
    }
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| format!("设置位置失败: {e}"))
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
        // ★第二十一轮：裸 show（绳带窄窗 · 全进程零 EXSTYLE 写入，show / 置顶不需要
        //   任何样式补写；与便利签 / 贴图窗同构）。
        win.show().map_err(|e| e.to_string())?;
        // Mac：真正显示时复核一次分层 level（setLevel 幂等），防止原生层状态
        // 变化把绳窗抬回 3 与主窗同层。Windows 无需此步。
        #[cfg(target_os = "macos")]
        apply_mac_level(&app, win, load_settings().always_on_top);
    }
    Ok(())
}

/// 前端布局完成后上报「可点矩形」（屏幕绝对物理坐标）。★第二十一轮起本表**只服务
/// 浮层关闭检测**（问题13：判定「左键点在面板外」），不再参与 OS 命中测试——
/// 命中由绳带窄窗的普通矩形窗口语义天然完成（窗口外点击直达桌面）。
/// - 传若干矩形 = 常态（展开面板矩形 / 收起拉绳横带）。
/// - 传空数组 [] = 预览 / 拖放会话（浮层铺满窗口期间暂停窗外判定）；仅记录起算
///   时刻并保留上一次非空矩形快照，前端异常丢失收尾时 8s 后命中循环自动回退。
/// ⚠️ 绝不让前端根据 pointermove 写穿透布尔值——历史上正是这类运行期窗口样式写入
///    触发 DWM 重建合成层（hover 透底），绳带窄窗架构下已无该通道（R68）。
#[tauri::command]
pub fn clothesline_set_hit_rects(app: tauri::AppHandle, rects: Vec<HitRect>) {
    if let Some(state) = app.try_state::<ClotheslineState>() {
        if rects.is_empty() {
            *state.empty_hit_since.lock().unwrap() = Some(std::time::Instant::now());
        } else {
            *state.empty_hit_since.lock().unwrap() = None;
            *state.last_non_empty_rects.lock().unwrap() = rects.clone();
        }
        *state.hit_rects.lock().unwrap() = rects.clone();
    }
}

/// 「临时强制可点」请求。★第二十一轮起为**无副作用兼容桩**：绳带窄窗下不存在
/// 「穿透/可点」双态，force 对窗口零操作（拖拽会话由按下期间 OS 鼠标捕获
/// 保障消息连续，不需要窗口级强制）。命令与前端调用点保留，避免无谓的接口 churn；
/// timer 仅作记录，命中循环已不再读取。
///
/// ★2026-11-13 安全钳制（历史留存）：单次 force 存活上限 MAX_FORCE_MS（2.5s）。
const MAX_FORCE_MS: u64 = 2500;
#[tauri::command]
pub fn clothesline_set_force_clickable(app: tauri::AppHandle, duration_ms: u64) {
    if let Some(state) = app.try_state::<ClotheslineState>() {
        let dur = duration_ms.min(MAX_FORCE_MS);
        *state.force_clickable_until.lock().unwrap() =
            Some(std::time::Instant::now() + Duration::from_millis(dur));
    }
}

/// 浮层（右键菜单 / ＋菜单）开合时由前端调用。打开→命中循环检测窗外左键→发关闭事件；
/// 关闭→停止检测。透明穿透窗收不到窗外 click，这是唯一可靠的「点外面关菜单」通道（问题13）。
#[tauri::command]
pub fn clothesline_set_dismiss_on_outside(app: tauri::AppHandle, on: bool) {
    if let Some(state) = app.try_state::<ClotheslineState>() {
        state.dismiss_on_outside.store(on, Ordering::SeqCst);
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
    Audio,      // 一键录音卡（会话级：录音引擎在主窗内存里，重启后不可能续录，故不恢复）
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
    /// 番茄总时长（正计时暂停后恢复 / 小重置 / +5 分需要；倒计时可由 end_at-created_at 推出，
    /// 但正计时暂停时 end_at 已置空，没有它就推不出总时长 → 2026-11-15 反馈4 修复）。
    #[serde(default)]
    pub timer_total_ms: Option<i64>,
    #[serde(default = "default_timer_direction")]
    pub timer_direction: String, // countdown | countup
    #[serde(default = "default_timer_mode")]
    pub timer_elapsed_mode: String, // wallclock | runtime
    #[serde(default)]
    pub fired_at: Option<i64>, // 提醒已触发去重，防重启重复弹
    /// 自定义卡片底色（CSS 十六进制；None/None = 沿用类型默认纸色）。
    #[serde(default)]
    pub card_color: Option<String>,
    /// 番茄钟卡片样式（paper=纸感 / minimal=极简 / glass=玻璃；默认 paper）。
    #[serde(default)]
    pub card_style: Option<String>,
    /// 计时卡结束是否弹提醒（默认 true）。
    #[serde(default = "default_true")]
    pub remind: bool,
    /// 卡内文字缩放（0.6~1.4；None = 1）。便利签 / 随手记卡的字号调节真源。
    #[serde(default)]
    pub font_scale: Option<f64>,
    /// ★批12 随手记字体格式：标题字号（px，None=默认 12.5，恒不受 font_scale 影响）。
    #[serde(default)]
    pub title_size: Option<f64>,
    /// 正文字号基准（px，实际渲染仍乘 font_scale；None=默认 10）。
    #[serde(default)]
    pub body_size: Option<f64>,
    /// 自定义字体族（CSS font-family 值，如 'Microsoft YaHei'；None=默认 Segoe UI）。
    #[serde(default)]
    pub font_family: Option<String>,
    /// 标题加粗（None/Some(true)=默认加粗 800；Some(false)=常规 500）。
    #[serde(default)]
    pub title_bold: Option<bool>,
    #[serde(default)]
    pub title_italic: Option<bool>,
    /// 正文加粗（None=常规 500；Some(true)=700）。
    #[serde(default)]
    pub body_bold: Option<bool>,
    #[serde(default)]
    pub body_italic: Option<bool>,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 软删除时间戳（ms）。有值 = 10s 撤销窗口内；正常退出提交为已删。
    #[serde(default)]
    pub deleted_at: Option<i64>,
    /// 归档时间戳（ms）。有值 = 已归档：不出现在绳上（parse_cards / active_snapshot
    /// 均过滤），但数据持久保留在 cards.json，供归档页查看 / 恢复 / 永久删除。
    /// 零迁移：旧 cards.json 反序列化时自动为 None。
    #[serde(default)]
    pub archived_at: Option<i64>,
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
/// ★一键录音卡（kind=audio）是会话级卡片：录音引擎在主窗内存中，重启后该卡的
/// 「录音进行中」状态不可能恢复，恢复出来只会是一张死卡 → 启动时一律丢弃。
fn parse_cards(raw: &str) -> Result<Vec<ClotheslineCard>, String> {
    let mut cards: Vec<ClotheslineCard> =
        serde_json::from_str(raw).map_err(|e| format!("cards.json 解析失败: {e}"))?;
    cards.retain(|c| {
        c.deleted_at.is_none()
            && c.archived_at.is_none() // 归档卡不回绳，但保留在 cards.json 供归档页。
            && c.kind != CardKind::Audio
    }); // 「没删就一定在」；软删除 / 已归档的卡不恢复。
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
        .filter(|c| c.deleted_at.is_none() && c.archived_at.is_none())
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
        if card.deleted_at.is_some() || card.archived_at.is_some() {
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
    let mut v: Vec<ClotheslineCard> = all
        .iter()
        .filter(|c| c.deleted_at.is_none() && c.archived_at.is_none())
        .cloned()
        .collect();
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
    pub timer_total_ms: Option<i64>,
    /// ★2026-11-18 重置语义：正计时重置必须重设 created_at 锚点（显示=now-created_at）。
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub timer_direction: Option<String>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub fired_at: Option<Option<i64>>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub card_color: Option<String>,
    #[serde(default)]
    pub card_style: Option<String>,
    #[serde(default)]
    pub remind: Option<bool>,
    #[serde(default)]
    pub font_scale: Option<f64>,
    /// ★批12 随手记字体格式（DoubleOption：缺失=不改 / null=清空回默认 / 值=设置）。
    #[serde(default, deserialize_with = "de_double_option")]
    pub title_size: Option<Option<f64>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub body_size: Option<Option<f64>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub font_family: Option<Option<String>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub title_bold: Option<Option<bool>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub title_italic: Option<Option<bool>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub body_bold: Option<Option<bool>>,
    #[serde(default, deserialize_with = "de_double_option")]
    pub body_italic: Option<Option<bool>>,
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
    // 归档卡不占绳上配额（与软删除同口径：不在绳上就不算挂着的）。
    let active_count = all
        .iter()
        .filter(|c| c.deleted_at.is_none() && c.archived_at.is_none())
        .count();

    // 计时卡额外约束：同时运行（有未来结束时间且未触发）最多 3 张，
    // 与总额度独立；超出的计时仍可创建为「已结束」草稿，避免误吞用户操作。
    if card.kind == CardKind::Timer {
        let running = all
            .iter()
            .filter(|c| {
                c.deleted_at.is_none()
                    && c.archived_at.is_none()
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
            .filter(|c| c.deleted_at.is_none() && c.archived_at.is_none() && !c.pinned)
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
    if let Some(v) = patch.card_color { c.card_color = Some(v); }
    if let Some(v) = patch.card_style { c.card_style = Some(v); }
    if let Some(v) = patch.remind { c.remind = v; }
    if let Some(v) = patch.font_scale { c.font_scale = Some(v); }
    // ★批12 随手记字体格式（DoubleOption：Some(内层) → 写入/清空）。
    if let Some(v) = patch.title_size { c.title_size = v; }
    if let Some(v) = patch.body_size { c.body_size = v; }
    if let Some(v) = patch.font_family { c.font_family = v; }
    if let Some(v) = patch.title_bold { c.title_bold = v; }
    if let Some(v) = patch.title_italic { c.title_italic = v; }
    if let Some(v) = patch.body_bold { c.body_bold = v; }
    if let Some(v) = patch.body_italic { c.body_italic = v; }
    if let Some(v) = patch.timer_total_ms { c.timer_total_ms = Some(v); }
    if let Some(v) = patch.created_at { c.created_at = v; } // ★重置：正计时从 0 重计。
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

/// ————————————————————————— 归档（2026-11-18）—————————————————————————
/// 归档 ≠ 软删除：archived_at 有值 = 不在绳上但持久保留，归档页可查看/恢复/永久删除。
/// 恢复语义同 clRestoreCard：「位置不可改变」——order 不动，回原槽位。

/// 归档卡片。Timer 顺带清 end_at / fired_at 并把 remind 恢复默认：
/// 停止计时并杜绝「恢复后触发历史闹钟」（end_at 已清，恢复后从静止态重新起算）。
#[tauri::command]
pub fn clothesline_archive_card(app: tauri::AppHandle, id: String) -> Result<ClotheslineCard, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let archived = {
        let c = all
            .iter_mut()
            .find(|c| c.id == id && c.deleted_at.is_none() && c.archived_at.is_none())
            .ok_or_else(|| "卡片不存在或已归档".to_string())?;
        let ts = now_ms();
        c.archived_at = Some(ts);
        c.updated_at = ts;
        if c.kind == CardKind::Timer {
            c.end_at = None;
            c.fired_at = None;
            c.remind = true; // 恢复默认：归档即停止计时语义，重挂后不残留旧提醒配置。
        }
        c.clone()
    };
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    crate::append_app_log(&format!("[clothesline] 归档卡片 {}", archived.kind_to_log()));
    Ok(archived)
}

/// 归档清单（归档页数据源）：deleted_at 无值 && archived_at 有值，按归档时间倒序。
#[tauri::command]
pub fn clothesline_list_archived(app: tauri::AppHandle) -> Result<Vec<ClotheslineCard>, String> {
    let _ = &app;
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let all = read_all_cards(&base)?;
    let mut v: Vec<ClotheslineCard> = all
        .into_iter()
        .filter(|c| c.deleted_at.is_none() && c.archived_at.is_some())
        .collect();
    v.sort_by(|a, b| b.archived_at.cmp(&a.archived_at).then_with(|| b.id.cmp(&a.id)));
    Ok(v)
}

/// 取消归档：清 archived_at，**order 不动 → 恢复回原槽位**（PRD「位置不可以改变」）。
#[tauri::command]
pub fn clothesline_unarchive_card(app: tauri::AppHandle, id: String) -> Result<ClotheslineCard, String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let restored = {
        let c = all
            .iter_mut()
            .find(|c| c.id == id && c.deleted_at.is_none() && c.archived_at.is_some())
            .ok_or_else(|| "没有可恢复的归档卡片".to_string())?;
        c.archived_at = None;
        c.updated_at = now_ms();
        c.clone()
    };
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    crate::append_app_log(&format!("[clothesline] 取消归档 {}", restored.kind_to_log()));
    Ok(restored)
}

/// 永久删除：从 cards.json 物理移除，无撤销。弹窗/按钮本身即一次确认。
/// 覆盖两类目标：已归档（archived_at 有值）与刚软删除（deleted_at 有值，10s 撤销
/// 窗口内用户直接选了删除）——绳上「删除」走 clRemoveCard + 本命令两连击。
/// 活跃卡（两者皆空）不允许经此删除，必须走软删除通道。
#[tauri::command]
pub fn clothesline_delete_archived(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let Some(state) = app.try_state::<ClotheslineState>() else {
        return Err("晾衣绳状态未初始化".into());
    };
    let _guard = state.cards_write_lock.lock().unwrap();
    let base = base_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut all = read_all_cards(&base)?;
    let before = all.len();
    all.retain(|c| {
        !(c.id == id && (c.archived_at.is_some() || c.deleted_at.is_some()))
    });
    if all.len() == before {
        return Err("归档卡片不存在".into());
    }
    atomic_write_json(&cards_path(&base), Some(&cards_bak_path(&base)), &all)?;
    let _ = app.emit("clothesline-cards-changed", &active_snapshot(&all));
    crate::append_app_log(&format!("[clothesline] 永久删除归档卡 {id}"));
    Ok(())
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
    // 0.4.81：卡片文件损坏 / 老版本数据不兼容时，绝不能让配置页的三个并行请求
    // 整体 reject（Promise.all → catch 静默 → 永远停在「正在读取晾衣绳设置…」）。
    // 配额只是状态条读数，读失败按 0 处理；数据本身由 restore 路径负责兜底。
    let all = read_all_cards(&base).unwrap_or_default();
    Ok(all
        .iter()
        .filter(|c| c.deleted_at.is_none() && c.archived_at.is_none())
        .count())
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
    fn default_off_0481_forces_off_once_and_remembers_manual_enable() {
        let base = tmp_base("default_off_0481");
        let _ = std::fs::remove_dir_all(&base);
        // 模拟 0.4.80 / 开发版遗留：enabled=true 且没有 0.4.81 迁移标记
        let mut old = ClotheslineSettings::default();
        old.enabled = true;
        old.default_off_v0481 = false;
        save_settings_to(&base, &old).unwrap();

        // 单测并行时全局 Once 可能已被别的用例置位，重置以保证本用例独立可测
        DEFAULT_OFF_0481_DONE.store(false, std::sync::atomic::Ordering::SeqCst);
        let first = load_settings_from(&base);
        assert!(!first.enabled, "0.4.81 首次启动必须默认关闭");
        assert!(first.default_off_v0481, "迁移标记必须写回磁盘");

        // 用户在配置页手动启用（等价于 clothesline_set_enabled(true) 的写盘路径）
        let mut manual = load_settings_from(&base);
        manual.enabled = true;
        save_settings_to(&base, &manual).unwrap();

        let again = load_settings_from(&base);
        assert!(again.enabled, "手动启用后必须被记忆，不能被再次重置");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn settings_roundtrip_and_atomic_write() {
        let base = tmp_base("roundtrip");
        let _ = std::fs::remove_dir_all(&base);
        let mut s = ClotheslineSettings::default();
        assert!(!s.enabled, "总开关必须默认关闭");
        s.enabled = true;
        s.anchor_y = 128;
        s.win_x_ratio = 0.72;
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
        s.win_x_ratio = 4.2;
        s.monitor_stable_id = "x".repeat(500);
        let s = sanitize(s);
        assert_eq!(s.anchor_y, 72);
        assert_eq!(s.pulltab_x_ratio, 0.95);
        assert_eq!(s.win_x_ratio, 1.0);
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
            timer_total_ms: None,
            timer_direction: "countdown".into(),
            timer_elapsed_mode: "wallclock".into(),
            fired_at: None,
            card_color: None,
            card_style: None,
            remind: true,
            font_scale: None,
            title_size: None,
            body_size: None,
            font_family: None,
            title_bold: None,
            title_italic: None,
            body_bold: None,
            body_italic: None,
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
