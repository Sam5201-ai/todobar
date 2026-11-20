/**
 * 按当前 locale 的 Intl 格式化统一入口(P0 提供,P1 各模块逐步替换硬编码的
 * toLocaleTimeString('zh-CN') / 拼接日期等)。
 *
 * 原则:文案可回退 en,但日期/数字格式始终按用户所选 locale 呈现(方案 9.2)。
 */

import { getLocale, getRegion } from './index'

function safeLocaleTag(locale: string): string {
  try {
    Intl.DateTimeFormat.supportedLocalesOf([locale])
    return locale
  } catch {
    return 'en'
  }
}

/** 日期:2026年11月19日 / Nov 19, 2026(带 style) */
export function formatDate(d: Date, style: 'short' | 'medium' | 'long' = 'medium'): string {
  const locale = safeLocaleTag(getLocale())
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: style === 'short' ? '2-digit' : 'long',
      day: 'numeric',
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/** 时间:HH:mm(HH:mm:ss) */
export function formatTime(d: Date, withSeconds = false): string {
  const locale = safeLocaleTag(getLocale())
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
    }).format(d)
  } catch {
    return d.toTimeString().slice(0, withSeconds ? 8 : 5)
  }
}

/** 数字分组:12,345 */
export function formatNumber(n: number): string {
  const locale = safeLocaleTag(getLocale())
  try {
    return new Intl.NumberFormat(locale).format(n)
  } catch {
    return String(n)
  }
}

/** 货币:按地区轴选币种(CN/TW→CNY/TWD,JP→JPY,KR→KRW,US→USD,Global→USD)。 */
export function currencyOfRegion(region = getRegion()): string {
  switch (region) {
    case 'CN':
      return 'CNY'
    case 'TW':
      return 'TWD'
    case 'JP':
      return 'JPY'
    case 'KR':
      return 'KRW'
    case 'US':
    case 'GLOBAL':
    default:
      return 'USD'
  }
}

/** 货币金额:￥29.9 / $4.99 */
export function formatCurrency(amount: number, currency?: string): string {
  const locale = safeLocaleTag(getLocale())
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency ?? currencyOfRegion(),
    }).format(amount)
  } catch {
    return String(amount)
  }
}

/** 相对时间:3 天前 / 3 days ago */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
): string {
  const locale = safeLocaleTag(getLocale())
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit)
  } catch {
    return `${value} ${unit}`
  }
}
