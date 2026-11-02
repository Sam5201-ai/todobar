# 截图 OCR 文字识别功能 — 开发方案 v2.0

> 版本：v2.0（Rust 原生引擎 · 精度优先） ｜ 日期：2026-10-29 ｜ 目标版本：0.5.x
> 相对 v1.0 的根本变化：OCR 引擎从 tesseract.js（WASM）**切换为系统原生引擎**——Windows 用 `Windows.Media.Ocr`，macOS 用 Vision framework。选型唯一标准：**识别精度优先**，精度不可靠则功能无价值。
> 范围不变：截图操作条「识别文字」、贴图右键「识别文字」+ 自由框选、结果浮层（复制全部 / 双击复制单行 / 转为待办）。

---

## 0. v1 → v2 变更摘要

| 项 | v1.0（tesseract.js） | v2.0（原生引擎，本方案） |
|---|---|---|
| 引擎 | tesseract.js WASM，chi_sim+eng fast 模型 | Windows.Media.Ocr（Win）＋ Vision accurate（mac） |
| 精度 | fast 量化模型，中文小字号明显掉精度 | 系统级引擎，UI 文字精度最高一档；Vision accurate 为 zh-Hans 识别标杆 |
| 预处理 | 灰度 + Otsu 二值化 + 放大（破坏 ClearType 亚像素信息） | **禁止破坏性预处理**：物理像素原图直出 |
| 预热 | JS Worker 单例 | Rust 引擎单例（后台线程预热，OnceLock 缓存） |
| 安装包增量 | +5~10MB（语言包随包） | **≈0**（引擎与语言模型由操作系统提供） |
| 速度 | 2~5s（WASM，老机器更慢） | 0.3~1.5s（原生，多核 SIMD） |
| 内存 | 每窗口 60~200MB worker | 几乎为零增量（引擎随进程，无独立堆） |
| 语言包依赖 | 应用自带，行为确定 | **依赖系统语言包**（Win 端需 zh-CN 包，见风险 R1） |
| Rust 侧改动 | 零 | 新增 OCR 模块 + 2 条命令（本次主要工作量所在） |

v1 风险分析中确认的结论：tessdata_fast + Otsu + WASM 三者叠加的精度上限不可接受 → 原生路线从"备选"转正。

---

## 1. 精度优先设计原则（本方案的宪法条款）

1. **原图直出**：送入引擎的图像 = 截图物理像素原样裁剪，**不做二值化、不做放大、不加任何滤镜**。Windows 的 ClearType 是亚像素渲染，任何全局阈值都会打碎笔画；两个原生引擎内部自带比我们更强的前处理。
2. **只做无损操作**：裁剪（物理像素）、PNG 编码（禁止 JPEG）、超限时等比**缩小**（仅当超过引擎尺寸上限，见 §4.4）。
3. **双语识别**：Win 用 zh-CN 引擎（Latin 字符内嵌识别良好，附 ASCII 占比启发式切 en-US）；macOS Vision 直接声明 `["zh-Hans", "en-US"]`。
4. **macOS 必须用 accurate 档**（`recognitionLevel = .accurate`），禁用 fast 档；`usesLanguageCorrection = true` 提升中文成句准确率（密码/乱码类内容可能被"纠正"，v1.1 在浮层加「原样输出」开关，见 §10 backlog）。
5. **精度验收硬指标**（§11）：15 张真实样张加权准确率 ≥95%，含最难的 ClearType 小字号样张 ≥90%。**不达标不发布**，先调语言/引擎策略，仍不达标再评估补充方案。
6. 识别结果与置信度（mac 有、Win 无）只用于内部空结果判定，UI 不展示置信度列（保持两平台观感一致）。

---

## 2. 架构现状（与本次改造相关的既有设施）

> 详细梳理见 v1，此处仅保留与 v2 相关的要点。

- 架构为 **Tauri 2**（React 19 + Rust），非 Electron；WebView：Win = WebView2，mac = WKWebView。
- 覆盖层 [CaptureOverlay.tsx](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/screenshot/CaptureOverlay.tsx)：预热常驻窗，四层 canvas，选区确认后操作条 → **新增「识别文字」按钮**；base 层物理像素画布即图像源。
- 贴图窗 [PinWindow.tsx](file:///d:/Wordbuddy/2026-10-09-10-11-34/todobar/src/screenshot/PinWindow.tsx)：目前无右键菜单 → 新增；图片支持滚轮/角柄缩放，框选坐标需按 `naturalWidth/clientWidth` 映射回原图。
- 图像传输铁律（项目既有教训）：**大图走临时文件 + 路径，不走 base64 IPC**（整屏 base64 曾撑爆 WebView）。OCR 沿用：区域 PNG 写临时文件 → 只传路径给 Rust。
- 子窗口不接账号/DB → 转待办走事件桥回主窗 `addTask`，自动满足「账号数据隔离」「免费每日限额」两条硬约束；**事件必须带重试 + ack**（pin-set 丢失事故的既有教训）。

---

## 3. 总体架构与数据流

```
┌─────────────────────────────┐      ┌─────────────────────────────┐
│  截图覆盖层 capture-overlay   │      │  贴图窗口 pin-*              │
│  选区确认 → 操作条「识别文字」 │      │  右键菜单「识别文字」→ 框选    │
└──────────────┬──────────────┘      └──────────────┬──────────────┘
               │ base canvas 裁剪选区(物理像素)   │ 原图离屏 canvas 裁剪框选
               │ extractPng → save_image 写临时 PNG │
               ▼                                   ▼
        ┌──────────────────────────────────────────────────┐
        │  invoke('ocr_recognize', { path })   只传路径       │
        │  ┌──────────────── Rust 侧（新增模块 src-tauri/src/ocr.rs）──────┐
        │  │ engine 单例预热(后台线程, OnceLock) → 读 PNG → 原图直出          │
        │  │  ├ Windows: Windows.Media.Ocr（zh-CN 引擎, ASCII 启发式切 en-US）│
        │  │  └ macOS:   Vision VNRecognizeTextRequest（accurate + 纠错）    │
        │  └──────────────── 返回 OcrResult { lines: Vec<OcrLine> } ───────┘
        └──────────────────┬───────────────────────────────────┘
                           │ OcrLine[] { text, x, y, w, h, confidence? }
                           ▼
        ┌──────────────────────────────────────────────┐
        │  ocr/OcrResultPanel.tsx 结果浮层               │
        │  复制全部 ｜ 双击复制单行 ｜ 单行/全部转待办       │
        └──────────────────┬───────────────────────────┘
                           │ emitTo('main','ocr-create-task') + 重试/ack
                           ▼
                主窗 useTaskStore.addTask（复用额度/会员校验）
```

依赖变化：
- Rust 新增 crate：`windows`（仅 Win target，features: `Media_Ocr`、`Globalization`、`Graphics_Imaging`、`Storage_Streams`、`Foundation`）；`objc2` + `objc2-vision` + `objc2-foundation`（仅 mac target）。
- 前端新增依赖：**无**（v1 的 tesseract.js 及语言包全部移除，`public/tessdata/` 方案作废）。
- Rust 侧读 PNG 需 `image` crate 解码（Win 端转 SoftwareBitmap；mac 端走 NSImage/CGImage 自解码亦可，见 §4.3）。

---

## 4. Rust 侧设计（本次核心）

新文件 `src-tauri/src/ocr.rs`，统一在 `#[cfg(target_os)]` 下分平台实现，对外两条命令 + 一个预热函数。

### 4.1 统一抽象

```rust
// 识别结果行:坐标为原图物理像素(贴图框选/行框映射回 UI 用,本期仅数据预留)
#[derive(Serialize, Clone)]
pub struct OcrLine {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,   // mac Vision 有;Win Media.Ocr 不提供 → None
    pub x: f32, pub y: f32, pub w: f32, pub h: f32,
}

#[derive(Serialize, Clone)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
    pub engine: String,        // "windows-media-ocr" / "macos-vision",日志与诊断用
    pub language: String,      // 实际使用的识别语言
}

pub trait OcrBackend: Send + Sync {
    fn recognize(&self, png_bytes: &[u8]) -> Result<OcrResult, String>;
    /// 探测系统能力,设置面板展示用(如 Win 未装中文语言包时提前告知)
    fn status(&self) -> OcrStatus;
}
```

### 4.2 Windows 实现（Windows.Media.Ocr）

```rust
#[cfg(target_os = "windows")]
pub struct WindowsOcr { engine: Mutex<Option<OcrEngine>>, lang: Mutex<Option<HString>> }

impl WindowsOcr {
    /** 引擎单例预热:进程启动/覆盖层首显时由后台线程调用。
     *  WinRT 激活是首用时最慢的一步(~100~300ms),提前完成;引擎对象进程级复用。
     *  语言策略:优先 zh-CN 显式创建;失败则 TryCreateFromUserProfileLanguages();
     *  都失败 → status 置 NotAvailable(前端提示安装语言包,见风险 R1)。 */
    pub fn warmup(&self) { /* RoInitialize(COM MTA) → TryCreateFromLanguage("zh-CN") → 缓存 */ }

    fn pick_engine(&self, png_is_mostly_ascii: bool) -> Result<OcrEngine, String> {
        // 精度启发式:纯英文截图(ASCII 占比>70% 需先低成本判定,见 4.5)且系统有 en-US 包
        // → 用 en-US 引擎,避免中文引擎输出形近字(l/1、0/O);否则用 zh-CN。
    }
}

impl OcrBackend for WindowsOcr {
    fn recognize(&self, png_bytes: &[u8]) -> Result<OcrResult, String> {
        // 1. bytes → InMemoryRandomAccessStream → BitmapDecoder → SoftwareBitmap
        //    → Convert 到 Bgra8(Media.Ocr 规范输入,转换无损)
        // 2. 尺寸守卫:若边长 > OcrEngine::MaxImageDimension 则等比缩小后再进引擎(§4.4)
        // 3. engine.RecognizeAsync(softwareBitmap) → OcrResult
        // 4. 逐行:line.Text;行框 = line.Words 各 OcrWord.BoundingRect 的并集
        // 5. 行序保持引擎返回的阅读顺序(引擎已按版面排序;多栏极端交错由框选兜底)
    }
}
```

要点：
- WinRT 调用必须在初始化过 COM(MTA) 的线程;预热线程与命令线程各自初始化,引擎对象 `Send + Sync` 包装后跨线程复用。
- `Windows.Media.Ocr` **不返回置信度**,`OcrLine.confidence = None`;空结果判定改用「lines 为空或全部 text trim 后为空」。
- 历史经验(社区共识):Media.Ocr 对白底黑字最佳,个别暗底反白场景偏弱——**默认不反色**,列入样张验收,若 R5 样张实测不达标才启用「暗底检测 → 反色后双跑取优」策略(§10 预案,非默认)。

### 4.3 macOS 实现（Vision）

```rust
#[cfg(target_os = "macos")]
pub struct MacOcr;

impl OcrBackend for MacOcr {
    fn recognize(&self, png_bytes: &[u8]) -> Result<OcrResult, String> {
        // 1. bytes → CGImage(NSImage/CGImageSource 解码)
        // 2. VNRecognizeTextRequest:
        //      recognition_level  = .accurate      ← 精度优先,禁用 fast
        //      recognition_languages = ["zh-Hans", "en-US"]
        //      uses_language_correction = true
        //    VNImageRequestHandler(cgImage).perform([request])
        // 3. 每个 VNRecognizedTextObservation 天然是行级:
        //      top_candidate(1) → string / confidence / boundingBox(归一化坐标)
        //      → 乘以图像宽高还原物理像素
        // 4. VNRecognizeTextRequest 需 macOS 10.15+(项目既有部署基线满足,T2 时确认)
    }
}
```

要点：
- Vision **每次调用无持久引擎对象**,预热仅需 `objc2::msg_send!` 触达 framework(成本极低),重点预热收益在 Win 端。
- boundingBox 是归一化坐标(y 轴向上,与屏幕坐标系相反),还原时注意翻转——T2 必验项。
- objc2 系 crate 需在 mac 构建机上编译验证(项目本就双平台发布,构建链已有)。

### 4.4 尺寸守卫（无损原则下的唯一例外）

- Win：超过 `OcrEngine::MaxImageDimension`(运行时读取,不硬编码) → 等比缩小,`engine` 字段附注 `scaled`。
- mac：Vision 对超大图同样有内存/耗时风险,统一守卫长边 ≤ 6000px。
- **永不放大**——原生引擎对原图小字的处理优于任何 JS 端重采样(这是 v1 被推翻的核心原因之一)。

### 4.5 两条 Tauri 命令

```rust
#[tauri::command]
pub fn ocr_recognize(path: String, state: State<AppState>) -> Result<OcrResult, String>
// 读临时 PNG(路径校验沿用 read_capture_png 的白名单模式:仅接受本工具生成的
// ticktask_shot_*.png / ticktask_ocr_*.png,防任意文件读取) → backend.recognize

#[tauri::command]
pub fn ocr_status() -> OcrStatus
// 设置面板/首次点击前探测:系统语言包是否可用、引擎是否就绪,失败原因可读化
```

预热时机：应用启动后台线程调用 `warmup()`（进程级一次）；`is_overlay_active` 首次翻真时若未预热则补热。预热失败不阻塞截图主流程（首次点击时同步兜底创建）。

---

## 5. 前端模块划分

| # | 模块 | 文件 | 职责 | 相对 v1 变化 |
|---|---|---|---|---|
| M1 | OCR 客户端 | `src/screenshot/ocr/ocrClient.ts` | extractPng → `save_image` 写临时文件 → `ocr_recognize` 调用；耗时埋点 | 替代 v1 的 ocrWorkerClient；无 Worker、无预热 UI 态（预热在 Rust） |
| M2 | 预处理（瘦身） | `src/screenshot/ocr/prepare.ts` | 裁剪 + 物理像素原图 PNG 编码，**无二值化/无放大** | 大幅瘦身，纯无损 |
| M3 | 结果浮层 | `src/screenshot/ocr/OcrResultPanel.tsx` + `ocr.css` | 复制全部 / 双击复制单行 / 转待办；识别中显示不可进度条（原生引擎无进度回调，改「转圈 + 已耗时 Ns」） | 进度展示调整 |
| M4 | 转待办事件桥 | `src/screenshot/ocr/ocrBridge.ts` | `emitOcrCreateTask(lines)` **带 3 次重试**；主窗 ack 应答（复用项目「重发+应答」既有模式） | 新增 ack 机制（v1 风险 R6 整改） |
| M5 | 覆盖层集成 | `CaptureOverlay.tsx`（最小侵入） | 操作条加按钮 + ocr 状态机 + Esc 层级 | 不变 |
| M6 | 贴图集成 | `PinWindow.tsx`（最小侵入） | 右键菜单 + 框选模式 + 坐标映射 | 不变 |
| M7 | 主窗接入 | `App.tsx`（约 30 行） | 监听（含 ack 回执）→ addTask → 额度/会员校验 → toast | + ack |
| M8 | 设置面板探测 | `ScreenshotSettingsPanel.tsx`（可选，+1 行区块） | 展示 `ocr_status`：系统语言包缺失时给出安装指引 | 新增，R1 缓解 |

---

## 6. 关键代码骨架（前端）

### 6.1 M1 `ocrClient.ts`

```ts
export interface OcrLine { text: string; confidence?: number; box?: {x,y,w,h} }
export interface OcrResult { lines: OcrLine[]; engine: string; language: string; elapsedMs: number }

/** 识别一张区域 PNG(base64)。图像以原图物理像素直出,不做任何破坏性处理。 */
export async function recognizeRegion(pngBase64: string): Promise<OcrResult> {
  const t0 = performance.now();
  // ① 区域 PNG 写临时文件(复用 save_image;走文件而非 base64 IPC,大区域安全)
  const path = await saveImage(pngBase64);
  // ② 调 Rust 原生 OCR(引擎已在进程内预热,通常 0.3~1.5s)
  const r = await invoke<{ lines: OcrLine[]; engine: string; language: string }>(
    'ocr_recognize', { path },
  );
  void shotLog(`ocr ok engine=${r.engine} lang=${r.language} lines=${r.lines.length} ${Math.round(performance.now() - t0)}ms`);
  return { ...r, elapsedMs: performance.now() - t0 };
}
```

### 6.2 M5 覆盖层集成点（最小侵入）

```tsx
// 状态:const [ocr, setOcr] = useState<{phase:'idle'|'running'|'done'; lines:OcrLine[]; startedAt:number}>()
// 操作条(capture-actionbar)新增按钮,顺序:贴图 / 识别文字 / 保存 / 取消 / 复制
const onOcr = useCallback(async () => {
  const sel = confirmedSelRef.current; if (!sel || busy) return;
  setOcr({ phase: 'running', lines: [], startedAt: Date.now() });
  try {
    // 只取 base 层(不含标注/马赛克):马赛克区域不会被 OCR,用户被打码内容不泄露
    const png = extractBasePng(sel);          // 与 extractPng 同构,但不叠加 anno/mosaic
    const r = await recognizeRegion(png);
    if (!r.lines.length) { setOcr(idle); showToast('未识别到文字'); return; }
    setOcr({ phase: 'done', lines: r.lines, startedAt: 0 });
  } catch (e) {
    setOcr(idle); showToast(`识别失败: ${String(e)}`);
  }
}, [busy]);
// Esc 层级:浮层开 → 仅关浮层;再 Esc → 取消截图(插在现有 onKey 分支最前)
// finish() 复位 ocr 状态
```

### 6.3 M6 贴图集成点

```tsx
// ① 右键菜单(新组件):识别文字 / 复制图片 / 关闭(进历史) / 销毁
//    onContextMenu preventDefault;锁定态禁用识别;穿透态收不到鼠标,天然无入口
// ② 「识别文字」→ 框选模式:遮罩 div(crosshair) + 拖拽选框 + 尺寸提示;Esc 取消
// ③ 坐标映射(贴图可被缩放):sx = rect.x * (img.naturalWidth / imgEl.clientWidth)
// ④ 识别输入 = dataRef 原图画到离屏 canvas 后按映射矩形裁剪(原图物理像素直出)
// ⑤ 互斥:框选/浮层期间清零 lastClickRef 屏蔽双击关闭,屏蔽拖拽/滚轮缩放;
//    pin-set 池窗复用重初始化时强制退出框选/浮层并置 ocr=idle(防悬挂 promise)
```

### 6.4 M4 `ocrBridge.ts`（转待办带 ack）

```ts
export const OCR_TASK_EVENT = 'ocr-create-task';
export const OCR_TASK_ACK = 'ocr-create-task-ack';

export async function emitOcrCreateTask(lines: { text: string }[]): Promise<boolean> {
  const reqId = `ocr${Date.now()}`;
  let acked = false;
  const off = await listen(OCR_TASK_ACK, (e) => { if (e.payload.reqId === reqId) acked = true; });
  // 重试 3 次,间隔 200ms(复用 pin-set 重发模式);全程无 ack → 返回 false,UI 提示重试
  for (let i = 0; i < 3 && !acked; i++) {
    try { await emitTo('main', OCR_TASK_EVENT, { reqId, lines }); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  off();
  return acked;
}
```

---

## 7. 性能与精度策略

**精度策略（§1 原则的落地清单）**

| 项 | 策略 |
|---|---|
| 图像输入 | 物理像素原图直出；PNG 无损；永不放大 |
| 语言 | Win: zh-CN 引擎 + ASCII 占比 >70% 且系统可用时切 en-US；mac: `["zh-Hans","en-US"]` |
| 引擎档位 | mac 强制 accurate；Win 无档位概念，受系统语言模型质量约束（Win11 优于 Win10，写入验收说明） |
| 语言纠正 | mac 开启 usesLanguageCorrection；「原样输出」开关放 v1.1 |
| 暗底反白 | 默认不处理；样张不达标才启用「反色双跑取优」预案（§10） |
| 多栏/复杂版面 | 引擎按版面输出行序；识别错乱时引导用户用框选缩小范围（产品文案） |

**性能预期（原生引擎，i5/M1 级）**

| 场景 | 预期 |
|---|---|
| 首次点击 | 引擎已随进程预热，≤1s 出结果（含 PNG 编码 + IPC） |
| 常规 UI 选区（<1M px） | 0.3~1.2s（Win）/ 0.5~2s（mac accurate） |
| 预处理（裁剪+PNG 编码） | <30ms（仅无损操作） |
| 内存增量 | ≈0（无常驻 worker；引擎对象进程级单例） |
| 进度反馈 | 原生引擎无进度回调 → 浮层显示转圈 + 已耗时秒数，超 30s 报失败 |

IPC 说明：区域 PNG 经临时文件传路径（沿用整屏图既有通道），单次 IPC 只传路径字符串，无大 base64 风险。

---

## 8. 交互细节与边界

> 与 v1 一致的条目不再重复，仅列变化与新增。

| 场景 | 行为 |
|---|---|
| 系统语言包缺失（Win） | `ocr_status` 探测 → 按钮点击后 toast「系统未安装中文识别语言包」+ 设置面板展示安装指引（设置 → 时间和语言 → 语言 → 添加中文）；英文包可用时英文截图不受影响 |
| 识别进行中 | 按钮转 loading；再次点击无效；框选模式不可进入 |
| 转待办无 ack | 3 次重试后 toast「添加失败，请重试」——不复现「点了没反应」的静默丢失 |
| 主窗被覆盖层遮挡 | 转待办成功后主窗侧闪任务栏提示（FlashWindow 或标题徽标，T7 决定），避免用户无感知 |
| 池窗复用竞态 | pin-set 重初始化 → reject 进行中的识别（前端以 runId 代际号判定丢弃过期结果） |
| 隐私 | 识别结果只存内存（浮层关闭即丢），不落盘、不进 localStorage、不上云；临时 PNG 复用截图临时文件的既有清理策略 |

---

## 9. 开发任务拆解与工时预估（详细版）

### 9.0 阶段总览与关键路径

```
阶段一 Rust 引擎层        阶段二 前端基础          阶段三 窗口集成           阶段四 验收
T0 骨架(0.5d) ──┬─ T1 Win(1d) ──┐
                └─ T2 mac(1d) ──┴─ T3 调用链+浮层(1d) ─ T4 转待办桥(0.5d) ─┬─ T5 覆盖层(1d) ─┐
                                                                       ├─ T6 贴图(1.5d) ─┼─ T8 验收(1d)
                                                                       └─ T7 设置+反馈(0.5d)┘
```

- **关键路径**：T0 → T1 → T3 → T5/T6 → T8。T2 与 T1 并行（受 mac 构建机约束，尽早排期）；T4 依赖 T3；T5/T6 可并行；T7 依赖 T1+T4。
- **合计基线：8 人日**；预案缓冲另列（§9.4），触发时按需追加。

### 9.1 阶段一：Rust 引擎层（2.5d）

**T0 Rust OCR 模块骨架 — 0.5d**

| 子任务 | 内容 | 涉及文件 |
|---|---|---|
| T0.1 | `OcrLine`/`OcrResult`/`OcrStatus`/`OcrBackend` trait 定义（§4.1 契约） | `src-tauri/src/ocr.rs`（新建） |
| T0.2 | AppState 挂载 backend 单例（`Mutex<Option<Box<dyn OcrBackend>>>`） | ocr.rs、screenshot.rs |
| T0.3 | 命令 `ocr_recognize`（**async + spawn_blocking 包裹阻塞识别**，风险整改 N1）、`ocr_status` | ocr.rs |
| T0.4 | 路径白名单校验（沿用 `read_capture_png` 模式，扩展接受 `ticktask_ocr_*.png`） | ocr.rs |
| T0.5 | 临时文件规范：`save_image` 落盘目录确认为临时目录；OCR 侧文件名唯一后缀防并发撞名（N3）；识别完成即删 | ocr.rs、screenshot.rs |
| T0.6 | 命令注册 + mod 声明 + shotLog 埋点 | lib.rs（注册处） |

**DoD**：cargo check 通过；用假 backend（返回固定两行）从前端 invoke 打通全链路；两条命令在 devtools 可手动调用。
**依赖**：无（最先启动）。

**T1 Windows 后端（Windows.Media.Ocr）— 1d**

| 子任务 | 内容 |
|---|---|
| T1.1 | Cargo.toml 加 `windows` crate（仅 `cfg(windows)`，features：`Media_Ocr`/`Globalization`/`Graphics_Imaging`/`Storage_Streams`/`Foundation`） |
| T1.2 | 解码链：PNG bytes → InMemoryRandomAccessStream → BitmapDecoder → SoftwareBitmap → Convert Bgra8 |
| T1.3 | 引擎创建策略：zh-CN 显式创建 → UserProfileLanguages 回退 → NotAvailable；ASCII 启发式切 en-US 做成独立函数（先接 zh-CN 主路径，启发式开关默认关） |
| T1.4 | 引擎单例预热：后台线程 COM(MTA) 初始化 → 创建引擎 → OnceLock 缓存；识别走 Mutex 串行 |
| T1.5 | 行结果组装：line.Text + Words BoundingRect 并集为行框；行序保持引擎返回顺序 |
| T1.6 | `OcrEngine::MaxImageDimension` 尺寸守卫（超限等比缩小，结果附 scaled 标记） |
| T1.7 | `ocr_status`：探测 zh-CN / en-US 包可用性与可读原因文案 |

**DoD**：Win10/Win11 各 3 张样张冒烟通过；二次调用无重复引擎激活；预热后首次识别 <1s；缺包机器上 status 返回明确指引文案。
**依赖**：T0。

**T2 macOS 后端（Vision）— 1d（需 mac 构建机，尽早锁定机器）**

| 子任务 | 内容 |
|---|---|
| T2.1 | Cargo.toml 加 `objc2`/`objc2-vision`/`objc2-foundation`（仅 mac target） |
| T2.2 | PNG bytes → CGImage 解码 |
| T2.3 | VNRecognizeTextRequest：accurate + `["zh-Hans","en-US"]` + usesLanguageCorrection；handler.perform |
| T2.4 | observation → 行文本 + confidence + boundingBox 归一化还原为物理像素（**y 轴翻转必验**） |
| T2.5 | 尺寸守卫：长边 > 6000px 等比缩小 |
| T2.6 | `ocr_status`：macOS 10.15+ 可用性探测 |

**DoD**：mac 3 张样张冒烟通过；坐标还原与屏幕位置逐点比对正确；accurate 档确认生效。
**依赖**：T0；与 T1 并行。

### 9.2 阶段二：前端基础设施（1.5d）

**T3 前端调用链 + 结果浮层 — 1d**

| 子任务 | 内容 | 涉及文件 |
|---|---|---|
| T3.1 | `prepare.ts`：base canvas 物理像素区域裁剪 + PNG 编码（**纯无损，无二值化/无放大**） | `src/screenshot/ocr/prepare.ts`（新） |
| T3.2 | `ocrClient.ts`：recognizeRegion（saveImage 写临时文件 → ocr_recognize）+ **大区域守卫：base64 > 8MB 时 toast 引导框选更小区域**（N2）+ 耗时埋点 | `src/screenshot/ocr/ocrClient.ts`（新） |
| T3.3 | `OcrResultPanel.tsx`：行列表、复制全部、双击复制单行（走 clipboard.ts 封装 + toast）、单行/全部转待办按钮、识别中「转圈 + 已耗时 Ns」、空结果不弹层只 toast | `OcrResultPanel.tsx`（新） |
| T3.4 | 噪音行过滤：单字符且行高 < 10px 物理像素的行剔除（启发式常量可调，N4） | OcrResultPanel.tsx |
| T3.5 | `ocr.css`：对齐 screenshot.css 既有设计语言（浮层圆角/行 hover 高亮/按钮/浅色深色适配） | `src/screenshot/ocr/ocr.css`（新） |

**DoD**：覆盖层内手动触发全链路出结果；复制/转待办按钮事件可观测；大图守卫可演示。
**依赖**：T0 命令就绪；真识别依赖 T1（可先接假 backend 开发 UI，与 T1 并行推进）。

**T4 转待办事件桥 + 主窗接入 — 0.5d**

| 子任务 | 内容 | 涉及文件 |
|---|---|---|
| T4.1 | `ocrBridge.ts`：emitOcrCreateTask（reqId + **3 次重试 + ack 应答**，复用项目 pin-set「重发+应答」模式） | `src/screenshot/ocr/ocrBridge.ts`（新） |
| T4.2 | App.tsx 注册监听（useEffect）→ 逐行 `addTask(listId, text)`（签名见 useTaskStore.ts L448）→ ack 回执 → 成功/失败 toast | `src/App.tsx`（约 30 行） |
| T4.3 | 免费额度/会员校验路径复用确认（FREE_DAILY_TASK_LIMIT / MEMBER_ONLY_TIP，不旁路） | App.tsx |

**DoD**：转待办任务出现在主窗当前账号清单（账号隔离自动成立）；模拟主窗不可达 → 3 次重试后浮层提示「添加失败，请重试」。
**依赖**：T3。

### 9.3 阶段三：窗口集成（3d）

**T5 覆盖层集成 — 1d（含回归）**

| 子任务 | 内容 |
|---|---|
| T5.1 | 操作条新增「识别文字」按钮（顺序：贴图/识别文字/保存/取消/复制；barRef 实测宽度机制自动适配）+ busy 门控 |
| T5.2 | ocr 状态机（idle/running/done）+ 代际号丢弃过期结果 |
| T5.3 | Esc 层级：浮层开 → 仅关浮层；再 Esc → 取消截图（插在现有 onKey 分支最前，不动原逻辑） |
| T5.4 | finish() 复位 ocr 状态；识别中禁止再框选/确认/重复点击 |
| T5.5 | OCR 输入只取 base 层（extractBasePng，不含标注/马赛克——马赛克区域不被识别，防泄露） |
| T5.6 | **回归清单全过**：复制（含 Ctrl+C/Enter）/贴图/保存（含取消对话框）/窗口模式/手柄调整/选区平移/全部标注工具/撤销清空/放大镜/右键取消/finish 无闪屏 |

**侵入约束**：OCR UI 全部独立子组件；对 CaptureOverlay.tsx 的改动收敛为「一个按钮 + 一个状态分支 + 一个 Esc 前置分支」。遵守「只改提及内容」惯例。
**依赖**：T3。

**T6 贴图集成 — 1.5d（含回归）**

| 子任务 | 内容 |
|---|---|
| T6.1 | PinContextMenu 组件：右键菜单（识别文字/复制图片/关闭进历史/销毁）；contextmenu preventDefault；锁定态禁用识别项；穿透态收不到鼠标天然无入口 |
| T6.2 | 框选模式：全屏遮罩 + crosshair + 拖拽选框 + 尺寸提示 + Esc 取消（复用截图选框样式） |
| T6.3 | 缩放坐标映射：`sx = rect.x * (naturalWidth / clientWidth)`（贴图经滚轮/角柄缩放后仍正确） |
| T6.4 | 互斥屏蔽：框选/浮层期间清零 lastClickRef（屏蔽双击关闭）、屏蔽拖拽与滚轮缩放 |
| T6.5 | 池窗复用竞态：pin-set 重初始化时强制退出框选/浮层 + 代际号丢弃悬挂识别 |
| T6.6 | **回归清单全过**：拖拽移动/滚轮缩放/角柄缩放/双击关闭/锁定/穿透与控制条/历史恢复/多贴图并存 |

**依赖**：T3；可与 T5 并行。

**T7 设置面板探测 + 主窗反馈 — 0.5d**

| 子任务 | 内容 |
|---|---|
| T7.1 | ScreenshotSettingsPanel 加 OCR 状态区：`ocr_status` 展示（zh-CN 可用 ✓ / 缺失 + 安装指引文案） |
| T7.2 | （可选）一键装包按钮：UAC 提权执行 `Add-WindowsCapability -Online -Name "Language.OCR~~~zh-CN~0.0.1.0"`，失败降级为纯文案指引。时间紧可裁剪，纯指引已可关闭 R1 主要伤害 |
| T7.3 | 主窗转待办成功可见反馈（任务栏闪烁/标题徽标，防止被覆盖层遮挡无感知） |

**依赖**：T1（status）、T4（反馈）。

### 9.4 阶段四：双平台验收与调优 — 1d

| 子任务 | 内容 |
|---|---|
| T8.1 | 样张集制作：15 张真实截图（ClearType 小字×3 / 暗底反白×3 / 中英混排×3 / 密集表格代码×3 / 常规正文×3），存 `docs/ocr-samples/` 便于回归复用 |
| T8.2 | 双平台实测：准确率 / 行序 / 耗时逐张记录，对照 §11 硬门槛（整集 ≥95%、小字组 ≥90%） |
| T8.3 | 性能验收：首次 ≤1s、常规 Win ≤1.2s / mac ≤2s、内存无增量、临时文件无泄漏 |
| T8.4 | 全场景回归：100%/125%/150% DPI、多屏混合 DPI、6 贴图并存 + OCR、断网全流程 |
| T8.5 | 不达标时执行预案（工时另计，见 §9.5） |

### 9.5 工时汇总与预案缓冲

| 阶段 | 任务 | 工时 |
|---|---|---|
| 一 Rust 引擎层 | T0 + T1 + T2 | 2.5d |
| 二 前端基础 | T3 + T4 | 1.5d |
| 三 窗口集成 | T5 + T6 + T7 | 3d |
| 四 验收 | T8 | 1d |
| **基线合计** | | **8 人日** |

**预案缓冲（不占用基线，T8 触发时按需追加）**：

| 预案 | 触发条件 | 追加工时 |
|---|---|---|
| 暗底检测 → 反色双跑取优 | 暗底样张组准确率 <90% | +0.5d |
| 小字 2x Lanczos 放大 A/B | 小字号组 <90%（验证通过后改为条件策略） | +0.5d |
| T7.2 一键装包完整实现 | 产品要求从「指引」升级为「一键」 | +0.5d |
| 「原样输出」开关提前 | T8.2 发现代码/编号被语言纠正改写 | +0.5d |

**排期风险提示**：T2 依赖 mac 构建机与 mac 实机验收环境，若机器排期滞后，Win 侧可先行至 T8（Win 单平台达标），mac 侧后补验收——两平台验收结论独立出。

---

## 10. 风险与对策（v2.0 按原生路线重评）

| 风险 | 等级 | 对策 |
|---|---|---|
| **R1 Windows 系统语言包缺失**（zh-CN 非用户语言时 Media.Ocr 不可用或降级 en） | 中（国内用户默认带中文包，风险集中在国内非中文系统/海外用户） | `ocr_status` 启动探测 + 设置面板可见状态 + 点击时精确报错与安装指引；en 包兜底保证英文场景可用 |
| **R2 Win Media.Ocr 精度上限**（弱于 mac Vision；小字号/密集文本不如 Vision；个别暗底反白场景偏弱） | 中 | 样张验收硬门槛卡住；预案 A：暗底检测→反色双跑取优（非默认）；预案 B：极端样张失败时对该区域降级调 tesseract **标准版**模型（仅作技术储备，不进本期范围）；产品侧预期管理：Win10 与 Win11 的系统模型质量有差异 |
| **R3 Rust↔WinRT/macOS FFI 细节坑**（COM 线程模型、SoftwareBitmap 编码格式、Vision 坐标翻转、objc2 API 版本） | 中 | T1/T2 骨架先行 + 每个平台各 3 张样张冒烟通过才继续；API 细节以 T1/T2 实测校准为准（本方案骨架已标注必验点） |
| **R4 识别中窗口复用/关闭的竞态** | 低 | 代际号（runId）丢弃过期结果；dismiss 时 reject 悬挂 promise |
| **R5 语言纠正改变原文字符**（mac usesLanguageCorrection 可能"修正"密码/乱码/编号） | 低 | v1.1 浮层加「原样输出」开关（临时关闭 correction 重跑一次）；当前版本文案提示 |
| **R6 临时 PNG 文件泄漏/清理** | 低 | 沿用截图临时文件既有清理策略 + 识别完成即删；T8 验证 |
| **R7 改动两个刚修稳的高危前端文件** | 中 | OCR UI 全部独立子组件，侵入压缩到「一个按钮 + 一个分支 + 一个互斥标志」；T5/T6 各配回归清单；遵守「只改提及内容」惯例 |
| **R8 mac 构建链复杂度**（objc2 系 crate 引入） | 低 | 项目本就双平台发布；crate 均为主流维护；T2 失败兜底：mac 端改走 Swift 小目标 + CLI 调用（技术储备，不预期使用） |

v1 遗留风险的状态：tesseract.js 相关全部消除（精度 R1、打包 R3、内存 R4、WKWebView 兼容 R8 均随选型切换消失）。

**Backlog（本期不做）**：行框映射原图高亮、OCR 历史记录、「原样输出」开关、tesseract 标准版作为可选精修引擎、表格/竖排文本专项优化。

---

## 11. 验收标准

**精度（硬门槛，样张集 15 张，双平台各自跑）**

样张集构成（真实场景截图，非合成）：
1. ClearType 小字号（12~14px 逻辑字号）中文 UI 文字 ×3
2. 暗底反白（深色主题编辑器/终端）×3
3. 中英混排（网页正文、聊天窗口）×3
4. 密集文本（表格、代码块）×3
5. 常规正文（14~18px）×3

指标：整集字符级加权准确率 ≥95%；ClearType 小字号组 ≥90%；行序错乱率 ≤1 行/张。**任一门限不达标则不进入发布流程**，先走 §10 预案。

**功能**
1. 截图选区「识别文字」出结果浮层；复制全部 / 双击复制单行 / 单行转待办 / 全部转待办可用
2. 贴图右键「识别文字」+ 自由框选可用（含缩放后坐标正确映射）
3. 转待办进入当前账号清单，免费额度/会员提示不旁路；无 ack 时有可见失败提示
4. 全流程离线（断网可用）；语言包不随应用分发（系统提供）
5. 既有交互零回退（§9 T5/T6 回归清单全过）

**性能**
1. 首次点击 ≤1s；常规选区 Win ≤1.2s / mac ≤2s
2. 预处理不卡 UI（<30ms）；内存无常驻增量
3. 临时文件无泄漏（识别后即删）
