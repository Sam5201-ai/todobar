// Unified domain model shared by the desktop app, the local store and the
// Cloudflare sync backend. `updatedAt` is the conflict-resolution clock
// (Last-Write-Wins); `id` is a UUID so edits from two devices never collide.

export type Priority = 'focus' | 'normal' | 'later'

/**
 * 重复规则。普通任务只存一个具体 dueDate;重复任务(模板)用规则表达「何时发生」,
 * 由 recurrence.ts 在运行时投影出虚拟实例落入日/周/月 tab。
 * weekdays 用 ISO 周几:1=周一 … 7=周日。
 */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly'

export interface Recurrence {
  freq: RecurrenceFreq
  /** weekly 时生效:周几发生(1-7)。 */
  weekdays?: number[]
  /** monthly 时生效:每月几号(1-31)。 */
  monthDay?: number
  /** 起始日(YYYY-MM-DD),之前不发生。 */
  anchorDate?: string | null
  /** 结束日(YYYY-MM-DD),之后不再发生。 */
  until?: string | null
  /** 开启后,发生日若落在法定节假日则跳过(不生成该日待办)。 */
  skipHolidays?: boolean
}

export interface Task {
  id: string
  parentId: string | null
  listId: string
  title: string
  notes: string
  meta: string
  priority: Priority
  isImportant: boolean
  isPinned: boolean
  done: boolean
  dueDate: string | null
  /** 处理日期区间结束日(ISO);为空表示与 dueDate 同日。区间内每天都显示该事项。 */
  dueEndDate?: string | null
  remindAt: string | null
  /** 重复规则;为空表示一次性任务。带规则的任务是「模板」,不单独渲染。 */
  recurrence?: Recurrence | null
  /** 重复模板专属:已勾掉的各发生日(YYYY-MM-DD 列表),用于按天标记完成。 */
  completedDates?: string[]
  /** 重复模板专属:被单独删除的各发生日(YYYY-MM-DD 列表),投影时跳过这些日期。 */
  deletedDates?: string[]
  /** 虚拟实例专属:指回其模板 id(templateId@dateKey 是其运行期 id)。 */
  seriesId?: string | null
  /** 虚拟实例专属:携带模板的重复规则,仅用于列表行展示「每天/每周X/每月」标签,不落库。 */
  seriesRecurrence?: Recurrence | null
  /** Set when the user deletes the task; the row stays for history/sync. */
  deletedAt: string | null
  /** Manual ordering within its sibling list (index); null = auto order. */
  sortOrder?: number | null
  createdAt: string
  updatedAt: string
}

export type ListKind = 'today' | 'month' | 'custom'
export interface TaskList {
  id: string
  title: string
  kind: ListKind
  collapsed: boolean
  position: number
}

// ---- 生日记录 --------------------------------------------------------------
//
// 生日是「每年重复」的事项,因此不能用一次性的 remindAt 时间戳表达。这里存
// 「历法 + 月 + 日 + 提醒时分」,由 App 在运行时换算成「今年的那一个时刻」。
// 公历直接取当月同日;农历需先算出该农历月日在当年对应哪一天公历。

export type CalendarKind = 'solar' | 'lunar'

/** 记录类型:生日(人) / 纪念日(事件)。 */
export type OccasionKind = 'birthday' | 'anniversary'

export interface Birthday {
  id: string
  /** 好友或家人名称;纪念日时为纪念日名称。 */
  name: string
  /** 与名称的关系(本人/家人/好友/同事…),仅作展示,可为空。 */
  relation: string
  /** 记录类型,默认生日。 */
  kind: OccasionKind
  /** 头像标识:'a1'~'a5';空字符串表示未指定(列表里回退为首字头像)。 */
  avatar: string
  /** 与名称的关系(家人/好友/同事…),仅作展示,可为空。 */
  calendar: CalendarKind
  /** 1-12。 */
  month: number
  /** 1-30(农历) / 1-31(公历)。 */
  day: number
  /** 农历闰月标记;仅 calendar === 'lunar' 时有意义。 */
  isLeapMonth: boolean
  /** 是否开启年度提醒。 */
  remindEnabled: boolean
  /** 提醒时刻:0-23。 */
  remindHour: number
  /** 提醒时刻:0-59。 */
  remindMinute: number
  /** 提前几天提醒(0 = 当天)。 */
  remindDaysBefore: number
  note: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export function createBirthday(patch: Partial<Birthday> = {}): Birthday {
  const at = nowIso()
  return {
    id: uid(),
    name: '',
    relation: '',
    kind: 'birthday',
    avatar: 'a1',
    calendar: 'solar',
    month: 1,
    day: 1,
    isLeapMonth: false,
    remindEnabled: true,
    remindHour: 9,
    remindMinute: 0,
    remindDaysBefore: 0,
    note: '',
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    ...patch,
  }
}

export function touchBirthday(b: Birthday, patch: Partial<Birthday>): Birthday {
  return { ...b, ...patch, updatedAt: nowIso() }
}

export interface SyncConfig {
  enabled: boolean
  endpoint: string
  token: string
  autoSync: boolean
  intervalSec: number
}
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

export interface SyncState {
  status: SyncStatus
  lastPushAt: string | null
  lastPullAt: string | null
  pending: number
  lastError: string | null
}

export const PRIORITY_ORDER: Record<Priority, number> = {
  focus: 0,
  normal: 1,
  later: 2,
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function createTask(
  listId: string,
  title: string,
  patch: Partial<Task> = {},
): Task {
  const at = nowIso()
  return {
    id: uid(),
    parentId: null,
    listId,
    title,
    notes: '',
    meta: '',
    priority: 'normal',
    isImportant: false,
    isPinned: false,
    done: false,
    dueDate: null,
    remindAt: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    ...patch,
  }
}

export function touch(task: Task, patch: Partial<Task>): Task {
  return { ...task, ...patch, updatedAt: nowIso() }
}
