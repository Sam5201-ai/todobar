import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, MONO } from './tokens';

// ============ 对照真实截图重建的 Tacco 页面（代码版，可动态演示） ============
// 布局/颜色/文案均以 shot-*.png 为基准

// 浅蓝山水底（待办/计算器等页面的背景）
export const LandscapeBg: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#f6f7f9' }}>
    <svg
      width="1080"
      height="1920"
      style={{ position: 'absolute', bottom: 0, left: 0 }}
      viewBox="0 0 1080 560"
      fill="none"
    >
      <path d="M0 300 C 180 210, 320 240, 470 300 C 620 360, 780 340, 1080 260 L1080 560 L0 560 Z" fill="#dbe7f6" opacity={0.75} />
      <path d="M0 400 C 220 330, 420 350, 640 410 C 820 458, 950 440, 1080 400 L1080 560 L0 560 Z" fill="#c6d9ef" opacity={0.7} />
      <path d="M0 480 C 260 440, 540 450, 800 490 C 940 512, 1020 508, 1080 500 L1080 560 L0 560 Z" fill="#b3cfea" opacity={0.65} />
    </svg>
  </AbsoluteFill>
);

// 页面弹入
export const PageIn: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 16, mass: 0.7 } });
  return (
    <AbsoluteFill style={{ opacity: s, transform: `scale(${0.96 + s * 0.04})` }}>
      {children}
    </AbsoluteFill>
  );
};

// 顶部栏：logo + Tacco + 右侧功能图标 + 时间
const HeadIcon: React.FC<{ children: React.ReactNode; delay: number }> = ({ children, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 13, mass: 0.5 } });
  return (
    <div style={{ opacity: s, transform: `translateY(${(1 - s) * 18}px)` }}>
      <svg width={40} height={40} viewBox="0 0 48 48" fill="none">
        {children}
      </svg>
    </div>
  );
};

export const AppHeader: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 16, mass: 0.6 } });
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '34px 40px 18px', gap: 16 }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 15,
          overflow: 'hidden',
          boxShadow: '0 6px 18px rgba(29,126,240,0.28)',
          transform: `scale(${s})`,
        }}
      >
        <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <div style={{ fontFamily: FONT, fontSize: 36, fontWeight: 800, color: C.ink, flex: 1 }}>Tacco</div>
      {/* 麦克风 */}
      <HeadIcon delay={8}>
        <rect x={19} y={7} width={10} height={20} rx={5} stroke="#454c56" strokeWidth={3.2} />
        <path d="M13 22a11 11 0 0 0 22 0" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" />
        <path d="M24 33v7" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" />
      </HeadIcon>
      {/* 取色 */}
      <HeadIcon delay={12}>
        <circle cx={24} cy={24} r={13} stroke="#454c56" strokeWidth={3.2} />
        <circle cx={24} cy={24} r={5} fill="#1d7ef0" />
      </HeadIcon>
      {/* 计算器 */}
      <HeadIcon delay={16}>
        <rect x={11} y={7} width={26} height={34} rx={6} stroke="#454c56" strokeWidth={3.2} />
        <rect x={15.5} y={11.5} width={17} height={7.5} rx={2} fill="#454c56" opacity={0.55} />
        <circle cx={17.5} cy={26} r={2.1} fill="#454c56" />
        <circle cx={24} cy={26} r={2.1} fill="#454c56" />
        <circle cx={30.5} cy={26} r={2.1} fill="#454c56" />
        <circle cx={17.5} cy={33.5} r={2.1} fill="#454c56" />
        <circle cx={24} cy={33.5} r={2.1} fill="#454c56" />
        <circle cx={30.5} cy={33.5} r={2.1} fill="#454c56" />
      </HeadIcon>
      {/* 万年历 */}
      <HeadIcon delay={20}>
        <path d="M24 12c-3-2.6-7.5-3.4-13-3v27c5.5-.4 10 .4 13 3 3-2.6 7.5-3.4 13-3V9c-5.5-.4-10 .4-13 3Z" stroke="#454c56" strokeWidth={3} strokeLinejoin="round" />
        <path d="M24 12v27" stroke="#454c56" strokeWidth={3} strokeLinecap="round" />
      </HeadIcon>
      {/* 同步 */}
      <HeadIcon delay={24}>
        <path d="M38 20a14 14 0 0 0-25-5" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" />
        <path d="M13 8v8h8" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 28a14 14 0 0 0 25 5" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" />
        <path d="M35 40v-8h-8" stroke="#454c56" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
      </HeadIcon>
      {/* 时间 */}
      <div style={{ fontFamily: MONO, fontSize: 30, fontWeight: 700, color: C.ink, marginLeft: 6 }}>13:51</div>
    </div>
  );
};

// 分类 Tab：黑胶囊随 active 平滑滑动
// segs = 滑动关键帧序列（分段插值），如 [{t:0,seg:0},{t:64,seg:0},{t:78,seg:1},{t:144,seg:1},{t:158,seg:0}]
export const TabPills: React.FC<{
  labels: string[];
  segs: { t: number; seg: number }[];
}> = ({ labels, segs }) => {
  const f = useCurrentFrame();
  const seg = interpolate(
    f,
    segs.map((s) => s.t),
    segs.map((s) => s.seg),
    { easing: Easing.inOut(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const w = 100 / labels.length;
  return (
    <div style={{ margin: '14px 28px 0', background: C.pill, borderRadius: 999, padding: 7, position: 'relative', height: 92 }}>
      <div
        style={{
          position: 'absolute',
          top: 7,
          bottom: 7,
          left: `calc(${seg * w}% + 7px)`,
          width: `calc(${w}% - 14px)`,
          background: C.dark,
          borderRadius: 999,
          boxShadow: '0 6px 16px rgba(23,24,26,0.28)',
        }}
      />
      {labels.map((lb, i) => (
        <div
          key={lb}
          style={{
            position: 'absolute',
            top: 7,
            bottom: 7,
            left: `${i * w}%`,
            width: `${w}%`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT,
            fontSize: 30,
            fontWeight: 600,
            color: i === Math.round(seg) ? '#ffffff' : C.ink2,
            transition: 'none',
          }}
        >
          {lb}
        </div>
      ))}
    </div>
  );
};

// 日期条
export const DateStrip: React.FC<{ active: number }> = ({ active }) => {
  const days = [
    { d: '10/31', w: '周六' },
    { d: '11/1', w: '周日' },
    { d: '11/2', w: '周一' },
    { d: '11/3', w: '周二' },
    { d: '11/4', w: '今天' },
  ];
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: 'flex', gap: 12, padding: '22px 28px 0' }}>
      {days.map((it, i) => {
        const on = i === active;
        const s = spring({ frame: f - 10 - i * 3, fps, config: { damping: 14, mass: 0.5 } });
        return (
          <div
            key={it.d}
            style={{
              flex: 1,
              borderRadius: 18,
              padding: '16px 0 12px',
              textAlign: 'center',
              background: on ? C.dark : C.pill,
              position: 'relative',
              opacity: s,
              transform: `translateY(${(1 - s) * 20}px)`,
            }}
          >
            <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: on ? 800 : 600, color: on ? '#ffffff' : C.ink2 }}>{it.d}</div>
            <div style={{ fontFamily: FONT, fontSize: 21, color: on ? '#b8bcc4' : C.ink3, marginTop: 3 }}>{it.w}</div>
            {on && (
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: C.red,
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 8,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// 绿色勾选圈（可从 ○ → ✓）
export const CheckCircle: React.FC<{ checked: boolean; size?: number; popAt?: number }> = ({ checked, size = 44, popAt = 0 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - popAt), fps, config: { damping: 10, mass: 0.5 } });
  if (!checked) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: '3px solid #c9cdd4',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#22a45d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transform: `scale(${s})`,
        boxShadow: `0 ${6 * s}px ${16 * s}px rgba(34,164,93,0.4)`,
      }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
        <path d="M4.5 12.5 10 18 19.5 7" stroke="#ffffff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
};

// ============ 待办页（可交互重建版） ============

type SubTask = { t: string; done: boolean };
type Task = { t: string; time?: string; alarm?: boolean; subs?: SubTask[] };

const DAY_TASKS: Task[] = [
  { t: '设计原型图', time: '11-05 09:00', alarm: true },
  {
    t: '开部门会议',
    subs: [
      { t: '提醒各岗位人员写报告', done: false },
      { t: '安排各岗位工作', done: true },
      { t: '记录会员纪要', done: true },
    ],
  },
];

const WEEK_TASKS: Task[] = [
  { t: '整理本周复盘报告', time: '11-07 18:00', alarm: true },
  { t: '安排下周产品排期', time: '11-08 10:00' },
  { t: '回复用户反馈邮件', time: '11-08 16:00' },
];

export const TodoApp: React.FC<{
  segs: { t: number; seg: number }[]; // tab 滑动关键帧（与 TabPills 一致）
  switches: { out: number }[]; // 每次列表切换的退场帧（内容随滑动中点换页）
  checkAt?: number; // 子任务打勾帧
}> = ({ segs, switches, checkAt }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 当前激活 tab（滑动过半即切换）
  const seg = interpolate(
    f,
    segs.map((s) => s.t),
    segs.map((s) => s.seg),
    { easing: Easing.inOut(Easing.quad), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const activeTab = Math.round(seg);

  // 最近一次已发生的切换（支持多次来回切换）
  let sw = -1;
  for (const s of switches) if (f >= s.out) sw = s.out;

  // 列表切换动画：旧列表在 sw 起上移淡出，新列表 sw+6 起滑入
  const outP = sw < 0 ? 0 : interpolate(f, [sw, sw + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const inP = sw < 0 ? 0 : interpolate(f, [sw + 6, sw + 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const tasks = activeTab === 0 ? DAY_TASKS : WEEK_TASKS;
  const prevTasks = activeTab === 0 ? WEEK_TASKS : DAY_TASKS;

  // 列表标题行
  const title = activeTab === 0 ? '11月3日 周二' : '本周 11月3日 - 11月9日';
  const count = activeTab === 0 ? '2 项' : '3 项';

  return (
    <AbsoluteFill>
      <AppHeader />
      <TabPills labels={['日待办', '周待办', '月待办', '记节日']} segs={segs} />
      <DateStrip active={2} />

      {/* 列表标题 */}
      <div style={{ padding: '30px 40px 6px', display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <span style={{ fontFamily: FONT, fontSize: 34, fontWeight: 800, color: C.ink }}>{title}</span>
        <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: C.ink3 }}>{count}</span>
      </div>

      {/* 任务列表（切换动画：仅切换期间双层叠放，其余时间单层静态） */}
      <div style={{ padding: '0 28px', position: 'relative', height: 1100 }}>
        {sw >= 0 && outP < 1 && (
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - outP, transform: `translateY(${-outP * 60}px)`, pointerEvents: 'none' }}>
            {prevTasks.map((tk, i) => (
              <TaskCard key={`old-${sw}-${i}`} task={tk} index={i} expandFactor={1} checkAt={-1} dim />
            ))}
          </div>
        )}
        {(sw < 0 || inP > 0) && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              opacity: sw < 0 ? 1 : inP,
              transform: `translateY(${sw < 0 ? 0 : (1 - inP) * 60}px)`,
            }}
          >
            {tasks.map((tk, i) => (
              <TaskCard key={`cur-${sw}-${i}`} task={tk} index={i} expandFactor={1} checkAt={checkAt ?? -1} />
            ))}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

// 单张任务卡（含子任务展开/收起、勾选）
const TaskCard: React.FC<{ task: Task; index: number; expandFactor: number; checkAt: number; dim?: boolean }> = ({
  task,
  index,
  expandFactor,
  checkAt,
  dim,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - 12 - index * 5, fps, config: { damping: 15, mass: 0.55 } });
  const hasSubs = !!task.subs;

  // 收起时隐藏子任务区（高度压缩 + 淡出）
  const subH = task.subs ? task.subs.length * 92 + 20 : 0;
  const subOpacity = Math.min(1, expandFactor * 1.6);

  return (
    <div
      style={{
        background: dim ? '#ffffff' : '#ffffff',
        borderRadius: 26,
        marginBottom: 20,
        padding: '28px 30px',
        boxShadow: '0 4px 18px rgba(23,28,38,0.06)',
        border: '1px solid rgba(23,28,38,0.05)',
        opacity: s,
        transform: `translateY(${(1 - s) * 36}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <CheckCircle checked={false} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 700, color: C.ink }}>{task.t}</div>
          {task.time && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              {task.alarm && (
                <svg width={26} height={26} viewBox="0 0 24 24" fill="none">
                  <circle cx={12} cy={13} r={8} stroke={C.red} strokeWidth={2.4} />
                  <path d="M12 9.5V13l2.5 2" stroke={C.red} strokeWidth={2.4} strokeLinecap="round" />
                  <path d="M7 3 4.5 5M17 3l2.5 2" stroke={C.red} strokeWidth={2.4} strokeLinecap="round" />
                </svg>
              )}
              <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: C.red }}>{task.time}</span>
            </div>
          )}
        </div>
        {hasSubs && (
          <svg
            width={34}
            height={34}
            viewBox="0 0 24 24"
            style={{ transform: `rotate(${(1 - expandFactor) * -90}deg)` }}
          >
            <path d="M6 9.5 12 15.5 18 9.5" stroke="#9aa0a8" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </div>

      {/* 子任务区（高度动画） */}
      {hasSubs && (
        <div
          style={{
            height: subH * expandFactor,
            opacity: subOpacity,
            overflow: 'hidden',
            marginTop: expandFactor > 0.05 ? 18 : 0,
            paddingLeft: 66,
          }}
        >
          {task.subs!.map((st, si) => {
            const isChecked = st.done || (si === 0 && checkAt >= 0 && f >= checkAt);
            const popAt = si === 0 ? checkAt : 0;
            return (
              <div key={st.t} style={{ display: 'flex', alignItems: 'center', gap: 20, height: 92 }}>
                <CheckCircle checked={isChecked} size={40} popAt={popAt} />
                <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 600, color: isChecked && si === 0 && checkAt >= 0 ? C.ink3 : C.ink2 }}>
                  {st.t}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
