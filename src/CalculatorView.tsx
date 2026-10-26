import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

// ============================================================================
// 通用工具
// ============================================================================

const pad2 = (n: number) => String(n).padStart(2, '0')

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseDayKey(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

function daysBetween(aKey: string, bKey: string): number {
  const a = parseDayKey(aKey).getTime()
  const b = parseDayKey(bKey).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 把浮点噪声收敛到 12 位有效数字,避免 0.1+0.2=0.30000000004 之类展示。 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '错误'
  if (n === 0) return '0'
  const r = Math.round(n * 1e10) / 1e10
  if (Number.isInteger(r)) return String(r)
  return String(parseFloat(r.toPrecision(12)))
}

/** 把输入串转为数值:「N%」按 N/100,其余按 parseFloat。供一元运算(x²、√x、1/x)使用。 */
function numericOf(s: string): number {
  const t = s === '' || s === '-0' ? '0' : s
  if (t.endsWith('%')) return parseFloat(t.slice(0, -1)) / 100
  return parseFloat(t)
}

// ============================================================================
// 表达式求值(支持 + − × ÷ ( ) 与一元负号,带运算优先级)
// ============================================================================

type Tok = string

function tokenize(expr: string): Tok[] {
  // −(U+2212,显示用)与 -(ASCII)等价,统一归一化后再解析。
  const norm = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  const re = /\s*(\d+(?:\.\d+)?|\.\d+|[+\-*/()])\s*/g
  const out: Tok[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(norm)) !== null) out.push(m[1])
  return out
}

function evaluate(expr: string): number {
  const tokens = tokenize(resolvePercent(expr))
  if (tokens.length === 0) throw new Error('空表达式')
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parseExpr(): number {
    let v = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  function parseTerm(): number {
    let v = parseFactor()
    while (peek() === '*' || peek() === '/') {
      const op = next()
      const r = parseFactor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  function parseFactor(): number {
    const t = peek()
    if (t === '-' || t === '+') {
      next()
      return (t === '-' ? -1 : 1) * parseFactor()
    }
    if (t === '(') {
      next()
      const v = parseExpr()
      if (peek() === ')') next()
      return v
    }
    return parseFloat(next())
  }

  const result = parseExpr()
  if (pos < tokens.length) throw new Error('表达式不完整')
  if (!Number.isFinite(result)) throw new Error('计算溢出')
  return result
}

/**
 * 把算式里的「N%」按语义解析为具体数值(返回不含 % 的等价算式):
 * - 前面是 + / − 时:相对左侧结果取百分比(200 + 10% → 200 + (200*(10/100)) = 220);
 * - 前面是 × / ÷ 或独立出现时:即百分数本身(0.01 ÷ 9% → 0.01 ÷ (9/100))。
 * 逐个消解 %,左侧若也含 % 会递归解析,保证连写(200 + 10% + 5%)逐级累计。
 */
function resolvePercent(expr: string): string {
  let s = expr
  while (s.includes('%')) {
    const i = s.indexOf('%')
    const m = /(\d+(?:\.\d+)?|\.\d+)%$/.exec(s.slice(0, i + 1))
    if (!m) throw new Error('表达式错误')
    const numStr = m[1]
    const start = i - numStr.length
    const before = s.slice(0, start).trimEnd()
    const opMatch = /[+\-−×÷]\s*$/.exec(before)
    let replacement: string
    if (opMatch) {
      const op = opMatch[0].trim()
      const prev = before.slice(0, before.length - opMatch[0].length).trimEnd()
      // 一元正负号(位于开头、其他运算符或左括号之后)不构成百分比基数上下文。
      const unary =
        prev === '' || /[+\-−×÷(]$/.test(prev)
      if (!unary && (op === '+' || op === '-' || op === '−')) {
        const base = prev ? evaluate(resolvePercent(prev)) : 0
        replacement = `(${formatNumber(base)}*(${numStr}/100))`
      } else {
        replacement = `(${numStr}/100)`
      }
    } else {
      replacement = `(${numStr}/100)`
    }
    s = s.slice(0, start) + replacement + s.slice(i + 1)
  }
  return s
}

// ============================================================================
// 中国法定节假日(用于工作日计算)
// 2024/2025 为国务院办公厅正式安排;2026 为暂定,以官方公布为准。
// 'off' = 放假, 'work' = 调休补班(周末上班)。
// ============================================================================

function buildChinaHolidays(): Record<string, 'off' | 'work'> {
  const m: Record<string, 'off' | 'work'> = {}
  const off = (s: string, e: string) => {
    const d = new Date(`${s}T00:00:00`)
    const end = new Date(`${e}T00:00:00`)
    while (d.getTime() <= end.getTime()) {
      m[dayKeyOf(d)] = 'off'
      d.setDate(d.getDate() + 1)
    }
  }
  const work = (s: string) => {
    m[s] = 'work'
  }

  // 2024
  off('2024-01-01', '2024-01-01')
  work('2024-02-04')
  off('2024-02-10', '2024-02-17')
  work('2024-02-18')
  off('2024-04-04', '2024-04-06')
  off('2024-05-01', '2024-05-05')
  work('2024-04-28')
  off('2024-06-10', '2024-06-10')
  off('2024-09-15', '2024-09-17')
  work('2024-09-14')
  off('2024-10-01', '2024-10-07')
  work('2024-09-29')
  work('2024-10-12')

  // 2025
  off('2025-01-01', '2025-01-01')
  off('2025-01-28', '2025-02-04')
  work('2025-01-26')
  work('2025-02-08')
  off('2025-04-04', '2025-04-06')
  off('2025-05-01', '2025-05-05')
  work('2025-04-27')
  off('2025-05-31', '2025-06-02')
  off('2025-10-01', '2025-10-08')
  work('2025-09-28')
  work('2025-10-11')

  // 2026(暂定)
  off('2026-01-01', '2026-01-01')
  off('2026-02-15', '2026-02-22')
  work('2026-02-07')
  work('2026-02-28')
  off('2026-04-04', '2026-04-06')
  off('2026-05-01', '2026-05-05')
  work('2026-04-26')
  work('2026-05-09')
  off('2026-06-19', '2026-06-21')
  off('2026-09-25', '2026-09-27')
  off('2026-10-01', '2026-10-07')
  work('2026-09-27')
  work('2026-10-10')

  return m
}

const CHINA_HOLIDAYS = buildChinaHolidays()

/** 内置节假日表覆盖的最后一年;之后的年份尝试联网获取。 */
const BUILT_IN_HOLIDAY_END_YEAR = 2026

// ---- 2027 起的年份:联网获取法定节假日并缓存到本机 --------------------------

const HOLIDAY_CACHE_KEY = 'todobar.holidays.v1'
type HolidayMap = Record<string, 'off' | 'work'>

let remoteHolidays: HolidayMap = {}
try {
  const parsed = JSON.parse(localStorage.getItem(HOLIDAY_CACHE_KEY) ?? '{}') as HolidayMap
  if (parsed && typeof parsed === 'object') remoteHolidays = parsed
} catch {
  remoteHolidays = {}
}

const holidayFetchTried: Record<number, true> = {}

/** 获取某年中国法定节假日(含调休补班);成功返回 true。每次会话只尝试一次。 */
async function fetchYearHolidays(year: number): Promise<boolean> {
  if (holidayFetchTried[year]) return false
  holidayFetchTried[year] = true
  try {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`https://timor.tech/api/holiday/year/${year}`, {
      signal: ctrl.signal,
    })
    window.clearTimeout(timer)
    if (!res.ok) throw new Error('bad status')
    const data = (await res.json()) as {
      holiday?: Record<string, { holiday?: boolean; date?: string }>
    }
    if (!data.holiday) throw new Error('no data')
    const next: HolidayMap = { ...remoteHolidays }
    for (const [mmdd, info] of Object.entries(data.holiday)) {
      const date = info?.date ?? `${year}-${mmdd}`
      next[date.slice(0, 10)] = info?.holiday === false ? 'work' : 'off'
    }
    remoteHolidays = next
    try {
      localStorage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify(next))
    } catch {
      // 缓存写不进也不影响本次计算。
    }
    return true
  } catch {
    return false
  }
}

function isWorkday(key: string): boolean {
  const fixed = CHINA_HOLIDAYS[key] ?? remoteHolidays[key]
  if (fixed) return fixed === 'work'
  const dow = parseDayKey(key).getDay()
  return dow !== 0 && dow !== 6
}

function countWorkdays(fromKey: string, toKey: string): number {
  const a = parseDayKey(fromKey)
  const b = parseDayKey(toKey)
  if (a.getTime() > b.getTime()) return 0
  let count = 0
  const cur = new Date(a)
  while (cur.getTime() <= b.getTime()) {
    if (isWorkday(dayKeyOf(cur))) count += 1
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

/** 周岁 / 月 / 天。 */
function ageFrom(birthKey: string): { years: number; months: number; days: number } | null {
  const birth = parseDayKey(birthKey)
  if (Number.isNaN(birth.getTime())) return null
  const now = new Date()
  if (birth.getTime() > now.getTime()) return null
  let years = now.getFullYear() - birth.getFullYear()
  let months = now.getMonth() - birth.getMonth()
  let days = now.getDate() - birth.getDate()
  if (days < 0) {
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0)
    days += prevMonth.getDate()
    months -= 1
  }
  if (months < 0) {
    years -= 1
    months += 12
  }
  return { years, months, days }
}

// ============================================================================
// 单位换算(线性) + 温度(仿射)
// ============================================================================

type Unit = { key: string; label: string; factor: number }

const LINEAR: Record<string, { label: string; units: Unit[] }> = {
  length: {
    label: '长度',
    units: [
      { key: 'm', label: '米 (m)', factor: 1 },
      { key: 'km', label: '千米 (km)', factor: 1000 },
      { key: 'cm', label: '厘米 (cm)', factor: 0.01 },
      { key: 'mm', label: '毫米 (mm)', factor: 0.001 },
      { key: 'ft', label: '英尺 (ft)', factor: 0.3048 },
      { key: 'mi', label: '英里 (mi)', factor: 1609.344 },
      { key: 'in', label: '英寸 (in)', factor: 0.0254 },
    ],
  },
  weight: {
    label: '重量',
    units: [
      { key: 'kg', label: '千克 (kg)', factor: 1 },
      { key: 'g', label: '克 (g)', factor: 0.001 },
      { key: 'mg', label: '毫克 (mg)', factor: 1e-6 },
      { key: 'lb', label: '磅 (lb)', factor: 0.45359237 },
      { key: 'oz', label: '盎司 (oz)', factor: 0.028349523125 },
    ],
  },
  area: {
    label: '面积',
    units: [
      { key: 'm2', label: '平方米 (m²)', factor: 1 },
      { key: 'km2', label: '平方千米 (km²)', factor: 1e6 },
      { key: 'ha', label: '公顷 (ha)', factor: 10000 },
      { key: 'mu', label: '亩', factor: 666.6666666667 },
      { key: 'ft2', label: '平方英尺 (ft²)', factor: 0.09290304 },
    ],
  },
  volume: {
    label: '体积',
    units: [
      { key: 'l', label: '升 (L)', factor: 1 },
      { key: 'ml', label: '毫升 (mL)', factor: 0.001 },
      { key: 'm3', label: '立方米 (m³)', factor: 1000 },
      { key: 'gal', label: '加仑(美) (gal)', factor: 3.785411784 },
    ],
  },
}

/** 货币:汇率以「1 CNY = ? 外币」为基准,联网实时刷新,失败回退到内置估算。 */
const CURRENCIES = [
  { key: 'CNY', label: '人民币 ¥', symbol: '¥' },
  { key: 'USD', label: '美元 $', symbol: '$' },
  { key: 'EUR', label: '欧元 €', symbol: '€' },
  { key: 'JPY', label: '日元 ¥', symbol: '¥' },
]

// 离线估算(仅供参考):1 CNY ≈ 这些值外币。联网成功后被覆盖。
const FALLBACK_RATES: Record<string, number> = {
  CNY: 1,
  USD: 0.1393,
  EUR: 0.1278,
  JPY: 21.42,
}

function convertCurrency(amount: number, from: string, to: string, rates: Record<string, number>): number {
  const rf = rates[from]
  const rt = rates[to]
  if (!rf || !rt) return NaN
  const inCny = amount / rf
  return inCny * rt
}

function cToF(c: number) {
  return c * 1.8 + 32
}
function fToC(f: number) {
  return (f - 32) / 1.8
}

// ============================================================================
// 计算器视图(三种模式)
// ============================================================================

export function CalculatorView() {
  const [mode, setMode] = useState<'calc' | 'date' | 'unit'>('calc')

  return (
    <div className="cal-view">
      <div className="segmented-control cal-mode">
        <button type="button" className={mode === 'calc' ? 'is-selected' : ''} onClick={() => setMode('calc')}>
          计算
        </button>
        <button type="button" className={mode === 'date' ? 'is-selected' : ''} onClick={() => setMode('date')}>
          日期
        </button>
        <button type="button" className={mode === 'unit' ? 'is-selected' : ''} onClick={() => setMode('unit')}>
          换算
        </button>
      </div>
      {mode === 'calc' && <CalcPad />}
      {mode === 'date' && <DateTools />}
      {mode === 'unit' && <UnitTools />}
    </div>
  )
}

// ----------------------------------------------------------------------------
// 1) 计算器键盘
// ----------------------------------------------------------------------------

type CalcAction =
  | { t: 'digit'; v: string }
  | { t: 'dot' }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'eq' }
  | { t: 'clear' }
  | { t: 'back' }
  | { t: 'neg' }
  | { t: 'pct' }
  | { t: 'inv' }
  | { t: 'sq' }
  | { t: 'sqrt' }

const CALC_KEYS: { label: string; action: CalcAction; cls?: string }[][] = [
  [
    { label: 'C', action: { t: 'clear' }, cls: 'is-clear' },
    { label: '⌫', action: { t: 'back' } },
    { label: '(', action: { t: 'lp' } },
    { label: ')', action: { t: 'rp' } },
    { label: '÷', action: { t: 'op', v: '÷' }, cls: 'is-op' },
  ],
  [
    { label: 'x²', action: { t: 'sq' }, cls: 'is-fn' },
    { label: '√x', action: { t: 'sqrt' }, cls: 'is-fn' },
    { label: '1/x', action: { t: 'inv' }, cls: 'is-fn' },
    { label: '±', action: { t: 'neg' }, cls: 'is-fn' },
    { label: '×', action: { t: 'op', v: '×' }, cls: 'is-op' },
  ],
  [
    { label: '7', action: { t: 'digit', v: '7' } },
    { label: '8', action: { t: 'digit', v: '8' } },
    { label: '9', action: { t: 'digit', v: '9' } },
    { label: '%', action: { t: 'pct' }, cls: 'is-fn' },
    { label: '−', action: { t: 'op', v: '−' }, cls: 'is-op' },
  ],
  [
    { label: '4', action: { t: 'digit', v: '4' } },
    { label: '5', action: { t: 'digit', v: '5' } },
    { label: '6', action: { t: 'digit', v: '6' } },
    { label: '.', action: { t: 'dot' } },
    { label: '+', action: { t: 'op', v: '+' }, cls: 'is-op' },
  ],
  [
    { label: '1', action: { t: 'digit', v: '1' } },
    { label: '2', action: { t: 'digit', v: '2' } },
    { label: '3', action: { t: 'digit', v: '3' } },
    { label: '0', action: { t: 'digit', v: '0' }, cls: 'is-zero' },
    { label: '=', action: { t: 'eq' }, cls: 'is-eq' },
  ],
]

function CalcPad() {
  const [expr, setExpr] = useState('')
  const [current, setCurrent] = useState('0')
  const [evaluated, setEvaluated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 显示区:上方 = 用户完整录入的算式(便于检查),下方 = 实时计算结果。
  const exprEndsWithOp = /[+\-−×÷(]\s*$/.test(expr)
  // 运算符后 current 会重置为 '0' 占位,算式展示时省略这个未输入的 0。
  const typing = evaluated ? '' : current === '0' && exprEndsWithOp ? '' : current
  const formulaText = evaluated ? expr : expr + typing
  const fullExpr = evaluated ? expr : expr + (current === '' ? '' : current)
  const liveResult = useMemo(() => {
    if (evaluated) return null
    try {
      const v = evaluate(fullExpr)
      return Number.isFinite(v) ? formatNumber(v) : null
    } catch {
      return null
    }
  }, [fullExpr, evaluated])
  const display = error ?? (evaluated ? current : (liveResult ?? (current === '' ? '0' : current)))

  const apply = (a: CalcAction) => {
    if (error && a.t !== 'clear' && a.t !== 'back') {
      setError(null)
      setExpr('')
      setCurrent('0')
      setEvaluated(false)
    }

    switch (a.t) {
      case 'digit': {
        const d = a.v
        if (evaluated) {
          setExpr('')
          setCurrent(d === '0' ? '0' : d)
          setEvaluated(false)
          return
        }
        setCurrent((c) => {
          // 已按 % 结尾时继续输入数字 = 撤掉 % 接着编辑该数(9% + 5 → 95)。
          if (c.endsWith('%')) c = c.slice(0, -1)
          if (d === '0') {
            if (c === '0') return '0'
            if (c === '-0') return '-0'
            return c + '0'
          }
          if (c === '0') return d
          if (c === '-0') return '-' + d
          return c + d
        })
        return
      }
      case 'dot': {
        if (evaluated) {
          setExpr('')
          setCurrent('0.')
          setEvaluated(false)
          return
        }
        setCurrent((c) => {
          if (c.endsWith('%')) c = c.slice(0, -1)
          return c.includes('.') ? c : c + '.'
        })
        return
      }
      case 'op': {
        const sym = a.v
        if (evaluated) {
          setExpr(`${current} ${sym} `)
          setCurrent('0')
          setEvaluated(false)
          return
        }
        setExpr((e) => {
          const trimmed = e.replace(/\s+$/, '')
          if (current === '0' && /[+\-−×÷]$/.test(trimmed)) {
            // 仅替换末尾的运算符
            return trimmed.slice(0, -1).replace(/\s+$/, '') + ` ${sym} `
          }
          if (current === '') {
            // 括号已闭合(值已在 expr 中)或 expr 以数字结尾时,允许直接接运算符;
            // 但避免「空开头」或「连续运算符」。
            if (trimmed === '' || /[+\-−×÷]$/.test(trimmed)) return e
            return `${e}${sym} `
          }
          return `${e}${current} ${sym} `
        })
        setCurrent('0')
        return
      }
      case 'lp': {
        if (evaluated) {
          setExpr('(')
          setEvaluated(false)
          setCurrent('')
          return
        }
        setExpr((e) => e + '(')
        setCurrent('')
        return
      }
      case 'rp': {
        // 括号闭合:直接把「)」追加到表达式,数值由实时求值给出。
        setExpr((e) => e + (current === '' ? ')' : `${current})`))
        setCurrent('')
        setEvaluated(false)
        return
      }
      case 'clear': {
        setExpr('')
        setCurrent('0')
        setEvaluated(false)
        setError(null)
        return
      }
      case 'back': {
        if (evaluated) return
        setCurrent((c) => {
          if (c === '' || c === '0') return '0'
          if (c === '-0') return '0'
          const sliced = c.slice(0, -1)
          return sliced === '-' ? '0' : sliced === '' ? '0' : sliced
        })
        return
      }
      case 'neg': {
        setCurrent((c) => {
          const hasPct = c.endsWith('%')
          const body = hasPct ? c.slice(0, -1) : c
          if (body === '0') return hasPct ? c : '-0'
          if (body === '-0') return hasPct ? c : '0'
          const toggled = body.startsWith('-') ? body.slice(1) : '-' + body
          return hasPct ? toggled + '%' : toggled
        })
        return
      }
      case 'pct': {
        // 如实保留「N%」字面量:显示与算式里都是 9%,求值时由 resolvePercent 按上下文解析。
        setCurrent((c) => {
          if (c === '' || c === '0' || c === '-0') return c
          if (c.endsWith('%')) return c
          return c + '%'
        })
        setEvaluated(false)
        return
      }
      case 'inv': {
        setCurrent((c) => {
          const n = numericOf(c)
          if (!Number.isFinite(n) || n === 0) return '错误'
          return formatNumber(1 / n)
        })
        return
      }
      case 'sq': {
        setCurrent((c) => {
          const n = numericOf(c)
          return formatNumber(n * n)
        })
        return
      }
      case 'sqrt': {
        setCurrent((c) => {
          const n = numericOf(c)
          if (!Number.isFinite(n) || n < 0) return '错误'
          return formatNumber(Math.sqrt(n))
        })
        return
      }
      case 'eq': {
        if (evaluated) return
        const full = expr + (current === '' ? '' : current)
        if (full.trim() === '') return
        try {
          const result = evaluate(full)
          if (!Number.isFinite(result)) {
            setError('计算溢出')
            return
          }
          // 保留完整算式在上方便于检查,结果放在下方的 current。
          setExpr(full)
          setCurrent(formatNumber(result))
          setEvaluated(true)
        } catch (err) {
          setError(err instanceof Error ? err.message : '表达式错误')
        }
        return
      }
    }
  }

  // 键盘输入支持(桌面快捷键)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const k = e.key
      if (/[0-9]/.test(k)) apply({ t: 'digit', v: k })
      else if (k === '.') apply({ t: 'dot' })
      else if (k === '+' || k === '-') apply({ t: 'op', v: k })
      else if (k === '*') apply({ t: 'op', v: '×' })
      else if (k === '/') {
        e.preventDefault()
        apply({ t: 'op', v: '÷' })
      } else if (k === '(') apply({ t: 'lp' })
      else if (k === ')') apply({ t: 'rp' })
      else if (k === '%') apply({ t: 'pct' })
      else if (k === 'Enter' || k === '=') {
        e.preventDefault()
        apply({ t: 'eq' })
      } else if (k === 'Backspace') apply({ t: 'back' })
      else if (k === 'Escape') apply({ t: 'clear' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, current, evaluated, error])

  return (
    <div className="calc-pad">
      <div className="calc-display" aria-live="polite">
        <div className="calc-expr">{formulaText ||' '}</div>
        <div className={`calc-current ${error ? 'is-error' : ''}`}>{display}</div>
      </div>
      <div className="calc-grid">
        {CALC_KEYS.flat().map((k, i) => (
          <button
            key={i}
            type="button"
            className={`calc-key ${k.cls ?? ''}`}
            onClick={() => apply(k.action)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="calc-hint">
        支持四则运算、括号、小数与负数;% 按「相对于前一项的百分比」计算(如 200 + 10% = 220)。
      </p>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 2) 日期工具
// ----------------------------------------------------------------------------

function DateTools() {
  const [sub, setSub] = useState<'diff' | 'work' | 'age'>('diff')
  const [holidayTick, setHolidayTick] = useState(0)
  const today = dayKeyOf(new Date())

  const [fromDiff, setFromDiff] = useState(today)
  const [toDiff, setToDiff] = useState(dayKeyOf(new Date(Date.now() + 86400000)))

  const [fromWork, setFromWork] = useState(dayKeyOf(new Date(Date.now() - 86400000 * 3)))
  const [toWork, setToWork] = useState(dayKeyOf(new Date(Date.now() + 86400000 * 7)))

  const [birth, setBirth] = useState('2000-01-01')

  const diffDays = useMemo(() => daysBetween(fromDiff, toDiff), [fromDiff, toDiff])
  const workDays = useMemo(() => countWorkdays(fromWork, toWork), [fromWork, toWork, holidayTick])
  const age = useMemo(() => ageFrom(birth), [birth])

  // 内置节假日表只到 2026;之后的年份尝试联网获取(结果缓存到 localStorage),
  // 获取成功后重新计算工作日。失败则按「仅扣除周末」降级。
  const yearsToFetch = useMemo(() => {
    const years = new Set([Number(fromWork.slice(0, 4)), Number(toWork.slice(0, 4))])
    return [...years].filter((y) => y > BUILT_IN_HOLIDAY_END_YEAR)
  }, [fromWork, toWork])

  useEffect(() => {
    let cancelled = false
    for (const y of yearsToFetch) {
      void fetchYearHolidays(y).then((fetched) => {
        if (!cancelled && fetched) setHolidayTick((t) => t + 1)
      })
    }
    return () => {
      cancelled = true
    }
  }, [yearsToFetch])

  return (
    <div className="cal-date">
      <div className="segmented-control cal-sub">
        <button type="button" className={sub === 'diff' ? 'is-selected' : ''} onClick={() => setSub('diff')}>
          日期差
        </button>
        <button type="button" className={sub === 'work' ? 'is-selected' : ''} onClick={() => setSub('work')}>
          工作日
        </button>
        <button type="button" className={sub === 'age' ? 'is-selected' : ''} onClick={() => setSub('age')}>
          年龄
        </button>
      </div>

      {sub === 'diff' && (
        <div className="cal-tool">
          <label className="cal-row">
            <span>开始日期</span>
            <input type="date" value={fromDiff} max={toDiff} onChange={(e) => setFromDiff(e.target.value)} />
          </label>
          <label className="cal-row">
            <span>结束日期</span>
            <input type="date" value={toDiff} min={fromDiff} onChange={(e) => setToDiff(e.target.value)} />
          </label>
          <div className="cal-result">
            <strong>{Math.abs(diffDays)}</strong> 天
            {diffDays < 0 && <em className="cal-note">（结束早于开始，已取绝对值）</em>}
            <div className="cal-subline">
              ≈ {Math.floor(Math.abs(diffDays) / 7)} 周 {Math.abs(diffDays) % 7} 天
            </div>
          </div>
        </div>
      )}

      {sub === 'work' && (
        <div className="cal-tool">
          <label className="cal-row">
            <span>开始日期</span>
            <input type="date" value={fromWork} max={toWork} onChange={(e) => setFromWork(e.target.value)} />
          </label>
          <label className="cal-row">
            <span>结束日期</span>
            <input type="date" value={toWork} min={fromWork} onChange={(e) => setToWork(e.target.value)} />
          </label>
          <div className="cal-result">
            <strong>{workDays}</strong> 个工作日
            <div className="cal-subline">已自动扣除周六、周日与中国法定节假日(含调休补班)。</div>
          </div>
        </div>
      )}

      {sub === 'age' && (
        <div className="cal-tool">
          <label className="cal-row">
            <span>出生日期</span>
            <input type="date" value={birth} max={today} onChange={(e) => setBirth(e.target.value)} />
          </label>
          <div className="cal-result">
            {age ? (
              <div className="cal-result-line">
                <strong>{age.years}</strong> 岁 <strong>{age.months}</strong> 个月{' '}
                <strong>{age.days}</strong> 天
              </div>
            ) : (
              <em className="cal-note">请选择有效的出生日期。</em>
            )}
          </div>
        </div>
      )}

      <p className="calc-hint">
        法定节假日已内置 2024–{BUILT_IN_HOLIDAY_END_YEAR}（{BUILT_IN_HOLIDAY_END_YEAR}
        为暂定，以国务院办公厅公布为准）；之后的年份会联网自动获取并缓存到本机，离线或获取失败时按周末自动排除。
      </p>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 3) 单位换算
// ----------------------------------------------------------------------------

function UnitTools() {
  const [cat, setCat] = useState<'currency' | 'length' | 'weight' | 'area' | 'temp' | 'volume'>('currency')

  // 货币实时汇率
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES)
  const [rateUpdated, setRateUpdated] = useState<string | null>(null)
  const [rateLive, setRateLive] = useState(false)

  const loadRates = useCallback(async () => {
    try {
      const ctrl = new AbortController()
      const timer = window.setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch('https://open.er-api.com/v6/latest/CNY', { signal: ctrl.signal })
      window.clearTimeout(timer)
      if (!res.ok) throw new Error('bad status')
      const data = (await res.json()) as { rates?: Record<string, number> }
      if (!data.rates) throw new Error('no rates')
      const next: Record<string, number> = { CNY: 1 }
      for (const c of CURRENCIES) {
        if (c.key === 'CNY') continue
        if (typeof data.rates[c.key] === 'number') next[c.key] = data.rates[c.key]
      }
      setRates(next)
      setRateLive(true)
      setRateUpdated(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    } catch {
      setRateLive(false)
      setRateUpdated(null)
    }
  }, [])

  useEffect(() => {
    if (cat === 'currency') void loadRates()
  }, [cat, loadRates])

  // 切换分类时清空单位选择,避免沿用上一个分类的无效单位(如长度的 m/ft 残留到温度)。
  useEffect(() => {
    setFromU('')
    setToU('')
  }, [cat])

  const TEMP_UNITS = [
    { key: 'C', label: '摄氏度 (°C)' },
    { key: 'F', label: '华氏度 (°F)' },
  ]

  // 各分类的单位选项与默认单位(对未知分类做兜底,避免 LINEAR[cat] 为 undefined 时崩溃)
  const linear = cat === 'currency' || cat === 'temp' ? null : (LINEAR[cat]?.units ?? LINEAR.length.units)
  const opts: { key: string; label: string }[] =
    cat === 'currency' ? CURRENCIES : cat === 'temp' ? TEMP_UNITS : linear!
  const defFrom = cat === 'currency' ? 'CNY' : cat === 'temp' ? 'C' : linear![0].key
  const defTo = cat === 'currency' ? 'USD' : cat === 'temp' ? 'F' : linear![1]?.key ?? linear![0].key

  const [amount, setAmount] = useState('1')
  const [fromU, setFromU] = useState('')
  const [toU, setToU] = useState('')

  // 切换分类后,只有「当前分类里确实存在的单位」才沿用选择;否则回退默认单位,
  // 避免残留的旧单位(如长度里的「米 m」切到重量后)查不到 factor 而崩溃。
  const fromKey = opts.some((o) => o.key === fromU) ? fromU : defFrom
  const toKey = opts.some((o) => o.key === toU) ? toU : defTo

  const num = parseFloat(amount)
  const amountValid = !Number.isNaN(num)

  let resultText = '—'
  let rateText = ''
  if (amountValid) {
    if (cat === 'currency') {
      const r = convertCurrency(num, fromKey, toKey, rates)
      if (Number.isFinite(r)) {
        resultText = formatNumber(r)
        const one = convertCurrency(1, fromKey, toKey, rates)
        const fc = CURRENCIES.find((c) => c.key === fromKey)
        const tc = CURRENCIES.find((c) => c.key === toKey)
        // 同时展示双向汇率,便于与银行/行情软件核对(中间价与挂牌价略有差异)。
        const back = Number.isFinite(one) && one !== 0 ? parseFloat((1 / one).toPrecision(6)) : NaN
        rateText = Number.isFinite(back)
          ? `1 ${fc?.symbol ?? fromKey} = ${formatNumber(one)} ${tc?.symbol ?? toKey}（1 ${tc?.symbol ?? toKey} ≈ ${formatNumber(back)} ${fc?.symbol ?? fromKey}）`
          : `1 ${fc?.symbol ?? fromKey} = ${formatNumber(one)} ${tc?.symbol ?? toKey}`
      } else {
        resultText = '汇率缺失'
      }
    } else if (cat === 'temp') {
      let r = NaN
      if (fromKey === 'C' && toKey === 'F') r = cToF(num)
      else if (fromKey === 'F' && toKey === 'C') r = fToC(num)
      else r = num
      resultText = formatNumber(r)
    } else {
      const fu = linear?.find((u) => u.key === fromKey)
      const tu = linear?.find((u) => u.key === toKey)
      if (fu && tu) {
        const base = num * fu.factor
        resultText = formatNumber(base / tu.factor)
      } else {
        resultText = '单位无效'
      }
    }
  }

  const swap = () => {
    setFromU(toKey)
    setToU(fromKey)
  }

  const subCats: { key: typeof cat; label: string }[] = [
    { key: 'currency', label: '货币' },
    { key: 'length', label: '长度' },
    { key: 'weight', label: '重量' },
    { key: 'area', label: '面积' },
    { key: 'temp', label: '温度' },
    { key: 'volume', label: '体积' },
  ]

  return (
    <div className="cal-unit">
      <div className="segmented-control cal-sub cal-sub-6">
        {subCats.map((s) => (
          <button key={s.key} type="button" className={cat === s.key ? 'is-selected' : ''} onClick={() => setCat(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="cal-tool">
        <label className="cal-row">
          <span>数值</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="输入数值"
          />
        </label>

        <div className="cal-convert-line">
          <select value={fromKey} onChange={(e) => setFromU(e.target.value)} aria-label="原单位">
            {opts.map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
          </select>
          <button type="button" className="cal-swap" aria-label="交换单位" onClick={swap}>
            ⇄
          </button>
          <select value={toKey} onChange={(e) => setToU(e.target.value)} aria-label="目标单位">
            {opts.map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
          </select>
        </div>

        <div className="cal-result">
          <strong>{resultText}</strong>
          {cat !== 'temp' && rateText && <div className="cal-subline">{rateText}</div>}
          {cat === 'currency' && (
            <div className="cal-subline">
              {rateLive && rateUpdated
                ? `汇率更新于 ${rateUpdated}（实时）`
                : '当前为离线估算汇率，仅供参考；联网后将自动刷新。'}
              <button type="button" className="cal-refresh" onClick={() => void loadRates()} aria-label="刷新汇率">
                <RefreshCw size={12} /> 刷新
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="calc-hint">
        {cat === 'currency'
          ? '货币按国际中间价实时换算（联网获取）；与银行挂牌价存在正常小幅差异，汇率波动，结果以成交时为准。'
          : '长度/重量/面积/体积按标准换算系数计算；温度为摄氏 ⇆ 华氏。'}
      </p>
    </div>
  )
}
