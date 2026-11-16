import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Cursor, FlashIn, FlashOut, Waypoint } from '../components';
import { HuangliApp } from '../pages2';

// S5 万年历（重建页面动态实操版，压缩至 165f）
const DUR = 165;

const CURSOR: Waypoint[] = [
  { x: 34, y: 68, t: 0 },
  { x: 76, y: 28.3, t: 50, click: 56 },
  { x: 85.7, y: 11.5, t: 106, click: 112 },
  { x: 50, y: 62, t: 160 },
];

export const Scene04: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <HuangliApp selectAt={56} backAt={112} />

      <Cursor points={CURSOR} />

      <Chip text="节气、节日，日历全标好" x={50} y={88} delay={12} hide={52} variant="dark" />
      <Chip text="点哪天，看哪天" x={50} y={88} delay={58} hide={108} variant="dark" dotRgb="29,126,240" />
      <Chip text="一键回到今天" x={50} y={88} delay={116} variant="dark" dotRgb="34,164,93" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
