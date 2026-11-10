# Changelog

## 0.4.63 - 优化体验

### 发布摘要（对外版本记录）

1. 周待办/月待办每个日期上新增添加按钮，支持选择任一日期添加待办事项。

### Added

- 周待办 / 月待办每个日期分组栏右侧新增「+」幽灵按钮：点击直接打开添加事项弹窗，弹窗显示目标日期（`M月D日 周X`），保存后事项归入该日期；跨周 / 跨月翻页按日期栏所在年份写入。月视图「未安排日期」为虚拟分组，不显示该按钮。
- 底部 FAB 与日待办行为不变：新增 `addSheetDateKey` 为空时仍走原有默认日期逻辑，弹窗关闭 / FAB 打开时清除目标日期，避免串日期。

### Changed

- 「升级永久会员」弹窗权益区由米黄卡片 + 六行长句改为三列功能对比列表（功能 / 普通用户 / 永久会员，共 9 行）：会员列绿色纯文字 + 绿勾、无背景色，普通列灰字 + 灰叉；截图贴图 / 剪贴板 / 便利签 / 录音各自独立成行，「待办云端同步」更名「云端同步」。
- 价格副标题改为「永久买断 · 持续迭代」，并从价格右侧移到价格正下方居中；表尾保留「更多会员权益持续更新中…」注脚，暗色主题下绿色自动切换为更高亮度。
- 对比数值全部沿用现有权限判定：普通用户每日 3 条主任务，子任务 / 提醒 / 生日纪念日新增 / 计薪器桌面组件 / 桌面套件 / 云同步均由 `fullAccess` 闸门控制。

### Fixed

- 混合 DPI 冷启动（主屏 1.5x、副屏 1.0x）时窗口宽高被整体缩小 1.5 倍，导致面板右侧裁切、收起后把手消失：首次布局与切屏迁移统一走 `applyBounds()` 隔帧连写 3 次窗口矩形；首次布局即使中途被取消也仍显示主窗，避免 `visible:false` 卡黑屏。

## 0.4.62 - 新增窗口位置调整+顶栏快捷入口

### 发布摘要（对外版本记录）

1. 新增窗口位置配置：多屏使用时，允许用户自行选择工具窗口要显示在主屏还是副屏，且贴边方向支持选择要显示在屏幕右侧还是屏幕左侧。
2. 顶部导航栏新增截图/新建便利签/剪贴板三个功能入口，且支持在设置页面中调整顶栏快捷入口的顺序及是否显示。

### Added

- 首页新增「发现新版本」提示弹窗：应用启动后自动检查更新，仅在侧栏展开时展示；每个版本最多弹一次。
  弹窗内容读取后台版本记录（`/api/releases`）中该版本的标题与更新项，支持关闭与「立即更新」（应用内下载并覆盖安装）。
- 跨版本升级时弹窗以最新版更新项为主，并提示「期间还发布了 N 个版本」，可在弹窗内展开完整版本记录。
- 首页顶栏新增「截图 / 便利签 / 剪贴板」固定入口，不再只能靠全局快捷键触发；会员工具点击时沿用未登录引导 / 会员提示分流。
- 顶栏改为按面板宽度动态分配槽位（300 / 340 / 500px 对应 5 / 4 / 6 槽），装不下的工具自动收进「⋯ 更多」菜单，菜单内可直接点击并显示当前快捷键。
- 设置页新增「顶栏快捷入口」配置：入口行显示顶栏 / 更多 / 隐藏数量，点击打开底部弹窗，弹窗内勾选显示、上移 / 下移排序、恢复默认并实时标注每个工具落在「顶栏」「更多」还是「隐藏」；「⋯ 更多」菜单底部可一键直达该弹窗。
- 设置页新增「窗口位置」分组：多屏时可选择工具面板显示在主屏 / 副屏 / 指定显示器（单屏时该行禁用而非隐藏），并可自由切换贴桌面左侧或右侧；切换立即生效，指定屏拔掉后自动回退主屏并提示。
- 新建便利签跟随工具面板所在屏幕，默认落在「面板之外的可用区」居中，不再固定落到主屏。
- 便利签低延迟（L2）：启动后预建 1 个隐藏便利签窗口，按 `Alt+N` / 点顶栏新建时直接领取并写入数据，省掉每次重建 WebView2 的等待；池窗只做「预建 + show/hide」，不做 warmup / park。
- 展开 / 收起新增按停靠边方向的滑动动画：右贴「展开向左 / 收起向右」，左贴「展开向右 / 收起向左」；原生窗口尺寸恒定，视觉过渡由内容层的 CSS `transform` 平移承担（`cubic-bezier(0.22, 1, 0.36, 1)`，时长沿用「动画时长」设置），零 IPC、零重排。
- 设置页「顶栏快捷入口」收进底部弹窗，8 行配置不再平铺占页面；弹窗内用草稿编辑，点「保存」才写回配置，取消 / 点遮罩 / Esc 一律丢弃。

### Changed

- 版本检查从「仅进入设置页才触发」上移到应用启动，设置页与首页弹窗共用同一份更新状态；
  法定节假日远程拉取也一并上移到启动阶段。
- 顶栏入口偏好纳入侧栏设置（沿用 v19 存储键，新字段由 sanitize 自动补齐，不重置主题 / 宽度 / 快捷键）；旧设置由磁盘 `prefs.json` 自动回灌，不会丢失。
- 「⋯ 更多」菜单与配置行使用主题变量，暗色主题下跟随深色，不再出现白卡片。
- 设置页「顶栏快捷入口」配置行 / 弹窗不再显示会员标签，副标题简化为「可调整顶部栏工具顺序」。
- 顶栏「剪贴板」入口改为只打开、不做 toggle 收起；调用失败时给出可见提示，不再静默失败。
- 主窗与便利签新建统一由 `src/dock.ts` 解析「目标屏幕 + 停靠边」，几何计算全部改用物理像素；便利签坐标附带 `scaleFactor` 基准，旧数据无该字段时按窗口当前屏缩放推断，保持原恢复行为。
- 左侧停靠时整窗视觉镜像（把手锚点、面板圆角 / 阴影 / 内边距、贴边 SVG 形状），独立页面滑入滑出与居中弹层入场方向同步镜像，点击穿透判定同步翻转。
- 便利签被手动拖到别的屏后仍按原位置恢复，不强制拉回面板屏；截图 / 剪贴板 / 便利签召回保持各自原有定屏逻辑（光标所在屏 / 原坐标）。
- 设置页把「打开窗口 / 新建便利签 / 打开剪贴板」三个快捷键合并为「快捷键」分组，移到页面底部、紧挨「截图 / 贴图」上方；「窗口」分组只保留宽度相关设置。
- 「贴边方向」分段控件顺序对调为「桌面左侧 → 桌面右侧」；「显示屏幕」下线容易误读的「默认 · 跟随窗口所在屏」及其说明，默认选中主屏，用户上次的选择会被持久化；提示文案简化为「切换后立即生效，无需重启。」
- 主窗改为**恒定使用完整展开矩形**（不再收起时缩窄窗口、也不再整窗平移出屏幕），展开 / 收起只由内容层 `.dock-layer` 的 CSS `transform` 平移完成：右贴收起向右、展开向左，左贴镜像；移出窗口的部分由视口裁掉，窗口任何一帧都完整落在目标屏内。贴边 SVG 沿用自身固定尺寸。切屏 / 换停靠边 / 改宽度属于几何迁移，临时禁用过渡做无动画快照，避免内容横穿窗口。
- 展开 / 收起走「零 RPC 快路径」：布局输入签名未变时不再发任何显示器查询 / 窗口尺寸 / 位置 / 焦点命令，动画完全交给合成器；点击穿透轮询在展开态与动画期间也跳过三次坐标查询。
- 「自动同步」开关改为按账号状态收敛：未登录 / 试用结束且未激活会员时一律显示为关并停掉定时同步（即使试用期内原本是打开的），成为会员后按用户原有偏好自动启用；底层偏好不改写为 `false`，用户主动关闭过的选择仍保留。试用期在应用常驻期间自然到期（没有账号刷新事件）时，界面与引擎也会自动收敛到关闭。
- 「升级永久会员」弹窗的权益改为 6 条具体能力明细（待办不限量 / 子任务 / 提醒、生日纪念日不限量、牛马计薪器组件、录音与截图贴图便利签剪贴板、待办云端同步）加「更多会员权益...」收尾，替换原先「全功能解锁 / 一次买断 / 持续更新 / 不限设备」等笼统卖点（买断与更新已由价格区、顶部横幅表达）。权益变长后价格 / 权益 / 激活步骤只在内容区滚动，「立即购买」始终吸底可见；长条目换行时勾与首行对齐，收尾提示做淡化区分。

### Fixed

- 未登录用户点击受限功能时改为弹「去登录」引导弹窗（此前误提示「会员功能」）；已登录但会员过期仍维持会员提示。
- 补录后台版本记录 0.4.59 / 0.4.60 / 0.4.61，修复版本记录滞后导致更新弹窗缺内容的问题。
- 修复剪贴板历史窗口「快捷键 / 托盘 / 顶栏都打不开」：混合 DPI 双屏（主屏 1.5x、副屏 1.0x）下把物理坐标除以缩放后当成逻辑坐标，又被系统按主屏放大一次，窗口被放到所有屏幕之外（实测 x=4329，屏幕最右仅 4080）。现全程使用物理坐标定位并夹取到目标显示器可视区内，且每次唤起都重新定位，切换屏幕 / 分辨率后不再停留在旧坐标。
- 修复剪贴板浮窗刚显示就被紧随的失焦事件立刻收起的问题（贴边主窗口抢焦点），并为开窗路径补充运行日志。
- 修复混合 DPI 多屏下新建便利签固定落在主屏：原 `pickFreeSpot()` 写死 `monitors[0]`，且把显示器物理坐标除以缩放当成逻辑坐标；越界自愈同样按错误口径判断，会把副屏上的便利签「自愈」回主屏。
- 修复新建便利签 / 快捷键唤起有 1–2 秒延迟（冷启动实测约 4.1s）：主因是每次新建与召回都重建一个 WebView2 窗口，现由预建池窗承担首次唤起。
- 修复切换到「桌面左侧」后窗口跨主屏 / 副屏且点击完全无响应（卡死）：旧收起态把整窗推到目标屏左边界之外（实测物理 `1806..2200`，主屏右缘 2160），混合 DPI 下 Windows 按主屏 1.5x 重新缩放 WebView，面板被裁切，且 `outerPosition` 与 `cursorPosition` 口径不一致导致点击穿透被误判为常开并锁死（实测窗口 `WS_EX_TRANSPARENT=1`）。现窗口在展开 / 收起两种状态都完整落在目标屏内，Rust 启动兜底同步改为屏内定位；穿透判定在展开态一律不穿透、收起态使用实测窗口尺寸并对坐标口径异常做兜底，且每轮无条件重发状态，任何竞态最多 48ms 自愈。
- 修复主屏为高 DPI 小屏时点击把手「闪烁展开」：窗口尺寸与位置原本由两次独立 IPC 写入，中间会插进一帧重绘；现改由 Rust 侧 `set_main_window_bounds` 在同一命令内原子写完，并把原生布局固定为「把手 + 面板」宽度（不再用 `100vw` 逐帧重排）。
- 修复展开 / 收起「不丝滑、感觉卡顿」：旧实现逐帧从 JS 调 Rust 改原生窗口尺寸，每帧一次 IPC + WebView2 重排重绘，叠加 48ms 点击穿透轮询抢主线程，帧间隔忽长忽短。现改为窗口恒定全宽 + CSS 合成器 transform 平移，普通开关零 RPC，动画期间不再查询光标 / 窗口坐标；切屏与几何迁移仍保留原子写入与三次校正。
- 修正未登录引导弹窗文案：原文「登录后即可使用 XX 功能，并解锁全部会员能力」错误地把登录等同于会员（实际还要看账号是否在试用期 / 已激活），现标题简化为「登录」、正文为「登录后可解锁更多功能的使用，支持数据同步云端」，不再点名具体功能、不承诺具体会员能力。
- 修复关闭「自动同步」时启动阶段仍调用 `startAuto(0)` 的问题：`SyncEngine` 内部 `Math.max(5, intervalSec)` 会把 0 解释成「每 5 秒同步一次」，关掉开关反而同步得更频繁。现关闭即彻底不启动定时器，且设置页开关、自动间隔显隐与定时同步引擎共用 `effectiveAutoSync` 同一生效值。
- 修复「显示屏幕」每次打开都要重新选择：磁盘 `prefs.json` 是异步写入，旧回灌逻辑用 `{...current, ...disk}` 让落后的磁盘值盖掉用户刚选的屏幕 / 主题 / 宽度。现明确优先级 localStorage > 磁盘 > 默认值，仅在缓存真的丢失（清缓存 / 重装）时由磁盘接管；旧版本落盘的 `auto` 一律归一到主屏。
- 修复「桌面左侧」时把手旁边出现一条贯穿整屏的竖向阴影：左贴预览态镜像规则的 `box-shadow` 特异性与 `.workspace.is-native` 相同但位置更靠后，把原生模式的 `box-shadow: none` 盖掉了（右贴没有对应镜像规则所以不受影响）。现为原生左贴的把手与面板显式复位阴影。
- 修复从主屏（小屏）切到副屏（大屏）后窗口仍是主屏尺寸、必须收起再展开才恢复：Windows 在窗口跨到不同 DPI 显示器时会按「逻辑尺寸」重新缩放，第一次尺寸写入会被吃掉。现切屏先把窗口定位到目标屏，再隔帧连续三次按目标屏物理像素写入目标矩形，切完即正确。

## 0.4.61 - 截图识别长文案修复

### Fixed

- 修复框选识别超过约 18 个字的长文案时结果错乱、无法识别的问题（识别检测对超宽扁条选区放大不足导致文字检测碎裂，现按高度补足放大，长短选区识别质量一致）。

## 0.4.59 - 会员购买入口

### Added

- 设置页新增会员购买入口：账户卡片上方滚动横幅（非会员/试用中/未登录可见），点击弹出底部购买弹窗。
- 兑换按钮右侧新增「购买激活码」按钮（已登录非会员/试用中可见），与横幅共用同一购买弹窗。
- 购买弹窗展示会员价格（￥29.9 永久买断）、会员权益与激活操作步骤；「立即购买」直接在系统浏览器打开链动小铺商品页（URL 白名单限定，其余链接不可通过该通道打开）。

### Fixed

- 修复购买弹窗与修改密码/设备/退出登录弹窗宽度异常伸入窗口边缘把手区的问题，弹窗宽度与添加事项弹窗对齐；购买弹窗右上角补充关闭按钮。

## 0.4.58 - 贴图文字划选复制修复

### Fixed

- 修复贴图偶发完全不显示的问题：贴图窗口前端异常时自动逐级自救（重发事件 → 重载窗口），不再需要重启应用。
- 修复贴图上无法划选复制文字的问题（样式表加载链断裂，多次修复失败的历史问题就此了结）。
- 修复圈选贴图整行后复制内容缺字的问题（识别结果缓存键随识别管线版本化，杜绝旧缓存串结果）。

### Changed

- 贴图文字识别全链路日志留痕（含每行识别文本），识别完成前显示「正在识别文字…」提示；同一张图再钉时秒出文字层（识别结果缓存）。

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
