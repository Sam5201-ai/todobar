import React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig, getStaticFiles } from 'remotion';
import { C, FONT } from '../tokens';
import { FlashIn, Logo, WinGlyph } from '../components';

// 场景 7 落版：品牌 + 真实截图 3D 轮播 + 下载引导
const PAGES = [
  { src: 'home-light.png', label: '待办主页' },
  { src: 'calculator.png', label: '内置计算器' },
  { src: 'huangli.png', label: '万年历宜忌' },
];
// 轮播时间轴（帧）：每页停留 60 帧，切换 18 帧
const PAGE_START = [36, 96, 156];
const PAGE_DUR = 60;
const TRANS = 18;

const FRAME_W = 600;
const FRAME_H = 1180;

export const Scene07: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoS = spring({ frame: Math.max(0, f - 4), fps, config: { damping: 12, mass: 0.7 } });
  const nameS = spring({ frame: Math.max(0, f - 14), fps, config: { damping: 14 } });
  const sloganS = spring({ frame: Math.max(0, f - 26), fps, config: { damping: 15 } });
  const frameS = spring({ frame: Math.max(0, f - 52), fps, config: { damping: 14, mass: 0.7 } });

  // 截图文件存在性检测（缺失时显示品牌占位）
  const files = getStaticFiles().map((sf) => sf.name);

  // 当前页与切换偏移
  let pageIdx = 0;
  for (let i = PAGES.length - 1; i >= 0; i--) {
    if (f - PAGE_START[i] >= 0) {
      pageIdx = i;
      break;
    }
  }
  // 切换进度：进入新页的前 18 帧滑入；首页视为已就位
  const prevIdx = pageIdx > 0 ? pageIdx - 1 : -1;
  const since = f - PAGE_START[pageIdx];
  const inProg = since < 0 ? 1 : Math.min(1, since / TRANS);
  const prevProg = prevIdx >= 0 ? Math.min(1, Math.max(0, (f - PAGE_START[prevIdx] - (PAGE_DUR - TRANS)) / TRANS)) : 0;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(760px 480px at 50% 16%, rgba(29,126,240,0.16), transparent 70%),
                     radial-gradient(640px 440px at 32% 86%, rgba(245,158,11,0.10), transparent 70%),
                     ${C.bg}`,
        fontFamily: FONT,
      }}
    >
      <FlashIn />

      {/* 品牌区 */}
      <div style={{ position: 'absolute', top: 96, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${logoS})`, opacity: logoS }}>
          <Logo size={140} />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          top: 272,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: FONT,
          fontSize: 80,
          fontWeight: 900,
          color: C.ink,
          opacity: nameS,
          transform: `translateY(${(1 - nameS) * 30}px)`,
        }}
      >
        Tacco
      </div>
      <div
        style={{
          position: 'absolute',
          top: 388,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: FONT,
          fontSize: 34,
          fontWeight: 600,
          color: C.ink2,
          opacity: sloganS,
          transform: `translateY(${(1 - sloganS) * 22}px)`,
        }}
      >
        待办事项，就该贴在屏幕边缘
      </div>

      {/* 截图轮播（600 宽：截图按 cover/top 展示，裁掉底部次要内容保证可读性；与角标行留出空档） */}
      <div
        style={{
          position: 'absolute',
          left: (1080 - FRAME_W) / 2,
          top: 548,
          width: FRAME_W,
          height: FRAME_H,
          borderRadius: 34,
          background: '#ffffff',
          border: '2px solid #e6e9ed',
          boxShadow: '0 40px 100px rgba(31,54,90,0.22)',
          overflow: 'hidden',
          opacity: frameS,
          transform: `translateY(${(1 - frameS) * 60}px)`,
        }}
      >
        {PAGES.map((p, i) => {
          // 当前页：自左侧滑入 rotateY 归正；前一页：滑出旋转淡出
          const isCur = i === pageIdx;
          const offset = isCur ? (1 - inProg) * 62 : i === prevIdx ? -prevProg * 62 : i < pageIdx ? -62 : 62;
          const rotY = isCur ? (1 - inProg) * 24 : i === prevIdx ? -prevProg * 24 : i < pageIdx ? -24 : 24;
          const fade = isCur ? 0.35 + inProg * 0.65 : i === prevIdx ? 1 - prevProg : 0;
          const exists = files.includes(p.src);
          return (
            <div
              key={p.src}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: exists ? '#ffffff' : `linear-gradient(160deg, ${C.primaryLight} 0%, ${C.primary} 100%)`,
                transform: `perspective(1400px) translateX(${offset}%) rotateY(${rotY}deg)`,
                opacity: fade,
                zIndex: isCur ? 2 : i === prevIdx ? 1 : 0,
              }}
            >
              {exists ? (
                <Img src={staticFile(p.src)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <Logo size={120} />
                  <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 800, color: '#ffffff', marginTop: 30 }}>{p.label}</div>
                </div>
              )}
            </div>
          );
        })}
        {/* 页面指示点 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 22,
            display: 'flex',
            justifyContent: 'center',
            gap: 12,
            zIndex: 5,
          }}
        >
          {PAGES.map((_, i) => {
            const on = i === pageIdx;
            return (
              <span
                key={i}
                style={{
                  width: on ? 40 : 14,
                  height: 14,
                  borderRadius: 999,
                  background: on ? '#ffffff' : 'rgba(255,255,255,0.55)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                  transition: 'none',
                }}
              />
            );
          })}
        </div>
      </div>

      {/* 「真实界面 · Windows 电脑桌面端」角标行（独立于截图框，避免压住截图内容） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 452,
          display: 'flex',
          justifyContent: 'center',
          gap: 14,
          zIndex: 6,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            background: C.dark,
            color: '#ffffff',
            fontFamily: FONT,
            fontSize: 26,
            fontWeight: 700,
            borderRadius: 999,
            padding: '10px 30px',
            opacity: frameS,
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: C.accent }} />
          真实界面 · {PAGES[pageIdx].label}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            background: C.dark,
            color: '#ffffff',
            fontFamily: FONT,
            fontSize: 26,
            fontWeight: 700,
            borderRadius: 999,
            padding: '10px 26px',
            opacity: frameS,
          }}
        >
          <WinGlyph size={24} color="#6cb8f5" />
          Windows 电脑桌面端
        </span>
      </div>

    </AbsoluteFill>
  );
};
