/**
 * i18n 类型定义。Locale 覆盖 5 种交付语言;Region 覆盖 6 个地区轴选项。
 */

export const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]

export const REGIONS = ['CN', 'TW', 'JP', 'KR', 'US', 'GLOBAL'] as const
export type Region = (typeof REGIONS)[number]

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

export function isRegion(v: unknown): v is Region {
  return typeof v === 'string' && (REGIONS as readonly string[]).includes(v)
}

/** BCP-47 标签归一化到支持的 Locale;无法识别返回 null。 */
export function normalizeLocaleTag(tag: string): Locale | null {
  const t = tag.toLowerCase()
  if (t.startsWith('zh')) {
    // 繁体优先按脚本/地区判别:zh-Hant / zh-TW / zh-HK / zh-MO。
    if (t.includes('hant') || t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo') return 'zh-TW'
    if (t.includes('hans') || t === 'zh-cn' || t === 'zh-sg') return 'zh-CN'
    // 模糊 zh 由 detect 的时区兜底判别,这里不做猜测。
    return null
  }
  if (t.startsWith('en')) return 'en'
  if (t.startsWith('ja')) return 'ja'
  if (t.startsWith('ko')) return 'ko'
  return null
}
