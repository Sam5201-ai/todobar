import React from 'react';
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../tokens';
import { Caption, FlashIn, FlashOut, PageHead, PanelHeader, Tabs, DateStrip, TaskCard, AddPill, Taskbar, DesktopBadge, DeskWaves } from '../components';

// 场景 6 个性化 + 云同步：点选星夜背景 → 面板实时变化 → 深色主题 → 云同步粒子
const PANEL_W = 520;
const PANEL_TOP = 300;
const PANEL_H = 660;

// 迷你面板（背景切换演示主角）
const MiniPanel: React.FC<{ wall: React.CSSProperties; dark: boolean; opacity: number }> = ({ wall, dark, opacity }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      borderRadius: 26,
      overflow: 'hidden',
      background: dark ? '#1e2126' : '#ffffff',
      opacity,
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    <div style={{ ...wall, position: 'absolute', inset: 0 }} />
    {dark && (
      <div style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: `${random(`sx${i}`) * 100}%`,
              top: `${random(`sy${i}`) * 46}%`,
              width: 3 + random(`sr${i}`) * 3,
              height: 3 + random(`sr${i}`) * 3,
              borderRadius: '50%',
              background: '#ffffff',
              opacity: 0.5 + random(`so${i}`) * 0.5,
            }}
          />
        ))}
      </div>
    )}
    <div style={{ position: 'relative' }}>
      <PanelHeader dark={dark} scale={0.82} />
      <Tabs active={0} dark={dark} scale={0.82} />
      <DateStrip active={2} dark={dark} scale={0.82} />
    </div>
    <div style={{ position: 'relative', padding: '14px 20px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TaskCard title="整理季度 OKR 评审材料" time="10-13 17:30" badge="提醒" pinned dark={dark} scale={0.82} delay={14} />
      <TaskCard title="回复客户反馈邮件" dark={dark} scale={0.82} delay={22} />
      <TaskCard title="健身房 · 力量训练 45min" time="10-13 20:45" dark={dark} scale={0.82} delay={30} />
      <AddPill dark={dark} scale={0.78} delay={38} />
    </div>
  </div>
);

const SWATS: { name: string; bg: React.CSSProperties; darkText?: boolean }[] = [
  { name: '纯色', bg: { background: '#f2f3f5' }, darkText: true },
  { name: '极光', bg: { background: 'linear-gradient(135deg,#c3e8ff,#e6d9ff)' }, darkText: true },
  { name: '清蓝', bg: { background: 'linear-gradient(180deg,#bfe3ff,#7db8f0)' }, darkText: true },
  { name: '远山', bg: { background: 'linear-gradient(180deg,#dbe9f8,#b0c9e0)' }, darkText: true },
  { name: '海浪', bg: { background: 'linear-gradient(180deg,#9ad0d8,#5da8b8)' } },
  { name: '枝叶', bg: { background: 'linear-gradient(135deg,#dfe8d0,#a9c48c)' }, darkText: true },
  { name: '星夜', bg: { background: 'linear-gradient(180deg,#2a3358,#0f1526)' } },
  { name: '赛博', bg: { background: 'linear-gradient(135deg,#3b2d5e,#7b4dbb)' } },
  { name: '动漫', bg: { background: 'linear-gradient(180deg,#aee1ff,#5fa8e8)' }, darkText: true },
];

export const Scene06: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headS = spring({ frame: Math.max(0, f - 2), fps, config: { damping: 16 } });
  const cardS = spring({ frame: Math.max(0, f - 12), fps, config: { damping: 16 } });

  // 背景切换 / 主题切换的透明度
  const tBg = spring({ frame: Math.max(0, f - 88), fps, config: { damping: 16 } });
  const tDark = spring({ frame: Math.max(0, f - 120), fps, config: { damping: 16 } });

  // 当前选中的背景（点星夜后为 6）
  const selected = f >= 88 ? 6 : 3;

  // 光标移动到「星夜」
  const curS = spring({ frame: Math.max(0, f - 62), fps, config: { damping: 13, mass: 0.7 } });
  const target = { x: 337, y: 1466 };
  const start = { x: 690, y: 1200 };
  const cx = start.x + (target.x - start.x) * curS;
  const cy = start.y + (target.y - start.y) * curS;
  const ripple = interpolate(f, [84, 102], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // 云同步
  const syncS = spring({ frame: Math.max(0, f - 172), fps, config: { damping: 14 } });
  const ringP = interpolate(f, [176, 232], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const doneS = spring({ frame: Math.max(0, f - 236), fps, config: { damping: 12, mass: 0.6 } });

  // 外观分段选择
  const segDark = f >= 120;

  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #dfeaf6 0%, #eef3f8 46%, #e4ebf2 100%)', fontFamily: FONT }}>
      <FlashIn />
      <DeskWaves />
      <Taskbar />
      <DesktopBadge />
      <PageHead title="换个背景，换个心情" sub="9 款背景 · 深浅主题 · 数据云同步" />

      {/* 面板预览（三层交叉淡入：远山浅色 → 星夜白卡 → 星夜深色卡） */}
      <div
        style={{
          position: 'absolute',
          left: (1080 - PANEL_W) / 2,
          top: PANEL_TOP,
          width: PANEL_W,
          height: PANEL_H,
          borderRadius: 26,
          boxShadow: '0 30px 80px rgba(31,54,90,0.18)',
          opacity: headS,
          transform: `translateY(${(1 - headS) * 40}px)`,
        }}
      >
        <MiniPanel wall={{ background: 'linear-gradient(180deg,#dbe9f8 0%,#eef3f8 55%,#c7d8e8 100%)' }} dark={false} opacity={1 - tBg} />
        <MiniPanel wall={{ background: 'linear-gradient(180deg,#2a3358 0%,#151b30 55%,#0f1526 100%)' }} dark={false} opacity={tBg * (1 - tDark)} />
        <MiniPanel wall={{ background: 'linear-gradient(180deg,#2a3358 0%,#151b30 55%,#0f1526 100%)' }} dark={true} opacity={tDark} />
      </div>

      {/* 云同步悬浮卡（叠在面板上部，避免与大标题重叠） */}
      <div
        style={{
          position: 'absolute',
          left: 540,
          top: 372,
          transform: `translate(-50%, ${(1 - syncS) * -30}px)`,
          opacity: syncS,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          background: '#ffffff',
          borderRadius: 999,
          padding: '18px 40px 18px 22px',
          boxShadow: '0 20px 60px rgba(31,54,90,0.30)',
          zIndex: 10,
        }}
      >
        <div style={{ position: 'relative', width: 96, height: 96 }}>
          <svg width={96} height={96} viewBox="0 0 96 96">
            <circle cx={48} cy={48} r={40} stroke="#e3e7ec" strokeWidth={7} fill="none" />
            <circle
              cx={48}
              cy={48}
              r={40}
              stroke={C.primary}
              strokeWidth={7}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 40}`}
              strokeDashoffset={`${2 * Math.PI * 40 * (1 - ringP)}`}
              transform="rotate(-90 48 48)"
            />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {f < 236 ? (
              <svg width={50} height={50} viewBox="0 0 48 48" fill="none">
                <path d="M15 34a9 9 0 0 1-1.5-17.9A12 12 0 0 1 37 19.5 8 8 0 0 1 35.5 34H15Z" fill={C.primary} opacity={0.9} />
              </svg>
            ) : (
              <svg width={44} height={44} viewBox="0 0 24 24">
                <path d="M4.5 12.5 10 18 19.5 7" stroke={C.primary} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </div>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.ink }}>
          {f < 236 ? '正在同步…' : <span style={{ color: C.primary }}>已同步</span>}
        </div>
      </div>

      {/* 上升粒子（面板底部 → 同步卡） */}
      {f >= 176 &&
        Array.from({ length: 10 }).map((_, i) => {
          const cycle = (f - 176 - i * 5) % 44;
          if (cycle < 0) return null;
          const p = cycle / 44;
          const px = 340 + random(`pt${i}`) * 400;
          const py = interpolate(p, [0, 1], [PANEL_TOP + PANEL_H - 60, 460]);
          return (
            <span
              key={i}
              style={{
                position: 'absolute',
                left: px,
                top: py,
                width: 12 + random(`pw${i}`) * 8,
                height: 12 + random(`pw${i}`) * 8,
                borderRadius: '50%',
                background: i % 3 === 0 ? C.accent : C.primary,
                opacity: Math.sin(p * Math.PI) * 0.85,
              }}
            />
          );
        })}

      {/* 设置卡片 */}
      <div
        style={{
          position: 'absolute',
          left: 220,
          top: 1040,
          width: 640,
          height: 600,
          background: '#ffffff',
          borderRadius: 26,
          border: '1.5px solid #e6e9ed',
          boxShadow: '0 30px 80px rgba(31,54,90,0.14)',
          padding: '28px 30px',
          opacity: cardS,
          transform: `translateY(${(1 - cardS) * 40}px)`,
        }}
      >
        {/* 外观 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <span style={{ fontFamily: FONT, fontSize: 27, fontWeight: 700, color: C.ink }}>外观</span>
          <div style={{ flex: 1, background: C.pill, borderRadius: 999, padding: 6, display: 'flex' }}>
            {['浅色', '深色'].map((t, i) => {
              const on = segDark ? i === 1 : i === 0;
              return (
                <div
                  key={t}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '12px 0',
                    borderRadius: 999,
                    background: on ? C.dark : 'transparent',
                    color: on ? '#ffffff' : C.ink2,
                    fontFamily: FONT,
                    fontSize: 25,
                    fontWeight: on ? 700 : 500,
                  }}
                >
                  {t}
                </div>
              );
            })}
          </div>
        </div>
        {/* 背景 */}
        <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: 700, color: C.ink, margin: '24px 0 14px' }}>背景</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {SWATS.map((s, i) => {
            const on = i === selected;
            return (
              <div
                key={s.name}
                style={{
                  height: 96,
                  borderRadius: 14,
                  position: 'relative',
                  overflow: 'hidden',
                  ...s.bg,
                  boxShadow: on ? '0 0 0 3.5px #ffffff, 0 0 0 6.5px #ffffff' : 'inset 0 0 0 1px rgba(26,22,38,0.08)',
                  border: on ? `3.5px solid ${C.primary}` : '3.5px solid transparent',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 8,
                    textAlign: 'center',
                    fontFamily: FONT,
                    fontSize: 22,
                    fontWeight: 600,
                    color: s.darkText ? C.ink2 : '#ffffff',
                    textShadow: s.darkText ? 'none' : '0 1px 6px rgba(0,0,0,0.45)',
                  }}
                >
                  {s.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 点击光标 + 涟漪 */}
      {f >= 58 && f < 118 && (
        <>
          <div
            style={{
              position: 'absolute',
              left: cx - 26,
              top: cy - 26,
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              border: '2.5px solid rgba(26,22,38,0.35)',
              boxShadow: '0 8px 24px rgba(26,22,38,0.25)',
              opacity: f < 96 ? 1 : interpolate(f, [96, 110], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            }}
          />
          {f >= 84 && (
            <div
              style={{
                position: 'absolute',
                left: target.x - 30 - ripple * 50,
                top: target.y - 30 - ripple * 50,
                width: 60 + ripple * 100,
                height: 60 + ripple * 100,
                borderRadius: '50%',
                border: `4px solid ${C.primary}`,
                opacity: (1 - ripple) * 0.8,
              }}
            />
          )}
        </>
      )}

      <Caption text="9 款背景 · 深浅主题随心换" delay={20} hide={208} bottom={120} />
      <Caption text="本地优先 · 云端同步" delay={220} bottom={120} />
      <FlashOut dur={300} />
    </AbsoluteFill>
  );
};
