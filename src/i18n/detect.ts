/**
 * 首次启动的语言/地区推断(决策:不用 IP、不联网,纯本地信息)。
 *
 * 语言链:磁盘已存值(由 storage/index 层负责) → navigator.language(s) → 时区兜底 → 构建期默认。
 * 地区链:磁盘已存值 → 构建期 VITE_MARKET → 语言映射 → 时区映射 → 默认 Global。
 *
 * 优先级铁律(全链路统一):手动选择 > 磁盘值 > 首次推断 > 构建期默认。
 */

import { MARKET } from '../config/market'
import { normalizeLocaleTag, type Locale, type Region } from './types'

/** 构建期默认语言:CN 包 zh-CN,INTL 包 en。 */
export const DEFAULT_LOCALE: Locale = MARKET === 'INTL' ? 'en' : 'zh-CN'

/** 构建期默认地区。 */
export const DEFAULT_REGION: Region = MARKET === 'INTL' ? 'GLOBAL' : 'CN'

/** navigator.language(s) → Locale;仅接受明确匹配,模糊 zh 留给时区判别。 */
function localeFromNavigator(): Locale | null {
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter(Boolean)
  for (const tag of candidates) {
    const hit = normalizeLocaleTag(tag)
    if (hit) return hit
  }
  return null
}

/** 模糊 `zh` 标签 + 时区判别繁简:上海/乌鲁木齐 → 简体,台北/香港 → 繁体。 */
function zhFromTimezone(): Locale | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz === 'Asia/Taipei' || tz === 'Asia/Hong_Kong' || tz === 'Asia/Macau') return 'zh-TW'
    if (tz.startsWith('Asia/Shanghai') || tz === 'Asia/Urumqi' || tz.startsWith('Asia/')) {
      // 其余亚洲时区不武断归简体;仅在完全没有其他线索时作为 zh-CN 兜底。
      return 'zh-CN'
    }
  } catch {
    /* Intl 不可用时忽略 */
  }
  return null
}

/** 推断界面语言(不含磁盘值,磁盘优先逻辑在 index.ts)。 */
export function detectLocale(): Locale {
  const fromNav = localeFromNavigator()
  if (fromNav) return fromNav
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz === 'Asia/Tokyo') return 'ja'
    if (tz === 'Asia/Seoul') return 'ko'
  } catch {
    /* ignore */
  }
  const zh = zhFromTimezone()
  if (zh) return zh
  return DEFAULT_LOCALE
}

/** 语言 → 默认地区映射(ja→JP / ko→KR / zh-TW→TW / zh-CN→CN / en→Global)。 */
function regionFromLocale(locale: Locale): Region | null {
  switch (locale) {
    case 'ja':
      return 'JP'
    case 'ko':
      return 'KR'
    case 'zh-TW':
      return 'TW'
    case 'zh-CN':
      return 'CN'
    default:
      return null
  }
}

/** 时区 → 地区映射(仅精确匹配,未识别一律 Global,避免错误节假日)。 */
function regionFromTimezone(): Region | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz === 'Asia/Tokyo') return 'JP'
    if (tz === 'Asia/Seoul') return 'KR'
    if (tz === 'Asia/Shanghai' || tz === 'Asia/Urumqi') return 'CN'
    if (tz === 'Asia/Taipei' || tz === 'Asia/Hong_Kong' || tz === 'Asia/Macau') return 'TW'
    // America/* 不武断映射 US(加拿大/巴西等会被误判),交给 Global 只排周末。
  } catch {
    /* ignore */
  }
  return null
}

/** 推断地区(不含磁盘值)。 */
export function detectRegion(locale: Locale): Region {
  const byLocale = regionFromLocale(locale)
  if (byLocale) return byLocale
  const byTz = regionFromTimezone()
  if (byTz) return byTz
  if (MARKET === 'CN') return 'CN'
  return 'GLOBAL'
}
