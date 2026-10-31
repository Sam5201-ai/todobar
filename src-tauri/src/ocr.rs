//! OCR 文字识别(离线)。
//!
//! 选型(精度优先,POC 实测对比驱动):
//! - **首选 PP-OCRv4**(本地神经网络模型,det+rec,模型 ~15MB 以 include_bytes 内置):
//!   同样样张上对系统引擎的主要痛点(小字丢字、形近字 ml/丨、表格边框沾染)全面
//!   占优,POC 中「哈尔滨啤酒瓶装250ml」100% 全对(系统引擎丢「啤」+ 250m丨)。
//! - 回退:Windows.Media.Ocr / macOS Vision(系统引擎),PP-OCR 加载或推理失败时自动降级。
//!
//! 线程模型:识别为 CPU 密集阻塞操作,统一走 spawn_blocking;session/引擎对象
//! 进程级单例缓存(预热在 setup 阶段后台线程提前完成)。
//!
//! 输入契约:前端先把区域 PNG 写入临时文件(ticktask_ocr_*.png),识别命令
//! 只接收路径,避免大 base64 走 IPC(整屏图撑爆 WebView 的既有教训)。

use serde::Serialize;
use std::sync::{Mutex, OnceLock};

/// 单行识别结果。bbox 为原图物理像素坐标(行框),供前端预留/框选定位。
#[derive(Debug, Clone, Serialize)]
pub struct OcrLine {
    pub text: String,
    /// 置信度(macOS Vision 提供;Windows Media.Ocr API 不暴露 → None)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<OcrBox>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct OcrBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
    /// "windows-media-ocr" / "macos-vision",日志与诊断用。
    pub engine: String,
    /// 实际使用的识别语言(如 "zh-CN")。
    pub language: String,
}

/// 系统能力探测结果(设置面板展示;语言包缺失时 message 给出可读指引)。
#[derive(Debug, Clone, Serialize)]
pub struct OcrStatus {
    pub available: bool,
    pub engine: String,
    pub zh_available: bool,
    pub en_available: bool,
    pub warmed: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// 临时文件:前端区域 PNG 的唯一合法入口(文件名自产,杜绝任意路径写入)
// ---------------------------------------------------------------------------

static OCR_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 区域 PNG → 临时文件,返回路径。识别命令只接受本函数产出的文件名。
#[tauri::command]
pub fn ocr_save_input(png_base64: String) -> Result<String, String> {
    let bytes = b64_decode(&png_base64)?;
    if bytes.is_empty() {
        return Err("OCR 输入为空".into());
    }
    let seq = OCR_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("ticktask_ocr_{}_{seq}.png", std::process::id()));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 OCR 临时文件失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 路径白名单:仅接受 ticktask_ocr_*.png(沿用 read_capture_png 的校验模式)。
fn validate_ocr_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "非法的 OCR 输入路径".to_string())?;
    if !name.starts_with("ticktask_ocr_") || !name.ends_with(".png") {
        return Err("非法的 OCR 输入文件".into());
    }
    Ok(p.to_path_buf())
}

/// 识别结果缓存:同一张图(字节级一致)重复识别直接命中。
/// 贴图场景的关键兜底:窗口可能在识别完成前被关闭(WebView 销毁会杀死
/// pending invoke,前端日志随之消失),但 Rust 侧 spawn_blocking 仍会算完
/// 并入库 → 用户再钉同一张图时文字层瞬时出现,而不是再次等 1s+ 推理。
/// 只缓存成功结果;容量极小,新条目插头、超限淘汰尾条。
static RESULT_CACHE: OnceLock<Mutex<Vec<(u64, OcrResult)>>> = OnceLock::new();
const RESULT_CACHE_CAP: usize = 16;
/// 识别管线版本:混入缓存键。管线变更(预处理/模型/解码)后 +1,
/// 旧结果自动失效 —— 否则重测同一张图永远命中修复前的旧缓存,
/// 表现为「修了没生效」的假象(2026-10-31 排查 rec 漏字时引入)。
const RECOGNIZE_PIPELINE_VERSION: u64 = 2;

fn cache_key(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    RECOGNIZE_PIPELINE_VERSION.hash(&mut h);
    bytes.hash(&mut h);
    h.finish()
}

fn cache_get(key: u64) -> Option<OcrResult> {
    RESULT_CACHE
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .ok()?
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, r)| r.clone())
}

fn cache_put(key: u64, r: OcrResult) {
    if let Ok(mut g) = RESULT_CACHE.get_or_init(|| Mutex::new(Vec::new())).lock() {
        g.retain(|(k, _)| *k != key);
        g.insert(0, (key, r));
        g.truncate(RESULT_CACHE_CAP);
    }
}

/// 识别(异步:阻塞实现放 spawn_blocking,避免卡 IPC 线程池)。
#[tauri::command]
pub async fn ocr_recognize(path: String) -> Result<OcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = validate_ocr_path(&path)?;
        let bytes = std::fs::read(&p).map_err(|e| format!("读取 OCR 输入失败: {e}"))?;
        let t0 = std::time::Instant::now();
        let key = cache_key(&bytes);
        if let Some(r) = cache_get(key) {
            // 注意:本应用 RustLog 只落盘 Warn 及以上,诊断必须直写 app.log。
            crate::append_app_log(&format!(
                "[ocr] cache hit lines={} {}ms bytes={}",
                r.lines.len(),
                t0.elapsed().as_millis(),
                bytes.len()
            ));
            let _ = std::fs::remove_file(&p);
            return Ok(r);
        }
        // Rust 侧留痕:贴图窗口可能在识别完成前被关闭(前端日志随 WebView
        // 销毁一起丢失,表现为零日志静默),只有这里能证明识别真实发生与耗时。
        crate::append_app_log(&format!("[ocr] recognize start bytes={}", bytes.len()));
        let r = imp::recognize(&bytes);
        match &r {
            Ok(res) => {
                crate::append_app_log(&format!(
                    "[ocr] recognize done lines={} {}ms",
                    res.lines.len(),
                    t0.elapsed().as_millis()
                ));
                // 逐行内容留痕:定位「识别文本缺字/多字」类问题(如粗体混排行漏识
                // 尾段 → 文字层 scaleX 拉伸铺满 bbox,蓝块全宽但复制缺字)必须有
                // 每行真实 text 与 bbox 才能定论,数量日志不够。
                for (i, l) in res.lines.iter().enumerate() {
                    crate::append_app_log(&format!(
                        "[ocr]   line[{i}] {:?} bbox={:?} conf={:?}",
                        l.text,
                        l.bbox,
                        l.confidence.map(|c| (c * 100.0).round() / 100.0),
                    ));
                }
            }
            Err(e) => crate::append_app_log(&format!(
                "[ocr] recognize failed {}ms: {e}",
                t0.elapsed().as_millis()
            )),
        }
        if let Ok(res) = &r {
            cache_put(key, res.clone());
        }
        // 识别完即删临时文件(含失败场景),避免残留泄漏。
        let _ = std::fs::remove_file(&p);
        r
    })
    .await
    .map_err(|e| format!("OCR 线程异常: {e}"))?
}

/// 系统能力探测(设置面板 + 缺包精确报错)。
#[tauri::command]
pub async fn ocr_status() -> OcrStatus {
    tauri::async_runtime::spawn_blocking(imp::status)
        .await
        .unwrap_or_else(|e| OcrStatus {
            available: false,
            engine: "unavailable".into(),
            zh_available: false,
            en_available: false,
            warmed: false,
            message: format!("OCR 状态探测失败: {e}"),
        })
}

/// 进程启动预热(Win 端 WinRT 引擎激活 ~100-300ms,提前完成;mac 为轻量空操作)。
pub fn warmup_async() {
    std::thread::Builder::new()
        .name("ocr-warmup".into())
        .spawn(imp::warmup)
        .ok();
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 解码失败: {e}"))
}

// ---------------------------------------------------------------------------
// Windows 实现:Windows.Media.Ocr
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::{OcrBox, OcrLine, OcrResult, OcrStatus};
    use std::sync::{Mutex, OnceLock};

    use windows::core::HSTRING;
    use windows::Foundation::Rect;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_MULTITHREADED,
    };

    /// 进程级引擎单例:预热/识别共用,避免每次识别重复 WinRT 激活。
    static ENGINE: OnceLock<Mutex<Option<CachedEngine>>> = OnceLock::new();

    #[derive(Clone)]
    struct CachedEngine {
        engine: OcrEngine,
        tag: String,
    }

    fn engine_cell() -> &'static Mutex<Option<CachedEngine>> {
        ENGINE.get_or_init(|| Mutex::new(None))
    }

    /// WinRT 需要 COM 单元;识别线程池线程逐次初始化(幂等)。
    fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    /// 创建识别引擎:基于系统实际可用的 OCR 语言列表选择
    /// (简中 > 其他中文 > 英文 > 其他),失败回退用户配置语言。
    /// 注意:不能只盲猜 "zh-CN" 标签 —— 多数中文系统安装的是 "zh-Hans-CN",
    /// TryCreateFromLanguage 对标签精确匹配,猜错会白白错过可用引擎。
    fn try_create_engine() -> Result<(OcrEngine, String), String> {
        if let Ok(avail) = OcrEngine::AvailableRecognizerLanguages() {
            let mut tags: Vec<String> = Vec::new();
            if let Ok(size) = avail.Size() {
                for i in 0..size {
                    if let Ok(l) = avail.GetAt(i) {
                        if let Ok(tag) = l.LanguageTag() {
                            tags.push(tag.to_string());
                        }
                    }
                }
            }
            tags.sort_by_key(|t| {
                let t = t.to_ascii_lowercase();
                if t.starts_with("zh-hans") || t.starts_with("zh-cn") {
                    0
                } else if t.starts_with("zh") {
                    1
                } else if t.starts_with("en") {
                    2
                } else {
                    3
                }
            });
            for tag in tags {
                if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag.as_str())) {
                    if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                        return Ok((engine, tag));
                    }
                }
            }
        }
        if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
            let tag = engine
                .RecognizerLanguage()
                .ok()
                .and_then(|l| l.LanguageTag().ok())
                .map(|t| t.to_string())
                .unwrap_or_else(|| "user-profile".into());
            return Ok((engine, tag));
        }
        Err("系统未安装可用的 OCR 语言包,请在 设置→时间和语言→语言 中添加中文语言包".into())
    }

    /// 取缓存引擎,未就绪则同步创建(预热失败时的兜底)。
    fn ensure_engine() -> Result<(OcrEngine, String), String> {
        if let Some(c) = engine_cell().lock().ok().and_then(|g| g.clone()) {
            return Ok((c.engine, c.tag));
        }
        let (engine, tag) = try_create_engine()?;
        if let Ok(mut g) = engine_cell().lock() {
            *g = Some(CachedEngine {
                engine: engine.clone(),
                tag: tag.clone(),
            });
        }
        Ok((engine, tag))
    }

    pub fn warmup() {
        com_init();
        // PP-OCR session 加载(det+rec 模型 ~15MB 反序列化)提前完成,首次识别零等待。
        super::ppocr::warmup();
        if let Err(e) = ensure_engine() {
            log::warn!("[ocr] 引擎预热失败(首次识别时将重试): {e}");
        } else {
            log::info!("[ocr] Windows.Media.Ocr 引擎预热完成");
        }
    }

    pub fn status() -> OcrStatus {
        com_init();
        // 基于系统实际可用 OCR 语言列表判定(zh-Hans-CN / zh-CN / en-* 等均计入)。
        let mut zh = false;
        let mut en = false;
        if let Ok(avail) = OcrEngine::AvailableRecognizerLanguages() {
            if let Ok(size) = avail.Size() {
                for i in 0..size {
                    if let Ok(l) = avail.GetAt(i) {
                        if let Ok(tag) = l.LanguageTag() {
                            let t = tag.to_string().to_ascii_lowercase();
                            if t.starts_with("zh") {
                                zh = true;
                            } else if t.starts_with("en") {
                                en = true;
                            }
                        }
                    }
                }
            }
        }
        let warmed = engine_cell()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        // PP-OCRv4(模型内置中文)就绪与否决定 engine 标识与 zh 可用性:
        // 就绪 → 恒可用(不依赖系统语言包);未就绪 → 回退系统引擎按语言包判定。
        let ppocr_ready = super::ppocr::is_ready();
        let available = ppocr_ready || zh || en || warmed;
        let message = if available {
            String::new()
        } else {
            "系统未安装中文 OCR 语言包:设置 → 时间和语言 → 语言 → 添加中文(简体)".into()
        };
        OcrStatus {
            available,
            engine: if ppocr_ready { "ppocr-v4" } else { "windows-media-ocr" }.into(),
            zh_available: ppocr_ready || zh,
            en_available: en,
            warmed,
            message,
        }
    }

    /// PNG bytes → 内存流 → BitmapDecoder → SoftwareBitmap(Bgra8,原生无损解码)。
    fn software_bitmap_from_png(
        png: &[u8],
    ) -> Result<SoftwareBitmap, String> {
        let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
        writer
            .WriteBytes(png)
            .map_err(|e| format!("写入解码流失败: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        writer
            .FlushAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        // Detach 防止 writer 关闭连带影响底层流;原流对象继续用于随机访问解码。
        let _ = writer.DetachStream();
        drop(writer);
        stream.Seek(0).map_err(|e| e.to_string())?;

        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        // Media.Ocr 规范输入:Bgra8(无损转换,保持原始像素信息,不做任何增强)。
        decoder
            .GetSoftwareBitmapConvertedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Premultiplied,
            )
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())
    }

    /// 罕见路径:超过引擎上限(MaxImageDimension,运行时读取)→ image crate
    /// 等比缩小(Lanczos3)后重新解码。永不放大。
    fn scale_png(png: &[u8], max_dim: u32) -> Result<Vec<u8>, String> {
        let img = image::load_from_memory(png).map_err(|e| format!("解码 PNG 失败: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let scale = max_dim as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale) as u32).max(1);
        let nh = ((h as f32 * scale) as u32).max(1);
        let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
        let mut out = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| format!("重编码 PNG 失败: {e}"))?;
        Ok(out)
    }

    /// 小图放大:Media.Ocr 对尺寸过小的输入(实测高 ~40px 及以下)会返回空结果,
    /// 这是引擎内部管线的已知行为;且实测放大过度(5x/6x)反而劣化 —— 引擎甜区
    /// 在「放大后最小边 ~64-96px」。整数倍 Lanczos3 放大至最小边 ≥ 72px
    /// (倍数 clamp 2~4x,且保证长边不超引擎上限),仅对过小图触发。
    fn upscale_tiny_png(png: &[u8], max_dim: u32) -> Result<Option<Vec<u8>>, String> {
        let img = image::load_from_memory(png).map_err(|e| format!("解码 PNG 失败: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let min_side = w.min(h);
        if min_side >= 64 {
            return Ok(None);
        }
        let scale = (((72 + min_side - 1) / min_side) as u32).clamp(2, 4);
        // 长边不得因放大超过引擎上限(极端细长条:宁可放弃放大也不越限)。
        let cap = (max_dim / w.max(h)).max(1);
        let scale = scale.min(cap);
        if scale <= 1 {
            return Ok(None);
        }
        log::info!("[ocr] 输入 {w}x{h} 过小,{scale}x 放大后识别");
        let resized = img.resize_exact(w * scale, h * scale, image::imageops::FilterType::Lanczos3);
        let mut out = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| format!("重编码 PNG 失败: {e}"))?;
        Ok(Some(out))
    }

    fn png_to_software_bitmap(png: &[u8]) -> Result<SoftwareBitmap, String> {
        let sb = software_bitmap_from_png(png)?;
        let max_dim = OcrEngine::MaxImageDimension().unwrap_or(8192);
        // PixelWidth/Height 返回 i32,统一转 u32 与 MaxImageDimension(u32)比较。
        let w = sb.PixelWidth().map_err(|e| e.to_string())? as u32;
        let h = sb.PixelHeight().map_err(|e| e.to_string())? as u32;
        if w > max_dim || h > max_dim {
            log::info!("[ocr] 输入 {w}x{h} 超过引擎上限 {max_dim},等比缩小后重新解码");
            let scaled = scale_png(png, max_dim)?;
            return software_bitmap_from_png(&scaled);
        }
        if let Some(scaled) = upscale_tiny_png(png, max_dim)? {
            return software_bitmap_from_png(&scaled);
        }
        Ok(sb)
    }

    /// 识别入口:优先 PP-OCRv4(本地神经网络,精度显著优于系统引擎),
    /// 模型加载/推理失败时自动回退 Windows.Media.Ocr(含小图放大补偿)。
    pub fn recognize(png: &[u8]) -> Result<OcrResult, String> {
        com_init();
        match super::ppocr::recognize(png) {
            Ok(r) => Ok(r),
            Err(e) => {
                log::warn!("[ocr] PP-OCRv4 识别失败,回退系统引擎: {e}");
                recognize_media_ocr(png)
            }
        }
    }

    fn recognize_media_ocr(png: &[u8]) -> Result<OcrResult, String> {
        com_init();
        let sb = png_to_software_bitmap(png)?;
        let (engine, tag) = ensure_engine()?;

        // 逐行:文本 + 行框(Words 各矩形并集);行序保持引擎返回的阅读顺序。
        let mut lines = Vec::new();
        {
            let result = engine
                .RecognizeAsync(&sb)
                .map_err(|e| format!("OCR 识别失败: {e}"))?
                .get()
                .map_err(|e| format!("OCR 识别失败: {e}"))?;
            let win_lines = result.Lines().map_err(|e| e.to_string())?;
            for i in 0..win_lines.Size().map_err(|e| e.to_string())? {
                let line = win_lines.GetAt(i).map_err(|e| e.to_string())?;
                let text = line.Text().map_err(|e| e.to_string())?.to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let mut bbox: Option<OcrBox> = None;
                if let Ok(words) = line.Words() {
                    for j in 0..words.Size().unwrap_or(0) {
                        if let Ok(word) = words.GetAt(j) {
                            if let Ok(Rect { X, Y, Width, Height }) = word.BoundingRect() {
                                let b = bbox.unwrap_or(OcrBox {
                                    x: X,
                                    y: Y,
                                    w: Width,
                                    h: Height,
                                });
                                let x0 = b.x.min(X);
                                let y0 = b.y.min(Y);
                                let x1 = (b.x + b.w).max(X + Width);
                                let y1 = (b.y + b.h).max(Y + Height);
                                bbox = Some(OcrBox {
                                    x: x0,
                                    y: y0,
                                    w: x1 - x0,
                                    h: y1 - y0,
                                });
                            }
                        }
                    }
                }
                lines.push(OcrLine {
                    text,
                    confidence: None, // Media.Ocr 不暴露置信度
                    bbox,
                });
            }
        }
        Ok(OcrResult {
            lines,
            engine: "windows-media-ocr".into(),
            language: tag,
        })
    }
}

// ---------------------------------------------------------------------------
// macOS 实现:Vision VNRecognizeTextRequest(accurate 档)
//
// 注意:T2 在 mac 构建机首次编译时需校准 objc2 系 crate 的具体 API 签名
// (方案 §10-R3 已列);本实现按 objc2 0.6 / objc2-vision 0.3 常规用法编写,
// 所有调用集中在此文件,便于一次性修正。开发机为 Windows,此处无法编译验证。
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::{OcrBox, OcrLine, OcrResult, OcrStatus};

    pub fn warmup() {
        // Vision 无持久引擎对象,预热收益极低,空操作。
    }

    pub fn status() -> OcrStatus {
        OcrStatus {
            available: true,
            engine: "macos-vision".into(),
            zh_available: true, // 系统内置 zh-Hans 识别(10.15+)
            en_available: true,
            warmed: true,
            message: String::new(),
        }
    }

    pub fn recognize(png: &[u8]) -> Result<OcrResult, String> {
        use objc2::runtime::ProtocolObject;
        use objc2_foundation::{NSArray, NSData, NSString};
        use objc2_vision::{
            VNImageRequestHandler, VNRecognizeTextRequest, VNRequestProtocol,
            VNRequestTextRecognitionLevel,
        };

        unsafe {
            // PNG bytes 原样交给 Vision(handler 内部解码,不做任何预处理)。
            let data = NSData::with_bytes(png);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                None,
            );

            let req = VNRecognizeTextRequest::new();
            // 精度优先:强制 accurate 档,禁用 fast;开启语言纠正提升中文成句准确率。
            req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            req.setRecognitionLanguages(&NSArray::from_slice(&[
                NSString::from_str("zh-Hans"),
                NSString::from_str("en-US"),
            ]));
            req.setUsesLanguageCorrection(true);

            let requests: NSArray<ProtocolObject<dyn VNRequestProtocol>> =
                NSArray::from_slice(&[ProtocolObject::from_retained(&req)]);
            handler
                .performRequests_error(&requests)
                .map_err(|e| format!("Vision 识别失败: {e:?}"))?;

            let results = req
                .results()
                .ok_or_else(|| "Vision 未返回结果".to_string())?;
            // boundingBox 为归一化坐标(y 轴向上),需图像宽高还原;从 PNG 头直接解析。
            let (img_w, img_h) = png_dimensions(png)?;
            let mut lines = Vec::new();
            for obs in results.iter() {
                let cands = obs.topCandidates_count(1);
                let Some(cand) = cands.first() else { continue };
                let text = cand.string().to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let bb = obs.boundingBox();
                // 归一化(y 原点在底部)→ 物理像素(y 原点在顶部)。
                let x = (bb.origin.x * img_w).round();
                let y = ((1.0 - bb.origin.y - bb.size.height) * img_h).round();
                lines.push(OcrLine {
                    text,
                    confidence: Some(cand.confidence()),
                    bbox: Some(OcrBox {
                        x,
                        y,
                        w: (bb.size.width * img_w).round(),
                        h: (bb.size.height * img_h).round(),
                    }),
                });
            }
            Ok(OcrResult {
                lines,
                engine: "macos-vision".into(),
                language: "zh-Hans,en-US".into(),
            })
        }
    }

    /// 从 PNG 头解析宽高(ihdr 固定偏移 16/20,大端 u32)。
    fn png_dimensions(png: &[u8]) -> Result<(f32, f32), String> {
        if png.len() < 24 || &png[12..16] != b"IHDR" {
            return Err("非法 PNG".into());
        }
        let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]) as f32;
        let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]) as f32;
        Ok((w, h))
    }
}

// ---------------------------------------------------------------------------
// 其他平台占位
// ---------------------------------------------------------------------------

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::{OcrResult, OcrStatus};

    pub fn warmup() {}
    pub fn status() -> OcrStatus {
        OcrStatus {
            available: false,
            engine: "unavailable".into(),
            zh_available: false,
            en_available: false,
            warmed: false,
            message: "当前平台不支持本地 OCR".into(),
        }
    }
    pub fn recognize(_png: &[u8]) -> Result<OcrResult, String> {
        Err("当前平台不支持本地 OCR".into())
    }
}

// ---------------------------------------------------------------------------
// PP-OCRv4 本地神经网络 OCR(Windows,首选引擎)
//
// POC(C:\Temp\ocr-poc\full.mjs,JS/WASM)验证后 1:1 移植:
//   det: 长边 736 等比拉伸(尺寸取整 32)→ DB 概率图(阈值 0.3)→ 连通域
//        → bbox 外扩(unclip 1.8)→ 映射回原图坐标
//   rec: 逐框裁剪 → 高 48 等比缩放 → normalize((x/255-0.5)/0.5) → CTC 贪心解码
// 模型 ~15MB 以 include_bytes 内置,不依赖文件路径;onnxruntime 走 load-dynamic
// 加载随包分发的 DLL(找不到 → 引擎不可用,自动回退系统 OCR,功能不中断)。
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod ppocr {
    use super::{OcrBox, OcrLine, OcrResult};
    use image::imageops::FilterType;
    use ort::environment::Environment;
    use ort::session::builder::GraphOptimizationLevel;
    use ort::session::Session;
    use ort::value::Tensor;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    static DET_ONNX: &[u8] = include_bytes!("../assets/ocr/ch_PP-OCRv4_det_infer.onnx");
    static REC_ONNX: &[u8] = include_bytes!("../assets/ocr/ch_PP-OCRv4_rec_infer.onnx");
    static KEYS: &str = include_str!("../assets/ocr/ppocr_keys_v1.txt");

    /// det 输入长边上限(PP-OCR 官方默认)。
    const DET_SIDE: f32 = 736.0;
    /// DB 概率图二值化阈值(官方默认 0.3)。
    const DB_THRESHOLD: f32 = 0.3;
    /// bbox 外扩系数(POC 实测 1.8;过小丢边缘笔画,过大沾邻框)。
    const DB_UNCLIP_RATIO: f32 = 1.8;
    /// rec 输入高度(PP-OCRv4 固定 48)。
    const REC_H: u32 = 48;

    struct Engine {
        det: Session,
        rec: Session,
        /// CTC 字典:6623 项,索引 i 对应模型类别 i+1(0=blank,C-1=空格)。
        dict: Vec<String>,
    }

    /// None = 初始化失败(缓存,避免每次识别反复试加载)。
    /// Session::run 需要 &mut,Engine 整体放 Mutex 串行化(识别本就走 spawn_blocking)。
    static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
    static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
    /// onnxruntime.dll 预载标记(带正确 DLL 搜索 flags,见 ort_env 内注释)
    static PRELOADED_ORT: OnceLock<Result<(), String>> = OnceLock::new();

    /// onnxruntime.dll 搜索:dev 时 cwd=src-tauri(仓库内);打包后资源落 exe 旁。
    fn ort_lib_path() -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("onnxruntime").join("onnxruntime.dll"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("onnxruntime").join("onnxruntime.dll"));
                candidates.push(dir.join("onnxruntime.dll"));
            }
        }
        candidates.into_iter().find(|p| p.is_file())
    }

    /// load-dynamic:进程级 Environment 一次,显式指定随包 DLL 路径。
    fn ort_env() -> Result<Environment, String> {
        ENV.get_or_init(|| {
            let path = ort_lib_path().ok_or_else(|| {
                "未找到 onnxruntime.dll(src-tauri/onnxruntime/ 随包资源缺失)".to_string()
            })?;
            // libloading 0.9 的 Library::new 用 flags=0(标准搜索顺序:exe 目录→System32→…),
            // 依赖 MSVCP140/VCRUNTIME140 会落到 System32 的老版本(部分机器是 2016 版),
            // 与随包新版混载会 0xC0000005。先按 DLL_LOAD_DIR|DEFAULT_DIRS 预载:
            // 依赖从 DLL 自身目录(app-local 新版运行库)解析;ort 随后 LoadLibrary 同一
            // 绝对路径时只会复用已加载模块,不再触发 flags=0 的重新解析。
            PRELOADED_ORT
                .get_or_init(|| {
                    unsafe {
                        libloading::os::windows::Library::load_with_flags(
                            &path,
                            libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                                | libloading::os::windows::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                        )
                    }
                    .map(|lib| {
                        // 保持引用计数,模块常驻;ort 的加载会再叠一层引用
                        std::mem::forget(lib);
                    })
                    .map_err(|e| format!("onnxruntime 预载失败({}): {e}", path.display()))
                })
                .clone()?;
            let env = ort::init_from(&path)
                .map_err(|e| format!("onnxruntime 加载失败({}): {e}", path.display()))?
                .build()
                .map_err(|e| format!("onnxruntime 初始化失败: {e}"))?;
            log::info!("[ocr] onnxruntime 已加载: {}", path.display());
            Ok(env)
        })
        .clone()
    }

    pub fn warmup() {
        if let Err(e) = ensure_engine() {
            log::warn!("[ocr] PP-OCRv4 不可用(将回退系统引擎): {e}");
        } else {
            log::info!("[ocr] PP-OCRv4 模型预热完成");
        }
    }

    pub fn is_ready() -> bool {
        ENGINE
            .get()
            .and_then(|m| m.lock().ok())
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    fn ensure_engine() -> Result<&'static Mutex<Option<Engine>>, String> {
        let env = ort_env()?;
        Ok(ENGINE.get_or_init(|| Mutex::new({
            let dict: Vec<String> = KEYS.lines().map(|l| l.to_string()).collect();
            let build = |bytes: &[u8], tag: &str| -> Result<Session, String> {
                Session::builder(&env)
                    .map_err(|e| format!("session builder 失败: {e}"))?
                    .with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(|e| format!("优化级别设置失败: {e}"))?
                    .commit_from_memory(bytes)
                    .map_err(|e| format!("{tag} 模型加载失败: {e}"))
            };
            match (build(DET_ONNX, "det"), build(REC_ONNX, "rec")) {
                (Ok(det), Ok(rec)) => {
                    log::info!("[ocr] PP-OCRv4 det+rec session 就绪(字典 {} 项)", dict.len());
                    Some(Engine { det, rec, dict })
                }
                (Err(e), _) | (_, Err(e)) => {
                    log::warn!("[ocr] PP-OCRv4 session 创建失败: {e}");
                    None
                }
            }
        })))
    }

    struct DetBox {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
    }

    /// det:整图 → DB 概率图 → 文本框(原图坐标系)。
    fn detect(
        eng: &mut Engine,
        img: &image::RgbImage,
        ow: u32,
        oh: u32,
    ) -> Result<Vec<DetBox>, String> {
        let ratio = DET_SIDE / ow.max(oh) as f32;
        // 尺寸四舍五入到 32 的倍数(POC 同款:Math.round(n/32)*32)。
        let rw = ((((ow as f32 * ratio) as u32 + 16) / 32) * 32).max(32);
        let rh = ((((oh as f32 * ratio) as u32 + 16) / 32) * 32).max(32);
        let resized = image::DynamicImage::ImageRgb8(img.clone())
            .resize_exact(rw, rh, FilterType::Lanczos3)
            .to_rgb8();
        let plane = (rw * rh) as usize;
        let mean = [0.485f32, 0.456, 0.406];
        let std = [0.229f32, 0.224, 0.225];
        let mut input = vec![0f32; 3 * plane];
        for (i, p) in resized.pixels().enumerate() {
            input[i] = (p[0] as f32 / 255.0 - mean[0]) / std[0];
            input[plane + i] = (p[1] as f32 / 255.0 - mean[1]) / std[1];
            input[2 * plane + i] = (p[2] as f32 / 255.0 - mean[2]) / std[2];
        }
        let input = Tensor::from_array((vec![1usize, 3, rh as usize, rw as usize], input))
            .map_err(|e| format!("det 输入张量构建失败: {e}"))?;
        let outputs = eng
            .det
            .run(ort::inputs![input])
            .map_err(|e| format!("det 推理失败: {e}"))?;
        let (shape, maps) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("det 输出提取失败: {e}"))?;
        // [1,1,rh,rw] 已 sigmoid 的概率图。
        if shape.len() != 4
            || shape[0] != 1
            || shape[1] != 1
            || shape[2] != rh as i64
            || shape[3] != rw as i64
        {
            return Err(format!("det 输出形状异常: {shape:?}"));
        }
        let (rw, rh) = (rw as usize, rh as usize);
        // 二值化 + 连通域(4 邻接,迭代 flood fill)。
        let bin: Vec<bool> = maps.iter().map(|&v| v > DB_THRESHOLD).collect();
        let mut visited = vec![false; rw * rh];
        let min_area = ((plane / 4000).max(30)) as usize;
        let mut boxes = Vec::new();
        for start in 0..rw * rh {
            if !bin[start] || visited[start] {
                continue;
            }
            let mut stack = vec![start];
            visited[start] = true;
            let (mut min_x, mut min_y, mut max_x, mut max_y, mut count) =
                (rw, rh, 0usize, 0usize, 0usize);
            while let Some(p) = stack.pop() {
                let x = p % rw;
                let y = p / rw;
                count += 1;
                if x < min_x { min_x = x; }
                if x > max_x { max_x = x; }
                if y < min_y { min_y = y; }
                if y > max_y { max_y = y; }
                if x > 0 && bin[p - 1] && !visited[p - 1] {
                    visited[p - 1] = true;
                    stack.push(p - 1);
                }
                if x + 1 < rw && bin[p + 1] && !visited[p + 1] {
                    visited[p + 1] = true;
                    stack.push(p + 1);
                }
                if y > 0 && bin[p - rw] && !visited[p - rw] {
                    visited[p - rw] = true;
                    stack.push(p - rw);
                }
                if y + 1 < rh && bin[p + rw] && !visited[p + rw] {
                    visited[p + rw] = true;
                    stack.push(p + rw);
                }
            }
            if count < min_area {
                continue;
            }
            // bbox 外扩(unclip):offset = area * ratio / perimeter。
            let bw = (max_x - min_x + 1) as f32;
            let bh = (max_y - min_y + 1) as f32;
            let offset = count as f32 * DB_UNCLIP_RATIO / (2.0 * (bw + bh));
            let ux0 = (min_x as f32 - offset).max(0.0);
            let uy0 = (min_y as f32 - offset).max(0.0);
            let ux1 = (max_x as f32 + offset).min((rw - 1) as f32);
            let uy1 = (max_y as f32 + offset).min((rh - 1) as f32);
            boxes.push(DetBox {
                x0: ux0 / ratio,
                y0: uy0 / ratio,
                x1: (ux1 / ratio).min((ow - 1) as f32),
                y1: (uy1 / ratio).min((oh - 1) as f32),
            });
        }
        // 阅读顺序:先上后下、左到右(POC 同款排序)。
        boxes.sort_by(|a, b| {
            a.y0.partial_cmp(&b.y0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.x0.partial_cmp(&b.x0).unwrap_or(std::cmp::Ordering::Equal))
        });
        Ok(boxes)
    }

    /// rec:单框裁剪 → 高 48 → CTC 解码,返回 (文本, 平均置信度)。
    fn recognize_crop(
        eng: &mut Engine,
        img: &image::RgbImage,
        ow: u32,
        oh: u32,
        b: &DetBox,
    ) -> Result<(String, f32), String> {
        let x = b.x0.max(0.0).floor() as u32;
        let y = b.y0.max(0.0).floor() as u32;
        let w = ((b.x1.ceil() as u32).min(ow)).saturating_sub(x).max(2);
        let h = ((b.y1.ceil() as u32).min(oh)).saturating_sub(y).max(2);
        let w48 = ((w as f32 / h as f32) * REC_H as f32).round() as u32;
        let w48 = w48.clamp(2, 4000);
        let crop = image::DynamicImage::ImageRgb8(img.clone())
            .crop_imm(x, y, w, h)
            .resize_exact(w48, REC_H, FilterType::Lanczos3)
            .to_rgb8();
        let plane = (REC_H * w48) as usize;
        let mut input = vec![0f32; 3 * plane];
        for (i, p) in crop.pixels().enumerate() {
            input[i] = (p[0] as f32 / 255.0 - 0.5) / 0.5;
            input[plane + i] = (p[1] as f32 / 255.0 - 0.5) / 0.5;
            input[2 * plane + i] = (p[2] as f32 / 255.0 - 0.5) / 0.5;
        }
        let input = Tensor::from_array((vec![1usize, 3, REC_H as usize, w48 as usize], input))
            .map_err(|e| format!("rec 输入张量构建失败: {e}"))?;
        let outputs = eng
            .rec
            .run(ort::inputs![input])
            .map_err(|e| format!("rec 推理失败: {e}"))?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("rec 输出提取失败: {e}"))?;
        // [1, T, C]:T 帧 × C 类别,贪心 argmax + 去重去 blank。
        if shape.len() != 3 {
            return Err(format!("rec 输出形状异常: {shape:?}"));
        }
        let t_len = shape[1] as usize;
        let c_len = shape[2] as usize;
        let mut text = String::new();
        let mut last = 0usize;
        let mut score_sum = 0f32;
        let mut n = 0usize;
        for t in 0..t_len {
            let base = t * c_len;
            let (mut arg, mut max) = (0usize, f32::NEG_INFINITY);
            for (c, &v) in data[base..base + c_len].iter().enumerate() {
                if v > max {
                    max = v;
                    arg = c;
                }
            }
            if arg != 0 && arg != last {
                if arg == c_len - 1 {
                    text.push(' ');
                } else if let Some(ch) = eng.dict.get(arg - 1) {
                    text.push_str(ch);
                }
                score_sum += max;
                n += 1;
            }
            last = arg;
        }
        let score = if n > 0 { score_sum / n as f32 } else { 0.0 };
        Ok((text.trim().to_string(), score))
    }

    pub fn recognize(png: &[u8]) -> Result<OcrResult, String> {
        let cell = ensure_engine()?;
        // 锁获取带上限(try_lock 轮询):Session::run 需 &mut,引擎整把锁串行化。
        // 极端情况下若某次推理异常滞留,后续请求不能永久阻塞——超时即报错,
        // 由 imp::recognize 回退系统引擎兜底,用户仍能拿到识别结果。
        let mut guard = None;
        for _ in 0..100 {
            match cell.try_lock() {
                Ok(g) => {
                    guard = Some(g);
                    break;
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("PP-OCR 引擎锁异常".into());
                }
            }
        }
        let Some(mut guard) = guard else {
            return Err("PP-OCR 引擎忙碌超时(10s)".into());
        };
        // 排队等待期间可能已有其他线程算完同一张图并入库,双检直接命中。
        if let Some(r) = super::cache_get(super::cache_key(png)) {
            return Ok(r);
        }
        let eng = guard
            .as_mut()
            .ok_or_else(|| "PP-OCRv4 引擎不可用".to_string())?;
        let img = image::load_from_memory(png)
            .map_err(|e| format!("解码 PNG 失败: {e}"))?
            .to_rgb8();
        let (ow, oh) = (img.width(), img.height());
        let boxes = detect(eng, &img, ow, oh)?;
        let mut lines = Vec::new();
        for b in &boxes {
            let (text, score) = recognize_crop(eng, &img, ow, oh, b)?;
            if text.is_empty() {
                continue;
            }
            lines.push(OcrLine {
                text,
                confidence: Some(score),
                bbox: Some(OcrBox {
                    x: b.x0,
                    y: b.y0,
                    w: b.x1 - b.x0,
                    h: b.y1 - b.y0,
                }),
            });
        }
        Ok(OcrResult {
            lines,
            engine: "ppocr-v4".into(),
            language: "chi_sim+eng".into(),
        })
    }
}
