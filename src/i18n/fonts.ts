/**
 * 按语言返回字体栈。
 *
 * ⚠️ P0 仅为占位能力,不自动应用:应用内已有「待办字体」设置(fontStackOf)
 *   控制任务文字字体,自动覆盖 document 级 font-family 会与其互相踩踏。
 *   P1 接入时按「语言缺字兜底」原则,把对应栈追加到现有字体选择之后。
 */

import type { Locale } from './types'

const LOCALE_FONT_STACKS: Record<Locale, string> = {
  // 简体:现有栈保持不变。
  'zh-CN': 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  // 繁体:正体优先(微软正黑 / 苹方-繁)。
  'zh-TW':
    'system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Microsoft YaHei", sans-serif',
  // 日文:Hiragino / Yu Gothic / 游ゴシック。
  ja: 'system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif',
  // 韩文:Malgun Gothic / Apple SD Gothic Neo。
  ko: 'system-ui, -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", "맑은 고딕", sans-serif',
  en: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
}

export function fontStackForLocale(locale: Locale): string {
  return LOCALE_FONT_STACKS[locale]
}
