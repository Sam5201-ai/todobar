import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FlashIn, FlashOut, Logo, MonoTag, PopText } from '../components';
import { FONT } from '../tokens';

// S0 封面：深色夜幕 + 大 Logo + 功能图标环绕 —— 与后续亮色界面形成反差
const FEATURES = ['待办清单', '万年历', '牛马计薪器', '计算器', '录音机', '生日纪念日'];

export const Scene00: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 背景光晕缓慢呼吸
  const breathe = 1 + Math.sin(f * 0.05) * 0.06;
  // Logo 弹入
  const s0 = spring({ frame: Math.max(0, f - 10), fps, config: { damping: 12, mass: 0.7 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#12141a' }}>
      <FlashIn />
      {/* 环境光 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '34%',
          width: 1400,
          height: 1400,
          marginLeft: -700,
          marginTop: -700,
          background: 'radial-gradient(circle, rgba(29,126,240,0.30) 0%, rgba(29,126,240,0.10) 42%, rgba(18,20,26,0) 70%)',
          transform: `scale(${breathe})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '18%',
          top: '72%',
          width: 700,
          height: 700,
          background: 'radial-gradient(circle, rgba(245,158,11,0.16) 0%, rgba(18,20,26,0) 68%)',
        }}
      />
      {/* 细网格 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '90px 90px',
          maskImage: 'radial-gradient(circle at 50% 42%, black 0%, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(circle at 50% 42%, black 0%, transparent 72%)',
        }}
      />

      {/* 角标 */}
      <MonoTag text="TACCO / PROMO" style={{ position: 'absolute', top: 96, left: 84, color: '#8fa4bd' }} />
      <MonoTag text="FOR WINDOWS" style={{ position: 'absolute', top: 96, right: 84, color: '#8fa4bd' }} />

      {/* Logo 弹入 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '30%',
          transform: `translate(-50%,-50%) scale(${0.4 + s0 * 0.6}) rotate(${(1 - s0) * -14}deg)`,
          opacity: s0,
        }}
      >
        <Logo size={230} />
      </div>

      {/* 品牌名 */}
      <PopText delay={22} y={40} style={{ position: 'absolute', left: 0, right: 0, top: '41%', textAlign: 'center' }}>
        <div style={{ fontFamily: FONT, fontSize: 170, fontWeight: 900, color: '#ffffff', letterSpacing: 6 }}>Tacco</div>
        <div style={{ fontFamily: FONT, fontSize: 42, fontWeight: 600, color: '#aebdd2', marginTop: 26, letterSpacing: 10 }}>
          桌面效率全家桶
        </div>
      </PopText>

      {/* 功能胶囊两行飞入 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '63.5%', display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 22, padding: '0 90px' }}>
        {FEATURES.map((t, i) => {
          const s = spring({ frame: Math.max(0, f - 40 - i * 5), fps, config: { damping: 13, mass: 0.6 } });
          return (
            <div
              key={t}
              style={{
                fontFamily: FONT,
                fontSize: 33,
                fontWeight: 700,
                color: '#dfe8f4',
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.16)',
                borderRadius: 999,
                padding: '16px 38px',
                opacity: s,
                transform: `translateY(${(1 - s) * 30}px)`,
              }}
            >
              {t}
            </div>
          );
        })}
      </div>

      {/* 底部进度点 */}
      <div style={{ position: 'absolute', bottom: 120, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 14 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: i === 0 ? 46 : 14,
              height: 14,
              borderRadius: 999,
              background: i === 0 ? '#4d9bf5' : 'rgba(255,255,255,0.22)',
            }}
          />
        ))}
      </div>

      <FlashOut dur={90} />
    </AbsoluteFill>
  );
};
