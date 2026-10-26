/**
 * 牛马计薪器 · 桌面组件 的共享配置(启用开关 + 风格)。
 *
 * 供三处复用:
 *  - SalaryView:用户在「桌面组件」区块里编辑;
 *  - WidgetView:组件窗口自身读取风格渲染、读取/写入位置;
 *  - App:启动时按磁盘持久化配置自动拉起组件窗口。
 *
 * 配置真源:优先 localStorage(同会话即时生效),缺失时回退磁盘偏好
 * (~/.ticktask/prefs.json,跨窗口/重装/清缓存存活,确保组件窗口与主程序一致)。
 *
 * 0.4.23: 三套样式按用户参考图 1:1 复刻重设计:
 *  - candy  奶牛萌卡(粉紫奶油风,竖版,奶牛吉祥物 + 寄语气泡 + 双卡 + 好心情徽章排);
 *  - wide   小马宽屏(浅蓝玻璃风,横版,寄语卡 + 右侧已赚/倒计时双卡,小马吉祥物);
 *  - sunset 暖阳三栏(奶油白玻璃风,横版三栏,牛牛伏案插画 + 已赚 + 倒计时进度条)。
 * 旧键(magazine/card/bar)已废弃,读取时静默映射到最接近的新风格。
 */

export type WidgetStyle = 'candy' | 'wide' | 'sunset'

export interface SalaryWidgetConfig {
  enabled: boolean
  style: WidgetStyle
}

/** localStorage 键。 */
export const SALARY_WIDGET_LS = 'ticktask.salaryWidget.v1'
/** 磁盘偏好键(get_pref / set_pref)。 */
export const SALARY_WIDGET_KEY = 'salaryWidget'
/** 位置持久化:localStorage 键(物理像素 {x,y})。 */
export const SALARY_WIDGET_POS_LS = 'ticktask.salaryWidget.pos'
/** 位置持久化:磁盘偏好键。 */
export const SALARY_WIDGET_POS_KEY = 'salaryWidgetPos'

/**
 * 三种风格的窗口逻辑尺寸(CSS 像素,与 Rust 创建窗口时一致)。
 * 0.4.24: 窗口比卡片四周各大 14px(透明边距),给圆角+柔和阴影留出渲染空间,
 * 根治「四角直角未被裁剪」的观感问题;卡片实际尺寸 = 窗口 - 28。
 */
export const STYLE_SIZES: Record<WidgetStyle, { w: number; h: number }> = {
  candy: { w: 468, h: 344 }, // 卡片 440×316(奶牛缩至 84px,寄语框与其等高,整体压扁)
  wide: { w: 588, h: 248 }, // 卡片 560×220(寄语卡 4:3,右侧双卡压缩)
  sunset: { w: 588, h: 238 }, // 卡片 560×210(寄语卡比右侧卡片宽 15%,压缩中部留白)
}

export const WIDGET_STYLES: { value: WidgetStyle; label: string }[] = [
  { value: 'candy', label: '奶牛萌卡' },
  { value: 'wide', label: '小马宽屏' },
  { value: 'sunset', label: '暖阳三栏' },
]

/** 旧版风格键 → 新风格的兼容映射(0.4.22 及之前的 magazine/card/bar)。 */
const LEGACY_MAP: Record<string, WidgetStyle> = {
  magazine: 'candy',
  card: 'candy',
  bar: 'wide',
}

export function normalizeStyle(s: unknown): WidgetStyle {
  if (s === 'candy' || s === 'wide' || s === 'sunset') return s
  if (typeof s === 'string' && LEGACY_MAP[s]) return LEGACY_MAP[s]
  return 'candy'
}

export function loadSalaryWidgetConfig(): SalaryWidgetConfig {
  try {
    const raw = localStorage.getItem(SALARY_WIDGET_LS)
    if (!raw) return { enabled: false, style: 'candy' }
    const c = JSON.parse(raw) as Partial<SalaryWidgetConfig>
    return {
      enabled: !!c.enabled,
      style: normalizeStyle(c.style),
    }
  } catch {
    return { enabled: false, style: 'candy' }
  }
}

export function saveSalaryWidgetConfigLocal(c: SalaryWidgetConfig) {
  try {
    localStorage.setItem(SALARY_WIDGET_LS, JSON.stringify(c))
  } catch {
    /* 静默 */
  }
}

/**
 * 受限降级专用:把组件配置置为「关闭」并写 localStorage,返回置关后的配置。
 * 只动本地配置,不动窗口进程 / 磁盘偏好——由调用方按需 close_salary_widget
 * 和 saveDiskPref(与用户手动关开关走同一条逻辑,UI 与配置保持一致)。
 */
export function disableSalaryWidgetConfig(): SalaryWidgetConfig {
  const disabled: SalaryWidgetConfig = { enabled: false, style: loadSalaryWidgetConfig().style }
  saveSalaryWidgetConfigLocal(disabled)
  return disabled
}

export interface WidgetPos {
  x: number
  y: number
}

export function loadSalaryWidgetPos(): WidgetPos | null {
  try {
    const raw = localStorage.getItem(SALARY_WIDGET_POS_LS)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<WidgetPos>
    if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
  } catch {
    /* ignore */
  }
  return null
}

export function saveSalaryWidgetPosLocal(p: WidgetPos) {
  try {
    localStorage.setItem(SALARY_WIDGET_POS_LS, JSON.stringify(p))
  } catch {
    /* 静默 */
  }
}
