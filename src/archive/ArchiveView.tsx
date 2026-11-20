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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { currentMonitor } from '@tauri-apps/api/window'
import { RotateCcw, Trash2 } from 'lucide-react'
import {
  clDeleteArchived,
  clListArchived,
  clReadPreview,
  clUnarchiveCard,
  type ClotheslineCard,
} from '../clothesline/bridge'
import { getNotes, removeNote, unarchiveNote, type Note } from '../notes/store'
import { invoke } from '@tauri-apps/api/core'
import { t, useI18n, type LocaleKey } from '../i18n'
import './archive.css'

type EntryKind = 'note' | 'text' | 'timer' | 'shot'

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

const KIND_META: Record<EntryKind, { label: LocaleKey; color: string }> = {
  note: { label: 'archive.kind.note', color: '#e8a912' },
  text: { label: 'archive.kind.text', color: '#3d7be8' },
  timer: { label: 'archive.kind.timer', color: '#e5484d' },
  shot: { label: 'archive.kind.shot', color: '#8a63d2' },
}

const FILTERS: { key: 'all' | EntryKind; label: LocaleKey }[] = [
  { key: 'all', label: 'archive.filter.all' },
  { key: 'note', label: 'archive.kind.note' },
  { key: 'text', label: 'archive.kind.text' },
  { key: 'timer', label: 'archive.kind.timer' },
  { key: 'shot', label: 'archive.kind.shot' },
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
  return (first ?? '').trim().slice(0, 30) || t('archive.kind.note')
}

function timerSummary(card: ClotheslineCard): string {
  const ms = card.timer_total_ms ?? card.elapsed_before_pause_ms ?? 0
  const mins = Math.max(1, Math.round(ms / 60000))
  const dir = card.timer_direction === 'up' ? t('archive.dirUp') : t('archive.dirDown')
  return t('archive.timerSummary', { n: mins, dir })
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const pad = (v: number) => String(v).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return t('archive.timeToday', { hm })
  if (days === 1) return t('archive.timeYesterday', { hm })
  if (days < 7) return t('archive.timeDaysAgo', { n: days })
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ORIGIN_LABEL: Record<ArchiveEntry['origin'], LocaleKey> = {
  rope: 'archive.origin.rope',
  desktop: 'archive.origin.desktop',
  both: 'archive.origin.both',
}

export default function ArchiveView({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [cards, setCards] = useState<ClotheslineCard[]>([])
  const [notesTick, setNotesTick] = useState(0)
  const [filter, setFilter] = useState<'all' | EntryKind>('all')
  const [loading, setLoading] = useState(true)
  /** 展开详情的条目（单开手风琴）：便利签/随手记点击可看完整内容。 */
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const { t, locale } = useI18n()

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

  /** 合并：绳上便利签卡与桌面便签按 note_id 合成一条；其余各算一条。
   *  ★2026-11-19 只纳入四种可归档类型（贴图/图片/待办/剪贴板未开放归档，
   *  若历史数据里出现则跳过，避免 KIND_META 取值越界）。 */
  const entries = useMemo<ArchiveEntry[]>(() => {
    const out: ArchiveEntry[] = []
    const consumedNotes = new Set<string>()
    for (const card of cards) {
      if (card.kind !== 'note' && card.kind !== 'text' && card.kind !== 'timer' && card.kind !== 'shot') {
        continue
      }
      if (card.kind === 'note' && card.note_id) {
        const note = archivedNotes.find((n) => n.id === card.note_id)
        if (note) {
          consumedNotes.add(note.id)
          out.push({
            key: `both-${card.id}`,
            kind: 'note',
            title: noteTitle(note) || card.title || t('archive.kind.note'),
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
          title: card.title || t('archive.kind.note'),
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
        title: card.title || t(KIND_META[card.kind].label),
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
  }, [cards, archivedNotes, locale])

  const counts = useMemo(() => {
    const c: Record<'all' | EntryKind, number> = { all: entries.length, note: 0, text: 0, timer: 0, shot: 0 }
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

  /** 截图缩略图缓存：entries 变化后批量拉取（跳过已请求的 id，失败不重试）。
   *  ★2026-11-19 终版：与晾衣绳预览同款 clReadPreview（base64 data URL），
   *  废弃 TEMP 中转 + asset 协议链路（破图根源）。 */
  const shotThumbsRef = useRef<Set<string>>(new Set())
  const [shotThumbs, setShotThumbs] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const ids = entries
      .filter((e) => e.kind === 'shot' && e.cardId && !shotThumbsRef.current.has(e.cardId))
      .map((e) => e.cardId!)
    ;(async () => {
      for (const id of ids) {
        shotThumbsRef.current.add(id)
        const url = await clReadPreview(id).catch(() => null)
        if (cancelled) return
        if (url) setShotThumbs((m) => ({ ...m, [id]: url }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entries])

  /** ★2026-11-19 终版 v4：截图预览 = **整屏透明覆盖窗**（与晾衣绳预览同构）。
   *  六轮实测定论：主窗是小条带窗口，setFullscreen（tao 改窗口样式=系统框闪现）
   *  与 setSize/setPosition 几何改造（跳变=闪屏/黑幕）都无法做到「窗口完全静止」；
   *  晾衣绳预览完美是因为绳窗本身恒为整屏、预览零几何变化。所以预览必须在
   *  **本来就在整屏的表面**上进行：Rust 按绳窗同款参数建/复用透明覆盖窗
   *  （ShotPreviewWindow），主窗彻底零改动 ⇒ 必然完全静止。
   *  覆盖窗常驻复用（hide/show），cardId 经 Rust 状态 + 事件传递；
   *  创建/显示失败时回退为主窗内覆盖层（previewCardId，限主窗范围）。 */
  const [previewCardId, setPreviewCardId] = useState<string | null>(null)
  /** Esc 生效门闩：覆盖窗无焦点，键盘事件仍落在主窗，这里统一监听。 */
  const [previewOpen, setPreviewOpen] = useState(false)
  const openShotPreview = useCallback(async (cardId: string) => {
    setPreviewOpen(true)
    try {
      const mon = await currentMonitor().catch(() => null)
      if (!mon) throw new Error('no monitor')
      await invoke('archive_preview_show', {
        cardId,
        x: mon.position.x,
        y: mon.position.y,
        w: mon.size.width,
        h: mon.size.height,
      })
    } catch {
      // 覆盖窗不可用 → 回退主窗内覆盖层（限主窗范围，至少能看图）
      setPreviewCardId(cardId)
    }
  }, [])
  const closeShotPreview = useCallback(async () => {
    setPreviewOpen(false)
    setPreviewCardId(null)
    await invoke('archive_preview_hide').catch(() => undefined)
  }, [])
  // Esc 关闭（焦点在主窗；覆盖窗路径同样生效）
  useEffect(() => {
    if (!previewOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') void closeShotPreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewOpen, closeShotPreview])
  // 组件卸载兜底：隐藏覆盖窗 + 撤历史补偿残留（后者为旧版本升级清理，均可 no-op）
  useEffect(
    () => () => {
      document.body.classList.remove('apv-active')
      document.documentElement.style.removeProperty('--apv-tx')
      document.documentElement.style.removeProperty('--apv-ty')
      void invoke('archive_preview_hide').catch(() => undefined)
    },
    [],
  )
  // 覆盖层打开但缩略图缓存未就绪 → 补拉一次 data URL
  useEffect(() => {
    if (previewCardId === null || shotThumbs[previewCardId]) return
    void clReadPreview(previewCardId)
      .then((url) => {
        if (url) setShotThumbs((m) => ({ ...m, [previewCardId]: url }))
      })
      .catch(() => undefined)
  }, [previewCardId, shotThumbs])

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
            {t(f.label)}
            {f.key !== 'all' ? <em>{counts[f.key]}</em> : null}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="arch-empty">
          {loading
            ? t('archive.loading')
            : t('archive.empty')}
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
                      {t(KIND_META[e.kind].label)}
                    </span>
                    <span className="arch-time">
                      {timeLabel(e.archivedAt)} · {t(ORIGIN_LABEL[e.origin])}
                    </span>
                  </div>
                  <div className="arch-item-title" title={e.title}>
                    {e.title}
                  </div>
                  {e.kind === 'shot' && e.cardId ? (
                    // 截图：缩略图 + 点击打开独立全屏预览窗口。
                    <div
                      className="arch-shot-thumb"
                      onClick={() => void openShotPreview(e.cardId!)}
                      title={t('archive.openFullTip')}
                    >
                      {shotThumbs[e.cardId] ? (
                        <img src={shotThumbs[e.cardId]} alt={t('archive.thumbAlt')} draggable={false} />
                      ) : (
                        <span className="arch-shot-fallback">{t('archive.shotFallback')}</span>
                      )}
                      <span className="arch-shot-open">{t('archive.fullPreview')}</span>
                    </div>
                  ) : null}
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
                          {e.summary || t('clothesline.task.empty')}
                        </div>
                      )}
                      <div className="arch-item-detail-tip">{t('archive.collapseTip')}</div>
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
                    {t('archive.restore')}
                  </button>
                  <button
                    type="button"
                    className="arch-act arch-act-danger"
                    onClick={() => handleDelete(e)}
                  >
                    <Trash2 size={11} />
                    {t('archive.delete')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="arch-foot">{t('archive.footer')}</div>

      {/* ★2026-11-19 截图全屏预览覆盖层：主窗临时 setFullscreen(true) 后铺满整个桌面，
          关闭（✕ / Esc / 点空白）自动还原窗口。图片 = 与晾衣绳同款 data URL。
          ★必须 createPortal 到 document.body：归档页位于 .dock-layer（App.css 带
          will-change:transform），它会成为 fixed 后代的包含块——不 portal 的话
          覆盖层永远被困在 384px 宽的 dock 条里，这就是上一版「只在桌面左侧
          显示一小条」的根因。body 无 transform，portal 后 fixed=真实视口。 */}
      {previewCardId
        ? createPortal(
            <div className="apv-root" onClick={() => void closeShotPreview()}>
              {shotThumbs[previewCardId] ? (
                <img
                  className="apv-img"
                  src={shotThumbs[previewCardId]}
                  alt={t('shot.previewAlt')}
                  draggable={false}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="apv-tip">{t('common.loading')}</div>
              )}
              {/* 关闭钮在预览图正下方（2026-11-19 用户定稿），列布局随 apv-root 生效 */}
              <button
                type="button"
                className="apv-close"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeShotPreview()
                }}
                aria-label={t('clothesline.preview.closeAria')}
              >
                ✕
              </button>
              <div className="apv-hint">{t('archive.escHint')}</div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
