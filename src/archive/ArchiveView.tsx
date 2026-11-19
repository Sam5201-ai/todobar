/**
 * 归档页（2026-11-18）：便利签 / 随手记 / 番茄计时的统一归档界面。
 *
 * UI 定稿 = 用户选定的「方案三 · 档案时间线」：左侧 2px 竖轴 + 类型色垂挂节点，
 * 按归档时间倒序；头部总数胶囊 + 类型筛选胶囊行；条目 hover 浮出「恢复 / 删除」。
 *
 * 数据源：
 * - 绳卡：Rust clothesline_list_archived（deleted_at 无值 && archived_at 有值，倒序）
 * - 桌面便签：notes/store localStorage 中 archivedAt 有值的签
 * 便利签条目按 note_id 合并「桌面便签 + 绳上卡」为一条（单一写方红线：恢复/删除
 * 的便签侧写操作 archiveNote/unarchiveNote/removeNote 只能经主窗 → 本页就是主窗页面）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { RotateCcw, Trash2 } from 'lucide-react'
import {
  clDeleteArchived,
  clListArchived,
  clUnarchiveCard,
  type ClotheslineCard,
} from '../clothesline/bridge'
import { getNotes, removeNote, unarchiveNote, type Note } from '../notes/store'
import { invoke } from '@tauri-apps/api/core'
import './archive.css'

type EntryKind = 'note' | 'text' | 'timer'

type ArchiveEntry = {
  key: string
  kind: EntryKind
  title: string
  summary: string
  /** 便利签结构化事项（仅 kind==='note' 且桌面便签数据存在时）：
   *  详情按事项逐行展示序号与勾选状态；绳卡快照无 items，回退纯文本。 */
  items?: { text: string; done: boolean }[]
  /** 归档时间（桌面便签与绳卡取较大者）。 */
  archivedAt: number
  /** 原位置：rope=原挂晾衣绳 / desktop=原在桌面 / both=一体归档（桌面+绳上都在）。 */
  origin: 'rope' | 'desktop' | 'both'
  cardId?: string
  noteId?: string
}

/** 便签结构化事项 → 归档页展示用的轻量快照。 */
function noteItems(n: Note): { text: string; done: boolean }[] {
  return (n.items ?? [])
    .filter((i) => typeof i.text === 'string' && i.text.trim().length > 0)
    .map((i) => ({ text: i.text, done: i.done }))
}

const KIND_META: Record<EntryKind, { label: string; color: string }> = {
  note: { label: '便利签', color: '#e8a912' },
  text: { label: '随手记', color: '#3d7be8' },
  timer: { label: '番茄计时', color: '#e5484d' },
}

const FILTERS: { key: 'all' | EntryKind; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '便利签' },
  { key: 'text', label: '随手记' },
  { key: 'timer', label: '番茄计时' },
]

function noteSummary(n: Note): string {
  const texts = (n.items ?? [])
    .map((i) => i.text)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
  return texts.join(' ')
}

/** 便利签没有标题字段：首条内容作标题，其余作摘要。 */
function noteTitle(n: Note): string {
  const first = (n.items ?? []).map((i) => i.text).find((t) => typeof t === 'string' && t.trim())
  return (first ?? '').trim().slice(0, 30) || '便利签'
}

function timerSummary(card: ClotheslineCard): string {
  const ms = card.timer_total_ms ?? card.elapsed_before_pause_ms ?? 0
  const mins = Math.max(1, Math.round(ms / 60000))
  const dir = card.timer_direction === 'up' ? '正计时' : '倒计时'
  return `已计时 ${mins} 分钟 · ${dir}`
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const pad = (v: number) => String(v).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return `今天 ${hm}`
  if (days === 1) return `昨天 ${hm}`
  if (days < 7) return `${days} 天前`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ORIGIN_LABEL: Record<ArchiveEntry['origin'], string> = {
  rope: '晾衣绳',
  desktop: '桌面',
  both: '桌面+晾衣绳',
}

export default function ArchiveView({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [cards, setCards] = useState<ClotheslineCard[]>([])
  const [notesTick, setNotesTick] = useState(0)
  const [filter, setFilter] = useState<'all' | EntryKind>('all')
  const [loading, setLoading] = useState(true)
  /** 展开详情的条目（单开手风琴）：便利签/随手记点击可看完整内容。 */
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  /** 便签侧数据来自 localStorage；events/storage 双通道刷新（与绳窗同策略）。 */
  useEffect(() => {
    let cancelled = false
    let un1: (() => void) | undefined
    let un2: (() => void) | undefined
    void listen<unknown>('clothesline-cards-changed', () => {
      if (!cancelled) void reload()
    })
      .then((fn) => {
        if (cancelled) fn()
        else un1 = fn
      })
      .catch(() => undefined)
    void listen<unknown>('notes-changed', () => {
      if (!cancelled) setNotesTick((n) => n + 1)
    })
      .then((fn) => {
        if (cancelled) fn()
        else un2 = fn
      })
      .catch(() => undefined)
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.includes('ticktask.notes')) setNotesTick((n) => n + 1)
    }
    window.addEventListener('storage', onStorage)
    return () => {
      cancelled = true
      un1?.()
      un2?.()
      window.removeEventListener('storage', onStorage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setCards(await clListArchived())
    } catch {
      setCards([])
    } finally {
      setLoading(false)
    }
  }, [])

  // 挂载即加载（PageShell 关闭即卸载，每次打开都是新快照）。
  useEffect(() => {
    void reload()
  }, [reload])

  // 便签列表每次 notesTick 重读（notes-changed/storage 触发）。
  const archivedNotes = useMemo(() => {
    void notesTick
    return getNotes().filter((n) => n.archivedAt != null)
  }, [notesTick])

  /** 合并：绳上便利签卡与桌面便签按 note_id 合成一条；其余各算一条。 */
  const entries = useMemo<ArchiveEntry[]>(() => {
    const out: ArchiveEntry[] = []
    const consumedNotes = new Set<string>()
    for (const card of cards) {
      if (card.kind !== 'note' && card.kind !== 'text' && card.kind !== 'timer') continue
      if (card.kind === 'note' && card.note_id) {
        const note = archivedNotes.find((n) => n.id === card.note_id)
        if (note) {
          consumedNotes.add(note.id)
          out.push({
            key: `both-${card.id}`,
            kind: 'note',
            title: noteTitle(note) || card.title || '便利签',
            summary: noteSummary(note) || card.text,
            items: noteItems(note),
            archivedAt: Math.max(note.archivedAt ?? 0, card.archived_at ?? 0),
            origin: 'both',
            cardId: card.id,
            noteId: note.id,
          })
          continue
        }
        out.push({
          key: `card-${card.id}`,
          kind: 'note',
          title: card.title || '便利签',
          summary: card.text,
          archivedAt: card.archived_at ?? card.updated_at,
          origin: 'rope',
          cardId: card.id,
        })
        continue
      }
      out.push({
        key: `card-${card.id}`,
        kind: card.kind,
        title: card.title || KIND_META[card.kind].label,
        summary: card.kind === 'timer' ? timerSummary(card) : card.text,
        archivedAt: card.archived_at ?? card.updated_at,
        origin: 'rope',
        cardId: card.id,
      })
    }
    for (const note of archivedNotes) {
      if (consumedNotes.has(note.id)) continue
      out.push({
        key: `note-${note.id}`,
        kind: 'note',
        title: noteTitle(note),
        summary: noteSummary(note),
        items: noteItems(note),
        archivedAt: note.archivedAt ?? note.updatedAt,
        origin: 'desktop',
        noteId: note.id,
      })
    }
    out.sort((a, b) => b.archivedAt - a.archivedAt)
    return out
  }, [cards, archivedNotes])

  const counts = useMemo(() => {
    const c: Record<'all' | EntryKind, number> = { all: entries.length, note: 0, text: 0, timer: 0 }
    for (const e of entries) c[e.kind] += 1
    return c
  }, [entries])

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.kind === filter)),
    [entries, filter],
  )

  // 总数上报给 PageShell 顶栏（actions 插槽渲染「N 条」胶囊）。
  useEffect(() => {
    onCountChange?.(counts.all)
  }, [counts.all, onCountChange])

  /** 恢复 = 回到归档前位置：便利签桌面+绳上一体还原；随手记/番茄回绳上原 order 位。
   *  桌面便签（非折叠态归档的）恢复后需重新开窗——unarchiveNote 只改数据不开窗。 */
  const handleRestore = useCallback((e: ArchiveEntry) => {
    if (e.kind === 'note') {
      if (e.noteId) {
        unarchiveNote(e.noteId)
        // 原在桌面（非折叠）的便签：恢复即重开桌面窗口（与启动恢复同一 Rust 命令）。
        const note = getNotes().find((n) => n.id === e.noteId)
        if (note && !note.collapsed) {
          void invoke('notes_open_window', { noteId: e.noteId }).catch(() => undefined)
        }
      }
      if (e.cardId) void clUnarchiveCard(e.cardId).catch(() => undefined)
    } else if (e.cardId) {
      void clUnarchiveCard(e.cardId).catch(() => undefined)
    }
  }, [])

  /** 删除 = 永久删除（按钮本身即确认，无二次弹窗）：便签 removeNote + 绳卡物理清除。 */
  const handleDelete = useCallback((e: ArchiveEntry) => {
    if (e.kind === 'note') {
      if (e.noteId) removeNote(e.noteId)
      if (e.cardId) void clDeleteArchived(e.cardId).catch(() => undefined)
    } else if (e.cardId) {
      void clDeleteArchived(e.cardId).catch(() => undefined)
    }
  }, [])

  // 筛选或数据变化时收起已展开的详情，避免展开态错位。
  useEffect(() => {
    setExpandedKey(null)
  }, [filter, entries])

  return (
    <div className="arch-root">
      <div className="arch-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`arch-chip ${filter === f.key ? 'is-active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key !== 'all' ? <em>{counts[f.key]}</em> : null}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="arch-empty">
          {loading
            ? '读取中…'
            : '暂无归档内容 · 关闭便利签/随手记/番茄卡时选择归档即可保留在这里'}
        </div>
      ) : (
        <div className="arch-timeline">
          {visible.map((e) => {
            // 便利签/随手记：点击条目展开完整内容（summary 即全文，展开换多行呈现）。
            const canExpand = e.kind === 'note' || e.kind === 'text'
            const expanded = expandedKey === e.key
            return (
              <div key={e.key} className="arch-item">
                <span
                  className="arch-node"
                  style={{ background: KIND_META[e.kind].color }}
                  aria-hidden
                />
                <div
                  className={`arch-item-body ${canExpand ? 'is-clickable' : ''}`}
                  onClick={
                    canExpand
                      ? () => setExpandedKey(expanded ? null : e.key)
                      : undefined
                  }
                >
                  <div className="arch-item-meta">
                    <span className="arch-badge" style={{ background: KIND_META[e.kind].color }}>
                      {KIND_META[e.kind].label}
                    </span>
                    <span className="arch-time">
                      {timeLabel(e.archivedAt)} · {ORIGIN_LABEL[e.origin]}
                    </span>
                  </div>
                  <div className="arch-item-title" title={e.title}>
                    {e.title}
                  </div>
                  {expanded && canExpand ? (
                    <>
                      {e.kind === 'note' && e.items && e.items.length > 0 ? (
                        // 便利签：按事项逐行展示，带序号与勾选状态（与便签视觉一致）。
                        <div
                          className="arch-item-detail"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setExpandedKey(null)
                          }}
                        >
                          {e.items.map((it, idx) => (
                            <div
                              key={idx}
                              className={`arch-line ${it.done ? 'is-done' : ''}`}
                            >
                              <span className="arch-line-idx">{idx + 1}.</span>
                              <span className="arch-line-check" aria-hidden>
                                {it.done ? '☑' : '☐'}
                              </span>
                              <span className="arch-line-text">{it.text}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div
                          className="arch-item-detail"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setExpandedKey(null)
                          }}
                        >
                          {e.summary || '（无内容）'}
                        </div>
                      )}
                      <div className="arch-item-detail-tip">点击详情框或条目收起</div>
                    </>
                  ) : e.summary ? (
                    <div className="arch-item-summary" title={e.summary}>
                      {e.summary}
                    </div>
                  ) : null}
                </div>
                <div className="arch-item-actions">
                  <button type="button" className="arch-act" onClick={() => handleRestore(e)}>
                    <RotateCcw size={11} />
                    恢复
                  </button>
                  <button
                    type="button"
                    className="arch-act arch-act-danger"
                    onClick={() => handleDelete(e)}
                  >
                    <Trash2 size={11} />
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="arch-foot">按类型筛选 · 时间线按归档时间倒序 · 恢复回原位</div>
    </div>
  )
}
