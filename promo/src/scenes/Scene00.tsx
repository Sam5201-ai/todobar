import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { FONT } from '../tokens';
import { FlashOut } from '../components';

// 场景 0 封面：成品封面图全屏呈现
// 动效：整图统一极缓漂移（无缩放、无局部切块，避免晃动感），保持画面平稳生动
export const Scene00: React.FC = () => {
  const f = useCurrentFrame();

  // 极轻漂移：整图一致移动，幅度克制（±5px），不产生晃动感
  const driftX = Math.sin(f * 0.008) * 5;
  const driftY = Math.cos(f * 0.006) * 4;

  return (
    <AbsoluteFill style={{ background: '#cfe8fb', fontFamily: FONT, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(1.012) translate(${driftX}px, ${driftY}px)` }}>
        <Img src={staticFile('cover-bg2.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>

      <FlashOut dur={60} />
    </AbsoluteFill>
  );
};
