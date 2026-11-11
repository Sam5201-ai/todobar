import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, FlashIn, FlashOut } from '../components';
import { CalcApp } from '../pages2';

// S6 计算器（重建页面动态实操版）：逐键按下 566 × 965，按键缩放+描边按压动效，
//   display 实时回显，= 号后结果 546190 弹出。纯页面动画 + Chip 标注。
const DUR = 270;

export const Scene06: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#f6f7f9' }}>
      <CalcApp />

      <Chip text="随手一按，账目清清楚楚" x={50} y={88} delay={18} hide={96} variant="dark" />
      <Chip text="连续运算，一气呵成" x={50} y={88} delay={128} hide={222} variant="dark" dotRgb="29,126,240" />
      <Chip text="结果秒出，支持括号与百分比" x={50} y={88} delay={244} variant="amber" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
