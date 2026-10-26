// 截图标注编辑器:在选区截图上进行矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克 / 模糊 /
// 高亮 / 序号标注,支持撤销重做,以及复制到剪贴板 / 保存到本地 / 钉到桌面。
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  REGION_KEY,
  dataUrlToBase64,
  openPin,
  restoreMain,
  saveImage,
  shotLog,
  takeImage,
  writeClipboardImage,
} from './bridge';
import { addPin as addPinStore } from './store';

type Tool =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'pen'
  | 'text'
  | 'mosaic'
  | 'blur'
  | 'highlight'
  | 'number';

export default function ScreenshotEditor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const actionsRef = useRef<Action[]>([]);
  const redoRef = useRef<Action[]>([]);
  const drawingRef = useRef<{ tool: Tool; start: Point; points: Point[] } | null>(null);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState('#ff3b30');
  const [width, setWidth] = useState(4);
  const [toast, setToast] = useState('');
  const [numberSeq, setNumberSeq] = useState(1);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2200);
  };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const base = baseCanvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    for (const a of actionsRef.current) drawAction(ctx, base, a);
  }, []);

  useEffect(() => {
    (async () => {
      const png = await takeImage(REGION_KEY);
      if (!png) {
        await shotLog('editor open: region data missing, closing');
        getCurrentWindow().close();
        restoreMain();
        return;
      }
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        baseCanvasRef.current = c;
        const canvas = canvasRef.current!;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        redraw();
        setReady(true);
        void shotLog('editor ready');
      };
      img.src = `data:image/png;base64,${png}`;
    })();

    getCurrentWindow()
      .onCloseRequested(() => {
        restoreMain();
      })
      .catch(() => {});

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toCanvas = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  const undo = useCallback(() => {
    const a = actionsRef.current.pop();
    if (a) {
      redoRef.current.push(a);
      redraw();
    }
  }, [redraw]);

  const redo = useCallback(() => {
    const a = redoRef.current.pop();
    if (a) {
      actionsRef.current.push(a);
      redraw();
    }
  }, [redraw]);

  const pushAction = (a: Action) => {
    actionsRef.current.push(a);
    redoRef.current = [];
    redraw();
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const p = toCanvas(e);
    if (tool === 'select') return;
    if (tool === 'text') {
      const text = window.prompt('输入文字');
      if (text) pushAction({ type: 'text', x: p.x, y: p.y, text, color, size: 24 });
      return;
    }
    if (tool === 'number') {
      const n = numberSeq;
      setNumberSeq(n + 1);
      pushAction({ type: 'number', x: p.x, y: p.y, n, color, size: 28 });
      return;
    }
    drawingRef.current = { tool, start: p, points: [p] };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drawingRef.current;
    if (!d) return;
    const p = toCanvas(e);
    d.points.push(p);
    if (d.tool === 'pen') {
      redraw();
      const ctx = canvasRef.current!.getContext('2d')!;
      const a: Action = {
        type: 'pen',
        points: [...d.points],
        color,
        width,
      };
      // 临时绘制
      drawAction(ctx, baseCanvasRef.current!, a);
    } else {
      redraw();
      const end =
        d.tool === 'mosaic' || d.tool === 'blur' || d.tool === 'highlight'
          ? p
          : p;
      const a = makeBoxOrArrow(d.tool, d.start, end, color, width);
      if (a) {
        const ctx = canvasRef.current!.getContext('2d')!;
        drawAction(ctx, baseCanvasRef.current!, a);
      }
    }
  };

  const onMouseUp = () => {
    const d = drawingRef.current;
    if (!d) return;
    drawingRef.current = null;
    const pts = d.points;
    const end = pts[pts.length - 1];
    if (d.tool === 'pen') {
      if (pts.length > 1) pushAction({ type: 'pen', points: pts, color, width });
    } else if (
      d.tool === 'mosaic' ||
      d.tool === 'blur' ||
      d.tool === 'highlight'
    ) {
      const x = Math.min(d.start.x, end.x);
      const y = Math.min(d.start.y, end.y);
      const w = Math.abs(end.x - d.start.x);
      const h = Math.abs(end.y - d.start.y);
      if (w > 3 && h > 3) {
        if (d.tool === 'mosaic') {
          pushAction({ type: 'mosaic', x, y, w, h, block: Math.max(4, Math.round(width * 2)) });
        } else if (d.tool === 'blur') {
          pushAction({ type: 'blur', x, y, w, h, radius: Math.max(2, width) });
        } else {
          pushAction({ type: 'highlight', x, y, w, h, color });
        }
      }
    } else {
      const w = Math.abs(end.x - d.start.x);
      const h = Math.abs(end.y - d.start.y);
      if (w > 3 || h > 3) {
        pushAction(makeBoxOrArrow(d.tool, d.start, end, color, width)!);
      }
    }
  };

  const exportDataUrl = (): string => {
    return canvasRef.current!.toDataURL('image/png');
  };

  const copy = async () => {
    try {
      await writeClipboardImage(dataUrlToBase64(exportDataUrl()));
      showToast('已复制到剪贴板');
    } catch (e) {
      showToast('复制失败:' + String(e));
    }
  };

  const save = async () => {
    try {
      const path = await saveImage(dataUrlToBase64(exportDataUrl()));
      showToast('已保存:' + path);
    } catch (e) {
      showToast('保存失败:' + String(e));
    }
  };

  const pin = async () => {
    const dataUrl = exportDataUrl();
    const id = `pin-${Date.now()}`;
    // 仅登记元数据;图片不入 localStorage(会撑爆配额),openPin 内部自传 base64。
    addPinStore(id);
    const img = imgRef.current!;
    await openPin(id, img.naturalWidth, img.naturalHeight, dataUrl);
    finish();
  };

  const finish = () => {
    void shotLog('editor finish');
    getCurrentWindow().close();
    restoreMain();
  };

  if (!ready) return <div className="shot-loading">正在加载截图…</div>;

  return (
    <div className="editor-root">
      <div className="editor-toolbar">
        <div className="etb-group">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              className={tool === t.key ? 'is-active' : ''}
              title={t.label}
              onClick={() => setTool(t.key as Tool)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="etb-group">
          <label>颜色</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <div className="etb-group">
          <label>粗细</label>
          <input
            type="range"
            min={1}
            max={20}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </div>
        <div className="etb-group">
          <button onClick={undo} title="撤销 Ctrl+Z">撤销</button>
          <button onClick={redo} title="重做 Ctrl+Y">重做</button>
        </div>
        <div className="etb-group etb-actions">
          <button className="primary" onClick={copy}>复制</button>
          <button onClick={save}>保存</button>
          <button onClick={pin}>钉桌面</button>
          <button onClick={finish}>完成</button>
        </div>
      </div>
      <div className="editor-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="editor-canvas"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
      </div>
      {toast && <div className="editor-toast">{toast}</div>}
    </div>
  );
}

// ---------- 类型与绘制 ----------
interface Point {
  x: number;
  y: number;
}
type Action =
  | { type: 'rect'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { type: 'ellipse'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: 'pen'; points: Point[]; color: string; width: number }
  | { type: 'text'; x: number; y: number; text: string; color: string; size: number }
  | { type: 'mosaic'; x: number; y: number; w: number; h: number; block: number }
  | { type: 'blur'; x: number; y: number; w: number; h: number; radius: number }
  | { type: 'highlight'; x: number; y: number; w: number; h: number; color: string }
  | { type: 'number'; x: number; y: number; n: number; color: string; size: number };

const TOOLS: { key: string; label: string }[] = [
  { key: 'rect', label: '矩形' },
  { key: 'ellipse', label: '椭圆' },
  { key: 'arrow', label: '箭头' },
  { key: 'pen', label: '画笔' },
  { key: 'text', label: '文字' },
  { key: 'mosaic', label: '马赛克' },
  { key: 'blur', label: '模糊' },
  { key: 'highlight', label: '高亮' },
  { key: 'number', label: '序号' },
];

function makeBoxOrArrow(
  tool: Tool,
  start: Point,
  end: Point,
  color: string,
  width: number,
): Action | null {
  if (tool === 'rect') {
    return {
      type: 'rect',
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
      color,
      width,
    };
  }
  if (tool === 'ellipse') {
    return {
      type: 'ellipse',
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
      color,
      width,
    };
  }
  if (tool === 'arrow') {
    return {
      type: 'arrow',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      color,
      width,
    };
  }
  return null;
}

function drawAction(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  a: Action,
) {
  ctx.save();
  switch (a.type) {
    case 'rect': {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      break;
    }
    case 'ellipse': {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.width;
      const head = Math.max(10, a.width * 3);
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(
        a.x2 - head * Math.cos(ang - Math.PI / 6),
        a.y2 - head * Math.sin(ang - Math.PI / 6),
      );
      ctx.lineTo(
        a.x2 - head * Math.cos(ang + Math.PI / 6),
        a.y2 - head * Math.sin(ang + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'pen': {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = a.color;
      ctx.font = `${a.size}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(a.text, a.x, a.y);
      break;
    }
    case 'number': {
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${a.size * 0.7}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(a.n), a.x, a.y + 1);
      break;
    }
    case 'highlight': {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    }
    case 'mosaic': {
      ctx.imageSmoothingEnabled = false;
      const tw = Math.max(1, Math.floor(a.w / a.block));
      const th = Math.max(1, Math.floor(a.h / a.block));
      const tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      const tctx = tmp.getContext('2d')!;
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(base, a.x, a.y, a.w, a.h, 0, 0, tw, th);
      ctx.drawImage(tmp, 0, 0, tw, th, a.x, a.y, a.w, a.h);
      break;
    }
    case 'blur': {
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.x, a.y, a.w, a.h);
      ctx.clip();
      ctx.filter = `blur(${a.radius}px)`;
      ctx.drawImage(base, 0, 0, base.width, base.height);
      ctx.filter = 'none';
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}
