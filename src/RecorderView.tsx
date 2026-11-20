/**
 * 录音机页面:一键录音 + 录音记录管理。
 *
 * - 录音区:大圆按钮(点击开始/暂停/继续)、计时(暂停冻结)、rAF 声波动画(直读
 *   getRecorderLevel,不走 React 渲染)、完成/取消;
 * - 引擎是模块级单例:页面关闭/侧栏收起时录音不中断,重进页面恢复显示;
 * - 记录列表:日期分组(今天/昨天/具体日期)、搜索、行内重命名(同步改磁盘文件名,
 *   保持「文件名 = 标题」)、备注走底部弹窗(20 字上限)、双击或播放键调系统默认
 *   播放器、资源管理器定位、行内删除确认;
 * - 保存位置:底部弹窗查看/修改录音保存目录(系统文件夹选择框),修改后新录音
 *   存新目录,已有录音保留在原位置;
 * - 文件丢失:挂载及列表变化时经 recordings_check 批量校验,丢失的标记红条,
 *   可一键清理;
 * - 会员闸门:受限用户(未登录/试用过期)可进页、可回放与管理历史,仅禁止新增
 *   录音——点录音按钮时 toast memberOnly('录音'),入口不隐藏不置灰;
 * - 样式全部收在 rec-* 命名空间(RecorderView.css),不动其他页面。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './RecorderView.css'
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Mic,
  Pause,
  Pencil,
  Play,
  Search,
  Settings2,
  Square,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as pickDirectory } from '@tauri-apps/plugin-dialog'
import { useAccount } from './membership'
import { memberOnly, OPEN_LOGIN_GUIDE_EVENT } from './account'
import { loadDiskPref } from './prefs'
import { t, useI18n } from './i18n'
import {
  cancelRecording,
  getRecorderLevel,
  loadRecordings,
  loadRecordingsDir,
  parseDiskRecordings,
  parseDiskRecordingsDir,
  pauseRecording,
  resumeRecording,
  saveRecordings,
  saveRecordingsDir,
  sanitizeFileName,
  startRecording,
  stopRecording,
  useRecorderSnapshot,
  type RecordingMeta,
} from './recorder'

/** 声波条数量。 */
const WAVE_BARS = 28
/** 备注字数上限。 */
const NOTE_MAX = 20

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 时长:mm:ss(不足 1 小时)/ h:mm:ss。 */
function fmtDur(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 文件大小:KB / MB / GB(≥1024MB 进位 GB)。 */
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 时:分(本地时区)。 */
function fmtClock(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 本地日期键 YYYY-MM-DD(注意:必须本地取,不能 iso.slice)。 */
function localDayKey(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 分组标签:今天 / 昨天 / M月D日(跨年带年份)。 */
function dayLabelOf(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (isSameLocalDay(d, now)) return t('date.today')
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameLocalDay(d, yesterday)) return t('recorder.yesterday')
  return d.getFullYear() === now.getFullYear()
    ? t('recorder.monthDay', { m: d.getMonth() + 1, d: d.getDate() })
    : t('recorder.monthDayYear', { year: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
}

// ---------------------------------------------------------------------------
// 底部弹窗:向上展开 / 向下收起;父组件条件渲染,关闭即卸载
// ---------------------------------------------------------------------------

interface RecSheetProps {
  title: string
  /** 请求关闭(内部先播收起动画,动画结束后由父组件卸载)。 */
  onClose: () => void
  children: ReactNode
}

function RecSheet({ title, onClose, children }: RecSheetProps): ReactNode {
  /** enter=挂载待展开 / open=已展开 / closing=收起中。 */
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter')
  const closingRef = useRef(false)
  const { t } = useI18n()

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase('open'))
    return () => cancelAnimationFrame(raf)
  }, [])

  const close = () => {
    if (closingRef.current) return
    closingRef.current = true
    setPhase('closing')
    window.setTimeout(onClose, 250) // 等收起动画播完再卸载
  }

  return (
    <>
      <div className={`rec-mask is-${phase}`} onClick={close} aria-hidden="true" />
      <div className={`rec-panel is-${phase}`} role="dialog" aria-label={title}>
        <div className="rec-panel-bar">
          <span className="rec-panel-title">{title}</span>
          <button type="button" aria-label={t('common.close')} onClick={close}>
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

type ToastKind = 'ok' | 'err' | 'warn'
interface RecToast {
  kind: ToastKind
  text: string
}

export function RecorderView(): ReactNode {
  const snap = useRecorderSnapshot()
  const { fullAccess, account } = useAccount()
  const { t } = useI18n()

  const [list, setList] = useState<RecordingMeta[]>(() => loadRecordings())
  const [missing, setMissing] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<RecToast | null>(null)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 备注弹窗目标(关即卸载,见 RecSheet)。 */
  const [noteTarget, setNoteTarget] = useState<RecordingMeta | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // 保存位置:'' = 默认「文档\Tacco录音」
  const [recDir, setRecDir] = useState(() => loadRecordingsDir())
  const [defaultDir, setDefaultDir] = useState('')
  const [dirSheetOpen, setDirSheetOpen] = useState(false)

  const toastTimer = useRef<number | null>(null)
  const waveRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const active = snap.status === 'recording' || snap.status === 'paused'

  const showToast = (kind: ToastKind, text: string) => {
    setToast({ kind, text })
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  // ---- 挂载:磁盘 prefs 回灌(localStorage 被清时自愈)+ 批量校验文件存在 ----
  useEffect(() => {
    let alive = true
    const boot = async () => {
      let current = loadRecordings()
      if (current.length === 0) {
        const fromDisk = parseDiskRecordings(await loadDiskPref<unknown>('recordings'))
        if (alive && fromDisk.length > 0) {
          saveRecordings(fromDisk)
          current = fromDisk
        }
      }
      // 保存目录配置同样回灌(localStorage 被清时自愈)。
      if (loadRecordingsDir() === '') {
        const savedDir = parseDiskRecordingsDir(await loadDiskPref<unknown>('recordingsDir'))
        if (alive && savedDir) {
          saveRecordingsDir(savedDir)
          setRecDir(savedDir)
        }
      }
      if (!alive) return
      setList(current)
    }
    void boot()
    void invoke<string>('recordings_default_dir')
      .then((d) => {
        if (alive) setDefaultDir(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // ---- 列表变化:批量校验录音文件是否仍在磁盘上(每条按自己的 dir+file 查) ----
  useEffect(() => {
    if (list.length === 0) {
      if (missing.size > 0) setMissing(new Set())
      return
    }
    let alive = true
    const dirs = list.map((r) => r.dir)
    const files = list.map((r) => r.file)
    const ids = list.map((r) => r.id)
    invoke<boolean[]>('recordings_check', { dirs, files })
      .then((exists) => {
        if (!alive) return
        const gone = new Set<string>()
        exists.forEach((ok, i) => {
          if (!ok && ids[i]) gone.add(ids[i])
        })
        setMissing(gone)
      })
      .catch(() => {
        /* 校验失败不阻断列表展示 */
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  // ---- 引擎完成保存:刷新列表 + toast(页面关着时由引擎落盘,重进自动可见) ----
  useEffect(() => {
    const r = snap.lastResult
    if (!r) return
    setList(loadRecordings())
    const text = r.savedOk
      ? t('recorder.saved', { dur: fmtDur(r.durationMs) })
      : t('recorder.savedTail', { dur: fmtDur(r.durationMs) })
    showToast(r.savedOk ? 'ok' : 'warn', text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.lastResult])

  // ---- 即将到达 2 小时上限提醒 ----
  useEffect(() => {
    if (snap.limitWarned) showToast('warn', t('recorder.limitWarn'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.limitWarned])

  // ---- 声波动画:rAF 直改 DOM,不触发 React 渲染 ----
  useEffect(() => {
    if (snap.status !== 'recording') return
    let raf = 0
    const loop = () => {
      const bars = waveRef.current?.children
      if (bars) {
        const lv = getRecorderLevel()
        const t = Date.now()
        for (let i = 0; i < bars.length; i++) {
          const phase = Math.abs(Math.sin(t / (210 + (i % 6) * 55) + i * 0.72))
          const h = 3 + phase * (3 + lv * 24)
          ;(bars[i] as HTMLElement).style.height = `${h.toFixed(1)}px`
        }
      }
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [snap.status])

  // ---- 重命名输入框自动聚焦 ----
  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.select()
  }, [renamingId])

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------

  const handleStart = () => {
    if (snap.status !== 'idle') return
    // 会员闸门:受限用户可进页/回放/管理,仅禁止新增录音。
    if (!fullAccess) {
      if (!account) {
        window.dispatchEvent(new CustomEvent(OPEN_LOGIN_GUIDE_EVENT, { detail: t('feature.recorder') }))
      } else {
        showToast('err', memberOnly(t('feature.recorder')))
      }
      return
    }
    void startRecording()
  }

  const handleOrbClick = () => {
    if (snap.status === 'idle') handleStart()
    else if (snap.status === 'recording') pauseRecording()
    else if (snap.status === 'paused') resumeRecording()
  }

  const persist = (next: RecordingMeta[]) => {
    setList(next)
    saveRecordings(next)
  }

  // 后端有两类 Err:文件确实丢失(「录音文件不存在或已被移动」)与打开系统失败
  // (如「打开录音失败: os error」)。只有前者才标记丢失,否则会误报已存在的文件。
  const handleOpen = async (item: RecordingMeta) => {
    try {
      await invoke('recording_open', { dir: item.dir, file: item.file })
    } catch (e) {
      const msg = String(e ?? '')
      if (msg.includes(t('recorder.errMissingMarker'))) {
        setMissing((prev) => new Set(prev).add(item.id))
        showToast('err', t('recorder.fileMissing'))
      } else {
        showToast('err', msg || t('recorder.errOpen'))
      }
    }
  }

  const handleReveal = async (item: RecordingMeta) => {
    try {
      await invoke('recording_reveal', { dir: item.dir, file: item.file })
    } catch (e) {
      const msg = String(e ?? '')
      if (msg.includes(t('recorder.errMissingMarker'))) {
        setMissing((prev) => new Set(prev).add(item.id))
        showToast('err', t('recorder.fileMissing'))
      } else {
        showToast('err', msg || t('recorder.errReveal'))
      }
    }
  }

  const handleOpenFolder = () => {
    void invoke('recordings_open_folder', { dir: recDir }).catch(() =>
      showToast('err', t('recorder.errReveal')),
    )
  }

  /** 修改保存位置:系统文件夹选择框。修改后只影响新录音,已有录音原地保留。 */
  const pickSaveDir = async () => {
    try {
      const picked = await pickDirectory({
        directory: true,
        multiple: false,
        title: t('recorder.pickDirTitle'),
      })
      if (typeof picked === 'string' && picked) {
        saveRecordingsDir(picked)
        setRecDir(picked)
        setDirSheetOpen(false)
        showToast('ok', t('recorder.dirUpdated'))
      }
    } catch {
      showToast('err', t('recorder.errDirPicker'))
    }
  }

  const resetSaveDir = () => {
    saveRecordingsDir('')
    setRecDir('')
    setDirSheetOpen(false)
    showToast('ok', t('recorder.dirReset'))
  }

  const handleCleanupMissing = () => {
    const n = missing.size
    if (n === 0) return
    persist(list.filter((r) => !missing.has(r.id)))
    setMissing(new Set())
    setConfirmDeleteId(null)
    showToast('ok', t('recorder.cleaned', { n }))
  }

  const handleDelete = async (item: RecordingMeta) => {
    try {
      await invoke('recording_delete', { dir: item.dir, file: item.file })
    } catch {
      /* 文件已不在也照样清记录 */
    }
    persist(list.filter((r) => r.id !== item.id))
    setConfirmDeleteId(null)
    showToast('ok', t('recorder.deleted'))
  }

  /** 重命名:记录名 + 磁盘文件名一起改,保持「文件名 = 标题」;冲突自动加序号。 */
  const commitRename = async () => {
    const id = renamingId
    if (id === null) return
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title) return
    const target = list.find((r) => r.id === id)
    if (!target || target.title === title) return
    let file = target.file
    if (!missing.has(id)) {
      try {
        file = await invoke<string>('recording_rename', {
          dir: target.dir,
          oldFile: target.file,
          newFile: sanitizeFileName(title),
        })
      } catch {
        showToast('err', t('recorder.renameFail'))
      }
    }
    persist(list.map((r) => (r.id === id ? { ...r, title, file } : r)))
  }

  /** 保存备注弹窗(20 字上限)。 */
  const commitNote = () => {
    const id = noteTarget?.id
    if (!id) return
    const note = noteDraft.trim()
    setNoteTarget(null)
    const target = list.find((r) => r.id === id)
    if (target && target.note !== note) {
      persist(list.map((r) => (r.id === id ? { ...r, note } : r)))
      showToast('ok', t('recorder.noteSaved'))
    }
  }

  // ---------------------------------------------------------------------------
  // 列表派生:倒序 + 搜索过滤 + 按天分组
  // ---------------------------------------------------------------------------

  const stats = useMemo(() => {
    let bytes = 0
    for (const r of list) bytes += r.bytes
    return { count: list.length, bytes }
  }, [list])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (r) =>
            r.title.toLowerCase().includes(q) || r.note.toLowerCase().includes(q),
        )
      : list
    const out: { key: string; label: string; items: RecordingMeta[] }[] = []
    // 新的在前:列表本身旧的在前,倒序遍历。
    for (let i = filtered.length - 1; i >= 0; i--) {
      const r = filtered[i]
      const key = localDayKey(r.createdAtIso)
      const last = out[out.length - 1]
      if (last && last.key === key) last.items.push(r)
      else out.push({ key, label: dayLabelOf(r.createdAtIso), items: [r] })
    }
    return out
  }, [list, query])

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  const orbContent = () => {
    switch (snap.status) {
      case 'starting':
        return <Mic size={58} strokeWidth={1.6} />
      case 'recording':
        return <Pause size={46} strokeWidth={2} />
      case 'paused':
        return <Play size={46} strokeWidth={2} />
      case 'saving':
        return <Square size={40} strokeWidth={2} />
      default:
        return <Mic size={58} strokeWidth={1.6} />
    }
  }

  const statusLabel = () => {
    switch (snap.status) {
      case 'starting':
        return t('recorder.statusStarting')
      case 'recording':
        return t('recorder.statusRecording')
      case 'paused':
        return t('recorder.statusPaused')
      case 'saving':
        return t('recorder.statusSaving')
      default:
        return t('recorder.statusIdle')
    }
  }

  return (
    <div className="rec-view">
      {/* ===== 录音区 ===== */}
      <section className={`rec-studio is-${snap.status}`}>
        <button
          type="button"
          className="rec-orb"
          onClick={handleOrbClick}
          disabled={snap.status === 'starting' || snap.status === 'saving'}
          aria-label={
            snap.status === 'recording'
              ? t('recorder.ariaPause')
              : snap.status === 'paused'
                ? t('recorder.ariaResume')
                : t('recorder.ariaStart')
          }
        >
          {orbContent()}
        </button>
        {active || snap.status === 'saving' ? (
          <div className="rec-timer" aria-live="polite">
            {fmtDur(snap.elapsedMs)}
          </div>
        ) : null}
        <div className="rec-hint">{statusLabel()}</div>
        {active ? (
          <div className="rec-wave" ref={waveRef} aria-hidden="true">
            {Array.from({ length: WAVE_BARS }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        ) : null}
        {active ? (
          <div className="rec-controls">
            <button
              type="button"
              className="rec-btn is-done"
              onClick={() => void stopRecording('manual')}
            >
              <Check size={14} />
              {t('recorder.done')}
            </button>
            <button
              type="button"
              className="rec-btn is-cancel"
              onClick={() => void cancelRecording()}
            >
              <X size={14} />
              {t('common.cancel')}
            </button>
          </div>
        ) : null}
      </section>

      {/* ===== 启动失败引导(麦克风权限/设备/磁盘) ===== */}
      {snap.status === 'idle' && snap.error ? (
        <div className="rec-error" role="alert">
          <AlertTriangle size={15} />
          <span>{snap.error}</span>
          {snap.errorKind === 'denied' ? (
            <button
              type="button"
              className="rec-error-action"
              onClick={() => void invoke('open_mic_privacy_settings')}
            >
              {t('recorder.systemSettings')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ===== 统计 + 工具 ===== */}
      <div className="rec-toolbar">
        <div className="rec-stats">
          {t('recorder.stats', { n: stats.count, size: fmtBytes(stats.bytes) })}
        </div>
        <div className="rec-toolbar-actions">
          {missing.size > 0 ? (
            <button type="button" className="rec-tool-btn is-warn" onClick={handleCleanupMissing}>
              {t('recorder.cleanMissing', { n: missing.size })}
            </button>
          ) : null}
          <button
            type="button"
            className="rec-tool-btn"
            aria-label={t('recorder.changeDir')}
            title={t('recorder.changeDir')}
            onClick={() => setDirSheetOpen(true)}
          >
            <Settings2 size={13} />
            {t('recorder.location')}
          </button>
          <button type="button" className="rec-tool-btn" onClick={handleOpenFolder}>
            <FolderOpen size={13} />
            {t('recorder.folder')}
          </button>
        </div>
      </div>

      {/* ===== 搜索 ===== */}
      {list.length > 0 ? (
        <div className="rec-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('recorder.searchPlaceholder')}
            spellCheck={false}
          />
          {query ? (
            <button type="button" aria-label={t('recorder.clearSearch')} onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ===== 记录列表 ===== */}
      {list.length === 0 ? (
        <div className="rec-empty">
          <div className="rec-empty-icon">
            <Mic size={26} />
          </div>
          <strong>{t('recorder.emptyTitle')}</strong>
          <span>{t('recorder.emptyHint')}</span>
        </div>
      ) : groups.length === 0 ? (
        <div className="rec-empty">
          <div className="rec-empty-icon">
            <Search size={24} />
          </div>
          <strong>{t('recorder.noMatchTitle')}</strong>
          <span>{t('recorder.noMatchHint')}</span>
        </div>
      ) : (
        <div className="rec-list">
          {groups.map((g) => (
            <section className="rec-group" key={g.key}>
              <div className="rec-group-label">{g.label}</div>
              {g.items.map((item) => {
                const isMissing = missing.has(item.id)
                const renaming = renamingId === item.id
                return (
                  <article
                    key={item.id}
                    className={`rec-item ${isMissing ? 'is-missing' : ''}`}
                    onDoubleClick={() => void handleOpen(item)}
                  >
                    <button
                      type="button"
                      className="rec-play"
                      aria-label={t('recorder.playAria', { title: item.title })}
                      onClick={() => void handleOpen(item)}
                    >
                      <Play size={14} />
                    </button>
                    <div className="rec-item-body">
                      {renaming ? (
                        <input
                          ref={renameInputRef}
                          className="rec-rename-input"
                          type="text"
                          value={renameDraft}
                          maxLength={40}
                          spellCheck={false}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename()
                            else if (e.key === 'Escape') setRenamingId(null)
                          }}
                        />
                      ) : (
                        <div className="rec-item-title" title={item.title}>
                          {item.title}
                          {isMissing ? <em className="rec-missing-tag">{t('recorder.missingTag')}</em> : null}
                        </div>
                      )}
                      <div className="rec-item-meta">
                        {fmtDur(item.durationMs)} · {fmtBytes(item.bytes)} ·{' '}
                        {fmtClock(item.createdAtIso)}
                      </div>
                      {item.note ? (
                        <button
                          type="button"
                          className="rec-note-view"
                          onClick={() => {
                            setNoteTarget(item)
                            setNoteDraft(item.note)
                          }}
                        >
                          {item.note}
                        </button>
                      ) : null}
                    </div>
                    <div className="rec-item-actions">
                      {confirmDeleteId === item.id ? (
                        <>
                          <button
                            type="button"
                            className="rec-act is-danger"
                            aria-label={t('recorder.confirmDelete')}
                            title={t('recorder.confirmDelete')}
                            onClick={() => void handleDelete(item)}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={t('recorder.cancelDelete')}
                            title={t('common.cancel')}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={t('recorder.note')}
                            title={t('recorder.note')}
                            onClick={() => {
                              setConfirmDeleteId(null)
                              setNoteTarget(item)
                              setNoteDraft(item.note)
                            }}
                          >
                            <StickyNote size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={t('recorder.rename')}
                            title={t('recorder.rename')}
                            onClick={() => {
                              setRenamingId(item.id)
                              setRenameDraft(item.title)
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={t('recorder.reveal')}
                            title={t('recorder.reveal')}
                            onClick={() => void handleReveal(item)}
                          >
                            <FolderOpen size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={t('recorder.delete')}
                            title={t('recorder.delete')}
                            onClick={() => {
                              setConfirmDeleteId(item.id)
                              setNoteTarget(null)
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
            </section>
          ))}
          <p className="rec-list-foot">{t('recorder.privacyNote')}</p>
        </div>
      )}

      {/* ===== 备注弹窗(底部,向上展开) ===== */}
      {noteTarget ? (
        <RecSheet title={t('recorder.noteSheet')} onClose={() => setNoteTarget(null)}>
          <div className="rec-note-editor">
            <textarea
              className="rec-note-input"
              value={noteDraft}
              rows={3}
              maxLength={NOTE_MAX}
              placeholder={t('recorder.notePlaceholder')}
              autoFocus
              spellCheck={false}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            <div className="rec-note-count">
              {noteDraft.length}/{NOTE_MAX}
            </div>
            <div className="rec-sheet-actions">
              <button
                type="button"
                className="rec-btn is-cancel"
                onClick={() => setNoteTarget(null)}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className="rec-btn is-done" onClick={commitNote}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </RecSheet>
      ) : null}

      {/* ===== 保存位置弹窗(底部,向上展开) ===== */}
      {dirSheetOpen ? (
        <RecSheet title={t('recorder.dirSheet')} onClose={() => setDirSheetOpen(false)}>
          <div className="rec-dir-body">
            <div className="rec-dir-current">
              {recDir || defaultDir || t('recorder.defaultDir')}
            </div>
            <div className="rec-dir-tip">
              {t('recorder.dirTip')}
            </div>
            <div className="rec-sheet-actions">
              <button type="button" className="rec-btn is-cancel" onClick={resetSaveDir}>
                {t('dataDir.reset')}
              </button>
              <button
                type="button"
                className="rec-btn is-done"
                onClick={() => void pickSaveDir()}
              >
                {t('recorder.pickFolder')}
              </button>
            </div>
          </div>
        </RecSheet>
      ) : null}

      {/* ===== 页内 toast:视觉与全局 .sidebar-toast 对齐(胶囊/12px 600/图标/单行) ===== */}
      {toast ? (
        <div className={`rec-toast is-${toast.kind}`} role="status" aria-live="polite">
          {toast.kind === 'ok' ? (
            <Check size={13} />
          ) : toast.kind === 'warn' ? (
            <AlertTriangle size={13} />
          ) : (
            <X size={13} />
          )}
          <span className="rec-toast-text">{toast.text}</span>
        </div>
      ) : null}
    </div>
  )
}
