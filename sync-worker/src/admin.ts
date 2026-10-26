import type { D1Database } from '@cloudflare/workers-types'

// ---------------------------------------------------------------------------
// 后台管理平台数据层:管理员会话 / 用户查询 / 激活码 / 埋点统计。
// 所有时间为 ISO 字符串(UTC 存储);按"北京时间(UTC+8)"分天统计,
// 直接交给 SQLite 的 date(ts, '+8 hours') 处理,避免 JS 侧时区换算出错。
// ---------------------------------------------------------------------------

const BJ_OFFSET_MS = 8 * 3600 * 1000

/** 生成为期 days 天的"北京日期"桶,并给出查询用的起始 ISO 时间。 */
export function bjdWindow(days: number): { sinceIso: string; list: string[] } {
  const n = Math.min(90, Math.max(1, Math.trunc(days)))
  const nowBjd = new Date(Date.now() + BJ_OFFSET_MS)
  const startBjd = Date.UTC(
    nowBjd.getUTCFullYear(),
    nowBjd.getUTCMonth(),
    nowBjd.getUTCDate(),
  ) - (n - 1) * 86_400_000
  const list: string[] = []
  for (let i = 0; i < n; i++) {
    list.push(new Date(startBjd + i * 86_400_000).toISOString().slice(0, 10))
  }
  // 桶起点往前回退 8 小时,保证 SQLite 里 UTC 时间戳能落进正确的北京日桶
  return { sinceIso: new Date(startBjd - BJ_OFFSET_MS).toISOString(), list }
}

export function bjdToday(): string {
  return new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 管理员会话
// ---------------------------------------------------------------------------

export async function createAdminSession(
  db: D1Database,
  token: string,
  createdAt: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(token, createdAt, expiresAt)
    .run()
}

export async function getAdminSession(
  db: D1Database,
  token: string,
  nowIso: string,
): Promise<{ token: string } | null> {
  try {
    const row = await db
      .prepare('SELECT token FROM admin_sessions WHERE token = ? AND expires_at > ?')
      .bind(token, nowIso)
      .first<{ token: string }>()
    return row ?? null
  } catch {
    return null
  }
}

export async function deleteAdminSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run()
}

// ---------------------------------------------------------------------------
// 用户查询 / 管理
// ---------------------------------------------------------------------------

export type UserStatus = 'member' | 'trial' | 'churned' | 'blacklist'

export async function listUsers(
  db: D1Database,
  opts: { q?: string; status?: UserStatus | ''; limit: number; offset: number },
): Promise<{
  rows: Array<{
    id: string
    email: string
    nickname: string | null
    avatar: string | null
    created_at: string
    activated: number
    activated_at: string | null
    trial_ends_at: string | null
    disabled: number
    devices: number
    last_seen_at: string | null
    tasks: number
    birthdays: number
  }>
  total: number
}> {
  const where: string[] = []
  const bind: unknown[] = []
  if (opts.q) {
    where.push('(u.email LIKE ? OR u.nickname LIKE ?)')
    const like = `%${opts.q}%`
    bind.push(like, like)
  }
  if (opts.status === 'blacklist') where.push('u.disabled = 1')
  else if (opts.status === 'member') where.push('u.disabled = 0 AND u.activated = 1')
  else if (opts.status === 'trial')
    where.push('u.disabled = 0 AND u.activated = 0 AND u.trial_ends_at IS NOT NULL AND u.trial_ends_at > ?')
  else if (opts.status === 'churned')
    where.push('u.disabled = 0 AND u.activated = 0 AND (u.trial_ends_at IS NULL OR u.trial_ends_at <= ?)')
  if (opts.status === 'trial' || opts.status === 'churned') bind.push(new Date().toISOString())
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const listSql = `
    SELECT u.id, u.email, u.nickname, u.avatar, u.created_at, u.activated, u.activated_at,
           u.trial_ends_at, u.disabled,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS devices,
           (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
           (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id AND t.deleted_at IS NULL) AS tasks,
           (SELECT COUNT(*) FROM birthdays b WHERE b.user_id = u.id AND b.deleted_at IS NULL) AS birthdays
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?`
  const [listRes, countRes] = await Promise.all([
    db
      .prepare(listSql)
      .bind(...bind, opts.limit, opts.offset)
      .all<{
        id: string
        email: string
        nickname: string | null
        avatar: string | null
        created_at: string
        activated: number
        activated_at: string | null
        trial_ends_at: string | null
        disabled: number
        devices: number
        last_seen_at: string | null
        tasks: number
        birthdays: number
      }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`)
      .bind(...bind)
      .first<{ n: number }>(),
  ])
  return { rows: listRes.results ?? [], total: Number(countRes?.n ?? 0) }
}

/** 拉黑/解除拉黑:返回受影响行数。调用方负责删除该用户会话。 */
export async function setUserDisabled(
  db: D1Database,
  userId: string,
  disabled: boolean,
): Promise<number> {
  const r = await db
    .prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .bind(disabled ? 1 : 0, userId)
    .run()
  return Number((r.meta as { changes?: number }).changes ?? 0)
}

/** 手动激活(买断制):写入 activated / activated_at。 */
export async function setUserActivated(
  db: D1Database,
  userId: string,
  activated: boolean,
  nowIso: string,
): Promise<number> {
  const r = await db
    .prepare('UPDATE users SET activated = ?, activated_at = ? WHERE id = ?')
    .bind(activated ? 1 : 0, activated ? nowIso : null, userId)
    .run()
  return Number((r.meta as { changes?: number }).changes ?? 0)
}

/** 设置试用截止时间(管理端调试用:可把用户置为"试用已过期",或恢复完整试用窗口)。 */
export async function setUserTrialEnds(
  db: D1Database,
  userId: string,
  trialEndsIso: string,
): Promise<number> {
  const r = await db
    .prepare('UPDATE users SET activated = 0, trial_ends_at = ? WHERE id = ?')
    .bind(trialEndsIso, userId)
    .run()
  return Number((r.meta as { changes?: number }).changes ?? 0)
}

/** 删除某用户全部会话(拉黑后立即失效)。 */
export async function deleteSessionsOfUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

// ---------------------------------------------------------------------------
// 激活码
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混淆的 0/O/1/I

/** 生成一个随机码段。 */
export function randomCodeSegment(length: number): string {
  const n = Math.min(24, Math.max(4, Math.trunc(length)))
  const buf = crypto.getRandomValues(new Uint32Array(n))
  let out = ''
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length]
  return out
}

export async function createActivationCodes(
  db: D1Database,
  codes: Array<{ code: string; batch: string; note: string; createdAt: string }>,
): Promise<number> {
  let created = 0
  for (const c of codes) {
    try {
      await db
        .prepare(
          `INSERT INTO activation_codes (code, batch, note, status, created_at)
           VALUES (?, ?, ?, 'unissued', ?)`,
        )
        .bind(c.code, c.batch, c.note, c.createdAt)
        .run()
      created += 1
    } catch {
      // 主键冲突(重号):跳过,由调用方补生成
    }
  }
  return created
}

export async function listActivationCodes(
  db: D1Database,
  opts: { status?: string; q?: string; limit: number; offset: number },
): Promise<{
  rows: Array<{
    code: string
    batch: string
    note: string
    status: string
    used_by: string | null
    used_at: string | null
    issued_at: string | null
    created_at: string
    user_email: string | null
  }>
  total: number
  counts: { unissued: number; issued: number; used: number }
}> {
  const where: string[] = []
  const bind: unknown[] = []
  if (opts.status && ['unissued', 'issued', 'used'].includes(opts.status)) {
    where.push('c.status = ?')
    bind.push(opts.status)
  }
  if (opts.q) {
    where.push('(c.code LIKE ? OR c.batch LIKE ? OR c.note LIKE ?)')
    const like = `%${opts.q}%`
    bind.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const listSql = `
    SELECT c.code, c.batch, c.note, c.status, c.used_by, c.used_at, c.issued_at, c.created_at,
           u.email AS user_email
    FROM activation_codes c
    LEFT JOIN users u ON u.id = c.used_by
    ${whereSql}
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
  const countSql = `SELECT COUNT(*) AS n FROM activation_codes c ${whereSql}`
  const [listRes, countRes, countsRes] = await Promise.all([
    db
      .prepare(listSql)
      .bind(...bind, opts.limit, opts.offset)
      .all<{
        code: string
        batch: string
        note: string
        status: string
        used_by: string | null
        used_at: string | null
        issued_at: string | null
        created_at: string
        user_email: string | null
      }>(),
    db
      .prepare(countSql)
      .bind(...bind)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='unissued' THEN 1 ELSE 0 END) AS unissued,
           SUM(CASE WHEN status='issued'   THEN 1 ELSE 0 END) AS issued,
           SUM(CASE WHEN status='used'      THEN 1 ELSE 0 END) AS used
         FROM activation_codes`,
      )
      .first<{ unissued: number; issued: number; used: number }>(),
  ])
  return {
    rows: listRes.results ?? [],
    total: Number(countRes?.n ?? 0),
    counts: {
      unissued: Number(countsRes?.unissued ?? 0),
      issued: Number(countsRes?.issued ?? 0),
      used: Number(countsRes?.used ?? 0),
    },
  }
}

/** 发放:仅未发放 / 未使用的码可置为已发放。 */
export async function issueActivationCodes(
  db: D1Database,
  codes: string[],
  issuedAt: string,
): Promise<number> {
  let n = 0
  for (const code of codes) {
    const r = await db
      .prepare(
        `UPDATE activation_codes SET status = 'issued', issued_at = ?
         WHERE code = ? AND status = 'unissued'`,
      )
      .bind(issuedAt, code)
      .run()
    n += Number((r.meta as { changes?: number }).changes ?? 0)
  }
  return n
}

/** 删除激活码(仅允许删除未使用的)。 */
export async function deleteActivationCodes(db: D1Database, codes: string[]): Promise<number> {
  let n = 0
  for (const code of codes) {
    const r = await db
      .prepare(`DELETE FROM activation_codes WHERE code = ? AND status != 'used'`)
      .bind(code)
      .run()
    n += Number((r.meta as { changes?: number }).changes ?? 0)
  }
  return n
}

export type RedeemResult =
  | { ok: true; activated: boolean }
  | { ok: false; error: string; status: number }

/** 客户端兑换激活码:校验 → 标记已使用 → 激活账号。 */
export async function redeemActivationCode(
  db: D1Database,
  code: string,
  userId: string,
  nowIso: string,
): Promise<RedeemResult> {
  const row = await db
    .prepare('SELECT code, status FROM activation_codes WHERE code = ?')
    .bind(code)
    .first<{ code: string; status: string }>()
  if (!row) return { ok: false, error: '激活码不存在', status: 404 }
  if (row.status === 'used') return { ok: false, error: '激活码已被使用', status: 409 }
  const r = await db
    .prepare(
      `UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ?
       WHERE code = ? AND status != 'used'`,
    )
    .bind(userId, nowIso, code)
    .run()
  if (!Number((r.meta as { changes?: number }).changes ?? 0)) {
    return { ok: false, error: '激活码刚被使用,请刷新后重试', status: 409 }
  }
  await db
    .prepare('UPDATE users SET activated = 1, activated_at = ? WHERE id = ?')
    .bind(nowIso, userId)
    .run()
  return { ok: true, activated: true }
}

// ---------------------------------------------------------------------------
// 埋点事件
// ---------------------------------------------------------------------------

export const ALLOWED_EVENTS = new Set([
  'pageview', // 下载页访问
  'download_click', // 下载页点击下载
  'app_open', // 工具启动
  'install', // 工具首次运行(安装)
  'register', // 注册成功
  'page_visit', // 工具内页面访问
  'feature_click', // 工具内功能点击
])

export type EventInput = {
  event: string
  page?: string
  visitor?: string
  meta?: string
}

/** 批量写入事件(由 ctx.waitUntil 异步执行,不阻塞响应)。 */
export async function insertEvents(
  db: D1Database,
  source: string,
  events: EventInput[],
  ts: string,
): Promise<number> {
  let n = 0
  for (const e of events) {
    await db
      .prepare(
        `INSERT INTO analytics_events (source, event, page, visitor, meta, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        source,
        e.event,
        String(e.page ?? '').slice(0, 40),
        String(e.visitor ?? '').slice(0, 64),
        String(e.meta ?? '').slice(0, 120),
        ts,
      )
      .run()
    n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// 统计:概览
// ---------------------------------------------------------------------------

export type Overview = {
  range: number
  users: {
    total: number
    newToday: number
    newInRange: number
    member: number
    trial: number
    churned: number
    blacklist: number
    conversionRate: number
  }
  active: { today: number; d7: number; d30: number }
  funnel: { visitors: number; clicks: number; installs: number; registrations: number }
  trends: {
    days: string[]
    newUsers: number[]
    cumulativeUsers: number[]
    activeUsers: number[]
    pageviews: number[]
    downloadClicks: number[]
  }
}

export async function overviewStats(db: D1Database, days = 30): Promise<Overview> {
  const nowIso = new Date().toISOString()
  const { sinceIso, list } = bjdWindow(days)
  const today = bjdToday()

  const [userAgg, newTodayRow, eventsAgg, registerRow] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN disabled = 1 THEN 1 ELSE 0 END) AS blacklist,
           SUM(CASE WHEN disabled = 0 AND activated = 1 THEN 1 ELSE 0 END) AS member,
           SUM(CASE WHEN disabled = 0 AND activated = 0 AND trial_ends_at IS NOT NULL AND trial_ends_at > ? THEN 1 ELSE 0 END) AS trial,
           SUM(CASE WHEN disabled = 0 AND activated = 0 AND (trial_ends_at IS NULL OR trial_ends_at <= ?) THEN 1 ELSE 0 END) AS churned
         FROM users`,
      )
      .bind(nowIso, nowIso)
      .first<{
        total: number
        blacklist: number
        member: number
        trial: number
        churned: number
      }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE date(created_at, '+8 hours') = ?`)
      .bind(today)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT date(ts, '+8 hours') AS d, event, COUNT(*) AS c, COUNT(DISTINCT visitor) AS uv
         FROM analytics_events WHERE ts >= ? GROUP BY d, event`,
      )
      .bind(sinceIso)
      .all<{ d: string; event: string; c: number; uv: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`)
      .bind(sinceIso)
      .first<{ n: number }>(),
  ])

  // 组装趋势序列
  const newUsersMap = new Map<string, number>()
  const activeMap = new Map<string, number>()
  const pageviewMap = new Map<string, number>()
  const clickMap = new Map<string, number>()
  for (const r of eventsAgg.results ?? []) {
    if (r.event === 'app_open') activeMap.set(r.d, Number(r.uv ?? 0))
    if (r.event === 'pageview') pageviewMap.set(r.d, Number(r.c ?? 0))
    if (r.event === 'download_click') clickMap.set(r.d, Number(r.c ?? 0))
  }
  const newUsersRows = await db
    .prepare(
      `SELECT date(created_at, '+8 hours') AS d, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY d`,
    )
    .bind(sinceIso)
    .all<{ d: string; c: number }>()
  for (const r of newUsersRows.results ?? []) newUsersMap.set(r.d, Number(r.c ?? 0))

  const newUsers: number[] = []
  const activeUsers: number[] = []
  const pageviews: number[] = []
  const downloadClicks: number[] = []
  for (const d of list) {
    newUsers.push(newUsersMap.get(d) ?? 0)
    activeUsers.push(activeMap.get(d) ?? 0)
    pageviews.push(pageviewMap.get(d) ?? 0)
    downloadClicks.push(clickMap.get(d) ?? 0)
  }
  // 累计用户:窗口起点之前的总数 + 逐日累加
  const beforeRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at < ?`)
    .bind(sinceIso)
    .first<{ n: number }>()
  let cum = Number(beforeRow?.n ?? 0)
  const cumulativeUsers = newUsers.map((v) => (cum += v))

  // 活跃用户:今日 / 近 7 天 / 近 30 天(按 app_open 的去重访客)
  const activeAgg = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN date(ts, '+8 hours') = ? THEN visitor END) AS today,
         COUNT(DISTINCT CASE WHEN ts >= ? THEN visitor END) AS d7,
         COUNT(DISTINCT CASE WHEN ts >= ? THEN visitor END) AS d30
       FROM analytics_events WHERE source = 'app' AND event = 'app_open'`,
    )
    .bind(today, new Date(Date.now() - 6 * 86_400_000).toISOString(), sinceIso)
    .first<{ today: number; d7: number; d30: number }>()

  // 下载站漏斗(窗口内)
  const funnelRow = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN event = 'pageview' AND visitor <> '' THEN visitor END) AS visitors,
         SUM(CASE WHEN event = 'download_click' THEN 1 ELSE 0 END) AS clicks
       FROM analytics_events WHERE source = 'site' AND ts >= ?`,
    )
    .bind(sinceIso)
    .first<{ visitors: number; clicks: number }>()
  const installRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN visitor <> '' THEN visitor END) AS n
       FROM analytics_events WHERE source = 'app' AND event = 'install' AND ts >= ?`,
    )
    .bind(sinceIso)
    .first<{ n: number }>()

  const total = Number(userAgg?.total ?? 0)
  const member = Number(userAgg?.member ?? 0)
  return {
    range: days,
    users: {
      total,
      newToday: Number(newTodayRow?.n ?? 0),
      newInRange: Number(registerRow?.n ?? 0),
      member,
      trial: Number(userAgg?.trial ?? 0),
      churned: Number(userAgg?.churned ?? 0),
      blacklist: Number(userAgg?.blacklist ?? 0),
      conversionRate: total > 0 ? Math.round((member / total) * 1000) / 10 : 0,
    },
    active: {
      today: Number(activeAgg?.today ?? 0),
      d7: Number(activeAgg?.d7 ?? 0),
      d30: Number(activeAgg?.d30 ?? 0),
    },
    funnel: {
      visitors: Number(funnelRow?.visitors ?? 0),
      clicks: Number(funnelRow?.clicks ?? 0),
      installs: Number(installRow?.n ?? 0),
      registrations: Number(registerRow?.n ?? 0),
    },
    trends: { days: list, newUsers, cumulativeUsers, activeUsers, pageviews, downloadClicks },
  }
}

// ---------------------------------------------------------------------------
// 统计:工具内页面 / 站点
// ---------------------------------------------------------------------------

export type PageStat = { page: string; visitors: number; clicks: number }
export type TrendPoint = { day: string; page: string; visitors: number; clicks: number }

export async function appPageStats(
  db: D1Database,
  days: number,
): Promise<{ pages: PageStat[]; trend: TrendPoint[]; days: string[] }> {
  const { sinceIso, list } = bjdWindow(days)
  const [rows, trendRows] = await Promise.all([
    db
      .prepare(
        `SELECT page,
                COUNT(DISTINCT CASE WHEN event = 'page_visit' AND visitor <> '' THEN visitor END) AS visitors,
                SUM(CASE WHEN event = 'feature_click' THEN 1 ELSE 0 END) AS clicks
         FROM analytics_events
         WHERE source = 'app' AND ts >= ? AND event IN ('page_visit', 'feature_click')
         GROUP BY page ORDER BY visitors DESC`,
      )
      .bind(sinceIso)
      .all<{ page: string; visitors: number; clicks: number }>(),
    db
      .prepare(
        `SELECT date(ts, '+8 hours') AS day, page,
                COUNT(DISTINCT CASE WHEN event = 'page_visit' AND visitor <> '' THEN visitor END) AS visitors,
                SUM(CASE WHEN event = 'feature_click' THEN 1 ELSE 0 END) AS clicks
         FROM analytics_events
         WHERE source = 'app' AND ts >= ? AND event IN ('page_visit', 'feature_click')
         GROUP BY day, page`,
      )
      .bind(sinceIso)
      .all<{ day: string; page: string; visitors: number; clicks: number }>(),
  ])
  return {
    pages: (rows.results ?? []).map((r) => ({
      page: r.page,
      visitors: Number(r.visitors ?? 0),
      clicks: Number(r.clicks ?? 0),
    })),
    trend: (trendRows.results ?? []).map((r) => ({
      day: r.day,
      page: r.page,
      visitors: Number(r.visitors ?? 0),
      clicks: Number(r.clicks ?? 0),
    })),
    days: list,
  }
}

export async function siteStats(
  db: D1Database,
  days: number,
): Promise<{ trend: TrendPoint[]; days: string[]; totals: { visitors: number; clicks: number } }> {
  const { sinceIso, list } = bjdWindow(days)
  const [trendRows, totalsRow] = await Promise.all([
    db
      .prepare(
        `SELECT date(ts, '+8 hours') AS day,
                COUNT(DISTINCT CASE WHEN event = 'pageview' AND visitor <> '' THEN visitor END) AS visitors,
                SUM(CASE WHEN event = 'download_click' THEN 1 ELSE 0 END) AS clicks
         FROM analytics_events
         WHERE source = 'site' AND ts >= ? AND event IN ('pageview', 'download_click')
         GROUP BY day`,
      )
      .bind(sinceIso)
      .all<{ day: string; visitors: number; clicks: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN event = 'pageview' AND visitor <> '' THEN visitor END) AS visitors,
                SUM(CASE WHEN event = 'download_click' THEN 1 ELSE 0 END) AS clicks
         FROM analytics_events WHERE source = 'site' AND ts >= ?`,
      )
      .bind(sinceIso)
      .first<{ visitors: number; clicks: number }>(),
  ])
  return {
    trend: (trendRows.results ?? []).map((r) => ({
      day: r.day,
      page: 'site',
      visitors: Number(r.visitors ?? 0),
      clicks: Number(r.clicks ?? 0),
    })),
    days: list,
    totals: {
      visitors: Number(totalsRow?.visitors ?? 0),
      clicks: Number(totalsRow?.clicks ?? 0),
    },
  }
}
