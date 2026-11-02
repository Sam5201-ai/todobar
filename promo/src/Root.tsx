import React from 'react';
import { Audio, Composition, Sequence, interpolate, staticFile } from 'remotion';
import { SCENE_DURS } from './tokens';
import { Scene00 } from './scenes/Scene00';
import { Scene01 } from './scenes/Scene01';
import { Scene02 } from './scenes/Scene02';
import { Scene03 } from './scenes/Scene03';
import { Scene04 } from './scenes/Scene04';
import { Scene05 } from './scenes/Scene05';
import { Scene06 } from './scenes/Scene06';
import { Scene07 } from './scenes/Scene07';

// 顺序必须与 tokens.ts 的 SCENE_DURS 一一对应
const SCENES = [Scene00, Scene01, Scene02, Scene03, Scene04, Scene05, Scene06, Scene07];

// ===== 音频编排 =====
// 旁白 s1-s7 对应各场景，起点 = 场景起点 + 少量偏移（让 FlashIn 先落定）
const SCENE_STARTS = SCENE_DURS.reduce<number[]>((acc, d, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + SCENE_DURS[i - 1]);
  return acc;
}, []);
const NARRATION_DELAY = [10, 14, 16, 16, 16, 16, 16];
const TOTAL_FRAMES = SCENE_DURS.reduce((a, b) => a + b, 0);

// BGM：Wallpaper（Kevin MacLeod, incompetech, CC-BY 4.0）——轻快马力琴，压低音量闪避旁白
const BGM_BASE = 0.2;
const VO_GAIN = 1.5; // TTS 源电平偏低，整体提升人声
const bgmVolume = (f: number) =>
  interpolate(f, [0, 24], [0, BGM_BASE], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) *
  interpolate(f, [TOTAL_FRAMES - 84, TOTAL_FRAMES - 6], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

export const Promo: React.FC = () => {
  let from = 0;
  return (
    <>
      {/* 背景音乐（全程，首尾淡入淡出） */}
      <Audio src={staticFile('bgm/Wallpaper.mp3')} volume={bgmVolume} />
      {/* 场景旁白（封面无旁白，s1-s7 对应第 2-8 个场景） */}
      {SCENE_STARTS.map((start, i) =>
        i === 0 ? null : (
          <Sequence key={`vo-${i}`} from={start + NARRATION_DELAY[i - 1]}>
            <Audio src={staticFile(`narration/s${i}.mp3`)} volume={VO_GAIN} />
          </Sequence>
        ),
      )}
      {SCENES.map((Scene, i) => {
        const start = from;
        from += SCENE_DURS[i];
        return (
          <Sequence key={i} from={start} durationInFrames={SCENE_DURS[i]}>
            <Scene />
          </Sequence>
        );
      })}
    </>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Promo"
    component={Promo}
    durationInFrames={SCENE_DURS.reduce((a, b) => a + b, 0)}
    fps={30}
    width={1080}
    height={1920}
  />
);
