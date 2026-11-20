/**
 * i18n 存储层:localStorage(同步读,快) + prefs.json 磁盘镜像(重装不丢) + 跨窗同步。
 *
 * 设计约束(与现有 prefs 体系保持一致):
 * - 磁盘用顶层独立 key `locale` / `region`(经 prefs.ts 的 loadDiskPref/saveDiskPref),
 *   不塞进 SidebarSettings v19 —— i18n 须在所有 createRoot 前确定,React hook 时序不满足;
 * - localStorage key `todobar.i18n.v1`,9 个窗口共享同一 WebView2 数据目录,
 *   任一窗口 setLocale() 写入后,其余窗口经 `storage` 事件收到通知并各自更新。
 */

import { loadDiskPref, saveDiskPref } from '../prefs'
import { DEFAULT_LOCALE } from './detect'
import type { Locale, Region } from './types'

const LS_KEY = 'todobar.i18n.v1'

export interface I18nPersisted {
  locale: Locale
  region: Region
}

/** 同步读取 localStorage 中的持久化值;缺失或损坏返回 null。 */
export function readLocal(): I18nPersisted | null {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<I18nPersisted>
    if (!v.locale || !v.region) return null
    return { locale: v.locale, region: v.region }
  } catch {
    return null
  }
}

/** 写 localStorage(同步)+ 异步镜像磁盘。供 setLocale/setRegion 调用。 */
export function writeLocal(value: I18nPersisted): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(value))
  } catch {
    /* 存储失败静默(无痕模式等),内存态仍生效 */
  }
  // 磁盘镜像独立 key,失败静默;不与 sidebar 设置互扰。
  void saveDiskPref('locale', value.locale)
  void saveDiskPref('region', value.region)
}

/** 磁盘值异步回灌(仅当 localStorage 丢失,如重装/清缓存)。返回磁盘值或 null。 */
export async function readDisk(): Promise<I18nPersisted | null> {
  const locale = await loadDiskPref<Locale>('locale')
  const region = await loadDiskPref<Region>('region')
  if (!locale || !region) return null
  return { locale, region }
}

export const FALLBACK_LOCALE = DEFAULT_LOCALE

/**
 * 监听其它窗口的 locale/region 变化(storage 事件只在「别的」窗口触发)。
 * 返回解绑函数。ownWindow 防止把本窗刚写入的值再应用一次。
 */
export function onOtherWindowChange(
  handler: (value: I18nPersisted) => void,
  ownWindow: () => I18nPersisted,
): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key !== LS_KEY || !e.newValue) return
    try {
      const v = JSON.parse(e.newValue) as I18nPersisted
      const cur = ownWindow()
      // 本窗状态落后于广播值时才应用(避免时序抖动来回翻转)。
      if (v.locale !== cur.locale || v.region !== cur.region) handler(v)
    } catch {
      /* 忽略损坏消息 */
    }
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
