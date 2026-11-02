import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../tokens';
import { Caption, FlashIn, FlashOut, Logo } from '../components';

// 场景 2 品牌登场：LOGO 弹入 + 品牌名 + slogan + 三徽章
const BADGES = [
  {
    label: 'Windows 电脑桌面端',
    icon: (
      <svg width={34} height={34} viewBox="0 0 48 48" fill="none">
        <rect x={7} y={7} width={16} height={16} rx={2} fill={C.primary} />
        <rect x={25} y={7} width={16} height={16} rx={2} fill={C.primary} opacity={0.65} />
        <rect x={7} y={25} width={16} height={16} rx={2} fill={C.primary} opacity={0.65} />
        <rect x={25} y={25} width={16} height={16} rx={2} fill={C.primary} opacity={0.4} />
      </svg>
    ),
  },
  {
    label: '全局快捷键呼出',
    icon: (
      <svg width={34} height={34} viewBox="0 0 48 48" fill="none">
        <rect x={5} y={12} width={38} height={24} rx={5} stroke={C.primary} strokeWidth={3.2} />
        <path d="M12 20h2M19 20h2M26 20h2M33 20h2M12 26h2M19 26h2M26 26h2M33 26h2M16 31h16" stroke={C.primary} strokeWidth={3} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: '本地优先 · 云同步',
    icon: (
      <svg width={34} height={34} viewBox="0 0 48 48" fill="none">
        <path
          d="M15 34a9 9 0 0 1-1.5-17.9A12 12 0 0 1 37 19.5 8 8 0 0 1 35.5 34H15Z"
          stroke={C.primary}
          strokeWidth={3.2}
          strokeLinejoin="round"
        />
        <path d="M24 40V26m0 0-5 5m5-5 5 5" stroke={C.accent} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export const Scene02: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoS = spring({ frame: Math.max(0, f - 8), fps, config: { damping: 11, mass: 0.8 } });
  const nameS = spring({ frame: Math.max(0, f - 26), fps, config: { damping: 14 } });
  const sloganS = spring({ frame: Math.max(0, f - 46), fps, config: { damping: 15 } });

  // 品牌名逐字入场
  const brand = 'TickTask'.split('');

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(720px 460px at 50% 22%, rgba(29,126,240,0.16), transparent 70%),
                     radial-gradient(620px 420px at 30% 78%, rgba(245,158,11,0.10), transparent 70%),
                     ${C.bg}`,
        fontFamily: FONT,
      }}
    >
      <FlashIn />

      {/* LOGO */}
      <div
        style={{
          position: 'absolute',
          top: 560,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div style={{ transform: `scale(${logoS})`, opacity: logoS }}>
          <Logo size={272} />
        </div>
      </div>

      {/* 品牌名逐字 */}
      <div
        style={{
          position: 'absolute',
          top: 900,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        {brand.map((ch, i) => {
          const s = spring({ frame: Math.max(0, f - 26 - i * 3), fps, config: { damping: 13, mass: 0.6 } });
          return (
            <span
              key={i}
              style={{
                fontFamily: FONT,
                fontSize: 118,
                fontWeight: 900,
                color: C.ink,
                letterSpacing: 1,
                opacity: s,
                transform: `translateY(${(1 - s) * 36}px)`,
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>

      {/* slogan */}
      <div
        style={{
          position: 'absolute',
          top: 1090,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: FONT,
          fontSize: 44,
          fontWeight: 600,
          opacity: sloganS,
          transform: `translateY(${(1 - sloganS) * 26}px)`,
        }}
      >
        待办事项，就该
        <span
          style={{
            background: `linear-gradient(90deg, ${C.primary}, ${C.accent})`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            fontWeight: 800,
          }}
        >
          贴在屏幕边缘
        </span>
      </div>

      {/* 三徽章 */}
      <div
        style={{
          position: 'absolute',
          top: 1240,
          left: 60,
          right: 60,
          display: 'flex',
          gap: 18,
          justifyContent: 'center',
        }}
      >
        {BADGES.map((b, i) => {
          const s = spring({ frame: Math.max(0, f - 70 - i * 9), fps, config: { damping: 14, mass: 0.7 } });
          return (
            <div
              key={b.label}
              style={{
                flex: 1,
                background: '#ffffff',
                border: `1.5px solid ${C.cardBorder}`,
                borderRadius: 24,
                padding: '30px 12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 16,
                boxShadow: '0 12px 34px rgba(26,22,38,0.08)',
                opacity: s,
                transform: `translateY(${(1 - s) * 44}px)`,
              }}
            >
              {b.icon}
              <span style={{ fontFamily: FONT, fontSize: 27, fontWeight: 700, color: C.ink2, whiteSpace: 'nowrap' }}>{b.label}</span>
            </div>
          );
        })}
      </div>

      {/* 版本徽标 */}
      <div
        style={{
          position: 'absolute',
          top: 1480,
          left: 0,
          right: 0,
          textAlign: 'center',
          opacity: interpolate(f, [110, 130], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: FONT,
            fontSize: 28,
            fontWeight: 600,
            color: C.primary,
            background: 'rgba(29,126,240,0.08)',
            border: '1.5px solid rgba(29,126,240,0.22)',
            borderRadius: 999,
            padding: '14px 36px',
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: C.primary }} />
          Windows 桌面端 · 极简待办
        </span>
      </div>

      <Caption text="贴在屏幕边缘的极简待办栏" delay={96} />
      <FlashOut dur={180} />
    </AbsoluteFill>
  );
};
