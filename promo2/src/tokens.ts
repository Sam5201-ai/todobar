// Tacco 品牌色板 —— 从 release/index.html（tailwind 主题）与真实界面截图提取
export const C = {
  primary: '#1d7ef0', // 主色（logo 蓝 / 选中 / 链接）
  primaryLight: '#3d97f5',
  primaryDark: '#1565c8',
  accent: '#f59e0b', // 品牌琥珀
  gradient: 'linear-gradient(135deg, #1d7ef0 0%, #3d97f5 60%, #f59e0b 150%)',
  bg: '#f6f7f9', // 应用浅色底
  wash: '#e3effc', // 顶部洗染（淡蓝）
  washSoft: '#f0f6fe',
  ink: '#1f2329', // 主文字
  ink2: '#4e5560', // 次级文字
  ink3: '#9aa0a8', // 辅助文字
  border: '#e8eaee', // 常规边框
  cardBorder: '#eef0f3', // 卡片边框
  cardBg: '#ffffff',
  pill: '#f1f2f4', // tab 容器浅灰
  dark: '#17181a', // 近黑（选中 pill / FAB）
  red: '#f54a45', // 提醒 / 置顶 / 今天
  green: '#22a45d', // 万年历绿
  darkBg: '#1e2126', // 深色模式底
  darkCard: '#2a2d33', // 深色模式卡片
} as const;

export const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
export const MONO = 'Consolas, "Cascadia Code", monospace';

// 各场景时长（帧，30fps）。与 Root.tsx 的 SCENES 数组一一对应。
// 十一段：封面 / 痛点 / 品牌 / 待办全功能 / 黄历 / 牛马计薪器 / 计算器 / 生日纪念日 / 录音机 / 效率套件 / 落版
export const SCENE_DURS = [90, 210, 210, 420, 300, 360, 270, 300, 270, 240, 240] as const;
