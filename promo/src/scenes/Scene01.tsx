import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT } from '../tokens';
import { Caption, FlashOut } from '../components';

// 场景 1 痛点钩子：9:16 痛点插画分块动画——模糊底图垫底，标题/8 张便签/底部场景逐块弹入，最后清晰全图收尾
const PAIN = 'pain-wall2.png';

// 便签块网格（1080×1920 显示坐标，含图钉外扩）
const COLS = [
  { x: 48, w: 495 },
  { x: 551, w: 495 },
];
const ROWS = [
  { y: 390, h: 273 },
  { y: 680, h: 272 },
  { y: 964, h: 268 },
  { y: 1240, h: 272 },
];

// 弹入块：标题（含副标条）→ 8 张便签（Z 字顺序）→ 底部崩溃场景
type Block = { x: number; y: number; w: number; h: number; delay: number; fromY: number; fromScale: number; fromRot: number };
const BLOCKS: Block[] = [
  { x: 0, y: 0, w: 1080, h: 366, delay: 2, fromY: -70, fromScale: 1, fromRot: 0 },
  ...ROWS.flatMap((r, ri) =>
    COLS.map((c, ci) => ({
      x: c.x,
      y: r.y,
      w: c.w,
      h: r.h,
      delay: 8 + (ri * 2 + ci) * 5,
      fromY: 64,
      fromScale: 0.72,
      fromRot: (ri + ci) % 2 === 0 ? -5 : 5,
    })),
  ),
  { x: 0, y: 1512, w: 1080, h: 408, delay: 52, fromY: 90, fromScale: 1, fromRot: 0 },
];

export const Scene01: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 底图缓慢漂移（非缩放，避免 PPT 感）
  const driftX = Math.sin(f * 0.016) * 12;
  const driftY = Math.cos(f * 0.011) * 9;

  // 清晰全图收尾淡入
  const fullS = interpolate(f, [96, 116], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#e8eff7', fontFamily: FONT, overflow: 'hidden' }}>
      {/* 模糊底图：入场期间垫底，轻微漂移 */}
      <div style={{ position: 'absolute', inset: 0, opacity: interpolate(f, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <Img
          src={staticFile(PAIN)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(24px) brightness(0.96) saturate(0.88)',
            transform: `scale(1.06) translate(${driftX}px, ${driftY}px)`,
          }}
        />
      </div>

      {/* 分块弹入（块内以全尺寸负偏移显示对应区域） */}
      {BLOCKS.map((b, i) => {
        const s = spring({ frame: Math.max(0, f - b.delay), fps, config: { damping: 13, mass: 0.8 } });
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              overflow: 'hidden',
              opacity: s,
              transform: `translateY(${(1 - s) * b.fromY}px) scale(${1 - (1 - s) * (1 - b.fromScale)}) rotate(${(1 - s) * b.fromRot}deg)`,
            }}
          >
            <Img
              src={staticFile(PAIN)}
              style={{ position: 'absolute', left: -b.x, top: -b.y, width: 1080, height: 1920, objectFit: 'fill' }}
            />
          </div>
        );
      })}

      {/* 清晰全图收尾：覆盖所有块与模糊层，保证最终态无缝 */}
      <Img src={staticFile(PAIN)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: fullS }} />

      <Caption text="事情一多，就手忙脚乱" delay={128} />
      <FlashOut dur={180} />
    </AbsoluteFill>
  );
};
