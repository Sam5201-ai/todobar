import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { FlashIn, FlashOut, MonoTag, ShotCard, SlamText } from '../components';
import { FONT } from '../tokens';

// S9 效率套件：深色底 + 真实截图卡片横向滑过（跑马灯式），表达「小工具不止这些」
const DUR = 240;
const CARDS = [
  { img: 'shot-todo.png', label: '待办清单' },
  { img: 'shot-huangli.png', label: '万年历' },
  { img: 'shot-calc.png', label: '计算器' },
  { img: 'shot-recorder.png', label: '录音机' },
];
const W = 420;
const GAP = 500; // 间距（含卡宽）
const LOOP = GAP * CARDS.length;

export const Scene09: React.FC = () => {
  const f = useCurrentFrame();
  const top = 690;

  return (
    <AbsoluteFill style={{ backgroundColor: '#171a20' }}>
      <FlashIn />
      {/* 氛围光 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '20%',
          width: 1200,
          height: 1200,
          marginLeft: -600,
          background: 'radial-gradient(circle, rgba(29,126,240,0.16) 0%, rgba(23,26,32,0) 65%)',
        }}
      />

      <MonoTag text="MORE TOOLS" style={{ position: 'absolute', top: 200, left: 0, right: 0, textAlign: 'center', color: '#7f8ea3' }} />
      <div style={{ position: 'absolute', top: 250, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <SlamText text="小工具，不止这些" size={92} delay={6} />
      </div>
      <div
        style={{
          position: 'absolute',
          top: 420,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: FONT,
          fontSize: 38,
          fontWeight: 600,
          color: '#9fb0c6',
          opacity: interpolate(f, [20, 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      >
        麦克风检测 · 取色器 · 同步备份 · 记节日
      </div>

      {/* 卡片跑马灯 */}
      {CARDS.map((c, i) => {
        const pos = (((i * GAP - f * 4.2) % LOOP) + LOOP) % LOOP;
        const x = pos - 480;
        const op = interpolate(x, [-460, -120, 660, 1000], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={c.img} style={{ position: 'absolute', left: x, top, opacity: op }}>
            <ShotCard name={c.img} width={W} radius={26} />
            <div
              style={{
                marginTop: 30,
                textAlign: 'center',
                fontFamily: FONT,
                fontSize: 36,
                fontWeight: 700,
                color: '#dfe8f4',
              }}
            >
              {c.label}
            </div>
          </div>
        );
      })}

      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
