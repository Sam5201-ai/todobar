/**
 * 地区轴配置:双包(CN / INTL)构建期固化的市场差异。
 *
 * 固化矩阵(评审结论,见方案风险评审):
 * - 支付 provider:构建期按 VITE_MARKET 固化,不随运行时 region 切换
 *   (支付渠道绑定分发渠道,INTL 包不露激活码入口,P3 接入);
 * - 黄历显隐 / 节假日:运行时按用户 region 即时重算(见 almanacForRegion),
 *   保持「地区轴正交、手动切换即时生效」的一致推论;
 * - 默认语言/地区:i18n/detect.ts 按 MARKET 取构建期默认。
 */

import type { Locale, Region } from '../i18n/types'

export type Market = 'CN' | 'INTL'

export type PaymentProviderKind = 'activationCode' | 'google' | 'none'

export interface MarketConfig {
  /** 构建期固化的支付 provider。 */
  payment: PaymentProviderKind
  /** 构建期默认语言(CN 包 zh-CN / INTL 包 en)。 */
  defaultLocale: Locale
  /** 该市场的兜底地区。 */
  defaultRegion: Region
}

export const MARKET: Market = import.meta.env.VITE_MARKET === 'INTL' ? 'INTL' : 'CN'

export const MARKET_CONFIG: Record<Market, MarketConfig> = {
  CN: { payment: 'activationCode', defaultLocale: 'zh-CN', defaultRegion: 'CN' },
  INTL: { payment: 'google', defaultLocale: 'en', defaultRegion: 'GLOBAL' },
}

/**
 * 黄历显隐(运行时,按用户地区):CN/TW 完整黄历,其余地区降级公历日历。
 * 决策 2:海外不翻译中国历法值,直接不渲染农历/宜忌等。
 */
export function almanacForRegion(region: Region): boolean {
  return region === 'CN' || region === 'TW'
}
