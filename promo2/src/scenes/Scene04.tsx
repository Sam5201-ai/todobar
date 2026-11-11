import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Cursor, FlashIn, FlashOut, Waypoint } from '../components';
import { HuangliApp } from '../pages2';

// S4 万年历（重建页面动态实操版）：
//   ① 光标点 11月7日「立冬」→ 蓝块滑动选中，农历大卡联动弹出
//   ② 光标点「回到今天」→ 蓝块滑回 11月4日，大卡切回今日
// 关键坐标推算：立冬格中心 (76%, 28.3%)；回到今天按钮 (85.7%, 11.5%)
const DUR = 300;

const CURSOR: Waypoint[] = [
  { x: 34, y: 68, t: 0 },
  { x: 76, y: 28.3, t: 82, click: 90 },
  { x: 85.7, y: 11.5, t: 188, click: 196 },
  { x: 50, y: 62, t: 286 },
];

export const Scene04: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <HuangliApp selectAt={90} backAt={196} />

      <Cursor points={CURSOR} />

      <Chip text="节气、节日，日历全标好" x={50} y={88} delay={22} hide={84} variant="dark" />
      <Chip text="点哪天，看哪天" x={50} y={88} delay={92} hide={190} variant="dark" dotRgb="29,126,240" />
      <Chip text="一键回到今天" x={50} y={88} delay={202} variant="dark" dotRgb="34,164,93" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
