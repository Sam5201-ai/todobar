import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../tokens';
import { Caption, FlashIn, FlashOut, KeyCap, PanelHeader, Tabs, DateStrip, TaskCard, AddPill, Taskbar } from '../components';

// 场景 3 贴边呼出 · 一行速记：桌面场景 → Ctrl+Shift+T → 面板滑入 → 打字添加 → 勾选完成 → 收回
const PANEL_W = 640;
const PANEL_H = 1210;
const PANEL_TOP = 340;
const TYPE_TEXT = '15:00 团队周会';

export const Scene03: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 桌面 / 浏览器窗口入场
  const deskS = spring({ frame: Math.max(0, f - 2), fps, config: { damping: 16 } });
  // 键帽
  const keyFade = interpolate(f, [100, 122], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressCtrl = f >= 52 && f < 72;
  const pressShift = f >= 60 && f < 72;
  const pressT = f >= 68 && f < 72;
  // 面板滑入 / 滑出
  const sIn = spring({ frame: Math.max(0, f - 80), fps, config: { damping: 17, mass: 0.9 } });
  const sOut = spring({ frame: Math.max(0, f - 314), fps, config: { damping: 16, mass: 0.9 } });
  const panelX = 1080 - sIn * (PANEL_W + 12) + sOut * (PANEL_W + 12);

  // 打字机
  const inputS = spring({ frame: Math.max(0, f - 134), fps, config: { damping: 15 } });
  const typedLen = Math.max(0, Math.min(TYPE_TEXT.length, Math.floor((f - 148) / 5)));
  const typed = TYPE_TEXT.slice(0, typedLen);
  const caretOn = f >= 148 && f < 208 && Math.floor(f / 8) % 2 === 0;
  const enterPop = spring({ frame: Math.max(0, f - 208), fps, config: { damping: 13, mass: 0.6 } });
  const inputGone = interpolate(f, [208, 224], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // 日期标题项数 3 → 4
  const countPop = spring({ frame: Math.max(0, f - 210), fps, config: { damping: 12 } });
  const itemsCount = f >= 210 ? 4 : 3;

  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      {/* 桌面壁纸（远山风格） */}
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, #dfeaf6 0%, #eef3f8 46%, #e4ebf2 100%)' }} />
      <svg style={{ position: 'absolute', bottom: 0, left: 0 }} width={1080} height={560} viewBox="0 0 1080 560" fill="none">
        <path d="M0 300 C 190 160 340 220 520 300 C 700 380 880 300 1080 210 V560 H0 Z" fill="#c3d3e2" opacity={0.75} />
        <path d="M0 430 C 230 320 430 380 640 430 C 830 475 980 420 1080 360 V560 H0 Z" fill="#a9bfd3" opacity={0.85} />
      </svg>
      <FlashIn />

      {/* 浏览器窗口（工作场景） */}
      <div
        style={{
          position: 'absolute',
          left: 24,
          top: 400,
          width: 460,
          height: 1130,
          background: '#ffffff',
          borderRadius: 22,
          border: '1.5px solid #e3e6ea',
          boxShadow: '0 30px 80px rgba(31,54,90,0.16)',
          overflow: 'hidden',
          opacity: deskS,
          transform: `translateY(${(1 - deskS) * 40}px)`,
        }}
      >
        {/* 窗口栏 */}
        <div style={{ height: 62, borderBottom: '1.5px solid #edeff2', display: 'flex', alignItems: 'center', padding: '0 22px', gap: 10, background: '#f7f8fa' }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#f0705f' }} />
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#f5bd4f' }} />
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#61c454' }} />
          <div style={{ flex: 1, height: 34, marginLeft: 16, background: '#eceef1', borderRadius: 8 }} />
        </div>
        {/* 正文骨架 */}
        <div style={{ padding: '38px 40px' }}>
          <div style={{ width: '62%', height: 34, background: '#d7dbe1', borderRadius: 8 }} />
          <div style={{ width: '38%', height: 20, background: '#e6e9ed', borderRadius: 6, marginTop: 20 }} />
          <div style={{ marginTop: 36, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {[92, 100, 84, 96, 70, 88, 94, 62].map((w, i) => (
              <div key={i} style={{ width: `${w}%`, height: 18, background: i % 3 === 2 ? '#eef0f3' : '#e3e6ea', borderRadius: 6 }} />
            ))}
          </div>
          <div style={{ marginTop: 40, height: 190, background: 'linear-gradient(135deg, #dbe9fb 0%, #c9def5 100%)', borderRadius: 14 }} />
          <div style={{ marginTop: 34, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {[88, 76].map((w, i) => (
              <div key={i} style={{ width: `${w}%`, height: 18, background: '#e3e6ea', borderRadius: 6 }} />
            ))}
          </div>
        </div>
      </div>

      {/* 右缘把手（面板收起态） */}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 860,
          width: 26,
          height: 160,
          background: C.dark,
          borderRadius: '16px 0 0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: deskS * (1 - sIn),
        }}
      >
        <svg width={16} height={26} viewBox="0 0 16 26">
          <path d="M11 5 4 13l7 8" stroke="#ffffff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </div>

      {/* 快捷键键帽 */}
      <div
        style={{
          position: 'absolute',
          top: 130,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 26,
          opacity: keyFade,
          transform: `translateY(${interpolate(f, [100, 122], [0, -26], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
        }}
      >
        <KeyCap label="Ctrl" size={148} pressed={pressCtrl} delay={20} />
        <span style={{ fontSize: 54, fontWeight: 800, color: C.ink3, opacity: keyFade }}>+</span>
        <KeyCap label="Shift" size={148} pressed={pressShift} delay={28} />
        <span style={{ fontSize: 54, fontWeight: 800, color: C.ink3, opacity: keyFade }}>+</span>
        <KeyCap label="T" size={148} pressed={pressT} delay={36} />
      </div>

      {/* 面板 */}
      <div
        style={{
          position: 'absolute',
          left: panelX,
          top: PANEL_TOP,
          width: PANEL_W,
          height: PANEL_H,
          background: '#ffffff',
          borderRadius: 26,
          border: '1.5px solid #e6e9ed',
          boxShadow: '-30px 20px 80px rgba(31,54,90,0.22)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <PanelHeader scale={1.04} />
        <Tabs active={0} scale={1.04} />
        <DateStrip active={2} scale={1.04} />
        {/* 日期标题 */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '24px 30px 4px' }}>
          <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 800, color: C.ink }}>10月13日 周二</span>
          <span
            style={{
              fontFamily: FONT,
              fontSize: 24,
              color: C.ink3,
              display: 'inline-block',
              transform: `scale(${f >= 210 ? 1 + (1 - countPop) * 0.35 : 1})`,
            }}
          >
            {itemsCount} 项
          </span>
        </div>
        {/* 任务列表 */}
        <div style={{ padding: '10px 24px 0', display: 'flex', flexDirection: 'column', gap: 18, position: 'relative' }}>
          <TaskCard title="整理季度 OKR 评审材料" time="10-13 17:30" badge="提醒" pinned scale={1.04} delay={100} />
          <TaskCard title="回复客户反馈邮件" checkAt={256} scale={1.04} delay={112} />
          <TaskCard title="健身房 · 力量训练 45min" time="10-13 20:45" scale={1.04} delay={124} />
          {/* 新添加的任务卡 */}
          {f >= 208 && (
            <div style={{ opacity: enterPop, transform: `translateY(${(1 - enterPop) * 30}px) scale(${0.94 + enterPop * 0.06})` }}>
              <TaskCard title="团队周会" time="10-13 15:00" badge="提醒" scale={1.04} delay={208} />
            </div>
          )}
        </div>
        <div style={{ marginTop: 'auto', paddingBottom: 30 }}>
          <AddPill scale={1.04} delay={130} />
        </div>

        {/* 打字输入条（浮在底部） */}
        {f < 226 && (
          <div
            style={{
              position: 'absolute',
              left: 24,
              right: 24,
              bottom: 140,
              background: '#ffffff',
              border: `3px solid ${C.primary}`,
              borderRadius: 18,
              padding: '22px 26px',
              display: 'flex',
              alignItems: 'center',
              boxShadow: '0 18px 50px rgba(29,126,240,0.28)',
              opacity: inputS * inputGone,
              transform: `translateY(${(1 - inputS) * 34}px)`,
            }}
          >
            <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>
              {typed}
              {caretOn && <span style={{ display: 'inline-block', width: 3, height: 34, background: C.primary, marginLeft: 4, verticalAlign: '-6px' }} />}
            </span>
          </div>
        )}
      </div>

      {/* Enter 回车提示 */}
      {f >= 200 && f < 232 && (
        <div
          style={{
            position: 'absolute',
            left: panelX + 40,
            bottom: 500,
            background: C.dark,
            color: '#ffffff',
            fontFamily: FONT,
            fontSize: 26,
            fontWeight: 700,
            borderRadius: 12,
            padding: '12px 24px',
            opacity: interpolate(f, [200, 210, 224, 232], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            zIndex: 20,
          }}
        >
          Enter ↵ 已添加
        </div>
      )}

      <Taskbar />
      <Caption text="Ctrl + Shift + T · 随时呼出" delay={22} hide={236} bottom={120} />
      <Caption text="一行速记 · 用完即收" delay={248} bottom={120} />
      <FlashOut dur={360} />
    </AbsoluteFill>
  );
};
