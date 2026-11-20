/**
 * 桌面组件「今日状态」模块的状态机(替换今日已赚,隐藏薪资隐私)。
 *
 * - 8 种状态按时段自动判定;所有时段由用户配置的上下班/午休时间推算,不写死;
 * - 动态小字分两类:客观系统时间(距干饭/距下班/已打卡/已打工)与
 *   趣味状态计时(已硬撑/已发呆,以进入状态的时间戳为起点,切换即重置);
 * - 「带薪发呆」每天 15:00 ± 随机 30 分钟(按日期确定性种子)触发一次,持续 10 分钟;
 * - 吐槽语录按 8 秒确定性轮换(同一天同一秒全局一致,无需额外状态)。
 */

import type { SalaryConfig } from './SalaryView'
import { t, type LocaleKey } from './i18n'

export type WidgetStateKey =
  | 'newborn' // 刚出土
  | 'working' // 疯狂搬砖
  | 'waiting_meal' // 等饭中
  | 'lunch' // 午休回血
  | 'exhausted' // 电量耗尽
  | 'spacing' // 带薪发呆
  | 'sprint' // 冲刺下班
  | 'free' // 下班自由

export interface WidgetStateDef {
  key: WidgetStateKey
  /** 状态名(词条 key,渲染期 t() 取词)。 */
  name: LocaleKey
  emoji: string
  /** 插图徽章底色 / 状态名文字色。 */
  bg: string
  fg: string
  /** 吐槽语录(词条 key 数组,渲染期 t() 取词,顺序即轮换顺序)。 */
  quips: LocaleKey[]
}

export const WIDGET_STATES: WidgetStateDef[] = [
  {
    key: 'newborn', name: 'widget.state.newborn', emoji: '🌱', bg: '#e8f6df', fg: '#4d8b3d',
    quips: ['widget.quip.newborn.1', 'widget.quip.newborn.2', 'widget.quip.newborn.3', 'widget.quip.newborn.4', 'widget.quip.newborn.5'],
  },
  {
    key: 'working', name: 'widget.state.working', emoji: '💼', bg: '#e3f0ff', fg: '#3d6fa8',
    quips: ['widget.quip.working.1', 'widget.quip.working.2', 'widget.quip.working.3', 'widget.quip.working.4', 'widget.quip.working.5'],
  },
  {
    key: 'waiting_meal', name: 'widget.state.waiting_meal', emoji: '🍚', bg: '#fff1de', fg: '#c07a2a',
    quips: ['widget.quip.waiting_meal.1', 'widget.quip.waiting_meal.2', 'widget.quip.waiting_meal.3', 'widget.quip.waiting_meal.4', 'widget.quip.waiting_meal.5'],
  },
  {
    key: 'lunch', name: 'widget.state.lunch', emoji: '😴', bg: '#efe9ff', fg: '#7a5fc9',
    quips: ['widget.quip.lunch.1', 'widget.quip.lunch.2', 'widget.quip.lunch.3', 'widget.quip.lunch.4', 'widget.quip.lunch.5'],
  },
  {
    key: 'exhausted', name: 'widget.state.exhausted', emoji: '🔋', bg: '#ffe9e3', fg: '#c96f5a',
    quips: ['widget.quip.exhausted.1', 'widget.quip.exhausted.2', 'widget.quip.exhausted.3', 'widget.quip.exhausted.4', 'widget.quip.exhausted.5'],
  },
  {
    key: 'spacing', name: 'widget.state.spacing', emoji: '💭', bg: '#e6f4ff', fg: '#4a7db8',
    quips: ['widget.quip.spacing.1', 'widget.quip.spacing.2', 'widget.quip.spacing.3', 'widget.quip.spacing.4', 'widget.quip.spacing.5'],
  },
  {
    key: 'sprint', name: 'widget.state.sprint', emoji: '🚀', bg: '#ffe8f0', fg: '#d85588',
    quips: ['widget.quip.sprint.1', 'widget.quip.sprint.2', 'widget.quip.sprint.3', 'widget.quip.sprint.4', 'widget.quip.sprint.5'],
  },
  {
    key: 'free', name: 'widget.state.free', emoji: '🌙', bg: '#e6ecff', fg: '#4a5fb8',
    quips: ['widget.quip.free.1', 'widget.quip.free.2', 'widget.quip.free.3', 'widget.quip.free.4', 'widget.quip.free.5'],
  },
]

const STATE_MAP: Record<WidgetStateKey, WidgetStateDef> = Object.fromEntries(
  WIDGET_STATES.map((d) => [d.key, d]),
) as Record<WidgetStateKey, WidgetStateDef>

export function stateDef(key: WidgetStateKey): WidgetStateDef {
  return STATE_MAP[key] ?? STATE_MAP.working
}

/** 'HH:MM' → 当日秒数(非法返回 NaN)。 */
function hmToSec(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm ?? '')
  if (!m) return NaN
  return Number(m[1]) * 3600 + Number(m[2]) * 60
}

/** 当天秒数。 */
function secOfDay(now: Date): number {
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
}

/** 带薪发呆窗口:每天 15:00 ± 随机 30 分钟(按日期种子),持续 10 分钟;夹取到工作时段内。 */
function spacingWindow(now: Date, end: number, floorSec: number): { s: number; e: number } | null {
  const dayIndex = Math.floor(now.getTime() / 86400000)
  const seed = Math.abs(Math.sin(dayIndex * 9301 + 49297)) % 1
  const base = 15 * 3600 + seed * 1800
  const lo = Math.max(floorSec, base - 900)
  const hi = Math.min(end - 600, base + 1800 + 600)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null
  const s = Math.min(Math.max(base, lo), Math.max(lo, hi - 600))
  return { s, e: s + 600 }
}

/**
 * 按用户配置推算当前应处的状态。
 * 午休未配置/无效时跳过 等饭中/午休回血;休息日直接判定为 下班自由。
 */
export function computeAutoStateKey(cfg: SalaryConfig, now: Date): WidgetStateKey {
  const start = hmToSec(cfg.workStart)
  const end = hmToSec(cfg.workEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'free'
  if (!cfg.workdays[now.getDay()]) return 'free'
  const s = secOfDay(now)
  if (s >= end || s < start) return 'free'

  // 午休(夹取到工作时段内,与 computeDay 同规则)
  let ls = hmToSec(cfg.lunchStart)
  let le = hmToSec(cfg.lunchEnd)
  const hasLunch = Number.isFinite(ls) && Number.isFinite(le) && le > ls && le > start && ls < end
  if (hasLunch) {
    ls = Math.max(ls, start)
    le = Math.min(le, end)
  }

  // 带薪发呆窗口(在午休结束/上班2h 之后、下班前 10min 之前)
  const floorSec = hasLunch ? Math.max(le, start + 2 * 3600) : start + 2 * 3600
  const sw = spacingWindow(now, end, floorSec)
  if (sw && s >= sw.s && s < sw.e) return 'spacing'

  const newbornEnd = start + 2 * 3600
  if (hasLunch) {
    const mealSoon = ls - 30 * 60
    if (s < mealSoon) return s < newbornEnd ? 'newborn' : 'working'
    if (s < ls) return 'waiting_meal'
    if (s < le) return 'lunch'
    const sprintStart = Math.max(le, end - 3600)
    if (s < sprintStart) return 'exhausted'
    return 'sprint'
  }
  const sprintStart = Math.max(newbornEnd, end - 3600)
  if (s < newbornEnd) return 'newborn'
  if (s < sprintStart) return 'working'
  return 'sprint'
}

/** 吐槽语录:按 8 秒确定性轮换。 */
export function quipFor(key: WidgetStateKey, now: Date): string {
  const quips = stateDef(key).quips
  return t(quips[Math.floor(now.getTime() / 8000) % quips.length])
}

/** 秒 → 'X 小时 X 分'(不足 1 小时只给分)。 */
export function fmtHmShort(sec: number): string {
  const v = Math.max(0, Math.floor(sec))
  const h = Math.floor(v / 3600)
  const m = Math.floor((v % 3600) / 60)
  return h >= 1 ? t('widget.dur.hm', { h, m }) : t('widget.dur.m', { m })
}

/** 秒 → 'X 分 X 秒'。 */
export function fmtMs(sec: number): string {
  const v = Math.max(0, Math.floor(sec))
  const m = Math.floor(v / 60)
  const s = v % 60
  return m >= 1 ? t('widget.dur.ms', { m, s }) : t('widget.dur.s', { s })
}

/**
 * 状态动态小字。区分客观系统时间与趣味状态计时(enterAt 为进入当前状态的时间戳)。
 * @param workedSec 今日已工作秒数(computeDay)
 */
export function stateSubtitle(
  key: WidgetStateKey,
  cfg: SalaryConfig,
  now: Date,
  workedSec: number,
  enterAt: number,
): string {
  const s = secOfDay(now)
  const start = hmToSec(cfg.workStart)
  const end = hmToSec(cfg.workEnd)
  let ls = hmToSec(cfg.lunchStart)
  let le = hmToSec(cfg.lunchEnd)
  const hasLunch = Number.isFinite(ls) && Number.isFinite(le) && le > ls
  if (hasLunch) {
    ls = Math.max(ls, start)
    le = Math.min(le, end)
  }
  switch (key) {
    case 'newborn':
      return t('widget.sub.checkedIn', { t: fmtHmShort(workedSec) })
    case 'working': {
      const base = t('widget.sub.focus', { t: fmtHmShort(workedSec) })
      return hasLunch && s < ls
        ? t('widget.sub.focusLunch', { t: base, n: Math.max(1, Math.ceil((ls - s) / 60)) })
        : base
    }
    case 'waiting_meal': {
      // 倒计时(递减):目标取午休开始;无午休配置时回退到下班(下午下班)
      const mealTarget = hasLunch ? ls : end
      return t('widget.sub.toMeal', { n: Math.max(1, Math.ceil((mealTarget - s) / 60)) })
    }
    case 'lunch': {
      // 正在回血(递增):从午休开始算已休息时长
      const em = Math.max(0, Math.floor((s - ls) / 60))
      return em < 1 ? t('widget.sub.recovering') : t('widget.sub.recoveringN', { n: em })
    }
    case 'exhausted':
      return t('widget.sub.enduring', { t: fmtHmShort((now.getTime() - enterAt) / 1000) })
    case 'spacing':
      return t('widget.sub.zoning', { t: fmtMs((now.getTime() - enterAt) / 1000) })
    case 'sprint':
      return t('widget.sub.toFree', { t: fmtMs(Math.max(0, end - s)) })
    case 'free':
      return s >= end && cfg.workdays[now.getDay()]
        ? t('widget.sub.worked', { t: fmtHmShort(workedSec) })
        : t('widget.sub.restDay')
  }
}
