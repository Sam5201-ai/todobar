/**
 * 自研轻量 i18n 核心(零依赖):
 * - 模块单例状态 + React Context(useSyncExternalStore 订阅);
 * - t(key, params) 插值 + 复数(count → Intl.PluralRules);
 * - 回退链:当前 locale → en → zh-CN → key(构建期缺词校验兜住"不露 key");
 * - 跨窗口:setLocale 广播经 storage 事件(见 storage.ts),9 窗口即时同步。
 *
 * ⚠️ 本模块刻意不引入任何第三方依赖、不做任何网络请求;initI18n() 的同步部分
 *   必须无副作用阻塞(读 localStorage),磁盘回灌异步进行,不影响首帧时序。
 */

import {
  createContext,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import zhCN, { type LocaleKey } from './locales/zh-CN'
import en from './locales/en'
import zhTW from './locales/zh-TW'
import ja from './locales/ja'
import ko from './locales/ko'
import { DEFAULT_LOCALE, detectLocale, detectRegion, DEFAULT_REGION } from './detect'
import { FALLBACK_LOCALE, onOtherWindowChange, readDisk, readLocal, writeLocal } from './storage'
import { isLocale, isRegion, type Locale, type Region } from './types'

const DICTS: Record<Locale, Partial<Record<LocaleKey, string>>> = {
  'zh-CN': zhCN,
  en,
  'zh-TW': zhTW,
  ja,
  ko,
}

export type { LocaleKey }
export { LOCALES, REGIONS } from './types'
export type { Locale, Region } from './types'

// ---------------------------------------------------------------------------
// 单例状态(每文档一份;跨窗口经 storage 事件同步)
// ---------------------------------------------------------------------------

interface I18nState {
  locale: Locale
  region: Region
}

let state: I18nState = {
  locale: DEFAULT_LOCALE,
  region: DEFAULT_REGION,
}
let initialized = false
const listeners = new Set<() => void>()
let snapshot: I18nState = state

function emitChange() {
  snapshot = { ...state }
  for (const l of listeners) l()
}

function applyLocaleSideEffects() {
  // 语言标签写入 html lang(无障碍/字体回退依据);字体栈不在 P0 自动应用,
  // 避免与现有「待办字体」设置互相覆盖(见 fonts.ts,由 P1 按需接入)。
  try {
    document.documentElement.lang = state.locale
  } catch {
    /* ignore */
  }
}

/** 初始化:同步确定初值(localStorage → 推断 → 构建期默认),磁盘回灌异步补齐。 */
export function initI18n(): void {
  if (initialized) return
  initialized = true

  const local = readLocal()
  if (local && isLocale(local.locale) && isRegion(local.region)) {
    state = { locale: local.locale, region: local.region }
  } else {
    const detected = detectLocale()
    state = { locale: detected, region: detectRegion(detected) }
    writeLocal(state)
  }
  applyLocaleSideEffects()

  // 磁盘回灌:仅当 localStorage 缺失(重装/清缓存)时由磁盘接管,与 sidebar 设置同策略。
  if (!local) {
    void readDisk().then((disk) => {
      if (!disk) return
      if (readLocal()) return // 回灌期间用户/其他窗口已写入 localStorage,磁盘让位
      if (isLocale(disk.locale) && isRegion(disk.region)) {
        state = { locale: disk.locale, region: disk.region }
        writeLocal(state)
        applyLocaleSideEffects()
        emitChange()
      }
    })
  }

  // 跨窗口同步:其余窗口改了 locale/region → 本窗跟随。
  onOtherWindowChange(
    (v) => {
      state = { locale: v.locale, region: v.region }
      applyLocaleSideEffects()
      emitChange()
    },
    () => state,
  )
}

// ---------------------------------------------------------------------------
// t() —— 可在 React 外调用(showFatal / Rust 消息映射等)
// ---------------------------------------------------------------------------

export type TParams = Record<string, string | number | undefined> & { count?: number }

function resolveKey(key: LocaleKey, locale: Locale): string | undefined {
  return DICTS[locale]?.[key] ?? DICTS[FALLBACK_LOCALE]?.[key] ?? zhCN[key]
}

function interpolate(template: string, params: TParams | undefined): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name]
    return v === undefined ? m : String(v)
  })
}

/**
 * 翻译。params.count 存在时启用复数:优先查 `${key}_${category}`
 * (category 由 Intl.PluralRules 按当前 locale 决定),查不到回退本词。
 */
export function t(key: LocaleKey, params?: TParams): string {
  let locale = state.locale
  if (params && typeof params.count === 'number') {
    let category = 'other'
    try {
      category = new Intl.PluralRules(locale).select(params.count)
    } catch {
      /* ignore */
    }
    const pluralKey = `${key}_${category}` as LocaleKey
    const pluralValue = DICTS[locale]?.[pluralKey] ?? DICTS[FALLBACK_LOCALE]?.[pluralKey]
    if (pluralValue !== undefined) return interpolate(pluralValue, params)
    // 复数词缺失时,当前 locale 可能整体回退,改用回退 locale 的规则再试一次。
    if (locale !== FALLBACK_LOCALE) {
      locale = FALLBACK_LOCALE
    }
  }
  return interpolate(resolveKey(key, locale) ?? key, params)
}

// ---------------------------------------------------------------------------
// React 接入
// ---------------------------------------------------------------------------

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const I18nContext = createContext<I18nState>(state)

export interface I18nApi extends I18nState {
  setLocale: (locale: Locale) => void
  setRegion: (region: Region) => void
  t: typeof t
}

/** 手动切换语言:立即重渲染 + 写 localStorage/磁盘 + 广播其余窗口。 */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === state.locale) return
  state = { ...state, locale }
  writeLocal(state)
  applyLocaleSideEffects()
  emitChange()
}

/** 手动切换地区:节假日/黄历/货币默认值等按新地区即时重算。 */
export function setRegion(region: Region): void {
  if (!isRegion(region) || region === state.region) return
  state = { ...state, region }
  writeLocal(state)
  emitChange()
}

function useI18nState(): I18nState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** 组件内读取当前语言状态与 t()。必须位于 <I18nProvider> 之内。 */
export function useI18n(): I18nApi {
  const s = useI18nState()
  const setLocaleCb = useCallback((locale: Locale) => setLocale(locale), [])
  const setRegionCb = useCallback((region: Region) => setRegion(region), [])
  return useMemo(
    () => ({ ...s, setLocale: setLocaleCb, setRegion: setRegionCb, t }),
    [s, setLocaleCb, setRegionCb],
  )
}

/**
 * Provider:包在每处 createRoot 的渲染树最外层。
 * Context value 引用只在 locale/region 变化时更新(经 useI18nState 的快照)。
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const s = useI18nState()
  const value = useMemo(() => s, [s])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** 非 React 场景读取当前 locale(如 Rust 消息映射、格式化)。 */
export function getLocale(): Locale {
  return state.locale
}

export function getRegion(): Region {
  return state.region
}
