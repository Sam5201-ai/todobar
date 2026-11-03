import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from './tokens';

// ============ 转场 ============

// 场景开头白场淡出（承接上一场景的白闪转场）
export const FlashIn: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [0, 10], [1, 0], { easing: Easing.out(Easing.quad), extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity, zIndex: 99, pointerEvents: 'none' }} />;
};

// 场景结尾淡入白场（交给下一场景）；dur = 本场景总帧数
export const FlashOut: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [dur - 8, dur - 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity, zIndex: 99, pointerEvents: 'none' }} />;
};

// 页面顶部洗染（浅色功能页头部氛围）
export const Wash: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 760,
      background: `linear-gradient(180deg, ${C.wash} 0%, rgba(227,239,252,0.4) 46%, rgba(246,247,249,0) 100%)`,
    }}
  />
);

// 底部字幕胶囊（hide = 开始淡出的帧号，用于字幕切换）
export const Caption: React.FC<{ text: string; delay?: number; dark?: boolean; bottom?: number; hide?: number }> = ({
  text,
  delay = 18,
  dark = false,
  bottom = 150,
  hide,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 14, mass: 0.7 } });
  const hideFactor = hide === undefined ? 1 : interpolate(f, [hide, hide + 12], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const skin: React.CSSProperties = dark
    ? { background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)', color: '#ffffff' }
    : { background: 'rgba(255,255,255,0.92)', border: `1px solid ${C.border}`, color: C.ink2 };
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: bottom, pointerEvents: 'none' }}>
      <div
        style={{
          ...skin,
          transform: `translateY(${(1 - s) * 44}px) scale(${0.95 + s * 0.05})`,
          opacity: s * hideFactor,
          borderRadius: 999,
          padding: '22px 56px',
          fontFamily: FONT,
          fontSize: 40,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          boxShadow: '0 12px 40px rgba(26,22,38,0.12)',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

// 功能页大标题
export const PageHead: React.FC<{ title: string; sub: string }> = ({ title, sub }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - 4), fps, config: { damping: 16 } });
  return (
    <div style={{ position: 'absolute', top: 88, left: 64, opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>
      <div style={{ fontFamily: FONT, fontSize: 92, fontWeight: 900, color: C.ink, letterSpacing: 2 }}>{title}</div>
      <div style={{ fontFamily: FONT, fontSize: 32, color: C.ink3, marginTop: 10, fontWeight: 500 }}>{sub}</div>
    </div>
  );
};

// ============ 品牌元素 ============

// LOGO：圆角方形（public/logo.png，应用图标）
export const Logo: React.FC<{ size: number; shadow?: boolean }> = ({ size, shadow = true }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.24,
      overflow: 'hidden',
      boxShadow: shadow ? `0 ${size * 0.12}px ${size * 0.32}px rgba(29,126,240,0.32)` : 'none',
    }}
  >
    <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
);

// 面板头部小 logo 缩略图
export const LogoThumb: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.26, overflow: 'hidden' }}>
    <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
);

// ============ 面板 UI 原子（对照 release/screenshots/home-light.png 重建） ============

// 头部右侧四个功能图标
export const HeadIcons: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const color = dark ? '#b8bcc4' : C.ink3;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
      {/* 计算器 */}
      <svg width={38} height={38} viewBox="0 0 48 48" fill="none">
        <rect x={10} y={6} width={28} height={36} rx={6} stroke={color} strokeWidth={3.4} />
        <rect x={15} y={11} width={18} height={8} rx={2} fill={color} opacity={0.55} />
        <circle cx={17.5} cy={27} r={2.4} fill={color} />
        <circle cx={24} cy={27} r={2.4} fill={color} />
        <circle cx={30.5} cy={27} r={2.4} fill={color} />
        <circle cx={17.5} cy={35} r={2.4} fill={color} />
        <circle cx={24} cy={35} r={2.4} fill={color} />
        <circle cx={30.5} cy={35} r={2.4} fill={color} />
      </svg>
      {/* 万年历（书本） */}
      <svg width={38} height={38} viewBox="0 0 48 48" fill="none">
        <path d="M24 12c-3-2.6-7.5-3.4-13-3v27c5.5-.4 10 .4 13 3 3-2.6 7.5-3.4 13-3V9c-5.5-.4-10 .4-13 3Z" stroke={color} strokeWidth={3.2} strokeLinejoin="round" />
        <path d="M24 12v27" stroke={color} strokeWidth={3.2} strokeLinecap="round" />
      </svg>
      {/* 同步 */}
      <svg width={38} height={38} viewBox="0 0 48 48" fill="none">
        <path d="M38 20a14 14 0 0 0-25-5" stroke={color} strokeWidth={3.4} strokeLinecap="round" />
        <path d="M13 8v8h8" stroke={color} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 28a14 14 0 0 0 25 5" stroke={color} strokeWidth={3.4} strokeLinecap="round" />
        <path d="M35 40v-8h-8" stroke={color} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* 设置 */}
      <svg width={38} height={38} viewBox="0 0 48 48" fill="none">
        <circle cx={24} cy={24} r={7} stroke={color} strokeWidth={3.2} />
        <path
          d="M24 6.5 27 12l6.3-1.6 1.2 6.4 6 2.7-3 5.5 3 5.5-6 2.7-1.2 6.4L27 36l-3 5.5L21 36l-6.3 1.6-1.2-6.4-6-2.7 3-5.5-3-5.5 6-2.7 1.2-6.4L21 12l3-5.5Z"
          stroke={color}
          strokeWidth={3}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

// 面板顶部栏：logo + Tacco + 四图标
export const PanelHeader: React.FC<{ dark?: boolean; scale?: number }> = ({ dark, scale = 1 }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: `${26 * scale}px ${30 * scale}px ${18 * scale}px`,
      gap: 16 * scale,
    }}
  >
    <LogoThumb size={52 * scale} />
    <div
      style={{
        fontFamily: FONT,
        fontSize: 34 * scale,
        fontWeight: 800,
        color: dark ? '#f2f3f5' : C.ink,
        flex: 1,
        letterSpacing: 0.5,
      }}
    >
      Tacco
    </div>
    <HeadIcons dark={dark} />
  </div>
);

// 分类 Tab：日待办 / 周待办 / 月待办 / 记节日，active 为近黑胶囊
export const Tabs: React.FC<{ active: number; dark?: boolean; scale?: number }> = ({ active, dark, scale = 1 }) => {
  const labels = ['日待办', '周待办', '月待办', '记节日'];
  return (
    <div
      style={{
        margin: `${8 * scale}px ${26 * scale}px 0`,
        background: dark ? 'rgba(255,255,255,0.08)' : C.pill,
        borderRadius: 999,
        padding: 6 * scale,
        display: 'flex',
        position: 'relative',
      }}
    >
      {labels.map((lb, i) => {
        const on = i === active;
        return (
          <div
            key={lb}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: `${14 * scale}px 0`,
              borderRadius: 999,
              background: on ? (dark ? '#f2f3f5' : C.dark) : 'transparent',
              color: on ? (dark ? '#17181a' : '#ffffff') : dark ? '#9aa0a8' : C.ink2,
              fontFamily: FONT,
              fontSize: 27 * scale,
              fontWeight: on ? 700 : 500,
              position: 'relative',
              zIndex: 2,
            }}
          >
            {lb}
          </div>
        );
      })}
    </div>
  );
};

// 日期条：五张日期卡，active 为近黑卡 + 红点
export const DateStrip: React.FC<{ active: number; dark?: boolean; scale?: number }> = ({ active, dark, scale = 1 }) => {
  const days = [
    { d: '10/11', w: '周日', dot: false },
    { d: '10/12', w: '周一', dot: false },
    { d: '10/13', w: '今天', dot: true },
    { d: '10/14', w: '周二', dot: true },
    { d: '10/15', w: '周三', dot: false },
  ];
  return (
    <div style={{ display: 'flex', gap: 10 * scale, padding: `${20 * scale}px ${26 * scale}px 0` }}>
      {days.map((it, i) => {
        const on = i === active;
        return (
          <div
            key={it.d}
            style={{
              flex: 1,
              borderRadius: 16 * scale,
              padding: `${12 * scale}px 0 ${10 * scale}px`,
              textAlign: 'center',
              background: on ? (dark ? '#f2f3f5' : C.dark) : dark ? 'rgba(255,255,255,0.08)' : C.pill,
              position: 'relative',
            }}
          >
            <div
              style={{
                fontFamily: FONT,
                fontSize: 25 * scale,
                fontWeight: on ? 800 : 600,
                color: on ? (dark ? '#17181a' : '#ffffff') : dark ? '#c9cdd4' : C.ink2,
              }}
            >
              {it.d}
            </div>
            <div
              style={{
                fontFamily: FONT,
                fontSize: 20 * scale,
                color: on ? (dark ? '#4e5560' : '#b8bcc4') : dark ? '#7a7f88' : C.ink3,
                marginTop: 2 * scale,
              }}
            >
              {it.w}
            </div>
            {it.dot && (
              <div
                style={{
                  width: 9 * scale,
                  height: 9 * scale,
                  borderRadius: '50%',
                  background: C.red,
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 6 * scale,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// 提醒小图标（蛋糕）
export const CakeGlyph: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <path d="M12 22h24v18H12V22Z" fill="#f59e0b" opacity={0.25} />
    <path d="M12 22h24v18H12V22Z" stroke="#f59e0b" strokeWidth={3} strokeLinejoin="round" />
    <path d="M24 12v6" stroke="#f59e0b" strokeWidth={3.4} strokeLinecap="round" />
    <path d="M24 6c1.8 2 1.8 4-0 5.4" stroke="#f59e0b" strokeWidth={3} strokeLinecap="round" fill="none" />
    <path d="M12 28c4 3 8-2 12 1s8-2 12 1" stroke="#f59e0b" strokeWidth={2.6} strokeLinecap="round" fill="none" />
  </svg>
);

// 任务卡：圆圈勾选 + 标题 + 可选提醒行 / 徽章
// checkAt = 勾选动画发生的帧号（未传则不勾选；传入即按该帧播放勾选 + 删除线扫过）
export const TaskCard: React.FC<{
  title: string;
  time?: string;
  badge?: string;
  pinned?: boolean;
  checkAt?: number;
  dark?: boolean;
  scale?: number;
  delay?: number;
}> = ({ title, time, badge, pinned, checkAt, dark, scale = 1, delay = 0 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 16, mass: 0.7 } });
  const checked = checkAt !== undefined && f >= checkAt;
  const checkPop = checked
    ? 1 + 0.18 * Math.max(0, 1 - (f - checkAt) / 8) * Math.sin(((f - checkAt) / 8) * Math.PI)
    : 1;
  const strike =
    checkAt !== undefined
      ? interpolate(f, [checkAt + 6, checkAt + 18], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : 0;
  return (
    <div
      style={{
        background: dark ? C.darkCard : '#ffffff',
        border: `1.5px solid ${dark ? 'rgba(255,255,255,0.07)' : C.cardBorder}`,
        borderRadius: 18 * scale,
        padding: `${20 * scale}px ${22 * scale}px`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16 * scale,
        opacity: s,
        transform: `translateY(${(1 - s) * 26 * scale}px)`,
      }}
    >
      {/* 勾选圈 */}
      <div
        style={{
          width: 34 * scale,
          height: 34 * scale,
          borderRadius: '50%',
          border: `3px solid ${checked ? C.primary : dark ? '#4a4e57' : '#d0d4d9'}`,
          background: checked ? C.primary : 'transparent',
          marginTop: 4 * scale,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${checkPop})`,
        }}
      >
        {checked && (
          <svg width={18 * scale} height={18 * scale} viewBox="0 0 24 24">
            <path d="M4.5 12.5 10 18 19.5 7" stroke="#ffffff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 * scale }}>
          <span
            style={{
              fontFamily: FONT,
              fontSize: 29 * scale,
              fontWeight: 600,
              color: checked ? C.ink3 : dark ? '#e8eaed' : C.ink,
              position: 'relative',
            }}
          >
            {title}
            {checked && (
              <span
                style={{
                  position: 'absolute',
                  left: '-2%',
                  top: '55%',
                  width: `${strike}%`,
                  height: 3 * scale,
                  background: C.ink3,
                  borderRadius: 3,
                }}
              />
            )}
          </span>
          {pinned && (
            <span
              style={{
                fontFamily: FONT,
                fontSize: 20 * scale,
                fontWeight: 700,
                color: '#ffffff',
                background: C.red,
                borderRadius: 7 * scale,
                padding: `${3 * scale}px ${10 * scale}px`,
                flexShrink: 0,
              }}
            >
              置顶
            </span>
          )}
        </div>
        {time && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 * scale, marginTop: 8 * scale }}>
            <CakeGlyph size={24 * scale} />
            <span style={{ fontFamily: FONT, fontSize: 23 * scale, color: dark ? '#9aa0a8' : C.ink3 }}>{time}</span>
            {badge && (
              <span
                style={{
                  fontFamily: FONT,
                  fontSize: 19 * scale,
                  fontWeight: 700,
                  color: '#ffffff',
                  background: C.red,
                  borderRadius: 6 * scale,
                  padding: `${2 * scale}px ${9 * scale}px`,
                }}
              >
                {badge}
              </span>
            )}
          </div>
        )}
      </div>
      {/* 右侧 + / 设置 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 * scale, marginTop: 6 * scale }}>
        <svg width={26 * scale} height={26 * scale} viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" stroke={dark ? '#7a7f88' : C.ink3} strokeWidth={2.6} strokeLinecap="round" />
        </svg>
        <svg width={26 * scale} height={26 * scale} viewBox="0 0 24 24" fill="none">
          <circle cx={12} cy={12} r={3.2} stroke={dark ? '#7a7f88' : C.ink3} strokeWidth={2.2} />
          <path
            d="M12 3.5 13.4 6l2.8-.7.5 2.9 2.7 1.2-1.4 2.6 1.4 2.6-2.7 1.2-.5 2.9-2.8-.7L12 20.5 10.6 18l-2.8.7-.5-2.9-2.7-1.2 1.4-2.6-1.4-2.6 2.7-1.2.5-2.9 2.8.7L12 3.5Z"
            stroke={dark ? '#7a7f88' : C.ink3}
            strokeWidth={1.8}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
};

// 底部黑色胶囊按钮「+ 添加事项」
export const AddPill: React.FC<{ dark?: boolean; scale?: number; label?: string; delay?: number }> = ({
  dark,
  scale = 1,
  label = '添加事项',
  delay = 8,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 13, mass: 0.7 } });
  return (
    <div
      style={{
        margin: `${24 * scale}px auto 0`,
        width: 'fit-content',
        display: 'flex',
        alignItems: 'center',
        gap: 12 * scale,
        background: dark ? '#f2f3f5' : C.dark,
        color: dark ? '#17181a' : '#ffffff',
        borderRadius: 999,
        padding: `${20 * scale}px ${56 * scale}px`,
        fontFamily: FONT,
        fontSize: 29 * scale,
        fontWeight: 700,
        opacity: s,
        transform: `translateY(${(1 - s) * 24 * scale}px)`,
      }}
    >
      <svg width={26 * scale} height={26 * scale} viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </svg>
      {label}
    </div>
  );
};

// 键帽（快捷键演示）
export const KeyCap: React.FC<{ label: string; size?: number; pressed?: boolean; delay?: number }> = ({
  label,
  size = 150,
  pressed,
  delay = 0,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 12, mass: 0.6 } });
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.14,
        background: '#ffffff',
        border: '2px solid #e2e5ea',
        boxShadow: pressed
          ? `0 3px 0 #c9cdd4, 0 0 0 6px rgba(29,126,240,0.18), 0 0 34px rgba(29,126,240,0.45)`
          : `0 ${size * 0.07}px 0 #d4d8de, 0 ${size * 0.14}px ${size * 0.28}px rgba(26,22,38,0.14)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        fontSize: size * 0.32,
        fontWeight: 800,
        color: C.ink,
        transform: `scale(${0.5 + s * 0.5}) translateY(${pressed ? size * 0.05 : 0}px)`,
        opacity: s,
      }}
    >
      {label}
    </div>
  );
};

// ============ 桌面语境元素（强化「电脑桌面端」概念） ============

// Windows 四方块图标
export const WinGlyph: React.FC<{ size?: number; color?: string }> = ({ size = 26, color = '#3b8de0' }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect x={5} y={5} width={17} height={17} rx={2} fill={color} />
    <rect x={26} y={5} width={17} height={17} rx={2} fill={color} opacity={0.72} />
    <rect x={5} y={26} width={17} height={17} rx={2} fill={color} opacity={0.72} />
    <rect x={26} y={26} width={17} height={17} rx={2} fill={color} opacity={0.48} />
  </svg>
);

// Windows 任务栏（Win11 风格）：开始 + 应用图标，Tacco 高亮运行中，右侧时钟
export const Taskbar: React.FC = () => {
  const icon = (node: React.ReactNode, key: string, running = false) => (
    <div key={key} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {node}
      {running && (
        <span
          style={{
            position: 'absolute',
            bottom: -10,
            width: 22,
            height: 4,
            borderRadius: 4,
            background: '#6cb8f5',
          }}
        />
      )}
    </div>
  );
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 72,
        background: 'rgba(18,23,31,0.95)',
        borderTop: '1px solid rgba(255,255,255,0.09)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        zIndex: 50,
      }}
    >
      {icon(
        <svg width={28} height={28} viewBox="0 0 48 48" fill="none">
          <rect x={5} y={5} width={17} height={17} rx={2} fill="#58b6f0" />
          <rect x={26} y={5} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.75} />
          <rect x={5} y={26} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.75} />
          <rect x={26} y={26} width={17} height={17} rx={2} fill="#58b6f0" opacity={0.5} />
        </svg>,
        'start',
      )}
      {icon(
        <svg width={30} height={30} viewBox="0 0 48 48" fill="none">
          <circle cx={24} cy={24} r={17} stroke="#98a2ae" strokeWidth={3} />
          <ellipse cx={24} cy={24} rx={8} ry={17} stroke="#98a2ae" strokeWidth={3} />
          <path d="M7.5 19h33M7.5 29h33" stroke="#98a2ae" strokeWidth={3} />
        </svg>,
        'browser',
      )}
      {icon(
        <svg width={30} height={30} viewBox="0 0 48 48" fill="none">
          <path d="M6 12a4 4 0 0 1 4-4h10l5 6h13a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V12Z" fill="#8f9aa8" opacity={0.9} />
        </svg>,
        'folder',
      )}
      {/* Tacco 运行中 */}
      {icon(
        <div style={{ width: 38, height: 38, borderRadius: 9, overflow: 'hidden', boxShadow: '0 0 0 2px rgba(108,184,245,0.65), 0 0 18px rgba(29,126,240,0.5)' }}>
          <Img src={staticFile('logo.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>,
        'todobar',
        true,
      )}
      {icon(
        <svg width={28} height={28} viewBox="0 0 48 48" fill="none">
          <circle cx={24} cy={24} r={7} stroke="#98a2ae" strokeWidth={3.2} />
          <path
            d="M24 6.5 27 12l6.3-1.6 1.2 6.4 6 2.7-3 5.5 3 5.5-6 2.7-1.2 6.4L27 36l-3 5.5L21 36l-6.3 1.6-1.2-6.4-6-2.7 3-5.5-3-5.5 6-2.7 1.2-6.4L21 12l3-5.5Z"
            stroke="#98a2ae"
            strokeWidth={3}
            strokeLinejoin="round"
          />
        </svg>,
        'settings',
      )}
      {/* 时钟 */}
      <div style={{ position: 'absolute', right: 44, textAlign: 'right', lineHeight: 1.3 }}>
        <div style={{ fontFamily: FONT, fontSize: 21, fontWeight: 600, color: '#dfe4ea' }}>17:30</div>
        <div style={{ fontFamily: FONT, fontSize: 15, color: '#8a929e' }}>2026/10/13 周二</div>
      </div>
    </div>
  );
};

// 「Windows 电脑桌面端」浮动徽章（功能页右上角）
export const DesktopBadge: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - 16), fps, config: { damping: 14 } });
  return (
    <div
      style={{
        position: 'absolute',
        top: 236,
        right: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: '#ffffff',
        border: '1.5px solid #e2e6ec',
        borderRadius: 999,
        padding: '13px 28px',
        boxShadow: '0 12px 34px rgba(31,54,90,0.12)',
        zIndex: 5,
        opacity: s,
        transform: `translateY(${(1 - s) * 26}px)`,
      }}
    >
      <WinGlyph size={28} />
      <span style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: C.ink2 }}>Windows 电脑桌面端</span>
    </div>
  );
};

// 桌面壁纸波浪（放在任务栏上方）
export const DeskWaves: React.FC = () => (
  <svg style={{ position: 'absolute', bottom: 72, left: 0 }} width={1080} height={320} viewBox="0 0 1080 320" fill="none">
    <path d="M0 160 C 190 70 340 115 520 168 C 700 220 880 155 1080 95 V320 H0 Z" fill="#c7d6e5" opacity={0.5} />
    <path d="M0 245 C 230 158 430 198 640 238 C 830 274 980 226 1080 175 V320 H0 Z" fill="#b0c4d8" opacity={0.55} />
  </svg>
);

// 对勾徽章
export const CheckBadge: React.FC<{ size: number; delay?: number }> = ({ size, delay = 0 }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.max(0, f - delay), fps, config: { damping: 11, mass: 0.6 } });
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: C.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 10px 30px rgba(29,126,240,0.4)',
        transform: `scale(${s})`,
      }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24">
        <path d="M4.5 12.5 10 18 19.5 7" stroke="#ffffff" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
};
