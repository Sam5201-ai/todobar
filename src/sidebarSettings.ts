import { useEffect, useState } from 'react'
import { loadDiskPref, saveDiskPref } from './prefs'

const STORAGE_KEY = 'todobar.sidebar.settings.v19'

export type ThemeMode = 'light' | 'dark'

/** 待办标题字体选项。stack 为 font-family 字体栈。 */
export const FONT_OPTIONS: { key: string; label: string; stack: string }[] = [
  { key: 'song', label: '宋体', stack: '"宋体", SimSun, "Songti SC", "NSimSun", serif' },
  { key: 'hei', label: '黑体', stack: '"黑体", SimHei, "Source Han Sans SC", "Microsoft YaHei", sans-serif' },
  { key: 'yahei', label: '微软雅黑', stack: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif' },
  { key: 'kai', label: '楷体', stack: '"楷体", KaiTi, "Kaiti SC", STKaiti, serif' },
  { key: 'deng', label: '等线', stack: '"等线", "DengXian", "Microsoft YaHei", sans-serif' },
  { key: 'fangsong', label: '仿宋', stack: '"仿宋", FangSong, "FangSong_GB2312", serif' },
  { key: 'system', label: '系统默认', stack: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' },
]

/** 背景选项。CSS 类名统一为 `bg-${key}`;图片类对应 public/ 下的图片。 */
export const BACKGROUND_OPTIONS: { key: string; label: string }[] = [
  { key: 'solid', label: '纯色' },
  { key: 'aurora', label: '极光' },
  { key: 'img-teal', label: '清蓝' },
  { key: 'img-mountain', label: '远山' },
  { key: 'img-wave', label: '海浪' },
  { key: 'img-leaf', label: '枝叶' },
  { key: 'img-star', label: '星夜' },
  { key: 'img-cyber', label: '赛博' },
  { key: 'img-anime', label: '动漫' },
]

const FONT_KEYS = FONT_OPTIONS.map((f) => f.key)
const BG_KEYS = BACKGROUND_OPTIONS.map((b) => b.key)

export function fontStackOf(key: string): string {
  return FONT_OPTIONS.find((f) => f.key === key)?.stack ?? FONT_OPTIONS[0].stack
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
  useEffect(() => {
    let cancelled = false
    void loadDiskPref<Partial<SidebarSettings>>('sidebar').then((disk) => {
      if (cancelled || !disk) return
      setSettings((current) => {
        const merged = sanitizeSettings({ ...current, ...disk })
        const params = new URLSearchParams(window.location.search)
        const themeParam = params.get('theme')
        if (themeParam === 'dark' || themeParam === 'light') merged.theme = themeParam
        return merged
      })
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
