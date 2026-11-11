import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FlashIn, FlashOut, Logo } from '../components';
import { C, FONT } from '../tokens';

// S2 品牌：白底大字反转 —— 「别装一堆软件了」划掉 → 亮出 Tacco + 功能胶囊
const PILLS = ['待办清单', '万年历', '牛马计薪器', '计算器', '录音机', '生日纪念日'];

export const Scene02: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 阶段 1：吐槽大字（0-52），阶段 2：品牌亮相（52+）
  const t1 = spring({ frame: Math.max(0, f - 4), fps, config: { damping: 15, mass: 0.8 } });
  const strike = interpolate(f, [30, 44], [0, 1], { easing: Easing.out(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // 吐槽字退场：上移淡出 + 轻微倾斜
  const out1 = interpolate(f, [44, 58], [0, 1], { easing: Easing.in(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const t2 = spring({ frame: Math.max(0, f - 56), fps, config: { damping: 13, mass: 0.7 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#f6f7f9' }}>
      <FlashIn />
      {/* 顶部洗染 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 620,
          background: `linear-gradient(180deg, ${C.wash} 0%, rgba(227,239,252,0.4) 48%, rgba(246,247,249,0) 100%)`,
        }}
      />

      {/* 阶段 1：吐槽 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 1 - out1,
          transform: `translateY(${-out1 * 120}px) rotate(${out1 * -3}deg)`,
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: 110,
            fontWeight: 900,
            color: C.ink,
            letterSpacing: 4,
            transform: `scale(${1.3 - t1 * 0.3})`,
            opacity: t1,
            position: 'relative',
          }}
        >
          别装一堆软件了
          {/* 红色划掉线 */}
          <div
            style={{
              position: 'absolute',
              left: '-4%',
              top: '52%',
              width: `${strike * 108}%`,
              height: 14,
              borderRadius: 8,
              background: C.red,
              transform: 'rotate(-4deg)',
              boxShadow: '0 6px 20px rgba(245,74,69,0.35)',
            }}
          />
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 42,
            fontWeight: 600,
            color: C.ink3,
            marginTop: 60,
            opacity: interpolate(f, [14, 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          }}
        >
          计时器、日历、计算器……装得满屏幕都是
        </div>
      </div>

      {/* 阶段 2：品牌亮相 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: t2,
          transform: `translateY(${(1 - t2) * 60}px)`,
        }}
      >
        <div style={{ transform: `scale(${0.5 + t2 * 0.5}) rotate(${(1 - t2) * -10}deg)` }}>
          <Logo size={190} />
        </div>
        <div style={{ fontFamily: FONT, fontSize: 108, fontWeight: 900, color: C.ink, marginTop: 44, letterSpacing: 4 }}>
          一个 Tacco 就够了
        </div>
        <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 600, color: C.ink3, marginTop: 22 }}>
          贴在桌面上的效率工具箱
        </div>

        {/* 功能胶囊 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20, marginTop: 78, padding: '0 110px' }}>
          {PILLS.map((t, i) => {
            const s = spring({ frame: Math.max(0, f - 84 - i * 5), fps, config: { damping: 13, mass: 0.6 } });
            return (
              <div
                key={t}
                style={{
                  fontFamily: FONT,
                  fontSize: 33,
                  fontWeight: 700,
                  color: '#ffffff',
                  background: i % 2 === 0 ? C.primary : C.dark,
                  borderRadius: 999,
                  padding: '16px 40px',
                  opacity: s,
                  transform: `translateY(${(1 - s) * 34}px) scale(${0.9 + s * 0.1})`,
                  boxShadow: '0 10px 30px rgba(29,126,240,0.22)',
                }}
              >
                {t}
              </div>
            );
          })}
        </div>
      </div>

      <FlashOut dur={210} />
    </AbsoluteFill>
  );
};
