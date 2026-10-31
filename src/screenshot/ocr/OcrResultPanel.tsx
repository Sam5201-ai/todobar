// OCR 结果浮层:复制全部 / 双击复制单行 / 单行、全部转待办。
// 两个宿主共用:
//  - 截图覆盖层:variant="floating",锚定选区,自动避让视口边界;
//  - 贴图窗口:  variant="inline",铺满窗口内部(窗口尺寸即图片尺寸)。
// 原生引擎无进度回调:识别中显示转圈 + 已耗时秒数,超时由调用方控制。
import { useEffect, useState } from 'react';
import type { OcrLine } from './ocrClient';
import './ocr.css';

export type OcrPhase = 'idle' | 'running' | 'done';

interface Props {
  phase: Extract<OcrPhase, 'running' | 'done'>;
  lines: OcrLine[];
  startedAt: number;
  /** floating:锚点(CSS px,选区下缘中心);inline:忽略 */
  anchor: { x: number; y: number };
  /** floating 时向上展开(操作条在选区上方时) */
  placeAbove?: boolean;
  variant: 'floating' | 'inline';
  /** 行动作执行中('copy' | 'convert'),禁用按钮防重复提交 */
  actionBusy: string | null;
  /** 操作反馈(绿色,显示在标题栏居中位置;空串不显示) */
  toast?: string;
  onClose: () => void;
  onCopyAll: () => void;
  onConvertAll: () => void;
  onCopyLine: (line: OcrLine) => void;
  onConvertLine: (line: OcrLine) => void;
}

const PANEL_W = 340;

export function OcrResultPanel(props: Props) {
  const { phase, lines, startedAt, anchor, placeAbove, variant, actionBusy } = props;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return;
    // 首拍在 500ms 后(异步回调,避免 effect 体内同步 setState);此前显示 0s。
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(id);
  }, [phase, startedAt]);

  // 位置:水平居中锚点并 clamp;垂直默认向下,placeAbove 时向上。
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, anchor.x - PANEL_W / 2), Math.max(8, vw - PANEL_W - 8));
  const style: React.CSSProperties =
    variant === 'inline'
      ? { left: 8, top: 8, width: vw - 16, maxHeight: vh - 16 }
      : placeAbove
        ? { left, width: PANEL_W, bottom: vh - anchor.y + 12, maxHeight: Math.min(460, vh - 32) }
        : { left, width: PANEL_W, top: anchor.y + 12, maxHeight: Math.min(460, vh - anchor.y - 24) };

  return (
    <div
      className={`ocr-panel${variant === 'inline' ? ' pin-ocr' : ''}`}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      // 右键放行给 WebView 原生菜单(选中文本后可直接右键复制),
      // 不冒泡到宿主 root(贴图/截图层都会 preventDefault 吞掉右键)。
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="ocr-head">
        <span className="ocr-title">
          {phase === 'running' ? '正在识别文字' : `识别结果 · ${lines.length} 行`}
        </span>
        {phase === 'running' && <span className="ocr-elapsed">{elapsed}s</span>}
        {props.toast && <span className="ocr-head-toast">{props.toast}</span>}
        <button type="button" className="ocr-close" title="关闭 (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>

      {phase === 'running' && (
        <div className="ocr-busy">
          <span className="ocr-spinner" aria-hidden="true" />
          <span>离线识别中,已耗时 {elapsed} 秒</span>
        </div>
      )}

      {phase === 'done' && (
        <>
          <div className="ocr-toolbar">
            <button
              type="button"
              className="ocr-btn"
              disabled={!!actionBusy}
              onClick={props.onCopyAll}
            >
              复制全部
            </button>
            <button
              type="button"
              className="ocr-btn ocr-btn-primary"
              disabled={!!actionBusy}
              onClick={props.onConvertAll}
            >
              {actionBusy === 'convert' ? '添加中…' : '全部转为待办'}
            </button>
          </div>
          <div className="ocr-lines">
            {lines.map((l, i) => (
              <div key={i} className="ocr-line">
                <span className="ocr-line-text">{l.text}</span>
                <span className="ocr-line-actions">
                  <button
                    type="button"
                    disabled={!!actionBusy}
                    onClick={() => props.onCopyLine(l)}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    disabled={!!actionBusy}
                    onClick={() => props.onConvertLine(l)}
                  >
                    待办
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
