// 中国法定节假日(全体公民放假)日期表。
// 数据来自国务院办公厅每年发布的《关于 X 年部分节假日安排的通知》。
//
// ── 自动更新机制 ───────────────────────────────────────────────
// 本文件内 BUILTIN_HOLIDAYS 仅是「离线兜底」(保留最近几年,防止弱网/离线时完全失效)。
// 应用启动时 loadHolidays() 会从官方下载站拉取 holidays.json(含最新年份),合并覆盖到
// 运行时内存表 HOLIDAY_MAP 并缓存到 localStorage。因此:
//   • 国务院发布新年安排后,只需刷新下载站上的 holidays.json(跑 scripts/fetch-holidays.mjs
//     解析通知 → 部署),已安装用户下次启动即自动吃到新数据,无需发版。
//   • 未知年份(远程未覆盖且内置也无) isLegalHoliday 一律返回 false(安全降级)。
// 收录的是「实际放假的日期」,已包含调休产生的连休日(春节前后周末连休、中秋国庆合并等)。
// 本表只服务「跳过法定节假日」,不含调休补班日(补班日本身是工作日)。

// 与 App.tsx 中的 OFFICIAL_SITE 保持一致(下载站同源, server.js 对 .json 已开 CORS + no-cache)。
const OFFICIAL_HOLIDAYS_URL = 'https://todobar-app.app.workbuddy.host/holidays.json'

const CACHE_KEY = 'ticktask.holidays.v1'

// 离线兜底:保留最近若干年(与下载站 holidays.json 初始内容一致)。
// 后续年份由远程 holidays.json 提供,不必在此长期维护。
const BUILTIN_HOLIDAYS: Record<number, string[]> = {
  2024: [
    '2024-01-01',
    '2024-02-10', '2024-02-11', '2024-02-12', '2024-02-13', '2024-02-14',
    '2024-02-15', '2024-02-16', '2024-02-17',
    '2024-04-04', '2024-04-05', '2024-04-06',
    '2024-05-01', '2024-05-02', '2024-05-03', '2024-05-04', '2024-05-05',
    '2024-06-08', '2024-06-09', '2024-06-10',
    '2024-09-15', '2024-09-16', '2024-09-17',
    '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04',
    '2024-10-05', '2024-10-06', '2024-10-07',
  ],
  2025: [
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01',
    '2025-02-02', '2025-02-03', '2025-02-04',
    '2025-04-04', '2025-04-05', '2025-04-06',
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
    '2025-05-31', '2025-06-01', '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04',
    '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  ],
  2026: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
}

// 运行时可变的内存表:年 -> 该年放假日 Set。初始化为内置表,loadHolidays 后并入远程数据。
const HOLIDAY_MAP: Record<number, Set<string>> = {}
for (const [y, dates] of Object.entries(BUILTIN_HOLIDAYS)) {
  HOLIDAY_MAP[Number(y)] = new Set(dates)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 判断某个本地日期是否为中国法定节假日(全体公民放假)。 */
export function isLegalHoliday(d: Date): boolean {
  const set = HOLIDAY_MAP[d.getFullYear()]
  return set ? set.has(dateKey(d)) : false
}

interface HolidayCache {
  data: Record<string, string[]>
  at: number
}

function readCache(): HolidayCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as HolidayCache) : null
  } catch {
    return null
  }
}

function writeCache(data: Record<string, string[]>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, at: Date.now() }))
  } catch {
    /* 配额或隐私模式:忽略 */
  }
}

/** 把一份 {年: 日期数组} 合并进运行时内存表(并集:远程覆盖/补充,不删除已有)。 */
function mergeIntoMap(data: Record<string, string[]>): void {
  for (const [y, dates] of Object.entries(data)) {
    const year = Number(y)
    if (!Number.isFinite(year) || !Array.isArray(dates)) continue
    const set = HOLIDAY_MAP[year] ?? new Set<string>()
    for (const d of dates) {
      if (typeof d === 'string') set.add(d)
    }
    HOLIDAY_MAP[year] = set
  }
}

/**
 * 应用启动时调用一次:拉取远程 holidays.json,合并到内存表并缓存。
 * - 先用本地缓存(保证离线/弱网也有较新数据),再请求远程覆盖。
 * - 任何失败均静默降级到内置/缓存,绝不影响主流程。
 */
export async function loadHolidays(): Promise<void> {
  const cache = readCache()
  if (cache?.data) mergeIntoMap(cache.data)
  try {
    const res = await fetch(`${OFFICIAL_HOLIDAYS_URL}?t=${Date.now()}`)
    if (!res.ok) return
    const data = (await res.json()) as Record<string, string[]>
    if (data && typeof data === 'object') {
      mergeIntoMap(data)
      writeCache(data)
    }
  } catch {
    /* 网络失败:保持内置/缓存即可 */
  }
}
