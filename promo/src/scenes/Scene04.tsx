import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../tokens';
import { Caption, FlashIn, FlashOut, PageHead, PanelHeader, Tabs, DateStrip, TaskCard, AddPill, CakeGlyph, Taskbar, DesktopBadge, DeskWaves } from '../components';

// 场景 4 日/周/月/记节日：Tab 依次切换 + 生日纪念日提醒
const PANEL_W = 660;
const PANEL_TOP = 420;
const PANEL_H = 1280;

// Tab 切换时间轴（帧）：日 0-88 / 周 88-152 / 月 152-218 / 节 218-300
const tabOf = (f: number) => (f < 88 ? 0 : f < 152 ? 1 : f < 218 ? 2 : 3);

// 生日 / 纪念日行卡
const PersonCard: React.FC<{
  name: string;
  tag: string;
  date: string;
  right: string;
  rightSub?: string;
  today?: boolean;
  avatar: string;
  delay: number;
}> = ({ name, tag, date, right, rightSub, today, avatar, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 15, mass: 0.7 } });
  const pulse = today ? 1 + 0.035 * Math.sin(f * 0.14) : 1;
  return (
    <div
      style={{
        background: today ? '#fff3f3' : '#ffffff',
        border: `2px solid ${today ? C.red : C.cardBorder}`,
        borderRadius: 18,
        padding: '20px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        opacity: s,
        transform: `translateY(${(1 - s) * 26}px) scale(${pulse})`,
      }}
    >
      <div
        style={{
          width: 66,
          height: 66,
          borderRadius: '50%',
          background: avatar,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width={36} height={36} viewBox="0 0 48 48" fill="none">
          <circle cx={24} cy={17} r={8} fill="#ffffff" opacity={0.9} />
          <path d="M8 41c2.6-8.2 8.6-12.5 16-12.5S37.4 32.8 40 41" fill="#ffffff" opacity={0.9} />
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: FONT, fontSize: 29, fontWeight: 700, color: C.ink }}>{name}</span>
          <span style={{ fontFamily: FONT, fontSize: 20, color: C.ink3, background: C.pill, borderRadius: 6, padding: '2px 10px' }}>{tag}</span>
          <CakeGlyph size={26} />
        </div>
        <div style={{ fontFamily: FONT, fontSize: 23, color: C.ink3, marginTop: 6 }}>{date}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 800, color: today ? C.red : C.ink }}>{right}</div>
        {rightSub && <div style={{ fontFamily: FONT, fontSize: 20, color: C.ink3, marginTop: 4 }}>{rightSub}</div>}
      </div>
    </div>
  );
};

export const Scene04: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tab = tabOf(f);

  const panelS = spring({ frame: Math.max(0, f - 2), fps, config: { damping: 16 } });

  // 各 tab 内容透明度（切换时 14 帧交叉淡入；本场景结尾不做淡出）
  const seg = (start: number) => ({
    opacity: interpolate(f, [start, start + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    transform: `translateY(${interpolate(f, [start, start + 14], [24, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
  });
  const dayStyle = {
    ...seg(-40),
    opacity: interpolate(f, [74, 88], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  };
  const festStyle = seg(218);

  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #dfeaf6 0%, #eef3f8 46%, #e4ebf2 100%)', fontFamily: FONT }}>
      <FlashIn />
      <DeskWaves />
      <Taskbar />
      <DesktopBadge />
      <PageHead title="日 / 周 / 月 · 记节日" sub="四种视图，安排得明明白白" />

      <div
        style={{
          position: 'absolute',
          left: (1080 - PANEL_W) / 2,
          top: PANEL_TOP,
          width: PANEL_W,
          height: PANEL_H,
          background: '#ffffff',
          borderRadius: 30,
          border: '1.5px solid #e6e9ed',
          boxShadow: '0 34px 90px rgba(31,54,90,0.14)',
          overflow: 'hidden',
          opacity: panelS,
          transform: `translateY(${(1 - panelS) * 50}px)`,
        }}
      >
        <PanelHeader scale={1.12} />
        <Tabs active={tab} scale={1.12} />

        {/* 日待办 */}
        <div style={{ position: 'absolute', top: 224, left: 0, right: 0, bottom: 0, ...dayStyle }}>
          <DateStrip active={2} scale={1.12} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '26px 34px 4px' }}>
            <span style={{ fontFamily: FONT, fontSize: 33, fontWeight: 800, color: C.ink }}>10月13日 周二</span>
            <span style={{ fontFamily: FONT, fontSize: 26, color: C.ink3 }}>3 项</span>
          </div>
          <div style={{ padding: '12px 28px 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <TaskCard title="整理季度 OKR 评审材料" time="10-13 17:30" badge="提醒" pinned scale={1.12} delay={16} />
            <TaskCard title="回复客户反馈邮件" scale={1.12} delay={26} />
            <TaskCard title="健身房 · 力量训练 45min" time="10-13 20:45" scale={1.12} delay={36} />
          </div>
        </div>

        {/* 周待办 */}
        <div style={{ position: 'absolute', top: 224, left: 0, right: 0, bottom: 0, ...(f >= 88 && f < 152 ? seg(88) : { opacity: 0 }) }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '30px 34px 4px' }}>
            <span style={{ fontFamily: FONT, fontSize: 33, fontWeight: 800, color: C.ink }}>10月13日 - 10月19日</span>
            <span style={{ fontFamily: FONT, fontSize: 26, color: C.ink3 }}>8 项</span>
          </div>
          <div style={{ padding: '14px 28px 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.ink3, padding: '4px 6px' }}>周一 · 3 项</div>
            <TaskCard title="提交产品周报" time="10-13 18:00" scale={1.12} delay={96} />
            <TaskCard title="设计评审会" time="10-13 14:00" badge="提醒" scale={1.12} delay={104} />
            <div style={{ fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.ink3, padding: '8px 6px 0' }}>周三 · 2 项</div>
            <TaskCard title="回访老客户" scale={1.12} delay={116} />
          </div>
        </div>

        {/* 月待办 */}
        <div style={{ position: 'absolute', top: 224, left: 0, right: 0, bottom: 0, ...(f >= 152 && f < 218 ? seg(152) : { opacity: 0 }) }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '30px 34px 4px' }}>
            <span style={{ fontFamily: FONT, fontSize: 33, fontWeight: 800, color: C.ink }}>10月</span>
            <span style={{ fontFamily: FONT, fontSize: 26, color: C.ink3 }}>12 项</span>
          </div>
          <div style={{ padding: '14px 28px 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.ink3, padding: '4px 6px' }}>10月20日 · 2 项</div>
            <TaskCard title="月度复盘会议" time="10-20 10:00" badge="提醒" scale={1.12} delay={160} />
            <div style={{ fontFamily: FONT, fontSize: 25, fontWeight: 700, color: C.ink3, padding: '8px 6px 0' }}>10月25日 · 3 项</div>
            <TaskCard title="版本发布清单核对" pinned scale={1.12} delay={170} />
            <TaskCard title="整理用户反馈" scale={1.12} delay={178} />
          </div>
        </div>

        {/* 记节日 */}
        <div style={{ position: 'absolute', top: 224, left: 0, right: 0, bottom: 0, ...festStyle }}>
          <div style={{ padding: '26px 34px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <CakeGlyph size={34} />
              <span style={{ fontFamily: FONT, fontSize: 31, fontWeight: 800, color: C.ink }}>生日</span>
              <span style={{ fontFamily: FONT, fontSize: 25, color: C.ink3 }}>3</span>
            </div>
            <div
              style={{
                marginTop: 14,
                background: C.pill,
                borderRadius: 12,
                padding: '12px 20px',
                fontFamily: FONT,
                fontSize: 24,
                color: C.ink2,
              }}
            >
              未来 30 天内有 2 个生日
            </div>
          </div>
          <div style={{ padding: '18px 28px 0', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <PersonCard name="闺蜜小雅" tag="好友" date="10 月 13 日 · 10/13 周二 · 公历" right="今天" today avatar="linear-gradient(135deg,#f9b8c4,#f28ca0)" delay={236} />
            <PersonCard name="妈妈" tag="家人" date="10 月 20 日 · 10/20 周二 · 公历" right="7 天后" rightSub="7 天" avatar="linear-gradient(135deg,#b9d9a8,#8fc47e)" delay={246} />
            <PersonCard name="爸爸" tag="家人" date="农历八月十五 · 9/15 周三 · 农历" right="11 个月后" rightSub="337 天" avatar="linear-gradient(135deg,#a8cfe0,#7ab3cc)" delay={256} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 6px 0' }}>
              <span style={{ fontFamily: FONT, fontSize: 31, fontWeight: 800, color: C.ink }}>纪念日</span>
              <span style={{ fontFamily: FONT, fontSize: 25, color: C.ink3 }}>1</span>
            </div>
            <PersonCard name="结婚纪念日" tag="家人" date="12 月 24 日 · 12/24 周四 · 公历" right="2 个月后" rightSub="72 天" avatar="linear-gradient(135deg,#e6c9f2,#c79fe0)" delay={266} />
          </div>
        </div>
        {/* 记节日底部：添加生日 / 添加纪念日（面板内底部） */}
        {f >= 226 && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 34,
              display: 'flex',
              justifyContent: 'center',
              gap: 22,
              opacity: interpolate(f, [226, 240], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            }}
          >
            <AddPill scale={0.9} delay={230} label="添加生日" />
            <AddPill scale={0.9} delay={238} label="添加纪念日" />
          </div>
        )}
      </div>

      <Caption text="日 / 周 / 月规划，条理清晰" delay={30} hide={216} bottom={120} />
      <Caption text="生日纪念日，一个都不忘" delay={228} bottom={120} />
      <FlashOut dur={300} />
    </AbsoluteFill>
  );
};
