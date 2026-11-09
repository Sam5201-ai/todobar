/**
 * Cloudflare Workers Free 用量巡检（供后台「服务监控」页面调用）。
 *
 * 与 scripts/usage-check.mjs 使用同一套 GraphQL 口径，但运行在 Worker 内部：
 * Cloudflare → Cloudflare API 属于服务端内网调用，浏览器与用户本机都不需要 VPN。
 * 令牌以 Worker secret（CF_API_TOKEN）注入，绝不下发到前端。
 *
 * 免费版额度（按账户、按 UTC 日）：
 *   Workers 请求 100,000 / 天；D1 读取 5,000,000 行 / 天；
 *   D1 写入 100,000 行 / 天；D1 存储 5 GB（账户内所有数据库合计）。
 */

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const DEFAULT_ACCOUNT_ID = '30b571afc22b411372befbba0492efb3'
const WARN = 0.5
const CRITICAL = 0.8

export const USAGE_LIMITS = {
  requests: 100_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storageBytes: 5 * 1024 ** 3,
} as const

export type UsageKey = keyof typeof USAGE_LIMITS
export type AlertLevel = 0 | 1 | 2

export type UsageMetric = {
  key: UsageKey
  name: string
  current: number
  limit: number
  ratio: number
  level: AlertLevel
  yesterday: number | null
  peak: { date: string; value: number; ratio: number } | null
}

export type UsagePayload = {
  ok: true
  generatedAt: string
  todayUtc: string
  windowStartUtc: string
  windowEndUtc: string
  days: string[]
  limits: typeof USAGE_LIMITS
  series: Record<UsageKey, number[]>
  metrics: UsageMetric[]
  level: AlertLevel
  notes: string[]
  account: {
    workers: { name: string; requests: number }[]
    errorsToday: number
    d1Databases: number
    storageBytes: number
    biggestDb: { id: string; bytes: number } | null
  }
  source: string
}

type GqlRow = {
  sum?: { requests?: number; errors?: number; rowsRead?: number; rowsWritten?: number }
  max?: { databaseSizeBytes?: number }
  dimensions?: { date?: string; scriptName?: string; databaseId?: string }
}

type GqlAccount = {
  wToday?: GqlRow[]
  wHist?: GqlRow[]
  dToday?: GqlRow[]
  dHist?: GqlRow[]
  storage?: GqlRow[]
}

export type UsageEnv = {
  /** 具备 Account Analytics Read 权限的 Cloudflare API Token，用 wrangler secret put 注入。 */
  CF_API_TOKEN?: string
  /** Cloudflare Account ID（非敏感，可放 wrangler.toml [vars]）。 */
  CF_ACCOUNT_ID?: string
}

const levelOf = (r: number): AlertLevel => (r >= CRITICAL ? 2 : r >= WARN ? 1 : 0)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

function sumField(rows: GqlRow[], field: 'requests' | 'errors' | 'rowsRead' | 'rowsWritten') {
  return rows.reduce((s, r) => s + (r.sum?.[field] || 0), 0)
}

/** 把按 (date, scriptName/databaseId) 分组的行汇总成按 UTC 日的数值。 */
function dailyTotals(rows: GqlRow[], fields: ('requests' | 'errors' | 'rowsRead' | 'rowsWritten')[]) {
  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const date = r.dimensions?.date
    if (!date) continue
    const cur = map.get(date) || Object.fromEntries(fields.map((f) => [f, 0]))
    for (const f of fields) cur[f] += r.sum?.[f] || 0
    map.set(date, cur)
  }
  return map
}

function buildQuery(accountId: string, histStart: string, today: string, endNow: string) {
  return `query {
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        wToday: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${today}T00:00:00Z", datetime_leq: "${endNow}" }) {
          sum { requests errors } dimensions { scriptName }
        }
        wHist: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${histStart}T00:00:00Z", datetime_leq: "${endNow}" }) {
          sum { requests errors } dimensions { date scriptName }
        }
        dToday: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: "${today}", date_leq: "${today}" }) {
          sum { rowsRead rowsWritten } dimensions { date databaseId }
        }
        dHist: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: "${histStart}", date_leq: "${today}" }) {
          sum { rowsRead rowsWritten } dimensions { date databaseId }
        }
        storage: d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: "${histStart}", date_leq: "${today}" }) {
          max { databaseSizeBytes } dimensions { date databaseId }
        }
      }
    }
  }`
}

/**
 * 拉取最新可用快照。Cloudflare GraphQL Analytics 有数分钟延迟，
 * 因此「实时」指每次调用都重新向 Cloudflare 取数（无服务端缓存），而非秒级。
 */
export async function fetchUsage(env: UsageEnv, days = 8): Promise<UsagePayload> {
  const token = env.CF_API_TOKEN
  if (!token) {
    throw new Error('服务端未配置 CF_API_TOKEN，请在 Worker 中用 wrangler secret put 注入具备 Account Analytics Read 权限的令牌')
  }
  const accountId = env.CF_ACCOUNT_ID || DEFAULT_ACCOUNT_ID
  const span = Math.min(30, Math.max(7, Math.floor(days)))

  const now = new Date()
  const today = dayOf(now)
  const endNow = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const startMs = Date.parse(`${today}T00:00:00Z`)
  const dayList: string[] = []
  for (let i = span - 1; i >= 0; i--) dayList.push(dayOf(new Date(startMs - i * 86_400_000)))
  const histStart = dayList[0]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  let body: {
    data?: { viewer?: { accounts?: GqlAccount[] } }
    errors?: { message?: string }[]
  }
  try {
    const resp = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: buildQuery(accountId, histStart, today, endNow) }),
      signal: controller.signal,
    })
    const text = await resp.text()
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`Cloudflare API 返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 180)}`)
    }
    if (!resp.ok && !body.errors) throw new Error(`Cloudflare API HTTP ${resp.status}：${text.slice(0, 180)}`)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('查询 Cloudflare Analytics 超时（20s）')
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL 错误：${body.errors.map((e) => e.message || 'unknown').join('；')}`)
  }
  const acc = body.data?.viewer?.accounts?.[0]
  if (!acc) throw new Error('GraphQL 未返回账户数据，请检查 CF_ACCOUNT_ID 与令牌的 Account Analytics Read 权限')

  const wToday = acc.wToday || []
  const dToday = acc.dToday || []
  const storageRows = acc.storage || []
  const wHist = dailyTotals(acc.wHist || [], ['requests', 'errors'])
  const dHist = dailyTotals(acc.dHist || [], ['rowsRead', 'rowsWritten'])

  const todayReq = sumField(wToday, 'requests')
  const todayErrors = sumField(wToday, 'errors')
  const todayRead = sumField(dToday, 'rowsRead')
  const todayWrite = sumField(dToday, 'rowsWritten')

  // D1 存储：按 (date, databaseId) 取当日最大体积；缺数据的日期沿用最近一次快照。
  const byDateDb = new Map<string, Map<string, number>>()
  const latestByDb = new Map<string, { date: string; bytes: number }>()
  for (const r of storageRows) {
    const date = r.dimensions?.date
    const id = r.dimensions?.databaseId
    if (!date || !id) continue
    const bytes = Number(r.max?.databaseSizeBytes || 0)
    let m = byDateDb.get(date)
    if (!m) {
      m = new Map()
      byDateDb.set(date, m)
    }
    m.set(id, Math.max(m.get(id) || 0, bytes))
    const prev = latestByDb.get(id)
    if (!prev || date > prev.date) latestByDb.set(id, { date, bytes })
  }
  const firstSnapshot = byDateDb.get([...byDateDb.keys()].sort()[0] || '') || new Map<string, number>()
  const carry = new Map<string, number>(firstSnapshot)
  const storageSeries = dayList.map((d) => {
    const m = byDateDb.get(d)
    if (m) for (const [id, bytes] of m) carry.set(id, bytes)
    return [...carry.values()].reduce((s, v) => s + v, 0)
  })
  const storageBytes = [...latestByDb.values()].reduce((s, v) => s + v.bytes, 0)
  const biggest = [...latestByDb.entries()].sort((a, b) => b[1].bytes - a[1].bytes)[0]

  const series: Record<UsageKey, number[]> = {
    requests: dayList.map((d) => wHist.get(d)?.requests || 0),
    rowsRead: dayList.map((d) => dHist.get(d)?.rowsRead || 0),
    rowsWritten: dayList.map((d) => dHist.get(d)?.rowsWritten || 0),
    storageBytes: storageSeries,
  }
  // 当日 GraphQL 快照可能比按日聚合略滞后，用更精确的今日计数覆盖最后一个点。
  series.requests[series.requests.length - 1] = todayReq
  series.rowsRead[series.rowsRead.length - 1] = todayRead
  series.rowsWritten[series.rowsWritten.length - 1] = todayWrite
  series.storageBytes[series.storageBytes.length - 1] = storageBytes

  const defs: { key: UsageKey; name: string }[] = [
    { key: 'requests', name: 'Workers 请求 / 天' },
    { key: 'rowsRead', name: 'D1 读取行数 / 天' },
    { key: 'rowsWritten', name: 'D1 写入行数 / 天' },
    { key: 'storageBytes', name: 'D1 存储（账户累计）' },
  ]
  const metrics: UsageMetric[] = defs.map((d) => {
    const arr = series[d.key]
    const limit = USAGE_LIMITS[d.key] as number
    const current = arr[arr.length - 1] || 0
    const ratio = current / limit
    let peak: UsageMetric['peak'] = null
    if (d.key !== 'storageBytes') {
      let best = { date: dayList[0], value: 0 }
      arr.forEach((v, i) => {
        if (v > best.value) best = { date: dayList[i], value: v }
      })
      peak = { date: best.date, value: best.value, ratio: best.value / limit }
    }
    return {
      key: d.key,
      name: d.name,
      current,
      limit,
      ratio,
      level: levelOf(ratio),
      yesterday: d.key === 'storageBytes' ? null : arr[arr.length - 2] ?? null,
      peak,
    }
  })

  const workers = new Map<string, number>()
  for (const r of wToday) {
    const name = r.dimensions?.scriptName || '(unknown)'
    workers.set(name, (workers.get(name) || 0) + (r.sum?.requests || 0))
  }

  const notes: string[] = []
  for (const m of metrics) {
    if (m.peak && m.peak.ratio >= WARN && m.ratio < WARN) {
      notes.push(`${m.name} 近 ${span} 日峰值达 ${(m.peak.ratio * 100).toFixed(1)}%（${m.peak.date}），虽今日不高，建议排查高消耗查询。`)
    }
  }

  return {
    ok: true,
    generatedAt: now.toISOString(),
    todayUtc: today,
    windowStartUtc: `${today}T00:00:00Z`,
    windowEndUtc: endNow,
    days: dayList,
    limits: USAGE_LIMITS,
    series,
    metrics,
    level: Math.max(...metrics.map((m) => m.level)) as AlertLevel,
    notes,
    account: {
      workers: [...workers.entries()]
        .map(([name, requests]) => ({ name, requests }))
        .sort((a, b) => b.requests - a.requests),
      errorsToday: todayErrors,
      d1Databases: latestByDb.size,
      storageBytes,
      biggestDb: biggest ? { id: biggest[0], bytes: biggest[1].bytes } : null,
    },
    source: 'Cloudflare GraphQL Analytics API（约数分钟延迟）',
  }
}
