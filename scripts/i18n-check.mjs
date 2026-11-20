/**
 * i18n 防遗漏审计(方案第 11 节)。
 *
 * 用法:
 *   node scripts/i18n-check.mjs           # 校验字典一致性;中文残留仅报告不失败
 *   node scripts/i18n-check.mjs --strict  # 中文残留也视为失败(P1 完成后用于 CI 门禁)
 *
 * 规则:
 * 1. 字典 key 一致性:5 份字典(en/zh-TW/ja/ko)的 key 集合必须与 zh-CN 完全一致
 *    —— 这是「缺词不露 key」的构建期保障,当前即强制;
 * 2. 中文残留:扫描 src/**\/*.{ts,tsx} 中含 CJK 的非注释行(白名单:字典/demo/测试),
 *    输出 文件:行号 清单,供 P1 分批替换消化;
 * 3. --strict 时残留计为失败;当前默认仅报告(P1 全量替换完成后切 strict)。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const srcDir = join(root, 'src')
const strict = process.argv.includes('--strict')

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
const LOCALE_FILES = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko']

// 白名单目录/文件模式(字典与演示数据本身含中文,测试 fixtures 同理)。
const WHITELIST = [
  join(srcDir, 'i18n', 'locales'),
  join(srcDir, 'demo'),
]
const WHITELIST_FILE = [
  /\.test\.tsx?$/,
  /lunar-javascript\.d\.ts$/,
  // 农历专名数据模块(月名/日名/节气/节日/干支等中文专名,多语言无标准对应,保留中文)。
  /(?:^|[\\/])lunar\.ts$/,
  /(?:^|[\\/])huangli\.ts$/,
]

let failed = false

// —— 1. 字典 key 一致性 ——
function extractKeys(file) {
  const text = readFileSync(file, 'utf8')
  const keys = new Set()
  for (const m of text.matchAll(/'([a-z][\w.-]*?)':/g)) keys.add(m[1])
  return keys
}

const zhKeys = extractKeys(join(srcDir, 'i18n', 'locales', 'zh-CN.ts'))
for (const lang of LOCALE_FILES.slice(1)) {
  const keys = extractKeys(join(srcDir, 'i18n', 'locales', `${lang}.ts`))
  const missing = [...zhKeys].filter((k) => !keys.has(k))
  const extra = [...keys].filter((k) => !zhKeys.has(k))
  if (missing.length) {
    failed = true
    console.error(`[dict:${lang}] 缺少 ${missing.length} 个 key:`)
    for (const k of missing) console.error(`  - ${k}`)
  }
  if (extra.length) {
    failed = true
    console.error(`[dict:${lang}] 多出 ${extra.length} 个 key(zh-CN 无此 key):`)
    for (const k of extra) console.error(`  - ${k}`)
  }
  if (!missing.length && !extra.length) {
    console.log(`[dict:${lang}] OK(${keys.size} keys)`)
  }
}
console.log(`[dict:zh-CN] ${zhKeys.size} keys(真源)`)

// —— 2. 中文残留扫描 ——
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function isWhitelisted(file) {
  if (WHITELIST.some((d) => file.startsWith(d))) return true
  return WHITELIST_FILE.some((re) => re.test(file))
}

/** 判断一行是否为注释(粗判:去引号内容前的形态)。 */
function isCommentLine(line) {
  const t = line.trim()
  if (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('<!--') ||
    t.startsWith('{/*')
  ) {
    return true
  }
  // 行尾注释:code // 中文 —— 仅当前面没有字符串里的 "://" 时剥离再判。
  const idx = t.indexOf(' //')
  if (idx > 0 && !t.slice(0, idx).includes('://') && !CJK.test(t.slice(0, idx))) {
    return true
  }
  return false
}

// 控制台输出与 ErrorBoundary 标识符 label 非用户可见文案,豁免。
const CONSOLE_RE = /console\.(log|warn|error|info|debug)\s*\(/
const BOUNDARY_LABEL_RE = /<ErrorBoundary\b[^>]*\blabel="/

// 行级豁免标记:注册表中文名参考、种子数据等有意保留的中文,行尾加 // i18n-allow。
const ALLOW_MARKER = /\bi18n-allow\b/

const residue = []
for (const file of walk(srcDir)) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  if (isWhitelisted(file)) continue
  const rel = relative(root, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  // 跨行块注释状态:/* ... */ 中间行不参与残留判定(粗判,不解析字符串)。
  let inBlockComment = false
  lines.forEach((line, i) => {
    let probe = line
    if (inBlockComment) {
      const end = probe.indexOf('*/')
      if (end === -1) return
      inBlockComment = false
      probe = probe.slice(end + 2)
    }
    // 剥离本行内完整的块注释段(可能多段),若以未闭合的 /* 结尾则进入块注释态。
    for (;;) {
      const start = probe.indexOf('/*')
      if (start === -1) break
      const end = probe.indexOf('*/', start + 2)
      if (end === -1) {
        inBlockComment = true
        probe = probe.slice(0, start)
        break
      }
      probe = probe.slice(0, start) + probe.slice(end + 2)
    }
    if (!CJK.test(probe)) return
    if (isCommentLine(probe)) return
    if (CONSOLE_RE.test(probe)) return
    if (BOUNDARY_LABEL_RE.test(probe)) return
    if (ALLOW_MARKER.test(probe)) return
    residue.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
}

if (residue.length) {
  console.log(`\n[i18n] 中文残留 ${residue.length} 行(未包 t() 的可见文案,分批替换消化):`)
  for (const r of residue) console.log(`  ${r}`)
  if (strict) failed = true
} else {
  console.log('\n[i18n] 无中文残留')
}

console.log(
  strict
    ? '\n模式:strict(残留视为失败)'
    : '\n模式:report(--strict 可启用残留门禁,P1 全量替换完成后接入 CI)',
)
process.exit(failed ? 1 : 0)
