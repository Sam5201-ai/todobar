import React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FlashIn, Logo, MonoTag, PopText } from '../components';
import { FONT } from '../tokens';

// S10 落版：深色收尾 —— Logo + 品牌句 + 六张真实界面缩略图浮层
const THUMBS = [
  'shot-todo.png',
  'shot-huangli.png',
  'shot-salary.png',
  'shot-birthday.png',
  'shot-calc.png',
  'shot-recorder.png',
];

export const Scene10: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: '#12141a' }}>
      <FlashIn />
      {/* 顶部光晕 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '-10%',
          width: 1300,
          height: 1300,
          marginLeft: -650,
          background: 'radial-gradient(circle, rgba(29,126,240,0.22) 0%, rgba(18,20,26,0) 65%)',
        }}
      />

      {/* Logo + 品牌名 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 190, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <LogoPop fps={fps} f={f} />
        <PopText delay={20} y={34} style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: FONT, fontSize: 130, fontWeight: 900, color: '#ffffff', letterSpacing: 6, marginTop: 34 }}>Tacco</div>
          <div style={{ fontFamily: FONT, fontSize: 44, fontWeight: 600, color: '#aebdd2', marginTop: 24, letterSpacing: 4 }}>
            把每一天，都安排得明明白白
          </div>
        </PopText>
        <PopText delay={44} y={20} style={{ marginTop: 40 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontFamily: FONT,
              fontSize: 28,
              fontWeight: 700,
              color: '#dfe8f4',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 999,
              padding: '12px 32px',
            }}
          >
            <svg width={26} height={26} viewBox="0 0 48 48" fill="none">
              <rect x={5} y={5} width={17} height={17} rx={2} fill="#58b6f0" />
              <rect x={26} y={5} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.75} />
              <rect x={5} y={26} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.75} />
              <rect x={26} y={26} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.5} />
            </svg>
            Windows 桌面端
          </div>
        </PopText>
      </div>

      {/* 六张真实界面缩略图（2 行 × 3 列，浮动） */}
      <div style={{ position: 'absolute', left: 98, top: 800, display: 'flex', flexWrap: 'wrap', gap: 22, width: 884 }}>
        {THUMBS.map((t, i) => {
          const s = spring({ frame: Math.max(0, f - 60 - i * 6), fps, config: { damping: 14, mass: 0.6 } });
          const float = Math.sin(f * 0.05 + i * 1.1) * 7;
          return (
            <div
              key={t}
              style={{
                width: 280,
                height: 497,
                borderRadius: 20,
                overflow: 'hidden',
                border: '1px solid rgba(255,255,255,0.13)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
                opacity: s,
                transform: `translateY(${(1 - s) * 46 + float}px) scale(${0.9 + s * 0.1})`,
              }}
            >
              <Img src={staticFile(t)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          );
        })}
      </div>

      <MonoTag text="TACCO · DESKTOP EFFICIENCY SUITE" style={{ position: 'absolute', bottom: 40, left: 0, right: 0, textAlign: 'center', color: '#5c6a7d' }} />
    </AbsoluteFill>
  );
};

// Logo 弹入（内部小组件，避免主组件冗长）
const LogoPop: React.FC<{ fps: number; f: number }> = ({ fps, f }) => {
  const s = spring({ frame: Math.max(0, f - 8), fps, config: { damping: 12, mass: 0.7 } });
  return (
    <div style={{ transform: `scale(${0.4 + s * 0.6})`, opacity: s }}>
      <Logo size={170} />
    </div>
  );
};
