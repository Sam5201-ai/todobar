import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, MONO } from '../tokens';
import { Caption, FlashIn, FlashOut, PageHead, Taskbar, DesktopBadge, DeskWaves } from '../components';

// 场景 5 计算器 + 牛马计薪器：按键敲出 200+10%=220 → 切到计薪器，钱数往上跳（万年历在片尾轮播展示真实截图）
const KEYS: string[][] = [
  ['C', '⌫', '(', ')', '÷'],
  ['x²', '√x', '1/x', '±', '×'],
  ['7', '8', '9', '%', '−'],
  ['4', '5', '6', '.', '+'],
  ['1', '2', '3', '0', '='],
];
const BLUE_KEYS = ['÷', '×', '−', '+'];

export const Scene05: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const calcS = spring({ frame: Math.max(0, f - 2), fps, config: { damping: 16 } });
  const calcOut = spring({ frame: Math.max(0, f - 126), fps, config: { damping: 16 } });
  const payS = spring({ frame: Math.max(0, f - 138), fps, config: { damping: 16 } });

  // 表达式与结果
  const exprSteps: [number, string][] = [
    [32, '2'],
    [44, '20'],
    [56, '200'],
    [70, '200+'],
    [82, '200+1'],
    [94, '200+10'],
    [106, '200+10%'],
  ];
  let expr = '';
  for (const [fr, t] of exprSteps) if (f >= fr) expr = t;
  const resultS = spring({ frame: Math.max(0, f - 114), fps, config: { damping: 11, mass: 0.6 } });
  const showResult = f >= 114;

  // 按键按压态
  const pressMap: Record<string, number> = {
    '2': f >= 26 && f < 34 ? 1 : 0,
    '0': (f >= 38 && f < 46) || (f >= 50 && f < 58) || (f >= 88 && f < 96) ? 1 : 0,
    '1': f >= 76 && f < 84 ? 1 : 0,
    '+': f >= 64 && f < 72 ? 1 : 0,
    '%': f >= 100 && f < 108 ? 1 : 0,
    '=': f >= 114 && f < 124 ? 1 : 0,
  };

  // ===== 牛马计薪器 =====
  // 今日已赚数字滚动
  const earned = interpolate(f, [148, 208], [0, 577.62], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const heroS = spring({ frame: Math.max(0, f - 142), fps, config: { damping: 15 } });
  const statsS = (d: number) => spring({ frame: Math.max(0, f - d), fps, config: { damping: 15, mass: 0.7 } });
  const progressP = interpolate(f, [218, 250], [0, 69.5], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const stag = (d: number) => ({
    opacity: statsS(d),
    transform: `translateY(${(1 - statsS(d)) * 24}px)`,
  });

  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #dfeaf6 0%, #eef3f8 46%, #e4ebf2 100%)', fontFamily: FONT }}>
      <FlashIn />
      <DeskWaves />
      <Taskbar />
      <DesktopBadge />
      <PageHead title="计算器 · 牛马计薪器" sub="好用的工具，都藏在侧栏里" />

      {/* 计算器卡片 */}
      <div
        style={{
          position: 'absolute',
          left: 220,
          top: 430,
          width: 640,
          height: 1160,
          background: '#ffffff',
          borderRadius: 30,
          border: '1.5px solid #e6e9ed',
          boxShadow: '0 34px 90px rgba(31,54,90,0.14)',
          overflow: 'hidden',
          opacity: calcS * (1 - calcOut),
          transform: `translateY(${(1 - calcS) * 50 - calcOut * 80}px)`,
        }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '30px 34px 8px' }}>
          <svg width={36} height={36} viewBox="0 0 24 24">
            <path d="M15 5 8 12l7 7" stroke={C.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontFamily: FONT, fontSize: 40, fontWeight: 800, color: C.ink }}>计算器</span>
        </div>
        {/* 分段 tab */}
        <div style={{ margin: '14px 30px 0', background: C.pill, borderRadius: 999, padding: 7, display: 'flex' }}>
          {['计算', '日期', '换算'].map((t, i) => (
            <div
              key={t}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '15px 0',
                borderRadius: 999,
                background: i === 0 ? C.dark : 'transparent',
                color: i === 0 ? '#ffffff' : C.ink2,
                fontFamily: FONT,
                fontSize: 28,
                fontWeight: i === 0 ? 700 : 500,
              }}
            >
              {t}
            </div>
          ))}
        </div>
        {/* 显示区 */}
        <div
          style={{
            margin: '24px 30px 0',
            background: C.bg,
            borderRadius: 18,
            padding: '20px 28px',
            textAlign: 'right',
            minHeight: 150,
            boxSizing: 'border-box',
            boxShadow: showResult ? '0 0 0 3px rgba(29,126,240,0.25)' : 'none',
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 34, color: C.ink3, height: 44 }}>{expr || '0'}</div>
          <div style={{ fontFamily: MONO, fontSize: 76, fontWeight: 800, color: C.ink, lineHeight: 1.15 }}>
            {showResult ? (
              <span style={{ display: 'inline-block', transform: `scale(${0.7 + resultS * 0.3})`, color: C.primary }}>220</span>
            ) : (
              '0'
            )}
          </div>
        </div>
        {/* 键盘 */}
        <div style={{ margin: '24px 30px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {KEYS.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 14 }}>
              {row.map((k) => {
                const pressed = pressMap[k] === 1;
                const isEq = k === '=';
                const isC = k === 'C';
                const isOp = BLUE_KEYS.includes(k);
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      height: 96,
                      borderRadius: 16,
                      background: isEq ? C.dark : pressed ? '#e8ebef' : '#ffffff',
                      border: '1.5px solid #e6e9ed',
                      boxShadow: pressed ? 'inset 0 3px 8px rgba(26,22,38,0.10)' : '0 3px 0 #e2e5ea',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: FONT,
                      fontSize: 40,
                      fontWeight: 700,
                      color: isC ? C.red : isEq ? '#ffffff' : isOp ? C.primary : C.ink,
                      transform: pressed ? 'translateY(3px)' : 'none',
                    }}
                  >
                    {k}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* 牛马计薪器卡片 */}
      <div
        style={{
          position: 'absolute',
          left: 220,
          top: 430,
          width: 640,
          height: 1160,
          borderRadius: 30,
          border: '1.5px solid #dbe7f5',
          boxShadow: '0 34px 90px rgba(31,54,90,0.14)',
          overflow: 'hidden',
          opacity: payS,
          transform: `translateY(${(1 - payS) * 90}px)`,
          background: 'linear-gradient(180deg,#e8f2fd 0%,#f4f9ff 46%,#eef5fc 100%)',
        }}
      >
        {/* 城市天际线剪影 */}
        <svg style={{ position: 'absolute', bottom: 0, left: 0 }} width={640} height={220} viewBox="0 0 640 220" fill="none">
          <g fill="#b9d0e8" opacity={0.5}>
            <rect x={20} y={110} width={54} height={110} rx={4} />
            <rect x={86} y={70} width={40} height={150} rx={4} />
            <rect x={138} y={130} width={64} height={90} rx={4} />
            <rect x={214} y={90} width={34} height={130} rx={4} />
            <rect x={258} y={140} width={70} height={80} rx={4} />
            <rect x={340} y={60} width={46} height={160} rx={4} />
            <rect x={398} y={120} width={58} height={100} rx={4} />
            <rect x={470} y={84} width={38} height={136} rx={4} />
            <rect x={520} y={128} width={66} height={92} rx={4} />
            <rect x={598} y={100} width={30} height={120} rx={4} />
          </g>
          <g fill="#a8c4e0" opacity={0.45}>
            <rect x={0} y={168} width={640} height={52} />
          </g>
        </svg>

        <div style={{ position: 'relative', padding: '30px 34px 0' }}>
          {/* 头部 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <svg width={36} height={36} viewBox="0 0 24 24">
              <path d="M15 5 8 12l7 7" stroke={C.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span style={{ fontFamily: FONT, fontSize: 40, fontWeight: 800, color: C.ink }}>牛马计薪器</span>
          </div>

          {/* 今日已赚（数字滚动） */}
          <div
            style={{
              marginTop: 24,
              background: '#ffffff',
              borderRadius: 20,
              border: '1.5px solid #e6e9ed',
              padding: '26px 24px 22px',
              textAlign: 'center',
              opacity: heroS,
              transform: `translateY(${(1 - heroS) * 30}px)`,
              boxShadow: '0 14px 40px rgba(29,126,240,0.10)',
            }}
          >
            <div style={{ fontFamily: FONT, fontSize: 27, color: C.ink3, fontWeight: 600 }}>今日已赚</div>
            <div style={{ fontFamily: MONO, fontSize: 88, fontWeight: 800, color: C.ink, lineHeight: 1.25, letterSpacing: -1 }}>
              ¥{earned.toFixed(2)}
            </div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 6,
                background: 'rgba(29,126,240,0.10)',
                border: '1.5px solid rgba(29,126,240,0.25)',
                borderRadius: 999,
                padding: '8px 24px',
                fontFamily: FONT,
                fontSize: 24,
                fontWeight: 700,
                color: C.primary,
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: f % 20 < 10 ? C.primary : '#b8d4f7' }} />
              工作中 · 实时计薪
            </div>
          </div>

          {/* 已工作 / 距下班 */}
          <div style={{ marginTop: 18, display: 'flex', gap: 16 }}>
            {[
              { l: '已工作时长', v: '04:52:01', d: 210 },
              { l: '距下班', v: '02:07:59', d: 218 },
            ].map((it) => (
              <div
                key={it.l}
                style={{
                  flex: 1,
                  background: '#ffffff',
                  borderRadius: 16,
                  border: '1.5px solid #e6e9ed',
                  padding: '18px 22px',
                  ...stag(it.d),
                }}
              >
                <div style={{ fontFamily: FONT, fontSize: 23, color: C.ink3 }}>{it.l}</div>
                <div style={{ fontFamily: MONO, fontSize: 38, fontWeight: 800, color: C.ink, marginTop: 4 }}>{it.v}</div>
              </div>
            ))}
          </div>

          {/* 今日工作进度 */}
          <div style={{ marginTop: 20, ...stag(226) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: FONT, fontSize: 24, color: C.ink2 }}>今日工作进度</span>
              <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 800, color: C.primary }}>{progressP.toFixed(1)}%</span>
            </div>
            <div style={{ marginTop: 10, height: 16, borderRadius: 999, background: '#dde6f0', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progressP}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: `linear-gradient(90deg, ${C.primary}, ${C.primaryLight})`,
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
              <span style={{ fontFamily: FONT, fontSize: 24, color: C.ink3 }}>
                日薪 <span style={{ fontFamily: MONO, fontWeight: 700, color: C.ink2 }}>¥830.77</span>
              </span>
              <span style={{ fontFamily: FONT, fontSize: 24, color: C.ink3 }}>
                时薪 <span style={{ fontFamily: MONO, fontWeight: 700, color: C.ink2 }}>¥118.68</span>
              </span>
            </div>
          </div>

          {/* 本周 / 本月 */}
          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { l: '本周已赚', v: '¥1,408.38', d: 252 },
              { l: '本月已赚', v: '¥11,377.62', d: 258 },
            ].map((it) => (
              <div
                key={it.l}
                style={{
                  background: '#ffffff',
                  borderRadius: 14,
                  border: '1.5px solid #e6e9ed',
                  padding: '16px 22px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  ...stag(it.d),
                }}
              >
                <span style={{ fontFamily: FONT, fontSize: 25, color: C.ink2 }}>{it.l}</span>
                <span style={{ fontFamily: MONO, fontSize: 28, fontWeight: 800, color: C.ink }}>{it.v}</span>
              </div>
            ))}
          </div>

          {/* 发薪日 */}
          <div
            style={{
              marginTop: 16,
              background: '#ffffff',
              borderRadius: 14,
              border: '1.5px solid #e6e9ed',
              padding: '16px 22px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              ...stag(264),
            }}
          >
            <div>
              <div style={{ fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.ink }}>每月 10 号发薪</div>
              <div style={{ fontFamily: FONT, fontSize: 21, color: C.ink3, marginTop: 4 }}>下次发薪 11月10日</div>
            </div>
            <span style={{ fontFamily: FONT, fontSize: 36, fontWeight: 800, color: C.accent }}>21 天</span>
          </div>

          {/* 牛马寄语 */}
          <div
            style={{
              marginTop: 16,
              background: '#fff7e8',
              border: '1.5px solid #f0dfb8',
              borderRadius: 14,
              padding: '18px 24px',
              ...stag(272),
            }}
          >
            <div style={{ fontFamily: FONT, fontSize: 23, fontWeight: 800, color: C.accent, letterSpacing: 2 }}>牛马寄语 ——</div>
            <div style={{ fontFamily: FONT, fontSize: 26, color: C.ink2, lineHeight: 1.55, marginTop: 8 }}>
              加班一时爽，一直加班一直爽，爽到体检报告来回横跳。
            </div>
          </div>
        </div>
      </div>

      <Caption text="计算器 · 顺手就来" delay={22} hide={132} bottom={120} />
      <Caption text="牛马计薪器 · 打工人狂喜" delay={146} bottom={120} />
      <FlashOut dur={300} />
    </AbsoluteFill>
  );
};
