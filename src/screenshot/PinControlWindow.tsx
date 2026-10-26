// 贴图穿透控制条窗口(label = pinctl-<贴图label>,独立不穿透小窗)。
//
// 背景:贴图窗口开启「鼠标穿透」后,Windows 层面 WS_EX_TRANSPARENT 让整窗
// 收不到任何鼠标事件,贴图上的按钮全部失效 → 无法关闭。参考 PixPin,穿透
// 期间在贴图上方悬浮一个独立控制条:拖拽把手(移动贴图)+ 不透明度滑条 +
// 关闭按钮;把手上方带说明气泡。
//
// 事件协议:
// - PinWindow 开启穿透 → invoke show_pin_control(定位)→(复用时)emit
//   `pinctl-show`;本组件挂载后自显 + 监听 pinctl-show 重读初始透明度。
// - 滑条拖动 → emit `pinctl-opacity` {target, value} → PinWindow 调透明度。
// - 拖拽把手 → pointermove 累计 delta → invoke move_pin_control(两窗同移)。
// - 关闭按钮 → dismissPinWindow(target)(Rust 侧联动销毁本控制条窗口)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { Move, X } from 'lucide-react';
import { dismissPinWindow, takeImage } from './bridge';
import { PIN_CTL } from './store';
import './screenshot.css';

export default function PinControlWindow() {
  const win = getCurrentWindow();
  // 自身 label = `pinctl-<贴图label>` → 反推目标贴图。
  const target = win.label.replace(/^pinctl-/, '');
  const [opacity, setOpacity] = useState(1);
  const [showBubble, setShowBubble] = useState(true);
  // 拖动串行队列:防止 setPosition IPC 乱序导致窗口抖动。
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void (async () => {
      const init = await takeImage(`pinctl-init:${win.label}`).catch(() => null);
      if (init) {
        const v = Number(init);
        if (Number.isFinite(v)) setOpacity(Math.min(1, Math.max(0.15, v)));
      }
      await win.show().catch(() => {});
    })();
    // 复用(PinWindow 再次开启穿透):重读初始透明度并自显。
    let un: (() => void) | undefined;
    void listen('pinctl-show', () => {
      void (async () => {
        const init = await takeImage(`pinctl-init:${win.label}`).catch(() => null);
        if (init) {
          const v = Number(init);
          if (Number.isFinite(v)) setOpacity(Math.min(1, Math.max(0.15, v)));
        }
        await win.show().catch(() => {});
      })();
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 不透明度滑条 → 通知贴图窗口。
  const onOpacity = (v: number) => {
    setOpacity(v);
    void emit('pinctl-opacity', { target, value: v }).catch(() => {});
  };

  // 拖拽把手:pointerdown 后监听全局 pointermove/up,把屏幕坐标位移
  // (CSS px)乘 scaleFactor 换算成物理像素,经 Rust 命令同步平移两窗。
  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startWin = getCurrentWindow();
      let lx = e.screenX;
      let ly = e.screenY;
      let scale = 1;
      void startWin
        .scaleFactor()
        .then((s) => {
          scale = s;
        })
        .catch(() => {});
      const onMove = (ev: PointerEvent) => {
        const dx = Math.round((ev.screenX - lx) * scale);
        const dy = Math.round((ev.screenY - ly) * scale);
        lx = ev.screenX;
        ly = ev.screenY;
        if (!dx && !dy) return;
        queueRef.current = queueRef.current
          .then(() => invokeMove(target, dx, dy))
          .catch(() => {});
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [target],
  );

  // 关闭气泡:窗口收缩到只剩控制条,下移让出空间(透明区域会挡下层点击)。
  const collapseBubble = useCallback(() => {
    setShowBubble(false);
    void (async () => {
      try {
        const scale = await win.scaleFactor();
        const p = await win.outerPosition();
        const shrink = Math.round((PIN_CTL.bubbleH + PIN_CTL.gap) * scale);
        await win.setSize(
          new PhysicalSize(Math.round(PIN_CTL.w * scale), Math.round(PIN_CTL.barH * scale)),
        );
        await win.setPosition(new PhysicalPosition(p.x, p.y + shrink));
      } catch {
        /* ignore */
      }
    })();
  }, [win]);

  return (
    <div className="pinctl-root">
      {showBubble && (
        <div className="pinctl-bubble">
          <div className="pinctl-bubble-arrow" />
          <button
            type="button"
            className="pinctl-bubble-close"
            title="关闭提示"
            onClick={collapseBubble}
          >
            <X size={14} />
          </button>
          <h4>鼠标穿透</h4>
          <p>开启后，您可以直接使用鼠标操作贴图下方的控件，以便临时操作或对比。</p>
          <p className="pinctl-bubble-hl">按住并拖动左侧抓手图标可以移动贴图。</p>
        </div>
      )}
      <div className="pinctl-bar" onMouseDown={(e) => e.stopPropagation()}>
        <span
          className="pinctl-drag"
          title="按住拖动以移动贴图"
          onPointerDown={onDragStart}
        >
          <Move size={17} />
        </span>
        <span className="pinctl-sep" />
        <span className="pinctl-label">不透明度</span>
        <input
          type="range"
          className="pinctl-slider"
          min={15}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)}
        />
        <button
          type="button"
          className="pinctl-btn"
          title="关闭贴图"
          onClick={() => void dismissPinWindow(target)}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

async function invokeMove(target: string, dx: number, dy: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('move_pin_control', { target, dx, dy });
}
