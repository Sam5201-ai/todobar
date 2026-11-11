import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, MONO } from './tokens';
import { AppHeader, CheckCircle, LandscapeBg, PageIn } from './pages1';

// ============ 记节日页（可交互重建版）：卡片弹入 + 铃铛摇动 + 倒数天数高亮 ============

type RememberCard = {
  avatar: string;
  name: string;
  tag: string;
  date: string;
  left: string;
  days: number;
  bell?: boolean;
};

const BIRTHDAYS: RememberCard[] = [
  { avatar: '👩', name: '妈妈', tag: '家人', date: '农历正月初一 · 2/6 周六 · 农历', left: '3 个月后', days: 94, bell: true },
  { avatar: '👱‍♀️', name: '老婆', tag: '家人', date: '农历四月十六 · 5/21 周五 · 农历', left: '7 个月后', days: 198, bell: true },
];

const ANNIVERSARIES: RememberCard[] = [
  { avatar: '结', name: '结婚纪念日', tag: '我们', date: '1月1日 · 1/1 周五 · 公历', left: '2 个月后', days: 58, bell: true },
];

const Bell: React.FC<{ shake: boolean }> = ({ shake }) => {
  const f = useCurrentFrame();
  const rot = shake ? Math.sin(f * 0.2) * 16 : 0;
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" style={{ transform: `rotate(${rot}deg)`, transformOrigin: 'top center' }}>
      <path d="M12 3a6 6 0 0 0-6 6v4l-1.8 3h15.6L18 13V9a6 6 0 0 0-6-6Z" fill="#f5b53d" />
      <path d="M10 18.5a2.2 2.2 0 0 0 4 0" stroke="#f5b53d" strokeWidth={2} strokeLinecap="round" fill="none" />
    </svg>
  );
};

const RCard: React.FC<{ c: RememberCard; delay: number; rgb: string }> = ({ c, delay, rgb }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 14, mass: 0.6 } });
  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 26,
        padding: '26px 30px',
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        boxShadow: '0 4px 18px rgba(23,28,38,0.06)',
        opacity: s,
        transform: `translateY(${(1 - s) * 40}px)`,
      }}
    >
      <div
        style={{
          width: 86,
          height: 86,
          borderRadius: '50%',
          background: c.avatar === '结' ? '#eceef2' : '#ffe9d6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: c.avatar === '结' ? 34 : 48,
          fontWeight: 800,
          color: c.avatar === '结' ? C.ink3 : undefined,
          flexShrink: 0,
        }}
      >
        {c.avatar}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontFamily: FONT, fontSize: 34, fontWeight: 800, color: C.ink }}>{c.name}</span>
          <span style={{ fontFamily: FONT, fontSize: 24, fontWeight: 700, color: C.ink3, background: C.pill, borderRadius: 999, padding: '6px 18px' }}>
            {c.tag}
          </span>
          {c.bell && <Bell shake />}
        </div>
        <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: C.ink3, marginTop: 10 }}>{c.date}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink3 }}>{c.left}</div>
        <div style={{ fontFamily: MONO, fontSize: 44, fontWeight: 900, color: rgb === '233,89,168' ? '#e859a8' : rgb === '245,74,69' ? C.red : '#f59e0b', marginTop: 4 }}>
          {c.days}
          <span style={{ fontFamily: FONT, fontSize: 24, fontWeight: 700 }}> 天</span>
        </div>
      </div>
    </div>
  );
};

export const BirthdayApp: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - 6), fps, config: { damping: 15, mass: 0.6 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <PageIn>
        <AppHeader />
        {/* Tab：记节日 active */}
        <div style={{ margin: '14px 28px 0', background: C.pill, borderRadius: 999, padding: 7, display: 'flex' }}>
          {['日待办', '周待办', '月待办', '记节日'].map((t, i) => (
            <div
              key={t}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '16px 0',
                borderRadius: 999,
                background: i === 3 ? C.dark : 'transparent',
                color: i === 3 ? '#ffffff' : C.ink2,
                fontFamily: FONT,
                fontSize: 30,
                fontWeight: i === 3 ? 700 : 500,
              }}
            >
              {t}
            </div>
          ))}
        </div>

        <div style={{ padding: '34px 28px 0' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '0 12px', opacity: s }}>
            <span style={{ fontFamily: FONT, fontSize: 34, fontWeight: 800, color: C.ink }}>生日</span>
            <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink3 }}>2</span>
          </div>
          <div style={{ marginTop: 18 }}>
            {BIRTHDAYS.map((c, i) => (
              <RCard key={c.name} c={c} delay={22 + i * 14} rgb="233,89,168" />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '0 12px', marginTop: 14, opacity: s }}>
            <span style={{ fontFamily: FONT, fontSize: 34, fontWeight: 800, color: C.ink }}>纪念日</span>
            <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink3 }}>1</span>
          </div>
          <div style={{ marginTop: 18 }}>
            {ANNIVERSARIES.map((c) => (
              <RCard key={c.name} c={c} delay={52} rgb="245,74,69" />
            ))}
          </div>
        </div>
      </PageIn>
    </AbsoluteFill>
  );
};

// ============ 录音机（可交互重建版）：计时走秒 + 波形实时跳动 + 按下暂停 ============

const RecordingRow: React.FC<{ name: string; meta: string; delay: number }> = ({ name, meta, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 14, mass: 0.55 } });
  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 22,
        padding: '20px 26px',
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        boxShadow: '0 3px 12px rgba(23,28,38,0.05)',
        opacity: s,
        transform: `translateY(${(1 - s) * 30}px)`,
      }}
    >
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(244,74,69,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width={22} height={22} viewBox="0 0 24 24">
          <path d="M8 5.5 18 12 8 18.5Z" fill={C.red} />
        </svg>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONT, fontSize: 29, fontWeight: 700, color: C.ink }}>{name}</div>
        <div style={{ fontFamily: MONO, fontSize: 23, fontWeight: 600, color: C.ink3, marginTop: 6 }}>{meta}</div>
      </div>
      <svg width={30} height={30} viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={9} stroke="#c9cdd4" strokeWidth={2} fill="none" />
        <circle cx={12} cy={12} r={4} fill="#c9cdd4" />
      </svg>
    </div>
  );
};

export const RecorderApp: React.FC<{ pressAt: number }> = ({ pressAt }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const paused = f >= pressAt;

  // 计时走秒（每 30 帧 +1），暂停后冻结
  const tick = Math.min(paused ? pressAt : f, pressAt);
  const sec = Math.floor(Math.max(0, tick - 18) / 30);
  const tStr = `00:${String(sec).padStart(2, '0')}`;
  const pressP = paused ? interpolate(f, [pressAt, pressAt + 6], [0, 1], { extrapolateRight: 'clamp' }) : 0;

  const s = spring({ frame: f, fps, config: { damping: 16, mass: 0.6 } });

  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <PageIn>
        <div style={{ display: 'flex', alignItems: 'center', padding: '34px 40px 0', gap: 18 }}>
          <svg width={40} height={40} viewBox="0 0 24 24">
            <path d="M15 5 8 12l7 7" stroke="#1f2329" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.ink, flex: 1 }}>录音机</span>
        </div>

        {/* 录音状态大卡 */}
        <div style={{ margin: '24px 28px 0', background: '#ffffff', borderRadius: 32, padding: '44px 40px 36px', boxShadow: '0 10px 30px rgba(23,28,38,0.08)', textAlign: 'center' }}>
          {/* 红色按钮 */}
          <div
            style={{
              width: 132,
              height: 132,
              borderRadius: '50%',
              background: C.red,
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 ${14 - pressP * 6}px ${34 - pressP * 10}px rgba(244,74,69,0.45)`,
              transform: `scale(${1 - pressP * 0.08})`,
            }}
          >
            {paused ? (
              // 暂停后：录音三角（恢复）
              <svg width={54} height={54} viewBox="0 0 24 24">
                <path d="M8 5.5 18 12 8 18.5Z" fill="#ffffff" />
              </svg>
            ) : (
              // 录音中：暂停双竖条
              <svg width={50} height={50} viewBox="0 0 24 24">
                <rect x={7} y={5} width={3.6} height={14} rx={1.8} fill="#ffffff" />
                <rect x={13.4} y={5} width={3.6} height={14} rx={1.8} fill="#ffffff" />
              </svg>
            )}
          </div>

          <div style={{ fontFamily: MONO, fontSize: 84, fontWeight: 900, color: C.ink, marginTop: 26, fontVariantNumeric: 'tabular-nums' }}>{tStr}</div>
          <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, color: C.ink3, marginTop: 10 }}>
            {paused ? '已暂停 · 点击按钮继续' : '录音中 · 点击按钮暂停'}
          </div>

          {/* 波形（暂停后静止） */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 60, marginTop: 24 }}>
            {Array.from({ length: 40 }).map((_, i) => {
              const alive = paused ? pressAt - 18 : Math.max(0, f - 18);
              const h = 10 + Math.abs(Math.sin(alive * 0.22 + i * 0.9)) * 34;
              const fade = interpolate(alive, [0, 8], [0.2, 1], { extrapolateRight: 'clamp' });
              return (
                <div
                  key={i}
                  style={{
                    width: 6,
                    height: paused ? Math.max(10, h * (1 - pressP * 0.4)) : h,
                    borderRadius: 3,
                    background: paused ? '#e5b5b3' : C.red,
                    opacity: fade,
                  }}
                />
              );
            })}
          </div>

          {/* 完成 / 取消 */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 26, marginTop: 34 }}>
            <div
              style={{
                fontFamily: FONT,
                fontSize: 30,
                fontWeight: 800,
                background: C.dark,
                color: '#ffffff',
                borderRadius: 999,
                padding: '18px 64px',
                opacity: s,
                transform: `scale(${paused ? 1.06 : 1})`,
              }}
            >
              ✓ 完成
            </div>
            <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, color: C.ink3, border: '2px solid #d5d9e0', borderRadius: 999, padding: '18px 52px' }}>
              ✕ 取消
            </div>
          </div>
        </div>

        {/* 列表头 */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '30px 40px 0', gap: 14 }}>
          <span style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, color: C.ink3, flex: 1 }}>共 9 条 · 55.3MB</span>
          <span style={{ fontFamily: FONT, fontSize: 24, fontWeight: 600, color: C.ink3, background: C.pill, borderRadius: 999, padding: '10px 22px' }}>📍 位置</span>
          <span style={{ fontFamily: FONT, fontSize: 24, fontWeight: 600, color: C.ink3, background: C.pill, borderRadius: 999, padding: '10px 22px' }}>📁 文件夹</span>
        </div>

        {/* 搜索框 */}
        <div
          style={{
            margin: '20px 28px 0',
            background: C.pill,
            borderRadius: 999,
            padding: '20px 30px',
            fontFamily: FONT,
            fontSize: 27,
            fontWeight: 500,
            color: '#a8adb6',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <svg width={30} height={30} viewBox="0 0 24 24">
            <circle cx={11} cy={11} r={7} stroke="#a8adb6" strokeWidth={2.4} fill="none" />
            <path d="m16.5 16.5 4 4" stroke="#a8adb6" strokeWidth={2.4} strokeLinecap="round" />
          </svg>
          搜索录音或备注
        </div>

        {/* 归档列表 */}
        <div style={{ padding: '22px 28px 0' }}>
          <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: 800, color: C.ink2, padding: '0 12px 14px' }}>11月2日</div>
          <RecordingRow name="录音 11月2日 17:20" meta="2:00:00 · 54.8M" delay={120} />
          <RecordingRow name="录音 11月2日 16:45" meta="00:26 · 199KB" delay={134} />
          <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: 800, color: C.ink2, padding: '6px 12px 14px' }}>10月30日</div>
          <RecordingRow name="录音 10月30日 09:12" meta="00:03 · 24KB" delay={148} />
        </div>
      </PageIn>
    </AbsoluteFill>
  );
};
