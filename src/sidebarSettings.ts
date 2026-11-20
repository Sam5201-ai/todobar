import { useEffect, useState } from 'react'
import { loadDiskPref, saveDiskPref } from './prefs'
import {
  DEFAULT_TOPBAR_TOOLS,
  sanitizeTopbarTools,
  type TopbarToolsPref,
} from './topbarTools'
import type { DockSide, MonitorPref } from './dock'
import { t, type LocaleKey } from './i18n'

// 保持 v19:新增字段(topbarTools / dockSide / targetMonitor)一律由
// sanitizeSettings 自动补齐,无需升 key。
// ⚠️ 不升 key 是刻意的选择——升 key 会让首帧以「默认值」启动,而磁盘回灌
// (loadDiskPref) 与镜像写入 (saveDiskPref) 是并发的,写可能先于读完成,把
// prefs.json 里的旧设置覆盖成默认值,导致用户主题/宽度/快捷键全部丢失。
export const SIDEBAR_SETTINGS_KEY = 'todobar.sidebar.settings.v19'
const STORAGE_KEY = SIDEBAR_SETTINGS_KEY

export type ThemeMode = 'light' | 'dark'

/** 待办标题字体选项。stack 为 font-family 字体栈。label 为中文参考,展示经 fontLabel() 走 t()。 */
export const FONT_OPTIONS: { key: string; label: string; stack: string }[] = [
  { key: 'song', label: '宋体', stack: '"宋体", SimSun, "Songti SC", "NSimSun", serif' }, // i18n-allow
  { key: 'hei', label: '黑体', stack: '"黑体", SimHei, "Source Han Sans SC", "Microsoft YaHei", sans-serif' }, // i18n-allow
  { key: 'yahei', label: '微软雅黑', stack: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif' }, // i18n-allow
  { key: 'kai', label: '楷体', stack: '"楷体", KaiTi, "Kaiti SC", STKaiti, serif' }, // i18n-allow
  { key: 'deng', label: '等线', stack: '"等线", "DengXian", "Microsoft YaHei", sans-serif' }, // i18n-allow
  { key: 'fangsong', label: '仿宋', stack: '"仿宋", FangSong, "FangSong_GB2312", serif' }, // i18n-allow
  { key: 'system', label: '系统默认', stack: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' }, // i18n-allow
]

/** 背景选项。CSS 类名统一为 `bg-${key}`;图片类对应 public/ 下的图片。label 为中文参考,展示经 backgroundLabel() 走 t()。 */
export const BACKGROUND_OPTIONS: { key: string; label: string }[] = [
  { key: 'solid', label: '纯色' }, // i18n-allow
  { key: 'aurora', label: '极光' }, // i18n-allow
  { key: 'img-teal', label: '清蓝' }, // i18n-allow
  { key: 'img-mountain', label: '远山' }, // i18n-allow
  { key: 'img-wave', label: '海浪' }, // i18n-allow
  { key: 'img-leaf', label: '枝叶' }, // i18n-allow
  { key: 'img-star', label: '星夜' }, // i18n-allow
  { key: 'img-cyber', label: '赛博' }, // i18n-allow
  { key: 'img-anime', label: '动漫' }, // i18n-allow
]

const FONT_KEYS = FONT_OPTIONS.map((f) => f.key)
const BG_KEYS = BACKGROUND_OPTIONS.map((b) => b.key)

export function fontStackOf(key: string): string {
  return FONT_OPTIONS.find((f) => f.key === key)?.stack ?? FONT_OPTIONS[0].stack
}

/** 字体/背景 label 的词条映射(label 字段仅作中文参考,展示一律经 t())。 */
const FONT_LABEL_KEYS: Record<string, LocaleKey> = {
  song: 'settings.font.song',
  hei: 'settings.font.hei',
  yahei: 'settings.font.yahei',
  kai: 'settings.font.kai',
  deng: 'settings.font.deng',
  fangsong: 'settings.font.fangsong',
  system: 'settings.font.system',
}
const BG_LABEL_KEYS: Record<string, LocaleKey> = {
  solid: 'settings.bg.solid',
  aurora: 'settings.bg.aurora',
  'img-teal': 'settings.bg.imgTeal',
  'img-mountain': 'settings.bg.imgMountain',
  'img-wave': 'settings.bg.imgWave',
  'img-leaf': 'settings.bg.imgLeaf',
  'img-star': 'settings.bg.imgStar',
  'img-cyber': 'settings.bg.imgCyber',
  'img-anime': 'settings.bg.imgAnime',
}

/** 字体显示名(当前语言);未知 key 回退注册表 label。 */
export function fontLabel(key: string): string {
  const k = FONT_LABEL_KEYS[key]
  if (k) return t(k)
  return FONT_OPTIONS.find((f) => f.key === key)?.label ?? key
}

/** 背景显示名(当前语言);未知 key 回退注册表 label。 */
export function backgroundLabel(key: string): string {
  const k = BG_LABEL_KEYS[key]
  if (k) return t(k)
  return BACKGROUND_OPTIONS.find((b) => b.key === key)?.label ?? key
}

export type SidebarSettings = {
  panelWidth: number
  tabWidth: number
  handleHeight: number
  handleY: number
  motionMs: number
  panelRadius: number
  surfaceAlpha: number
  taskRowHeight: number
  taskGap: number
  taskTextSize: number
  showCompleted: boolean
  launchAtLogin: boolean
  theme: ThemeMode
  taskFont: string
  background: string
  /** 打开/关闭(呼出/收起)主窗口的全局快捷键,默认 CommandOrControl+Shift+T。 */
  toggleWindowShortcut: string
  /** 新建便利签的全局快捷键,默认 Alt+N。 */
  noteShortcut: string
  /** 唤出剪贴板历史浮窗的全局快捷键,默认 CommandOrControl+Shift+V。 */
  clipboardShortcut: string
  /** 打开归档页的全局快捷键,默认 Alt+A(2026-11-18 归档)。 */
  archiveShortcut: string
  /** 首页顶栏快捷入口:完整顺序 + 勾选启用的工具(设置按钮固定,不参与配置)。 */
  topbarTools: TopbarToolsPref
  /** 悬停自动展开:收起时光标移入把手区域自动展开,移出窗口自动收起。 */
  hoverAutoExpand: boolean
  /** 主窗停靠在哪一侧桌缘。 */
  dockSide: DockSide
  /** 主窗显示在哪块屏幕:主屏(默认)/ 副屏 / 具体显示器 key。会被持久化。 */
  targetMonitor: MonitorPref
}

export const defaultSidebarSettings: SidebarSettings = {
  panelWidth: 340,
  tabWidth: 42,
  handleHeight: 84,
  handleY: 50,
  motionMs: 230,
  panelRadius: 18,
  surfaceAlpha: 96,
  taskRowHeight: 44,
  taskGap: 7,
  taskTextSize: 12.5,
  showCompleted: true,
  launchAtLogin: true,
  theme: 'light',
  taskFont: 'song',
  background: 'solid',
  toggleWindowShortcut: 'CommandOrControl+Shift+T',
  noteShortcut: 'Alt+N',
  clipboardShortcut: 'CommandOrControl+Shift+V',
  archiveShortcut: 'Alt+A',
  topbarTools: { ...DEFAULT_TOPBAR_TOOLS },
  hoverAutoExpand: true,
  dockSide: 'right',
  targetMonitor: 'primary',
}

/**
 * 旧版本把 'auto'(跟随窗口所在屏)当默认值,但该选项已下线。
 * 任何空值 / 'auto' 一律归到主屏,避免老用户的落盘值落到一个不存在的选项上。
 */
export function normalizeMonitorPref(value: unknown): MonitorPref {
  return typeof value === 'string' && value.trim() && value !== 'auto'
    ? value
    : 'primary'
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

function sanitizeSettings(value: Partial<SidebarSettings>): SidebarSettings {
  return {
    panelWidth: clamp(
      value.panelWidth ?? defaultSidebarSettings.panelWidth,
      300,
      500,
    ),
    tabWidth: clamp(value.tabWidth ?? defaultSidebarSettings.tabWidth, 34, 62),
    handleHeight: clamp(
      value.handleHeight ?? defaultSidebarSettings.handleHeight,
      72,
      132,
    ),
    handleY: clamp(value.handleY ?? defaultSidebarSettings.handleY, 0, 100),
    motionMs: clamp(value.motionMs ?? defaultSidebarSettings.motionMs, 140, 360),
    panelRadius: clamp(
      value.panelRadius ?? defaultSidebarSettings.panelRadius,
      12,
      28,
    ),
    surfaceAlpha: clamp(
      value.surfaceAlpha ?? defaultSidebarSettings.surfaceAlpha,
      86,
      100,
    ),
    taskRowHeight: clamp(
      value.taskRowHeight ?? defaultSidebarSettings.taskRowHeight,
      40,
      62,
    ),
    taskGap: clamp(value.taskGap ?? defaultSidebarSettings.taskGap, 4, 14),
    taskTextSize: clamp(
      value.taskTextSize ?? defaultSidebarSettings.taskTextSize,
      11,
      14,
    ),
    showCompleted:
      value.showCompleted ?? defaultSidebarSettings.showCompleted,
    launchAtLogin:
      value.launchAtLogin ?? defaultSidebarSettings.launchAtLogin,
    theme: value.theme === 'dark' ? 'dark' : 'light',
    taskFont: FONT_KEYS.includes(value.taskFont ?? '')
      ? (value.taskFont as string)
      : defaultSidebarSettings.taskFont,
    background: BG_KEYS.includes(value.background ?? '')
      ? (value.background as string)
      : defaultSidebarSettings.background,
    toggleWindowShortcut:
      typeof value.toggleWindowShortcut === 'string' &&
      value.toggleWindowShortcut.trim().length > 0
        ? value.toggleWindowShortcut
        : defaultSidebarSettings.toggleWindowShortcut,
    noteShortcut:
      typeof value.noteShortcut === 'string' && value.noteShortcut.trim().length > 0
        ? value.noteShortcut
        : defaultSidebarSettings.noteShortcut,
    clipboardShortcut:
      typeof value.clipboardShortcut === 'string' && value.clipboardShortcut.trim().length > 0
        ? value.clipboardShortcut
        : defaultSidebarSettings.clipboardShortcut,
    archiveShortcut:
      typeof value.archiveShortcut === 'string' && value.archiveShortcut.trim().length > 0
        ? value.archiveShortcut
        : defaultSidebarSettings.archiveShortcut,
    topbarTools: sanitizeTopbarTools(value.topbarTools ?? defaultSidebarSettings.topbarTools),
    hoverAutoExpand:
      value.hoverAutoExpand ?? defaultSidebarSettings.hoverAutoExpand,
    dockSide: value.dockSide === 'left' ? 'left' : 'right',
    targetMonitor: normalizeMonitorPref(value.targetMonitor),
  }
}

export function useSidebarSettings() {
  const [settings, setSettings] = useState<SidebarSettings>(() => {
    const params = new URLSearchParams(window.location.search)
    const themeParam = params.get('theme')

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      const base = stored
        ? sanitizeSettings(JSON.parse(stored) as Partial<SidebarSettings>)
        : defaultSidebarSettings

      return sanitizeSettings({
        ...base,
        theme:
          themeParam === 'dark' || themeParam === 'light'
            ? themeParam
            : base.theme,
      })
    } catch {
      return sanitizeSettings({
        ...defaultSidebarSettings,
        theme:
          themeParam === 'dark' || themeParam === 'light'
            ? themeParam
            : defaultSidebarSettings.theme,
      })
    }
  })

  // 重装 / 清缓存后 localStorage 会丢失,这里从磁盘持久化(~/.ticktask/prefs.json)回灌。
  // ⚠️ 优先级:localStorage > 磁盘 > 默认值。磁盘写入是异步 IPC,用户改完设置立刻
  // 关窗时 prefs.json 可能还落后一个版本;旧实现用 {...current, ...disk} 让旧磁盘值
  // 盖掉用户刚选的屏幕/主题/宽度,表现为「每次打开都要重新选一次」。
  // 只有在 localStorage 真的丢失(清缓存 / 重装)时才由磁盘接管。
  useEffect(() => {
    let cancelled = false
    void loadDiskPref<Partial<SidebarSettings>>('sidebar').then((disk) => {
      if (cancelled || !disk) return
      let stored: Partial<SidebarSettings> | null = null
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw) stored = JSON.parse(raw) as Partial<SidebarSettings>
      } catch {
        /* 缓存损坏时让磁盘接管 */
      }
      const merged = sanitizeSettings({
        ...defaultSidebarSettings,
        ...disk,
        ...(stored ?? {}),
      })
      const params = new URLSearchParams(window.location.search)
      const themeParam = params.get('theme')
      if (themeParam === 'dark' || themeParam === 'light') merged.theme = themeParam
      if (!cancelled) setSettings(merged)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Desktop builds can later move this into a settings repository.
    }
    // 同时镜像到磁盘,重装后不丢。
    void saveDiskPref('sidebar', settings)
  }, [settings])

  const updateSettings = (patch: Partial<SidebarSettings>) => {
    setSettings((current) => sanitizeSettings({ ...current, ...patch }))
  }

  const resetSettings = () => setSettings(defaultSidebarSettings)

  return [settings, updateSettings, resetSettings] as const
}
