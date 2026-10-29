// 悬浮贴图窗口:把截图钉在桌面上(置顶无边框窗口),支持拖拽移动、角部缩放、
// 透明度调节、锁定、鼠标穿透、关闭(进历史可恢复)与销毁(移出历史)。
//
// B 路线改造:窗口为预热池常驻(pin-1/pin-2)或 Rust 动态建窗(pin-dyn-*),
// 组件不再从 label 提取 pinId,而是读 `pin-meta:<label>` 元数据;池窗复用时由
// 'pin-set' 事件驱动重新初始化。关闭统一走 dismiss_pin_window(池窗归还、动态窗销毁)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Eye, EyeOff, Lock, Unlock, Trash2, X, Plus, Minus } from 'lucide-react';
import {
  dismissPinWindow,
  loadImageDataUrl,
  shotLog,
  stashImage,
  takeImage,
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
import './screenshot.css';

const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.15;

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
  const [toolbarVisible, setToolbarVisible] = useState(false);
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
  const init = useCallback(async () => {
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
      return;
    }
    if (pinIdRef.current === id) return; // 已是这张,跳过
    let url = getPinImage(id);
    if (!url) {
      // 跨窗口兜底:进程级暂存。
      const b64 = await takeImage(`pin:${id}`);
      if (b64) url = `data:image/png;base64,${b64}`;
    }
    if (!url) {
      // 图片数据暂未就绪(动态窗场景下 pin:<id> 晚于 pin-meta 写入)。把 meta 放回,
      // 下次 pin-set/轮询再试 —— 否则 meta 被 takeImage 取走删除后会永久丢失。
      await stashImage(`pin-meta:${label}`, JSON.stringify({ pinId: id }));
      return;
    }
    try {
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
      setToolbarVisible(false);
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
      if (st.penetrated) {
        win.setIgnoreCursorEvents(true).catch(() => {});
        setLastPenetratedPin(id);
      } else {
        win.setIgnoreCursorEvents(false).catch(() => {});
        setLastPenetratedPin(null);
      }
    } catch {
      /* 加载失败保持现状 */
    }
  }, [label, win]);

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
      void init();
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
        } catch {
          /* ignore */
        }
      })();
    },
    [penetrated, locked, win],
  );

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
      onMouseEnter={() => {
        setHovered(true);
        if (!penetrated) setToolbarVisible(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
        setToolbarVisible(false);
      }}
      onMouseMove={onImageMouseMove}
      onMouseUp={onImageMouseUp}
      onWheel={onWheel}
    >
      <img
        className="pin-image"
        src={dataUrl}
        alt="贴图"
        draggable={false}
        style={{ opacity }}
        onMouseDown={onImageMouseDown}
      />

      {!penetrated && toolbarVisible && (
        <div className="pin-toolbar" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="pin-btn"
            title={locked ? '解锁(L)' : '锁定(L)'}
            onClick={() => setLocked((v) => !v)}
          >
            {locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          <button
            type="button"
            className="pin-btn"
            title={penetrated ? '取消穿透(P)' : '鼠标穿透(P)'}
            onClick={() => {
              setPenetrated((v) => !v);
              showToast(penetrated ? '已取消穿透' : '已开启穿透');
            }}
          >
            {penetrated ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <span className="pin-opacity">
            <button
              type="button"
              className="pin-btn"
              title="降低透明度(-)"
              onClick={() =>
                setOpacity((o) => Math.max(MIN_OPACITY, Math.round((o - OPACITY_STEP) * 10) / 10))
              }
            >
              <Minus size={14} />
            </button>
            <em>{Math.round(opacity * 100)}%</em>
            <button
              type="button"
              className="pin-btn"
              title="提高透明度(+)"
              onClick={() =>
                setOpacity((o) => Math.min(1, Math.round((o + OPACITY_STEP) * 10) / 10))
              }
            >
              <Plus size={14} />
            </button>
          </span>
          <button
            type="button"
            className="pin-btn"
            title="关闭(进历史, Esc / Ctrl+W / 双击)"
            onClick={closeToHistory}
          >
            <X size={14} />
          </button>
          <button
            type="button"
            className="pin-btn pin-danger"
            title="销毁(移出历史, Ctrl+D)"
            onClick={destroy}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {!locked && !penetrated && (
        <div className="pin-resize-handle" onMouseDown={onResizeDown} title="拖拽缩放" />
      )}

      {toast && <div className="pin-toast">{toast}</div>}
    </div>
  );
}
