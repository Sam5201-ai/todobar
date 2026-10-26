#!/usr/bin/env node
// 解析国务院办公厅《关于 X 年部分节假日安排的通知》,生成/合并 holidays.json。
//
// 用法:
//   node scripts/fetch-holidays.mjs <gov.cn通知URL> [--year 2027] [--merge <path>] [--out <path>]
//
//   <gov.cn通知URL>  通知正文页,例如 https://www.gov.cn/zhengce/content/202511/content_7047090.htm
//   --year           目标年份(默认从通知标题「2026年」自动提取)
//   --merge          已有的 holidays.json 路径;命中时只更新该年份,保留其它年份
//   --out            输出路径(默认 = --merge 路径,或仓库 release/holidays.json)
//
// 输出:合并后的 holidays.json(按年分组,值为 YYYY-MM-DD 数组),并同时打印到 stdout 摘要。
//
// 原理:通知正文为半结构化文本,7 个假期项(元旦/春节/清明/劳动/端午/中秋/国庆)均形如
//   「X月X日(…)至Y日(…)放假调休,共N天。」或「X月X日放假」(极少见)。
// 用正则提取放假区间并展开为每天日期;「X月X日(…)上班」(调休补班)不含「至」,不会误纳入。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'release', 'holidays.json')

function parseArgs(argv) {
  const args = { url: null, year: null, merge: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--year') args.year = Number(argv[++i])
    else if (a === '--merge') args.merge = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (!a.startsWith('--')) args.url = a
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node fetch-holidays.mjs <gov.cn通知URL> [--year 2027] [--merge <path>] [--out <path>]`)
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      process.exit(1)
    }
  }
  if (!args.url) {
    console.error('缺少 gov.cn 通知 URL。用法见 --help')
    process.exit(1)
  }
  return args
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function expandRange(year, sm, sd, em, ed) {
  const out = []
  const start = new Date(year, sm - 1, sd)
  const end = new Date(year, em - 1, ed)
  if (end < start) throw new Error(`日期区间非法: ${sm}/${sd} → ${em}/${ed}`)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  return out
}

function extractHolidays(text, year) {
  const holidays = new Set()
  // 1) 放假区间:「X月X日(…)至[Z月]Y日」(结束月可省略=同起始月)
  // 注意:结束月必须用「(?:(\d{1,2})月)?」显式判断「月」字是否存在,否则两位结束日(如 23日)
  // 会被错误拆成「月=2、日=3」。
  const rangeRe = /(\d{1,2})月(\d{1,2})日(?:\（[^）]*\）)?至\s*(?:(\d{1,2})月)?(\d{1,2})日/g
  let m
  while ((m = rangeRe.exec(text)) !== null) {
    const sm = Number(m[1])
    const sd = Number(m[2])
    const em = m[3] ? Number(m[3]) : sm
    const ed = Number(m[4])
    for (const d of expandRange(year, sm, sd, em, ed)) holidays.add(d)
  }
  // 2) 单日放假(罕见):「X月X日(…)放假」且其后不是「至」(避免与区间起始重复纳入)
  const singleRe = /(\d{1,2})月(\d{1,2})日(?:\（[^）]*\）)?(?!至)[^。\n]*?放假/g
  while ((m = singleRe.exec(text)) !== null) {
    const sm = Number(m[1])
    const sd = Number(m[2])
    holidays.add(`${year}-${pad(sm)}-${pad(sd)}`)
  }
  return [...holidays].sort()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const res = await fetch(args.url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`通知页 HTTP ${res.status}`)
  const html = await res.text()
  const text = html.replace(/<[^>]+>/g, '')

  let year = args.year
  if (!year) {
    const ym = text.match(/(\d{4})年[^]*?部分节假日安排/)
    if (!ym) throw new Error('无法从通知标题提取年份,请用 --year 指定')
    year = Number(ym[1])
  }

  const dates = extractHolidays(text, year)
  if (dates.length === 0) throw new Error('未解析到任何放假日期,请检查 URL 是否为正确的通知正文页')

  // 合并到已有 holidays.json(若有)
  let merged = {}
  const mergePath = args.merge || (fs.existsSync(DEFAULT_OUT) ? DEFAULT_OUT : null)
  if (mergePath && fs.existsSync(mergePath)) {
    merged = JSON.parse(fs.readFileSync(mergePath, 'utf-8'))
  }
  merged[year] = dates

  const outPath = args.out || mergePath || DEFAULT_OUT
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')

  console.log(`年份: ${year}`)
  console.log(`放假天数: ${dates.length}`)
  console.log(`已写入: ${outPath}`)
  console.log(`该年放假日期: ${dates.join(', ')}`)
  console.log('后续:把更新后的 holidays.json 部署到下载站(重发 release/ 目录),已安装用户下次启动即生效。')
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
