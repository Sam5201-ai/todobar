import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import type { D1Database, D1PreparedStatement, KVNamespace } from '@cloudflare/workers-types'
import {
  applySchema,
  getSettings,
  hardDeleteBirthdays,
  hardDeleteTasks,
  listBirthdaysSince,
  listTasksSince,
  putSettings,
  upsertBirthdays,
  upsertTasks,
  createUser,
  getUserByEmail,
  getUserById,
  updateUserPassword,
  updateUserProfile,
  insertEmailCode,
  getLatestEmailCode,
  bumpEmailCodeAttempts,
  deleteEmailCodes,
  createSession,
  touchSession,
  deleteSession,
  listSessions,
  countSessions,
  revokeSessionForUser,
  deleteOtherSessions,
  deleteAllSessions,
  insertFeedbackReply,
  listFeedbackReplies,
  markFeedbackRead,
  type BirthdayRow,
  type TaskRow,
} from './db'
import {
  resolveUser,
  unauthorized,
  hashPassword,
  verifyPassword,
  randomToken,
  hashCode,
  verifyCode,
} from './auth'
import { sendCodeEmail } from './email'
import {
  ALLOWED_EVENTS,
  appPageStats,
  createActivationCodes,
  createAdminSession,
  deleteActivationCodes,
  deleteAdminSession,
  deleteSessionsOfUser,
  getAdminSession,
  insertEvents,
  issueActivationCodes,
  linkIdentity,
  recordSiteDownload,
  listActivationCodes,
  listUsers,
  overviewStats,
  randomCodeSegment,
  redeemActivationCode,
  setUserActivated,
  setUserDisabled,
  setUserTrialEnds,
  siteStats,
  type EventInput,
  type UserStatus,
} from './admin'

export type WorkerEnv = {
  DB: D1Database
  TOKENS?: KVNamespace
  API_TOKENS?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  /** 后台管理平台账号(可选,默认见 defaultAdminEmail)。 */
  ADMIN_EMAIL?: string
  /** 后台管理平台密码(可选,默认值为需求指定值)。 */
  ADMIN_PASSWORD?: string
}

// 每个 DB(生产环境即单个 D1 实例)只跑一次建表/补列。用 await 而非
// ctx.waitUntil 的异步调度,确保首个请求在表结构就绪后再执行 upsert,
// 避免冷启动时因表缺列直接 422。按 DB 对象缓存,避免多库(本地测试)串台。
// applySchema 返回失败清单,health 接口据此暴露诊断信息。
const schemaReadyByDb = new WeakMap<D1Database, Promise<string[]>>()
function ensureSchema(env: WorkerEnv): Promise<string[]> {
  let p = schemaReadyByDb.get(env.DB)
  if (!p) {
    p = applySchema(env.DB).catch((e) => {
      schemaReadyByDb.delete(env.DB)
      console.error('applySchema failed:', e)
      throw e
    })
    schemaReadyByDb.set(env.DB, p)
  }
  return p
}

const app = new Hono<{ Bindings: WorkerEnv }>()

// 未捕获异常一律以 JSON 返回具体原因(此前是纯文本 Internal Server Error,
// 客户端只能显示"请求失败(500)",无法定位 no such table 之类的问题)
app.onError((err, c) => {
  console.error('[unhandled]', err)
  const msg = err instanceof Error ? err.message : String(err)
  return c.json({ error: `服务器错误:${msg}` }, 500)
})

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'X-Admin-Token', 'X-Sync-Token'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
)

const nowIso = () => new Date().toISOString()

// 账号体系常量
const CODE_TTL_MS = 10 * 60 * 1000 // 验证码 10 分钟有效
const SEND_INTERVAL_MS = 60 * 1000 // 同邮箱 60 秒一封
const SESSION_TTL_DAYS = 30
const TRIAL_DAYS = 14

function bool(v: unknown): number {
  return v ? 1 : 0
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Clamp an untrusted number into an integer range, with a fallback. */
function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Coerce an untrusted JSON object into a TaskRow we are willing to store. */
function normalizeTask(raw: unknown, userId: string): TaskRow {
  if (!raw || typeof raw !== 'object') throw new Error('task must be an object')
  const t = raw as Record<string, unknown>
  const id = str(t.id)
  const listId = str(t.list_id)
  const title = str(t.title)
  const updatedAt = str(t.updated_at)
  const createdAt = str(t.created_at) || updatedAt || nowIso()
  if (!id || !listId || !title || !updatedAt) {
    throw new Error('task requires id, list_id, title and updated_at')
  }
  return {
    id,
    user_id: userId,
    parent_id: t.parent_id == null ? null : str(t.parent_id),
    list_id: listId,
    title,
    notes: t.notes == null ? null : str(t.notes),
    meta: t.meta == null ? null : str(t.meta),
    priority: ['focus', 'normal', 'later'].includes(str(t.priority))
      ? str(t.priority)
      : 'normal',
    is_important: bool(t.is_important),
    is_pinned: bool(t.is_pinned),
    done: bool(t.done),
    due_date: t.due_date == null ? null : str(t.due_date),
    due_end_date: t.due_end_date == null ? null : str(t.due_end_date),
    remind_at: t.remind_at == null ? null : str(t.remind_at),
    deleted_at: t.deleted_at == null ? null : str(t.deleted_at),
    // 之前漏了这一列,导致客户端手工排序的 sort_order 在 push 时被丢成 NULL
    sort_order: t.sort_order == null ? null : int(t.sort_order, -1_000_000, 1_000_000, 0),
    recurrence: t.recurrence == null ? null : str(t.recurrence),
    completed_dates: t.completed_dates == null ? null : str(t.completed_dates),
    deleted_dates: t.deleted_dates == null ? null : str(t.deleted_dates),
    series_id: t.series_id == null ? null : str(t.series_id),
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

/** Coerce an untrusted JSON object into a BirthdayRow we are willing to store. */
function normalizeBirthday(raw: unknown, userId: string): BirthdayRow {
  if (!raw || typeof raw !== 'object') throw new Error('birthday must be an object')
  const b = raw as Record<string, unknown>
  const id = str(b.id)
  const updatedAt = str(b.updated_at)
  const createdAt = str(b.created_at) || updatedAt || nowIso()
  if (!id || !updatedAt) {
    throw new Error('birthday requires id and updated_at')
  }
  const calendar = str(b.calendar) === 'lunar' ? 'lunar' : 'solar'
  const kind = str(b.kind) === 'anniversary' ? 'anniversary' : 'birthday'
  const avatar = str(b.avatar).match(/^a[1-5]$/) ? str(b.avatar) : null
  const month = int(b.month, 1, 12, 1)
  // 公历允许 1-31,农历 1-30;按日历类型收紧上界,避免 2 月 31 日这类脏数据。
  const dayMax = calendar === 'lunar' ? 30 : 31
  return {
    id,
    user_id: userId,
    name: str(b.name).slice(0, 120),
    relation: b.relation == null ? null : str(b.relation).slice(0, 60),
    kind,
    avatar,
    calendar,
    month,
    day: int(b.day, 1, dayMax, 1),
    is_leap_month: bool(b.is_leap_month),
    remind_enabled: bool(b.remind_enabled),
    remind_hour: int(b.remind_hour, 0, 23, 9),
    remind_minute: int(b.remind_minute, 0, 59, 0),
    remind_days_before: int(b.remind_days_before, 0, 365, 0),
    note: b.note == null ? null : str(b.note).slice(0, 2000),
    deleted_at: b.deleted_at == null ? null : str(b.deleted_at),
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

app.get('/api/health', async (c) => {
  // 诊断端点:建表失败清单 + 当前库里的表名,一眼定位"表没建上"类问题
  const failures = await ensureSchema(c.env)
  let tables: string[] = []
  try {
    const r = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>()
    tables = (r.results ?? []).map((x) => x.name)
  } catch (e) {
    return c.json({ ok: false, time: nowIso(), failures, dbError: String(e) }, 500)
  }
  return c.json({ ok: failures.length === 0, time: nowIso(), tables, failures })
})

app.get('/api/tasks', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const since = c.req.query('since') ?? null
  if (since && Number.isNaN(Date.parse(since))) {
    return c.json({ error: 'invalid since' }, 400)
  }
  const [tasks, birthdays] = await Promise.all([
    listTasksSince(c.env.DB, userId, since),
    listBirthdaysSince(c.env.DB, userId, since),
  ])
  return c.json({ server_now: nowIso(), tasks, birthdays, cursor: since })
})

app.post('/api/tasks', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()

  let body: {
    tasks?: unknown[]
    deleted?: unknown[]
    birthdays?: unknown[]
    deleted_birthdays?: unknown[]
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const incoming = Array.isArray(body.tasks) ? body.tasks : []
  const deleted = Array.isArray(body.deleted)
    ? body.deleted.filter((x): x is string => typeof x === 'string')
    : []
  const incomingBirthdays = Array.isArray(body.birthdays) ? body.birthdays : []
  const deletedBirthdays = Array.isArray(body.deleted_birthdays)
    ? body.deleted_birthdays.filter((x): x is string => typeof x === 'string')
    : []

  try {
    const normalizedTasks = incoming.map((t) => normalizeTask(t, userId))
    const normalizedBirthdays = incomingBirthdays.map((b) => normalizeBirthday(b, userId))
    let accepted = 0
    try {
      accepted += await upsertTasks(c.env.DB, userId, normalizedTasks)
      accepted += await upsertBirthdays(c.env.DB, userId, normalizedBirthdays)
    } catch (err) {
      // 老库缺列时先补 schema 再重试一次
      await applySchema(c.env.DB)
      accepted = await upsertTasks(c.env.DB, userId, normalizedTasks)
      accepted += await upsertBirthdays(c.env.DB, userId, normalizedBirthdays)
    }
    let removed = await hardDeleteTasks(c.env.DB, userId, deleted)
    removed += await hardDeleteBirthdays(c.env.DB, userId, deletedBirthdays)
    return c.json({ server_now: nowIso(), accepted, removed })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 422)
  }
})

app.get('/api/settings', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const row = await getSettings(c.env.DB, userId)
  return c.json({ server_now: nowIso(), settings: row ? JSON.parse(row.payload) : null })
})

app.put('/api/settings', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  if (payload == null || typeof payload !== 'object') {
    return c.json({ error: 'settings must be an object' }, 422)
  }
  const updatedAt = nowIso()
  await putSettings(c.env.DB, userId, JSON.stringify(payload), updatedAt)
  return c.json({ server_now: updatedAt, updated_at: updatedAt })
})

// Best-effort schema bootstrap on first request (idempotent).
app.get('/api/bootstrap', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const failures = await applySchema(c.env.DB)
  if (failures.length > 0) {
    return c.json({ ok: false, error: '表结构不完整', failures }, 500)
  }
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 版本更新记录(官网下载页使用):公开读取,令牌鉴权写入
// ---------------------------------------------------------------------------

type ReleaseRow = {
  version: string
  release_date: string
  title: string
  items: string
  created_at: string
}

function parseItems(raw: string): string[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

const RELEASES_SQL =
  'SELECT version, release_date, title, items, created_at FROM release_notes ORDER BY release_date DESC'

// 字典序比较会把 "0.4.10" 排在 "0.4.9" 之后("9" > "1"),必须按语义化版本降序。
function semverCompareDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

function sortReleasesDesc(rows: ReleaseRow[]): ReleaseRow[] {
  return [...rows].sort((a, b) => {
    if (a.release_date !== b.release_date) return a.release_date < b.release_date ? 1 : -1
    return semverCompareDesc(a.version, b.version)
  })
}

app.get('/api/releases', async (c) => {
  const query = async () => {
    const { results } = await c.env.DB.prepare(RELEASES_SQL).all<ReleaseRow>()
    return sortReleasesDesc(results ?? []).map((r) => ({
      version: r.version,
      release_date: r.release_date,
      title: r.title,
      items: parseItems(r.items),
    }))
  }
  let releases
  try {
    releases = await query()
  } catch {
    // 表可能还没建(老库首次升级):补一次 schema 再重试
    await applySchema(c.env.DB)
    releases = await query()
  }
  return c.json({ releases })
})

app.post('/api/releases', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const version = str(body.version)
  const releaseDate = str(body.release_date ?? body.date)
  const title = str(body.title)
  const items = Array.isArray(body.items)
    ? body.items.filter((x) => typeof x === 'string').slice(0, 20)
    : []
  if (!version || !releaseDate || !title) {
    return c.json({ error: 'version, release_date and title are required' }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO release_notes (version, release_date, title, items, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(version) DO UPDATE SET
       release_date = excluded.release_date,
       title = excluded.title,
       items = excluded.items`,
  )
    .bind(version, releaseDate, title, JSON.stringify(items), nowIso())
    .run()
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 账号体系(P1):注册 / 登录 / 登出 / 改密 / 设备管理
// 所有接口走 HTTPS,与同步同域可直连;令牌为 sessions 表里的会话令牌。
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function isEmail(s: string): boolean {
  return EMAIL_RE.test(s)
}
/** 6 位数字验证码。 */
function genCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(n).padStart(6, '0')
}
/** 从请求里取当前 bearer / x-sync-token(给设备管理标记"本机"用)。 */
function currentToken(c: { req: { raw: Request } }): string | null {
  const h = c.req.raw.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return h ?? c.req.raw.headers.get('x-sync-token')?.trim() ?? null
}
/** 对外暴露的账号信息(绝不带密码哈希/盐)。 */
function publicUser(u: {
  id: string
  email: string
  activated: number
  trial_ends_at: string | null
  nickname?: string | null
  avatar?: string | null
}): {
  id: string
  email: string
  activated: boolean
  trialEndsAt: string | null
  nickname: string | null
  avatar: string | null
} {
  return {
    id: u.id,
    email: u.email,
    activated: Boolean(u.activated),
    trialEndsAt: u.trial_ends_at,
    nickname: u.nickname ?? null,
    avatar: u.avatar ?? null,
  }
}

app.post('/api/auth/send-code', async (c) => {
  let body: { email?: unknown; purpose?: unknown }
  try {
    body = (await c.req.json()) as { email?: unknown; purpose?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const email = str(body.email).toLowerCase()
  const purpose = body.purpose === 'reset' ? 'reset' : 'register'
  if (!isEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400)

  // 60 秒频控
  const last = await getLatestEmailCode(c.env.DB, email, purpose)
  if (last && Date.now() - Date.parse(last.created_at) < SEND_INTERVAL_MS) {
    return c.json({ error: '请 60 秒后再获取验证码' }, 429)
  }

  const code = genCode()
  const { hash, salt } = await hashCode(code)
  const now = nowIso()
  await insertEmailCode(c.env.DB, {
    email,
    codeHash: hash,
    salt,
    purpose,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    createdAt: now,
  })
  const sent = await sendCodeEmail(c.env, email, code, purpose)
  if (!sent.ok) {
    // 发信失败:撤回刚写入的码,允许立即重试
    await deleteEmailCodes(c.env.DB, email, purpose)
    return c.json({ error: sent.error || '邮件发送失败' }, 502)
  }
  return c.json({ ok: true })
})

app.post('/api/auth/register', async (c) => {
  let body: {
    email?: unknown
    password?: unknown
    code?: unknown
    deviceName?: unknown
    deviceId?: unknown
    deviceFingerprint?: unknown
    nickname?: unknown
    avatar?: unknown
  }
  try {
    body = (await c.req.json()) as {
      email?: unknown
      password?: unknown
      code?: unknown
      deviceName?: unknown
      deviceId?: unknown
      deviceFingerprint?: unknown
      nickname?: unknown
      avatar?: unknown
    }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const email = str(body.email).toLowerCase()
  const password = str(body.password)
  const code = str(body.code)
  const deviceName = str(body.deviceName) || '此设备'
  const deviceId = str(body.deviceId) || null
  const deviceFingerprint = str(body.deviceFingerprint) || null
  const nickname = str(body.nickname).trim().slice(0, 24) || email.split('@')[0].slice(0, 24)
  const avatar = typeof body.avatar === 'string' && body.avatar.startsWith('data:image/') ? body.avatar.slice(0, 300_000) : null
  if (!isEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400)
  if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400)

  const rec = await getLatestEmailCode(c.env.DB, email, 'register')
  if (!rec) return c.json({ error: '请先获取注册验证码' }, 400)
  if (Date.parse(rec.expires_at) < Date.now()) {
    await deleteEmailCodes(c.env.DB, email, 'register')
    return c.json({ error: '验证码已过期,请重新获取' }, 400)
  }
  if (rec.attempts >= 5) return c.json({ error: '验证码尝试次数过多,请重新获取' }, 429)
  if (!(await verifyCode(code, rec.salt, rec.code_hash))) {
    await bumpEmailCodeAttempts(c.env.DB, email, 'register')
    return c.json({ error: '验证码错误' }, 400)
  }
  if (await getUserByEmail(c.env.DB, email)) {
    return c.json({ error: '该邮箱已注册,请直接登录' }, 409)
  }

  const { hash, salt } = await hashPassword(password)
  const userId = 'u_' + randomToken().slice(0, 20)
  const createdAt = nowIso()
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString()
  await createUser(c.env.DB, {
    id: userId,
    email,
    passwordHash: hash,
    salt,
    nickname,
    avatar,
    createdAt,
    trialEndsAt,
  })
  await deleteEmailCodes(c.env.DB, email, 'register')

  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString()
  await createSession(c.env.DB, { token, userId, deviceId, deviceName, createdAt, expiresAt })
  // v2:绑定设备↔账号,统计活跃用户时按账号去重(跨设备只算 1)
  await linkIdentity(c.env.DB, deviceFingerprint || deviceId || '', userId, createdAt)
  return c.json({
    token,
    user: publicUser({ id: userId, email, activated: 0, trial_ends_at: trialEndsAt, nickname, avatar }),
  })
})

/** 更新昵称/头像(需登录)。avatar 为 data:image URL,上限 300KB。 */
app.post('/api/auth/profile', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  let body: { nickname?: unknown; avatar?: unknown }
  try {
    body = (await c.req.json()) as { nickname?: unknown; avatar?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const patch: { nickname?: string | null; avatar?: string | null } = {}
  if (body.nickname !== undefined) {
    const n = str(body.nickname).trim().slice(0, 24)
    if (!n) return c.json({ error: '昵称不能为空' }, 400)
    patch.nickname = n
  }
  if (body.avatar !== undefined) {
    if (body.avatar === null || body.avatar === '') {
      patch.avatar = null
    } else if (typeof body.avatar === 'string' && body.avatar.startsWith('data:image/') && body.avatar.length <= 300_000) {
      patch.avatar = body.avatar
    } else {
      return c.json({ error: '头像格式不支持或过大' }, 400)
    }
  }
  await updateUserProfile(c.env.DB, userId, patch)
  const user = await getUserById(c.env.DB, userId)
  if (!user) return unauthorized()
  return c.json({ ok: true, user: publicUser(user) })
})

app.post('/api/auth/login', async (c) => {
  let body: { email?: unknown; password?: unknown; deviceName?: unknown; deviceId?: unknown; deviceFingerprint?: unknown }
  try {
    body = (await c.req.json()) as {
      email?: unknown
      password?: unknown
      deviceName?: unknown
      deviceId?: unknown
      deviceFingerprint?: unknown
    }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const email = str(body.email).toLowerCase()
  const password = str(body.password)
  const deviceName = str(body.deviceName) || '此设备'
  const deviceId = str(body.deviceId) || null
  const deviceFingerprint = str(body.deviceFingerprint) || null

  const user = await getUserByEmail(c.env.DB, email)
  if (!user || user.disabled) return c.json({ error: '邮箱或密码错误' }, 401)
  if (!(await verifyPassword(password, user.salt, user.password_hash))) {
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  // 设备会话治理(不做数量限制):
  // 1) 先清掉该用户已过期的会话;
  // 2) 同 deviceId 重登视为同一台设备,替换旧会话,不新增设备行
  //    (此前 localStorage 被清会生成新 deviceId,同一台电脑被当成新设备,幽灵设备会越积越多);
  // 3) 建新会话 + 绑定设备↔账号(v2 统计口径)。
  // 优化(2026-10-27):以上写操作此前逐条 await(每次一次 D1 往返,叠加代理链路
  // 延迟明显拖慢登录),现合并为一次 DB.batch——batch 内按顺序执行、整体提交,
  // 语义与逐条一致,省去约 3 次子请求往返。语句与 db.ts / admin.ts 中同名助手保持一致。
  const token = randomToken()
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString()
  const db = c.env.DB
  const writes: D1PreparedStatement[] = [
    // 同 purgeExpiredSessions(db.ts)
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, createdAt),
  ]
  if (deviceId) {
    // 同 deleteSessionsByDeviceId(db.ts)
    writes.push(
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND device_id = ?').bind(user.id, deviceId),
    )
  }
  writes.push(
    // 同 createSession(db.ts)
    db
      .prepare(
        `INSERT INTO sessions (token, user_id, device_id, device_name, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(token, user.id, deviceId, deviceName, createdAt, createdAt, expiresAt),
  )
  const identity = deviceFingerprint || deviceId || ''
  if (identity) {
    // 同 linkIdentity(admin.ts)
    writes.push(
      db
        .prepare(
          `INSERT INTO identity_links (device, uid, first_seen, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device) DO UPDATE SET uid = excluded.uid, last_seen = excluded.last_seen`,
        )
        .bind(identity, user.id, createdAt, createdAt),
    )
  }
  await db.batch(writes)
  return c.json({ token, user: publicUser(user) })
})

app.post('/api/auth/logout', async (c) => {
  const auth =
    c.req.raw.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ??
    c.req.raw.headers.get('x-sync-token')?.trim() ??
    null
  if (auth) await deleteSession(c.env.DB, auth)
  return c.json({ ok: true })
})

app.get('/api/auth/devices', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const auth = currentToken(c)
  const rows = await listSessions(c.env.DB, userId)
  const devices = rows.map((r) => ({
    token: r.token,
    deviceName: r.device_name,
    deviceId: r.device_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.token === auth,
  }))
  if (auth) await touchSession(c.env.DB, auth)
  return c.json({ devices })
})

app.post('/api/auth/devices/revoke', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  let body: { token?: unknown }
  try {
    body = (await c.req.json()) as { token?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const token = str(body.token)
  if (!token) return c.json({ error: '缺少 token' }, 400)
  await revokeSessionForUser(c.env.DB, userId, token)
  return c.json({ ok: true })
})

// 一键解绑除当前设备外的所有会话:用于清理同一台电脑因历史缺陷(deviceId 重生成)
// 被记成多台的幽灵设备,释放设备额度。其他被解绑设备需重新登录。
app.post('/api/auth/devices/revoke-others', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const auth = currentToken(c)
  if (!auth) return c.json({ error: '缺少会话令牌' }, 401)
  await deleteOtherSessions(c.env.DB, userId, auth)
  return c.json({ ok: true })
})

app.post('/api/auth/password', async (c) => {
  let body: { email?: unknown; password?: unknown; code?: unknown }
  try {
    body = (await c.req.json()) as { email?: unknown; password?: unknown; code?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const email = str(body.email).toLowerCase()
  const password = str(body.password)
  const code = str(body.code)
  if (!isEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400)
  if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400)

  const user = await getUserByEmail(c.env.DB, email)
  if (!user) return c.json({ error: '该邮箱未注册' }, 404)

  const rec = await getLatestEmailCode(c.env.DB, email, 'reset')
  if (!rec) return c.json({ error: '请先获取重置验证码' }, 400)
  if (Date.parse(rec.expires_at) < Date.now()) {
    await deleteEmailCodes(c.env.DB, email, 'reset')
    return c.json({ error: '验证码已过期,请重新获取' }, 400)
  }
  if (rec.attempts >= 5) return c.json({ error: '验证码尝试次数过多,请重新获取' }, 429)
  if (!(await verifyCode(code, rec.salt, rec.code_hash))) {
    await bumpEmailCodeAttempts(c.env.DB, email, 'reset')
    return c.json({ error: '验证码错误' }, 400)
  }

  const { hash, salt } = await hashPassword(password)
  await updateUserPassword(c.env.DB, user.id, hash, salt)
  await deleteEmailCodes(c.env.DB, email, 'reset')
  // 改密后所有设备会话立即失效(含本机),强制重新登录
  await deleteAllSessions(c.env.DB, user.id)
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  const user = await getUserById(c.env.DB, userId)
  if (!user) return unauthorized()
  return c.json({
    user: publicUser(user),
    devices: await countSessions(c.env.DB, userId),
  })
})

// ---------------------------------------------------------------------------
// 埋点上报(下载页 + 工具内实时上报)
// 公开接口:无需登录(未注册用户也要能统计访客/点击),靠事件白名单 +
// 单 IP 频控 + 单次批量上限防灌水。写库走 waitUntil,不阻塞客户端。
// ---------------------------------------------------------------------------

const TRACK_WINDOW_MS = 60_000
const TRACK_MAX_PER_WINDOW = 60 // 单设备每分钟最多 60 次上报
const trackBuckets = new Map<string, { n: number; reset: number }>()
function trackAllowed(key: string): boolean {
  const now = Date.now()
  const b = trackBuckets.get(key)
  if (!b || now > b.reset) {
    trackBuckets.set(key, { n: 1, reset: now + TRACK_WINDOW_MS })
    return true
  }
  b.n += 1
  return b.n <= TRACK_MAX_PER_WINDOW
}

// 真实客户端 IP:server.js 已透传 x-client-ip;Cloudflare / 反代头兜底
function realClientIp(c: Context): string {
  return (
    c.req.header('x-client-ip')?.split(',')[0]?.trim() ||
    c.req.header('cf-connecting-ip')?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

app.post('/api/track', async (c) => {
  const ip = realClientIp(c)
  let body: { source?: unknown; events?: unknown }
  try {
    body = (await c.req.json()) as { source?: unknown; events?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const source = body.source === 'app' ? 'app' : 'site'
  const raw = Array.isArray(body.events) ? body.events.slice(0, 50) : []
  const events: EventInput[] = raw.filter(
    (e): e is EventInput =>
      !!e && typeof e === 'object' && ALLOWED_EVENTS.has((e as { event?: unknown }).event as string),
  )
  if (events.length === 0) return c.json({ ok: true, accepted: 0 })
  // 限流键:优先设备标识,其次真实 IP。避免下载站/App 各自经 server.js 共享出口 IP 被误限
  const key = events[0].device || events[0].visitor || ip
  if (!trackAllowed(key)) return c.json({ ok: true, accepted: 0, skipped: true })
  const ts = nowIso()
  const db = c.env.DB
  // 下载站下载记录(来自 server.js /download 中转,带真实下载用户 IP)
  const dlEvents = events.filter((e) => e.event === 'site_download')
  if (dlEvents.length) {
    const dlIp = c.req.header('x-real-download-ip')?.split(',')[0]?.trim() || ip
    const dlRecords: Promise<unknown>[] = dlEvents.map((e) =>
      recordSiteDownload(db, e.device || e.visitor || '', dlIp, c.req.header('user-agent') || '', ts),
    )
    await Promise.all(dlRecords).catch((e) => console.error('[track] dl record failed:', e))
  }
  // install 事件补真实 IP(用于下载→安装 24h 归因匹配)
  for (const e of events) {
    if (e.event === 'install') e.ip = ip
  }
  // site_download 只写 site_downloads 表,不进主事件表(避免污染站点统计)
  const mainEvents = events.filter((e) => e.event !== 'site_download')
  const writing = insertEvents(db, source, mainEvents, ts).catch((e) =>
    console.error('[track] insert failed:', e),
  )
  // waitUntil 让响应立即返回;执行上下文不可用时退化为同步等待
  try {
    c.executionCtx?.waitUntil?.(writing)
  } catch {
    await writing
  }
  return c.json({ ok: true, accepted: events.length })
})

// ---------------------------------------------------------------------------
// 后台管理平台:固定管理员账号(单人使用,无注册)
// 账号密码支持 env 覆盖(ADMIN_EMAIL / ADMIN_PASSWORD),默认值即需求指定值。
// 令牌存 admin_sessions 表,12 小时有效,经 X-Admin-Token 头发送。
// ---------------------------------------------------------------------------

const ADMIN_SESSION_HOURS = 12

/** 默认管理员账号(可用 env ADMIN_EMAIL 覆盖)。 */
function defaultAdminEmail(): string {
  return '396770760@qq.com'
}

/** 从 X-Admin-Token / X-Sync-Token / Authorization 取管理令牌并校验会话。 */
async function resolveAdmin(
  env: WorkerEnv,
  request: Request,
): Promise<boolean> {
  const header =
    request.headers.get('x-admin-token')?.trim() ||
    request.headers.get('x-sync-token')?.trim() ||
    request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ||
    ''
  if (!header) return false
  return Boolean(await getAdminSession(env.DB, header, nowIso()))
}

function adminUnauthorized(): Response {
  return c_json({ error: '未授权或登录已过期' }, 401)
}

// 统一 JSON 响应小工具(避免在 admin 路由里到处写 headers)
function c_json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

app.post('/api/admin/login', async (c) => {
  let body: { email?: unknown; password?: unknown }
  try {
    body = (await c.req.json()) as { email?: unknown; password?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const email = str(body.email).toLowerCase()
  const password = str(body.password)
  // 期望口令支持 env 覆盖(ADMIN_EMAIL / ADMIN_PASSWORD),默认值即需求指定值
  const expectEmail = (c.env.ADMIN_EMAIL || defaultAdminEmail()).toLowerCase()
  const expectPassword = c.env.ADMIN_PASSWORD || '66666666'
  if (!email || !password || email !== expectEmail || password !== expectPassword) {
    return c.json({ error: '账号或密码错误' }, 401)
  }
  const token = randomToken()
  const now = nowIso()
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_HOURS * 3600_000).toISOString()
  await createAdminSession(c.env.DB, token, now, expiresAt)
  return c.json({ ok: true, token, expiresAt })
})

app.post('/api/admin/logout', async (c) => {
  const token = c.req.header('x-admin-token')?.trim() || c.req.header('x-sync-token')?.trim() || ''
  if (token) await deleteAdminSession(c.env.DB, token)
  return c.json({ ok: true })
})

/** 管理端鉴权:除 login/logout 外的 /api/admin/* 全部要求有效管理会话。 */
app.use('/api/admin/*', async (c, next) => {
  if (c.req.path === '/api/admin/login' || c.req.path === '/api/admin/logout') return next()
  if (!(await resolveAdmin(c.env, c.req.raw))) return adminUnauthorized()
  return next()
})

// ---- 数据概览 --------------------------------------------------------------

app.get('/api/admin/overview', async (c) => {
  const days = int(c.req.query('days'), 7, 90, 30)
  const data = await overviewStats(c.env.DB, days)
  return c.json(data)
})

// ---- 用户管理 --------------------------------------------------------------

app.get('/api/admin/users', async (c) => {
  const q = str(c.req.query('q')).slice(0, 60)
  const rawStatus = str(c.req.query('status')).slice(0, 20)
  const status: UserStatus | '' = (
    ['member', 'trial', 'churned', 'blacklist'] as const
  ).includes(rawStatus as UserStatus)
    ? (rawStatus as UserStatus)
    : ''
  const page = int(c.req.query('page'), 1, 10_000, 1)
  const pageSize = int(c.req.query('pageSize'), 5, 100, 20)
  const { rows, total } = await listUsers(c.env.DB, {
    q,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })
  return c.json({ rows, total, page, pageSize })
})

app.post('/api/admin/users/blacklist', async (c) => {
  let body: { id?: unknown; disabled?: unknown }
  try {
    body = (await c.req.json()) as { id?: unknown; disabled?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const id = str(body.id)
  const disabled = Boolean(body.disabled)
  if (!id) return c.json({ error: '缺少用户 id' }, 400)
  const changed = await setUserDisabled(c.env.DB, id, disabled)
  if (!changed) return c.json({ error: '用户不存在' }, 404)
  // 拉黑后立即踢掉该用户全部会话,同步与兑换接口随之失效
  if (disabled) await deleteSessionsOfUser(c.env.DB, id)
  return c.json({ ok: true })
})

app.post('/api/admin/users/activate', async (c) => {
  let body: { id?: unknown; activated?: unknown }
  try {
    body = (await c.req.json()) as { id?: unknown; activated?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const id = str(body.id)
  const activated = body.activated === undefined ? true : Boolean(body.activated)
  if (!id) return c.json({ error: '缺少用户 id' }, 400)
  const changed = await setUserActivated(c.env.DB, id, activated, nowIso())
  if (!changed) return c.json({ error: '用户不存在' }, 404)
  return c.json({ ok: true })
})

// 设为试用过期 / 恢复试用(管理端验证"试用结束"流程用)
app.post('/api/admin/users/trial', async (c) => {
  let body: { id?: unknown; expired?: unknown }
  try {
    body = (await c.req.json()) as { id?: unknown; expired?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const id = str(body.id)
  const expired = body.expired === undefined ? true : Boolean(body.expired)
  if (!id) return c.json({ error: '缺少用户 id' }, 400)
  const trialEndsIso = expired
    ? new Date(Date.now() - 86_400_000).toISOString() // 昨天过期
    : new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString() // 恢复完整试用窗口
  const changed = await setUserTrialEnds(c.env.DB, id, trialEndsIso)
  if (!changed) return c.json({ error: '用户不存在' }, 404)
  return c.json({ ok: true })
})

// ---- 激活码管理 ------------------------------------------------------------

app.get('/api/admin/codes', async (c) => {
  const status = str(c.req.query('status')).slice(0, 20)
  const q = str(c.req.query('q')).slice(0, 60)
  const page = int(c.req.query('page'), 1, 100_000, 1)
  const pageSize = int(c.req.query('pageSize'), 5, 200, 20)
  const data = await listActivationCodes(c.env.DB, {
    status,
    q,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })
  return c.json({ ...data, page, pageSize })
})

app.post('/api/admin/codes', async (c) => {
  let body: {
    count?: unknown
    prefix?: unknown
    length?: unknown
    note?: unknown
    batch?: unknown
  }
  try {
    body = (await c.req.json()) as {
      count?: unknown
      prefix?: unknown
      length?: unknown
      note?: unknown
      batch?: unknown
    }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const count = int(body.count, 1, 200, 10)
  const prefix = (str(body.prefix).slice(0, 8) || 'TK').toUpperCase()
  const length = int(body.length, 4, 24, 10)
  const note = str(body.note).slice(0, 200)
  const batch = str(body.batch).slice(0, 40) || 'B' + Date.now().toString(36).toUpperCase()
  const createdAt = nowIso()
  const seen = new Set<string>()
  const codes: Array<{ code: string; batch: string; note: string; createdAt: string }> = []
  let guard = 0
  while (codes.length < count && guard < count * 8) {
    guard += 1
    const code = `${prefix}-${randomCodeSegment(length)}`
    if (seen.has(code)) continue
    seen.add(code)
    codes.push({ code, batch, note, createdAt })
  }
  const created = await createActivationCodes(c.env.DB, codes)
  return c.json({ ok: true, created, batch, codes: codes.map((x) => x.code) })
})

app.post('/api/admin/codes/issue', async (c) => {
  let body: { codes?: unknown }
  try {
    body = (await c.req.json()) as { codes?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const codes = Array.isArray(body.codes)
    ? body.codes.filter((x): x is string => typeof x === 'string').slice(0, 500)
    : []
  if (codes.length === 0) return c.json({ error: '缺少激活码' }, 400)
  const n = await issueActivationCodes(c.env.DB, codes, nowIso())
  return c.json({ ok: true, issued: n })
})

app.post('/api/admin/codes/delete', async (c) => {
  let body: { codes?: unknown }
  try {
    body = (await c.req.json()) as { codes?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const codes = Array.isArray(body.codes)
    ? body.codes.filter((x): x is string => typeof x === 'string').slice(0, 500)
    : []
  if (codes.length === 0) return c.json({ error: '缺少激活码' }, 400)
  const n = await deleteActivationCodes(c.env.DB, codes)
  return c.json({ ok: true, deleted: n })
})

// ---- 数据统计(工具内页面 / 站点) -------------------------------------------

app.get('/api/admin/stats', async (c) => {
  const days = int(c.req.query('days'), 7, 90, 30)
  const [app, site] = await Promise.all([
    appPageStats(c.env.DB, days),
    siteStats(c.env.DB, days),
  ])
  return c.json({ days, app, site })
})

// ---- 版本记录管理 ----------------------------------------------------------

const ADMIN_RELEASES_SQL =
  'SELECT version, release_date, title, items, created_at FROM release_notes ORDER BY release_date DESC'

app.get('/api/admin/releases', async (c) => {
  const query = async () => {
    const { results } = await c.env.DB.prepare(ADMIN_RELEASES_SQL).all<ReleaseRow>()
    return sortReleasesDesc(results ?? []).map((r) => ({
      version: r.version,
      release_date: r.release_date,
      title: r.title,
      items: parseItems(r.items),
      created_at: r.created_at,
    }))
  }
  let releases
  try {
    releases = await query()
  } catch {
    await applySchema(c.env.DB)
    releases = await query()
  }
  return c.json({ releases })
})

app.post('/api/admin/releases', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const version = str(body.version).trim().slice(0, 20)
  const releaseDate = str(body.release_date ?? body.date).trim()
  const title = str(body.title).trim().slice(0, 80)
  const items = Array.isArray(body.items)
    ? body.items.filter((x) => typeof x === 'string').slice(0, 20)
    : []
  if (!version || !releaseDate || !title) {
    return c.json({ error: 'version, release_date 和 title 为必填' }, 400)
  }
  if (Number.isNaN(Date.parse(releaseDate))) {
    return c.json({ error: 'release_date 格式应为 YYYY-MM-DD' }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO release_notes (version, release_date, title, items, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(version) DO UPDATE SET
       release_date = excluded.release_date,
       title = excluded.title,
       items = excluded.items`,
  )
    .bind(version, releaseDate, title, JSON.stringify(items), nowIso())
    .run()
  return c.json({ ok: true })
})

app.put('/api/admin/releases', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const version = str(body.version).trim().slice(0, 20)
  const releaseDate = str(body.release_date ?? body.date).trim()
  const title = str(body.title).trim().slice(0, 80)
  const items = Array.isArray(body.items)
    ? body.items.filter((x) => typeof x === 'string').slice(0, 20)
    : []
  if (!version || !releaseDate || !title) {
    return c.json({ error: 'version, release_date 和 title 为必填' }, 400)
  }
  if (Number.isNaN(Date.parse(releaseDate))) {
    return c.json({ error: 'release_date 格式应为 YYYY-MM-DD' }, 400)
  }
  const r = await c.env.DB.prepare(
    `UPDATE release_notes SET release_date = ?, title = ?, items = ? WHERE version = ?`,
  )
    .bind(releaseDate, title, JSON.stringify(items), version)
    .run()
  if (!Number((r.meta as { changes?: number }).changes ?? 0)) {
    return c.json({ error: '版本记录不存在' }, 404)
  }
  return c.json({ ok: true })
})

app.delete('/api/admin/releases', async (c) => {
  const version = str(c.req.query('version')).trim()
  if (!version) return c.json({ error: '缺少 version' }, 400)
  const r = await c.env.DB.prepare('DELETE FROM release_notes WHERE version = ?').bind(version).run()
  if (!Number((r.meta as { changes?: number }).changes ?? 0)) {
    return c.json({ error: '版本记录不存在' }, 404)
  }
  return c.json({ ok: true })
})

// ---- 用户反馈(联系客服) ----------------------------------------------------

app.get('/api/admin/feedback', async (c) => {
  const kind = str(c.req.query('kind'))
  const status = str(c.req.query('status'))
  const limit = int(c.req.query('limit'), 1, 500, 200)
  const where: string[] = []
  const params: string[] = []
  if (kind === 'issue' || kind === 'demand') {
    where.push('kind = ?')
    params.push(kind)
  }
  if (status === 'open' || status === 'done' || status === 'replied') {
    where.push('status = ?')
    params.push(status)
  }
  const sql = `SELECT id, kind, content, user_id, email, app_version, contact_method, status, created_at
     FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`
  const stmt = c.env.DB.prepare(sql).bind(...params, limit)
  const { results } = await stmt.all<{
    id: number
    kind: string
    content: string
    user_id: string
    email: string
    app_version: string
    contact_method: string
    status: string
    created_at: string
  }>()
  const items = results ?? []
  // 关联平台回复(支持多轮回复)
  const ids = items.map((f) => f.id)
  const repliesMap = await listFeedbackReplies(c.env.DB, ids)
  const enriched = items.map((f) => ({
    ...f,
    replies: (repliesMap[f.id] ?? []).map((r) => ({ id: r.id, body: r.body, created_at: r.created_at })),
  }))
  return c.json({ items: enriched })
})

app.post('/api/admin/feedback/update', async (c) => {
  let body: { id?: unknown; status?: unknown }
  try {
    body = (await c.req.json()) as { id?: unknown; status?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const id = int(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
  const status = str(body.status)
  if (!id) return c.json({ error: '缺少 id' }, 400)
  if (status !== 'open' && status !== 'done') return c.json({ error: 'status 仅支持 open/done' }, 400)
  const r = await c.env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?')
    .bind(status, id)
    .run()
  if (!Number((r.meta as { changes?: number }).changes ?? 0)) {
    return c.json({ error: '反馈不存在' }, 404)
  }
  return c.json({ ok: true })
})

app.delete('/api/admin/feedback', async (c) => {
  const id = int(c.req.query('id'), 1, Number.MAX_SAFE_INTEGER, 0)
  if (!id) return c.json({ error: '缺少 id' }, 400)
  const r = await c.env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run()
  if (!Number((r.meta as { changes?: number }).changes ?? 0)) {
    return c.json({ error: '反馈不存在' }, 404)
  }
  return c.json({ ok: true })
})

/** 后台回复反馈:状态 open → replied;已处理(done)禁止再回复。回复条数不限。 */
app.post('/api/admin/feedback/reply', async (c) => {
  let body: { id?: unknown; body?: unknown }
  try {
    body = (await c.req.json()) as { id?: unknown; body?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const id = int(body.id, 1, Number.MAX_SAFE_INTEGER, 0)
  const reply = str(body.body).trim()
  if (!id) return c.json({ error: '缺少 id' }, 400)
  if (!reply) return c.json({ error: '请输入回复内容' }, 400)
  if (reply.length > 2000) return c.json({ error: '回复内容过长' }, 400)
  const row = await c.env.DB.prepare('SELECT id, status FROM feedback WHERE id = ?')
    .bind(id)
    .first<{ id: number; status: string }>()
  if (!row) return c.json({ error: '反馈不存在' }, 404)
  if (row.status === 'done') return c.json({ error: '已处理的反馈不可再回复' }, 409)
  await insertFeedbackReply(c.env.DB, id, reply, nowIso())
  // 有回复但未结案 → 标记为「已回复」
  if (row.status === 'open') {
    await c.env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?')
      .bind('replied', id)
      .run()
  }
  return c.json({ ok: true })
})

// ---- 客户端:本人反馈历史(登录后可见) ----------------------------------------

app.get('/api/feedback', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return c.json({ error: '请先登录' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, content, status, created_at, last_read_at
       FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all<{
      id: number
      kind: string
      content: string
      status: string
      created_at: string
      last_read_at: string
    }>()
  const items = results ?? []
  const ids = items.map((f) => f.id)
  const repliesMap = await listFeedbackReplies(c.env.DB, ids)
  const enriched = items.map((f) => {
    const replies = (repliesMap[f.id] ?? []).map((r) => ({
      id: r.id,
      body: r.body,
      created_at: r.created_at,
    }))
    const maxReplyAt = replies.reduce(
      (m, r) => (r.created_at > m ? r.created_at : m),
      '',
    )
    const unread =
      replies.length > 0 &&
      (f.last_read_at === '' || (maxReplyAt !== '' && maxReplyAt > f.last_read_at))
    return { ...f, replies, unread }
  })
  return c.json({ items: enriched })
})

/** 查看历史记录后标记本人全部反馈为已读。 */
app.post('/api/feedback/read', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return c.json({ error: '请先登录' }, 401)
  await markFeedbackRead(c.env.DB, userId, nowIso())
  return c.json({ ok: true })
})

// ---- 激活码兑换(客户端调用,需登录) ------------------------------------------

app.post('/api/activation/redeem', async (c) => {
  const userId = await resolveUser(c.env, c.req.raw)
  if (!userId) return unauthorized()
  let body: { code?: unknown }
  try {
    body = (await c.req.json()) as { code?: unknown }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const code = str(body.code).trim().toUpperCase().slice(0, 40)
  if (!code) return c.json({ error: '请输入激活码' }, 400)
  const result = await redeemActivationCode(c.env.DB, code, userId, nowIso())
  if (!result.ok) {
    return c.json({ error: result.error }, result.status === 404 ? 404 : 409)
  }
  return c.json({ ok: true, activated: true })
})

// ---- 用户反馈(联系客服):公开提交,已登录自动带上账号身份 -------------------

app.post('/api/feedback', async (c) => {
  let body: { kind?: unknown; content?: unknown; app_version?: unknown; contact_method?: unknown }
  try {
    body = (await c.req.json()) as {
      kind?: unknown
      content?: unknown
      app_version?: unknown
      contact_method?: unknown
    }
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const kind = str(body.kind) === 'demand' ? 'demand' : 'issue'
  const content = str(body.content).trim()
  if (!content) return c.json({ error: '请填写反馈内容' }, 400)
  if (content.length > 1000) return c.json({ error: '反馈内容请控制在 1000 字以内' }, 400)
  const appVersion = str(body.app_version).slice(0, 20)
  const contactMethod = str(body.contact_method).trim().slice(0, 60)
  const ip =
    c.req.header('cf-connecting-ip')?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    ''
  // 轻量防滥用:同一 IP 10 分钟内最多 5 条
  if (ip) {
    const since = new Date(Date.now() - 10 * 60_000).toISOString()
    const recent = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM feedback WHERE ip = ? AND created_at > ?',
    )
      .bind(ip, since)
      .first<{ n: number }>()
    if ((recent?.n ?? 0) >= 5) return c.json({ error: '提交太频繁,请稍后再试' }, 429)
  }
  // 已登录则关联账号(便于回访),未登录匿名提交
  let email = ''
  let userId = ''
  try {
    const uid = await resolveUser(c.env, c.req.raw)
    if (uid) {
      userId = uid
      const row = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
        .bind(uid)
        .first<{ email: string }>()
      email = row?.email ?? ''
    }
  } catch {
    // 匿名提交不受影响
  }
  await c.env.DB.prepare(
    `INSERT INTO feedback (kind, content, user_id, email, app_version, ip, contact_method, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8)`,
  )
    .bind(kind, content, userId, email, appVersion, ip, contactMethod, nowIso())
    .run()
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 非 /api 路径:代理官网下载页,让 todobar.tuanzhang.site 直接打开下载落地页
// ---------------------------------------------------------------------------

const SITE_UPSTREAM = 'https://todobar-app.app.workbuddy.host'

async function proxySite(request: Request, pathname: string, search: string): Promise<Response> {
  const target = SITE_UPSTREAM + pathname + search
  const resp = await fetch(target, { redirect: 'follow' })
  const headers = new Headers(resp.headers)
  headers.set('access-control-allow-origin', '*')
  return new Response(resp.body, { status: resp.status, headers })
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    // 自定义域名上的非 API 请求一律转发到下载页(404 修复的关键)
    if (!url.pathname.startsWith('/api/')) {
      return proxySite(request, url.pathname, url.search)
    }
    // 首个请求同步补好表结构,确保后续 upsert 不再因缺列而 422。
    try {
      await ensureSchema(env)
    } catch {
      // 建表失败不阻断请求,POST 内部还有一次补列重试兜底
    }
    return app.fetch(request, env, ctx)
  },
}
