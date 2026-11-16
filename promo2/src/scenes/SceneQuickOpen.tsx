import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../tokens';
import { AppHeader } from '../pages1';

// S3「一点即开，用完即收」：全局快捷键按下 → Tacco 窗口瞬间弹出 → 用完即收
// 视觉：按键提示 → 窗口快速 spring 弹入 → 短暂停留 → 快速收起 → 标语
const DUR = 120;

// 单个按键
const KeyCap: React.FC<{ label: string; press: number; w?: number }> = ({ label, press, w = 96 }) => {
  const p = interpolate(press, [0, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        width: w,
        height: 110,
        borderRadius: 22,
        background: '#ffffff',
        border: '2px solid #d8dde4',
        boxShadow: `0 ${10 - p * 7}px ${20 - p * 12}px rgba(23,28,38,0.18)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        fontSize: 38,
        fontWeight: 800,
        color: C.ink,
        transform: `translateY(${p * 6}px)`,
      }}
    >
      {label}
    </div>
  );
};

export const SceneQuickOpen: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 按键按下帧
  const pressAt = 26;
  const keyPress = f >= pressAt ? 1 : interpolate(f, [pressAt - 6, pressAt], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // 窗口弹出/收起：弹出帧 30，收起帧 92
  const openAt = 30;
  const closeAt = 92;
  const openSpring = spring({ frame: Math.max(0, f - openAt), fps, config: { damping: 18, mass: 0.5 } });
  const closeP = interpolate(f, [closeAt, closeAt + 10], [0, 1], { easing: Easing.in(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const winScale = openSpring * (1 - closeP * 0.12);
  const winOpacity = Math.min(openSpring, 1 - closeP);
  const winY = closeP * -60;

  // 标语
  const tagSpring = spring({ frame: Math.max(0, f - 96), fps, config: { damping: 14, mass: 0.6 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#0f131a' }}>
      {/* 背景模糊桌面感（深色渐变 + 微光） */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at 50% 40%, #1b2433 0%, #0a0d12 70%)',
        }}
      />

      {/* 快捷键提示 */}
      <div
        style={{
          position: 'absolute',
          top: '30%',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          opacity: f < closeAt ? interpolate(f, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0,
        }}
      >
        <KeyCap label="Alt" press={keyPress} w={130} />
        <span style={{ fontFamily: FONT, fontSize: 44, fontWeight: 800, color: '#ffffff' }}>+</span>
        <KeyCap label="Space" press={keyPress} w={170} />
      </div>

      {/* 呼出的 Tacco 窗口 */}
      {winOpacity > 0.01 && (
        <div
          style={{
            position: 'absolute',
            top: '16%',
            left: '6%',
            right: '6%',
            bottom: '16%',
            borderRadius: 36,
            overflow: 'hidden',
            background: '#f6f7f9',
            boxShadow: '0 50px 120px rgba(0,0,0,0.6)',
            opacity: winOpacity,
            transform: `translateY(${winY}px) scale(${winScale})`,
          }}
        >
          {/* 窗口顶部条 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', background: '#ffffff', borderBottom: '1px solid #eef0f3' }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#ff5f57' }} />
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#febc2e' }} />
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#28c840' }} />
            <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink3, marginLeft: 16 }}>Tacco · 待办</span>
          </div>
          {/* 简版待办内容（仅示意快速打开） */}
          <div style={{ padding: '20px 30px' }}>
            <AppHeader />
            <div style={{ marginTop: 14, background: '#ffffff', borderRadius: 24, padding: '24px 30px', boxShadow: '0 4px 16px rgba(23,28,38,0.06)', display: 'flex', alignItems: 'center', gap: 18 }}>
              <div style={{ width: 44, height: 44, borderRadius: '50%', border: '3px solid #c9cdd4' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FONT, fontSize: 32, fontWeight: 700, color: C.ink }}>快速记录一条待办</div>
                <div style={{ fontFamily: FONT, fontSize: 24, color: C.ink3, marginTop: 6 }}>随时呼出，记完就走</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 标语：一点即开，用完即收 */}
      <div
        style={{
          position: 'absolute',
          bottom: '14%',
          left: '50%',
          transform: `translateX(-50%) translateY(${(1 - tagSpring) * 30}px)`,
          opacity: tagSpring,
          textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: FONT, fontSize: 64, fontWeight: 900, color: '#ffffff', letterSpacing: 2 }}>一点即开，用完即收</div>
        <div style={{ fontFamily: FONT, fontSize: 32, fontWeight: 600, color: '#9fb4d4', marginTop: 16 }}>不占屏幕，随叫随到</div>
      </div>
    </AbsoluteFill>
  );
};
