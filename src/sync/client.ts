import type { Birthday, Recurrence, Task } from '../types'

// Wire format sent to / received from the Cloudflare Worker (snake_case, matches
// the D1 column names so the backend can store rows with minimal translation).
export interface WireTask {
  id: string
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

export interface WireBirthday {
  id: string
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

export interface PushResult {
  server_now: string
  accepted: number
  removed: number
}

export interface PullResult {
  server_now: string
  tasks: WireTask[]
  birthdays: WireBirthday[]
}

export interface SyncClient {
  push(
    tasks: Task[],
    deleted: string[],
    birthdays: Birthday[],
    deletedBirthdays: string[],
  ): Promise<PushResult>
  pull(since: string | null): Promise<PullResult>
}

const num = (b: boolean) => (b ? 1 : 0)

/** 读取错误响应体里的 {error},让界面显示服务器返回的真实原因而不是光秃秃的状态码。 */
async function errorDetail(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown }
    if (data && typeof data.error === 'string' && data.error) return `: ${data.error}`
  } catch {
    /* 响应体不是 JSON,忽略 */
  }
  if (res.status === 401) return ': 访问令牌无效或未在服务端注册'
  return ''
}

export function taskToWire(t: Task): WireTask {
  return {
    id: t.id,
    parent_id: t.parentId,
    list_id: t.listId,
    title: t.title,
    notes: t.notes || null,
    meta: t.meta || null,
    priority: t.priority,
    is_important: num(t.isImportant),
    is_pinned: num(t.isPinned),
    done: num(t.done),
    due_date: t.dueDate,
    due_end_date: t.dueEndDate ?? null,
    remind_at: t.remindAt,
    deleted_at: t.deletedAt,
    sort_order: t.sortOrder ?? null,
    recurrence: t.recurrence ? JSON.stringify(t.recurrence) : null,
    completed_dates: t.completedDates && t.completedDates.length > 0 ? JSON.stringify(t.completedDates) : null,
    deleted_dates: t.deletedDates && t.deletedDates.length > 0 ? JSON.stringify(t.deletedDates) : null,
    series_id: t.seriesId ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  }
}

export function wireToTask(w: WireTask): Task {
  return {
    id: w.id,
    parentId: w.parent_id ?? null,
    listId: w.list_id,
    title: w.title,
    notes: w.notes ?? '',
    meta: w.meta ?? '',
    priority: w.priority as Task['priority'],
    isImportant: Boolean(w.is_important),
    isPinned: Boolean(w.is_pinned),
    done: Boolean(w.done),
    dueDate: w.due_date ?? null,
    dueEndDate: w.due_end_date ?? null,
    remindAt: w.remind_at ?? null,
    deletedAt: w.deleted_at ?? null,
    sortOrder: typeof w.sort_order === 'number' ? w.sort_order : null,
    recurrence: w.recurrence ? safeParseRecurrence(w.recurrence) : null,
    completedDates: w.completed_dates ? safeParseDates(w.completed_dates) : [],
    deletedDates: w.deleted_dates ? safeParseDates(w.deleted_dates) : [],
    seriesId: w.series_id ?? null,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  }
}

function safeParseRecurrence(s: unknown): Recurrence | null {
  try {
    const r = typeof s === 'string' ? JSON.parse(s) : s
    if (r && typeof r === 'object' && 'freq' in r) return r as Recurrence
  } catch {
    /* ignore */
  }
  return null
}

function safeParseDates(s: unknown): string[] {
  try {
    const arr = typeof s === 'string' ? JSON.parse(s) : s
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string')
  } catch {
    /* ignore */
  }
  return []
}

export function birthdayToWire(b: Birthday): WireBirthday {
  return {
    id: b.id,
    name: b.name,
    relation: b.relation || null,
    kind: b.kind ?? 'birthday',
    avatar: b.avatar || null,
    calendar: b.calendar,
    month: b.month,
    day: b.day,
    is_leap_month: num(b.isLeapMonth),
    remind_enabled: num(b.remindEnabled),
    remind_hour: b.remindHour,
    remind_minute: b.remindMinute,
    remind_days_before: b.remindDaysBefore,
    note: b.note || null,
    deleted_at: b.deletedAt,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
  }
}

export function wireToBirthday(w: WireBirthday): Birthday {
  return {
    id: w.id,
    name: w.name ?? '',
    relation: w.relation ?? '',
    kind: (w.kind as Birthday['kind']) ?? 'birthday',
    avatar: w.avatar ?? '',
    calendar: (w.calendar as Birthday['calendar']) ?? 'solar',
    month: Number(w.month ?? 1),
    day: Number(w.day ?? 1),
    isLeapMonth: Boolean(w.is_leap_month),
    remindEnabled: Boolean(w.remind_enabled),
    remindHour: Number(w.remind_hour ?? 9),
    remindMinute: Number(w.remind_minute ?? 0),
    remindDaysBefore: Number(w.remind_days_before ?? 0),
    note: w.note ?? '',
    deletedAt: w.deleted_at ?? null,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  }
}

export function createHttpSyncClient(endpoint: string, token: string): SyncClient {
  const base = endpoint.replace(/\/+$/, '')
  // 经国内代理(托管平台会剥离 Authorization 头)时,用自定义头携带令牌,
  // 由代理侧还原为 Authorization 转发到 Cloudflare,从而实现不开 VPN 同步。
  const headers = {
    authorization: `Bearer ${token}`,
    'x-sync-token': token,
    'content-type': 'application/json',
  }
  return {
    async push(tasks, deleted, birthdays, deletedBirthdays) {
      const res = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tasks: tasks.map(taskToWire),
          deleted,
          birthdays: birthdays.map(birthdayToWire),
          deleted_birthdays: deletedBirthdays,
        }),
      })
      if (!res.ok) throw new Error(`push failed: ${res.status}${await errorDetail(res)}`)
      return (await res.json()) as PushResult
    },
    async pull(since) {
      const url = since
        ? `${base}/api/tasks?since=${encodeURIComponent(since)}`
        : `${base}/api/tasks`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`pull failed: ${res.status}${await errorDetail(res)}`)
      const data = (await res.json()) as PullResult
      return { server_now: data.server_now, tasks: data.tasks ?? [], birthdays: data.birthdays ?? [] }
    },
  }
}
