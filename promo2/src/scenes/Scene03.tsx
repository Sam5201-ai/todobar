import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Cursor, FlashIn, FlashOut, Waypoint } from '../components';
import { LandscapeBg, PageIn, TodoApp } from '../pages1';

// S3 待办（重建页面动态实操版）：
//   ① 光标点「周待办」→ 胶囊滑动 + 列表切换为周任务
//   ② 光标点「日待办」→ 切回今日任务
//   ③ 光标点子任务 ○ → 绿勾弹出，勾掉一项
// 布局推算：Tabs 中心 y≈8.75%；周待办 x≈38.8%、日待办 x≈15.1%；子任务首行 ○ (10.2%, 36.5%)
const DUR = 420;

const CURSOR: Waypoint[] = [
  { x: 62, y: 70, t: 0 },
  { x: 38.8, y: 8.9, t: 56, click: 64 },
  { x: 15.1, y: 8.9, t: 138, click: 144 },
  { x: 10.2, y: 36.5, t: 202, click: 206 },
  { x: 46, y: 86, t: 300 },
];

export const Scene03: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#f6f7f9' }}>
      <LandscapeBg />
      <PageIn>
        <TodoApp
          segs={[
            { t: 0, seg: 0 },
            { t: 64, seg: 0 },
            { t: 78, seg: 1 },
            { t: 144, seg: 1 },
            { t: 158, seg: 0 },
          ]}
          switches={[{ out: 70 }, { out: 150 }]}
          checkAt={212}
        />
      </PageIn>

      <Cursor points={CURSOR} />

      <Chip text="日、周、月待办，一键切换" x={50} y={88} delay={26} hide={104} variant="dark" />
      <Chip text="今天的事，按天安排" x={50} y={88} delay={116} hide={196} variant="dark" dotRgb="23,24,26" />
      <Chip text="做完一项勾一项" x={50} y={88} delay={212} variant="dark" dotRgb="34,164,93" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
