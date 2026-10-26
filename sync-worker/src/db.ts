import type { D1Database } from '@cloudflare/workers-types'

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  parent_id    TEXT,
  list_id      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  notes        TEXT,
  meta         TEXT,
  priority     TEXT    NOT NULL DEFAULT 'normal',
  is_important INTEGER NOT NULL DEFAULT 0,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT,
  remind_at    TEXT,
  deleted_at   TEXT,
  sort_order   INTEGER,
  recurrence   TEXT,
  completed_dates TEXT,
  deleted_dates TEXT,
  series_id    TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_updated ON tasks(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_parent  ON tasks(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_list    ON tasks(user_id, list_id);

CREATE TABLE IF NOT EXISTS birthdays (
  id                 TEXT    NOT NULL,
  user_id            TEXT    NOT NULL,
  name               TEXT    NOT NULL DEFAULT '',
  relation           TEXT,
  kind               TEXT    NOT NULL DEFAULT 'birthday',
  avatar             TEXT,
  calendar           TEXT    NOT NULL DEFAULT 'solar',
  month              INTEGER NOT NULL DEFAULT 1,
  day                INTEGER NOT NULL DEFAULT 1,
  is_leap_month      INTEGER NOT NULL DEFAULT 0,
  remind_enabled     INTEGER NOT NULL DEFAULT 1,
  remind_hour        INTEGER NOT NULL DEFAULT 9,
  remind_minute      INTEGER NOT NULL DEFAULT 0,
  remind_days_before INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  deleted_at         TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_birthdays_user_updated ON birthdays(user_id, updated_at);

CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id)
);

-- ===== 账号体系(P1):users / email_codes / sessions =====
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  nickname      TEXT,
  avatar        TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  activated     INTEGER NOT NULL DEFAULT 0,
  activated_at  TEXT,
  trial_ends_at TEXT,
  created_at    TEXT    NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS email_codes (
  email       TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  salt        TEXT    NOT NULL,
  purpose     TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  device_id    TEXT,
  device_name  TEXT,
  created_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  PRIMARY KEY (token)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS release_notes (
  version      TEXT    NOT NULL,
  release_date TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  items        TEXT    NOT NULL DEFAULT '[]',
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (version)
);

-- ===== 后台管理平台:管理员会话 / 激活码 / 埋点事件 =====
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (token)
);

-- 激活码:status = unissued(未发放) | issued(已发放) | used(已使用)
CREATE TABLE IF NOT EXISTS activation_codes (
  code        TEXT    NOT NULL,
  batch       TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'unissued',
  used_by     TEXT,
  used_at     TEXT,
  issued_at   TEXT,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (code)
);
CREATE INDEX IF NOT EXISTS idx_codes_status ON activation_codes(status, created_at);

-- 埋点事件:source = site(下载页) 或 app(工具内),event 取值见 ALLOWED_EVENTS
CREATE TABLE IF NOT EXISTS analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  page        TEXT    NOT NULL DEFAULT '',
  visitor     TEXT    NOT NULL DEFAULT '',
  meta        TEXT    NOT NULL DEFAULT '',
  ts          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON analytics_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event ON analytics_events(event, ts);

-- 用户反馈(联系客服):kind = issue(问题反馈) | demand(需求提报)
-- status = open(待反馈) | replied(已回复) | done(已处理)
CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL DEFAULT 'issue',
  content       TEXT    NOT NULL,
  user_id       TEXT    NOT NULL DEFAULT '',
  email         TEXT    NOT NULL DEFAULT '',
  app_version   TEXT    NOT NULL DEFAULT '',
  ip            TEXT    NOT NULL DEFAULT '',
  contact_method TEXT   NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'open',
  last_read_at  TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at);

-- 反馈回复:平台(管理员)回复内容,支持多次回复(is_platform 列预留,当前全部为平台回复)
CREATE TABLE IF NOT EXISTS feedback_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id  INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  is_platform  INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fbreplies_fb ON feedback_replies(feedback_id, created_at);

INSERT OR IGNORE INTO release_notes (version, release_date, title, items, created_at) VALUES
('0.2.8', '2026-10-16', '修复更新后丢失数据与登录态', '["修复更新后存储位置被重置、页面变空:存储位置指针与登录态改由主目录 ~/.ticktask/config.json 持久化,跨更新存活,启动自愈","修复「恢复云端数据」无反馈:登录态跨更新保留,未登录明确提示,成功精确反馈条数","新增「查找本地数据」:扫描常见位置找回误丢失的本地数据库目录,一键恢复"]', '2026-10-16T20:00:00.000Z'),
('0.2.9', '2026-10-16', '同步与登录态体验修复', '["修复「更改存储位置」后设置页误显默认位置:连接键 sqlite: 前缀重复拼接导致加载失败、指针被误清;设置页回显改读持久化配置真源","恢复云端数据/自动补齐一律过滤云端已删除(墓碑)数据,已删除事项绝不复活","重新登录或新设备登录后自动从云端补齐缺失数据(只增不删:本地已有的跳过,本地多出的保留)","登录态令牌失效(云端 401)时自动清除僵尸登录态:账号区立即回到未登录,不再出现已登录样式但同步一直失败","启动时一次性清理 WebView 旧缓存,修复更新后界面仍显示旧文案(如「同步 (Cloudflare)」)的问题","设置页「同步」分组去掉 (Cloudflare) 文案"]', '2026-10-16T22:00:00.000Z'),
('0.2.7', '2026-10-16', '恢复云端数据与万年历改版', '["待办设置页新增「恢复云端数据」按钮:支持用云端覆盖本地,或在现有基础上补充","补充模式按事项 ID 去重:本地已存在的事项直接跳过,绝不产生重复两条","万年历页面 UI 重设计:统一为现代极简风格,工具栏毛玻璃、卡片圆角化、配色更柔和"]', '2026-10-16T18:00:00.000Z'),
('0.2.6', '2026-10-16', '管理后台体验修复', '["概览图表样式统一:同一卡片不再同时渲染双图,X 轴刻度/字体/节点大小一致,卡片间距更紧凑","用户管理新增「设为试用过期」操作:一键把用户置为试用已过期且未激活,便于验证流程","修复数据统计页面一直「加载中」的问题(日期数组取值修正)"]', '2026-10-16T12:00:00.000Z'),
('0.2.5', '2026-10-16', '会员状态同步与体验优化', '["修复:后台激活/兑换激活码后,工具端会员状态未即时更新——启动与打开设置页时自动同步云端状态","管理后台体验优化:本地缓存优先加载、图表悬浮数据浮窗、界面 LOGO 与工具统一"]', '2026-10-16T10:00:00.000Z'),
('0.2.4', '2026-10-15', '激活码兑换与数据埋点', '["设置页新增激活码输入:兑换后升级会员,永久全功能","匿名数据埋点:启动 / 页面访问 / 功能点击,用于产品改进(不含任何任务内容)","本地队列批量上报,断网不丢,恢复后自动补发"]', '2026-10-15T20:00:00.000Z'),
('0.2.3', '2026-10-15', '体验优化与本地存储', '["头像 / 昵称修改提示移至页面顶部并自动消失","保存昵称头像改为本地即时生效 + 云端异步静默同步","同步设置精简:去掉启用开关,自动同步关闭时收起间隔选项","官网版本记录默认仅显示 3 条,可展开查看全部","新增本地数据存储路径设置,可自定义数据目录"]', '2026-10-15T10:00:00.000Z'),
('0.2.2', '2026-10-15', '同步与账号体验优化', '["头像 / 昵称修改成功改为 toast 提示","退出登录增加确认弹窗","同步去掉手动配置的服务地址与访问令牌,登录即用","关闭每次增删改的即时同步,改为定时 + 手动同步","数据按用户严格隔离"]', '2026-10-15T08:00:00.000Z'),
('0.2.1', '2026-10-14', '账户中心升级', '["设置页账户区改为头像 + 昵称布局,未登录显示默认头像与「未登录」","登录 / 注册 / 找回密码统一为弹窗,支持自定义头像与昵称","修复获取验证码偶发 500 的建表问题,同步服务更稳定"]', '2026-10-14T17:40:00.000Z'),
('0.2.0', '2026-10-14', '账号系统上线', '["新增账号系统:邮箱注册 / 登录 / 修改密码","云同步改用登录令牌,数据按账号隔离,无需手填同步令牌","设备管理:最多 3 台设备,支持远程解绑"]', '2026-10-14T16:50:00.000Z'),
('0.1.9', '2026-10-14', 'TickTask 正式更名与应用内更新', '["产品更名为 TickTask,界面与官网全面更新","新增设置页「版本」字段:一键检查更新并站内下载安装","界面一览截图尺寸优化"]', '2026-10-14T12:00:00.000Z'),
('0.1.8', '2026-10-14', '国内免 VPN 同步', '["经国内代理地址即可同步,无需 VPN","修复老版本云端数据库缺列导致的同步失败","同步失败时界面显示服务器返回的具体原因"]', '2026-10-14T10:00:00.000Z'),
('0.1.7', '2026-10-14', '同步修复与体验优化', '["修复老版本云端数据库导致的同步失败","同步失败时显示服务器返回的具体原因","下载页界面一览支持大图横向滚动浏览"]', '2026-10-14T08:00:00.000Z'),
('0.1.6', '2026-10-13', '全新外观与同步优化', '["全新应用图标与官网配色","设置页新增赛博、动漫两款精选背景","自动同步间隔可选 5 分钟至 12 小时","官网新增版本更新记录页面"]', '2026-10-13T08:00:00.000Z'),
('0.1.5', '2026-10-12', '首个公开版本', '["贴边悬浮待办栏,鼠标一划即出","日 / 周 / 月视图与万年历节假日","生日与纪念日提醒","内置计算器:计算、日期、汇率换算","多设备云同步","自定义字体与背景"]', '2026-10-12T08:00:00.000Z');
`

export type TaskRow = {
  id: string
  user_id: string
  parent_id: string | null
  list_id: string
  title: string
  notes: string | null
  meta: string | null
  priority: string
  is_important: number
  is_pinned: number
  done: number
  due_date: string | null
  due_end_date: string | null
  remind_at: string | null
  deleted_at: string | null
  sort_order: number | null
  recurrence: string | null
  completed_dates: string | null
  deleted_dates: string | null
  series_id: string | null
  created_at: string
  updated_at: string
}

export type BirthdayRow = {
  id: string
  user_id: string
  name: string
  relation: string | null
  kind: string
  avatar: string | null
  calendar: string
  month: number
  day: number
  is_leap_month: number
  remind_enabled: number
  remind_hour: number
  remind_minute: number
  remind_days_before: number
  note: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** Split SQL on ';' that are NOT inside single-quoted string literals.
 *  Seed INSERTs embed JSON inside single-quoted values, and that JSON may
 *  legitimately contain ';' (e.g. Chinese punctuation). A naive split(';')
 *  would mangle those statements, so we honour string context. */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      // SQL 转义引号用 '' 表示,跳过第二个引号,避免误切换字符串状态
      if (inString && sql[i + 1] === "'") {
        cur += "''"
        i++
        continue
      }
      inString = !inString
      cur += ch
      continue
    }
    if (ch === ';' && !inString) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Idempotently create the schema. Safe to call on every cold start. */
export async function applySchema(db: D1Database): Promise<string[]> {
  // 逐条执行:单条失败不中断,但**收集失败详情**返回给调用方——
  // 之前用 db.exec + 静默吞错,线上建表失败完全无感知,排查极其困难。
  // 改用 prepare().run()(D1 对多语句 exec 行为不稳定),并跳过纯注释语句。
  const failures: string[] = []
  const run = async (raw: string) => {
    // 去掉行内注释,避免部分驱动对 "--" 开头语句处理异常
    const sql = raw
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')
      .trim()
    if (!sql) return
    try {
      await db.prepare(sql + ';').run()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/already exists/i.test(msg)) return
      const snippet = sql.replace(/\s+/g, ' ').slice(0, 70)
      failures.push(`${snippet}… → ${msg}`)
      console.error('[schema] 语句失败:', snippet, '::', msg)
    }
  }
  const statements = splitSqlStatements(SCHEMA_SQL)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const sql of statements) await run(sql)
  // 旧库补列(已存在时报 duplicate column,忽略)
  const alters = [
    'ALTER TABLE tasks ADD COLUMN sort_order INTEGER',
    'ALTER TABLE tasks ADD COLUMN recurrence TEXT',
    'ALTER TABLE tasks ADD COLUMN completed_dates TEXT',
    'ALTER TABLE tasks ADD COLUMN deleted_dates TEXT',
    'ALTER TABLE tasks ADD COLUMN series_id TEXT',
    'ALTER TABLE tasks ADD COLUMN due_end_date TEXT',
    "ALTER TABLE birthdays ADD COLUMN kind TEXT NOT NULL DEFAULT 'birthday'",
    'ALTER TABLE birthdays ADD COLUMN avatar TEXT',
    'ALTER TABLE users ADD COLUMN nickname TEXT',
    'ALTER TABLE users ADD COLUMN avatar TEXT',
    "ALTER TABLE feedback ADD COLUMN contact_method TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE feedback ADD COLUMN last_read_at TEXT NOT NULL DEFAULT ''",
  ]
  for (const sql of alters) {
    try {
      await db.prepare(sql).run()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/duplicate column|already exists/i.test(msg)) continue
      failures.push(`${sql} → ${msg}`)
      console.error('[schema] 补列失败:', sql, '::', msg)
    }
  }
  return failures
}

const TASK_COLUMNS = [
  'id',
  'user_id',
  'parent_id',
  'list_id',
  'title',
  'notes',
  'meta',
  'priority',
  'is_important',
  'is_pinned',
  'done',
  'due_date',
  'due_end_date',
  'remind_at',
  'deleted_at',
  'sort_order',
  'recurrence',
  'completed_dates',
  'deleted_dates',
  'series_id',
  'created_at',
  'updated_at',
]

/**
 * Pull every task changed after `since` (ISO string). When `since` is null we
 * return the full data set for that user — used on first sync / device restore.
 */
export async function listTasksSince(
  db: D1Database,
  userId: string,
  since: string | null,
): Promise<TaskRow[]> {
  const sql = since
    ? `SELECT * FROM tasks WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC`
    : `SELECT * FROM tasks WHERE user_id = ? ORDER BY updated_at ASC`
  const bind = since ? [userId, since] : [userId]
  const result = await db.prepare(sql).bind(...bind).all<TaskRow>()
  return result.results
}

/**
 * Server-side Last-Write-Wins upsert. We only overwrite an existing row when the
 * incoming `updated_at` is strictly newer, so concurrent edits from two devices
 * converge without one silently clobbering the other's newer change.
 */
export async function upsertTasks(
  db: D1Database,
  userId: string,
  tasks: TaskRow[],
): Promise<number> {
  let accepted = 0
  for (const t of tasks) {
    const sql = `
      INSERT INTO tasks (
        ${TASK_COLUMNS.join(', ')}
      ) VALUES (
        ${TASK_COLUMNS.map(() => '?').join(', ')}
      )
      ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id,
        parent_id=excluded.parent_id,
        list_id=excluded.list_id,
        title=excluded.title,
        notes=excluded.notes,
        meta=excluded.meta,
        priority=excluded.priority,
        is_important=excluded.is_important,
        is_pinned=excluded.is_pinned,
        done=excluded.done,
        due_date=excluded.due_date,
        due_end_date=excluded.due_end_date,
        remind_at=excluded.remind_at,
        deleted_at=excluded.deleted_at,
        sort_order=excluded.sort_order,
        recurrence=excluded.recurrence,
        completed_dates=excluded.completed_dates,
        deleted_dates=excluded.deleted_dates,
        series_id=excluded.series_id,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
      WHERE excluded.updated_at > tasks.updated_at
        AND tasks.user_id = excluded.user_id
    `
    const params = [
      t.id,
      userId,
      t.parent_id ?? null,
      t.list_id,
      t.title,
      t.notes ?? null,
      t.meta ?? null,
      t.priority,
      t.is_important ? 1 : 0,
      t.is_pinned ? 1 : 0,
      t.done ? 1 : 0,
      t.due_date ?? null,
      t.due_end_date ?? null,
      t.remind_at ?? null,
      t.deleted_at ?? null,
      t.sort_order ?? null,
      t.recurrence ?? null,
      t.completed_dates ?? null,
      t.deleted_dates ?? null,
      t.series_id ?? null,
      t.created_at,
      t.updated_at,
    ]
    await db.prepare(sql).bind(...params).run()
    accepted += 1
  }
  return accepted
}

/** Hard-delete rows the client has already soft-deleted and purged locally. */
export async function hardDeleteTasks(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const sql = `DELETE FROM tasks WHERE user_id = ? AND id IN (${placeholders})`
  const result = await db.prepare(sql).bind(userId, ...ids).run()
  return Number((result.meta as { changes?: number }).changes ?? ids.length)
}

export async function getSettings(
  db: D1Database,
  userId: string,
): Promise<{ payload: string; updated_at: string } | null> {
  const row = await db
    .prepare('SELECT payload, updated_at FROM settings WHERE user_id = ?')
    .bind(userId)
    .first<{ payload: string; updated_at: string }>()
  return row ?? null
}

export async function putSettings(
  db: D1Database,
  userId: string,
  payload: string,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (user_id, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         payload=excluded.payload,
         updated_at=excluded.updated_at
       WHERE excluded.updated_at > settings.updated_at`,
    )
    .bind(userId, payload, updatedAt)
    .run()
}

// ---------------------------------------------------------------------------
// Birthdays
// ---------------------------------------------------------------------------

const BIRTHDAY_COLUMNS = [
  'id',
  'user_id',
  'name',
  'relation',
  'kind',
  'avatar',
  'calendar',
  'month',
  'day',
  'is_leap_month',
  'remind_enabled',
  'remind_hour',
  'remind_minute',
  'remind_days_before',
  'note',
  'deleted_at',
  'created_at',
  'updated_at',
]

export async function listBirthdaysSince(
  db: D1Database,
  userId: string,
  since: string | null,
): Promise<BirthdayRow[]> {
  const sql = since
    ? `SELECT * FROM birthdays WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC`
    : `SELECT * FROM birthdays WHERE user_id = ? ORDER BY updated_at ASC`
  const bind = since ? [userId, since] : [userId]
  const result = await db.prepare(sql).bind(...bind).all<BirthdayRow>()
  return result.results
}

export async function upsertBirthdays(
  db: D1Database,
  userId: string,
  birthdays: BirthdayRow[],
): Promise<number> {
  let accepted = 0
  for (const b of birthdays) {
    const sql = `
      INSERT INTO birthdays (
        ${BIRTHDAY_COLUMNS.join(', ')}
      ) VALUES (
        ${BIRTHDAY_COLUMNS.map(() => '?').join(', ')}
      )
      ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id,
        name=excluded.name,
        relation=excluded.relation,
        kind=excluded.kind,
        avatar=excluded.avatar,
        calendar=excluded.calendar,
        month=excluded.month,
        day=excluded.day,
        is_leap_month=excluded.is_leap_month,
        remind_enabled=excluded.remind_enabled,
        remind_hour=excluded.remind_hour,
        remind_minute=excluded.remind_minute,
        remind_days_before=excluded.remind_days_before,
        note=excluded.note,
        deleted_at=excluded.deleted_at,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
      WHERE excluded.updated_at > birthdays.updated_at
        AND birthdays.user_id = excluded.user_id
    `
    const params = [
      b.id,
      userId,
      b.name,
      b.relation ?? null,
      b.kind ?? 'birthday',
      b.avatar ?? null,
      b.calendar,
      b.month,
      b.day,
      b.is_leap_month ? 1 : 0,
      b.remind_enabled ? 1 : 0,
      b.remind_hour,
      b.remind_minute,
      b.remind_days_before,
      b.note ?? null,
      b.deleted_at ?? null,
      b.created_at,
      b.updated_at,
    ]
    await db.prepare(sql).bind(...params).run()
    accepted += 1
  }
  return accepted
}

export async function hardDeleteBirthdays(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const sql = `DELETE FROM birthdays WHERE user_id = ? AND id IN (${placeholders})`
  const result = await db.prepare(sql).bind(userId, ...ids).run()
  return Number((result.meta as { changes?: number }).changes ?? ids.length)
}

// ---------------------------------------------------------------------------
// 账号体系(P1):users / email_codes / sessions
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string
  email: string
  password_hash: string
  salt: string
  nickname: string | null
  avatar: string | null
  email_verified: number
  activated: number
  activated_at: string | null
  trial_ends_at: string | null
  created_at: string
  disabled: number
}

export interface EmailCodeRow {
  email: string
  code_hash: string
  salt: string
  purpose: string
  expires_at: string
  attempts: number
  created_at: string
}

export interface SessionRow {
  token: string
  user_id: string
  device_id: string | null
  device_name: string | null
  created_at: string
  last_seen_at: string
  expires_at: string
}

export async function createUser(
  db: D1Database,
  u: {
    id: string
    email: string
    passwordHash: string
    salt: string
    nickname: string | null
    avatar: string | null
    createdAt: string
    trialEndsAt: string | null
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, salt, nickname, avatar, email_verified, activated, trial_ends_at, created_at, disabled)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 0)`,
    )
    .bind(u.id, u.email, u.passwordHash, u.salt, u.nickname, u.avatar, u.trialEndsAt, u.createdAt)
    .run()
}

/** 更新昵称/头像(传 null 表示不改该字段)。 */
export async function updateUserProfile(
  db: D1Database,
  id: string,
  patch: { nickname?: string | null; avatar?: string | null },
): Promise<void> {
  const sets: string[] = []
  const params: (string | null)[] = []
  if (patch.nickname !== undefined) {
    sets.push('nickname = ?')
    params.push(patch.nickname)
  }
  if (patch.avatar !== undefined) {
    sets.push('avatar = ?')
    params.push(patch.avatar)
  }
  if (sets.length === 0) return
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run()
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return (
    (await db
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(email)
      .first<UserRow>()) ?? null
  )
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return (
    (await db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first<UserRow>()) ?? null
  )
}

export async function updateUserPassword(
  db: D1Database,
  id: string,
  passwordHash: string,
  salt: string,
): Promise<void> {
  await db
    .prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
    .bind(passwordHash, salt, id)
    .run()
}

/** 插入一条新验证码,并清掉同一邮箱同用途的旧码,保证只认最新一条。 */
export async function insertEmailCode(
  db: D1Database,
  c: {
    email: string
    codeHash: string
    salt: string
    purpose: string
    expiresAt: string
    createdAt: string
  },
): Promise<void> {
  await db
    .prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?')
    .bind(c.email, c.purpose)
    .run()
  await db
    .prepare(
      `INSERT INTO email_codes (email, code_hash, salt, purpose, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(c.email, c.codeHash, c.salt, c.purpose, c.expiresAt, c.createdAt)
    .run()
}

export async function getLatestEmailCode(
  db: D1Database,
  email: string,
  purpose: string,
): Promise<EmailCodeRow | null> {
  return (
    (await db
      .prepare(
        'SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
      )
      .bind(email, purpose)
      .first<EmailCodeRow>()) ?? null
  )
}

export async function bumpEmailCodeAttempts(
  db: D1Database,
  email: string,
  purpose: string,
): Promise<void> {
  await db
    .prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?')
    .bind(email, purpose)
    .run()
}

export async function deleteEmailCodes(
  db: D1Database,
  email: string,
  purpose: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?')
    .bind(email, purpose)
    .run()
}

export async function createSession(
  db: D1Database,
  s: {
    token: string
    userId: string
    deviceId: string | null
    deviceName: string | null
    createdAt: string
    expiresAt: string
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (token, user_id, device_id, device_name, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.token, s.userId, s.deviceId, s.deviceName, s.createdAt, s.createdAt, s.expiresAt)
    .run()
}

export async function getSession(
  db: D1Database,
  token: string,
): Promise<SessionRow | null> {
  return (
    (await db
      .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
      .bind(token, new Date().toISOString())
      .first<SessionRow>()) ?? null
  )
}

export async function touchSession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?')
    .bind(new Date().toISOString(), token)
    .run()
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

export async function listSessions(db: D1Database, userId: string): Promise<SessionRow[]> {
  const r = await db
    .prepare(
      'SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
    )
    .bind(userId, new Date().toISOString())
    .all<SessionRow>()
  return r.results ?? []
}

/** 统计有效设备数:只数未过期的会话(过期会话不占设备额度,历史缺陷曾导致幽灵设备占满上限)。 */
export async function countSessions(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?')
    .bind(userId, new Date().toISOString())
    .first<{ n: number }>()
  return Number(r?.n ?? 0)
}

/** 删除某用户所有已过期的会话(登录前清理,过期设备不占额度)。 */
export async function purgeExpiredSessions(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?')
    .bind(userId, new Date().toISOString())
    .run()
}

/** 删除某用户指定 deviceId 的会话(同设备重登视为同一台,不新增设备行)。 */
export async function deleteSessionsByDeviceId(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND device_id = ?')
    .bind(userId, deviceId)
    .run()
}

/** 返回该用户最久未活跃的会话(自动解绑用)。 */
export async function oldestSession(
  db: D1Database,
  userId: string,
): Promise<SessionRow | null> {
  return (
    (await db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at ASC LIMIT 1')
      .bind(userId)
      .first<SessionRow>()) ?? null
  )
}

export async function revokeSessionForUser(
  db: D1Database,
  userId: string,
  token: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token = ?')
    .bind(userId, token)
    .run()
}

/** 保留 keepToken,删除该用户其余全部会话(一键解绑其他设备,清理历史幽灵设备)。 */
export async function deleteOtherSessions(
  db: D1Database,
  userId: string,
  keepToken: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .bind(userId, keepToken)
    .run()
}

export async function deleteAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

// ---------------------------------------------------------------------------
// 用户反馈(联系客服):回复 / 历史 / 已读
// ---------------------------------------------------------------------------

/** 插入一条平台(管理员)回复。 */
export async function insertFeedbackReply(
  db: D1Database,
  feedbackId: number,
  body: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feedback_replies (feedback_id, body, is_platform, created_at)
       VALUES (?, ?, 1, ?)`,
    )
    .bind(feedbackId, body, createdAt)
    .run()
}

/** 批量取出若干反馈的回复,按 feedback_id 分组(按时间升序)。 */
export async function listFeedbackReplies(
  db: D1Database,
  feedbackIds: number[],
): Promise<Record<number, { id: number; body: string; created_at: string }[]>> {
  const out: Record<number, { id: number; body: string; created_at: string }[]> = {}
  if (feedbackIds.length === 0) return out
  const placeholders = feedbackIds.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT id, feedback_id, body, created_at FROM feedback_replies
       WHERE feedback_id IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .bind(...feedbackIds)
    .all<{ id: number; feedback_id: number; body: string; created_at: string }>()
  for (const r of rows.results ?? []) {
    ;(out[r.feedback_id] ||= []).push({ id: r.id, body: r.body, created_at: r.created_at })
  }
  return out
}

/** 将某用户全部反馈标记为已读(查看历史记录时调用)。 */
export async function markFeedbackRead(db: D1Database, userId: string, now: string): Promise<void> {
  await db
    .prepare('UPDATE feedback SET last_read_at = ? WHERE user_id = ?')
    .bind(now, userId)
    .run()
}

