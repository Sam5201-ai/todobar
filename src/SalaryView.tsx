/**
 * 牛马计薪器:按秒实时估算「今天上班到此刻赚了多少钱」。
 *
 * - 计薪公式:今日已赚 = 今日已工作秒数 ÷ 今日有效工作秒数 × 日工资(实时比例,非固定累加);
 * - 日工资:月薪 = 月薪×12÷(52×每周工作天数);周薪 = 周薪÷每周工作天数;时薪 = 时薪×当日工时;
 * - 状态机:休息日(金额 0)→ 上班前(0)→ 工作中(实时)→ 午休(冻结)→ 下班后(锁定为当日应得);
 * - 配置只存本地(localStorage),不进云端同步;
 * - 界面风格跟随工作区主题变量(--ink/--muted/--line/--control-bg 等),浅色/深色自适应。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './SalaryView.css'
import { Check, Settings, X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { loadDiskPref, saveDiskPref } from './prefs'
import { useAccount } from './membership'
import { memberOnly } from './account'
import { VipBadge } from './VipBadge'
import {
  loadSalaryWidgetConfig,
  saveSalaryWidgetConfigLocal,
  normalizeStyle,
  WIDGET_STYLES,
  type SalaryWidgetConfig,
  type WidgetStyle,
} from './salaryWidgetConfig'
// 三套组件样式的预览截图(构建期由 dist 预览产出,随包内置,选项下方直观展示)
import previewCandy from './assets/widget-preview/candy.png'
import previewWide from './assets/widget-preview/wide.png'
import previewSunset from './assets/widget-preview/sunset.png'

/** 风格 → 预览图。 */
const STYLE_PREVIEWS: Record<WidgetStyle, string> = {
  candy: previewCandy,
  wide: previewWide,
  sunset: previewSunset,
}

// ---------------------------------------------------------------------------
// 配置与本地存储
// ---------------------------------------------------------------------------

type PayMode = 'monthly' | 'weekly' | 'hourly'

export interface SalaryConfig {
  mode: PayMode
  /** 对应模式的金额(元):月薪 / 周薪 / 时薪。 */
  amount: number
  /** 'HH:MM' */
  workStart: string
  workEnd: string
  lunchStart: string
  lunchEnd: string
  /** 长度 7,索引 = JS getDay()(0=周日 … 6=周六)。 */
  workdays: boolean[]
  /**
   * 发薪日期:按计薪方式存三种取值,切换方式互不丢失。
   *  - monthly:每月几号发薪(1~31);
   *  - weekly:每周几发薪(0~6,同 workdays 索引);
   *  - hourly:每天几点发薪('HH:MM')。
   */
  payDay: { monthly: number; weekly: number; hourly: string }
}

export const STORE_KEY = 'ticktask.salaryConfig.v1'

const DEFAULT_CONFIG: SalaryConfig = {
  mode: 'monthly',
  amount: 8000,
  workStart: '09:00',
  workEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  workdays: [false, true, true, true, true, true, false],
  payDay: { monthly: 15, weekly: 5, hourly: '18:00' },
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function loadConfig(): SalaryConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const c = JSON.parse(raw) as Partial<SalaryConfig>
    if (!c || !Array.isArray(c.workdays) || c.workdays.length !== 7) return { ...DEFAULT_CONFIG }
    const wd: boolean[] = c.workdays
    return {
      mode: c.mode === 'weekly' || c.mode === 'hourly' ? c.mode : 'monthly',
      amount: Number(c.amount) > 0 ? Number(c.amount) : DEFAULT_CONFIG.amount,
      workStart: typeof c.workStart === 'string' ? c.workStart : DEFAULT_CONFIG.workStart,
      workEnd: typeof c.workEnd === 'string' ? c.workEnd : DEFAULT_CONFIG.workEnd,
      lunchStart: typeof c.lunchStart === 'string' ? c.lunchStart : DEFAULT_CONFIG.lunchStart,
      lunchEnd: typeof c.lunchEnd === 'string' ? c.lunchEnd : DEFAULT_CONFIG.lunchEnd,
      workdays: DEFAULT_CONFIG.workdays.map((d, i) => (typeof wd[i] === 'boolean' ? (wd[i] as boolean) : d)),
      payDay: {
        monthly: clampInt(Number((c as { payDay?: { monthly?: number } }).payDay?.monthly), 1, 31, DEFAULT_CONFIG.payDay.monthly),
        weekly: clampInt(Number((c as { payDay?: { weekly?: number } }).payDay?.weekly), 0, 6, DEFAULT_CONFIG.payDay.weekly),
        hourly:
          typeof (c as { payDay?: { hourly?: unknown } }).payDay?.hourly === 'string'
            ? String((c as { payDay?: { hourly?: string } }).payDay!.hourly)
            : DEFAULT_CONFIG.payDay.hourly,
      },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

// ---------------------------------------------------------------------------
// 时间 / 金额工具
// ---------------------------------------------------------------------------

/** 'HH:MM' → 当日秒数(支持 24:00);非法返回 NaN。 */
function hmToSec(s: string): number {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.trim())
  if (!m) return NaN
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60
  return sec >= 0 && sec <= 24 * 3600 ? sec : NaN
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (x: number) => String(x).padStart(2, '0')
  return `${String(h).padStart(2, '0')}:${p(m)}:${p(ss)}`
}

// ---------------------------------------------------------------------------
// 当日计薪核心
// ---------------------------------------------------------------------------

export type SalaryStatus = 'invalid' | 'rest' | 'before' | 'working' | 'lunch' | 'after'

export interface DayStat {
  status: SalaryStatus
  /** 今日已工作秒数。 */
  workedSec: number
  /** 今日有效工作秒数(扣除午休)。 */
  totalSec: number
  earned: number
  dailyPay: number
  hourlyPay: number
  /** 倒计时秒数(before=距上班;working/lunch=距下班;其余 0)。 */
  remainSec: number
}

export function computeDay(cfg: SalaryConfig, now: Date): DayStat {
  const weekDays = cfg.workdays.filter(Boolean).length
  const start = hmToSec(cfg.workStart)
  const end = hmToSec(cfg.workEnd)
  let ls = hmToSec(cfg.lunchStart)
  let le = hmToSec(cfg.lunchEnd)
  const lunchRaw = Number.isFinite(ls) && Number.isFinite(le) && le > ls
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || weekDays === 0) {
    return { status: 'invalid', workedSec: 0, totalSec: 0, earned: 0, dailyPay: 0, hourlyPay: 0, remainSec: 0 }
  }
  // 午休夹取到工作时段内,越界部分不计
  if (lunchRaw) {
    ls = Math.max(ls, start)
    le = Math.min(le, end)
  }
  const lunchSec = lunchRaw && le > ls ? le - ls : 0
  const totalSec = Math.max(0, end - start - lunchSec)

  const dailyPay =
    cfg.mode === 'monthly'
      ? (cfg.amount * 12) / (52 * weekDays)
      : cfg.mode === 'weekly'
        ? cfg.amount / weekDays
        : (totalSec / 3600) * cfg.amount
  const hourlyPay = totalSec > 0 ? dailyPay / (totalSec / 3600) : 0

  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  const isWorkday = !!cfg.workdays[now.getDay()]
  const earnedOf = (worked: number) => (totalSec > 0 ? (worked / totalSec) * dailyPay : 0)

  if (!isWorkday) {
    return { status: 'rest', workedSec: 0, totalSec, earned: 0, dailyPay, hourlyPay, remainSec: 0 }
  }
  if (nowSec < start) {
    return { status: 'before', workedSec: 0, totalSec, earned: 0, dailyPay, hourlyPay, remainSec: start - nowSec }
  }
  if (nowSec >= end) {
    return { status: 'after', workedSec: totalSec, totalSec, earned: dailyPay, dailyPay, hourlyPay, remainSec: 0 }
  }
  if (lunchSec > 0 && nowSec >= ls && nowSec < le) {
    // 午休:金额冻结在午休开始那一刻
    const worked = Math.max(0, ls - start)
    return { status: 'lunch', workedSec: worked, totalSec, earned: earnedOf(worked), dailyPay, hourlyPay, remainSec: end - nowSec }
  }
  const overlap = nowSec >= le ? lunchSec : 0
  const worked = Math.max(0, nowSec - start - overlap)
  return { status: 'working', workedSec: worked, totalSec, earned: earnedOf(worked), dailyPay, hourlyPay, remainSec: end - nowSec }
}

/** 本月累计已赚(截止当前时刻):从 1 号到今天,过去工作日按整日工资,今天按实时。 */
export function computeMonthEarned(cfg: SalaryConfig, now: Date): number {
  let total = 0
  const today = now.getDate()
  for (let d = 1; d <= today; d++) {
    // 今天用真实当前时间(实时),过去的日期用当日 23:59:59(视为已完成、拿整日工资)
    const dayDate = d === today ? now : new Date(now.getFullYear(), now.getMonth(), d, 23, 59, 59)
    total += computeDay(cfg, dayDate).earned
  }
  return total
}

/** 本周累计已赚(周一为一周起点,截止当前时刻)。 */
export function computeWeekEarned(cfg: SalaryConfig, now: Date): number {
  const dow = now.getDay() // 0=周日 … 6=周六
  const sinceMonday = (dow + 6) % 7
  let total = 0
  for (let i = 0; i <= sinceMonday; i++) {
    const base = new Date(now)
    base.setDate(now.getDate() - i)
    const dayDate =
      i === 0 ? now : new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59)
    total += computeDay(cfg, dayDate).earned
  }
  return total
}

// ---------------------------------------------------------------------------
// 发薪日期:规则描述 + 下一次发薪日
// ---------------------------------------------------------------------------

export interface PayDayInfo {
  /** 发薪规则描述,如「每月 15 号发薪」。 */
  label: string
  /** 下一次发薪的本地日期(若今天即为发薪日则含今天)。 */
  next: Date
}

export function getPayDayInfo(cfg: SalaryConfig, now: Date): PayDayInfo {
  if (cfg.mode === 'monthly') {
    const day = clampInt(cfg.payDay.monthly, 1, 31, DEFAULT_CONFIG.payDay.monthly)
    const y = now.getFullYear()
    const m = now.getMonth()
    let next = new Date(y, m, day, 0, 0, 0)
    if (next.getTime() < startOfDay(now).getTime()) next = new Date(y, m + 1, day, 0, 0, 0)
    return { label: `每月 ${day} 号发薪`, next }
  }
  if (cfg.mode === 'weekly') {
    const target = clampInt(cfg.payDay.weekly, 0, 6, DEFAULT_CONFIG.payDay.weekly)
    const diff = (target - now.getDay() + 7) % 7
    const next = startOfDay(now)
    next.setDate(next.getDate() + diff)
    return { label: `每周${WEEK_LABELS[target]}发薪`, next }
  }
  // hourly:每天指定时间发薪
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(cfg.payDay.hourly.trim())
  const hh = m ? Number(m[1]) : 18
  const mm = m ? Number(m[2]) : 0
  const todayPay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0)
  const next = now.getTime() < todayPay.getTime() ? todayPay : new Date(todayPay.getTime() + 86400000)
  return { label: `每天 ${cfg.payDay.hourly} 发薪`, next }
}

// ---------------------------------------------------------------------------
// 今日寄语:按当天日期确定性抽取,一天内不变,次日自动换新。
// ---------------------------------------------------------------------------

const Q_WORKDAY = [
  '加班不是生活的全部，但努力会让想要的生活更近一点。今天也辛苦啦，牛马也有闪闪发光的一天！💪',
  '每一分钟的坚持，都在悄悄垫高你想要的生活。别小看今天的自己，你已经很棒了。🌟',
  '工作再忙，也别忘了给自己倒杯热水。你认真搬砖的样子，其实挺好看的。☕',
  '今天的疲惫是真实的，但你的努力也是真实的。允许自己慢一点，但别停下。🍃',
  '钱是赚不完的，但今天的你是独一无二的。摸摸头，你已经做得很好了。🧸',
  '每一个准时上班的早晨，都是对生活的一次认真点头。你真的很靠谱。🌅',
  '工资到账时的快乐很短暂，但你为自己拼过的每一秒都很长情。💸',
  '别总盯着还没完成的事，回头看看，今天你也扛住了不少。🫶',
  '打工的日子或许平淡，但认真生活的人自带光芒。今天也辛苦你了。✨',
  '你可以偶尔喊累，但别否定自己的付出。你的坚持，时间都记着。🌻',
  '不是每一份努力都会立刻开花，但每一份认真都在扎根。慢慢来，别急。🌱',
  '今天的你或许疲惫，但也在一点点靠近想要的生活。这就是意义。🚶',
  '屏幕前的你，值得一句：今天辛苦了，剩下的交给时间就好。🕰️',
  '工资条上的数字会清零重来，但你积累的能力不会。继续走吧。📈',
  '忙完这阵就歇歇，别把弦绷得太紧。你不是机器，你是会累的人。🛋️',
]
const Q_MONDAY = [
  '周一确实有点难，但这也是全新一周的入场券。撑过今天，就赢了开头。🎫',
  '不想上班的心情可以理解，但还是来了，这就是成年人的体面。周一快乐，哪怕一点都不快乐。😮‍💨',
  '新的一周，新的机会，新的自己。哪怕只是把今天过好，也足够了。🌤️',
  '周一的闹钟很无情，但你按时起床的样子很有力量。加油，这一周看你的了。⏰',
  '周一综合症不是病，是被生活召唤的证明。喝杯咖啡，我们慢慢启动。☕',
]
const Q_FRIDAY = [
  '周五的每一分钟，都带着周末的味道。再坚持一下，自由就在门口等你。🚪',
  '坚持到周五的你，已经打败了周一那个想放弃的自己。太棒了。🏆',
  '周五不是结束，是给自己的一份交代。辛苦一周，值得好好放松。🍻',
  '屏幕上的光标还在闪，但你的心已经飞向周末了。没关系，快了。✈️',
  '周五的班，上得比哪天都值。因为下班的铃声，是本周最动听的歌。🔔',
]
const Q_WEEKEND = [
  '休息不是偷懒，是给下一周的自己充电。今天好好休息，钱包不涨但快乐在涨。🔋',
  '周末的你，可以什么都不做，只是发呆也很合理。辛苦了一周，该歇歇了。🛏️',
  '今天不上班，但也没有浪费时间，因为你正在认真恢复元气。🌈',
  '休息日不必有产出，躺平也是一种自我关怀。舒服就好。🧘',
  '把工作的自己先放一放，今天只做让自己开心的事。你值得。🍰',
]
const Q_OVERTIME = [
  '加班的夜灯下，你是自己的英雄。别熬太狠，明天还有明天的活。🌙',
  '加班不是常态，但今晚的坚持值得一句辛苦了。早点忙完，早点回家。🏠',
  '灯火通明的办公室里，别忘了也照亮一下自己的心情。💡',
  '每一份加班都有它的意义，但别让它成为全部。累了就歇，天亮再说。🌃',
  '你熬的夜，终会变成想要的生活里的光。但也记得早点睡。🌠',
]
const Q_FISH = [
  '摸鱼不是不负责，是给紧绷的神经透口气。偷得浮生半刻闲，刚刚好。🐟',
  '忙里偷闲是门艺术，你画得挺好。笑一下，继续搬砖。😌',
  '休息是为了走更远的路，摸鱼是为了保持搬砖的手感。开玩笑的，歇会儿吧。😄',
  '偶尔放空不是罪，大脑也需要中场休息。充好电再出发。🔋',
  '工作要认真，休息要心安。这一刻属于你自己。🍵',
]
const Q_PAYDAY = [
  '工资到账的那一秒，觉得世界都温柔了一点。辛苦了，这是你应得的。💰',
  '数字或许不多，但每一分都是你用时间换来的。值得为自己骄傲一下。🧾',
  '发薪日的快乐很朴素，却很真实。犒劳一下今天的自己吧。🎁',
  '钱不是万能的，但今天它证明了你的付出有回响。收下这份认可。📬',
  '看到余额的瞬间，觉得这一个月的疲惫都值了。开心一下，不过分。😊',
]
const Q_OFFWORK = [
  '下班铃一响，今天的工作就圆满交卷。剩下的时间，全部归你。🎒',
  '关上电脑的那一刻，你完成了今天的使命。回家路上慢一点，也温柔一点。🚶',
  '工作留在办公室，生活从这里开始。今天辛苦了，好好享受夜晚。🌆',
  '下班的路是最治愈的路程，因为每一步都离自由更近。🏡',
  '今天的事今天结，明天的事明天再说。现在，是属于你的时间。🌇',
]
const Q_TOOL = [
  '看着数字一点点跳动，才发现自己的时间这么值钱。你值得被认真计价。⏱️',
  '每一秒都在增值的你，才是最宝贵的资产。今天也很有价值。📊',
  '计薪器上的数字会归零，但你今天赚到的经验不会。继续积累吧。🧮',
  '你的努力看得见，连数字都在替你记录。这就是坚持的证据。🔢',
  '钱是赚不完的，但每一秒认真对待的自己，都闪闪发光。💎',
  '工资是努力的回音，今天你听到了吗？辛苦啦，继续发光。📣',
]
const Q_LOW = [
  '有些日子就是很丧，这很正常。允许自己低落，但别忘记明天还会来。🫂',
  '不是每天都得元气满满，偶尔泄气也是人之常情。抱抱自己。🤗',
  '日子会难，但你也比想象中更能扛。今天撑住了，就是胜利。🌧️',
  '累了就停一停，方向还在，路就不会丢。你已经在路上了。🛤️',
  '低谷不是终点，只是上坡前的一段缓冲。休息够了，继续走。🏔️',
]
const Q_MORNING = [
  '新的一天，新的开始，新的机会去靠近想要的生活。开工大吉。🌞',
  '早安，打工人。今天的你比昨天又多了一点经验值，很厉害。☀️',
  '每一个早起的早晨，都是对生活的一次主动选择。今天也要加油呀。🌄',
  '睁开眼就是新的机会，别辜负这个元气满满的自己。早安。🌷',
  '今天的你带着昨天的积累出发，这本身就是一种底气。冲吧。🚀',
]

/** 按日期确定性抽取一条寄语(周一/周五/周末/发薪日使用专属分类,其余工作日混合轮换)。 */
export function pickDailyQuote(cfg: SalaryConfig, now: Date): string {
  const info = getPayDayInfo(cfg, now)
  const isPayday = startOfDay(info.next).getTime() === startOfDay(now).getTime()
  const dow = now.getDay()
  let pool: string[]
  if (isPayday) pool = Q_PAYDAY
  else if (dow === 1) pool = Q_MONDAY
  else if (dow === 5) pool = Q_FRIDAY
  else if (dow === 0 || dow === 6) pool = Q_WEEKEND
  else pool = [...Q_WORKDAY, ...Q_OVERTIME, ...Q_FISH, ...Q_OFFWORK, ...Q_TOOL, ...Q_LOW, ...Q_MORNING]
  const dayIndex = Math.floor(now.getTime() / 86400000)
  return pool[((dayIndex % pool.length) + pool.length) % pool.length]
}

// ---------------------------------------------------------------------------
// 通用底部弹窗(与工具其它底部 popup 动画一致:淡入 + 上滑;关闭 is-closing + 190ms)
// ---------------------------------------------------------------------------

function useSheetClose(onClose: () => void) {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, 190)
  }, [onClose])
  return { closing, requestClose }
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const { closing, requestClose } = useSheetClose(onClose)
  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 界面
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<SalaryStatus, string> = {
  invalid: '请检查计薪设置',
  rest: '休息日,不上班',
  before: '还没上班',
  working: '工作中 · 实时计薪',
  lunch: '摸鱼中（金额冻结）',
  after: '自由了',
}

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

type SheetKey = 'settings' | null

export function SalaryView() {
  const [cfg, setCfg] = useState<SalaryConfig>(loadConfig)
  const [draft, setDraft] = useState<SalaryConfig>(cfg)
  const [now, setNow] = useState(() => new Date())

  const [sheet, setSheet] = useState<SheetKey>(null)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const toastTimer = useRef<number | null>(null)

  /** 页内 toast 统一入口:约 2.8s 自动消失(所有提示都必须有寿命,不许常驻)。 */
  const showSalToast = useCallback((text: string, ok = false) => {
    setToast({ ok, text })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2800)
  }, [])

  // 500ms 刷新一次当前时间,金额按秒级实时变化
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 500)
    return () => window.clearInterval(t)
  }, [])

  // 重装 / 清缓存后 localStorage 会丢失,这里从磁盘持久化(~/.ticktask/prefs.json)回灌
  // 计薪配置,避免「重装后要重新设置」。回灌需同时刷新 draft,否则设置弹窗仍显示默认值。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const s = await loadDiskPref<SalaryConfig>('salary')
      if (s && !cancelled) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch {}
        const next = loadConfig()
        setCfg(next)
        setDraft(next)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 桌面组件(透明悬浮窗)的配置状态:启用开关 + 风格。
  const [widget, setWidget] = useState<SalaryWidgetConfig>(() => loadSalaryWidgetConfig())
  // 会员闸门:受限用户(未登录 / 试用过期未激活)不能启用桌面组件。
  const { fullAccess, showVip } = useAccount()

  // 启动时从磁盘偏好回灌(确保重装/清缓存后状态与上次一致)。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const d = await loadDiskPref<SalaryWidgetConfig>('salaryWidget')
      if (d && !cancelled) setWidget({ enabled: !!d.enabled, style: normalizeStyle(d.style) })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 应用桌面组件配置变更:
   * - 写入 localStorage(即时,组件窗口轮询同步风格)+ 磁盘偏好(跨重装);
   * - 启用 → open_salary_widget(幂等:窗口已存在时只改尺寸,内容变化由组件页
   *   轮询 localStorage 自行刷新;不做 close 后立刻 open —— close 是异步销毁,
   *   同 label 重建会撞「窗口已存在」竞态);关闭 → close_salary_widget。
   */
  const applyWidget = useCallback(
    async (next: SalaryWidgetConfig) => {
      // 会员闸门:受限用户只写「关闭」,不允许拉起组件窗口。
      const enabled = next.enabled && fullAccess
      const effective: SalaryWidgetConfig = { ...next, enabled }
      setWidget(effective)
      saveSalaryWidgetConfigLocal(effective)
      try {
        await saveDiskPref('salaryWidget', effective)
      } catch {
        /* 静默 */
      }
      try {
        if (enabled) {
          // raise:true —— 手动启用时组件短暂置顶露一次脸;否则可能整个开在
          // 主窗口/其它应用后面(skip_taskbar 不进任务栏),用户感知为「没有显示」。
          await invoke('open_salary_widget', { style: effective.style, raise: true })
          // 0.4.37 排障:open 是线程内异步 build,invoke 返回 Ok ≠ 窗口创建成功。
          // 延迟核实窗口是否真的存在,把结果明确告诉用户(此前失败完全静默)。
          await new Promise((r) => window.setTimeout(r, 1200))
          const exists = await invoke<boolean>('salary_widget_exists')
          if (exists) {
            showSalToast('桌面组件已启用', true)
          } else {
            showSalToast('桌面组件窗口创建失败,请重启应用后重试', false)
          }
        } else {
          await invoke('close_salary_widget')
        }
      } catch (e) {
        // 非 Tauri 环境或窗口命令不可用:给用户可见提示,不再只写 console
        console.warn('[salaryWidget] 窗口命令调用失败:', e)
        showSalToast(`桌面组件操作失败:${String(e).slice(0, 60)}`, false)
      }
    },
    [fullAccess],
  )

  // 会员降级/受限:开关随会员状态正常关闭(走 applyWidget 完整路径,配置/窗口/UI 一致),
  // 而不是只杀进程;已关闭时幂等不动作。依赖 widget 使 applyWidget 内 setWidget 后本
  // effect 不再重复触发。
  useEffect(() => {
    if (!fullAccess && widget.enabled) void applyWidget({ ...widget, enabled: false })
  }, [fullAccess, widget, applyWidget])

  const stat = useMemo(() => computeDay(cfg, now), [cfg, now])
  const monthEarned = useMemo(() => computeMonthEarned(cfg, now), [cfg, now])
  const weekEarned = useMemo(() => computeWeekEarned(cfg, now), [cfg, now])
  const payInfo = useMemo(() => getPayDayInfo(cfg, now), [cfg, now])
  const quote = useMemo(() => pickDailyQuote(cfg, now), [cfg, now])
  // 距下次发薪的整天数(0 = 今天发薪)
  const payCountdownLabel = useMemo(() => {
    const days = Math.round((startOfDay(payInfo.next).getTime() - startOfDay(now).getTime()) / 86400000)
    return days <= 0 ? '今天' : `${days} 天`
  }, [payInfo, now])
  const pct = stat.totalSec > 0 ? Math.min(100, (stat.workedSec / stat.totalSec) * 100) : 0

  /** 原生 time 输入只在右侧时钟图标处唤起选择面板,这里点击输入框任意位置都调 showPicker。 */
  function openPicker(e: React.MouseEvent<HTMLInputElement>) {
    const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void }
    try {
      el.showPicker?.()
    } catch {
      /* 老内核不支持则退化为默认行为 */
    }
  }

  const saveDraft = () => {
    void (async () => {
      let ok = true
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(draft))
      } catch {
        ok = false
      }
      try {
        await saveDiskPref('salary', draft)
      } catch {
        ok = false
      }
      if (ok) setCfg(draft)
      // 先关闭设置弹窗,再在页面顶部弹 toast(与全局提示样式一致,约 2.8s 自动消失)
      setSheet(null)
      showSalToast(ok ? '保存成功' : '保存失败', ok)
    })()
  }

  const remainLabel =
    stat.status === 'before' ? '距上班' : stat.status === 'working' || stat.status === 'lunch' ? '距下班' : '下班'
  const remainText =
    stat.status === 'before' || stat.status === 'working' || stat.status === 'lunch'
      ? fmtDur(stat.remainSec)
      : stat.status === 'after'
        ? '已下班'
        : '—'

  const draftInvalid = computeDay(draft, now).status === 'invalid'

  return (
    <div className="sal-view">
      {/* 今日已赚(主数字) */}
      <div className="sal-hero">
        <div className="sal-hero-label">今日已赚</div>
        <div className="sal-hero-amount" aria-live="off">
          <em>¥</em>
          {stat.status === 'invalid' ? '--' : fmtMoney(stat.earned)}
        </div>
        <div className="sal-hero-sub">{STATUS_TEXT[stat.status]}</div>
      </div>

      {/* 工时 / 倒计时 */}
      <div className="sal-stats">
        <div className="sal-stat">
          <span>已工作时长</span>
          <strong>{stat.status === 'invalid' ? '--:--:--' : fmtDur(stat.workedSec)}</strong>
        </div>
        <div className="sal-stat">
          <span>{remainLabel}</span>
          <strong>{stat.status === 'invalid' ? '--:--:--' : remainText}</strong>
        </div>
      </div>

      {/* 今日进度条 */}
      <div className="sal-progress">
        <div className="sal-progress-bar">
          <div className="sal-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="sal-progress-meta">
          <span>今日工作进度</span>
          <span>{pct.toFixed(1)}%</span>
        </div>
      </div>

      {/* 参考单价 + 本周/本月累计已赚 + 发薪日 + 今日寄语 */}
      {stat.status !== 'invalid' ? (
        <div className="sal-rates">
          <span>日薪 ¥{fmtMoney(stat.dailyPay)}</span>
          <span>时薪 ¥{fmtMoney(stat.hourlyPay)}</span>
        </div>
      ) : null}
      {stat.status !== 'invalid' ? (
        <div className="sal-month">
          <span>本周已赚</span>
          <strong>¥{fmtMoney(weekEarned)}</strong>
        </div>
      ) : null}
      {stat.status !== 'invalid' ? (
        <div className="sal-month">
          <span>本月已赚</span>
          <strong>¥{fmtMoney(monthEarned)}</strong>
        </div>
      ) : null}
      {stat.status !== 'invalid' ? (
        <div className="sal-month sal-payday">
          <div className="sal-payday-left">
            <span>{payInfo.label}</span>
            <em>下次发薪 {payInfo.next.getMonth() + 1}月{payInfo.next.getDate()}日</em>
          </div>
          <strong>{payCountdownLabel}</strong>
        </div>
      ) : null}

      <div className="sal-quote">
        <span className="sal-quote-watermark" aria-hidden="true">”</span>
        <div className="sal-quote-head">
          牛马寄语
          <span className="sal-quote-rule" aria-hidden="true" />
        </div>
        <p>{quote}</p>
      </div>

      {/* 计薪设置(底部弹窗) */}
      <button type="button" className="sal-settings-toggle" onClick={() => setSheet('settings')}>
        <Settings size={13} />
        计薪设置
      </button>

      {/* 桌面组件(透明悬浮窗):启用开关 + 三风格选择 */}
      <div className="sal-widget">
        <div className="sal-widget-head">
          <span className="sal-widget-title">
            桌面组件
            {showVip ? <VipBadge /> : null}
          </span>
          <button
            type="button"
            className={`sal-switch ${widget.enabled ? 'is-on' : ''}${fullAccess ? '' : ' is-locked'}`}
            role="switch"
            aria-checked={widget.enabled}
            aria-disabled={fullAccess ? undefined : true}
            aria-label="启用桌面组件"
            onClick={() => {
              if (!fullAccess) {
                showSalToast(memberOnly('桌面组件'))
                return
              }
              void applyWidget({ ...widget, enabled: !widget.enabled })
            }}
          >
            <span className="sal-switch-knob" />
          </button>
        </div>
        <div className={`sal-widget-styles ${widget.enabled ? '' : 'is-dim'}`}>
          {WIDGET_STYLES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={widget.style === s.value ? 'is-selected' : ''}
              onClick={() => {
                if (!fullAccess) {
                  showSalToast(memberOnly('桌面组件'))
                  return
                }
                void applyWidget({ enabled: true, style: s.value })
              }}
            >
              <img src={STYLE_PREVIEWS[s.value]} alt={`${s.label}样式预览`} draggable={false} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="sal-widget-hint">
          {fullAccess
            ? '启用后组件出现在桌面中央,可拖到任意位置;点上方预览即可切换样式,关掉开关即隐藏。'
            : '桌面组件为会员功能,开通会员后可启用并拖到桌面任意位置。'}
        </div>
      </div>

      <div className="sal-note">估算值,不含税社保 · 配置仅保存在本机</div>

      {/* 保存结果 toast(样式与全局 sidebar-toast 一致,固定在页面顶部) */}
      {toast ? (
        <div className={`sal-toast ${toast.ok ? 'is-ok' : 'is-err'}`} role="status" aria-live="polite">
          {toast.ok ? <Check size={13} /> : <X size={13} />}
          {toast.text}
        </div>
      ) : null}

      {/* ===== 计薪设置 底部弹窗 ===== */}
      {sheet === 'settings' ? (
        <Sheet title="计薪设置" onClose={() => setSheet(null)}>
          <div className="sal-field">
            <label>计薪方式</label>
            <div className="sal-seg">
              {(
                [
                  ['monthly', '月薪'],
                  ['weekly', '周薪'],
                  ['hourly', '时薪'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={draft.mode === v ? 'is-selected' : ''}
                  onClick={() => setDraft({ ...draft, mode: v })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 发薪日期:随计薪方式切换输入形态,放在计薪方式下方 */}
          <div className="sal-field">
            <label>发薪日期</label>
            {draft.mode === 'monthly' ? (
              <input
                type="number"
                min={1}
                max={31}
                value={draft.payDay.monthly}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    payDay: { ...draft.payDay, monthly: clampInt(Number(e.target.value), 1, 31, DEFAULT_CONFIG.payDay.monthly) },
                  })
                }
              />
            ) : draft.mode === 'weekly' ? (
              <div className="sal-week">
                {WEEK_LABELS.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    className={draft.payDay.weekly === i ? 'is-selected' : ''}
                    onClick={() => setDraft({ ...draft, payDay: { ...draft.payDay, weekly: i } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="time"
                value={draft.payDay.hourly}
                onClick={openPicker}
                onChange={(e) => setDraft({ ...draft, payDay: { ...draft.payDay, hourly: e.target.value } })}
              />
            )}
            <span className="sal-field-hint">
              {draft.mode === 'monthly' ? '每月固定几号发薪' : draft.mode === 'weekly' ? '选择每周几发薪' : '每天几点发薪'}
            </span>
          </div>

          <div className="sal-field">
            <label>
              {draft.mode === 'monthly' ? '月薪(元)' : draft.mode === 'weekly' ? '周薪(元)' : '时薪(元)'}
            </label>
            <input
              type="number"
              min={0}
              step={draft.mode === 'hourly' ? 1 : 100}
              value={Number.isFinite(draft.amount) ? draft.amount : ''}
              onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
            />
          </div>

          <div className="sal-field-row">
            <div className="sal-field">
              <label>上班时间</label>
              <input
                type="time"
                value={draft.workStart}
                onClick={openPicker}
                onChange={(e) => setDraft({ ...draft, workStart: e.target.value })}
              />
            </div>
            <div className="sal-field">
              <label>下班时间</label>
              <input
                type="time"
                value={draft.workEnd}
                onClick={openPicker}
                onChange={(e) => setDraft({ ...draft, workEnd: e.target.value })}
              />
            </div>
          </div>

          <div className="sal-field-row">
            <div className="sal-field">
              <label>午休开始</label>
              <input
                type="time"
                value={draft.lunchStart}
                onClick={openPicker}
                onChange={(e) => setDraft({ ...draft, lunchStart: e.target.value })}
              />
            </div>
            <div className="sal-field">
              <label>午休结束</label>
              <input
                type="time"
                value={draft.lunchEnd}
                onClick={openPicker}
                onChange={(e) => setDraft({ ...draft, lunchEnd: e.target.value })}
              />
            </div>
          </div>

          <div className="sal-field">
            <label>每周工作日</label>
            <div className="sal-week">
              {WEEK_LABELS.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  className={draft.workdays[i] ? 'is-selected' : ''}
                  onClick={() => {
                    const next = [...draft.workdays]
                    next[i] = !next[i]
                    setDraft({ ...draft, workdays: next })
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {draftInvalid ? (
            <div className="sal-hint sal-hint-err">下班时间需晚于上班时间,且至少选择一个工作日</div>
          ) : null}

          <div className="sheet-actions">
            <button type="button" className="sheet-primary" onClick={saveDraft} disabled={draftInvalid}>
              保存设置
            </button>
          </div>
        </Sheet>
      ) : null}

    </div>
  )
}
