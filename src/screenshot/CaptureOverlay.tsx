// 截图覆盖层:全屏透明窗口(静态预热常驻),展示冻结截图并支持区域 / 窗口 / 全屏
// 选择、比例锁定、放大镜、实时宽高与起点坐标;确认选区后弹出操作条
// (复制 / 贴图 / 保存 / 取消),并可进入标注模式(箭头 / 画笔 / 几何 / 序号 /
// 文字 / 马赛克 / 橡皮擦),关闭路径统一收敛到 finish()。
//
// 预热窗生命周期:应用启动即挂载(无数据 → 空闲待命,不关窗);每次快捷键触发由
// 主窗口 emit 'overlay-show' 驱动新一轮流程,结束后只隐藏不销毁 → 下次零冷启动。
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { Copy, Eraser, Pin, Save, X } from 'lucide-react';
import {
  FULL_KEY,
  LAST_KEY,
  finishOverlay,
  pinImage,
  saveImageTo,
  shotLog,
  stashImage,
  takeImage,
  windowAtPoint,
  writeClipboardImage,
  type Rect,
} from './bridge';
import type { CaptureMode } from './types';
import './screenshot.css';

interface CaptureMeta {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  path: string;
  mode?: CaptureMode;
}

type Ratio = 'free' | '1:1' | '4:3' | '16:9';

const RATIO_VALUES: Record<Exclude<Ratio, 'free'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
};

interface Sel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 选区调整手柄:四角 + 四边中点(问题8:框选后可拖拽微调范围)。 */
const HANDLES: { id: string; fx: (s: Sel) => number; fy: (s: Sel) => number }[] = [
  { id: 'nw', fx: (s) => s.x, fy: (s) => s.y },
  { id: 'n', fx: (s) => s.x + s.w / 2, fy: (s) => s.y },
  { id: 'ne', fx: (s) => s.x + s.w, fy: (s) => s.y },
  { id: 'e', fx: (s) => s.x + s.w, fy: (s) => s.y + s.h / 2 },
  { id: 'se', fx: (s) => s.x + s.w, fy: (s) => s.y + s.h },
  { id: 's', fx: (s) => s.x + s.w / 2, fy: (s) => s.y + s.h },
  { id: 'sw', fx: (s) => s.x, fy: (s) => s.y + s.h },
  { id: 'w', fx: (s) => s.x, fy: (s) => s.y + s.h / 2 },
];

// ---------------- 标注模型 ----------------
type ActiveTool =
  | 'move'
  | 'arrow'
  | 'pencil'
  | 'rect'
  | 'ellipse'
  | 'num'
  | 'text'
  | 'mosaic'
  | 'eraser';

interface Pt {
  x: number;
  y: number;
}

interface Shape {
  id: number;
  tool: Exclude<ActiveTool, 'move' | 'eraser'>;
  color: string;
  width: number;
  pts: Pt[]; // 绘制时的绝对物理坐标(相对抓取屏原点)
  text?: string;
  baked?: HTMLCanvasElement; // 马赛克:预烘焙的像素化小图
}

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#2f80ff', '#1a1a1a', '#ffffff'];

export default function CaptureOverlay() {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const mosaicRef = useRef<HTMLCanvasElement>(null);
  const annoRef = useRef<HTMLCanvasElement>(null);
  const uiRef = useRef<HTMLCanvasElement>(null);
  const magRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const metaRef = useRef<CaptureMeta | null>(null);
  const dprRef = useRef<number>(1);
  const dragRef = useRef<{ x0: number; y0: number } | null>(null);
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const windowRectRef = useRef<Rect | null>(null);
  const confirmedSelRef = useRef<Sel | null>(null);
  // 手柄拖拽中的原始选区 + 起始物理坐标。
  const handleDragRef = useRef<{ handle: string; start: Sel; x0: number; y0: number } | null>(null);
  // 选区整体平移拖拽(功能1)。
  const moveDragRef = useRef<{ startX: number; startY: number; x0: number; y0: number } | null>(null);
  // 绘制中的图形。
  const drawingRef = useRef<Shape | null>(null);
  // 标注基准:确认选区时的选区原点;渲染时按当前选区与基准的位移整体平移图形。
  const annoBaseRef = useRef<{ x: number; y: number } | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const idRef = useRef(0);
  const numCounterRef = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  // 马赛克拖拽实时预览用的小图 canvas(复用,避免每帧新建)。
  const mosaicSmallRef = useRef<HTMLCanvasElement | null>(null);
  // 标注层渲染 rAF 合帧句柄。
  const rafRef = useRef(0);
  // 本轮是否由快捷键触发(挂载待命时的空数据不算,不能误恢复主窗)。
  const activatedRef = useRef(false);
  // 上次 overlay-show 触发时间:主窗口带就绪轮询的重发机制会对同一轮多次
  // emit,800ms 内的重复触发直接忽略,防止 runId 重复 +1 重新初始化。
  const lastTriggerRef = useRef(0);

  const [mode, setMode] = useState<CaptureMode>('region');
  const [ratio, setRatio] = useState<Ratio>('free');
  const [ready, setReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const confirmedRef = useRef(false);
  confirmedRef.current = confirmed;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [cursor, setCursor] = useState({ x: -1, y: -1 });
  // 已确认选区的渲染副本:手柄拖拽时实时更新,驱动选框/手柄/操作条重绘。
  const [selDisp, setSelDisp] = useState<Sel | null>(null);
  // 操作条实测宽度(右对齐定位用;首帧兜底 264)。
  const [barW, setBarW] = useState(264);
  // 每轮流程 +1,驱动 init effect 重跑(预热窗复用时复位全部状态)。
  const [runId, setRunId] = useState(0);

  // 标注工具栏状态。
  const [activeTool, setActiveToolState] = useState<ActiveTool>('move');
  const toolRef = useRef<ActiveTool>('move');
  const [annoColor, setAnnoColor] = useState(COLORS[0]);
  const [annoWidth, setAnnoWidth] = useState(4);
  const [textInput, setTextInput] = useState<{
    x: number;
    y: number;
    ax: number;
    ay: number;
    value: string;
    visible: boolean;
  }>({ x: 0, y: 0, ax: 0, ay: 0, value: '', visible: false });

  const selectTool = (t: ActiveTool) => {
    toolRef.current = t;
    setActiveToolState(t);
    // 光标跟随工具:指针 = 默认箭头(悬停选区内时变四向移动),其他 = 十字。
    const ui = uiRef.current;
    if (ui) ui.style.cursor = t === 'move' ? 'default' : 'crosshair';
    // 切换工具时收起进行中的文字输入。
    if (textInput.visible) setTextInput((v) => ({ ...v, visible: false }));
    if (drawingRef.current) {
      drawingRef.current = null;
      renderAnno();
    }
  };

  // 当前活动选区(物理像素,相对抓取屏原点),应用比例锁。
  const currentSelection = useCallback((): Sel | null => {
    const d = dragRef.current;
    if (!d) return null;
    const c = cursorRef.current;
    if (ratio === 'free') {
      const x = Math.min(d.x0, c.x);
      const y = Math.min(d.y0, c.y);
      return { x, y, w: Math.abs(c.x - d.x0), h: Math.abs(c.y - d.y0) };
    }
    const rv = RATIO_VALUES[ratio];
    const w = Math.abs(c.x - d.x0);
    const h = w / rv;
    const signX = c.x >= d.x0 ? 1 : -1;
    const signY = c.y >= d.y0 ? 1 : -1;
    const x = signX > 0 ? d.x0 : d.x0 - w;
    const y = signY > 0 ? d.y0 : d.y0 - h;
    return { x, y, w, h };
  }, [ratio]);

  const sizeCanvases = useCallback((w: number, h: number) => {
    for (const r of [baseRef, mosaicRef, annoRef, uiRef]) {
      if (r.current) {
        r.current.width = w;
        r.current.height = h;
      }
    }
  }, []);

  const clearAnnoCanvas = useCallback(() => {
    for (const r of [mosaicRef, annoRef]) {
      const c = r.current;
      if (c) {
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, c.width, c.height);
      }
    }
  }, []);

  const drawBase = useCallback(() => {
    const base = baseRef.current;
    const img = imgRef.current;
    if (!base || !img) return;
    const ctx = base.getContext('2d')!;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.drawImage(img, 0, 0, base.width, base.height);
  }, []);

  const drawSizeLabel = (ctx: CanvasRenderingContext2D, sel: Sel) => {
    const meta = metaRef.current!;
    const text = `${Math.round(sel.w)} × ${Math.round(sel.h)}`;
    const coord = `起点 (${Math.round(sel.x + meta.left)}, ${Math.round(sel.y + meta.top)})`;
    ctx.font = '13px system-ui, sans-serif';
    const pad = 6;
    const tw =
      Math.max(ctx.measureText(text).width, ctx.measureText(coord).width) + pad * 2;
    const th = 38;
    const lx = Math.min(Math.max(0, sel.x), meta.width - tw - 4);
    const ly = sel.y > th + 8 ? sel.y - th - 6 : sel.y + sel.h + 6;
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.fillRect(lx, ly, tw, th);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, lx + pad, ly + 16);
    ctx.fillStyle = '#9ad';
    ctx.fillText(coord, lx + pad, ly + 31);
  };

  const redrawUI = useCallback(() => {
    const ui = uiRef.current;
    const meta = metaRef.current;
    if (!ui || !meta) return;
    const ctx = ui.getContext('2d')!;
    ctx.clearRect(0, 0, ui.width, ui.height);
    if (confirmed) {
      // 已确认(含手柄拖拽调整中):选区外保持暗罩,选区内明亮 —— 与主流截图
      // 工具一致。此前只画选框不画暗罩,手柄一调整「暗罩消失」(用户反馈)。
      const sel = confirmedSelRef.current;
      if (sel) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, ui.width, ui.height);
        ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
        ctx.strokeStyle = '#2f80ff';
        ctx.lineWidth = 4;
        ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
      }
      return;
    }
    if (mode === 'region') {
      const sel = confirmedSelRef.current ?? currentSelection();
      if (sel) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, ui.width, ui.height);
        ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
        ctx.strokeStyle = '#2f80ff';
        ctx.lineWidth = 4;
        ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
        drawSizeLabel(ctx, sel);
      }
    } else if (mode === 'window' && windowRectRef.current) {
      const wr = windowRectRef.current;
      const rx = wr.x - meta.left;
      const ry = wr.y - meta.top;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, ui.width, ui.height);
      ctx.clearRect(rx, ry, wr.width, wr.height);
      ctx.strokeStyle = '#2f80ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, wr.width, wr.height);
      drawSizeLabel(ctx, { x: rx, y: ry, w: wr.width, h: wr.height });
    }
  }, [mode, currentSelection, confirmed]);

  // ---- 标注渲染(向量图形 + 马赛克),选区位移时整体平移 ----
  const renderAnno = useCallback(() => {
    const a = annoRef.current;
    const meta = metaRef.current;
    const base = annoBaseRef.current;
    const sel = confirmedSelRef.current;
    if (!a || !meta) return;
    const ctx = a.getContext('2d')!;
    ctx.clearRect(0, 0, a.width, a.height);
    const sc = dprRef.current || 1;
    const dx = sel && base ? sel.x - base.x : 0;
    const dy = sel && base ? sel.y - base.y : 0;
    const drawOne = (s: Shape) => {
      const col = s.color;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.max(1, s.width * sc);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const tp = s.pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      switch (s.tool) {
        case 'pencil': {
          ctx.beginPath();
          tp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          break;
        }
        case 'arrow': {
          const [p0, p1] = tp;
          if (!p1) break;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          const len = Math.max(9, 15 * sc);
          const spread = (22 * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(
            p1.x - len * Math.cos(ang - spread),
            p1.y - len * Math.sin(ang - spread),
          );
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(
            p1.x - len * Math.cos(ang + spread),
            p1.y - len * Math.sin(ang + spread),
          );
          ctx.stroke();
          break;
        }
        case 'rect': {
          const [p0, p1] = tp;
          if (!p1) break;
          const x = Math.min(p0.x, p1.x);
          const y = Math.min(p0.y, p1.y);
          const w = Math.abs(p1.x - p0.x);
          const h = Math.abs(p1.y - p0.y);
          ctx.strokeRect(x, y, w, h);
          break;
        }
        case 'ellipse': {
          const [p0, p1] = tp;
          if (!p1) break;
          const cx = (p0.x + p1.x) / 2;
          const cy = (p0.y + p1.y) / 2;
          const rx = Math.abs(p1.x - p0.x) / 2;
          const ry = Math.abs(p1.y - p0.y) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'num': {
          const c = tp[0];
          const r = Math.max(11, 13 * sc);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.round(r * 1.15)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.text || '', c.x, c.y + 1);
          break;
        }
        case 'text': {
          const c = tp[0];
          ctx.fillStyle = col;
          ctx.font = `${Math.round(18 * sc)}px system-ui, sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(s.text || '', c.x, c.y);
          break;
        }
        case 'mosaic': {
          if (s.baked) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(s.baked, tp[0].x, tp[0].y);
          }
          break;
        }
      }
    };
    for (const s of shapesRef.current) drawOne(s);
    const d = drawingRef.current;
    if (d) {
      if (d.tool === 'mosaic') {
        // 拖拽中实时像素化预览:旧实现只画已烘焙图形,拖拽过程零反馈,
        // 松手才出现 → 被感知为「马赛克延迟几秒才显示」(用户反馈)。
        const [a, b] = d.pts;
        const base = baseRef.current;
        if (a && b && base) {
          const rx = Math.min(a.x, b.x);
          const ry = Math.min(a.y, b.y);
          const rw = Math.abs(b.x - a.x);
          const rh = Math.abs(b.y - a.y);
          if (rw >= 4 && rh >= 4) {
            const sc = dprRef.current || 1;
            const block = Math.max(6, Math.round(14 * sc));
            const bw = Math.max(1, Math.floor(rw / block));
            const bh = Math.max(1, Math.floor(rh / block));
            let small = mosaicSmallRef.current;
            if (!small) {
              small = document.createElement('canvas');
              mosaicSmallRef.current = small;
            }
            if (small.width !== bw || small.height !== bh) {
              small.width = bw;
              small.height = bh;
            }
            const sctx = small.getContext('2d')!;
            sctx.imageSmoothingEnabled = true; // 缩小取平均 → 马赛克块色
            sctx.clearRect(0, 0, bw, bh);
            sctx.drawImage(base, rx, ry, rw, rh, 0, 0, bw, bh);
            ctx.imageSmoothingEnabled = false; // 放大不平滑 → 像素块
            ctx.drawImage(small, 0, 0, bw, bh, rx + dx, ry + dy, rw, rh);
            ctx.imageSmoothingEnabled = true;
          }
        }
      } else {
        drawOne(d);
      }
    }
  }, []);

  /** 马赛克烘焙:把底图某区域像素化,返回小图(随选区平移绘制)。 */
  const bakeMosaic = (rect: { x: number; y: number; w: number; h: number }): HTMLCanvasElement => {
    const base = baseRef.current!;
    const sc = dprRef.current || 1;
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d')!;
    tctx.drawImage(base, rect.x, rect.y, w, h, 0, 0, w, h);
    const block = Math.max(6, Math.round(14 * sc));
    const sw = Math.max(1, Math.floor(w / block));
    const sh = Math.max(1, Math.floor(h / block));
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    small.getContext('2d')!.drawImage(tmp, 0, 0, sw, sh);
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
    return tmp;
  };

  const updateMagnifier = useCallback((px: number, py: number) => {
    const img = imgRef.current;
    const mag = magRef.current;
    if (!img || !mag) return;
    const zoom = 4;
    const size = 120;
    const srcSize = size / zoom;
    mag.width = size;
    mag.height = size;
    const ctx = mag.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, size, size);
    const sx = Math.max(0, px - srcSize / 2);
    const sy = Math.max(0, py - srcSize / 2);
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
    ctx.strokeStyle = 'rgba(47,128,255,0.9)';
    ctx.strokeRect(size / 2 - 0.5, size / 2 - 0.5, 1, 1);
  }, []);

  const toPhysical = (clientX: number, clientY: number) => {
    const dpr = dprRef.current;
    return { x: clientX * dpr, y: clientY * dpr };
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2200);
  };

  /** 结束本轮流程:唯一出口,隐藏预热窗(0.4.41 终版:不再恢复主窗)。
   *
   * 关键时序:**先把覆盖层复位为完全透明的待命帧并等待两帧合成上屏,再隐藏窗口**。
   * WebView2 窗口隐藏期间渲染挂起,下次 show 的第一帧是上一次合成帧的残留 ——
   * 若残留是冻结帧/暗罩+选框画面,用户会看到「开始截图先闪一个框」。
   * 让最后一帧变成透明待命帧后,show 的首帧残留即透明(与桌面一致,不可见)。
   * 又因主窗全程不被隐藏、始终在覆盖层下方,透明帧与真实桌面逐像素一致,
   * 开始/结束两个方向的过渡都无感 → 开始零闪框、退出零弹动。 */
  const finish = useCallback(async () => {
    setBusy(true);
    // ① 复位全部 UI 状态(工具条/操作条/手柄/放大镜随 ready/confirmed 消失)。
    setReady(false);
    setConfirmed(false);
    confirmedRef.current = false;
    setSelDisp(null);
    setTextInput({ x: 0, y: 0, ax: 0, ay: 0, value: '', visible: false });
    dragRef.current = null;
    confirmedSelRef.current = null;
    handleDragRef.current = null;
    moveDragRef.current = null;
    drawingRef.current = null;
    annoBaseRef.current = null;
    shapesRef.current = [];
    numCounterRef.current = 0;
    toolRef.current = 'move';
    setActiveToolState('move');
    if (uiRef.current) uiRef.current.style.cursor = 'default';
    // ② 清空四层画布 → 窗口内容变回纯透明。
    for (const r of [baseRef, mosaicRef, annoRef, uiRef]) {
      const c = r.current;
      if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    }
    // ③ 等两帧:确保透明待命帧已真正合成上屏(此刻窗口仍可见,
    //    但内容 = 覆盖层透明 → 桌面原样透出,视觉上截图已"无痕"结束)。
    //    兜底:rAF 在窗口不可见等极端场景可能不触发,120ms 超时保底。
    await new Promise<void>((resolve) => {
      let done = false;
      const step = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(step));
      window.setTimeout(step, 120);
    });
    // ④ 隐藏窗口(桌面无任何变化,零弹动)。
    await finishOverlay();
    setBusy(false);
  }, [clearAnnoCanvas]);

  /** 从底图 + 标注层裁剪选区 → PNG base64。 */
  const extractPng = (sel: Sel): string => {
    const base = baseRef.current!;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sel.w));
    out.height = Math.max(1, Math.round(sel.h));
    const octx = out.getContext('2d')!;
    octx.drawImage(base, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
    if (mosaicRef.current)
      octx.drawImage(mosaicRef.current, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
    if (annoRef.current)
      octx.drawImage(annoRef.current, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
    return out.toDataURL('image/png').split(',')[1] ?? '';
  };

  /** 固化确认选区:记录基准 + 初始化标注原点。 */
  const applyConfirm = (sel: Sel) => {
    confirmedSelRef.current = sel;
    setSelDisp(sel);
    annoBaseRef.current = { x: sel.x, y: sel.y };
    setConfirmed(true);
    confirmedRef.current = true;
    dragRef.current = null;
    selectTool('move');
    redrawUI();
  };

  // ---- 操作条动作 ----
  const onCopy = useCallback(async () => {
    const sel = confirmedSelRef.current;
    if (!sel || busy) return;
    setBusy(true);
    try {
      const png = extractPng(sel);
      await writeClipboardImage(png);
      await stashImage(LAST_KEY, png);
      await shotLog(`copy ok ${Math.round(sel.w)}x${Math.round(sel.h)}`);
      // 复制后直接退出截图模式(原「复制后自动关闭」开关已移除,行为固定)。
      await finish();
    } catch (e) {
      setBusy(false);
      void shotLog(`copy fail: ${String(e)}`);
      showToast(`复制失败: ${String(e)}`);
    }
  }, [busy, finish]);

  const onPin = useCallback(async () => {
    const sel = confirmedSelRef.current;
    const meta = metaRef.current;
    if (!sel || !meta || busy) return;
    setBusy(true);
    try {
      const png = extractPng(sel);
      await stashImage(LAST_KEY, png);
      // 原位钉屏:贴图位置 = 选区在虚拟屏上的物理坐标。
      await pinImage(png, meta.left + sel.x, meta.top + sel.y);
      await shotLog(`pin ok ${Math.round(sel.w)}x${Math.round(sel.h)}`);
      await finish();
    } catch (e) {
      setBusy(false);
      void shotLog(`pin fail: ${String(e)}`);
      showToast(`贴图失败: ${String(e)}`);
    }
  }, [busy, finish]);

  const onSave = useCallback(async () => {
    const sel = confirmedSelRef.current;
    if (!sel || busy) return;
    setBusy(true);
    try {
      const png = extractPng(sel);
      await stashImage(LAST_KEY, png);
      // 「另存为」:弹出系统保存对话框,用户自选目录与文件名。
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `TickTask-截屏-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
      const target = await saveFileDialog({
        defaultPath: name,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (!target) {
        // 用户取消对话框:不结束截图,回到操作条可继续调整。
        setBusy(false);
        return;
      }
      const path = await saveImageTo(png, target);
      await shotLog(`save ok ${path}`);
      await finish();
    } catch (e) {
      setBusy(false);
      void shotLog(`save fail: ${String(e)}`);
      showToast(`保存失败: ${String(e)}`);
    }
  }, [busy, finish]);

  /** 把当前(拖拽 / 窗口 / 全屏)选区固化为已确认状态。 */
  const confirmSelection = useCallback(() => {
    if (!ready || confirmed) return;
    let sel: Sel | null = null;
    if (mode === 'region') {
      sel = currentSelection();
      if (!sel || sel.w < 5 || sel.h < 5) return;
    } else if (mode === 'window') {
      const meta = metaRef.current;
      const wr = windowRectRef.current;
      if (!meta || !wr) return;
      sel = { x: wr.x - meta.left, y: wr.y - meta.top, w: wr.width, h: wr.height };
    } else {
      const meta = metaRef.current;
      if (!meta) return;
      sel = { x: 0, y: 0, w: meta.width, h: meta.height };
    }
    applyConfirm(sel);
  }, [ready, confirmed, mode, currentSelection, redrawUI]);

  /** 贴图快捷键在覆盖层激活时触发(问题6):钉**当前正在截**的选区;
   * 未确认时先按当前模式固化选区(无有效选区则整屏)。 */
  const onPinHotkey = useCallback(() => {
    if (!ready || busy) return;
    if (!confirmed) {
      let sel: Sel | null = null;
      const meta = metaRef.current;
      if (mode === 'region') {
        sel = currentSelection();
      } else if (mode === 'window' && meta && windowRectRef.current) {
        const wr = windowRectRef.current;
        sel = { x: wr.x - meta.left, y: wr.y - meta.top, w: wr.width, h: wr.height };
      }
      if ((!sel || sel.w < 5 || sel.h < 5) && meta) {
        sel = { x: 0, y: 0, w: meta.width, h: meta.height };
      }
      if (!sel) return;
      applyConfirm(sel);
    }
    void onPin();
  }, [ready, busy, confirmed, mode, currentSelection, onPin]);

  // ---- 手柄拖拽调整已确认选区(问题8) ----
  const onHandleDown = (e: React.MouseEvent, id: string) => {
    const sel = confirmedSelRef.current;
    if (!sel || busy) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toPhysical(e.clientX, e.clientY);
    handleDragRef.current = { handle: id, start: { ...sel }, x0: p.x, y0: p.y };
  };

  useEffect(() => {
    const onMove = (ev: globalThis.MouseEvent) => {
      const hd = handleDragRef.current;
      const meta = metaRef.current;
      if (!hd || !meta) return;
      const dpr = dprRef.current || 1;
      const cx = ev.clientX * dpr;
      const cy = ev.clientY * dpr;
      const min = 5;
      const { start } = hd;
      let x = start.x;
      let y = start.y;
      let w = start.w;
      let h = start.h;
      if (hd.handle.includes('e')) w = start.w + (cx - hd.x0);
      if (hd.handle.includes('s')) h = start.h + (cy - hd.y0);
      if (hd.handle.includes('w')) {
        x = Math.max(0, start.x + (cx - hd.x0));
        w = start.x + start.w - x;
      }
      if (hd.handle.includes('n')) {
        y = Math.max(0, start.y + (cy - hd.y0));
        h = start.y + start.h - y;
      }
      // 边界钳制:不越出屏幕,不小于 5 物理像素。
      w = Math.min(w, meta.width - x);
      h = Math.min(h, meta.height - y);
      const sel: Sel = { x, y, w: Math.max(min, w), h: Math.max(min, h) };
      confirmedSelRef.current = sel;
      setSelDisp(sel);
      redrawUI();
    };
    const onUp = () => {
      handleDragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [redrawUI]);

  // 操作条右对齐定位:确认后实测宽度(问题1)。
  useEffect(() => {
    if (confirmed && barRef.current) {
      setBarW(barRef.current.offsetWidth || 264);
    }
  }, [confirmed, selDisp]);

  // ---- 标注交互(鼠标移动 / 抬起,监听 window 保证绘制不被 DOM 阻挡) ----
  useEffect(() => {
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!confirmedRef.current) return;
      // 整体平移选区(功能1)。
      if (moveDragRef.current) {
        const md = moveDragRef.current;
        const meta = metaRef.current;
        const sel = confirmedSelRef.current;
        if (!meta || !sel) return;
        const dpr = dprRef.current || 1;
        const px = ev.clientX * dpr;
        const py = ev.clientY * dpr;
        let nx = md.startX + (px - md.x0);
        let ny = md.startY + (py - md.y0);
        nx = Math.max(0, Math.min(nx, meta.width - sel.w));
        ny = Math.max(0, Math.min(ny, meta.height - sel.h));
        sel.x = nx;
        sel.y = ny;
        confirmedSelRef.current = sel;
        setSelDisp({ ...sel });
        redrawUI();
        renderAnno();
        return;
      }
      // 绘制中。
      if (drawingRef.current) {
        const dpr = dprRef.current || 1;
        const px = ev.clientX * dpr;
        const py = ev.clientY * dpr;
        const s = drawingRef.current;
        if (s.tool === 'pencil') s.pts.push({ x: px, y: py });
        else if (s.tool === 'arrow' || s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'mosaic')
          s.pts[1] = { x: px, y: py };
        // rAF 合帧:高频 mousemove 下每帧最多渲染一次,防渲染排队造成可见延迟。
        if (!rafRef.current) {
          rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = 0;
            renderAnno();
          });
        }
        return;
      }
    };
    const onUp = () => {
      if (moveDragRef.current) {
        moveDragRef.current = null;
        return;
      }
      if (drawingRef.current) {
        const s = drawingRef.current;
        drawingRef.current = null;
        finalizeShape(s);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redrawUI, renderAnno]);

  /** 收尾一个绘制中的图形(校验有效性 / 烘焙马赛克)。 */
  const finalizeShape = (s: Shape) => {
    if (s.tool === 'pencil') {
      if (s.pts.length < 2) return;
    } else if (s.tool === 'arrow' || s.tool === 'rect' || s.tool === 'ellipse') {
      const [a, b] = s.pts;
      if (!b || (Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4)) return;
    } else if (s.tool === 'mosaic') {
      const [a, b] = s.pts;
      if (!b) return;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      if (w < 6 || h < 6) return;
      s.pts = [
        { x, y },
        { x: x + w, y: y + h },
      ];
      s.baked = bakeMosaic({ x, y, w, h });
    }
    shapesRef.current.push(s);
    renderAnno();
  };

  /** 命中测试(橡皮擦):返回是否点中该图形。 */
  const hitShape = (s: Shape, p: Pt): boolean => {
    const sc = dprRef.current || 1;
    if (s.tool === 'mosaic' || s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'num' || s.tool === 'text') {
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const q of s.pts) {
        minx = Math.min(minx, q.x);
        miny = Math.min(miny, q.y);
        maxx = Math.max(maxx, q.x);
        maxy = Math.max(maxy, q.y);
      }
      const pad = s.tool === 'num' ? 14 * sc : s.tool === 'text' ? 18 * sc : Math.max(6, (s.width * sc) / 2 + 4);
      return p.x >= minx - pad && p.x <= maxx + pad && p.y >= miny - pad && p.y <= maxy + pad;
    }
    const tol = Math.max(6, (s.width * sc) / 2 + 4);
    for (let i = 0; i < s.pts.length - 1; i++) {
      if (distToSeg(p, s.pts[i], s.pts[i + 1]) <= tol) return true;
    }
    if (s.pts.length === 1) {
      const q = s.pts[0];
      return Math.hypot(p.x - q.x, p.y - q.y) <= tol;
    }
    return false;
  };

  const distToSeg = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  };

  // ---- 每轮初始化(runId 驱动) ----
  useEffect(() => {
    if (runId === 0) return; // 0 = 挂载待命,无数据
    let disposed = false;
    (async () => {
      try {
        // 主窗口 stash 在 emit 之前完成,理论上必有;重试兜底事件竞态。
        let raw: string | null = null;
        for (let i = 0; i < 5 && !raw; i++) {
          raw = await takeImage(FULL_KEY);
          if (!raw) await new Promise((r) => setTimeout(r, 60));
        }
        if (!raw) throw new Error('截图数据不存在');
        const meta = JSON.parse(raw) as CaptureMeta;
        if (!meta || !meta.path) throw new Error('截图数据不完整');
        if (disposed) return;
        metaRef.current = meta;
        // 关键时序(0.4.41):**先在隐藏态完成覆盖层定位**,再加载/绘制冻结帧。
        // 旧实现定位与显示同帧执行,WebView2 首帧可能是按旧窗口尺寸栅格化的
        // 画面 → 用户看到「先出现一个框,再闪烁成全屏截图」。定位与显示之间
        // 隔着图片加载+绘制(数百毫秒),重排在隐藏态悄然完成,首帧即正确。
        try {
          await invoke('position_capture_overlay', {
            left: meta.left,
            top: meta.top,
            width: meta.width,
            height: meta.height,
          });
        } catch (e) {
          await shotLog(`position_capture_overlay failed: ${String(e)}`);
        }
        if (disposed) return;
        // 整屏 PNG 从 Rust 侧读回 base64(见下方 data: URL 注释)。
        const captureB64 = await invoke<string>('read_capture_png', {
          path: meta.path,
        });
        if (disposed) return;
        setMode(meta.mode ?? 'region');
        setRatio('free');
        setConfirmed(false);
        confirmedRef.current = false;
        setToast('');
        // 复位标注状态(新一轮)。
        shapesRef.current = [];
        numCounterRef.current = 0;
        drawingRef.current = null;
        moveDragRef.current = null;
        annoBaseRef.current = null;
        selectTool('move');
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            imgRef.current = img;
            dprRef.current = window.devicePixelRatio || 1;
            sizeCanvases(meta.width, meta.height);
            drawBase();
            clearAnnoCanvas();
            resolve();
          };
          img.onerror = () => reject(new Error('截图解码失败'));
          // ⚠️ 必须经 Rust 读回 base64 用 data: URL 加载,不能用 convertFileSrc:
          // asset:// 跨源图会把 canvas 标记为 tainted,extractPng 的 toDataURL()
          // 抛 SecurityError → 复制/贴图/保存全部失败。
          img.src = `data:image/png;base64,${captureB64}`;
        });
        if (!disposed) {
          setReady(true);
          // 双保险:ready 翻转后 canvas 必然在 DOM,下一帧再补一次尺寸+绘制,
          // 防御任何 ref 时序问题(本轮修复的核心教训:静默空转不可接受)。
          window.requestAnimationFrame(() => {
            if (disposed) return;
            const meta2 = metaRef.current;
            const img2 = imgRef.current;
            if (meta2 && img2 && baseRef.current) {
              sizeCanvases(meta2.width, meta2.height);
              drawBase();
              clearAnnoCanvas();
              redrawUI();
            }
            // 冻结帧已上屏:此刻才显示覆盖层(定位早已在隐藏态完成)。
            // 只显示+置焦,不动主窗(主窗全程在覆盖层下方,冻结帧与其一致)。
            if (metaRef.current) {
              invoke('show_capture_overlay').catch(async (e) => {
                await shotLog(`show_capture_overlay failed: ${String(e)}`);
                if (!disposed && activatedRef.current) await finishOverlay();
              });
            }
          });
          void shotLog('overlay ui ready');
        }
      } catch (e) {
        console.error('覆盖层初始化失败', e);
        await shotLog(`overlay init failed: ${String(e)}`);
        if (!disposed && activatedRef.current) {
          setReady(false);
          setConfirmed(false);
          confirmedRef.current = false;
          await finishOverlay();
        }
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // ---- 监听主窗口触发 + 键盘 ----
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen('overlay-show', () => {
      // 防抖:主窗口的就绪轮询机制会对同一轮触发多次 emit,800ms 内忽略。
      const now = Date.now();
      if (now - lastTriggerRef.current < 800) return;
      lastTriggerRef.current = now;
      activatedRef.current = true;
      setRunId((v) => v + 1);
    }).then((fn) => {
      unlisten = fn;
    });
    const onKey = (e: KeyboardEvent) => {
      if (!activatedRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // 文字输入进行中:仅取消输入,不退出截图。
        if (textInput.visible) {
          setTextInput((v) => ({ ...v, visible: false }));
          return;
        }
        void shotLog('overlay cancel (esc)');
        void finish();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (textInput.visible) {
          commitText();
          return;
        }
        if (confirmed) void onCopy();
        else confirmSelection();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        // Ctrl+C 复制(问题4):与主流截图工具一致,无需点「复制」按钮。
        e.preventDefault();
        if (confirmed && !textInput.visible) void onCopy();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undoShape();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unlisten?.();
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed, finish, confirmSelection, onCopy, textInput.visible]);

  // 贴图快捷键(覆盖层激活时由主窗口转发,问题6)。
  useEffect(() => {
    let unlistenPin: (() => void) | undefined;
    void listen('pin-hotkey', () => onPinHotkey()).then((fn) => {
      unlistenPin = fn;
    });
    return () => unlistenPin?.();
  }, [onPinHotkey]);

  /** 撤销:删除最近一个图形。 */
  const undoShape = useCallback(() => {
    if (shapesRef.current.length === 0) return;
    shapesRef.current.pop();
    renderAnno();
  }, [renderAnno]);

  /** 清空:删除全部标注。 */
  const clearShapes = useCallback(() => {
    shapesRef.current = [];
    numCounterRef.current = 0;
    renderAnno();
  }, [renderAnno]);

  /** 提交文字图形。 */
  const commitText = useCallback(() => {
    setTextInput((v) => {
      const val = v.value.trim();
      if (val) {
        shapesRef.current.push({
          id: idRef.current++,
          tool: 'text',
          color: annoColor,
          width: annoWidth,
          pts: [{ x: v.ax, y: v.ay }],
          text: val,
        });
        renderAnno();
      }
      return { ...v, visible: false, value: '' };
    });
  }, [annoColor, annoWidth, renderAnno]);

  // 文字输入框出现后兜底抢焦点:setTimeout 0 排到浏览器默认焦点处理之后,
  // 确保任何时序下输入框都处于可输入状态。
  useEffect(() => {
    if (!textInput.visible) return;
    const t = window.setTimeout(() => textInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [textInput.visible]);

  const onMouseDown = (e: React.MouseEvent) => {
    // 右键 = 取消截图(与 Esc 等效,问题3)。
    if (e.button === 2) {
      e.preventDefault();
      void shotLog('overlay cancel (right-click)');
      void finish();
      return;
    }
    if (e.button !== 0) return;
    if (!ready) return;
    if (!confirmed) {
      if (mode === 'window') {
        confirmSelection();
        return;
      }
      const p = toPhysical(e.clientX, e.clientY);
      dragRef.current = { x0: p.x, y0: p.y };
      cursorRef.current = p;
      redrawUI();
      return;
    }
    // 已确认:根据当前工具决定「平移选区」或「绘制」。
    const p = toPhysical(e.clientX, e.clientY);
    const tool = toolRef.current;
    if (tool === 'move') {
      const sel = confirmedSelRef.current;
      if (sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h) {
        moveDragRef.current = {
          startX: sel.x,
          startY: sel.y,
          x0: p.x,
          y0: p.y,
        };
      }
      return;
    }
    if (tool === 'eraser') {
      for (let i = shapesRef.current.length - 1; i >= 0; i--) {
        if (hitShape(shapesRef.current[i], p)) {
          shapesRef.current.splice(i, 1);
          break;
        }
      }
      renderAnno();
      return;
    }
    if (tool === 'text') {
      // ⚠️ 必须 preventDefault:浏览器 mousedown 默认行为会把焦点夺回 body,
      // 输入框 autoFocus 后立即被 blur → onBlur 触发 commitText → 输入框
      // 闪现即消失(用户看到「单击没有出现可编辑文本框」)。
      e.preventDefault();
      e.stopPropagation();
      // 已有输入框:先提交旧文字,再开新框(与主流截图工具一致)。
      if (textInput.visible) commitText();
      setTextInput({
        x: e.clientX,
        y: e.clientY,
        ax: p.x,
        ay: p.y,
        value: '',
        visible: true,
      });
      return;
    }
    if (tool === 'num') {
      numCounterRef.current += 1;
      shapesRef.current.push({
        id: idRef.current++,
        tool: 'num',
        color: annoColor,
        width: annoWidth,
        pts: [{ x: p.x, y: p.y }],
        text: String(numCounterRef.current),
      });
      renderAnno();
      return;
    }
    // arrow / pencil / rect / ellipse / mosaic
    const tool2 = tool as Exclude<ActiveTool, 'move' | 'eraser' | 'text' | 'num'>;
    const shape: Shape = {
      id: idRef.current++,
      tool: tool2,
      color: annoColor,
      width: annoWidth,
      pts: [{ x: p.x, y: p.y }],
    };
    if (tool2 !== 'pencil') shape.pts.push({ x: p.x, y: p.y });
    drawingRef.current = shape;
  };

  const onMouseMove = async (e: React.MouseEvent) => {
    const p = toPhysical(e.clientX, e.clientY);
    cursorRef.current = p;
    // 已确认态光标仅用于放大镜(已隐藏),跳过 setState 避免高频 mousemove
    // 触发整组件重渲染(标注/马赛克场景下是无谓开销)。
    if (!confirmed) setCursor({ x: e.clientX, y: e.clientY });
    if (confirmed) {
      // 指针工具悬停在选区内 → 四向移动光标(与主流截图工具一致);
      // 其他标注工具 → 十字光标。直接写 style,不走 setState。
      const ui = uiRef.current;
      if (ui) {
        const tool = toolRef.current;
        const sel = confirmedSelRef.current;
        const inside =
          !!sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;
        ui.style.cursor = tool === 'move' ? (inside ? 'move' : 'default') : 'crosshair';
      }
      return; // 已确认:绘制/平移由 window 监听处理
    }
    if (mode === 'window' && metaRef.current) {
      const meta = metaRef.current;
      const wr = await windowAtPoint(
        Math.round(meta.left + p.x),
        Math.round(meta.top + p.y),
      );
      windowRectRef.current = wr;
    }
    redrawUI();
    updateMagnifier(p.x, p.y);
  };

  const onMouseUp = () => {
    if (mode === 'region' && dragRef.current && !confirmed) {
      const sel = currentSelection();
      if (sel && sel.w >= 5 && sel.h >= 5) {
        // 松手即确认,弹出操作条。
        confirmSelection();
      } else {
        dragRef.current = null;
        redrawUI();
      }
    }
  };

  // 操作条位置:与选区**右下角**对齐(用户习惯从左往右框选,松手时光标在右下,
  // 操作条应出现在手边,问题1);贴近屏幕底边时改放选区上方。
  const actionBarStyle = (): React.CSSProperties => {
    const sel = confirmedSelRef.current;
    const dpr = dprRef.current || 1;
    if (!sel) return { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' };
    const vw = (metaRef.current?.width ?? 0) / dpr;
    const vh = (metaRef.current?.height ?? 0) / dpr;
    const left = Math.max(8, Math.min((sel.x + sel.w) / dpr - barW, vw - barW - 8));
    const below = (sel.y + sel.h) / dpr + 10;
    const top = below + 44 > vh ? Math.max(8, sel.y / dpr - 48) : below;
    return { left, top };
  };

  // ⚠️ canvas 必须**常驻 DOM**:初始化 effect 里的 sizeCanvases/drawBase 在
  // setReady(true) 之前执行,若 canvas 尚未挂载(refs 为 null)会静默空转,
  // 导致覆盖层显示空白 300×150 画布 → 桌面原样透出、复制/贴图全空。
  // 因此这里永远渲染 canvas,仅用 ready 门控交互与操作条等 UI。
  return (
    <div className="capture-overlay-root" onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={baseRef} className="capture-base" />
      <canvas ref={mosaicRef} className="capture-mosaic" />
      <canvas ref={annoRef} className="capture-anno" />
      <canvas
        ref={uiRef}
        className="capture-ui"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      {ready && (
        <>
          {confirmed && selDisp && !busy && activeTool === 'move' && (
            <div className="capture-handles">
              {HANDLES.map((h) => (
                <div
                  key={h.id}
                  className={`capture-handle handle-${h.id}`}
                  style={{
                    left: h.fx(selDisp) / (dprRef.current || 1) - 6,
                    top: h.fy(selDisp) / (dprRef.current || 1) - 6,
                  }}
                  onMouseDown={(e) => onHandleDown(e, h.id)}
                />
              ))}
            </div>
          )}
          <div
            className="capture-magnifier"
            style={{
              left: cursor.x + 16,
              top: cursor.y + 16,
              display: !confirmed && cursor.x >= 0 ? 'block' : 'none',
            }}
          >
            <canvas ref={magRef} />
          </div>
          {!confirmed && (
            <div className="capture-toolbar">
              <div className="ctb-group">
                <button className={mode === 'region' ? 'is-active' : ''} onClick={() => setMode('region')}>
                  区域
                </button>
                <button className={mode === 'window' ? 'is-active' : ''} onClick={() => setMode('window')}>
                  窗口
                </button>
              </div>
              <div className="ctb-group">
                <label>比例</label>
                <select
                  value={ratio}
                  onChange={(e) => setRatio(e.target.value as Ratio)}
                  disabled={mode !== 'region'}
                >
                  <option value="free">自由</option>
                  <option value="1:1">1:1</option>
                  <option value="4:3">4:3</option>
                  <option value="16:9">16:9</option>
                </select>
              </div>
              <div className="ctb-group ctb-hint">拖拽框选 · 松手确认 · Enter 复制 · 右键/Esc 取消</div>
            </div>
          )}
          {confirmed && (
            <div className="capture-annotbar">
              <div className="cab-tools">
                <button
                  className={`cab-tool-label ${activeTool === 'move' ? 'is-active' : ''}`}
                  onClick={() => selectTool('move')}
                  title="选择 / 移动 (V)"
                >
                  指针
                </button>
                <button className={activeTool === 'arrow' ? 'is-active' : ''} onClick={() => selectTool('arrow')} title="箭头">
                  ↗
                </button>
                <button className={activeTool === 'pencil' ? 'is-active' : ''} onClick={() => selectTool('pencil')} title="画笔">
                  ✎
                </button>
                <button className={activeTool === 'rect' ? 'is-active' : ''} onClick={() => selectTool('rect')} title="矩形">
                  ▭
                </button>
                <button className={activeTool === 'ellipse' ? 'is-active' : ''} onClick={() => selectTool('ellipse')} title="椭圆">
                  ◯
                </button>
                <button className={activeTool === 'num' ? 'is-active' : ''} onClick={() => selectTool('num')} title="序号">
                  ①
                </button>
                <button className={activeTool === 'text' ? 'is-active' : ''} onClick={() => selectTool('text')} title="文字">
                  A
                </button>
                <button className={activeTool === 'mosaic' ? 'is-active' : ''} onClick={() => selectTool('mosaic')} title="马赛克">
                  ▦
                </button>
                <button className={activeTool === 'eraser' ? 'is-active' : ''} onClick={() => selectTool('eraser')} title="橡皮擦">
                  <Eraser size={15} />
                </button>
              </div>
              <div className="cab-colors">
                {COLORS.map((c) => (
                  <span
                    key={c}
                    className={`cab-color ${annoColor === c ? 'is-active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setAnnoColor(c)}
                  />
                ))}
              </div>
              <div className="cab-widths">
                {[2, 4, 7].map((w) => (
                  <span
                    key={w}
                    className={`cab-width ${annoWidth === w ? 'is-active' : ''}`}
                    onClick={() => setAnnoWidth(w)}
                  >
                    <i style={{ height: w }} />
                  </span>
                ))}
              </div>
              <div className="cab-actions2">
                <button onClick={() => undoShape()} title="撤销 (Ctrl+Z)">
                  撤销
                </button>
                <button onClick={() => clearShapes()} title="清空标注">
                  清空
                </button>
              </div>
            </div>
          )}
          {confirmed && (
            <div ref={barRef} className="capture-actionbar" style={actionBarStyle()}>
              <button type="button" className="cab-btn" disabled={busy} onClick={onPin} title="钉在桌面原位">
                <Pin size={15} />
                贴图
              </button>
              <button type="button" className="cab-btn" disabled={busy} onClick={onSave} title="保存为 PNG 文件">
                <Save size={15} />
                保存
              </button>
              <button type="button" className="cab-btn cab-cancel" disabled={busy} onClick={() => void finish()} title="取消(Esc)">
                <X size={15} />
                取消
              </button>
              <button type="button" className="cab-btn" disabled={busy} onClick={onCopy} title="复制到剪贴板(Enter)">
                <Copy size={15} />
                复制
              </button>
            </div>
          )}
          {textInput.visible && (
            <input
              ref={textInputRef}
              className="capture-text-input"
              autoFocus
              style={{ left: textInput.x, top: textInput.y }}
              value={textInput.value}
              placeholder="输入文字…"
              onChange={(e) => setTextInput((v) => ({ ...v, value: e.target.value }))}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTextInput((v) => ({ ...v, visible: false, value: '' }));
                }
              }}
            />
          )}
          {toast && <div className="capture-toast">{toast}</div>}
        </>
      )}
    </div>
  );
}
