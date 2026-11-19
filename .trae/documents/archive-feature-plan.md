# 归档功能方案（便利签 / 随手记 / 番茄计时）

## Context

用户需要一个统一归档功能：便利签（桌面便利签 + 晾衣绳便利签卡）、随手记（绳上 text 卡）、番茄计时（绳上 timer 卡）三类内容可归档留存。已确认的交互决策：

1. 桌面便利签 × → **两选弹窗（归档 / 删除）**，不再保留手动折叠（挂绳时自动收起不受影响）
2. 晾衣绳上三类卡 × → **两选弹窗（归档 / 删除）**，其余类型（截图/贴图/图片/待办/录音）保持现有 takeDown 软删+撤销行为
3. 删除 = **直接永久删除**（弹窗本身即一次确认，点删除立即清除，无撤销期；归档页内删除同样即时永久删除）
4. 归档界面 = **主窗内 PageShell 页面**（同「晾衣绳设置页」模式）
5. 恢复 = **回到归档前位置**：便利签桌面+绳上一体还原；随手记/番茄挂回绳上原 order 位
6. 入口：顶栏工具（默认收进「更多」，可排序/启停，支持全局快捷键）+ 晾衣绳 ＋ 菜单

## 一、数据模型

### 1.1 晾衣绳卡片（Rust）
文件：[clothesline.rs](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src-tauri/src/clothesline.rs)

- `ClotheslineCard`（L1091-1177）新增字段 `#[serde(default)] archived_at: Option<i64>`，零迁移（旧 JSON 反序列化自动为 None）
- `parse_cards()`（L1271）过滤条件追加 `&& c.archived_at.is_none()` → 归档卡不出现在绳上，但持久保留在 cards.json
- 正常退出提交软删逻辑（L1425-1429）**不动归档卡**（只 retain deleted_at）

新增 4 个 Tauri 命令（仿 clRemoveCard/clRestoreCard 写法，L1651-1790 一带的保存模式）：

| 命令 | 行为 |
|---|---|
| `cl_archive_card(id)` | 活跃卡置 `archived_at=now`；若 kind==Timer 顺带清 `end_at/remind/fired_at`（停止计时与提醒） |
| `cl_list_archived()` | 返回 `deleted_at.is_none() && archived_at.is_some()` 的卡，按 archived_at 倒序 |
| `cl_unarchive_card(id)` | 清 `archived_at`，**order 不动** → 恢复回原槽位（同 clRestoreCard「位置不可改变」原则） |
| `cl_delete_archived(id)` | 从数组中物理移除（永久删除） |

### 1.2 桌面便利签（前端 store）
文件：[store.ts](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/notes/store.ts)

- `Note` 类型新增 `archivedAt?: number`（L44-77），sanitize（L158 附近）补字段
- 新增 `archiveNote(id)`（置 archivedAt=now，走 commit 广播 storage+notes-changed）与 `unarchiveNote(id)`（清 archivedAt，恢复为 `collapsed:true` 桌面折叠态）
- **所有可见性出口过滤归档**：`getVisibleNotes()`（L372）追加 `&& !n.archivedAt`；启动恢复便利签窗口的逻辑同样以 archivedAt 排除（归档签不开窗）
- `removeNote`（硬删+墓碑）不变，作为「删除」通道

### 1.3 便利签「一体归档」口径
绳上 note 卡是桌面便利签的快照（挂绳时 clMakeCard 拷贝 title/text，note_id 关联）。归档口径：

- **归档绳上便利签卡** → 主窗同时 `archiveNote(note_id)`（note 存在时）+ `cl_archive_card(card.id)`
- **归档桌面便利签** → `archiveNote(id)` + 主窗查找该 note_id 的活跃绳卡并 `cl_archive_card`
- **恢复** → 双向还原（unarchiveNote + cl_unarchive_card）
- 编排方 = 主窗（notes store 单一写方原则）。绳窗只 emit 事件，不直接写 notes。

## 二、关闭交互改造

### 2.1 桌面便利签
文件：[NoteWindow.tsx](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/notes/NoteWindow.tsx)（L146-154 现为 collapseNote）

- × 点击 → 弹窗内小确认条（沿用便签窗内既有浮层样式风格）：标题「关闭便利签」，两按钮 **归档**（主按钮）/ **删除**（红字）+ 取消
- 归档 → emit 事件给主窗（复用 notes bridge 通道）`archiveNote + 关联绳卡归档` → `notes_close_window`
- 删除 → `removeNote(id)` + 关联绳卡 `cl_delete_archived`（若挂绳）→ `notes_close_window`，永久删除无撤销
- 挂绳自动收起路径（useNotesBridge L158-259 `updateNote(collapsed:true)`）**不动**

### 2.2 晾衣绳三类卡
文件：[ClotheslineView.tsx](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/clothesline/ClotheslineView.tsx)

- `takeDown`（L2241）入口分流：kind ∈ {note, text, timer} → 打开确认弹窗（复用 `.cl-modal` 桌面居中样式 + `armModalHit` 命中上报，批2 已有完整机制）：文案「取下「标题」」+ 按钮 归档 / 删除（红字）/ 取消
  - 归档：kind==note → emit `CL_ARCHIVE_CARD {cardId}`（主窗编排一体归档）；kind==text/timer → 直接 `cl_archive_card`；toast「已归档 · 可在归档页查看」
  - 删除：`cl_remove_card` 后追加物理删除（或直接 `cl_delete_archived`），无撤销 toast
- 其余 kind 走原 `takeDown`（软删 + 10s undo toast）不变
- L2114-2121 的两处直接 clRemoveCard 调用同步核对接入分流

### 2.3 跨窗编排事件（bridge.ts）
文件：[bridge.ts](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/clothesline/bridge.ts)

- 新增常量 `CL_ARCHIVE_CARD = 'clothesline-archive-card'`、`CL_OPEN_ARCHIVE = 'clothesline-open-archive'`
- 主窗 useNotesBridge/App 监听 CL_ARCHIVE_CARD：查 note_id → archiveNote → cl_archive_card；note 已删则只归档卡

## 三、归档页（主窗 PageShell · 用户已选「方案三 档案时间线」）

新组件：`src/archive/ArchiveView.tsx` + `src/archive/archive.css`（新文件，主窗内页面非独立窗口）。UI 定稿 = 用户从 3 版 mockup（分区清单/时光纸卡墙/档案时间线）中选定的**方案三「档案时间线」**：

- 打开方式：`const [archiveOpen, setArchiveOpen] = useState(false)`，`<PageShell open={archiveOpen} title="归档" onClose={...}>`（仿 App.tsx L2359 晾衣绳页）
- 数据：打开时并行 `invoke('cl_list_archived')` + notes store 读取 `archivedAt` 便签
- 布局规格（对照已确认 mockup `archive_mock_c_timeline`）：
  1. **头部行**：标题「归档」+ 右侧总数胶囊（brand 色 10% 底，如「12 条」）
  2. **筛选胶囊行**（可换行）：全部 / 便利签 N / 随手记 N / 番茄计时 N；选中态 = ink 底白字（跟随主题），未选中 = 描边胶囊
  3. **时间线主体**：左侧 2px 竖轴（--line 色），左缘距面板 20px；每条目为垂挂节点条目——
     - 节点：14px 圆点，底色 = 类型色（便利签 #e8a912 / 随手记 #3d7be8 / 番茄 #e5484d），3px surface 描边圈 + 1px 外描边，压在竖轴上
     - 条目内容：类型徽标（类型色实底白字 10.5px，4px 圆角）+ 归档时间（11px 灰）→ 标题 14px/700 → 单行摘要 12.5px（超长省略）
     - 条目间 1px 虚线分隔，按归档时间倒序（合并桌面便签 archivedAt 与绳卡 archived_at 取较大者排序）
  4. **悬停操作**：条目 hover 浮出「↺ 恢复 / 删除」按钮组（描边胶囊；删除 hover 变红）——点击删除即永久删除（按钮本身即确认，无二次弹窗）
  5. 底部提示文案：「按类型筛选 · 时间线按归档时间倒序 · 恢复回原位」
- 便利签条目的合并口径：按 note_id 合并「归档桌面便签 + 归档绳卡」为一条（卡片不存在时单显示便签，反之亦然）；徽标统一为「便利签」，时间旁可注明「原挂晾衣绳 / 原在桌面」
- 番茄条目摘要：任务名 + 原时长（如「已计时 15 分钟 · 正计时」）
- 空态文案：「暂无归档内容 · 关闭便利签/随手记/番茄卡时选择归档即可保留在这里」
- 暗色主题：跟随主窗 data-theme，类型色/轴/卡片变量进 archive.css 并做暗色覆盖
- 动效：仅 hover 过渡（≤120ms），条目删除/恢复时列表轻位移，不引入长动画

## 四、功能入口

### 4.1 顶栏工具（默认「更多」+ 排序）
文件：[topbarTools.ts](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/topbarTools.ts)

- `TopbarToolId` 加 `'archive'`；`TOPBAR_TOOLS` 在 clothesline 之后、sync 之前插入 `{ id:'archive', name:'归档', tip:'归档 · 便利签/随手记/番茄', vip:false, gated:false, keyHint:'' }`
- `MIGRATE_IDS`（L88）追加 `'archive'`：老用户已存偏好时自动补进 enabled；因 10 个工具 > 槽位数（≤6），默认排序天然落入「⋯ 更多」，新旧用户默认均不占顶栏槽
- 设置页 `TopbarToolsSheet`（App.tsx L3164-3279）注册表驱动，归档自动出现在排序/启停列表，零额外改动
- `runTopbarTool` 分发（App.tsx L944-1050）：`case 'archive'` → 关其它独立页 + `setArchiveOpen(true) + setIsOpen(true)`

### 4.2 晾衣绳 ＋ 菜单
文件：ClotheslineView.tsx（L3598-3651 add-sheet）

- 「晾衣绳设置」上方加分隔符 + 按钮 `▦ 归档 <em>便利签 · 随手记 · 番茄</em>`：`setAddSheetOpen(false)` → `emit(CL_OPEN_ARCHIVE, {})`
- App.tsx 监听 CL_OPEN_ARCHIVE（仿 L806 CL_OPEN_SETTINGS）：`setIsOpen(true)`（唤起主窗）+ `setArchiveOpen(true)`；不改绳身展开态

### 4.3 全局快捷键
- `sidebarSettings.ts` 新增 `archiveShortcut: string`（默认 `'Alt+A'`，与现有 toggle/note/clipboard 字段同构，sanitize 补默认与类型校验）
- Rust：仿 [notes.rs register_note_shortcut](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src-tauri/src/notes.rs#L260) 新增 `register_archive_shortcut` 命令（global-shortcut 注册，触发后向主窗 emit 打开归档页的事件），lib.rs L1844 invoke_handler 注册
- 前端：`commitArchiveShortcut`（仿 App.tsx L3835 commitNoteShortcut：先 applyShortcut 成功再落设置）；设置页「快捷键」组（L4204-4235）加 `ShortcutField label="打开归档"`，conflictFor 检查与现有三个快捷键冲突
- 顶栏/更多菜单 keyHint 动态覆盖沿用现有 shortcutLabels 机制

## 五、文件清单

| 文件 | 改动 |
|---|---|
| src-tauri/src/clothesline.rs | archived_at 字段、parse 过滤、4 个归档命令 |
| src-tauri/src/notes.rs | register_archive_shortcut |
| src-tauri/src/lib.rs | invoke_handler 注册新命令 |
| src/clothesline/bridge.ts | archived_at 类型、4 个命令封装、CL_ARCHIVE_CARD/CL_OPEN_ARCHIVE 常量 |
| src/clothesline/ClotheslineView.tsx | takeDown 分流+确认弹窗、＋菜单归档项 |
| src/notes/store.ts | archivedAt/archiveNote/unarchiveNote、可见性过滤 |
| src/notes/NoteWindow.tsx | × 两选弹窗 |
| src/notes/useNotesBridge.ts | CL_ARCHIVE_CARD 编排监听 |
| src/topbarTools.ts | archive 工具 + MIGRATE_IDS |
| src/sidebarSettings.ts | archiveShortcut |
| src/App.tsx | archiveOpen 页面挂载、顶栏分发、事件监听、快捷键字段与 commit |
| src/archive/ArchiveView.tsx + archive.css | 新增（归档页） |

## 六、风险点

1. **parse_cards 过滤遗漏**：绳上所有卡查询路径（计数、order 对账、退出提交）必须统一排除 archived，否则归档卡回绳。逐处 grep `deleted_at.is_none()` 核对
2. **timer 归档残留提醒**：归档时必须清 end_at/remind/fired_at，否则恢复后可能触发历史闹钟
3. **notes 双写**：归档编排只在主窗执行（单一写方），绳窗/便签窗只 emit
4. **老用户入口可达**：MIGRATE_IDS 必须含 archive，否则已存偏好的用户既不在顶栏也不在更多
5. **确认弹窗命中矩形**：绳上弹窗期间需 armModalHit 上报自身矩形（批2 教训：空命中表 8 秒后被 dismiss 关弹窗）
6. **交付铁律**：用户直启打包 exe（内嵌 dist 资产）——改动完成后必须 `npm run build` + `npx tauri build --debug --no-bundle` 重编 exe 才对用户生效；dev 会话运行期间 exe 被锁需先关闭

## 七、验证

1. `npx tsc --noEmit`（vite 不查类型，必须实际跑并核对退出码）
2. `npm run build` + `npx tauri build --debug --no-bundle`
3. 功能回归（按用户惯例先测非关键数据）：
   - 桌面便利签 × → 弹窗归档/删除两路 + 挂绳自动收起不受影响
   - 绳上便利签/随手记/番茄 × → 弹窗；归档后绳上消失、cards.json 中 archived_at 落盘、重启不回绳
   - 归档页三类分区显示正确；恢复 → 便利签桌面+绳还原、随手记/番茄回原位；删除 → 永久消失（重启验证）
   - 计时中的番茄归档 → 提醒不再触发
   - 顶栏更多菜单出现「归档」、设置页可排序/启停、Alt+A 全局唤起、绳＋菜单入口
   - 其余类型（截图/贴图/图片/待办/录音）× 行为不变（软删+撤销）
