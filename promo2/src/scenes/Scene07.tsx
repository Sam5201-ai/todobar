import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Chip, Confetti, FlashIn, FlashOut } from '../components';
import { BirthdayApp } from '../pages3';

// S7 记节日（重建页面动态实操版）：
//   Tab「记节日」激活，生日/纪念日卡片依次弹入，铃铛摇动，倒数天数高亮；
//   纸屑撒落强调「帮你记住重要日子」。
const DUR = 300;

export const Scene07: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <BirthdayApp />
      <Confetti from={26} count={40} />

      <Chip text="重要的日子，一个不忘" x={50} y={88} delay={22} hide={110} variant="dark" dotRgb="233,89,168" />
      <Chip text="倒数 94 天，提前提醒" x={50} y={88} delay={120} hide={224} variant="dark" />
      <Chip text="纪念日，也有它的一份" x={50} y={88} delay={234} variant="dark" dotRgb="245,74,69" />

      <FlashIn />
      <FlashOut dur={DUR} />
    </AbsoluteFill>
  );
};
