// 悬浮贴图窗口:把截图钉在桌面上(置顶无边框窗口),支持拖拽移动、角部缩放、
// 透明度调节、锁定、鼠标穿透、关闭(进历史可恢复)与销毁(移出历史)。
//
// B 路线改造:窗口为预热池常驻(pin-1/pin-2)或 Rust 动态建窗(pin-dyn-*),
// 组件不再从 label 提取 pinId,而是读 `pin-meta:<label>` 元数据;池窗复用时由
// 'pin-set' 事件驱动重新初始化。关闭统一走 dismiss_pin_window(池窗归还、动态窗销毁)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  Menu,
  type CheckMenuItemOptions,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu';
import {
  dismissPinWindow,
  loadImageDataUrl,
  shotLog,
  stashImage,
  takeImage,
  writeClipboardImage,
} from './bridge';
import {
  getPinImage,
  getLastPenetratedPin,
  getPinState,
  PIN_CTL,
  removePin,
  setLastPenetratedPin,
  setPinState,
  type PinState,
} from './store';
import { clAddCard, clMakeCard, clSavePreview } from '../clothesline/bridge';
import { isFullAccess, loadAccount } from '../account';
import { cropRegionPng } from './ocr/prepare';
import { filterNoiseLines, OCR_INPUT_LIMIT, recognizeRegion } from './ocr/ocrClient';
import './screenshot.css';

/** 贴图文字层的一行:文本 + 原图物理像素 bbox(SVG viewBox 坐标系)。 */
type PinTextLine = { text: string; x: number; y: number; w: number; h: number };

const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.15;

/** 共享测量画布:measureText 计算行文本自然宽度(scaleX 校准用)。 */
let measureCanvas: HTMLCanvasElement | null = null;

/** 以指定像素字号测量文本自然宽度。字体须与 .pin-text-line 的 font-family 一致。 */
function measureTextWidth(text: string, fontPx: number): number {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${fontPx}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  return ctx.measureText(text).width;
}

export default function PinWindow() {
  const win = getCurrentWindow();
  const label = win.label;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [penetrated, setPenetrated] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const [toast, setToast] = useState('');
  // 窗口焦点状态:聚焦时边框泛蓝、失焦泛灰(参考 PixPin,用户借此辨认贴图)。
  const [focused, setFocused] = useState(false);
  // 悬停兜底:即使焦点事件链路异常(被其他窗口抢走等),鼠标悬停在贴图上
  // 也显示蓝色边框,保证「贴图在哪」始终有明确视觉反馈。
  const [hovered, setHovered] = useState(false);
  const aspectRef = useRef(1);
  const resizeRef = useRef<{ x0: number; y0: number; w0: number; h0: number } | null>(null);
  const pinIdRef = useRef<string | null>(null);
  // 双击关闭判定:原生 onDoubleClick 不可靠(原生拖拽会吞掉第二次 click),
  // 改用「两次 mousedown 间隔 + 首次按下未位移」判定。只在 mouseup 且未拖拽时
  // 记录时间戳,所以拖拽结束不会误触发双击。
  const lastClickRef = useRef(0);
  // 本次按下的起点(用于区分「单击」与「拖拽」)。按下时不立刻 startDragging,
  // 只有指针移动超过 3px 才启动原生拖拽 —— 这样拖拽零延迟、手感跟手,
  // 同时纯点击不会误拖,双击判定不会被拖拽循环吞掉。
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // ---- OCR:文字层(PixPin 式自由复制) ----------------------------------------
  // 贴图显示后后台静默整图 OCR,识别行按原图物理像素 bbox 合成透明文字层,
  // 直接在贴图上拖选复制(不经右键菜单)。右键菜单 = 原悬停工具栏功能全集,
  // 以 OS 原生菜单弹出(不受贴图窗口尺寸约束,见 showContextMenu)。
  // 池窗复用换图时强制丢弃进行中的识别(代际号防悬挂结果回填)。
  // 贴图文字层:识别行按原图物理像素 bbox 存放;渲染期换算为百分比定位 +
  // vh 字号,窗口任意缩放自动跟随。
  const [pinText, setPinText] = useState<{ w: number; h: number; lines: PinTextLine[] } | null>(
    null,
  );
  const ocrRunRef = useRef(0);

  // 逐行 scaleX 校准:HTML span 字形串按字体自然排布,宽度≠OCR bbox 宽度;
  // measureText 测自然宽度后 scaleX 精确铺满 bbox —— 即 SVG textLength=
  // spacingAndGlyphs 的 HTML 等价实现(SVG <text> 在 WebView2 中拖选不可靠,
  // HTML span 拖选可靠,故用 span + scaleX 达成同样的逐字对齐)。
  const styledPinText = useMemo(() => {
    if (!pinText) return null;
    const lines = pinText.lines.map((l) => {
      const natural = measureTextWidth(l.text, l.h);
      return { ...l, sx: natural > 0 ? l.w / natural : 1 };
    });
    return { w: pinText.w, h: pinText.h, lines };
  }, [pinText]);

  // 整图自动识别(PixPin 式,后台静默):贴图显示后触发,完成后文字层可直接拖选复制。
  // 失败静默降级为无文字层,不弹任何提示;代际号防悬挂:换图/关闭时
  // ocrRunRef.current 已 +1,结果自动丢弃。
  // 超限降采样:整图直出超过 IPC 体积上限(≈4K 整屏钉图)会抛 OCR_REGION_TOO_LARGE,
  // 旧实现直接静默跳过 → 贴图完全没有文字层(用户视角就是「无法划选复制」)。
  // 现按 0.7 逐级降采样重试(下限 0.35),bbox 识别后映射回原图坐标。
  const autoOcrWholeImage = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      // 留痕:此前此处静默返回,排查「贴图无法划选」时无法区分「没跑」与「跑了没完成」。
      void shotLog('pin ocr skipped: image not ready');
      return;
    }
    const run = ocrRunRef.current;
    try {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      // start 留痕:识别完成前的日志(`pin ocr lines=N`)只有 await 返回后才会写,
      // 窗口提前关闭时全部随 WebView 销毁丢失(此前 4 次测试零日志即此因);
      // 有 start 行即可区分「识别未发生」与「识别中窗口被关」。
      void shotLog(`pin ocr start ${w}x${h}`);
      let scale = 1;
      let png = '';
      for (;;) {
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(w * scale));
        off.height = Math.max(1, Math.round(h * scale));
        const octx = off.getContext('2d');
        if (!octx) return;
        octx.drawImage(img, 0, 0, off.width, off.height);
        png = cropRegionPng(off, 0, 0, off.width, off.height);
        if (png.length <= OCR_INPUT_LIMIT || scale <= 0.35) break;
        scale = Math.max(0.35, scale * 0.7);
      }
      // 识别期间提示:PP-OCRv4 神经网络推理约 0.3~1.5s,期间文字层尚未生成,
      // 此刻划选必然无反应 —— 明确告知「正在识别」,避免用户误判功能失效。
      // 缓存命中时毫秒级返回,提示一闪而过基本无感。
      setToast('正在识别文字…');
      const r = await recognizeRegion(png);
      setToast('');
      if (ocrRunRef.current !== run) return; // 悬挂结果(换图/关闭)丢弃
      const out: PinTextLine[] = [];
      const k = 1 / scale; // 降采样识别的 bbox → 原图物理像素
      for (const l of filterNoiseLines(r.lines)) {
        if (!l.bbox) continue;
        out.push({
          text: l.text,
          x: Math.round(l.bbox.x * k),
          y: Math.round(l.bbox.y * k),
          w: Math.round(l.bbox.w * k),
          h: Math.round(l.bbox.h * k),
        });
      }
      void shotLog(`pin ocr lines=${out.length} scale=${scale.toFixed(2)}`);
      // 逐行内容留痕:「圈选整行却复制缺字」类问题必须能看到每行真实 text/bbox
      // 才能定论是识别漏字(bbox 与文本宽度和失配,scaleX 拉伸掩盖)还是选区问题。
      out.forEach((l, i) => {
        void shotLog(
          `pin ocr line[${i}] "${l.text}" bbox=(${l.x},${l.y},${l.w}x${l.h})`,
        );
      });
      setPinText({ w, h, lines: out });
    } catch (e) {
      setToast('');
      // 静默降级为无文字层;留痕便于排查「贴图无法划选」类反馈。
      void shotLog(`pin ocr failed: ${String(e)}`);
    }
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 1800);
  };

  /**
   * 载入贴图数据 + 恢复运行态。无参统一语义:
   * - 读到 pin-meta → 装载并显示(若已是同一张则跳过,避免重复初始化)。
   * - 读不到 → 保持现状(待命或已显示),**绝不再 dismiss/隐藏**。旧逻辑在重复
   *   pin-set 或轮询兜底时读到 null 会把已显示的贴图误关掉,导致「贴图闪一下消失」。
   * 由 pin-set 事件唤醒,或挂载后短轮询兜底(动态窗 WebView2 冷启动、pin-set 可能
   * 丢失时,窗口加载完自行轮询到 pin-meta 显示)。
   */
  const init = useCallback(
    async (fromEvent = false) => {
      let id: string | null = null;
      try {
        const metaRaw = await takeImage(`pin-meta:${label}`);
        if (metaRaw) {
          id = (JSON.parse(metaRaw) as { pinId: string }).pinId ?? null;
        }
      } catch {
        /* 无元数据 */
      }
      if (!id) {
        // 无数据:保持现状(待命或已显示),不 dismiss、不隐藏。
        // 事件触发却读不到 meta = 数据被上一轮消费/丢失,留痕(此前完全静默,
        // 是「贴图永不出现且零日志」的排查盲区);轮询待命空转不打日志。
        if (fromEvent) void shotLog(`pin init skip: no meta (label=${label})`);
        return;
      }
      if (pinIdRef.current === id) return; // 已是这张,跳过
      // 池窗复用换图:代际号 +1 丢弃悬挂识别结果。
      ocrRunRef.current += 1;
      setPinText(null); // 文字层随旧图丢弃
      let b64: string | null = null;
      let url = getPinImage(id);
      try {
        if (!url) {
          // 跨窗口兜底:进程级暂存。
          b64 = await takeImage(`pin:${id}`);
          if (b64) url = `data:image/png;base64,${b64}`;
        }
        if (!url) {
          // 图片数据暂未就绪(动态窗场景下 pin:<id> 晚于 pin-meta 写入)。把 meta 放回,
          // 下次 pin-set/轮询再试 —— 否则 meta 被 takeImage 取走删除后会永久丢失。
          await stashImage(`pin-meta:${label}`, JSON.stringify({ pinId: id }));
          void shotLog(`pin init skip: image not ready, meta re-stashed id=${id}`);
          return;
        }
        const img = await loadImageDataUrl(url);
        imgRef.current = img;
        aspectRef.current = img.naturalWidth / Math.max(1, img.naturalHeight);
        const st = getPinState(id);
        pinIdRef.current = id;
        setPinId(id);
        setDataUrl(url);
        setLocked(st.locked);
        setPenetrated(st.penetrated);
        setOpacity(st.opacity);
        setReady(true);
        // 图片装载完成:此刻才显示窗口(Rust 侧不再代为 show)。
        try {
          await win.show();
          // ⚠️ 必须连 WebView2 控制器一起置可见:池窗/动态窗都是 `visible: false` 建的,
          // 只 show 外层 HWND 时 WebView2 仍认为「不可见」→ 页面 visibilityState=hidden,
          // 渲染停摆。表现就是热键贴图后画面不出现,鼠标点一下(真实输入)才画出来。
          await getCurrentWebview().show();
          await win.setFocus();
        } catch {
          /* ignore */
        }
        void shotLog(`pin shown label=${label} vis=${document.visibilityState}`);
        // 就绪登记:Rust 看门狗据此停止自救(事件丢失/页面假死检测,见 screenshot.rs)。
        void invoke('pin_frontend_ready', { label }).catch(() => {});
        // PixPin 式:贴图显示后后台整图 OCR,完成后文字层可直接拖选复制(静默,失败无感)。
        void autoOcrWholeImage();
        if (st.penetrated) {
          win.setIgnoreCursorEvents(true).catch(() => {});
          setLastPenetratedPin(id);
        } else {
          win.setIgnoreCursorEvents(false).catch(() => {});
          setLastPenetratedPin(null);
        }
      } catch (e) {
        // ⚠️ take_image 是取出即删:走到这里说明 meta(可能还有图片)已被消费,
        // 不放回则本轮数据永久丢失、后续所有 pin-set 都拿不到数据 —— 静默失败,
        // 表现为「贴图永不出现且重试无效」(2026-10-30 排查结论之一)。原样放回
        // + 留痕,等待看门狗重发/下一轮事件重试。
        try {
          await stashImage(`pin-meta:${label}`, JSON.stringify({ pinId: id }));
          if (b64) await stashImage(`pin:${id}`, b64);
        } catch {
          /* ignore */
        }
        void shotLog(`pin init failed: ${String(e)} (data re-stashed id=${id})`);
      }
    },
    [label, win, autoOcrWholeImage],
  );

  // 挂载:短轮询兜底。动态窗是全新 WebView2 冷启动,从 build 到 JS 加载完成、
  // 注册 pin-set 监听要数百毫秒,前端 emitTo 的 pin-set 可能在此之前发出而丢失;
  // 此处挂载后轮询 pin-meta,窗口一加载完就能自行显示(池窗则靠 pin-set 即时唤醒)。
  // 已显示即停;最多 ~6s 后停止空转。
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      while (!cancelled && tries < 24) {
        if (pinIdRef.current) return; // 已显示,停
        await init();
        tries += 1;
        if (pinIdRef.current) return; // 本次已显示,停
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载留痕:证明 PinWindow 组件本身已加载执行(排查「窗口建了但前端零日志」——
  // 无此行 = webview 加载失败/挂载崩溃;有此行而无 pin shown = init 链路问题)。
  useEffect(() => {
    void shotLog(`pin mounted label=${label}`);
  }, [label]);

  // 焦点跟踪:聚焦 → 蓝框,失焦 → 灰框(PixPin 式贴图位置指示)。
  useEffect(() => {
    const p = win.onFocusChanged(({ payload }) => setFocused(payload));
    return () => {
      void p.then((fn) => fn());
    };
  }, [win]);

  // pin-set 唤醒:贴图 / 复用池窗时由前端 emitTo 触发,读取 pin-meta 显示或待命。
  // 动态窗若事件在 JS 未就绪时丢失,由挂载轮询兜底,此处不依赖事件必然命中。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen('pin-set', () => {
      // fromEvent=true:事件触发却读不到 meta 时留痕(区别于挂载轮询的静默空转)。
      void init(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [init]);

  // 持久化运行态并应用穿透。
  useEffect(() => {
    const id = pinIdRef.current;
    if (!id) return;
    const st: PinState = { locked, penetrated, opacity };
    setPinState(id, st);
    win.setIgnoreCursorEvents(penetrated).catch(() => {});
    if (penetrated) setLastPenetratedPin(id);
    else if (getLastPenetratedPin() === id) setLastPenetratedPin(null);
  }, [locked, penetrated, opacity, pinId, win]);

  // 穿透控制条窗口(参考 PixPin):穿透开启时贴图整窗收不到鼠标事件,
  // 无法关闭/调节 → 在贴图上方悬浮独立控制条(拖拽把手 + 不透明度 + 关闭)。
  // 注意:deps 不含 opacity,避免每次调透明度都重建控制条;当前透明度经
  // 暂存键 `pinctl-init:<label>` 传给控制条做滑条初值。
  useEffect(() => {
    if (!pinId) return;
    if (penetrated) {
      void (async () => {
        try {
          const scale = await win.scaleFactor();
          const op = await win.outerPosition();
          const os = await win.outerSize();
          const pw = Math.round(PIN_CTL.w * scale);
          const phFull = Math.round((PIN_CTL.bubbleH + PIN_CTL.gap + PIN_CTL.barH) * scale);
          const gapPx = Math.round(PIN_CTL.gap * scale);
          // 默认贴图正上方居中;贴图太靠上则放贴图下方。
          let py = op.y - phFull - gapPx;
          if (py < 0) py = op.y + os.height + gapPx;
          const px = op.x + Math.round((os.width - pw) / 2);
          await stashImage(`pinctl-init:${label}`, String(opacity));
          await invoke('show_pin_control', { target: label, px, py, pw, ph: phFull });
          // 复用(控制条窗口已存在):emit 通知自显 + 重读初值。
          // 首次创建时窗口尚未挂载,emit 失败无妨(挂载后自显兜底)。
          try {
            await emitTo(`pinctl-${label}`, 'pinctl-show');
          } catch {
            /* 首次创建时未挂载,忽略 */
          }
        } catch {
          /* 控制条失败不影响穿透本身 */
        }
      })();
    } else {
      void invoke('hide_pin_control', { target: label }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [penetrated, pinId, label, win]);

  // 控制条滑条 → 调透明度(穿透时唯一调节入口)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ target: string; value: number }>('pinctl-opacity', ({ payload }) => {
      if (payload.target === label) {
        setOpacity(Math.min(1, Math.max(0.15, payload.value)));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [label]);

  // 关闭到历史(不销毁数据,可从设置/历史重新钉出)。
  const closeToHistory = useCallback(() => {
    pinIdRef.current = null;
    setReady(false);
    void dismissPinWindow(label);
  }, [label]);

  // 销毁(从历史移除并关闭窗口)。
  const destroy = useCallback(() => {
    const id = pinIdRef.current;
    if (id) removePin(id);
    pinIdRef.current = null;
    setReady(false);
    void dismissPinWindow(label);
  }, [label]);

  // ---- 键盘快捷键(窗口聚焦且未穿透时生效) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (penetrated) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        closeToHistory();
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        destroy();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeToHistory();
      } else if (e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setLocked((v) => !v);
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPenetrated((v) => !v);
        showToast(penetrated ? '已取消穿透' : '已开启穿透(点击穿透桌面)');
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setOpacity((o) => Math.min(1, Math.round((o + OPACITY_STEP) * 10) / 10));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setOpacity((o) => Math.max(MIN_OPACITY, Math.round((o - OPACITY_STEP) * 10) / 10));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penetrated, closeToHistory, destroy]);

  // 鼠标交互(未锁定且未穿透时):按下只记录起点,**不立刻 startDragging**;
  // 指针移动超过 3px 才启动原生拖拽。这样:
  // ① 拖拽零延迟、跟手(旧实现延迟 260ms 才拖 → 明显发迟、拖不动就松手会失效);
  // ② 纯点击(含双击的两次按下)永远不会误触发拖拽,双击判定也不会被拖拽循环吞掉;
  // ③ 两次按下间隔 ≤250ms 且未发生位移 → 判定双击关闭。
  const onImageMouseDown = (e: React.MouseEvent) => {
    if (locked || penetrated) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const now = Date.now();
    if (lastClickRef.current && now - lastClickRef.current <= 250) {
      lastClickRef.current = 0;
      pressRef.current = null;
      closeToHistory();
      return;
    }
    pressRef.current = { x: e.screenX, y: e.screenY, moved: false };
    // 点击时抢焦点:边框随之变蓝,明确告知用户当前选中的是这张贴图。
    win.setFocus().catch(() => {});
  };

  const onImageMouseMove = (e: React.MouseEvent) => {
    const p = pressRef.current;
    if (!p || p.moved || locked || penetrated) return;
    // 3px 阈值:过滤手抖,保证「点击」不会变成「拖拽」。
    if (Math.abs(e.screenX - p.x) > 3 || Math.abs(e.screenY - p.y) > 3) {
      p.moved = true;
      win.startDragging().catch(() => {});
    }
  };

  const onImageMouseUp = () => {
    const p = pressRef.current;
    pressRef.current = null;
    // 只有「没拖动过」的按下才算一次点击,用于双击计时。
    if (p && !p.moved) lastClickRef.current = Date.now();
  };

  // 滚轮缩放贴图(参考 PixPin):以窗口中心为锚缩放,保持宽高比。
  // 物理像素计算,多屏混合 DPI 不漂移;最小宽度 80 逻辑 px。
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (penetrated || locked) return;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      void (async () => {
        try {
          const scale = await win.scaleFactor();
          const op = await win.outerPosition();
          const os = await win.outerSize();
          const minW = Math.round(80 * scale);
          const newW = Math.max(minW, Math.round(os.width * factor));
          if (newW === os.width) return;
          const newH = Math.round(newW / aspectRef.current);
          const newX = op.x + Math.round((os.width - newW) / 2);
          const newY = op.y + Math.round((os.height - newH) / 2);
          await win.setSize(new PhysicalSize(newW, newH));
          await win.setPosition(new PhysicalPosition(newX, newY));
        } catch (err) {
          // 静默失败不留痕会让「滚轮缩放失灵」无从排查,这里记一行。
          void shotLog(`pin wheel resize failed: ${String(err)}`);
        }
      })();
    },
    [penetrated, locked, win],
  );

  const copyPinImage = async () => {
    if (!dataUrl) return;
    try {
      await writeClipboardImage(dataUrl.split(',')[1] ?? '');
      showToast('已复制图片');
    } catch (e) {
      showToast(`复制失败: ${String(e)}`);
    }
  };

  /** 挂到晾衣绳：直接用已装载的 dataUrl 压缩略图，不 takeImage、不动 pin stash。 */
  const hangPinOnRope = async () => {
    if (!dataUrl) return;
    try {
      const img = await loadImageDataUrl(dataUrl);
      const scale = Math.min(1, 480 / Math.max(1, img.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const seed = clMakeCard('pin', {
        pin_id: pinIdRef.current,
        title: '贴图',
        text: `${img.naturalWidth}×${img.naturalHeight}`,
      });
      const path = await clSavePreview(seed.id, canvas.toDataURL('image/png'));
      await clAddCard({ ...seed, src_path: path }, isFullAccess(loadAccount()));
      showToast('已挂到晾衣绳');
    } catch (e) {
      showToast(`挂绳失败: ${String(e)}`);
    }
  };

  // ---- 右键原生菜单(原悬停工具栏功能全集) -----------------------------------
  // 悬停工具栏整体移除(黑色操作框会遮挡贴图内容),功能并入右键菜单;菜单用
  // OS 原生弹出(@tauri-apps/api/menu),在鼠标位置显示、不受贴图窗口尺寸约束
  // —— 旧的 DOM 菜单渲染在贴图 webview 内,小贴图会被窗口裁剪无法完整显示。
  // 每次右键动态重建以携带最新勾选态;上一份菜单在新菜单 popup 成功后 close;
  // popup 返回后必须 win.setFocus() 夺回焦点(Windows TrackPopupMenu 关闭后
  // 键盘焦点可能未交回 WebView2,表现为拖选正常但 Ctrl+C 失灵)。
  // 注意:OCR/文字复制功能一律不进本菜单 —— 自由划选复制必须直接在贴图
  // 文字层上操作。
  const ctxMenuRef = useRef<Menu | null>(null);

  const showContextMenu = async () => {
    const items: (MenuItemOptions | CheckMenuItemOptions | PredefinedMenuItemOptions)[] = [
      {
        text: '锁定贴图',
        checked: locked,
        action: () => setLocked((v) => !v),
      },
      {
        text: '鼠标穿透',
        checked: penetrated,
        action: () => {
          setPenetrated((v) => !v);
          showToast(penetrated ? '已取消穿透' : '已开启穿透(点击穿透桌面)');
        },
      },
      { item: 'Separator' },
      {
        text: '降低不透明度',
        action: () =>
          setOpacity((o) => Math.max(MIN_OPACITY, Math.round((o - OPACITY_STEP) * 10) / 10)),
      },
      {
        text: '提高不透明度',
        action: () => setOpacity((o) => Math.min(1, Math.round((o + OPACITY_STEP) * 10) / 10)),
      },
      { item: 'Separator' },
      { text: '复制图片', action: () => void copyPinImage() },
      { text: '挂到晾衣绳', action: () => void hangPinOnRope() },
      { item: 'Separator' },
      { text: '关闭(进历史)', action: () => closeToHistory() },
      { text: '销毁(移出历史)', action: () => destroy() },
    ];
    let menu: Menu;
    try {
      menu = await Menu.new({ items });
      await menu.popup(undefined, win); // 不传 at:在当前鼠标位置弹出(OS 级)
    } catch (e) {
      void shotLog(`ctx menu popup failed: ${String(e)}`);
      return;
    }
    ctxMenuRef.current?.close(); // 上一份菜单已弹出完毕,释放资源
    ctxMenuRef.current = menu;
    // 夺回键盘焦点:TrackPopupMenu 关闭后焦点可能滞留原处,拖选正常但 Ctrl+C 失灵。
    win.setFocus().catch(() => {});
  };

  const onContextMenu = (e: React.MouseEvent) => {
    // 文字层上已有选区:放行 WebView 原生菜单(右键直接复制所选文字)。
    // 其余一律弹原生右键菜单(工具栏功能全集,见 showContextMenu)。
    const sel = window.getSelection();
    if ((e.target as Element).closest('.pin-text-layer') && sel && !sel.isCollapsed) return;
    e.preventDefault();
    lastClickRef.current = 0; // 菜单打开期间屏蔽双击关闭
    void showContextMenu();
  };

  // 角部拖拽缩放(保持宽高比)。
  const onResizeDown = (e: React.MouseEvent) => {
    if (locked || penetrated) return;
    e.preventDefault();
    e.stopPropagation();
    const start = async () => {
      const size = await win.innerSize();
      const scale = await win.scaleFactor();
      const logicalW = size.width / scale;
      const logicalH = size.height / scale;
      resizeRef.current = { x0: e.clientX, y0: e.clientY, w0: logicalW, h0: logicalH };
    };
    void start();
  };

  useEffect(() => {
    const onMove = (ev: globalThis.MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = ev.clientX - r.x0;
      const newW = Math.max(80, r.w0 + dx);
      const newH = Math.round(newW / aspectRef.current);
      win.setSize(new LogicalSize(Math.round(newW), newH)).catch(() => {});
    };
    const onUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [win]);

  if (!ready || !dataUrl) {
    // 待命(预热挂载,隐藏状态):不渲染内容。
    return <div className="pin-root pin-idle" />;
  }

  return (
    <div
      className={`pin-root ${focused || hovered ? 'is-focused' : ''} ${penetrated ? 'is-penetrated' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={onImageMouseMove}
      onMouseUp={onImageMouseUp}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <img
        className="pin-image"
        src={dataUrl}
        alt="贴图"
        draggable={false}
        style={{ opacity }}
        onMouseDown={onImageMouseDown}
      />

      {/* PixPin 式文字层(HTML span):百分比定位 + vh 字号随窗口缩放自动对齐;
          scaleX 把字形串精确铺满 bbox 宽度 → 字符位置与图片文字逐字对齐,
          圈选范围 = 复制内容。(曾用 SVG <text> + textLength 实现对齐,但
          WebView2 中 SVG 文本拖选不可靠,HTML span 拖选可靠,故回退 span。) */}
      {styledPinText && styledPinText.lines.length > 0 && (
        <div className="pin-text-layer">
          {styledPinText.lines.map((l, i) => (
            <span
              key={i}
              className="pin-text-line"
              style={{
                left: `${(l.x / styledPinText.w) * 100}%`,
                top: `${(l.y / styledPinText.h) * 100}%`,
                width: `${(l.w / styledPinText.w) * 100}%`,
                height: `${(l.h / styledPinText.h) * 100}%`,
                fontSize: `${(l.h / styledPinText.h) * 100}vh`,
                transform: `scaleX(${l.sx.toFixed(4)})`,
              }}
            >
              {l.text}
            </span>
          ))}
        </div>
      )}

      {!locked && !penetrated && (
        <div className="pin-resize-handle" onMouseDown={onResizeDown} title="拖拽缩放" />
      )}

      {toast && <div className="pin-toast">{toast}</div>}
    </div>
  );
}
