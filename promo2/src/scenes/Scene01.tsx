import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { FlashOut, MonoTag, SlamText } from '../components';
import { FONT } from '../tokens';

// S1 痛点：三连快切，全屏大字砸入 —— 黑 / 纸白 / 深蓝三种底，节奏快、反差强
const PANELS = [
  {
    bg: 'radial-gradient(120% 120% at 50% 30%, #23262e 0%, #14161a 70%)',
    text: '待办越堆越多',
    sub: '今日事，拖到明日',
    accent: '#f54a45',
    tag: 'PAIN 01 / 03',
    tagColor: '#7d8492',
  },
  {
    bg: 'radial-gradient(120% 120% at 50% 30%, #fbf7ee 0%, #efe7d8 70%)',
    text: '工资越算越糊涂',
    sub: '到账金额，全靠心算',
    accent: '#1d7ef0',
    tag: 'PAIN 02 / 03',
    tagColor: '#9a8f78',
  },
  {
    bg: 'radial-gradient(120% 120% at 50% 30%, #16345f 0%, #0c1e3a 70%)',
    text: '日子总被忘记',
    sub: '爸妈生日 · 结婚纪念日',
    accent: '#f59e0b',
    tag: 'PAIN 03 / 03',
    tagColor: '#7f9cc4',
  },
];

const Panel: React.FC<{ p: (typeof PANELS)[number] }> = ({ p }) => {
  const f = useCurrentFrame();
  // 手绘感下划线
  const draw = interpolate(f, [16, 34], [0, 1], { easing: Easing.out(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // 大字轻微悬浮
  const float = Math.sin(f * 0.08) * 8;
  return (
    <AbsoluteFill style={{ background: p.bg, justifyContent: 'center', alignItems: 'center' }}>
      <MonoTag text={p.tag} style={{ position: 'absolute', top: 130, left: 0, right: 0, textAlign: 'center', color: p.tagColor }} />
      <div style={{ position: 'relative', textAlign: 'center' }}>
        <div style={{ transform: `translateY(${float}px)` }}>
          <SlamText text={p.text} size={118} color={p.text === '工资越算越糊涂' ? '#26221a' : '#ffffff'} delay={5} />
        </div>
        {/* 下划线 */}
        <div
          style={{
            position: 'absolute',
            left: '8%',
            right: '8%',
            bottom: -34,
            height: 12,
            borderRadius: 8,
            background: p.accent,
            transform: `scaleX(${draw})`,
            transformOrigin: 'left center',
          }}
        />
        <div
          style={{
            fontFamily: FONT,
            fontSize: 44,
            fontWeight: 600,
            color: p.text === '工资越算越糊涂' ? '#7a6f58' : 'rgba(255,255,255,0.72)',
            marginTop: 110,
            opacity: interpolate(f, [18, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          }}
        >
          {p.sub}
        </div>
      </div>
      {/* 大编号水印 */}
      <div
        style={{
          position: 'absolute',
          right: 60,
          bottom: 40,
          fontFamily: FONT,
          fontSize: 300,
          fontWeight: 900,
          color: 'rgba(255,255,255,0.05)',
          lineHeight: 1,
        }}
      >
        0{PANELS.indexOf(p) + 1}
      </div>
    </AbsoluteFill>
  );
};

export const Scene01: React.FC = () => {
  const f = useCurrentFrame();
  const idx = Math.min(2, Math.floor(f / 70));
  const p = PANELS[idx];
  return (
    <AbsoluteFill style={{ backgroundColor: '#14161a' }}>
      <Panel key={idx} p={p} />
      <FlashOut dur={210} />
    </AbsoluteFill>
  );
};
