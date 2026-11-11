import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, MONO } from './tokens';
import { AppHeader, LandscapeBg, PageIn } from './pages1';

// ============ 黄历页（可交互重建版）：点节气日期 → 大卡联动切换 → 点「回到今天」 ============

type DayCell = { d: number; sub?: string; red?: boolean; green?: boolean; prev?: boolean };
const GRID: DayCell[][] = [
  [
    { d: 26, sub: '十七', prev: true },
    { d: 27, sub: '十八', prev: true },
    { d: 28, sub: '十九', prev: true },
    { d: 29, sub: '二十', prev: true },
    { d: 30, sub: '廿一', prev: true },
    { d: 31, sub: '廿二', prev: true },
    { d: 1, sub: '万圣节', red: true },
  ],
  [
    { d: 2, sub: '廿四' },
    { d: 3, sub: '廿五' },
    { d: 4, sub: '廿六' },
    { d: 5, sub: '廿七' },
    { d: 6, sub: '廿八' },
    { d: 7, sub: '立冬', green: true },
    { d: 8, sub: '三十' },
  ],
  [
    { d: 9, sub: '十月' },
    { d: 10, sub: '初二' },
    { d: 11, sub: '初三' },
    { d: 12, sub: '初四' },
    { d: 13, sub: '初五' },
    { d: 14, sub: '初六' },
    { d: 15, sub: '初七' },
  ],
  [
    { d: 16, sub: '初八' },
    { d: 17, sub: '初九' },
    { d: 18, sub: '初十' },
    { d: 19, sub: '十一' },
    { d: 20, sub: '十二' },
    { d: 21, sub: '十三' },
    { d: 22, sub: '十四', green: true },
  ],
  [
    { d: 23, sub: '十五', green: true },
    { d: 24, sub: '十六' },
    { d: 25, sub: '十七' },
    { d: 26, sub: '感恩节', red: true },
    { d: 27, sub: '十九' },
    { d: 28, sub: '二十' },
    { d: 29, sub: '廿一' },
  ],
  [{ d: 30, sub: '廿二' }],
];

const DAY_INFO: Record<number, { w: string; lunar: string; ganzhi: string }> = {
  4: { w: '星期三', lunar: '九月廿六', ganzhi: '丙午年【马年】戊戌月 壬午日' },
  7: { w: '星期六', lunar: '九月廿九', ganzhi: '丙午年【马年】戊戌月 乙亥日' },
};

const WEEKS = ['一', '二', '三', '四', '五', '六', '日'];
const cellPos = (d: number): { col: number; row: number } => {
  for (let r = 0; r < GRID.length; r++) {
    const c = GRID[r].findIndex((x) => x.d === d && !x.prev);
    if (c >= 0) return { col: c, row: r };
  }
  return { col: 3, row: 1 };
};

export const HuangliApp: React.FC<{ selectAt: number; backAt: number }> = ({ selectAt, backAt }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 选中日：4 → (selectAt) 7 → (backAt) 4
  const sel = f < selectAt ? 4 : f < backAt ? 7 : 4;
  const selChange = f >= selectAt && f < selectAt + 20;
  const backChange = f >= backAt && f < backAt + 20;

  // 选中蓝块位置滑动：4→7（selectAt），7→4（backAt）
  const p4 = cellPos(4);
  const p7 = cellPos(7);
  const phase1 = interpolate(f, [selectAt, selectAt + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const phase2 = interpolate(f, [backAt, backAt + 14], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const move = phase1 * phase2;
  const block = {
    col: p4.col + (p7.col - p4.col) * move,
    row: p4.row + (p7.row - p4.row) * move,
  };

  const info = DAY_INFO[sel];
  const cardKey = sel;

  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <PageIn>
        <AppHeader />
        {/* 页标题与选择行 */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 40px 0', gap: 18 }}>
          <svg width={40} height={40} viewBox="0 0 24 24">
            <path d="M15 5 8 12l7 7" stroke="#1f2329" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.ink, flex: 1 }}>万年历</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '22px 40px 0' }}>
          <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, color: C.ink }}>2026年 ▾</span>
          <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, color: C.ink }}>11月 ▾</span>
          <div
            style={{
              marginLeft: 'auto',
              fontFamily: FONT,
              fontSize: 27,
              fontWeight: 700,
              color: C.primary,
              border: `2.5px solid ${C.primary}`,
              borderRadius: 999,
              padding: '12px 30px',
              opacity: backChange ? 0.5 : 1,
            }}
          >
            回到今天
          </div>
        </div>

        {/* 月历卡 */}
        <div style={{ margin: '24px 28px 0', background: '#ffffff', borderRadius: 28, padding: '26px 22px', boxShadow: '0 4px 18px rgba(23,28,38,0.06)' }}>
          <div style={{ fontFamily: FONT, fontSize: 32, fontWeight: 800, color: C.ink, paddingLeft: 10 }}>2026年11月</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', marginTop: 16 }}>
            {WEEKS.map((w) => (
              <div key={w} style={{ textAlign: 'center', fontFamily: FONT, fontSize: 24, fontWeight: 600, color: C.ink3, padding: '10px 0' }}>
                {w}
              </div>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            {/* 选中蓝块 */}
            <div
              style={{
                position: 'absolute',
                width: '13.2%',
                height: 118,
                left: `${block.col * 14.28 + 0.55}%`,
                top: block.row * 118,
                background: C.primary,
                borderRadius: 20,
                boxShadow: `0 ${8}px ${20}px rgba(29,126,240,0.35)`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 40, fontWeight: 800, color: '#ffffff' }}>{sel}</div>
            </div>
            {GRID.map((row, ri) => (
              <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', height: 118 }}>
                {row.map((cell, ci) => {
                  const selected = !cell.prev && cell.d === sel && (sel === cell.d);
                  return (
                    <div key={ci} style={{ textAlign: 'center', paddingTop: 12 }}>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 34,
                          fontWeight: cell.red || cell.green ? 800 : 600,
                          color: cell.prev ? '#c2c7cf' : cell.red ? C.red : cell.green ? '#22a45d' : C.ink,
                          opacity: selected ? 0 : 1,
                        }}
                      >
                        {cell.d}
                      </div>
                      <div
                        style={{
                          fontFamily: FONT,
                          fontSize: 19,
                          fontWeight: 600,
                          color: cell.prev ? '#d3d7de' : cell.red ? C.red : cell.green ? '#22a45d' : C.ink3,
                          marginTop: 2,
                          opacity: selected ? 0 : 1,
                        }}
                      >
                        {cell.sub}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* 详细信息条 */}
        <div
          style={{
            margin: '22px 28px 0',
            background: 'rgba(29,126,240,0.10)',
            border: `2px solid rgba(29,126,240,0.35)`,
            borderRadius: 20,
            padding: '18px 30px',
            fontFamily: FONT,
            fontSize: 28,
            fontWeight: 700,
            color: C.primary,
            display: 'flex',
            gap: 14,
          }}
        >
          2026年11月{sel}日 详细信息{sel === 4 ? <span style={{ color: C.primary }}>• 今天</span> : null}
        </div>

        {/* 农历大卡（sel 变化时内容翻动） */}
        <BigCard key={cardKey} sel={sel} info={info} pop={selChange || backChange} fps={fps} f={f} />
      </PageIn>
    </AbsoluteFill>
  );
};

const BigCard: React.FC<{ sel: number; info: { w: string; lunar: string; ganzhi: string }; pop: boolean; fps: number; f: number }> = ({
  sel,
  info,
  pop,
}) => {
  const s = spring({ frame: pop ? 2 : 0, fps: 30, config: { damping: 14, mass: 0.6 } });
  return (
    <div
      style={{
        margin: '22px 28px 0',
        background: '#ffffff',
        borderRadius: 28,
        padding: '30px 40px 36px',
        boxShadow: '0 4px 18px rgba(23,28,38,0.06)',
        opacity: 0.7 + s * 0.3,
        transform: `translateY(${(1 - s) * 24}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
        <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 800, color: C.ink }}>2026年</span>
        <span style={{ fontFamily: FONT, fontSize: 44, fontWeight: 900, color: C.ink }}>11月(大)</span>
        <span style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, color: C.primary, marginLeft: 'auto' }}>{info.w}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 190, fontWeight: 900, color: C.primary, lineHeight: 1.15, marginLeft: 60 }}>
        {sel}
      </div>
      <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 700, color: C.ink, marginLeft: 64 }}>农历 {info.lunar}</div>
      <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: C.ink3, marginLeft: 64, marginTop: 12 }}>{info.ganzhi}</div>
    </div>
  );
};

// ============ 牛马计薪器（可交互重建版）：数字实时进账 + 秒表走动 + 进度条增长 ============

const fmt = (v: number, dec = 2) => v.toFixed(dec);

export const SalaryApp: React.FC = () => {
  const f = useCurrentFrame();

  // 今日已赚：f30-130 从 0 滚到 178.61，之后每 40 帧 +0.01~0.03 微跳
  const base = interpolate(f, [30, 130], [0, 178.55], { easing: Easing.out(Easing.cubic), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const drip = Math.max(0, Math.floor((f - 130) / 40)) * 0.02;
  const earned = Math.min(178.61, base + drip);

  // 秒表：03:23:10 起每 30 帧 +1 秒（按帧率折算 1 秒 = 30 帧）
  const tick = Math.floor(Math.max(0, f - 20) / 30);
  const worked = 3 * 3600 + 23 * 60 + 10 + tick;
  const off = 3 * 3600 + 36 * 60 + 50 - tick;
  const wStr = `${String(Math.floor(worked / 3600)).padStart(2, '0')}:${String(Math.floor((worked % 3600) / 60)).padStart(2, '0')}:${String(worked % 60).padStart(2, '0')}`;
  const oStr = `${String(Math.floor(off / 3600)).padStart(2, '0')}:${String(Math.floor((off % 3600) / 60)).padStart(2, '0')}:${String(off % 60).padStart(2, '0')}`;

  // 进度条 0 → 48.4%
  const prog = interpolate(f, [40, 130], [0, 48.4], { easing: Easing.out(Easing.cubic), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // 寄语打字机
  const MOTTO = '加班的夜灯下，你是自己的英雄。别熬太狠，明天还有明天的活。🌙';
  const chars = Math.floor(interpolate(f, [160, 240], [0, MOTTO.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));

  return (
    <AbsoluteFill style={{ backgroundColor: '#eef2f7' }}>
      <PageIn>
        <div style={{ display: 'flex', alignItems: 'center', padding: '34px 40px 0', gap: 18 }}>
          <svg width={40} height={40} viewBox="0 0 24 24">
            <path d="M15 5 8 12l7 7" stroke="#1f2329" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.ink, flex: 1 }}>牛马计薪器</span>
        </div>

        {/* 今日已赚 */}
        <div style={{ margin: '26px 28px 0', background: 'linear-gradient(135deg, #1d7ef0 0%, #4d9bf5 100%)', borderRadius: 30, padding: '36px 40px', color: '#ffffff', boxShadow: '0 14px 36px rgba(29,126,240,0.32)' }}>
          <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, opacity: 0.9 }}>今日已赚</div>
          <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 10 }}>
            <span style={{ fontFamily: FONT, fontSize: 60, fontWeight: 800, marginRight: 6 }}>¥</span>
            <span style={{ fontFamily: MONO, fontSize: 108, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>{fmt(earned)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#3ee07f', boxShadow: '0 0 12px rgba(62,224,127,0.9)', opacity: 0.4 + 0.6 * Math.abs(Math.sin(f * 0.14)) }} />
            <span style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, opacity: 0.95 }}>工作中 · 实时计薪</span>
          </div>
        </div>

        {/* 时长双卡 */}
        <div style={{ display: 'flex', gap: 20, margin: '22px 28px 0' }}>
          {[
            { l: '已工作时长', v: wStr },
            { l: '距下班', v: oStr },
          ].map((it, i) => (
            <div key={it.l} style={{ flex: 1, background: '#ffffff', borderRadius: 26, padding: '26px 30px', boxShadow: '0 4px 18px rgba(23,28,38,0.06)' }}>
              <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink3 }}>{it.l}</div>
              <div style={{ fontFamily: MONO, fontSize: 52, fontWeight: 800, color: C.ink, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{it.v}</div>
            </div>
          ))}
        </div>

        {/* 进度条 */}
        <div style={{ margin: '22px 28px 0', background: '#ffffff', borderRadius: 26, padding: '26px 30px', boxShadow: '0 4px 18px rgba(23,28,38,0.06)' }}>
          <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: 700, color: C.ink2 }}>今日工作进度</div>
          <div style={{ marginTop: 16, height: 26, borderRadius: 999, background: '#eef0f4', overflow: 'hidden' }}>
            <div style={{ width: `${prog}%`, height: '100%', borderRadius: 999, background: `linear-gradient(90deg, #1d7ef0, #4d9bf5)` }} />
          </div>
          <div style={{ fontFamily: MONO, fontSize: 30, fontWeight: 800, color: C.primary, marginTop: 10, textAlign: 'right' }}>{prog.toFixed(1)}%</div>
        </div>

        {/* 日薪 / 时薪 */}
        <div style={{ display: 'flex', gap: 20, margin: '22px 28px 0' }}>
          {[
            { l: '日薪', v: '¥369.23' },
            { l: '时薪', v: '¥52.75' },
          ].map((it) => (
            <div key={it.l} style={{ flex: 1, background: '#ffffff', borderRadius: 26, padding: '22px 30px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', boxShadow: '0 4px 18px rgba(23,28,38,0.06)' }}>
              <span style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, color: C.ink3 }}>{it.l}</span>
              <span style={{ fontFamily: MONO, fontSize: 40, fontWeight: 800, color: C.ink }}>{it.v}</span>
            </div>
          ))}
        </div>

        {/* 发薪卡 */}
        <div style={{ margin: '22px 28px 0', background: '#ffffff', borderRadius: 26, padding: '24px 30px', display: 'flex', alignItems: 'center', boxShadow: '0 4px 18px rgba(23,28,38,0.06)' }}>
          <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, color: C.ink2, flex: 1 }}>每月 10 号发薪</div>
          <div style={{ fontFamily: FONT, fontSize: 27, fontWeight: 800, color: '#f59e0b' }}>下次发薪 11月10日 · 6天</div>
        </div>

        {/* 牛马寄语（打字机） */}
        <div style={{ margin: '22px 28px 0', background: '#fdf6e3', border: '2px solid #f3e2b6', borderRadius: 26, padding: '26px 30px' }}>
          <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 800, color: '#b8860b', marginBottom: 12 }}>🐮 牛马寄语</div>
          <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 600, color: '#7a6320', lineHeight: 1.5 }}>
            {MOTTO.slice(0, chars)}
            {chars < MOTTO.length && chars > 0 ? '▌' : ''}
          </div>
        </div>
      </PageIn>
    </AbsoluteFill>
  );
};

// ============ 计算器（可交互重建版）：逐键输入 566×965 = 546190 ============

const KEYS = [
  { k: 'C', red: true },
  { k: '⌫' },
  { k: '(' },
  { k: ')' },
  { k: '÷' },
  { k: 'x²' },
  { k: '√x' },
  { k: '1/x' },
  { k: '±' },
  { k: '×' },
  { k: '7' },
  { k: '8' },
  { k: '9' },
  { k: '%' },
  { k: '−' },
  { k: '4' },
  { k: '5' },
  { k: '6' },
  { k: '.' },
  { k: '+' },
  { k: '1' },
  { k: '2' },
  { k: '3' },
  { k: '0' },
  { k: '=', dark: true },
];

// 输入时间轴：每一步 = [按键索引, 按下帧]
const STEPS: { key: number; t: number }[] = [
  { key: 16, t: 50 }, // 5
  { key: 17, t: 76 }, // 6
  { key: 17, t: 102 }, // 6
  { key: 9, t: 128 }, // ×
  { key: 12, t: 154 }, // 9
  { key: 17, t: 180 }, // 6
  { key: 16, t: 206 }, // 5
  { key: 24, t: 232 }, // =
];

// display 内容随步骤推进
const displayFor = (f: number): string => {
  const seq = ['5', '56', '566', '566×', '566×9', '566×96', '566×965'];
  let s = '';
  let done = false;
  STEPS.forEach((st, i) => {
    if (f >= st.t + 8) {
      if (i < seq.length) s = seq[i];
      else done = true;
    }
  });
  if (f >= STEPS[7].t + 10) return done ? '546190' : s;
  return s;
};

export const CalcApp: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const expr = displayFor(f);
  const isResult = expr === '546190';
  const resS = spring({ frame: f - (STEPS[7].t + 8), fps, config: { damping: 13, mass: 0.7 } });

  // 当前按压的键
  const pressing = STEPS.find((st) => f >= st.t && f < st.t + 10);

  return (
    <AbsoluteFill>
      <LandscapeBg />
      <PageIn>
        <div style={{ display: 'flex', alignItems: 'center', padding: '30px 40px 0', gap: 18 }}>
          <svg width={40} height={40} viewBox="0 0 24 24">
            <path d="M15 5 8 12l7 7" stroke="#1f2329" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontFamily: FONT, fontSize: 38, fontWeight: 800, color: C.ink, flex: 1 }}>计算器</span>
        </div>

        {/* Tabs */}
        <div style={{ margin: '14px 28px 0', background: C.pill, borderRadius: 999, padding: 7, display: 'flex' }}>
          {['计算', '日期', '换算'].map((t, i) => (
            <div
              key={t}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '16px 0',
                borderRadius: 999,
                background: i === 0 ? C.dark : 'transparent',
                color: i === 0 ? '#ffffff' : C.ink2,
                fontFamily: FONT,
                fontSize: 30,
                fontWeight: i === 0 ? 700 : 500,
              }}
            >
              {t}
            </div>
          ))}
        </div>

        {/* display */}
        <div style={{ margin: '24px 40px 0', textAlign: 'right', minHeight: 170 }}>
          {!isResult && (
            <div style={{ fontFamily: MONO, fontSize: 68, fontWeight: 700, color: C.ink2, fontVariantNumeric: 'tabular-nums' }}>{expr}</div>
          )}
          {isResult && (
            <div
              style={{
                fontFamily: MONO,
                fontSize: 120,
                fontWeight: 900,
                color: C.ink,
                fontVariantNumeric: 'tabular-nums',
                transform: `scale(${0.7 + resS * 0.3})`,
                transformOrigin: 'right center',
                opacity: resS,
              }}
            >
              546190
            </div>
          )}
        </div>

        {/* 键盘 */}
        <div style={{ margin: '20px 26px 0', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14 }}>
          {KEYS.map((it, i) => {
            const pressingThis = pressing && pressing.key === i;
            const pressP = pressingThis ? interpolate(f, [pressing.t, pressing.t + 6, pressing.t + 10], [0, 1, 0], { extrapolateRight: 'clamp' }) : 0;
            return (
              <div
                key={i}
                style={{
                  height: 118,
                  borderRadius: 22,
                  background: it.red ? 'rgba(245,74,69,0.10)' : it.dark ? C.dark : '#ffffff',
                  color: it.red ? C.red : it.dark ? '#ffffff' : C.ink,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: FONT,
                  fontSize: 38,
                  fontWeight: 700,
                  boxShadow: '0 2px 10px rgba(23,28,38,0.05)',
                  border: '1px solid rgba(23,28,38,0.05)',
                  transform: `scale(${1 - pressP * 0.07})`,
                  outline: pressingThis ? `3px solid rgba(29,126,240,${0.4 + pressP * 0.5})` : 'none',
                  outlineOffset: -3,
                }}
              >
                {it.k}
              </div>
            );
          })}
        </div>

        {/* 说明文字 */}
        <div style={{ margin: '26px 40px 0', fontFamily: FONT, fontSize: 25, fontWeight: 500, color: C.ink3, lineHeight: 1.5 }}>
          支持四则运算、括号、小数与负数;% 按「相对于前一项的百分比」计算(如 200 + 10% = 220)。
        </div>
      </PageIn>
    </AbsoluteFill>
  );
};
