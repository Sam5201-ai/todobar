import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, FlashIn, FlashOut } from '../components';
import { SalaryApp } from '../pages2';

// S5 牛马计薪器（重建页面动态实操版）：
//   今日已赚 0 → 178.55 滚动 + 微跳进账；秒表 03:23:10 起走秒；距下班递减；
//   进度条 0 → 48.4%；牛马寄语打字机逐字浮现。纯页面动画 + Chip 标注（无需光标）。
const DUR = 360;

export const Scene05: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <SalaryApp />

      <Chip text="上班打开，自动开始算钱" x={50} y={88} delay={24} hide={108} variant="dark" />
      <Chip text="工资一秒一秒进账" x={50} y={88} delay={118} hide={196} variant="dark" dotRgb="62,224,127" />
      <Chip text="距下班还有多久，一目了然" x={50} y={88} delay={206} variant="amber" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
