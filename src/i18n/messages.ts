/**
 * Rust 错误码 → 前端文案映射(P0 建立机制,P3 Rust 端改造后启用)。
 *
 * 约定:Rust invoke 的 Err(String) 携带稳定错误码(如 "CL_CARD_LIMIT"),
 * 前端收到后经 messageForCode 翻译;未登记的错误码原样透传(避免吞掉新错误)。
 */

import { t, type TParams } from './index'
import type { LocaleKey } from './locales/zh-CN'

/** Rust 端已登记的错误码注册表。P3 逐个接入后在此补 key。 */
const CODE_TO_KEY: Record<string, LocaleKey> = {
  // 'CL_CARD_LIMIT': 'clothesline.error.cardLimit',
}

/** 把 Rust 错误码翻译为当前语言文案;未登记则原样返回。 */
export function messageForCode(code: string, params?: TParams): string {
  const key = CODE_TO_KEY[code]
  if (!key) return code
  return t(key, params)
}

/** 判断一个 Err 字符串是否是已登记的错误码(全大写下划线格式才尝试映射)。 */
export function looksLikeErrorCode(err: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(err) && err in CODE_TO_KEY
}
