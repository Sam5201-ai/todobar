import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, MONO } from './tokens';

// ============ 转场 ============

// 场景开头白场淡出（承接上一场景的白闪转场）
export const FlashIn: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [0, 10], [1, 0], { easing: Easing.out(Easing.quad), extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity, zIndex: 99, pointerEvents: 'none' }} />;
};

// 场景结尾淡入白场（交给下一场景）；dur = 本场景总帧数
export const FlashOut: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [dur - 8, dur - 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity, zIndex: 99, pointerEvents: 'none' }} />;
};

// ============ 品牌 ============

// LOGO：圆角方形（public/logo.png，应用图标）
export const Logo: React.FC<{ size: number; shadow?: boolean }> = ({ size, shadow = true }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.24,
      overflow: 'hidden',
      boxShadow: shadow ? `0 ${size * 0.12}px ${size * 0.32}px rgba(29,126,240,0.32)` : 'none',
    }}
  >
    <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
);

export const LogoThumb: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.26, overflow: 'hidden' }}>
    <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
);

// ============ 真实截图主视觉 ============
// 用户提供的 Tacco 真实窗口截图（941×1672 ≈ 1080×1920），全幅铺放保证样式与内容一致。
// Ken Burns 在外层做缩放/漂移；children 叠加在截图坐标系内（随缩放同步移动，始终对准 UI 元素）。

export const ShotFrame: React.FC<{
  name: string;
  dur: number;
  scaleFrom?: number;
  scaleTo?: number;
  origin?: string;
  drift?: number; // 全程漂移 px（translateY）
  children?: React.ReactNode;
}> = ({ name, dur, scaleFrom = 1.02, scaleTo = 1.09, origin = '50% 50%', drift = 0, children }) => {
  const f = useCurrentFrame();
  const sc = interpolate(f, [0, dur], [scaleFrom, scaleTo], { easing: Easing.inOut(Easing.quad) });
  const dy = interpolate(f, [0, dur], [0, drift], { easing: Easing.inOut(Easing.quad) });
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${sc}) translateY(${dy}px)`, transformOrigin: origin }}>
        <Img
          src={staticFile(name)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// 真实截图卡片（圆角 + 阴影 + 细边），用于深色场景中的「窗口展示」
export const ShotCard: React.FC<{
  name: string;
  width: number;
  radius?: number;
  style?: React.CSSProperties;
}> = ({ name, width, radius = 28, style }) => (
  <div
    style={{
      width,
      height: (width * 1672) / 941,
      borderRadius: radius,
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.14)',
      boxShadow: '0 40px 110px rgba(0,0,0,0.55)',
      background: '#fff',
      ...style,
    }}
  >
    <Img src={staticFile(name)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
);

// ============ 截图坐标系叠加组件 ============
// x / y 一律为截图的百分比坐标；scale 用 rgb 三元组字符串（如 '29,126,240'）

// 高亮脉冲圈：圈住截图里的某个真实 UI 元素
export const Spot: React.FC<{
  x: number;
  y: number;
  r?: number;
  delay?: number;
  rgb?: string;
  hide?: number;
}> = ({ x, y, r = 90, delay = 0, rgb = '29,126,240', hide }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 12, mass: 0.5 } });
  const pulse = 1 + 0.05 * Math.sin(Math.max(0, f - delay) * 0.16);
  const op =
    hide === undefined
      ? s
      : s * interpolate(f, [hide, hide + 10], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: r * 2,
        height: r * 2,
        marginLeft: -r,
        marginTop: -r,
        zIndex: 20,
        pointerEvents: 'none',
        opacity: op,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `5px solid rgba(${rgb},0.95)`,
          transform: `scale(${s * pulse})`,
          boxShadow: `0 0 46px rgba(${rgb},0.45), inset 0 0 30px rgba(${rgb},0.12)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 6,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(${rgb},0.16) 0%, rgba(${rgb},0) 70%)`,
        }}
      />
    </div>
  );
};

// 浮动标签：说明性文字条，位置自由（打破「底部胶囊」单调感）
export const Chip: React.FC<{
  text: string;
  x: number;
  y: number;
  delay?: number;
  hide?: number;
  variant?: 'dark' | 'light' | 'amber';
  dotRgb?: string;
}> = ({ text, x, y, delay = 0, hide, variant = 'dark', dotRgb }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 14, mass: 0.7 } });
  const op =
    hide === undefined
      ? s
      : s * interpolate(f, [hide, hide + 10], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const skin: React.CSSProperties =
    variant === 'dark'
      ? { background: 'rgba(21,24,29,0.92)', color: '#ffffff', border: '1px solid rgba(255,255,255,0.16)' }
      : variant === 'amber'
        ? { background: 'rgba(245,158,11,0.95)', color: '#221703', border: '1px solid rgba(255,255,255,0.3)' }
        : { background: 'rgba(255,255,255,0.94)', color: C.ink2, border: `1px solid ${C.border}` };
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) translateY(${(1 - s) * 34}px) scale(${0.92 + s * 0.08})`,
        opacity: op,
        zIndex: 40,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        ...skin,
        borderRadius: 999,
        padding: '18px 44px',
        fontFamily: FONT,
        fontSize: 36,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 16px 44px rgba(10,14,22,0.28)',
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: dotRgb ? `rgb(${dotRgb})` : C.primary,
          flexShrink: 0,
        }}
      />
      {text}
    </div>
  );
};

// 光标 + 点击涟漪（模拟在真实界面上操作）
export type Waypoint = { x: number; y: number; t: number; click?: number };

export const Cursor: React.FC<{ points: Waypoint[] }> = ({ points }) => {
  const f = useCurrentFrame();
  let x = points[0].x;
  let y = points[0].y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (f >= a.t && f <= b.t) {
      const p = interpolate(f, [a.t, b.t], [0, 1], { easing: Easing.inOut(Easing.quad) });
      x = a.x + (b.x - a.x) * p;
      y = a.y + (b.y - a.y) * p;
      break;
    }
    if (f > b.t) {
      x = b.x;
      y = b.y;
    }
  }
  return (
    <>
      {points
        .filter((p) => p.click !== undefined)
        .map((p, i) => {
          const dt = f - (p.click as number);
          if (dt < 0 || dt > 16) return null;
          const rr = interpolate(dt, [0, 16], [12, 66]);
          const op = interpolate(dt, [0, 16], [0.85, 0]);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: rr * 2,
                height: rr * 2,
                marginLeft: -rr,
                marginTop: -rr,
                borderRadius: '50%',
                border: `4px solid rgba(29,126,240,${op})`,
                zIndex: 30,
                pointerEvents: 'none',
              }}
            />
          );
        })}
      <div
        style={{
          position: 'absolute',
          left: `${x}%`,
          top: `${y}%`,
          transform: 'translate(-8px,-4px)',
          zIndex: 31,
          pointerEvents: 'none',
          filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.4))',
        }}
      >
        <svg width={46} height={54} viewBox="0 0 24 28">
          <path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.5 L20 15 Z" fill="#1f2329" stroke="#ffffff" strokeWidth={1.6} />
        </svg>
      </div>
    </>
  );
};

// 绿色对勾：弹到截图里的「○」位置，模拟勾选完成
export const CheckPop: React.FC<{ x: number; y: number; delay?: number; size?: number }> = ({
  x,
  y,
  delay = 0,
  size = 56,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 10, mass: 0.55 } });
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: '#22a45d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${s})`,
        boxShadow: '0 8px 26px rgba(34,164,93,0.5)',
        zIndex: 25,
        pointerEvents: 'none',
      }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
        <path d="M4.5 12.5 10 18 19.5 7" stroke="#ffffff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
};

// ============ 演示动效 ============

// 数字滚动（0 → to，easeOut）
export const RollNumber: React.FC<{
  to: number;
  dur?: [number, number];
  decimals?: number;
  style?: React.CSSProperties;
}> = ({ to, dur = [40, 120], decimals = 2, style }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, dur, [0, to], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{v.toFixed(decimals)}</span>;
};

// 纸屑（庆祝）
export const Confetti: React.FC<{ from?: number; count?: number }> = ({ from = 30, count = 42 }) => {
  const f = useCurrentFrame();
  const colors = ['#f54a45', '#f59e0b', '#1d7ef0', '#22a45d', '#e859a8'];
  const rand = (n: number) => {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 35 }}>
      {Array.from({ length: count }).map((_, i) => {
        const born = from + rand(i * 3.3) * 60;
        if (f < born) return null;
        const t = f - born;
        const x0 = rand(i * 7.1) * 100;
        const fall = t * (5 + rand(i * 5.7) * 4);
        const sway = Math.sin(t * 0.08 + i) * 40;
        const y = -40 + fall;
        if (y > 2000) return null;
        const size = 12 + rand(i * 9.4) * 14;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${x0}%`,
              top: y,
              width: size,
              height: size * 0.6,
              marginLeft: sway,
              background: colors[Math.floor(rand(i * 4.9) * colors.length)],
              borderRadius: 3,
              transform: `rotate(${t * (3 + rand(i * 2.2) * 5)}deg)`,
              opacity: Math.min(1, t / 6),
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// 波形点（录音）：沿一条水平线布置跳动的小点
export const WaveDots: React.FC<{
  x: number; // 起点 %
  y: number; // 中线 %
  w: number; // 总宽 %
  count?: number;
  rgb?: string;
  from?: number;
  dotW?: number;
  minH?: number;
  maxH?: number;
}> = ({ x, y, w, count = 34, rgb = '244,74,69', from = 0, dotW = 7, minH = 14, maxH = 52 }) => {
  const f = useCurrentFrame();
  const alive = Math.max(0, f - from);
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: `${w}%`,
        height: maxH + 20,
        marginTop: -(maxH + 20) / 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 25,
        pointerEvents: 'none',
      }}
    >
      {Array.from({ length: count }).map((_, i) => {
        const h = minH + Math.abs(Math.sin(alive * 0.22 + i * 0.9)) * (maxH - minH);
        const op = interpolate(alive, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
        return (
          <div
            key={i}
            style={{
              width: dotW,
              height: h,
              borderRadius: dotW / 2,
              background: `rgba(${rgb},0.9)`,
              opacity: op,
            }}
          />
        );
      })}
    </div>
  );
};

// 大字砸入（痛点 / 口号）
export const SlamText: React.FC<{
  text: string;
  delay?: number;
  size?: number;
  color?: string;
  weight?: number;
  letterSpacing?: number;
}> = ({ text, delay = 4, size = 100, color = '#ffffff', weight = 900, letterSpacing = 4 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 15, mass: 0.8 } });
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: weight,
        color,
        letterSpacing,
        transform: `scale(${1.5 - s * 0.5})`,
        filter: `blur(${(1 - s) * 12}px)`,
        opacity: s,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
};

// 通用文字弹入（温和）
export const PopText: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
  y?: number;
}> = ({ children, delay = 0, style, y = 28 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 15, mass: 0.7 } });
  return (
    <div style={{ opacity: s, transform: `translateY(${(1 - s) * y}px)`, ...style }}>{children}</div>
  );
};

// 小节标签（mono 数字角标）
export const MonoTag: React.FC<{ text: string; style?: React.CSSProperties }> = ({ text, style }) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 26,
      fontWeight: 600,
      letterSpacing: 6,
      opacity: 0.55,
      ...style,
    }}
  >
    {text}
  </div>
);
