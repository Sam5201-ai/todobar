# 贴图文字直接可选中复制 — 任务拆解

对应规格：[pin-text-copy-spec.md](pin-text-copy-spec.md)

## [x] T1. PinWindow.tsx：自动整图 OCR

- [x] 新增 state（实现为 `pinText`，bbox 已折算为百分比——渲染期免读 imgRef，满足 react-compiler 规则）。
- [x] 新增 `autoOcrWholeImage()`：整幅离屏 canvas → `cropRegionPng` → `recognizeRegion`
      → `filterNoiseLines` → 仅保留含 bbox 行 → 折算百分比 → `setPinText`。
- [x] 代际号防悬挂：进入时快照 `ocrRunRef.current`，完成时比对丢弃（换图/关闭/resetOcr 已有 +1）。
- [x] 全程 try/catch 静默（含 `OCR_REGION_TOO_LARGE`）。
- [x] 触发点：`init()` 中 `win.show()` 成功后 `void autoOcrWholeImage()`（deps 已补）。
- [x] 清理点：init 换图分支 `setPinText([])`。

## [x] T2. PinWindow.tsx：渲染透明文字层

- [x] 条件：`pinText.length > 0 && ocr.phase === 'idle'`（结果浮层打开时隐藏）。
- [x] 结构：`.pin-text-layer` > `.pin-text-line` × N，百分比定位（含 bbox 存在性守卫）。
- [x] 插入位置：`<img>` 之后、`ocrSelecting` overlay 之前。
- [x] 附加：`onContextMenu` 在「文字层且已有选区」时放行 WebView 原生菜单（右键复制所选），
      无选区仍弹自定义 OCR 菜单（规格 §2.2 落地）。

## [x] T3. ocr.css：文字层样式

- [x] `.pin-text-layer`（inset:0 / z-4 / pointer-events:none）、
      `.pin-text-line`（pointer-events:auto / user-select:text / 透明文字）、
      `.pin-text-line::selection`（半透明蓝块 + 白字兜底）。

## [x] T4. 验证

- [x] `tsc --noEmit` 全项目通过。
- [x] `eslint` 本次改动文件（PinWindow.tsx / OcrResultPanel.tsx / ocrClient.ts）0 错误 0 警告；
      其余报错均为未触碰文件的存量问题（CaptureOverlay / ScreenshotEditor / bridge / store），不处理。

## [x] T6. v2 迭代：消除选字浮字 + 贴图去浮层（用户实测反馈）

- [x] 文字层字号 `fontSize: <行高>vh`（字形盒与图片文字等大重合）+ `line-height: 1`。
- [x] `::selection` 字形 `transparent`：选中只显示半透明蓝块，图片文字透出。
- [x] 移除 PinWindow 的 OcrResultPanel 引用与 ocr 结果态；`runOcr` 结果按 bbox 平移
      合并进文字层（相交旧行替换）；右键菜单新增「复制文字」「全部转为待办」。
- [x] `tsc --noEmit` + `eslint PinWindow.tsx` 通过。

## [x] T7. v3 迭代：圈选范围与复制内容对齐（用户实测反馈）

- [x] 文字层 HTML span → SVG `<text>`：viewBox=原图物理像素、`textLength=bbox.w`
      + `spacingAndGlyphs` 强制字形串铺满 bbox、基线 y=+0.88h。
- [x] pinText 数据形态改为 `{w, h, lines:{x,y,w,h,text}}`（自然像素），runOcr 合并/
      autoOcr 同步适配；菜单置灰与复制/转待办改用 `pinText?.lines`。
- [x] ocr.css：`fill:transparent` + `pointer-events:all` + `::selection` 蓝块透明字形。
- [x] `tsc --noEmit` + `eslint PinWindow.tsx` 通过。

## [x] T8. v4 迭代：截图流程识别结果浮层自由复制（用户实测反馈）

- [x] 根因：CaptureOverlay keydown 的 Ctrl+C 分支无条件 `preventDefault()` + `onCopy()`
      （复制整图），劫持了 WebView2 原生加速键，浮层内拖选的文字无法 Ctrl+C 复制。
- [x] 修复：Ctrl+C 分支加门控 `if (window.getSelection()?.type === 'Range') return;`
      ——浮层/文字输入框内有选中文字时放行原生加速键复制所选；无选区仍复制整图。
- [x] `tsc --noEmit` 全项目通过；`eslint CaptureOverlay.tsx` 报 5 个错误
      （142/751/902/988/1134 行）均为存量（本次改动块 1139-1146 之外），不处理。

## [x] T9. v5 迭代：工具栏移除 + OS 原生右键菜单 + 划选失效排查加固（用户反馈）

- [x] 移除悬停黑色工具栏（toolbarVisible/lucide 图标/.pin-toolbar JSX 及样式）；悬停仅蓝色边框。
- [x] 原工具栏功能全集迁入 Tauri 2 原生右键菜单（Menu.new + menu.popup(undefined, win)）：
      锁定/鼠标穿透（CheckMenuItem 勾选态）、透明度±、复制图片、关闭(进历史)、销毁(移出历史)；
      每次右键动态重建；上一份菜单 popup 成功后 close；popup 返回后 win.setFocus() 夺回焦点。
- [x] OCR 功能不进右键菜单（用户约束）；手动框选识别入口整体删除
      （runOcr/enterOcrSelect/ocrMenu/ocrSelecting 及相关 JSX/CSS）；
      划选复制保持在贴图上直接操作（自动整图 OCR + SVG 文字层）。
- [x] 划选失效排查：链路无回归；唯一静默失败路径 = 整图超 OCR_INPUT_LIMIT 直接跳过 → 无文字层；
      修复为 0.7 逐级降采样重试（下限 0.35）+ bbox 映射回原图 + `pin ocr` 日志留痕。
- [x] capabilities/screenshot.json 增加 core:menu:default。
- [x] `tsc --noEmit` 全项目通过；`eslint PinWindow.tsx / ocrClient.ts` 0 错误 0 警告。

## [x] T10. v6 迭代：滚轮缩放修复 + 文字层回退 HTML span（用户反馈）

- [x] 根因1：onWheel 守卫残留未声明的 `ocrActiveRef.current`（v5 删状态时漏改），
      vite 不做类型检查 → 运行时 ReferenceError → 滚轮缩放 100% 失效；守卫改回
      `if (penetrated || locked)`，缩放 catch 加 `pin wheel resize failed` 日志。
- [x] 根因2：v3 起 SVG `<text>` 在 WebView2 中拖选不可靠（v2 的 HTML span 时代拖选
      正常）；文字层回退 HTML span，逐行 measureText + scaleX 校准实现
      textLength=spacingAndGlyphs 等价的逐字对齐。
- [x] ocr.css 文字层样式改为 HTML 语义（color:transparent / user-select:text /
      ::selection 蓝块），font-family 与测量侧 ctx.font 锁定一致。
- [x] `tsc --noEmit` 全项目通过（已核对退出码 0）；`eslint PinWindow.tsx` 0 错误 0 警告。

## [x] T11. v7 迭代：识别延迟静默问题根治（用户反馈「多次修复仍无法划选」）

- [x] **真正根因（日志证据链定论）**：PP-OCRv4 对用户测试图（1077x551/12 行）实测需 ~1.4s，
      而 `pin ocr lines=N`/`ocr ok` 日志都在前端 await 返回后才写 —— 用户贴图后 ~1s 内即关闭窗口,
      pending invoke 随 WebView 销毁静默丢失,连续 4 次测试**零 OCR 日志、文字层从未生成过**
      （不是「生成了选不中」,v6 的 span 层修复从未被真正测到）。此前 Media.Ocr 时代 ~0.2s 秒出
      文字层,用户划选时层已就绪,故「之前可以」。
- [x] Rust 侧（ocr.rs）:
      - `ocr_recognize` 全程留痕（start/done/failed/cache hit,字节数+行数+耗时）——
        不受窗口关闭影响,可定论「识别是否真实发生」。
      - **识别结果按图字节 hash 缓存**（容量 16,仅缓存成功结果）:窗口提前关闭后 Rust 侧
        spawn_blocking 仍算完入库 → 再钉同一张图秒出文字层。
      - ppocr 引擎锁改 try_lock 轮询（上限 10s）,超时报错回退系统引擎,杜绝永久阻塞;
        获锁后双检缓存（排队期间他线程可能已算完同图）。
- [x] 前端（PinWindow.tsx）:
      - `autoOcrWholeImage` 开头 `pin ocr start WxH` 日志 + 图片未就绪 skip 日志。
      - 识别期间显示「正在识别文字…」toast（完成/失败即清除;缓存命中毫秒级返回基本无感）,
        明确告知文字层尚未就绪,避免用户贴图即划选扑空误判功能失效。
- [x] 前端（ocrClient.ts）:invoke 加 15s 超时（withTimeout）——本项目已有 invoke 偶发挂起先例,
      超时抛错走 `pin ocr failed` 日志链路,不再静默无响应。
- [x] `tsc --noEmit` 全项目通过（退出码 0）;`eslint PinWindow.tsx / ocrClient.ts` 0 错误 0 警告;
      `cargo check` 通过（退出码 0）。

## [ ] T5. 用户真机验收

- [ ] 贴图后 ~1s 直接在文字上拖选 → 半透明蓝块盖在图片文字上（无浮字）→ Ctrl+C 粘贴验证。
- [ ] **圈选部分文字 → 粘贴内容与圈选范围逐字一致（不多了、不少了）**。
- [ ] 右键选中文字 → 原生菜单「复制」。
- [ ] 按在无文字区域拖动贴图正常、滚轮缩放后文字层位置与高亮仍精确对齐。
- ~~右键菜单「识别文字(框选)」→ 识别后文字直接出现在贴图对应位置（无浮层）。~~（v5 已移除该入口）
- ~~右键菜单「复制文字」「全部转为待办」可用（无识别结果时置灰）。~~（v5 已移除该入口）
- [ ] **v4：截图 → 识别文字 → 浮层内拖选文字 → Ctrl+C 粘贴 = 所选文字（不再复制整图）。**
- [ ] **v4：浮层内无选区时 Ctrl+C 仍复制整张截图（原行为无回归）。**
- [ ] **v5：悬停贴图无黑色操作栏（仅蓝色边框），贴图内容完全不被遮挡。**
- [ ] **v5：右键菜单完整显示在贴图窗口外（小尺寸贴图也不被裁剪），锁定/穿透勾选态正确。**
- [ ] **v5：菜单内透明度±/复制图片/关闭(进历史)/销毁 均可用且效果正确。**
- [ ] **v5：右键菜单操作后，贴图上拖选 + Ctrl+C 复制仍正常（setFocus 修复生效）。**
- [ ] **v5：大图钉图（≈4K 整屏）也有文字层可划选（降采样重试生效，日志出现 pin ocr lines）。**
- [ ] **v7：贴图后出现「正在识别文字…」提示，约 1~1.5s 后消失 → 此时拖选复制正常（首钉同一张图）。**
- [ ] **v7：关闭贴图后再次钉同一张图 → 文字层立即出现（Rust 缓存命中，日志出现 cache hit），可即刻划选复制。**
- [ ] **v7：若再遇「无法划选」，查 app.log：`pin ocr start`（前端开始）/ `recognize start/done`（Rust 完成）/ `cache hit`（命中）三段日志可直接定位卡点。**

## [x] T12. v7.1：贴图完全不显示修复（2026-10-30）

- [x] **证据链**：5 次尝试全部 `pin ok` 但零 `pin shown` —— Rust 建窗成功、事件已投、前端从未装载。
      根因①池窗坏死复用陷阱（隐藏=空闲被每次复用，事件投给死页面）；根因②take_image 取出即删,
      init 中途失败数据未放回 → 后续全部零数据零日志静默失败。
- [x] Rust（screenshot.rs）:`pin_frontend_ready` 命令 + 前端就绪看门狗
      （t+4s 重发 pin-set → t+8s 重载 webview（每轮一次防循环）→ t+15s 报错留痕），
      池窗/动态窗路径均接入；每轮 show_pin_window 先清标记。
- [x] Rust（lib.rs）:注册 `pin_frontend_ready`。
- [x] Rust（ocr.rs）:v7 的 log::info! 改 append_app_log 直写（RustLog 只落 Warn+，info 进不了 app.log）。
- [x] 前端（PinWindow.tsx）:init 失败把 meta/图片原样放回 stash（防永久丢失）；图片未就绪 meta 放回重试；
      挂载留痕 `pin mounted`；pin-set 监听器改 `init(true)` 事件路径留痕。
- [x] `tsc --noEmit`（退出码 0）、`eslint PinWindow.tsx` 0 错 0 警告、`cargo check`（退出码 0）。
- [ ] **v7.1 真机验收：重启应用 → 截图-贴图 → 贴图正常显示、文字层可划选；
      若再失败按 `pin mounted` / `pin init ...` / `pin frontend not ready` 日志链定位。**

## [x] T13. v7.2：划选失败真因——文字层样式表未加载（2026-10-31）

- [x] **证据链**：日志全链路通（pin shown → cache hit → pin ocr lines=1）,文字层 DOM 已生成,
      断点在选中交互;排查发现 `.pin-text-layer/.pin-text-line/::selection` 三段样式寄生
      ocr/ocr.css,而该文件仅 OcrResultPanel.tsx 引入 —— v5 移除手动框选浮层后贴图窗口
      不再加载,样式静默消失（span 被图片盖住视觉零异常 + 继承 user-select:none → 无法划选）。
- [x] 修复：三段样式迁入 screenshot.css（PinWindow 实际 import）,ocr.css 留防回归注释;
      grep 验证样式定义唯一、使用方唯一。
- [ ] **v7.2 真机验收：贴图显示后,在文字 bbox 上按下拖动出现半透明蓝块选区,
      Ctrl+C 粘贴 = 所选文字;bbox 之外拖动仍是移动贴图;其余功能无回归。**

## [ ] T14. v7.3：圈选整行复制缺字——排查与定论工具（2026-10-31）

- [x] **现象**：v7.2 后划选可用；用户圈选贴图整行「贴图后把鼠标移到文字上」（239x50,行内后半段粗体）,
      粘贴只有「贴图后把鼠标移」——缺粗体尾段「到文字上」。
- [x] **几何定论（日志+截图推演,高置信）**：日志 `pin ocr lines=1`;粘贴=前 8 字 + 蓝块铺满整行
      ⇒ 唯一自洽解 = **det 框住整行但 rec 只输出前 8 字**(8 个字形被 scaleX 拉伸铺满整行 bbox,
      蓝块全宽掩盖了文本缺字)。rec 链路核查无宽度截断/无置信度过滤,漏字发生在模型识别环节
      (小行高 ~30px + 粗体混排为最可能诱因)。
- [x] 定论工具：Rust `recognize done` 后逐行输出 `[ocr] line[i] text/bbox/conf`;
      前端 `pin ocr lines=N` 后逐行输出 `pin ocr line[i] "text" bbox`。
- [x] 缓存版本化：cache_key 混入 RECOGNIZE_PIPELINE_VERSION(=2)——管线修复后旧结果自动失效,
      杜绝「重测同图永远命中修复前缓存 → 修了没生效」假象。
- [x] `tsc --noEmit`（退出码 0）、`eslint PinWindow.tsx` 0 错 0 警告、`cargo check`（退出码 0）。
- [ ] **v7.3 真机定论：重钉同一张图（缓存已失效会真实重识别）→ 看 app.log `pin ocr line[0]` /
      `[ocr] line[0]` 的 text 是否缺「到文字上」→ 实锤后做针对性修复（候选:小图升采样重识别）。**
