# Changelog

## 0.4.47 - 便利签（桌面便签）功能上线

### Added

- 新增「便利签」功能（会员专属）：快捷键一键创建桌面便签，最多同时显示 12 张、总计 50 张上限。
- 便签条目支持勾选划线（已完成）、增删改、一键「转待办」（转为今日待办）。
- 便签支持 6 色换肤 + 透明度滑条自定义：点调色板图标弹出面板，滑动调节不透明度（最低 35%）。
- 便签可钉住（置顶）、可自由拖动摆放、窗口大小可调整。
- 启动恢复：未删除的便签在关机/重启后按上次位置自动重新贴回桌面（多屏回到原屏）。
- 删除即撕：点 × 彻底删除该便签，数据不保留、误关不可恢复；删除写「墓碑」双写（localStorage + 磁盘），杜绝重启后已删便签复活。
- 设置页提供「新建便利签快捷键」配置入口（默认 Alt+N）。

### Changed

- 便利签为会员专属能力：非会员不可新建；会员过期后已有便签仍可编辑，仅禁止新建。

## 0.4.46 - 法定节假日数据可远程自动更新（免发版）

### Added

- 法定节假日数据改为「远程拉取 + 本地兜底」：App 启动自动从下载站获取最新 `holidays.json`（内置 2024–2026 做离线兜底）。2027 年及以后国务院放假安排公布后，仅需更新服务器上的 JSON 并刷新下载站，已安装的旧版用户下次启动自动吃到新数据，**无需再次发版**。
- 新增 `scripts/fetch-holidays.mjs`：输入 gov.cn 放假安排通知 URL 即可自动解析 7 项假期并生成/合并 `holidays.json`。

### Changed

- 「跳过法定节假日」开关功能不变，数据来源改为远程优先；离线或网络异常时回退至内置/缓存，不影响主流程。

## 0.4.45 - 截图去全屏 + 法定节假日跳过

### Changed

- 截图顶部操作栏去掉「全屏」选项：全屏与「窗口」截出来完全一致，属于冗余入口，现已移除。
- 截图选区蓝色边框线加粗（线宽 2→4）：窗口/区域/已确认三态统一加粗，选区更醒目，一眼就知道正在截图。

### Added

- 添加事项弹窗新增「跳过法定节假日」开关：勾选后，重复事项在法定节假日当天不生成（标签自动追加「节假日除外」）。内置 2024–2026 年国务院官方法定节假日数据，2027 年安排公布后仅需在 `src/holidays.ts` 追加日期即可生效。

## 0.4.44 - 启动无残影、无启动框

### Fixed

- 修复桌面启动时主窗口以默认位置（177,177）白色不透明闪现的「工具残影」：主窗口改为 `visible:false` 起步，显示权交给前端——前端完成定位并双 rAF 首帧绘制后才调用 `show_main_window_ready`，Rust 仅保留 15 秒看门狗兜底。
- 修复启动期弹出的无标题栏控制台窗口（「程序启动框」）：数据目录 junction 自愈的 `cmd /c mklink/rmdir` 加上 `CREATE_NO_WINDOW`(0x08000000)，不再弹出可见控制台。
- 计薪组件窗口同步采用 `visible:false` 起步 + 前端就位后显示，避免组件窗口闪现。

## 0.2.12 - 万年历筛选栏宽度优化

### Fixed

- 修复万年历页「回到今天」按钮在窄窗口下被右侧裁切：收窄左右翻页箭头（24→20px）、下拉框内边距与字号、筛选栏间距（8→5px）以及按钮内边距，使整栏在窗口内完整显示。

## 0.2.11 - 万年历筛选栏视觉微调

### Changed

- 万年历页顶部年月筛选一栏去掉白色背景条（含毛玻璃与下边线），与页面融为一体。
- 年/月两个筛选框背景色改为淡灰色（扁平无边框）。
- 「回到今天」按钮尺寸与文字进一步缩小（高 26→22px，字号 11.5→10.5px）。

## 0.2.10 - 万年历页面 UI 重设计

### Changed

- 万年历（黄历）页面视觉重做，功能与农历/节气/宜忌数据完全不变：
  - 日历面板恢复经典干净网格：去掉每个日期的描边小卡片，改为整体一张卡片，日期格仅悬停浅灰底，无边框。
  - 选中日期改为蓝底白字圆角块（带柔和投影）；今天标记改为蓝描边 + 浅蓝底（此前为琥珀橙）。
  - 休/班角标缩小并贴角，不再挤压日期内容。
  - 「回到今天」按钮字号 12→11.5px、高度 28→26px，并锁定单行显示。
  - 详情区标题条改为蓝底蓝字，宜忌卡与信息表加轻阴影，风格与日历面板统一。

## 0.2.9 - 修复「更改存储位置」无法持久化

### Fixed

- 修复在设置页「更改存储位置」后，退出再返回设置页又显示回默认位置的严重缺陷。根因：`set_data_dir` 返回的数据库连接键已带 `sqlite:` 前缀，而前端 `connectionPath()` 会再拼一次，形成 `sqlite:sqlite:...` 导致加载失败，进而触发兜底逻辑把自定义位置指针抹掉并回退默认库。现已让 Rust 返回值与启动恢复一致（不带前缀），并给 `connectionPath()` 加防御性去重；同时取消「加载失败时抹除自定义位置指针」的破坏性逻辑，改为保留指针仅告警回退。
- 设置页「同步」分组标题去掉 `(Cloudflare)` 文案；启动时一次性清理 WebView 旧缓存（旧前端资源被 WebView2 缓存导致更新后界面仍显示旧文案的根治）。
- 「恢复云端数据」与云端补齐一律过滤云端已删除（软删除墓碑）数据——已删除的事项不会再被"恢复"回来。
- 重新登录或在新设备登录后，自动从云端补齐缺失数据（只增不删：本地已有的按 ID 跳过，本地多出的保留，云端已删除的不复活）。
- 登录令牌失效（云端 401：改密码/设备被解绑/会话过期）时自动清除僵尸登录态：账号区立即回到未登录样式，同步明确提示重新登录，不再出现"显示已登录但同步一直失败"的割裂。
- 修复退出登录后重启应用登录态"复活"的问题（持久化配置此前无法显式清除账号字段）。

## 0.2.8 - 修复更新后丢失数据与登录态

### Fixed

- 修复更新应用后「存储位置被重置、页面变空」的问题：根因是存储位置指针与登录态仅存于 WebView 的 localStorage，更新会被清掉。现已改由 Rust 写入用户主目录 `~/.ticktask/config.json` 持久化，跨更新存活；启动时自动重建目录链接（junction），存储位置自愈。
- 修复「恢复云端数据」点击后无反馈的问题：登录态现在跨更新保留，未登录时明确提示先登录；恢复成功后用 toast 精确反馈恢复/跳过/移除条数。
- 新增「查找本地数据」入口：扫描常见位置找回误丢失的本地数据库目录，一键恢复。

## 0.2.7 - 恢复云端数据与万年历改版

### Added

- 待办设置页新增「恢复云端数据」按钮（与「立即同步」同行显示）：支持用云端覆盖本地，或在现有基础上补充。
- 补充模式按事项 ID 去重：本地已存在的事项直接跳过，绝不产生重复两条；覆盖模式会移除本地独有事项，但云端数据始终保留。
- 万年历页面 UI 重设计（功能不变）：统一为现代极简风格，工具栏毛玻璃、月历网格圆角卡片、配色更柔和，消除原高饱和刺眼色块。

### Verified

- `tsc -b` 类型检查通过，`npm run build` 前端构建通过。
- `v0.2.7` Windows 安装包已构建并发布，版本记录同步至同步后端与管理后台。

## 0.1.5 - Native Shortcut Fix

### Fixed

- Moved the toggle shortcut registration from the focused React webview into the
  native Tauri layer, so `Ctrl/Cmd + Shift + T` can open Todobar from another
  app without clicking the sidebar first.

### Added

- Added `Ctrl/Cmd + Alt + T` as a fallback global toggle shortcut when the
  default shortcut is taken by another app.
- Extended project verification so native shortcut registration remains covered.

### Verified

- `v0.1.5` artifacts were published for Windows, macOS Apple Silicon, and
  macOS Intel, with release digests recorded in the verification notes.

## 0.1.4 - Desktop Control and Product Vision

### Added

- Native tray/menu-bar control for opening Todobar, opening settings, and
  quitting the app while the sidebar stays out of the taskbar.
- Product vision documentation covering Version 0, planner upgrades,
  notifications, AI assistant direction, MCP/Gmail/context connectors, and the
  future companion manager surface.

### Verified

- `v0.1.4` artifacts were published for Windows, macOS Apple Silicon, and
  macOS Intel, with release digests recorded in the verification notes.

## 0.1.3 - Responsive Edge Polish

### Fixed

- Fixed a 2px handle clipping issue in narrow open-sidebar browser preview
  layouts.

### Added

- Responsive Playwright checks for desktop, narrow, and short viewports.
- Release verification documentation for the responsive edge-polish release.

### Verified

- Browser smoke tests now cover the task flow plus responsive sidebar bounds.
- `v0.1.3` artifacts were published for Windows, macOS Apple Silicon, and
  macOS Intel, with release digests recorded in the verification notes.

## 0.1.2 - Reliability and Open Source Polish

### Added

- Completed-task visibility setting so finished tasks can be hidden without
  deleting them.
- Playwright smoke test for the sidebar, settings drawer, and completed-task
  visibility flow.
- No-bundle native Tauri build smoke test for Windows and macOS CI.
- Release verification documentation for the stable release.

### Changed

- Updated GitHub Actions workflow dependencies.
- Made install instructions version-agnostic to avoid stale release filenames.
- Linked release gaps to public GitHub Issues.
- Expanded project verification to guard scripts, docs links, release versions,
  and workflow expectations.

### Verified

- CI runs project verification, TypeScript/Vite build, ESLint, Playwright smoke
  tests, Rust check, and native Tauri build smoke on Windows and macOS.
- `v0.1.2` release artifacts were published for Windows, macOS Apple Silicon,
  and macOS Intel.

## 0.1.1

- Added launch-at-login control in settings.
- Added task row height, row gap, and text size customization.
- Improved narrow viewport task action spacing.
- Clarified Windows and macOS installation docs.
- Added platform support documentation.
- Added GitHub issue and pull request templates.

## 0.1.0

- Added native right-edge sidebar shell.
- Added draggable open/close handle.
- Added global shortcut support.
- Added autostart on login.
- Added single-instance desktop behavior.
- Added Today, Month Plan, and custom lists.
- Added add, complete, priority, collapse, and delete actions.
- Added light and dark themes.
- Added local persistence for prototype task data.
- Added Windows and macOS release workflows.
