import { Solar, Lunar, HolidayUtil } from 'lunar-javascript'

/** YYYY-MM-DD(本地日)。 */
const pad2 = (n: number) => String(n).padStart(2, '0')
export function hlKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** 公历日期 → Date(本地零点),供计算天数差。 */
function toDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d)
}
function daysBetween(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  const ta = toDate(a.year, a.month, a.day).getTime()
  const tb = toDate(b.year, b.month, b.day).getTime()
  return Math.round((tb - ta) / 86_400_000)
}

// ---------------------------------------------------------------------------
// 月历格子
// ---------------------------------------------------------------------------

export type HlBadge = 'rest' | 'work' | null
export type HlSubType = 'festival' | 'term' | 'lunar'

/** 月历格子里放行的「其他纪念日」白名单(其余只在详情「节日」行显示,保持格子清爽)。 */
const GRID_OTHER_FESTS = new Set([
  '世界粮食日',
  '世界环境日',
  '世界地球日',
  '世界无烟日',
  '世界读书日',
  '世界水日',
  '世界旅游日',
  '全国爱牙日',
  '全国爱眼日',
  '全国高血压日',
  '国际残疾人日',
  '世界艾滋病日',
])

export interface HlCell {
  key: string
  day: number
  weekend: boolean
  today: boolean
  badge: HlBadge
  /** 徽章是否来自法定节假日(红色);false 表示普通周末(粉色)。 */
  badgeLegal: boolean
  /** 日期数字下的说明行:节日/节气/农历日。 */
  sub: string
  subType: HlSubType
}

/** 农历月天数(29 或 30):用 Lunar.fromYmd 试探 29/30 号是否合法。 */
function lunarMonthDays(lunarYear: number, lunarMonth: number): number {
  let max = 29
  for (let d = 29; d <= 30; d++) {
    try {
      const probe: any = Lunar.fromYmd(lunarYear, lunarMonth, d)
      if (probe.getDay() === d) max = d
    } catch {
      break
    }
  }
  return max
}

/**
 * 生成某月日历格子(周一起始)。开头留空,与参考图一致(不补上月日期)。
 */
export function getMonthCells(year: number, month: number, todayKey: string): (HlCell | null)[] {
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: (HlCell | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const s: any = Solar.fromYmd(year, month, d)
    const l: any = s.getLunar()
    const dow = new Date(year, month - 1, d).getDay()
    const weekend = dow === 0 || dow === 6
    const key = hlKey(year, month, d)

    // 法定节假日徽章:无官方数据时,周末按「休」显示(与参考图一致)。
    const h: any = HolidayUtil.getHoliday(year, month, d)
    let badge: HlBadge = null
    let badgeLegal = false
    if (h) {
      badge = h.isWork() ? 'work' : 'rest'
      badgeLegal = !h.isWork()
    } else if (weekend) {
      badge = 'rest'
      badgeLegal = false
    }

    // 说明行优先级:法定节假日名(仅起始日) > 公历/农历主要节日 > 节气 > 其他纪念日 > 农历日
    let sub = ''
    let subType: HlSubType = 'lunar'
    const solarFest: string[] = s.getFestivals() ?? []
    const lunarFest: string[] = l.getFestivals() ?? []
    const otherFest: string[] = [...(s.getOtherFestivals?.() ?? []), ...(l.getOtherFestivals?.() ?? [])]
    const jieQi: string = l.getJieQi() ?? ''
    let legalName: string | null = null
    if (h && !h.isWork()) {
      try {
        const parts = String(h.toString()).split(' ')
        if (parts.length >= 3 && parts[0] === parts[2]) legalName = parts[1]
      } catch {
        legalName = null
      }
    }
    if (legalName) {
      sub = legalName
      subType = 'festival'
    } else if (solarFest.length > 0) {
      sub = solarFest[0]
      subType = 'festival'
    } else if (lunarFest.length > 0) {
      sub = lunarFest[0]
      subType = 'festival'
    } else if (jieQi) {
      sub = jieQi
      subType = 'term'
    } else if (otherFest.some((f) => GRID_OTHER_FESTS.has(f))) {
      sub = otherFest.find((f) => GRID_OTHER_FESTS.has(f))!
      subType = 'term'
    } else {
      // 农历日;农历每月初一显示月名(如「九月」)
      sub =
        l.getDay() === 1
          ? `${l.getMonth() < 0 ? '闰' : ''}${l.getMonthInChinese()}月`
          : l.getDayInChinese()
      subType = 'lunar'
    }

    cells.push({ key, day: d, weekend, today: key === todayKey, badge, badgeLegal, sub, subType })
  }
  return cells
}

// ---------------------------------------------------------------------------
// 详情(万年历)
// ---------------------------------------------------------------------------

export interface HlDetail {
  key: string
  year: number
  month: number
  day: number
  weekCn: string
  lunarMonthDay: string
  lunarMonthLeap: boolean
  /** 农历月大小(30天=大,29天=小)。 */
  lunarMonthSize: '大' | '小'
  lunarFull: string
  yearGZ: string
  shengXiao: string
  xingZuo: string
  monthGZ: string
  dayGZ: string
  festivals: string[]
  yi: string[]
  ji: string[]
  chong: string
  sha: string
  pengZu: string
  taiZhan: string
  yearNaYin: string
  monthNaYin: string
  dayNaYin: string
  season: string
  xiu: string
  xiuLuck: string
  xiuFull: string
  jieQiText: string
  julianDay: number
  buddhistYear: string
  islamic: string
  liuYao: string
  zhiXing: string
  jiShen: string[]
  xiongSha: string[]
  posXi: string
  posCai: string
  dayLu: string
  shuJiu: string
  fu: string
}

const SEASONS = ['冬', '冬', '春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬']

/** 伊斯兰历(乌姆库拉历),失败时返回空串。 */
function islamicDate(y: number, m: number, d: number): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    })
    const parts = fmt.formatToParts(new Date(Date.UTC(y, m - 1, d)))
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}年${get('month')}月${get('day')}日`
  } catch {
    return ''
  }
}

export function getHuangliDetail(year: number, month: number, day: number): HlDetail {
  const s: any = Solar.fromYmd(year, month, day)
  const l: any = s.getLunar()
  const key = hlKey(year, month, day)

  // 节日合集(法定名/公历节日/农历节日/其他纪念日)
  const festivals: string[] = []
  const h: any = HolidayUtil.getHoliday(year, month, day)
  if (h && !h.isWork()) {
    try {
      const parts = String(h.toString()).split(' ')
      if (parts.length >= 3 && parts[0] === parts[2]) festivals.push(parts[1])
    } catch {
      /* ignore */
    }
  }
  for (const f of [...(s.getFestivals() ?? []), ...(l.getFestivals() ?? [])]) {
    if (!festivals.includes(f)) festivals.push(f)
  }
  for (const f of [...(s.getOtherFestivals?.() ?? []), ...(l.getOtherFestivals?.() ?? [])]) {
    if (!festivals.includes(f)) festivals.push(f)
  }

  // 节气:当天是节气 → 「今日霜降」;否则 → 「寒露 第4天(距下一个节气“霜降”,还有12天)」
  let jieQiText = ''
  try {
    const todayJq: string = l.getJieQi() ?? ''
    if (todayJq) {
      jieQiText = todayJq
    } else {
      const prev = l.getPrevJieQi(true)
      const next = l.getNextJieQi(true)
      const prevS = prev.getSolar()
      const nextS = next.getSolar()
      const n = daysBetween({ year: prevS.getYear(), month: prevS.getMonth(), day: prevS.getDay() }, { year, month, day }) + 1
      const remain = daysBetween({ year, month, day }, { year: nextS.getYear(), month: nextS.getMonth(), day: nextS.getDay() })
      jieQiText = `${prev.getName()} 第${n}天(距下一个节气“${next.getName()}”,还有${remain}天)`
    }
  } catch {
    jieQiText = ''
  }

  // 冲:DayChongDesc 形如 "(壬子)鼠" → 提取干支,组成 鼠（壬子）
  let chong = ''
  try {
    const desc: string = l.getDayChongDesc() ?? ''
    const gz = /\(([^)]+)\)/.exec(desc)?.[1] ?? ''
    chong = `${l.getDayChongShengXiao()}${gz ? `（${gz}）` : ''}`
  } catch {
    chong = ''
  }

  // 二十八宿:星宿（星日马） + 吉凶
  let xiuFull = ''
  try {
    xiuFull = `${l.getXiu()}${l.getZheng()}${l.getAnimal()}`
  } catch {
    xiuFull = ''
  }

  let shuJiu = ''
  try {
    const sj = l.getShuJiu()
    shuJiu = sj ? sj.toString() : ''
  } catch {
    shuJiu = ''
  }
  let fu = ''
  try {
    const f = l.getFu()
    fu = f ? f.toString() : ''
  } catch {
    fu = ''
  }

  return {
    key,
    year,
    month,
    day,
    weekCn: s.getWeekInChinese(),
    lunarMonthDay: `${l.getMonth() < 0 ? '闰' : ''}${l.getMonthInChinese()}月${l.getDayInChinese()}`,
    lunarMonthLeap: l.getMonth() < 0,
    lunarMonthSize: lunarMonthDays(l.getYear(), l.getMonth()) === 30 ? '大' : '小',
    lunarFull: l.toString?.() ?? '',
    yearGZ: l.getYearInGanZhi(),
    shengXiao: l.getYearShengXiao(),
    xingZuo: `${s.getXingZuo?.() ?? ''}座`,
    monthGZ: l.getMonthInGanZhi(),
    dayGZ: l.getDayInGanZhi(),
    festivals,
    yi: l.getDayYi() ?? [],
    ji: l.getDayJi() ?? [],
    chong,
    sha: l.getDaySha(),
    pengZu: `${l.getPengZuGan()}，${l.getPengZuZhi()}`,
    taiZhan: l.getDayPositionTai(),
    yearNaYin: l.getYearNaYin(),
    monthNaYin: l.getMonthNaYin(),
    dayNaYin: l.getDayNaYin(),
    season: SEASONS[month - 1] + '季',
    xiu: l.getXiu(),
    xiuLuck: l.getXiuLuck(),
    xiuFull,
    jieQiText,
    julianDay: s.getJulianDay(),
    buddhistYear: `${year + 544}年`,
    islamic: islamicDate(year, month, day),
    liuYao: l.getLiuYao?.() ?? '',
    zhiXing: l.getZhiXing() ?? '',
    jiShen: l.getDayJiShen?.() ?? [],
    xiongSha: l.getDayXiongSha?.() ?? [],
    posXi: `${l.getDayPositionXi?.() ?? ''}${l.getDayPositionXiDesc?.() ?? ''}`,
    posCai: `${l.getDayPositionCai?.() ?? ''}${l.getDayPositionCaiDesc?.() ?? ''}`,
    dayLu: l.getDayLu?.() ?? '',
    shuJiu,
    fu,
  }
}
