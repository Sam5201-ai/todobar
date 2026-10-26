/**
 * 便利签数据层。
 *
 * 双持久化:localStorage 即时写(主数据源)+ 磁盘 ~/.ticktask/prefs.json 异步镜像,
 * 重装应用或清理 WebView 缓存后自动回灌 —— 与录音 / 计薪 / 贴图 / 待办设置同机制。
 *
 * ⚠️ useSyncExternalStore 快照铁律(0.4.35 事故):
 * getSnapshot 绝不可每次返回新引用(JSON.parse / filter / map 新建对象),否则
 * dev 环境不报错而生产环境直接白屏。故此处维护**模块级 cacheNotes 引用**,
 * 仅当数据真的变化时才重建数组,getNotes() 恒返回同一引用。
 */

import { useSyncExternalStore } from 'react'

import { loadDiskPref, saveDiskPref } from '../prefs'

const STORAGE_KEY = 'ticktask.notes.v1'
const DISK_KEY = 'notes'
// 墓碑:被彻底删除的便利签 id → 删除时间戳。
// ⚠️ 为什么必须要有:WebView2 的 localStorage 落盘是异步的,进程被强杀/崩溃时
// 未 flush,重启会读到旧快照 —— 没有墓碑的话,已删除的签会从旧快照里"复活"。
// 磁盘镜像(Rust 写 prefs.json)是同步持久的,墓碑双写两侧,启动时取并集过滤。
const TOMBSTONE_LOCAL_KEY = 'ticktask.notes.tombstones.v1'
const DISK_TOMBSTONE_KEY = 'notes_tombstones'
/** 墓碑保留时长:超过后若两侧数据里都没这个 id,即可安全清掉。 */
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000

/** 账面上限:累计存在的便利签总数(含已收起未删除)。防止数据无限膨胀。 */
export const MAX_NOTES = 50
/** 同时显示上限:桌面上同时存在的窗口数。 */
export const MAX_VISIBLE_NOTES = 12

/** 背景透明度可调范围。下限 0.35 保证任何色板下文字仍可读。 */
export const MIN_BG_ALPHA = 0.35

export type NoteItem = {
  id: string
  text: string
  /** 勾选划线(仅便签内视觉完成,与待办数据源隔离)。 */
  done: boolean
  createdAt: number
  /** 是否已转待办(视觉标记,防重复转)。 */
  converted: boolean
}

export type Note = {
  id: string
  items: NoteItem[]
  /** 预设色板 key,不给任意取色器 —— 保证文字对比度始终达标。 */
  colorKey: string
  /** 背景不透明度(仅作用于背景,文字恒全不透明)。 */
  bgAlpha: number
  /** 「始终置顶」(用户口中的"钉住")。 */
  pinned: boolean
  /** 位置尺寸,存 Windows 全局虚拟桌面坐标,支持多显示器原位置恢复。 */
  x: number
  y: number
  w: number
  h: number
  createdAt: number
  updatedAt: number
  /** 收起态:数据保留、窗口销毁,可从管理器召回。 */
  collapsed: boolean
}

/**
 * 预设色板。bg 为 "R, G, B" 三元组(便于拼 rgba),fg 为该背景上的文字色。
 * 每档都保证低透明度下文字仍有足够对比度。
 */
export const NOTE_COLORS: { key: string; label: string; bg: string; fg: string }[] = [
  { key: 'yellow', label: '柠檬黄', bg: '253, 216, 110', fg: '#4a3710' },
  { key: 'pink', label: '樱花粉', bg: '252, 186, 200', fg: '#5c2131' },
  { key: 'blue', label: '晴空蓝', bg: '168, 214, 250', fg: '#123a55' },
  { key: 'green', label: '薄荷绿', bg: '175, 232, 199', fg: '#12462f' },
  { key: 'purple', label: '薰衣草', bg: '212, 190, 245', fg: '#3a2352' },
  { key: 'gray', label: '石墨灰', bg: '206, 212, 218', fg: '#2c3033' },
]

export function noteColorOf(key: string) {
  return NOTE_COLORS.find((c) => c.key === key) ?? NOTE_COLORS[0]
}

// ————————————————————————— 模块级缓存与订阅 —————————————————————————

let cacheNotes: Note[] = []
let loaded = false
let hydrated = false
const listeners = new Set<() => void>()

// ——— 跨窗口同步 ———
// 每个窗口(主窗 + N 个便利签窗)都是独立 JS 上下文,模块级 cache 互不相通。
// 写入方 commit() 后经 Tauri emit 广播;其它窗口收到后从 localStorage 重读。
// lastLocalJson 是原始串指纹:① 防自回声(自己 emit 回来时内容相同则跳过);
// ② 保证 getNotes() 恒返回同一引用(0.4.35 useSyncExternalStore 白屏铁律)。
const NOTES_CHANGED_EVENT = 'notes-changed'
let lastLocalJson = '[]'
let tombstones: Record<string, number> = {}

const newId = () =>
  `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const clampNum = (v: unknown, min: number, max: number, dft: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dft

/** 归一化,防御性处理损坏 / 旧版本数据,保证 Note 结构完整。 */
function normalizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return null

  const items: NoteItem[] = Array.isArray(v.items)
    ? v.items
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .map((it) => ({
          id: typeof it.id === 'string' && it.id ? it.id : newId(),
          text: typeof it.text === 'string' ? it.text : '',
          done: it.done === true,
          createdAt: typeof it.createdAt === 'number' ? it.createdAt : Date.now(),
          converted: it.converted === true,
        }))
        .filter((it) => it.text.length > 0)
    : []

  return {
    id: v.id,
    items,
    colorKey: NOTE_COLORS.some((c) => c.key === v.colorKey)
      ? (v.colorKey as string)
      : NOTE_COLORS[0].key,
    bgAlpha: clampNum(v.bgAlpha, MIN_BG_ALPHA, 1, 0.92),
    pinned: v.pinned !== false,
    x: clampNum(v.x, -32768, 32768, 120),
    y: clampNum(v.y, -32768, 32768, 120),
    w: clampNum(v.w, 200, 640, 240),
    h: clampNum(v.h, 160, 900, 220),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
    collapsed: v.collapsed === true,
  }
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  bindCrossWindowSync()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    lastLocalJson = raw ?? '[]'
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      cacheNotes = Array.isArray(parsed)
        ? parsed.map(normalizeNote).filter((n): n is Note => n !== null)
        : []
    }
    const tr = window.localStorage.getItem(TOMBSTONE_LOCAL_KEY)
    if (tr) {
      const parsed = JSON.parse(tr) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        tombstones = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => [k, v as number]),
        )
      }
    }
  } catch {
    cacheNotes = []
    lastLocalJson = '[]'
  }
}

function persistTombstonesLocal() {
  try {
    window.localStorage.setItem(TOMBSTONE_LOCAL_KEY, JSON.stringify(tombstones))
  } catch {
    /* 配额或隐私模式,忽略 */
  }
}

/**
 * 从 localStorage 重读,内容指纹有变才重建 cacheNotes(引用稳定铁律)。
 * 返回是否真的发生了变化。getNotes() 每次调用都会先跑一遍 —— 字符串比对
 * 开销可忽略,却能根治「主窗口启动时缓存了空数组,便利签窗口写入后看不到」。
 */
function refreshFromLocal(): boolean {
  ensureLoaded()
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return false
  }
  const cur = raw ?? '[]'
  if (cur === lastLocalJson) return false
  let next: Note[] = []
  try {
    const parsed = JSON.parse(cur) as unknown
    next = Array.isArray(parsed)
      ? parsed.map(normalizeNote).filter((n): n is Note => n !== null)
      : []
  } catch {
    return false
  }
  cacheNotes = next
  lastLocalJson = cur
  return true
}

async function broadcastNotesChanged(): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(NOTES_CHANGED_EVENT, {})
  } catch {
    /* 非 Tauri 环境(vite 纯浏览器调试)忽略 */
  }
}

/** 只绑定一次:Tauri 事件 + 原生 storage 事件双通道(dev 浏览器环境走 storage)。 */
function bindCrossWindowSync() {
  const onExternal = () => {
    if (refreshFromLocal()) listeners.forEach((l) => l())
    // localStorage 读不到(理论上同源共享不会发生)时,尝试磁盘回灌兜底
    else if (cacheNotes.length === 0) void hydrateNotes()
  }
  try {
    window.addEventListener('storage', onExternal)
  } catch {
    /* ignore */
  }
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen(NOTES_CHANGED_EVENT, onExternal).catch(() => {}))
    .catch(() => {
      /* 非 Tauri 环境 */
    })
}

/**
 * 启动回灌 + 双侧对账。
 *
 * 不再"localStorage 非空就跳过磁盘"——localStorage 可能是强杀/崩溃前未 flush 的旧快照。
 * 规则:
 * 1. 笔记按 id 合并 localStorage + 磁盘,updatedAt 新者胜;仅存在于一侧的保留
 *    (可能是新创建且对端写丢失,宁可多留也不丢用户内容);
 * 2. 墓碑取并集,凡在墓碑里的 id 一律过滤(删除是不可逆的最高优先级);
 * 3. 旧版"收起态"(collapsed)在删除模型下不存在,一并清掉;
 * 4. 对账结果回写双侧,保证下一轮一致。
 */
export async function hydrateNotes(): Promise<void> {
  if (hydrated) return
  hydrated = true
  ensureLoaded()

  let diskNotes: Note[] = []
  let diskTs: Record<string, number> = {}
  try {
    const disk = await loadDiskPref<unknown>(DISK_KEY)
    if (Array.isArray(disk)) {
      diskNotes = disk.map(normalizeNote).filter((n): n is Note => n !== null)
    }
    const dts = await loadDiskPref<unknown>(DISK_TOMBSTONE_KEY)
    if (dts && typeof dts === 'object' && !Array.isArray(dts)) {
      diskTs = Object.fromEntries(
        Object.entries(dts as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => [k, v as number]),
      )
    }
  } catch {
    /* 磁盘读不到则按 localStorage 单侧继续 */
  }

  // ① 笔记合并:id 相同取 updatedAt 新者;单侧独有的保留
  const byId = new Map<string, Note>()
  for (const n of [...cacheNotes, ...diskNotes]) {
    const cur = byId.get(n.id)
    if (!cur || n.updatedAt > cur.updatedAt) byId.set(n.id, n)
  }

  // ② 墓碑并集(取更晚的删除时间)
  const ts: Record<string, number> = { ...tombstones }
  for (const [k, v] of Object.entries(diskTs)) {
    ts[k] = Math.max(ts[k] ?? 0, v)
  }

  // ③ 过滤:已删除 + 旧版收起态
  const merged = [...byId.values()].filter((n) => !(n.id in ts) && !n.collapsed)

  // ④ 清理过期墓碑(超 TTL 且两侧数据里都不存在了)
  const now = Date.now()
  for (const [k, v] of Object.entries(ts)) {
    if (now - v > TOMBSTONE_TTL && !byId.has(k)) delete ts[k]
  }

  const notesChanged = JSON.stringify(merged) !== JSON.stringify(cacheNotes)
  const tsChanged = JSON.stringify(ts) !== JSON.stringify(tombstones)
  cacheNotes = merged
  tombstones = ts
  if (notesChanged || tsChanged) {
    persistLocal()
    persistTombstonesLocal()
    void saveDiskPref(DISK_KEY, merged)
    void saveDiskPref(DISK_TOMBSTONE_KEY, ts)
  }
  listeners.forEach((l) => l())
}

function persistLocal() {
  const json = JSON.stringify(cacheNotes)
  lastLocalJson = json
  try {
    window.localStorage.setItem(STORAGE_KEY, json)
  } catch {
    /* 配额或隐私模式,忽略 */
  }
}

/** 统一提交入口:更新缓存引用 → 落盘 → 广播其它窗口 → 通知本窗口订阅者。 */
function commit(next: Note[]) {
  cacheNotes = next
  persistLocal()
  void saveDiskPref(DISK_KEY, next)
  void broadcastNotesChanged()
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getNotes(): Note[] {
  // 先吸收其它窗口的写入(指纹无变化时零开销、引用不变)
  refreshFromLocal()
  return cacheNotes
}

/** 订阅全部便利签。快照引用稳定,满足 useSyncExternalStore 要求。 */
export function useNotes(): Note[] {
  return useSyncExternalStore(subscribe, getNotes, getNotes)
}

// ————————————————————————— 查询 —————————————————————————

export function getNoteSync(id: string): Note | null {
  return getNotes().find((n) => n.id === id) ?? null
}

/** 当前应处于显示态(未收起)的便利签。 */
export function visibleNotes(): Note[] {
  return getNotes().filter((n) => !n.collapsed)
}

/** 是否还能再显示一个窗口(受同时显示上限约束)。 */
export function canOpenAnother(): boolean {
  return visibleNotes().length < MAX_VISIBLE_NOTES
}

// ————————————————————————— 写入 —————————————————————————

/**
 * 新建便利签。返回 null 表示已达账面总数上限 —— 调用方必须据此提示用户,
 * 不可静默失败(否则用户以为"点了没反应")。
 */
export function createNote(patch: Partial<Note> = {}): Note | null {
  const all = getNotes()
  if (all.length >= MAX_NOTES) return null

  const now = Date.now()
  const note: Note = {
    id: newId(),
    items: [],
    colorKey: NOTE_COLORS[0].key,
    bgAlpha: 0.92,
    pinned: true, // 默认「始终置顶」(用户决策:默认钉住)
    x: 120,
    y: 120,
    w: 240,
    h: 220,
    createdAt: now,
    updatedAt: now,
    collapsed: false,
    ...patch,
  }
  commit([note, ...all])
  return note
}

export function updateNote(id: string, patch: Partial<Note>): void {
  const all = getNotes()
  const idx = all.findIndex((n) => n.id === id)
  if (idx < 0) return
  const next = all.slice()
  next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() }
  commit(next)
}

/**
 * 彻底删除(不可恢复)。调用方需做二步确认。
 *
 * ⚠️ 必须写墓碑:localStorage 可能未 flush 就被强杀,没有墓碑的话
 * 旧快照里的这条签会在重启后"复活"(实测踩过)。
 */
export function removeNote(id: string): void {
  tombstones[id] = Date.now()
  persistTombstonesLocal()
  void saveDiskPref(DISK_TOMBSTONE_KEY, tombstones)
  commit(getNotes().filter((n) => n.id !== id))
}

/** 收起:数据保留、窗口由 Rust 侧销毁,可从管理器召回。 */
export function collapseNote(id: string): void {
  updateNote(id, { collapsed: true })
}

export function restoreNote(id: string): void {
  updateNote(id, { collapsed: false })
}

export function setAllCollapsed(collapsed: boolean): void {
  commit(getNotes().map((n) => ({ ...n, collapsed, updatedAt: Date.now() })))
}

// ————————————————————————— 条目 —————————————————————————

export function addNoteItem(noteId: string, text: string): NoteItem | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const note = getNoteSync(noteId)
  if (!note) return null
  if (note.items.length >= 200) return null

  const item: NoteItem = {
    id: newId(),
    text: trimmed,
    done: false,
    createdAt: Date.now(),
    converted: false,
  }
  updateNote(noteId, { items: [...note.items, item] })
  return item
}

export function updateNoteItem(
  noteId: string,
  itemId: string,
  patch: Partial<Pick<NoteItem, 'text' | 'done' | 'converted'>>,
): void {
  const note = getNoteSync(noteId)
  if (!note) return
  updateNote(noteId, {
    items: note.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
  })
}

export function removeNoteItem(noteId: string, itemId: string): void {
  const note = getNoteSync(noteId)
  if (!note) return
  updateNote(noteId, { items: note.items.filter((it) => it.id !== itemId) })
}

export function toggleNoteItem(noteId: string, itemId: string): void {
  const note = getNoteSync(noteId)
  if (!note) return
  updateNote(noteId, {
    items: note.items.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it)),
  })
}

/** 清理已转待办的条目(用户确认后调用)。 */
export function clearConvertedItems(noteId: string): number {
  const note = getNoteSync(noteId)
  if (!note) return 0
  const rest = note.items.filter((it) => !it.converted)
  const removed = note.items.length - rest.length
  if (removed > 0) updateNote(noteId, { items: rest })
  return removed
}
