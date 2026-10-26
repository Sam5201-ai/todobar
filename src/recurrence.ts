import type { Recurrence, Task } from './types'
import { isLegalHoliday } from './holidays'

/** YYYY-MM-DD(本地日)。与 App 的 dayKey 约定一致。 */
export function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseYmd(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** ISO 周几:1=周一 … 7=周日。 */
export function isoWeekday(d: Date): number {
  return ((d.getDay() + 6) % 7) + 1
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 该日期是否满足重复规则(忽略 anchor/until)。 */
function matches(rec: Recurrence, d: Date): boolean {
  // 跳过法定节假日:开启且当天为法定节假日时,该发生日不产生。
  if (rec.skipHolidays && isLegalHoliday(d)) return false
  if (rec.freq === 'daily') return true
  if (rec.freq === 'weekly') return (rec.weekdays ?? []).includes(isoWeekday(d))
  if (rec.freq === 'monthly') return rec.monthDay != null && d.getDate() === rec.monthDay
  return false
}

/** 返回 [start, end] 区间内所有发生日(含端点)。 */
export function occurrenceDates(rec: Recurrence, start: Date, end: Date): Date[] {
  const out: Date[] = []
  const lo = atMidnight(start)
  const hi = atMidnight(end)
  if (lo > hi) return out
  const cur = new Date(lo)
  while (cur <= hi) {
    const key = ymd(cur)
    const afterAnchor = !rec.anchorDate || key >= rec.anchorDate
    const beforeUntil = !rec.until || key <= rec.until
    if (afterAnchor && beforeUntil && matches(rec, cur)) out.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/** 判断任务是否为重复模板(带规则且未落具体日期)。 */
export function isTemplate(t: Task): boolean {
  return Boolean(t.recurrence) && !t.dueDate && !t.seriesId
}

/**
 * 把模板投影成窗口内的虚拟实例,并与一次性任务合并返回。
 * - 一次性任务原样保留(recurrence 为空或带具体 dueDate)。
 * - 模板本身不出现在结果里,只出现其发生的虚拟实例。
 * 虚拟实例 id 形如 `templateId@YYYY-MM-DD`,done 由 completedDates 决定。
 */
export function expandRecurrences(tasks: Task[], start: Date, end: Date): Task[] {
  // 重复事项只对「今天及未来」生效:把窗口下界钳制到今天,历史日期不投影。
  const todayStart = atMidnight(new Date())
  const winStart = start < todayStart ? todayStart : start
  const result: Task[] = []
  for (const t of tasks) {
    if (isTemplate(t) && t.recurrence) {
      // 整个窗口在历史中(罕见,如回看过去的某天)则不产生任何实例。
      if (winStart <= end) {
        const skipped = new Set(t.deletedDates ?? [])
        for (const occ of occurrenceDates(t.recurrence, winStart, end)) {
          const key = ymd(occ)
          // 该发生日已被单独删除,投影时跳过。
          if (skipped.has(key)) continue
          result.push({
            ...t,
            id: `${t.id}@${key}`,
            dueDate: key,
            recurrence: null,
            seriesId: t.id,
            seriesRecurrence: t.recurrence ?? null,
            done: t.completedDates?.includes(key) ?? false,
            parentId: null,
          })
        }
      }
    } else {
      result.push(t)
    }
  }
  return result
}

/** 从虚拟实例 id 解析出 模板id 与 发生日。 */
export function parseInstanceId(id: string): { templateId: string; dateKey: string } | null {
  const at = id.indexOf('@')
  if (at < 0) return null
  return { templateId: id.slice(0, at), dateKey: id.slice(at + 1) }
}

/** 周几短名(索引 0=日 … 6=六),用于规则文案。 */
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** 重复规则的人类可读文案,如「每天」「每周三、周五」「每月15号」。 */
export function recurrenceLabel(rec: Recurrence): string {
  let base = ''
  if (rec.freq === 'daily') base = '每天'
  else if (rec.freq === 'weekly') {
    const days = (rec.weekdays ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((w) => `周${WEEKDAY_SHORT[w % 7]}`)
    base = `每周${days.join('、')}`
  } else if (rec.freq === 'monthly') base = `每月${rec.monthDay ?? 1}号`
  else return ''
  return rec.skipHolidays ? `${base}(节假日除外)` : base
}

/** 从 from 起(含)最近的第一个发生日 key(YYYY-MM-DD),找不到返回 null。 */
export function nextOccurrenceKey(rec: Recurrence, from: Date = new Date()): string | null {
  const end = new Date(from.getFullYear(), from.getMonth() + 2, 0) // 往后两个月
  const occ = occurrenceDates(rec, from, end)
  return occ.length > 0 ? ymd(occ[0]) : null
}
