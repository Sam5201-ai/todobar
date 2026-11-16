import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Cursor, FlashIn, FlashOut, Waypoint } from '../components';
import { LandscapeBg, PageIn, TodoApp } from '../pages1';

// S4 待办（重建页面动态实操版，压缩至 180f）
const DUR = 180;

const CURSOR: Waypoint[] = [
  { x: 62, y: 70, t: 0 },
  { x: 38.8, y: 8.9, t: 38, click: 44 },
  { x: 15.1, y: 8.9, t: 82, click: 88 },
  { x: 10.2, y: 36.5, t: 124, click: 130 },
  { x: 46, y: 86, t: 176 },
];

export const Scene03: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#f6f7f9' }}>
      <LandscapeBg />
      <PageIn>
        <TodoApp
          segs={[
            { t: 0, seg: 0 },
            { t: 44, seg: 0 },
            { t: 56, seg: 1 },
            { t: 88, seg: 1 },
            { t: 100, seg: 0 },
          ]}
          switches={[{ out: 50 }, { out: 94 }]}
          checkAt={130}
        />
      </PageIn>

      <Cursor points={CURSOR} />

      <Chip text="日、周、月待办，一键切换" x={50} y={88} delay={12} hide={60} variant="dark" />
      <Chip text="今天的事，按天安排" x={50} y={88} delay={68} hide={122} variant="dark" dotRgb="23,24,26" />
      <Chip text="做完一项勾一项" x={50} y={88} delay={132} variant="dark" dotRgb="34,164,93" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
