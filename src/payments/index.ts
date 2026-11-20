/**
 * 支付 provider 抽象(P0 骨架,P3 实装)。
 *
 * - CN 包:激活码兑换(现有 wzyp.cn 链路,由 AccountSetting 现状承担,P3 迁入);
 * - INTL 包:Web 收银台(Google Pay Web / Stripe / Paddle,首发实装一种);
 * - 抽象接口保持可替换,业务代码只依赖 PaymentProvider。
 * ⚠️ 本骨架未接入任何调用方,纯定义 + 工厂,零运行时影响。
 */

import { MARKET, type PaymentProviderKind } from '../config/market'

export interface PaymentProvider {
  readonly kind: PaymentProviderKind
  /** 当前环境是否可发起购买(如 INTL 包未配置收银台时为 false)。 */
  isAvailable(): boolean
  /** 获取商品(价格经 i18n/format.formatCurrency 按 locale/region 展示)。 */
  getProducts(): Promise<{ id: string; amount: number; currency: string }[]>
  /** 发起购买,返回订单标识;失败抛携带稳定错误码的 Error。 */
  purchase(productId: string): Promise<{ orderId: string }>
  /** 恢复购买(CN 激活码体系无此概念,返回 false)。 */
  restore(): Promise<boolean>
}

const unavailableProvider: PaymentProvider = {
  kind: 'none',
  isAvailable: () => false,
  getProducts: async () => [],
  purchase: async () => {
    throw new Error('PAYMENT_UNAVAILABLE')
  },
  restore: async () => false,
}

/** 按构建期市场取支付 provider(固化,不随运行时 region 切换)。 */
export function getPaymentProvider(): PaymentProvider {
  // P3 实装:CN → activationCode.ts(迁移现有激活码逻辑);
  // INTL → google.ts(Web 收银台)。骨架阶段统一返回不可用占位。
  switch (MARKET) {
    case 'CN':
    case 'INTL':
    default:
      return unavailableProvider
  }
}
