/**
 * 富文本随手记（2026-11-24）—— 存取 / 净化 / 渲染三件套，绳卡与归档页共用。
 *
 * 存储（零 Rust 改动）：card.text = '@@RICH@@' + 白名单净化后的 HTML；
 * 无格式时存纯文本（与旧数据完全兼容）。'@@RICH@@' 前缀是唯一判据，
 * 纯文本里出现的 < 字符不会被误判。
 *
 * 净化红线：随手记正文会被原样塞进 dangerouslySetInnerHTML，必须白名单重建——
 * 只放行排版标签（div/p/br/b/strong/i/em/u/s/strike/span/font）与
 * color / font-weight / font-style / text-decoration 四种内联样式；
 * 其余标签剥壳保内容，script/style 整体丢弃，属性除 style/color 外全剥。
 */

import type { MouseEvent } from 'react'

export const RICH_PREFIX = '@@RICH@@'

const ALLOWED_TAGS = new Set([
  'DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'FONT',
])
const STYLE_ALLOWED = /^(color|font-weight|font-style|text-decoration)\s*:/i
const COLOR_SAFE = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-zA-Z]{3,16})$/

/** 是否为富文本存储格式（带前缀）。 */
export const isRichText = (t?: string | null): boolean => !!t && t.startsWith(RICH_PREFIX)

/** 编辑器产出的 HTML 是否含真实格式标记（纯换行 div/br 不算）。 */
export function hasRichMarkup(html: string): boolean {
  return /<\/?(?:b|strong|i|em|u|s|strike|font|span)[\s/>]/i.test(html)
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** style 属性白名单过滤；FONT 的 color 属性并入 style（色值校验）。 */
function safeStyle(el: Element): string {
  const parts: string[] = []
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const d = decl.trim()
    if (d && STYLE_ALLOWED.test(d) && !d.includes('"')) parts.push(d)
  }
  if (el.tagName === 'FONT') {
    const c = el.getAttribute('color') ?? ''
    if (c && COLOR_SAFE.test(c)) parts.push(`color: ${c}`)
  }
  return parts.join('; ')
}

/** 白名单净化：DOMParser 逐节点重建输出，绝不信原始字符串。 */
export function sanitizeRichHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(escapeText(node.textContent ?? ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (el.tagName === 'BR') {
      out.push('<br>')
      return
    }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return
      for (const c of Array.from(el.childNodes)) walk(c)
      return
    }
    const tag = el.tagName.toLowerCase()
    const style = safeStyle(el)
    out.push(`<${tag}${style ? ` style="${style}"` : ''}>`)
    for (const c of Array.from(el.childNodes)) walk(c)
    out.push(`</${tag}>`)
  }
  for (const c of Array.from(doc.body.childNodes)) walk(c)
  return out.join('').replace(/(?:<br>){3,}/gi, '<br><br>')
}

/** 预览拍平：块级标签折成 <br>，让 -webkit-line-clamp 能按「行」截断。 */
export function flattenRichHtml(html: string): string {
  return html.replace(/<\/(?:div|p)>/gi, '<br>').replace(/<(?:div|p)[^>]*>/gi, '')
}

/** 富文本 → 纯文本（编辑旧富文本 / title 提示等场景的兜底）。 */
export function richToPlain(t?: string | null): string {
  if (!t) return ''
  if (!isRichText(t)) return t
  const doc = new DOMParser().parseFromString(t.slice(RICH_PREFIX.length), 'text/html')
  return (doc.body.textContent ?? '').trim()
}

/** 渲染组件：富文本走净化 HTML；纯文本原样（换行由调用方 CSS pre-wrap 承接）。 */
export function RichText(props: {
  text?: string | null
  className?: string
  /** 预览场景拍平块级标签（配 line-clamp 用）。 */
  flatten?: boolean
  /** 原生 title 提示（富文本时由调用方传 richToPlain 结果）。 */
  title?: string
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
}) {
  const { text, className, flatten, title, onClick } = props
  const raw = text ?? ''
  if (!isRichText(raw)) {
    return (
      <div className={className} title={title} onClick={onClick}>
        {raw}
      </div>
    )
  }
  const html = sanitizeRichHtml(raw.slice(RICH_PREFIX.length))
  return (
    <div
      className={className}
      title={title}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: flatten ? flattenRichHtml(html) : html }}
    />
  )
}
