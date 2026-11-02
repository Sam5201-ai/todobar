# 贴图文字直接可选中复制（PixPin 式文字层）— 规格说明

日期：2026-10-30 ｜ 状态：已批准并实施

## 1. 背景与根因

用户反馈「贴图当前依然不能复制文案」。经全链路静态排查，现有「OCR 结果浮层内自由选字」实现
（事件、CSS user-select、WebView2 加速键/右键菜单、复制命令）**均无缺陷**。

真正根因是**交互预期偏差**：用户以 PixPin 为标杆，期望贴图后**直接在贴图图片上拖选文字复制**
（PixPin 贴图时后台自动 OCR，文字以透明文本层叠加在图片 bbox 位置）；当前实现却要求
「右键 → 识别文字 → 框选 → 等待 → 结果浮层内选字」，操作路径完全不同。

## 2. 目标行为（PixPin 式）

1. 贴图显示后，**后台自动整图 OCR**，完成后文字行叠加在图片对应位置，直接可拖选。
2. 选中文字后 `Ctrl+C` 或右键（WebView2 原生菜单）即可复制。
3. 鼠标按在文字 bbox 上 = 选字；按在 bbox 之外 = 拖动贴图（与 PixPin 一致）。
4. 识别完成前 / 识别失败时，行为与现状完全一致（可拖动、右键菜单手动识别可用），**静默降级**。
5. 右键菜单「识别文字(框选)」的识别结果**直接合并进贴图文字层**（v2 变更，见变更记录）。

## 3. 技术方案

### 3.1 自动整图识别（PinWindow.tsx）

- `init()` 装载成功、`win.show()` 之后触发 `autoOcrWholeImage()`：
  - 复用 `runOcr` 的画布管线，但区域为整图（sx=0, sy=0, sw=naturalWidth, sh=naturalHeight）。
  - 走独立代际号（复用 `ocrRunRef`，池窗复用换图 / 关闭 / `resetOcr` 时 +1 丢弃悬挂结果）。
  - 结果存新 state `pinLines: OcrLine[]`（含 bbox，原图物理像素）。
  - 大图守卫：`recognizeRegion` 抛 `OCR_REGION_TOO_LARGE`（≈4K 钉图）→ **静默跳过**，不弹提示。
  - 其它失败 → 静默跳过（`catch` 置空）。识别中不显示任何 UI，不打扰。
  - `locked` / `penetrated` 状态照常识别（穿透时窗口收不到鼠标，天然不可选；锁定不影响选字，
    文字层不触发 `onImageMouseDown`，与拖拽/双击关闭零冲突）。

### 3.2 透明文字层（PinWindow.tsx + ocr.css）

- 渲染：`pinLines` 非空且 `ocr.phase === 'idle'`（结果浮层打开时隐藏文字层，避免视觉重叠）时，
  在 `<img>` 之后插入：
  ```tsx
  <div className="pin-text-layer">
    {pinLines.map((l, i) => (
      <span key={i} className="pin-text-line" style={{
        left:   `${(l.bbox.x / img.naturalWidth) * 100}%`,
        top:    `${(l.bbox.y / img.naturalHeight) * 100}%`,
        width:  `${(l.bbox.w / img.naturalWidth) * 100}%`,
        height: `${(l.bbox.h / img.naturalHeight) * 100}%`,
      }}>{l.text}</span>
    ))}
  </div>
  ```
- 定位用**百分比**映射 `naturalWidth/naturalHeight`：滚轮/角柄缩放窗口后自动跟随
  （`img` 为 `object-fit: fill` 铺满，比例映射恒精确），无需监听 resize。
- 事件策略：`.pin-text-layer { pointer-events: none }`，`.pin-text-line { pointer-events: auto }`
  → 文字 bbox 上选字、bbox 外仍拖动贴图。
  - span 上 mousedown 不会设置 `pressRef`（`onImageMouseDown` 只在 img 上）→ 不触发拖拽，
    不会误触双击关闭（`lastClickRef` 不更新，符合预期：文字上双击 = 选词）。
  - mousedown 冒泡到 pin-root 仅用于关闭右键菜单，无害。
- 层级：`z-index: 4`（图片 auto < 文字层 4 < 边框 ::after 8 < 缩放把手 9 < 工具栏 10 < 结果浮层 20）。

### 3.3 样式（ocr.css 追加）

```css
.pin-text-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.pin-text-line {
  position: absolute;
  pointer-events: auto;
  user-select: text;
  cursor: text;
  color: transparent;          /* 平时不可见,只提供选择热区 */
  overflow: hidden;
  white-space: pre;
}
.pin-text-line::selection {
  background: rgba(53, 115, 240, 0.45);
  color: rgba(255, 255, 255, 0.85);  /* 选中时半透明白字,PixPin 同款观感 */
}
```

- 字号不设：`color: transparent` 下字形无关紧要，bbox 矩形即选择热区；
  选中高亮块覆盖 bbox 区域，观感与 PixPin 一致。

## 4. 不改动清单（v2 修订）

- Rust 侧：零改动（复用 `ocr_save_input` / `ocr_recognize`）。
- 截图覆盖层流程（CaptureOverlay + OcrResultPanel 浮层）：v4 前零改动；v4 仅在 CaptureOverlay
  的 Ctrl+C 分支加选区门控（见变更记录），OcrResultPanel 浮层本身零改动。
- 贴图窗口：v2 起移除结果浮层依赖，OcrResultPanel 不再被 PinWindow 引用。

## 5. 决策点（已按最优取值，可否决）

| # | 决策 | 取值 | 理由 |
|---|---|---|---|
| D1 | 自动 OCR 时机 | 贴图显示后自动后台跑 | PixPin 同款；异步不阻塞显示；首次 ~830ms / 后续 ~93ms 可接受 |
| D2 | 大图超限处理 | 静默跳过 | 自动场景弹提示是打扰；手动框选路径保留可用 |
| D3 | 手动框选结果是否合并进文字层 | **合并**（v2 反转） | 用户实测反馈浮层体验差；PixPin 全程无浮层 |
| D4 | 选中文字可见性 | **透明字形 + 蓝块**（v2 修订） | 图片文字从半透明块下透出即所见所选；白字会浮现与图片不符的"识别小字" |

## 6. 风险点

1. **行 bbox 覆盖区拖不动贴图**：按在文字上 = 选字（PixPin 同款行为）；按 bbox 间空隙 / 无文字区仍可拖。
2. **`::selection` 在 WebView2 透明窗口的渲染**：已用半透明白字兜底（D4）；若仍有异常，回退方案为
   选中时改用固定高亮 span，但预计不需要。
3. **悬挂识别结果**：池窗复用换图、关闭、销毁均已由 `ocrRunRef` 代际号机制丢弃，无串图风险。
4. **pinLines 含 bbox 为 undefined 的行**：渲染时 `l.bbox &&` 守卫跳过（防御既有类型即可，不加新校验）。

## 7. 验证步骤

1. `npx tsc --noEmit` + `npx eslint src/screenshot` 通过（Rust 无改动无需 cargo check）。
2. 用户实测验收（v2 修订）：
   - 贴图后 ~1s 内直接在文字上拖选 → 半透明蓝块盖在图片文字上（无浮字）→ Ctrl+C 粘贴验证；
   - 右键选中文字 → 原生菜单「复制」；
   - 按在无文字区域拖动贴图正常、滚轮缩放后文字层位置与高亮仍精确对齐；
   - 右键菜单「识别文字(框选)」→ 识别后文字直接出现在贴图对应位置（无浮层）；
   - 右键菜单「复制文字」「全部转为待办」可用（无识别结果时置灰）。

## 8. 变更记录

### v2（2026-10-30，用户实测反馈后二次迭代）

实测问题：拖选时贴图上浮现一行 16px 的「识别文案」小字（文字层 span 默认字号与图片文字
不等大），观感是"单独一层显示识别出的文案"；右键「识别文字」框选后仍弹结果浮层，与
PixPin「全程在贴图上操作」不符。

1. **选中观感对齐 PixPin**：文字层字号改用内联 `fontSize: <行高>vh`（视口即贴图显示区，
   字形盒与图片文字等大且重合，浏览器原生随窗口缩放）；`::selection` 字形改 `transparent`，
   选中只显示半透明蓝块，图片文字从块下透出 → 不再浮现"识别小字"。
2. **贴图窗口去浮层**：移除 PinWindow 对 OcrResultPanel 的引用与 ocr 结果态（phase/lines/
   busy）；右键「识别文字(框选)」结果按 bbox 平移合并进文字层（与框选区域相交的旧行被
   新行替换），兼作自动识别失败/超限时的补救入口。
3. **右键菜单补齐入口**（替代原浮层按钮）：新增「复制文字」「全部转为待办」（无识别结果
   时置灰）；菜单防出屏 clamp 160→210。
4. 实现说明：`runOcr` 合并逻辑在 `setPinText` updater 内完成（相交判定用原图物理像素，
   新行坐标 = bbox + 区域起点，再折算百分比）；代际号沿用 `ocrRunRef`（手动识别 `++`
   使在途自动识别结果作废，手动优先）。

### v3（2026-10-30，用户实测反馈三次迭代）

实测问题：圈选范围与复制内容不一致——圈了半行，粘贴出比圈选更长的文字。

根因：文字层是 HTML span，字符按字体规则排布（数字窄/中文宽），字号仅匹配行高，
**字形串宽度 ≠ OCR bbox 宽度**，字符位置与图片文字横向错位；拖选端点按字形位置反查
字符，错位导致反查到的字符范围比圈选的图片范围宽。

修复：文字层由 HTML span 改为 **SVG `<text>`**：
1. `viewBox = 0 0 naturalWidth naturalHeight` + `preserveAspectRatio="none"`——坐标系
   即原图物理像素，缩放自动对齐（pinText 数据形态改为 `{w, h, lines: {x,y,w,h,text}}`）。
2. `textLength = bbox.w` + `lengthAdjust="spacingAndGlyphs"`——**强制字形串精确铺满
   bbox 宽度**，字符位置与图片文字逐字对齐 → 圈选范围 = 复制内容。
3. 基线 `y = bbox.y + 0.88×bbox.h`（CJK 墨迹≈[基线-0.86H, 基线+0.1H]，选区高亮≈bbox）。
4. CSS：`fill: transparent`（SVG 无 color/transparent 字形）；`pointer-events: all`
   （SVG 默认 visiblePainted 因 fill 透明失去命中）；`::selection { fill: transparent;
   background: 蓝 }`（不支持时回退系统选区蓝，基础 fill 恒透明兜底）。
5. `user-select: text` 对 SVG `<text>` 同样生效；Ctrl+A / 拖选 / 原生右键复制语义不变。

### v4（2026-10-30，用户实测反馈四次迭代）

实测问题：截图流程「识别结果」浮层内圈选文字后按 Ctrl+C，复制到的是**整张截图**而非所选文字。

根因：CaptureOverlay 的全局 keydown 对 Ctrl+C 无条件 `preventDefault()` 并调用 `onCopy()`
（复制整图，对齐主流截图工具），劫持了 WebView2 原生加速键——浮层 `.ocr-lines` 虽已支持
拖选（`user-select: text`），但原生 Ctrl+C 永远到不了浏览器复制命令。

修复（CaptureOverlay.tsx keydown Ctrl+C 分支，一处 2 行门控）：

```tsx
if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
  // 浮层/文字输入框内已有选中文字时放行:交由 WebView2 原生加速键复制所选文字
  // (与贴图自由复制文案体验一致);无选区仍复制整张截图。
  if (window.getSelection()?.type === 'Range') return;
  e.preventDefault();
  if (confirmed && !textInput.visible) void onCopy();
}
```

- `Selection.type === 'Range'` = 存在非折叠文字选区（OCR 浮层或文字标注输入框内）→ 直接
  `return` 不 preventDefault，wry 默认 `browser_accelerator_keys: true` 使原生复制生效。
- 无选区时行为不变（复制整图）；Esc 关浮层逻辑此前已处理，不受影响。

### v5（2026-10-30，用户反馈：悬停工具栏遮挡 + 右键菜单受限 + 划选失效排查）

实测问题：
1. 鼠标移入贴图时的黑色操作栏遮挡贴图内容，要求移除并全部并入右键菜单；
2. 贴图右键 DOM 菜单受贴图窗口尺寸限制，小贴图时无法完整显示；
3. 用户明确约束：**仅操作栏功能迁移至右键菜单**；自由划选复制必须保持在贴图上直接操作，
   **OCR 相关功能（框选识别/复制文字/全部转待办）不得放进右键菜单**（菜单首项「识别文字(框选)」
   易误点进入框选模式导致贴图像失控）。

修复：
1. **移除悬停工具栏**：删除 PinWindow 的 `toolbarVisible` 态、lucide 图标 import 与
   `.pin-toolbar` JSX；screenshot.css 删除 `.pin-toolbar/.pin-btn/.pin-opacity` 全部样式。
   悬停仅保留蓝色边框提示。
2. **OS 原生右键菜单**（`@tauri-apps/api/menu` 的 `Menu.new` + `menu.popup(undefined, win)`）：
   不传 `at` 在当前鼠标位置弹出，OS 级显示、**不受贴图窗口尺寸约束**；菜单每次右键动态重建
   携带最新勾选态（锁定/鼠标穿透 CheckMenuItem、透明度±、复制图片、关闭(进历史)、销毁(移出历史)）；
   上一份菜单在新菜单 popup 成功后 `close()` 释放资源；**popup 返回后必须 `win.setFocus()`
   夺回键盘焦点**（Windows TrackPopupMenu 关闭后焦点可能未交回 WebView2 → 拖选正常但
   Ctrl+C 失灵）；capabilities/screenshot.json 增加 `core:menu:default`。
3. **手动框选识别入口随菜单迁移整体删除**：`runOcr`/`enterOcrSelect`/`ocrMenu`/`ocrSelecting`
   等状态与 DOM 菜单 JSX、ocr.css 中 `.ocr-ctx-menu`/`.ocr-select-*` 样式全部清理。
   自由划选主体 = 显示后自动整图 OCR + SVG 文字层拖选（不经任何菜单）；
   文字层已有选区时右键仍放行 WebView 原生复制菜单。
4. **划选失效排查结论与加固**：静态排查文字层命中链（pointer-events/user-select/::selection）、
   preventDefault 路径、Ctrl+C 放行、CSS 规则均无回归；app.log 证实 OCR 链路正常
   （含整图 28 行识别）。唯一静默失败路径 = 整图 base64 超 `OCR_INPUT_LIMIT`（≈4K 钉图）时
   旧实现直接跳过 → 贴图无文字层（用户视角即「无法划选」）。修复：按 0.7 逐级降采样重试
   （下限 0.35），bbox 识别后按 `1/scale` 映射回原图坐标；新增 `pin ocr lines=N scale=X` /
   `pin ocr failed` 日志留痕（`OCR_INPUT_LIMIT` 改为 export）。

> 注：变更记录 v2/v3/v4 中描述的右键菜单「识别文字(框选)/复制文字/全部转为待办」入口已在
> v5 移除，以本记录为准。

### v6（2026-10-30，用户反馈：滚轮缩放失灵 + 划选仍不可用）

实测问题：v5 之后 ①贴图无法滚轮缩放；②贴图上依然无法划选复制（该问题自 v3 起）。

根因与修复：
1. **滚轮缩放（100% 失效）**：v5 重构删除了 ocrActive 相关状态，但 onWheel 守卫残留
   `ocrActiveRef.current` 引用（全文件无声明）。vite/esbuild 不做类型检查，把未声明
   标识符编译为全局变量引用——构建通过、运行时每次滚轮事件抛 `ReferenceError` →
   缩放必然失效（此前「tsc 通过」的结论不实：该错误只有 tsc 能查出）。修复：守卫改回
   `if (penetrated || locked) return;`，缩放 catch 中加 `pin wheel resize failed` 日志。
2. **划选复制（v3 起失效）**：时间线还原证实 v2（HTML span 文字层）拖选可靠、v3 换成
   SVG `<text>` + textLength 后 WebView2 中 SVG 文本拖选不再工作。修复：文字层回退
   HTML span（拖选可靠），逐行 `measureText` 测自然宽度后 `scaleX = bbox.w / 自然宽度`
   校准——字形串精确铺满 bbox，达到 textLength=spacingAndGlyphs 的等价逐字对齐；
   `::selection` 透明字形 + 半透明蓝块不变；font-family 在 CSS 与 canvas 测量两侧锁定
   一致，否则校准失准。
3. 验证：`tsc --noEmit` 全项目通过（本次已实际核对退出码）、ESLint 0 错误 0 警告。

### v7（2026-10-30，用户反馈：多次修复后贴图仍无法划选，要求找出真正改动原因）

实测问题：v6 修复后贴图上依然「无法划选复制」。

根因定论（日志证据链，区别于 v6 的层类型问题）：用户 4 次测试贴图（同内容 1077x551、
12 行文字）在 `pin shown` 后 1~1.5s 内即关闭，且**全部零 OCR 日志**——`pin ocr lines=N` /
`ocr ok` 都在前端 await 返回后才写，窗口提前关闭时 pending invoke 随 WebView 销毁静默丢失。
即：**文字层从未生成过（识别需 ~1.4s > 用户关闭间隔 ~1s），不是「生成了选不中」**——
v6 的 span 层修复方向正确但从未被真正测到。「之前可以」的原因：Media.Ocr 时代 ~0.2s 秒出
文字层，用户划选时层已就绪；换 PP-OCRv4（精度优先，用户拍板）后首识别延迟升至秒级。

修复（v7）：
1. Rust 侧（ocr.rs）：`ocr_recognize` 全程日志留痕（start/done/failed/cache hit）；
   **识别结果按图字节 hash 缓存**（容量 16，仅成功结果）——窗口提前关闭后 Rust 侧仍算完
   入库，再钉同一张图秒出文字层；ppocr 引擎锁 try_lock 轮询上限 10s（超时报错回退系统
   引擎，杜绝永久阻塞），获锁后双检缓存。
2. 前端（PinWindow.tsx）：`pin ocr start WxH` / skip 日志；识别期间「正在识别文字…」
   toast（完成即清除），告知用户文字层尚在生成、稍候即可划选。
3. 前端（ocrClient.ts）：invoke 15s 超时（本项目有 invoke 偶发挂起先例），超时走
   `pin ocr failed` 日志链路，不再静默。
4. 验证：`tsc --noEmit`（退出码 0）、`eslint` 两改动文件 0 错误 0 警告、`cargo check`（退出码 0）。

验收要点：首钉同一张图等「正在识别文字…」消失（约 1~1.5s）后拖选；关闭再钉同一张图
文字层立即出现（cache hit）可即刻划选；若仍有问题，app.log 的 `pin ocr start` →
`recognize start/done` → `cache hit` 三段日志可直接定位卡点。

### v7.1（2026-10-30，用户反馈：截图-贴图后贴图完全不显示，多次尝试均失败）

证据链：app.log 中 5 次尝试全部 `pin click → pin invoking show_pin_window → pin window label=pin-1 → pin ok`，
但**无任何 `pin shown`**（对比此前成功记录：`pin window label=...` 后 ~400ms 即出现 `pin shown`）。
Rust 侧建窗成功、事件已投递，前端从未装载 → 断点在贴图窗口前端侧。两个叠加根因：

1. **池窗坏死复用陷阱**：池窗保持隐藏=空闲即会被复用。pin-1 的 WebView 若加载失败/假死
   （该次应用启动有 `main window force-shown by watchdog (page load event missing)` 佐证启动不顺），
   事件投给死页面，且窗口永远隐藏=永远空闲 → **每次都复用同一个坏死窗，所有尝试全部失败**。
2. **take_image 取出即删的静默失败模式**：PinWindow init 消费 meta/图片后若中途失败且未放回，
   数据永久丢失 → 后续所有尝试拿不到数据、零日志静默失败（本应用 RustLog 只落 Warn+，
   v7 在 ocr.rs 加的 `log::info!` 全部进不了 app.log，加剧排查盲区）。

修复（v7.1）：
1. Rust 侧（screenshot.rs）：**贴图前端就绪看门狗** —— PinWindow 装载完成自行 show 后调用
   新命令 `pin_frontend_ready` 登记；show_pin_window 每轮先清除标记，若 t+4s 未就绪重发
   pin-set 自救，t+8s 仍失败则**重载 webview**（每轮仅一次防循环）后复检，t+15s 仍失败记错误
   （webview 疑似未加载/已死，重启应用可恢复）。池窗与动态窗路径均接入。
2. Rust 侧（lib.rs）：注册 `pin_frontend_ready` 命令。
3. Rust 侧（ocr.rs）：v7 的 4 处 `log::info!` 全部改为 `crate::append_app_log` 直写
   （本应用 RustLog 只落 Warn 及以上，诊断日志必须直写 app.log 才可见）。
4. 前端（PinWindow.tsx）：
   - init 失败兜底：catch 中把 meta（及已取到的图片 b64）**原样放回 stash**，防数据永久丢失；
   - 图片未就绪（动态窗 pin:<id> 晚于 meta 场景）时把 meta 放回待下次重试，不再永久丢失；
   - 挂载留痕 `pin mounted label=...`（无此行=webview 加载失败/挂载崩溃；有此行无 pin shown=init 链路问题）；
   - pin-set 监听器改 `init(true)`：事件触发却读不到 meta 时留痕（区别于挂载轮询的静默空转）。
5. 验证：`tsc --noEmit`（退出码 0）、`eslint PinWindow.tsx` 0 错误 0 警告、`cargo check`（退出码 0）。

验收要点：**重启应用**后贴图应正常显示。若再失败，app.log 依次查 `pin mounted` →
`pin init ...` → `pin frontend not ready t+4s/t+8s/t+15s`（看门狗逐级自救留痕），
日志链可直接定位断点。

### v7.2（2026-10-31，用户反馈：贴图能显示了但仍无法划选复制——多次修复失败真因定论）

日志证据链：本轮测试 `pin shown → pin ocr start → [ocr] cache hit lines=1 → pin ocr lines=1`
全链路通,**文字层 DOM 已生成**,断点在选中交互层。

真因（v5 埋雷,v6/v7/v7.1 均未命中）：文字层三段样式 `.pin-text-layer` / `.pin-text-line` /
`.pin-text-line::selection` 一直寄生在 `ocr/ocr.css`,而该文件**只有 OcrResultPanel.tsx 引入**。
v2 时代 PinWindow 渲染 OcrResultPanel（手动框选浮层）,ocr.css 顺带加载,划选正常;
v5 移除手动框选入口时把 OcrResultPanel 从 PinWindow 删除,ocr.css 从此不在贴图窗口加载,
文字层样式**静默消失**。无样式后果:span 无 position:absolute → 被绝对定位的图片盖住
（视觉零异常）、无 pointer-events:auto、继承 .pin-root 的 user-select:none → 拖选必然
无反应,而拖动/缩放/右键菜单全部正常——与用户现象逐项吻合。v6 回退 span 层、v7 修识别
耗时、v7.1 修窗口显示,均未检查样式表加载链;tsc/eslint 不检查 CSS,连续多轮验证通过
却全部无效。

修复（v7.2）：三段样式**迁入 screenshot.css**（PinWindow 实际 import 的样式表）,ocr.css
仅留防回归注释;grep 验证样式定义唯一、使用方唯一（仅 PinWindow.tsx）。纯 CSS 变更,
无 TSX 改动。

教训：排查「修改后失效」时,**CSS 依赖必须核对加载链**（谁 import、被谁渲染）,组件删除
可能连带卸掉无关功能的样式;样式寄生在非直接相关的文件里就是隐式耦合。
