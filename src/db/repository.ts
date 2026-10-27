import type { Birthday, Recurrence, SyncConfig, SyncState, Task, TaskList } from '../types'

/**
 * Storage contract used by the UI and the sync engine. Two production impls
 * exist (SQLite on the desktop, localStorage in the web preview) plus an
 * in-memory impl used by the engine unit tests.
 */
export interface TaskRepository {
  init(): Promise<void>
  getAllTasks(): Promise<Task[]>
  getAllLists(): Promise<TaskList[]>
  saveList(list: TaskList): Promise<void>
  deleteList(id: string): Promise<void>
  saveTask(task: Task): Promise<void>
  saveTasks(tasks: Task[]): Promise<void>
  deleteTask(id: string, at: string): Promise<void>
  purgeTask(id: string): Promise<void>
  /** Last-Write-Wins merge of a task pulled from the server. */
  mergeTask(incoming: Task): Promise<void>
  /** Queue every existing task for push (used when sync is first enabled). */
  enqueueAllTasks(): Promise<void>
  getSettings(): Promise<SyncConfig>
  saveSettings(config: SyncConfig): Promise<void>
  getOutbox(): Promise<Task[]>
  getOutboxDeleted(): Promise<string[]>
  clearOutbox(ids: string[], deleted: string[]): Promise<void>
  getSyncState(): Promise<SyncState>
  setSyncState(patch: Partial<SyncState>): Promise<void>
  // ---- 生日记录 -----------------------------------------------------------
  // 生日与任务共用同一套 outbox/push 通道,同步协议在 wire 层用 kind 区分。
  getAllBirthdays(): Promise<Birthday[]>
  saveBirthday(birthday: Birthday): Promise<void>
  deleteBirthday(id: string, at: string): Promise<void>
  purgeBirthday(id: string): Promise<void>
  mergeBirthday(incoming: Birthday): Promise<void>
  enqueueAllBirthdays(): Promise<void>
  getOutboxBirthdays(): Promise<Birthday[]>
  getOutboxBirthdayDeleted(): Promise<string[]>
  clearBirthdayOutbox(ids: string[], deleted: string[]): Promise<void>
}

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  endpoint: '',
  token: '',
  autoSync: true,
  intervalSec: 30,
}

// ---------------------------------------------------------------------------
// 账号分库(本地数据按账号隔离)
//
// 云端数据按会话令牌天然隔离,但此前本地只有一份库:换账号登录后,上一账号的
// 任务仍留在库里,一旦编辑就会推送到新账号的云端(数据互传)。现在每个邮箱
// 账号使用独立的本地库(桌面端独立 .db 文件,预览端独立 localStorage 前缀),
// 未登录时的数据保留在默认的「游客库」里,老用户升级零感知。
// ---------------------------------------------------------------------------

/** 当前活跃资料库对应的账号邮箱;null = 游客库(默认库)。 */
let activeProfileEmail: string | null = null

const PROFILE_POINTER_KEY = 'todobar.profileEmail'

/** 读取持久化的资料库指针(localStorage 被清后回落游客库,账号数据仍在盘上不丢)。 */
export function getStoredProfilePointer(): string | null {
  try {
    const v = localStorage.getItem(PROFILE_POINTER_KEY)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

export function getActiveProfile(): string | null {
  return activeProfileEmail
}

/** 切换活跃资料库指针并持久化。库连接由调用方负责重开(SqliteStore.repoint 等)。 */
export function setActiveProfile(email: string | null): void {
  activeProfileEmail = email && email.trim() ? email.trim() : null
  try {
    if (activeProfileEmail) localStorage.setItem(PROFILE_POINTER_KEY, activeProfileEmail)
    else localStorage.removeItem(PROFILE_POINTER_KEY)
  } catch {
    /* 隐私模式等写入失败不致命,指针仅剩内存态 */
  }
}

/** 启动时恢复指针:已登录账号优先,其次沿用上次活跃账号(退出登录仍显示其数据)。 */
export function resolveBootProfile(loggedInEmail: string | null): string | null {
  return loggedInEmail ?? getStoredProfilePointer()
}

/** 同步字符串哈希(FNV-1a ×2,16 hex):从邮箱派生稳定的分库文件名片段。
 *  仅用于本地文件命名,非安全用途,碰撞概率可忽略。 */
function profileTag(email: string): string {
  const s = email.trim().toLowerCase()
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = (h1 ^ c) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ ((c << 3) | (i & 7))) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return `u-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** localStorage 键名加资料库前缀(预览端分库);游客库键名保持原样(兼容旧数据)。 */
function prefixedKey(key: string): string {
  const tag = activeProfileEmail ? profileTag(activeProfileEmail) : ''
  return tag ? `todobar.${tag}.${key.slice('todobar.'.length)}` : key
}

const DEFAULT_SYNC_STATE: SyncState = {
  status: 'idle',
  lastPushAt: null,
  lastPullAt: null,
  pending: 0,
  lastError: null,
}

// ---------------------------------------------------------------------------
// In-memory base store (used for tests and as the engine for the web preview
// when wrapped by BrowserStore below).
// ---------------------------------------------------------------------------

type OutboxEntry = { deleted: boolean }

export class MapStore implements TaskRepository {
  protected tasks = new Map<string, Task>()
  protected lists = new Map<string, TaskList>()
  protected birthdays = new Map<string, Birthday>()
  protected outbox = new Map<string, OutboxEntry>()
  protected bOutbox = new Map<string, OutboxEntry>()
  protected syncConfig: SyncConfig = { ...DEFAULT_SYNC_CONFIG }
  protected syncState: SyncState = { ...DEFAULT_SYNC_STATE }

  async init(): Promise<void> {
    if (this.lists.size === 0) {
      this.lists.set('today', {
        id: 'today',
        title: 'Today',
        kind: 'today',
        collapsed: false,
        position: 0,
      })
      this.lists.set('month', {
        id: 'month',
        title: 'Month Plan',
        kind: 'month',
        collapsed: false,
        position: 1,
      })
      this.persist()
    }
  }

  protected persist(): void {
    // Overridden by BrowserStore.
  }

  async getAllTasks(): Promise<Task[]> {
    return [...this.tasks.values()]
  }

  async getAllLists(): Promise<TaskList[]> {
    return [...this.lists.values()].sort((a, b) => a.position - b.position)
  }

  async saveList(list: TaskList): Promise<void> {
    this.lists.set(list.id, list)
    this.persist()
  }

  async deleteList(id: string): Promise<void> {
    this.lists.delete(id)
    for (const [tid, t] of this.tasks) {
      if (t.listId === id) this.tasks.delete(tid)
    }
    this.persist()
  }

  async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task)
    this.outbox.set(task.id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async saveTasks(tasks: Task[]): Promise<void> {
    for (const t of tasks) this.tasks.set(t.id, t)
    for (const t of tasks) this.outbox.set(t.id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async deleteTask(id: string, at: string): Promise<void> {
    const t = this.tasks.get(id)
    if (t) {
      this.tasks.set(id, { ...t, deletedAt: at, updatedAt: at })
      this.outbox.set(id, { deleted: false })
      this.syncState.pending = this.outbox.size + this.bOutbox.size
      this.persist()
    }
  }

  async purgeTask(id: string): Promise<void> {
    this.tasks.delete(id)
    this.outbox.set(id, { deleted: true })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async mergeTask(incoming: Task): Promise<void> {
    const local = this.tasks.get(incoming.id)
    if (!local || incoming.updatedAt > local.updatedAt) {
      this.tasks.set(incoming.id, incoming)
      this.persist()
    }
  }

  async enqueueAllTasks(): Promise<void> {
    for (const id of this.tasks.keys()) this.outbox.set(id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  // ---- 生日记录 -----------------------------------------------------------

  async getAllBirthdays(): Promise<Birthday[]> {
    return [...this.birthdays.values()]
  }

  async saveBirthday(birthday: Birthday): Promise<void> {
    this.birthdays.set(birthday.id, birthday)
    this.bOutbox.set(birthday.id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async deleteBirthday(id: string, at: string): Promise<void> {
    const b = this.birthdays.get(id)
    if (!b) return
    this.birthdays.set(id, { ...b, deletedAt: at, updatedAt: at })
    this.bOutbox.set(id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async purgeBirthday(id: string): Promise<void> {
    this.birthdays.delete(id)
    this.bOutbox.set(id, { deleted: true })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async mergeBirthday(incoming: Birthday): Promise<void> {
    const local = this.birthdays.get(incoming.id)
    if (!local || incoming.updatedAt > local.updatedAt) {
      this.birthdays.set(incoming.id, incoming)
      this.persist()
    }
  }

  async enqueueAllBirthdays(): Promise<void> {
    for (const id of this.birthdays.keys()) this.bOutbox.set(id, { deleted: false })
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async getOutboxBirthdays(): Promise<Birthday[]> {
    const result: Birthday[] = []
    for (const [id, entry] of this.bOutbox) {
      if (!entry.deleted && this.birthdays.has(id)) result.push(this.birthdays.get(id)!)
    }
    return result
  }

  async getOutboxBirthdayDeleted(): Promise<string[]> {
    return [...this.bOutbox.entries()].filter(([, e]) => e.deleted).map(([id]) => id)
  }

  async clearBirthdayOutbox(ids: string[], deleted: string[]): Promise<void> {
    for (const id of [...ids, ...deleted]) this.bOutbox.delete(id)
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async getSettings(): Promise<SyncConfig> {
    return { ...this.syncConfig }
  }

  async saveSettings(config: SyncConfig): Promise<void> {
    this.syncConfig = { ...config }
    this.persist()
  }

  async getOutbox(): Promise<Task[]> {
    const result: Task[] = []
    for (const [id, entry] of this.outbox) {
      if (!entry.deleted && this.tasks.has(id)) result.push(this.tasks.get(id)!)
    }
    return result
  }

  async getOutboxDeleted(): Promise<string[]> {
    return [...this.outbox.entries()]
      .filter(([, e]) => e.deleted)
      .map(([id]) => id)
  }

  async clearOutbox(ids: string[], deleted: string[]): Promise<void> {
    for (const id of ids) this.outbox.delete(id)
    for (const id of deleted) this.outbox.delete(id)
    this.syncState.pending = this.outbox.size + this.bOutbox.size
    this.persist()
  }

  async getSyncState(): Promise<SyncState> {
    return { ...this.syncState }
  }

  async setSyncState(patch: Partial<SyncState>): Promise<void> {
    this.syncState = { ...this.syncState, ...patch }
    this.persist()
  }
}

// ---------------------------------------------------------------------------
// Web-preview store: same logic, persisted to localStorage.
// ---------------------------------------------------------------------------

export class BrowserStore extends MapStore {
  private loaded = false

  async init(): Promise<void> {
    if (!this.loaded) {
      this.load()
      this.loaded = true
    }
    await super.init()
  }

  private load(): void {
    try {
      const tasks = localStorage.getItem(prefixedKey('todobar.tasks.v2'))
      if (tasks) for (const t of JSON.parse(tasks) as Task[]) this.tasks.set(t.id, t)
      const lists = localStorage.getItem(prefixedKey('todobar.lists.v2'))
      if (lists) for (const l of JSON.parse(lists) as TaskList[]) this.lists.set(l.id, l)
      const outbox = localStorage.getItem(prefixedKey('todobar.outbox.v2'))
      if (outbox)
        for (const [k, v] of Object.entries(JSON.parse(outbox) as Record<string, OutboxEntry>))
          this.outbox.set(k, v)
      const birthdays = localStorage.getItem(prefixedKey('todobar.birthdays.v1'))
      if (birthdays) for (const b of JSON.parse(birthdays) as Birthday[]) this.birthdays.set(b.id, b)
      const bOutbox = localStorage.getItem(prefixedKey('todobar.boutbox.v1'))
      if (bOutbox)
        for (const [k, v] of Object.entries(JSON.parse(bOutbox) as Record<string, OutboxEntry>))
          this.bOutbox.set(k, v)
      const cfg = localStorage.getItem(prefixedKey('todobar.sync.v2'))
      if (cfg) this.syncConfig = { ...DEFAULT_SYNC_CONFIG, ...JSON.parse(cfg) }
      const st = localStorage.getItem(prefixedKey('todobar.syncstate.v2'))
      if (st) this.syncState = { ...DEFAULT_SYNC_STATE, ...JSON.parse(st) }
    } catch {
      // Corrupt storage -> start clean.
    }
  }

  protected persist(): void {
    try {
      localStorage.setItem(prefixedKey('todobar.tasks.v2'), JSON.stringify([...this.tasks.values()]))
      localStorage.setItem(prefixedKey('todobar.lists.v2'), JSON.stringify([...this.lists.values()]))
      localStorage.setItem(
        prefixedKey('todobar.outbox.v2'),
        JSON.stringify(Object.fromEntries(this.outbox)),
      )
      localStorage.setItem(
        prefixedKey('todobar.birthdays.v1'),
        JSON.stringify([...this.birthdays.values()]),
      )
      localStorage.setItem(
        prefixedKey('todobar.boutbox.v1'),
        JSON.stringify(Object.fromEntries(this.bOutbox)),
      )
      localStorage.setItem(prefixedKey('todobar.sync.v2'), JSON.stringify(this.syncConfig))
      localStorage.setItem(prefixedKey('todobar.syncstate.v2'), JSON.stringify(this.syncState))
    } catch {
      // Best-effort persistence in the preview.
    }
  }

  /** 预览端切换资料库:清空内存态并按新前缀重载(桌面端走 SqliteStore.repoint)。 */
  async reloadForProfile(): Promise<void> {
    this.tasks.clear()
    this.lists.clear()
    this.birthdays.clear()
    this.outbox.clear()
    this.bOutbox.clear()
    this.syncConfig = { ...DEFAULT_SYNC_CONFIG }
    this.syncState = { ...DEFAULT_SYNC_STATE }
    this.load()
    await super.init()
  }
}

// ---------------------------------------------------------------------------
// Desktop store: Tauri SQLite via @tauri-apps/plugin-sql.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function rowToTask(r: Row): Task {
  let recurrence: Recurrence | null = null
  if (r.recurrence && typeof r.recurrence === 'string' && r.recurrence.length > 0) {
    try {
      recurrence = JSON.parse(r.recurrence as string) as Recurrence
    } catch {
      recurrence = null
    }
  }
  let completedDates: string[] = []
  if (r.completed_dates && typeof r.completed_dates === 'string' && r.completed_dates.length > 0) {
    try {
      const arr = JSON.parse(r.completed_dates as string)
      if (Array.isArray(arr)) completedDates = arr.filter((x) => typeof x === 'string')
    } catch {
      completedDates = []
    }
  }
  let deletedDates: string[] = []
  if (r.deleted_dates && typeof r.deleted_dates === 'string' && r.deleted_dates.length > 0) {
    try {
      const arr = JSON.parse(r.deleted_dates as string)
      if (Array.isArray(arr)) deletedDates = arr.filter((x) => typeof x === 'string')
    } catch {
      deletedDates = []
    }
  }
  return {
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    listId: r.list_id as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? '',
    meta: (r.meta as string | null) ?? '',
    priority: r.priority as Task['priority'],
    isImportant: Boolean(r.is_important),
    isPinned: Boolean(r.is_pinned),
    done: Boolean(r.done),
    dueDate: (r.due_date as string | null) ?? null,
    dueEndDate: (r.due_end_date as string | null) ?? null,
    remindAt: (r.remind_at as string | null) ?? null,
    recurrence,
    completedDates,
    deletedDates,
    seriesId: (r.series_id as string | null) ?? null,
    deletedAt: (r.deleted_at as string | null) ?? null,
    sortOrder: typeof r.sort_order === 'number' ? r.sort_order : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function rowToSettings(r: Row | undefined): SyncState {
  return r ? (JSON.parse(r.value as string) as SyncState) : { ...DEFAULT_SYNC_STATE }
}

function rowToBirthday(r: Row): Birthday {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? '',
    relation: (r.relation as string | null) ?? '',
    kind: (r.kind as Birthday['kind']) ?? 'birthday',
    avatar: (r.avatar as string | null) ?? '',
    calendar: (r.calendar as Birthday['calendar']) ?? 'solar',
    month: Number(r.month ?? 1),
    day: Number(r.day ?? 1),
    isLeapMonth: Boolean(r.is_leap_month),
    remindEnabled: Boolean(r.remind_enabled),
    remindHour: Number(r.remind_hour ?? 9),
    remindMinute: Number(r.remind_minute ?? 0),
    remindDaysBefore: Number(r.remind_days_before ?? 0),
    note: (r.note as string | null) ?? '',
    deletedAt: (r.deleted_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

const LOCAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, parent_id TEXT, list_id TEXT NOT NULL, title TEXT NOT NULL,
    notes TEXT, meta TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    is_important INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0, due_date TEXT, remind_at TEXT, deleted_at TEXT,
    sort_order INTEGER, recurrence TEXT, completed_dates TEXT, deleted_dates TEXT, series_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS birthdays (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', relation TEXT,
    kind TEXT NOT NULL DEFAULT 'birthday', avatar TEXT,
    calendar TEXT NOT NULL DEFAULT 'solar', month INTEGER NOT NULL DEFAULT 1,
    day INTEGER NOT NULL DEFAULT 1, is_leap_month INTEGER NOT NULL DEFAULT 0,
    remind_enabled INTEGER NOT NULL DEFAULT 1, remind_hour INTEGER NOT NULL DEFAULT 9,
    remind_minute INTEGER NOT NULL DEFAULT 0, remind_days_before INTEGER NOT NULL DEFAULT 0,
    note TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox (task_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS b_outbox (birthday_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS sync_config (key TEXT PRIMARY KEY, value TEXT)`,
]

const BIRTHDAY_COLUMNS = [
  'id', 'name', 'relation', 'kind', 'avatar', 'calendar', 'month', 'day', 'is_leap_month',
  'remind_enabled', 'remind_hour', 'remind_minute', 'remind_days_before',
  'note', 'deleted_at', 'created_at', 'updated_at',
]

const TASK_COLUMNS = [
  'id', 'parent_id', 'list_id', 'title', 'notes', 'meta', 'priority',
  'is_important', 'is_pinned', 'done', 'due_date', 'due_end_date', 'remind_at',
  'deleted_at', 'sort_order', 'recurrence', 'completed_dates', 'deleted_dates', 'series_id',
  'created_at', 'updated_at',
]

export class SqliteStore implements TaskRepository {
  // Loaded lazily so the module is safe to import in the web preview.
  private db: any = null

  /** 显示用:用户选择的自定义目录(设置页展示)。 */
  static DB_DIR_KEY = 'todobar.dataDir'

  /** 连接用:plugin-sql 的 sqlite 相对路径键。
   *  default = 'todobar.db'(app_config_dir 内);
   *  自定义 = 'todobar_data/todobar.db'(app_config_dir/todobar_data 是到用户目录的 junction)。 */
  static DB_KEY = 'todobar.dbKey'

  /** 读取用户自定义数据目录(持久化在 localStorage),用于设置页展示。 */
  static getDataDir(): string | null {
    try {
      const v = localStorage.getItem(SqliteStore.DB_DIR_KEY)
      return v && v.trim() ? v.trim() : null
    } catch {
      return null
    }
  }

  /** 跨更新持久化的连接键(由 Rust init_data_dir 在启动时写入,优先于 localStorage)。 */
  static dbKeyOverride: string | null = null

  /** 写回当前连接的 dbKey(迁移后由 JS 持久化,同时更新内存 override 与 localStorage 缓存)。 */
  static setDbKey(key: string | null) {
    SqliteStore.dbKeyOverride = key && key.trim() ? key.trim() : null
    try {
      if (key && key.trim()) localStorage.setItem(SqliteStore.DB_KEY, key.trim())
      else localStorage.removeItem(SqliteStore.DB_KEY)
    } catch {
      /* 忽略 */
    }
  }

  /** 写回当前展示用的自定义目录(设置页展示)。 */
  static setDataDir(value: string | null) {
    try {
      if (value && value.trim()) localStorage.setItem(SqliteStore.DB_DIR_KEY, value.trim())
      else localStorage.removeItem(SqliteStore.DB_DIR_KEY)
    } catch {
      /* 忽略 */
    }
  }

  /** 基础库路径(不含账号分库后缀):优先跨更新持久化的 dbKey,其次 localStorage,最后默认库名。 */
  private basePath(): string {
    const norm = (k: string) => (k.startsWith('sqlite:') ? k.slice('sqlite:'.length) : k)
    if (SqliteStore.dbKeyOverride && SqliteStore.dbKeyOverride.trim()) {
      return norm(SqliteStore.dbKeyOverride.trim())
    }
    let key: string | null = null
    try {
      key = localStorage.getItem(SqliteStore.DB_KEY)
    } catch {
      /* 忽略 */
    }
    return key && key.trim() ? norm(key.trim()) : 'todobar.db'
  }

  /** 当前连接用的 sqlite 路径:基础路径 + 账号分库后缀。
   *  游客(null)= 基础库本身;账号 = 在 .db 前插入 .u-<hash>,如
   *  'todobar.db' → 'todobar.u-1a2b….db'、'todobar_data/todobar.db' →
   *  'todobar_data/todobar.u-1a2b….db'(自定义目录 junction 天然覆盖分库文件)。
   *  注意:plugin-sql 的 sqlite: 方案永远相对 app_config_dir,无法直接用绝对路径,
   *  因此自定义目录通过 app_config_dir/todobar_data 这个 junction 间接实现。 */
  private connectionPath(): string {
    const base = this.basePath()
    if (!activeProfileEmail) return 'sqlite:' + base
    const accountFile = base.replace(/\.db$/i, '') + '.' + profileTag(activeProfileEmail) + '.db'
    return 'sqlite:' + accountFile
  }

  /** 游客库连接键(迁移/清理临时连接用)。 */
  private guestPath(): string {
    return 'sqlite:' + this.basePath()
  }

  /** 当前是否正连着游客库。 */
  isGuestProfile(): boolean {
    return !activeProfileEmail
  }

  /** 读取游客库全量快照(供首次登录把本地数据并入账号库)。临时开连接,读完即关。
   *  当前就在游客库时返回 null(无意义);快照包含软删除行,由调用方决定取舍。 */
  async readGuestSnapshot(): Promise<{
    tasks: Task[]
    birthdays: Birthday[]
    lists: TaskList[]
  } | null> {
    if (this.isGuestProfile()) return null
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    let g: any = null
    try {
      g = await Database.load(this.guestPath())
      const tasks = (await g.select('SELECT * FROM tasks')) as Row[]
      const birthdays = (await g.select('SELECT * FROM birthdays')) as Row[]
      const lists = (await g.select('SELECT * FROM lists')) as Row[]
      return {
        tasks: tasks.map(rowToTask),
        birthdays: birthdays.map(rowToBirthday),
        lists: lists.map((r) => ({
          id: r.id as string,
          title: r.title as string,
          kind: r.kind as TaskList['kind'],
          collapsed: Boolean(r.collapsed),
          position: Number(r.position),
        })),
      }
    } catch {
      return null
    } finally {
      try {
        // 坑:plugin-sql 的 close() 不带参数会关闭**全部**连接池(含主账号库),
        // 导致迁移循环的下一条写入落在已关闭的连接上抛错。必须只关游客库这一条。
        await g?.close(g.path)
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 迁移完成后清空游客库内容(数据已并入账号库,防止再次登录其他新账号时重复并入)。
   *  仅清业务数据与同步队列/配置,保留表结构。 */
  async clearGuestData(): Promise<void> {
    if (this.isGuestProfile()) return
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    let g: any = null
    try {
      g = await Database.load(this.guestPath())
      await g.execute('DELETE FROM tasks')
      await g.execute('DELETE FROM birthdays')
      await g.execute("DELETE FROM lists WHERE kind = 'custom'")
      await g.execute('DELETE FROM outbox')
      await g.execute('DELETE FROM b_outbox')
      await g.execute("DELETE FROM sync_state WHERE key = 'state'")
      await g.execute("DELETE FROM sync_config WHERE key = 'cfg'")
    } catch {
      /* 游客库可能不存在(全新安装即登录),忽略 */
    } finally {
      try {
        // 同上:只关游客库连接池,绝不能误杀主账号库(见 readGuestSnapshot 注释)。
        await g?.close(g.path)
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 迁移前:关闭当前连接(文件交由 Rust 复制/建 junction)。 */
  async closeForMigration(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close()
      } catch {
        /* 忽略 */
      }
      this.db = null
    }
  }

  /** 按当前 localStorage 中的 dbKey 重新打开连接(含建表/补列)。 */
  async repoint(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close()
      } catch {
        /* 忽略 */
      }
      this.db = null
    }
    await this.ensure()
  }

  private async ensure(): Promise<any> {
    if (this.db) return this.db
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    try {
      this.db = await Database.load(this.connectionPath())
    } catch (e) {
      // 自定义位置加载失败(如目录不可写、junction 失效):保留用户的选择指针,
      // 仅回退到默认库以保应用可用,绝不再抹掉 DB_DIR_KEY(否则设置页会误显「默认」,
      // 且与真实连接位置不一致)。等待用户重新选择或工具自动修复 junction。
      if (SqliteStore.getDataDir()) {
        console.warn('[SqliteStore] 自定义数据位置加载失败,临时回退默认库:', e)
        this.db = await Database.load('sqlite:todobar.db')
      } else {
        throw e
      }
    }
    for (const stmt of LOCAL_SCHEMA) await this.db.execute(stmt)
    // 旧库补列。每列必须独立 try:SQLite 的 ALTER 遇到已存在的列会抛错,
    // 若合并成一个 try,首条抛错后其余列永远不会被补上(历史缺陷:导致
    // saveTask 持续报 "no column named deleted_dates",所有写入静默失败)。
    const taskColumnMigrations: [string, string][] = [
      ['sort_order', 'INTEGER'],
      ['recurrence', 'TEXT'],
      ['completed_dates', 'TEXT'],
      ['deleted_dates', 'TEXT'],
      ['series_id', 'TEXT'],
      ['due_end_date', 'TEXT'],
    ]
    for (const [col, type] of taskColumnMigrations) {
      try {
        await this.db.execute(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`)
      } catch {
        // Column already exists.
      }
    }
    try {
      await this.db.execute("ALTER TABLE birthdays ADD COLUMN kind TEXT NOT NULL DEFAULT 'birthday'")
    } catch {
      // Column already exists.
    }
    try {
      await this.db.execute('ALTER TABLE birthdays ADD COLUMN avatar TEXT')
    } catch {
      // Column already exists.
    }
    return this.db
  }

  async init(): Promise<void> {
    const db = await this.ensure()
    const lists = (await db.select('SELECT id FROM lists')) as Row[]
    if (lists.length === 0) {
      await db.execute(
        "INSERT INTO lists (id, title, kind, collapsed, position) VALUES ('today','Today','today',0,0), ('month','Month Plan','month',0,1)",
      )
    }
  }

  async getAllTasks(): Promise<Task[]> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT * FROM tasks')) as Row[]
    return rows.map(rowToTask)
  }

  async getAllLists(): Promise<TaskList[]> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT * FROM lists ORDER BY position')) as Row[]
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      kind: r.kind as TaskList['kind'],
      collapsed: Boolean(r.collapsed),
      position: Number(r.position),
    }))
  }

  async saveList(list: TaskList): Promise<void> {
    const db = await this.ensure()
    await db.execute(
      'INSERT INTO lists (id, title, kind, collapsed, position) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, kind=excluded.kind, collapsed=excluded.collapsed, position=excluded.position',
      [list.id, list.title, list.kind, list.collapsed ? 1 : 0, list.position],
    )
  }

  async deleteList(id: string): Promise<void> {
    const db = await this.ensure()
    await db.execute('DELETE FROM tasks WHERE list_id = ?', [id])
    await db.execute('DELETE FROM lists WHERE id = ?', [id])
  }

  private taskParams(t: Task): unknown[] {
    return [
      t.id, t.parentId ?? null, t.listId, t.title, t.notes || null,
      t.meta || null, t.priority, t.isImportant ? 1 : 0, t.isPinned ? 1 : 0,
      t.done ? 1 : 0, t.dueDate ?? null, t.dueEndDate ?? null, t.remindAt ?? null,
      t.deletedAt ?? null, t.sortOrder ?? null,
      t.recurrence ? JSON.stringify(t.recurrence) : null,
      t.completedDates && t.completedDates.length > 0 ? JSON.stringify(t.completedDates) : null,
      t.deletedDates && t.deletedDates.length > 0 ? JSON.stringify(t.deletedDates) : null,
      t.seriesId ?? null,
      t.createdAt, t.updatedAt,
    ]
  }

  async saveTask(task: Task): Promise<void> {
    const db = await this.ensure()
    await db.execute(
      `INSERT INTO tasks (${TASK_COLUMNS.join(',')}) VALUES (${TASK_COLUMNS.map(() => '?').join(',')})
       ON CONFLICT(id) DO UPDATE SET ${TASK_COLUMNS.slice(1)
         .map((c) => `${c}=excluded.${c}`)
         .join(', ')}`,
      this.taskParams(task),
    )
    await db.execute('INSERT OR REPLACE INTO outbox (task_id, deleted) VALUES (?, 0)', [task.id])
    await this.bumpPending(db)
  }

  async saveTasks(tasks: Task[]): Promise<void> {
    for (const t of tasks) await this.saveTask(t)
  }

  async deleteTask(id: string, at: string): Promise<void> {
    const db = await this.ensure()
    await db.execute('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id])
    await db.execute('INSERT OR REPLACE INTO outbox (task_id, deleted) VALUES (?, 0)', [id])
    await this.bumpPending(db)
  }

  async purgeTask(id: string): Promise<void> {
    const db = await this.ensure()
    await db.execute('DELETE FROM tasks WHERE id = ?', [id])
    await db.execute('INSERT OR REPLACE INTO outbox (task_id, deleted) VALUES (?, 1)', [id])
    await this.bumpPending(db)
  }

  async mergeTask(incoming: Task): Promise<void> {
    const db = await this.ensure()
    const local = (await db.select('SELECT updated_at FROM tasks WHERE id = ?', [incoming.id])) as Row[]
    if (local.length === 0 || incoming.updatedAt > (local[0].updated_at as string)) {
      await db.execute(
        `INSERT INTO tasks (${TASK_COLUMNS.join(',')}) VALUES (${TASK_COLUMNS.map(() => '?').join(',')})
         ON CONFLICT(id) DO UPDATE SET ${TASK_COLUMNS.slice(1)
           .map((c) => `${c}=excluded.${c}`)
           .join(', ')} WHERE excluded.updated_at > tasks.updated_at`,
        this.taskParams(incoming),
      )
    }
  }

  async enqueueAllTasks(): Promise<void> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT id FROM tasks')) as Row[]
    for (const r of rows) {
      await db.execute('INSERT OR REPLACE INTO outbox (task_id, deleted) VALUES (?, 0)', [r.id])
    }
    await this.bumpPending(db)
  }

  async enqueueAllBirthdays(): Promise<void> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT id FROM birthdays')) as Row[]
    for (const r of rows) {
      await db.execute('INSERT OR REPLACE INTO b_outbox (birthday_id, deleted) VALUES (?, 0)', [r.id])
    }
    await this.bumpPending(db)
  }

  async getOutboxBirthdays(): Promise<Birthday[]> {
    const db = await this.ensure()
    const rows = (await db.select(
      'SELECT b.* FROM b_outbox o JOIN birthdays b ON b.id = o.birthday_id WHERE o.deleted = 0',
    )) as Row[]
    return rows.map(rowToBirthday)
  }

  async getOutboxBirthdayDeleted(): Promise<string[]> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT birthday_id FROM b_outbox WHERE deleted = 1')) as Row[]
    return rows.map((r) => r.birthday_id as string)
  }

  async clearBirthdayOutbox(ids: string[], deleted: string[]): Promise<void> {
    const db = await this.ensure()
    for (const id of [...ids, ...deleted]) {
      await db.execute('DELETE FROM b_outbox WHERE birthday_id = ?', [id])
    }
    await this.bumpPending(db)
  }

  async getAllBirthdays(): Promise<Birthday[]> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT * FROM birthdays')) as Row[]
    return rows.map(rowToBirthday)
  }

  private birthdayParams(b: Birthday): unknown[] {
    return [
      b.id, b.name, b.relation || null, b.kind ?? 'birthday', b.avatar || null,
      b.calendar, b.month, b.day,
      b.isLeapMonth ? 1 : 0, b.remindEnabled ? 1 : 0, b.remindHour, b.remindMinute,
      b.remindDaysBefore, b.note || null, b.deletedAt ?? null, b.createdAt, b.updatedAt,
    ]
  }

  async saveBirthday(birthday: Birthday): Promise<void> {
    const db = await this.ensure()
    await db.execute(
      `INSERT INTO birthdays (${BIRTHDAY_COLUMNS.join(',')}) VALUES (${BIRTHDAY_COLUMNS.map(() => '?').join(',')})
       ON CONFLICT(id) DO UPDATE SET ${BIRTHDAY_COLUMNS.slice(1)
         .map((c) => `${c}=excluded.${c}`)
         .join(', ')}`,
      this.birthdayParams(birthday),
    )
    await db.execute('INSERT OR REPLACE INTO b_outbox (birthday_id, deleted) VALUES (?, 0)', [birthday.id])
    await this.bumpPending(db)
  }

  async deleteBirthday(id: string, at: string): Promise<void> {
    const db = await this.ensure()
    await db.execute('UPDATE birthdays SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id])
    await db.execute('INSERT OR REPLACE INTO b_outbox (birthday_id, deleted) VALUES (?, 0)', [id])
    await this.bumpPending(db)
  }

  async purgeBirthday(id: string): Promise<void> {
    const db = await this.ensure()
    await db.execute('DELETE FROM birthdays WHERE id = ?', [id])
    await db.execute('INSERT OR REPLACE INTO b_outbox (birthday_id, deleted) VALUES (?, 1)', [id])
    await this.bumpPending(db)
  }

  async mergeBirthday(incoming: Birthday): Promise<void> {
    const db = await this.ensure()
    const local = (await db.select('SELECT updated_at FROM birthdays WHERE id = ?', [incoming.id])) as Row[]
    if (local.length === 0 || incoming.updatedAt > (local[0].updated_at as string)) {
      await db.execute(
        `INSERT INTO birthdays (${BIRTHDAY_COLUMNS.join(',')}) VALUES (${BIRTHDAY_COLUMNS.map(() => '?').join(',')})
         ON CONFLICT(id) DO UPDATE SET ${BIRTHDAY_COLUMNS.slice(1)
           .map((c) => `${c}=excluded.${c}`)
           .join(', ')} WHERE excluded.updated_at > birthdays.updated_at`,
        this.birthdayParams(incoming),
      )
    }
  }

  private async bumpPending(db: any): Promise<void> {
    const count = (await db.select(
      'SELECT (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM b_outbox) AS n',
    )) as Row[]
    const n = Number(count[0]?.n ?? 0)
    await db.execute(
      "INSERT INTO sync_state (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify({ ...(await this.readState(db)), pending: n })],
    )
  }

  private async readState(db: any): Promise<SyncState> {
    const rows = (await db.select("SELECT value FROM sync_state WHERE key='state'")) as Row[]
    return rowToSettings(rows[0])
  }

  async getSettings(): Promise<SyncConfig> {
    const db = await this.ensure()
    const rows = (await db.select("SELECT value FROM sync_config WHERE key='cfg'")) as Row[]
    return rows[0] ? { ...DEFAULT_SYNC_CONFIG, ...JSON.parse(rows[0].value as string) } : { ...DEFAULT_SYNC_CONFIG }
  }

  async saveSettings(config: SyncConfig): Promise<void> {
    const db = await this.ensure()
    await db.execute(
      "INSERT INTO sync_config (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(config)],
    )
  }

  async getOutbox(): Promise<Task[]> {
    const db = await this.ensure()
    const rows = (await db.select(
      'SELECT t.* FROM outbox o JOIN tasks t ON t.id = o.task_id WHERE o.deleted = 0',
    )) as Row[]
    return rows.map(rowToTask)
  }

  async getOutboxDeleted(): Promise<string[]> {
    const db = await this.ensure()
    const rows = (await db.select('SELECT task_id FROM outbox WHERE deleted = 1')) as Row[]
    return rows.map((r) => r.task_id as string)
  }

  async clearOutbox(ids: string[], deleted: string[]): Promise<void> {
    const db = await this.ensure()
    for (const id of [...ids, ...deleted]) {
      await db.execute('DELETE FROM outbox WHERE task_id = ?', [id])
    }
    await this.bumpPending(db)
  }

  async getSyncState(): Promise<SyncState> {
    const db = await this.ensure()
    return this.readState(db)
  }

  async setSyncState(patch: Partial<SyncState>): Promise<void> {
    const db = await this.ensure()
    const next = { ...(await this.readState(db)), ...patch }
    await db.execute(
      "INSERT INTO sync_state (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(next)],
    )
  }
}
