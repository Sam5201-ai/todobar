import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Cursor, FlashIn, FlashOut, Waypoint } from '../components';
import { RecorderApp } from '../pages3';

// S8 录音机（重建页面动态实操版）：
//   计时 00:00 起走秒、波形实时跳动；光标按下红按钮 → 暂停：计时冻结、
//   波形变灰静止、按钮切换为恢复三角、「完成」按钮微微放大。
// 重建页内红按钮中心 ≈ (50%, 12.6%)
const DUR = 270;

const CURSOR: Waypoint[] = [
  { x: 66, y: 68, t: 0 },
  { x: 50, y: 12.6, t: 202, click: 210 },
  { x: 58, y: 44, t: 264 },
];

export const Scene08: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <RecorderApp pressAt={210} />

      <Cursor points={CURSOR} />

      <Chip text="一键开录，自动计时" x={50} y={88} delay={22} hide={96} variant="dark" dotRgb="244,74,69" />
      <Chip text="波形实时跳动，声声可见" x={50} y={88} delay={106} hide={204} variant="dark" />
      <Chip text="按一下，随时暂停" x={50} y={88} delay={214} variant="dark" dotRgb="244,74,69" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
