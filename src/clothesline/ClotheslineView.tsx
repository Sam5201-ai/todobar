import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import {
  clGetRestoreState,
  clSaveSession,
  clGetMonitors,
  clApplyBoundsAndShow,
  clSetHitRects,
  clSetForceClickable,
  clUpdateSettings,
  clSetAlwaysOnTop,
  clReorderCards,
  clAddCard,
  clUpdateCard,
  clRemoveCard,
  clRestoreCard,
  clReadPreview,
  clSavePreview,
  clMakeCard,
  CL_CARDS_CHANGED,
  CL_ORDER_CHANGED,
  CL_CARD_DROPPED,
  CL_OPEN_NOTE,
  CL_OPEN_TASK,
  CL_EDIT_NOTE_ITEM,
  CL_SETTINGS_CHANGED,
  type ClotheslineSettings,
  type ClotheslineCard,
  type MonitorInfo,
  type SessionState,
  type HitRect,
  type CardPatch,
} from './bridge'
import { useAccount } from '../membership'
import './clothesline.css'

const lsLog = (msg: string) => {
  try {
    console.info(`[clothesline] ${msg}`)
  } catch {
    /* noop */
  }
}

/**
 * 绳窗专用错误边界：崩溃时**保持透明**（不刷白横幅，R63），只写一个透明占位 + 日志。
 * 与全局 ErrorBoundary 不同——后者有不透明背景，在置顶透明层上会变成刺眼白块。
 */
export class ClotheslineErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    try {
      localStorage.setItem(
        'todobar.clothesline.crash',
        JSON.stringify({ time: new Date().toISOString(), message: error.message, stack: (error.stack || '').slice(0, 1500) }),
      )
    } catch {
      /* noop */
    }
    lsLog(`渲染异常（已保持透明）: ${error.message}`)
  }
  render() {
    // 失败只留透明节点，窗口继续存在但不可见——绝不打断桌面其它功能。
    return this.state.failed ? <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} /> : this.props.children
  }
}

/** 与 Rust geometry_signature 逐字一致：工作区宽x高@缩放。签名未变则锚点原样。 */
const geoSignature = (mon: MonitorInfo) =>
  `${mon.width}x${mon.height}@${mon.scale_factor}`

/** 卡片按 (order asc, id 字典序) 确定性排序——与 createdAt 彻底解耦（PRD R78）。 */
const sortCards = (cards: ClotheslineCard[]) =>
  [...cards].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

/** 由 card.id 哈希确定性算出倾角 / 风相位：重启后同一个 id 姿态完全一致（禁止重新随机）。 */
function hashPose(id: string): { tilt: number; windPhase: number } {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const u = (h >>> 0) / 4294967295
  return { tilt: +(u * 4 - 2).toFixed(2), windPhase: +(u * Math.PI * 2).toFixed(3) }
}

/** 引用源是否已失效（原便利签/贴图/剪贴板/待办/本地图被删或路径丢失）。
 *  ★失效只降级占位，绝不把卡片从数组移除（PRD R79「没删就一定在」）。 */
function refBroken(card: ClotheslineCard): boolean {
  switch (card.kind) {
    case 'note':
      return !card.note_id
    case 'pin':
      return !card.pin_id
    case 'clipboard':
      return !card.clip_id
    case 'task':
      return !card.task_id
    case 'shot':
    case 'image':
      return !card.src_path
    default:
      return false // text / timer 自持数据，永不因外部引用失效而占位。
  }
}

/** 便利签只读快照：各窗共享 WebView2 数据源，绳窗**只读 localStorage**，绝不调
 *  notes/store.ts 的写入 API（commit() 会整文件覆盖 prefs.json，R60 竞态）。 */
type NoteLite = { id: string; items?: Array<{ id: string; text: string; done: boolean }> }
const NOTES_LS_KEY = 'ticktask.notes.v1'
function readNoteLite(id: string | null): NoteLite | null {
  if (!id) return null
  try {
    const raw = window.localStorage.getItem(NOTES_LS_KEY)
    if (!raw) return null
    const list = JSON.parse(raw) as NoteLite[]
    return list.find((n) => n?.id === id) ?? null
  } catch {
    return null
  }
}

/** 卡片呈现内容。外部引用失效只降级占位，卡本身保留原槽位。 */
function cardCopy(card: ClotheslineCard): { title: string; text: string; missing: boolean } {
  if (refBroken(card)) {
    return { title: '原内容已删除', text: '卡片已保留在原位', missing: true }
  }
  if (card.kind === 'note') {
    const note = readNoteLite(card.note_id)
    if (!note) return { title: '原内容已删除', text: '卡片已保留在原位', missing: true }
    const items = note.items ?? []
    const itemId = card.attach_to?.startsWith('item:') ? card.attach_to.slice(5) : null
    if (itemId) {
      const item = items.find((it) => it.id === itemId)
      if (!item) return { title: '该条事项已删除', text: '卡片已保留在原位', missing: true }
      return { title: '便利签 · 单条', text: `${item.done ? '✓ ' : '· '}${item.text}`, missing: false }
    }
    return {
      title: '便利签',
      text: items.length ? items.map((it) => `${it.done ? '✓ ' : '· '}${it.text}`).join('\n') : '（空便利签）',
      missing: false,
    }
  }
  const title = card.title || (
    card.kind === 'shot' ? '截图'
      : card.kind === 'timer' ? '计时'
      : card.kind === 'clipboard' ? '剪贴板'
      : card.kind === 'image' ? '图片'
      : card.kind === 'pin' ? '贴图'
      : card.kind === 'task' ? '待办' : '文字'
  )
  return { title, text: card.text || '（无内容）', missing: false }
}

/** 计时卡：结束时间写盘，重启后续算而非重开（wallclock）。 */
function timerText(card: ClotheslineCard, now: number): string {
  const remain = (card.end_at ?? now) - now
  const abs = Math.abs(remain)
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const s = Math.floor((abs % 60_000) / 1000)
  const body = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (card.timer_direction === 'countup') return `已计 ${body}`
  return remain <= 0 ? '时间到' : `剩余 ${body}`
}

/** 番茄圆环进度：总时长由 created_at→end_at 推出，绝不 render 期读 Date.now()。 */
function timerRatio(card: ClotheslineCard, now: number): number {
  const end = card.end_at ?? now
  const total = Math.max(1, end - card.created_at)
  return Math.min(1, Math.max(0, (end - now) / total))
}

type TimerAction = 'pause' | 'resume' | 'reset' | 'plus5'
type CardFaceProps = {
  card: ClotheslineCard
  copy: { title: string; text: string; missing: boolean }
  thumb: string | null
  timer: string | null
  ratio: number
  windPhase: number
  onTimerAction: (action: TimerAction) => void
}

/**
 * 原型多态卡片（clothesline-preview.html §各类卡片）：便利签勾选清单 / 待办行 /
 * 番茄圆环 + 控制 / 大图 caption+meta / 楷体便签 / 等宽剪贴板。
 * ⚠️ 这里只做呈现，所有写操作仍由主组件走 clUpdateCard / clRemoveCard，单一写锁不变。
 */
function CardFace({ card, copy, thumb, timer, ratio, windPhase, onTimerAction }: CardFaceProps) {
  const faceStyle = { animationDelay: `${windPhase + 0.3}s` } as CSSProperties
  const pinMark = card.pinned ? ' · 置顶' : ''

  if (card.kind === 'timer') {
    const frozen = card.end_at == null
    return (
      <div className="cl-face" style={faceStyle}>
        <span className="cl-tm-head">{copy.title}{pinMark}</span>
        <div className="cl-tm-ring">
          <svg className="cl-tm-svg" viewBox="0 0 96 96" aria-hidden="true">
            <circle className="cl-tm-bg" cx="48" cy="48" r="42" />
            <circle
              className="cl-tm-fg"
              cx="48"
              cy="48"
              r="42"
              style={{ strokeDashoffset: 263.9 * (1 - ratio) }}
            />
          </svg>
          <span className={`cl-tm-time ${timer?.startsWith('时间到') ? 'is-fired' : ''}`}>
            {timer?.replace(/^(剩余|已计|时间到)\s*/, '') ?? '--:--'}
          </span>
        </div>
        <div className="cl-tm-btns" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => onTimerAction(frozen ? 'resume' : 'pause')}>
            {frozen ? '继续' : '暂停'}
          </button>
          <button type="button" onClick={() => onTimerAction('reset')}>小重置</button>
          <button type="button" onClick={() => onTimerAction('plus5')}>+5 分</button>
        </div>
        <span className="cl-tm-foot">
          {card.timer_direction === 'countup' ? '正计时' : '倒计时'} · 右键更多
          {pinMark}
        </span>
      </div>
    )
  }

  if (card.kind === 'note') {
    const note = readNoteLite(card.note_id)
    const itemId = card.attach_to?.startsWith('item:') ? card.attach_to.slice(5) : null
    const items = (note?.items ?? []).filter((it) => !itemId || it.id === itemId).slice(0, 6)
    return (
      <div className="cl-face" style={faceStyle}>
        <span className="cl-note-title">{itemId ? '便利签 · 单条' : copy.title}{pinMark}</span>
        <ul className="cl-note-list">
          {items.map((it) => (
            <li key={it.id} className={`cl-note-row ${it.done ? 'is-done' : ''}`}>
              <i />
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
        {items.length === 0 ? <span className="cl-note-more">（空便利签）</span> : null}
      </div>
    )
  }

  if (card.kind === 'task') {
    const lines = copy.text.split('\n').filter(Boolean).slice(0, 5)
    return (
      <div className="cl-face" style={faceStyle}>
        <span className="cl-task-title">{copy.title}{pinMark}</span>
        {lines.length ? (
          lines.map((t, i) => (
            <div className="cl-task-row" key={`${i}-${t}`}><i /><span>{t}</span></div>
          ))
        ) : (
          <div className="cl-task-row"><i /><span>（无内容）</span></div>
        )}
      </div>
    )
  }

  if (card.kind === 'shot' || card.kind === 'pin' || card.kind === 'image') {
    return (
      <div className="cl-face" style={faceStyle}>
        {thumb ? (
          <div className="cl-photo"><img src={thumb} alt="预览" draggable={false} /></div>
        ) : (
          <div className="cl-photo-empty">
            <div className="cl-mini-shot">
              <div className="ms-bar"><i /><i /><i /></div>
              <div className="ms-line w1" />
              <div className="ms-line w2" />
              <div className="ms-line w3" />
            </div>
          </div>
        )}
        <span className="cl-caption">{copy.title}{pinMark}</span>
        <span className="cl-meta">{copy.text || '挂在晾衣绳上'}</span>
      </div>
    )
  }

  if (card.kind === 'text') {
    return (
      <div className="cl-face" style={faceStyle}>
        <div className="cl-txt">{copy.text}</div>
        {pinMark ? <span className="cl-meta">{pinMark.trim()}</span> : null}
      </div>
    )
  }

  // clipboard（等宽）
  return (
    <div className="cl-face" style={faceStyle}>
      <div className="cl-clip-txt">{copy.text}</div>
      {pinMark ? <span className="cl-meta">{pinMark.trim()}</span> : null}
    </div>
  )
}

/** 主窗偏好快照（各窗共享 localStorage）：绳窗据此避让贴边主窗 + 跟随主窗主题。 */
const SIDEBAR_LS_KEY = 'todobar.sidebar.settings.v19'
type SidebarPrefLite = {
  dockSide?: unknown
  theme?: unknown
  panelWidth?: unknown
  tabWidth?: unknown
  targetMonitor?: unknown
}
function readSidebarPref(): SidebarPrefLite {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LS_KEY)
    return raw ? (JSON.parse(raw) as SidebarPrefLite) : {}
  } catch {
    return {}
  }
}
function readDockSide(): 'left' | 'right' {
  return readSidebarPref().dockSide === 'left' ? 'left' : 'right'
}
function readSidebarTheme(): 'light' | 'dark' {
  return readSidebarPref().theme === 'dark' ? 'dark' : 'light'
}

/** 主窗此刻是否落在 mon 这块屏，以及它贴边占用的物理宽度（PRD §4 / R3「不可关」）。
 *  ⚠️ 主窗 targetMonitor 存的是 dock.ts::monitorKey（= m.name.trim() 或 `mon@x,y`），与绳窗
 *     自己的 stable_id（硬件段:宽x高）**不是同一套 ID**，绝不能用 stable_id 比对，否则副屏
 *     永远判不中。拿不到可靠落屏信息时宁可返回 null（不避让），也不误裁绳窗宽度。 */
function mainWindowOccupancy(
  mon: MonitorInfo,
): { side: 'left' | 'right'; occupyPhys: number } | null {
  const pref = readSidebarPref()
  const target = pref.targetMonitor
  let mainHere: boolean
  if (target === 'primary' || target == null || target === '') {
    mainHere = mon.is_primary
  } else if (target === 'secondary') {
    mainHere = !mon.is_primary
  } else if (typeof target === 'string') {
    mainHere = target === mon.name || target === `mon@${mon.x},${mon.y}`
  } else {
    mainHere = mon.is_primary
  }
  if (!mainHere) return null
  const sf = mon.scale_factor || 1
  const panelW =
    typeof pref.panelWidth === 'number' && Number.isFinite(pref.panelWidth)
      ? pref.panelWidth
      : 340
  const tabW =
    typeof pref.tabWidth === 'number' && Number.isFinite(pref.tabWidth)
      ? pref.tabWidth
      : 42
  // 保守按主窗「展开态」满宽避让：主窗收起时绳子略短，但绝不盖住主窗（安全第一）。
  return { side: readDockSide(), occupyPhys: Math.round((panelW + tabW) * sf) }
}

/** 收起态可点矩形：屏幕绝对物理坐标，精确复刻 .cl-handle / .cl-pulltab 的 CSS 布局。
 *  ⚠️ CSS 的 `left:%` 相对窗口宽 → 换算后 = ratio*panelW（物理）；固定 px 需 ×scaleFactor。
 *     绝不能再用 mon.width（宽屏会错几百像素 → 把手看得见却点不到），也不能漏算 CSS 的 top 偏移。 */
function collapsedHitRects(
  winX: number,
  winY: number,
  panelW: number,
  scaleFactor: number,
  pullRatio: number,
): HitRect[] {
  const sf = scaleFactor || 1
  const handleW = Math.round(44 * sf)
  const handleH = Math.round(96 * sf)
  const hx = winX + Math.round(pullRatio * panelW - 22 * sf)
  const hy = winY + Math.round(14 * sf)
  const pullW = Math.round(30 * sf)
  const pullH = Math.round(34 * sf)
  const px = winX + Math.round(pullRatio * panelW - 15 * sf)
  const py = winY + Math.round(38 * sf)
  return [
    { x: hx, y: hy, width: handleW, height: handleH },
    { x: px, y: py, width: pullW, height: pullH },
  ]
}

export function ClotheslineView() {
  const [settings, setSettings] = useState<ClotheslineSettings | null>(null)
  // 主题跟随主窗显式选择（各窗共享 localStorage 同源），而非系统 prefers-color-scheme。
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null)
  const [cards, setCards] = useState<ClotheslineCard[]>([])
  const [expanded, setExpanded] = useState(true)
  const [ready, setReady] = useState(false)
  const [restoring, setRestoring] = useState(true) // 恢复期跳过入场动画 / 自动滚入视野。
  const [monitorFallback, setMonitorFallback] = useState(false)
  const [recoveredFromBackup, setRecoveredFromBackup] = useState(false)
  // ＋ 菜单与清风冻结（原型 .add-sheet / §4.6「鼠标移入即冻结，移出 200ms 恢复」）。
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [windPaused, setWindPaused] = useState(false)
  const windPauseTimerRef = useRef<number | null>(null)
  // 拖绳 / 拉杆会话（PRD §11 / §4.7）：声明必须在事件监听 effect 之前，避免 TDZ。
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ropeDragRef = useRef<{
    startY: number
    startAnchor: number
    nextY: number
    moved: boolean
  } | null>(null)
  const pullDragRef = useRef<{
    startX: number
    startY: number
    startRatio: number
    nextRatio: number | null
    mode: 'none' | 'horizontal' | 'vertical'
    moved: boolean
  } | null>(null)
  const pullMovedRef = useRef(false)
  const ropeFrameRef = useRef<number | null>(null)
  const pendingYRef = useRef<number | null>(null)
  const pullKeepAliveRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  const geomRef = useRef<{ mon: MonitorInfo; winX: number; panelW: number; anchorY: number } | null>(null)
  const scrollXRef = useRef(0)
  const [scrollX, setScrollX] = useState(0) // transform 平移用 state，render 期绝不读 ref。
  const sessionRef = useRef<SessionState | null>(null)
  // 主窗配置页改偏好后的广播比对基准：避免本窗自己写盘→广播回环导致重复定位。
  const lastSettingsRef = useRef<ClotheslineSettings | null>(null)
  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  /** transform 平移上限 = 内容宽 − 视口宽（PRD §4.1 无滚动条横向平移）。 */
  const maxScrollX = useCallback(() => {
    const deck = deckRef.current
    if (!deck) return 0
    return Math.max(0, deck.scrollWidth - deck.clientWidth + 60)
  }, [])
  /** 滚轮横向平移：deltaX / 纵向 deltaY 都映射到水平位移；不产生任何滚动条。 */
  const onDeckWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    scrollXRef.current = Math.min(maxScrollX(), Math.max(0, scrollXRef.current + delta))
    setScrollX(scrollXRef.current)
  }, [maxScrollX, setScrollX])

  /**
   * 展开态命中矩形：按「真实可点区」上报，绝不退化成空列表。
   * ⚠️ Rust 命中循环里 hit_rects 为空 == 整窗可点；展开态若沿用 [], 300px 高的透明窗
   *    会吞掉桌面顶部所有点击（用户会感知成「加了晾衣绳后桌面点不动了」）。
   *    DOM 未挂载时至少保留麻绳热区这一条，保证列表恒非空。
   * 坐标：getBoundingClientRect 是窗口内 CSS 逻辑像素，×scaleFactor + 窗口物理起点 = 屏幕绝对物理坐标。
   */
  const refreshHitRects = useCallback(async () => {
    const geom = geomRef.current
    if (!geom) return
    const sf = geom.mon.scale_factor || 1
    const winY = geom.mon.y + geom.anchorY
    const cssW = geom.panelW / sf
    const rects: HitRect[] = [
      {
        // 与 .cl-rope-hotzone 的 CSS（left/right:24px；top:14px；height:36px）逐字对齐。
        x: geom.winX + Math.round(24 * sf),
        y: winY + Math.round(14 * sf),
        width: Math.round(Math.max(0, cssW - 48) * sf),
        height: Math.round(36 * sf),
      },
    ]
    rootRef.current?.querySelectorAll<HTMLElement>('[data-cl-hit], [data-cl-card-id]').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return // display:none / 收起态隐藏元素
      rects.push({
        x: geom.winX + Math.round(r.left * sf),
        y: winY + Math.round(r.top * sf),
        width: Math.round(r.width * sf),
        height: Math.round(r.height * sf),
      })
    })
    await clSetHitRects(rects)
  }, [])

  /** 把窗口摆到目标屏 + 上报命中矩形。所有坐标物理像素。 */
  const placeAndArm = useCallback(async (anchorY: number, isExpanded: boolean, mon: MonitorInfo, pullRatio: number) => {
    const ropeH = isExpanded ? 300 : 120
    const clampedAnchor = Math.min(anchorY, Math.max(0, mon.height - ropeH - 24))

    // ★空间避让贴边主窗（PRD R3 / §4.2，不可关）：绳窗只占「对侧」的安全区，
    //   绝不盖主窗顶栏与把手。主窗不在本屏 / 主窗已关 → 占满整屏宽度（回退旧行为）。
    const occ = mainWindowOccupancy(mon)
    const winX = occ?.side === 'left' ? mon.x + occ.occupyPhys : mon.x
    // 可用宽 = 屏宽 − 主窗避让宽；窗口宽绝不超过可用宽（极窄屏也不越出目标屏右缘），
    // 正常屏取 min(可用宽, 1280)。下限跟随可用宽收缩，避免 max(320,…) 把窗口顶出屏外。
    const availW = Math.max(0, mon.width - (occ?.occupyPhys ?? 0))
    const panelW = Math.min(Math.max(320, Math.min(availW, 1280)), availW)
    geomRef.current = { mon, winX, panelW, anchorY: clampedAnchor }

    // ★先同步 reflow 再 setTimeout 兜底：隐藏窗里 requestAnimationFrame 会被丢弃，
    //   直接 rAF 定位会不执行 → 窗口在错误位置 show（PRD §5.16 / MEMORY）。
    const applyNow = () => {
      void clApplyBoundsAndShow(winX, mon.y + clampedAnchor, panelW, ropeH).then(() => {
        setReady(true)
        lsLog(
          `定位完成 screen=${mon.stable_id} @${winX},${mon.y + clampedAnchor} ${panelW}x${ropeH}` +
            (occ ? ` (避让${occ.side}主窗 ${occ.occupyPhys}px)` : ''),
        )
      })
    }
    if (rootRef.current) void rootRef.current.offsetHeight
    applyNow()
    window.setTimeout(applyNow, 60) // 兜底：首帧丢帧时 60ms 后再写一次（幂等）。

    // 命中矩形：展开态按真实可点区（卡片 / 工具条 / ＋菜单 / 麻绳热区）上报；
    // 收起态只有把手竖条 + 下拉胶囊。
    // ⚠️ 绝不能传 []：Rust 命中循环里空列表 == 整窗可点，300px 透明窗会吞掉桌面顶部所有点击。
    // ⚠️ 收起态传窗口物理起点 winX / 物理宽 panelW / DPI，不能用屏幕宽（宽屏把手会点不到）。
    if (isExpanded) {
      await refreshHitRects()
    } else {
      await clSetHitRects(
        collapsedHitRects(winX, mon.y + clampedAnchor, panelW, mon.scale_factor, pullRatio),
      )
    }
  }, [refreshHitRects])

  // 启动恢复：一次读齐 settings + cards(+bak) + session + monitors（Rust 只读，绝不写空覆盖）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let state = await clGetRestoreState().catch(() => null)
        if (!state) {
          // IPC 抖动兜底：重试一次。
          await new Promise((r) => setTimeout(r, 120))
          state = await clGetRestoreState().catch(() => null)
        }
        if (cancelled || !state) {
          lsLog('恢复状态读取失败（保持透明）')
          return
        }
        const mon =
          state.monitors.find((m) => m.stable_id === state!.target_monitor_stable_id) ??
          state.monitors.find((m) => m.is_primary) ??
          state.monitors[0]
        if (!mon) {
          lsLog('无可用显示器（保持透明）')
          return
        }

        setSettings(state.settings)
        lastSettingsRef.current = state.settings // 设置变更广播的比对基准，避免首条边界歧义。
        setTheme(readSidebarTheme()) // 绳窗主题对齐主窗显式选择（light/dark）。
        setMonitor(mon)
        setCards(sortCards(state.cards)) // 按 order 确定性还原，不按创建时间。
        // 展开/收起恢复规则（PRD §6.2「开机自动显示」）：
        //   ① 崩溃退出（clean_exit=false）→ 强制收起，避免异常态遮挡屏幕；
        //   ② 「开机自动显示」关 → 本次启动强制收起（只露木夹把手，用户随时点开），
        //      不采用「根本不建窗」——否则无托盘入口时绳窗再也唤不出，且本次会话内切
        //      该开关不会主动干预已显示的绳窗（PRD「关不影响本次会话」）。
        //   ③ 正常退出且该开关开 → 恢复退出前的展开/收起状态。
        const initExpanded =
          state.session.clean_exit && state.settings.auto_show_on_boot
            ? !state.session.collapsed
            : false
        setExpanded(initExpanded)
        setMonitorFallback(state.monitor_fallback)
        setRecoveredFromBackup(state.recovered_from_backup)
        scrollXRef.current = state.session.scroll_x
        setScrollX(state.session.scroll_x)
        sessionRef.current = state.session
        lsLog(
          `restore ok: cards=${state.cards.length}, monitor=${mon.stable_id}, ` +
            `anchorY=${state.session.anchor_y}${state.recovered_from_backup ? ' (来自备份)' : ''}`,
        )

        // 拔屏 / 首次启用 → 自固化新稳定 ID（唯一允许的启动时写，不碰 cards.json）。
        if (state.settings.monitor_stable_id !== mon.stable_id) {
          const updated = await clUpdateSettings({ monitor_stable_id: mon.stable_id }).catch(
            () => null,
          )
          if (!cancelled && updated) setSettings(updated)
        }

        await placeAndArm(state.session.anchor_y, initExpanded, mon, state.settings.pulltab_x_ratio)
        // 恢复完成，下一帧结束 restoring（跳过入场动画）。
        window.setTimeout(() => {
          if (!cancelled) setRestoring(false)
        }, 80)
      } catch (e) {
        lsLog(`恢复失败（保持透明）: ${String(e)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [placeAndArm])

  // 卸载 / 窗口隐藏前写 session（collapsed + scrollX + 几何签名 + cleanExit）。
  // 用 beforeunload + visibilitychange 双保险：WebView 隐藏不总是触发 unmount。
  const persistSession = useCallback(() => {
    const s = sessionRef.current
    const geom = geomRef.current
    if (!s || !geom) return
    void clSaveSession({
      ...s,
      collapsed: !expanded,
      scroll_x: scrollXRef.current,
      geo_sig: geoSignature(geom.mon),
      anchor_y: geom.anchorY,
      monitor_stable_id: geom.mon.stable_id,
    }).catch(() => undefined)
  }, [expanded])

  useEffect(() => {
    window.addEventListener('beforeunload', persistSession)
    const onVis = () => {
      if (document.visibilityState === 'hidden') persistSession()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('beforeunload', persistSession)
      document.removeEventListener('visibilitychange', onVis)
      persistSession() // StrictMode 卸载也写一次（幂等）。
    }
  }, [persistSession])

  // 展开 / 收起：改本地 + 更新配置 + 重定位 + 重算命中矩形。
  const toggleExpanded = useCallback(async () => {
    if (!settings || !monitor) return
    await clSetForceClickable(600)
    const next = !expanded
    setExpanded(next)
    await clUpdateSettings({ expanded: next }).catch(() => undefined)
    await placeAndArm(settings.anchor_y, next, monitor, settings.pulltab_x_ratio)
  }, [settings, monitor, expanded, placeAndArm])

  const toggleTopmost = useCallback(async () => {
    if (!settings) return
    const next = { ...settings, always_on_top: !settings.always_on_top }
    setSettings(next)
    await clSetAlwaysOnTop(next.always_on_top)
  }, [settings])

  // ———————————————————— 阶段 3：卡片拖动排序 ————————————————————
  // ★零逐帧 IPC：拖动期间只改本地 dragVisual + CSS transform；松手才 1 次 clReorderCards。
  // 三种入口：木夹把手按下 120ms / 正文长按 350ms / Alt+拖立即。Esc 或拖出绳外一律回滚。
  type DragMode = 'clip' | 'longpress' | 'alt'
  type DragSession = {
    id: string
    card: ClotheslineCard
    mode: DragMode
    pointerId: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    lastX: number
    lastY: number
    active: boolean
    timer: number | null
    keepAlive: number | null
    preview: string[] | null
  }
  type DragVisual = {
    id: string
    card: ClotheslineCard
    x: number
    y: number
    order: string[]
    insertAt: number
  }

  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null)
  const [reorderFailed, setReorderFailed] = useState(false)
  const dragRef = useRef<DragSession | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const clickMuteRef = useRef(false)
  const clickMuteTimerRef = useRef<number | null>(null)
  const cardsRef = useRef(cards)

  // ———————————————————— 阶段 4：卡片内容与操作 ————————————————————
  const { fullAccess } = useAccount()
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [notesTick, setNotesTick] = useState(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [cardMenu, setCardMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [composing, setComposing] = useState<'text' | 'timer' | null>(null)
  const [composeText, setComposeText] = useState('')
  const [composeMinutes, setComposeMinutes] = useState('25')
  const [undoCard, setUndoCard] = useState<{ id: string; label: string } | null>(null)
  const [hint, setHint] = useState('')
  const hintTimerRef = useRef<number | null>(null)
  const undoTimerRef = useRef<number | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const flash = useCallback((msg: string) => {
    setHint(msg)
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setHint(''), 2800)
  }, [setHint])

  // 事件回调需要最新 cards，但不允许在 render 期写 ref（React Compiler 铁律）。
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  /** 拖完短暂吞 click；用布尔 + 定时器，避免在 render 期调 Date.now（purity 规则）。 */
  const muteClicks = useCallback(() => {
    clickMuteRef.current = true
    if (clickMuteTimerRef.current !== null) window.clearTimeout(clickMuteTimerRef.current)
    clickMuteTimerRef.current = window.setTimeout(() => {
      clickMuteRef.current = false
    }, 400)
  }, [])
  const clickSuppressed = useCallback(() => clickMuteRef.current, [])

  /** 别的窗口（主窗 / 截图窗）改了卡片时同步；本窗排序 emit 回来是幂等的。 */
  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    void (async () => {
      const reg = <T,>(event: string, cb: (payload: T) => void) => {
        void listen<T>(event, (e) => {
          if (!cancelled) cb(e.payload)
        })
          .then((u) => {
            if (cancelled) u()
            else unsubs.push(u)
          })
          .catch(() => undefined)
      }
      reg<ClotheslineCard[]>(CL_CARDS_CHANGED, (list) => setCards(sortCards(list)))
      reg<Array<[string, number]>>(CL_ORDER_CHANGED, (pairs) => {
        const map = new Map(pairs)
        setCards((prev) =>
          [...prev]
            .map((c) => ({ ...c, order: map.get(c.id) ?? c.order }))
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
        )
      })
      reg<string>(CL_CARD_DROPPED, (id) => {
        setUndoCard({ id, label: '已满 · 已撕下最旧一张' })
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = window.setTimeout(() => setUndoCard(null), 10_000)
      })
      // 主窗配置页改了 6 项偏好 → 本次会话内即时生效（清风 / 比例靠 state；展开 / 换屏要重定位）。
      reg<ClotheslineSettings>(CL_SETTINGS_CHANGED, (next) => {
        const prev = lastSettingsRef.current
        lastSettingsRef.current = next
        setSettings(next) // 清风 wind_effect / pulltab 比例：class、样式立即响应。
        const geom = geomRef.current
        if (!geom) return // 恢复未完成，忽略；启动恢复本身已按磁盘摆位。
        const expandedChanged = next.expanded !== expandedRef.current
        const monitorChanged =
          next.monitor_stable_id !== geom.mon.stable_id &&
          (!prev || prev.monitor_stable_id !== next.monitor_stable_id)
        if (!expandedChanged && !monitorChanged) return
        if (next.expanded !== expandedRef.current) setExpanded(next.expanded)
        // 换屏要按新屏重算几何（物理起点 / 工作区 clamp / 命中矩形），不能沿用旧屏 mon。
        if (next.monitor_stable_id !== geom.mon.stable_id) {
          void clGetMonitors()
            .then((ms) => {
              const target =
                ms.find((m) => m.stable_id === next.monitor_stable_id) ??
                ms.find((m) => m.is_primary) ??
                ms[0]
              if (!cancelled && target) {
                setMonitor(target)
                void placeAndArm(next.anchor_y, next.expanded, target, next.pulltab_x_ratio)
              }
            })
            .catch(() => undefined)
        } else {
          void placeAndArm(next.anchor_y, next.expanded, geom.mon, next.pulltab_x_ratio)
        }
      })
      // 便利签是 localStorage 同源共享；两通道保证主窗写入后本窗立即刷新。
      reg<unknown>('notes-changed', () => setNotesTick((n) => n + 1))
      const onStorage = (e: StorageEvent) => {
        if (e.key === NOTES_LS_KEY) setNotesTick((n) => n + 1)
      }
      window.addEventListener('storage', onStorage)
      unsubs.push(() => window.removeEventListener('storage', onStorage))
    })()
    return () => {
      cancelled = true
      unsubs.forEach((u) => u())
      if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
      if (windPauseTimerRef.current !== null) window.clearTimeout(windPauseTimerRef.current)
      if (ropeFrameRef.current !== null) window.cancelAnimationFrame(ropeFrameRef.current)
      if (pullKeepAliveRef.current !== null) window.clearInterval(pullKeepAliveRef.current)
    }
  }, [placeAndArm])

  /** 媒体卡缩略图按需读回（capabilities 未授权 asset://，走 Rust data URL）。 */
  const mediaKey = cards
    .filter((c) => (c.kind === 'shot' || c.kind === 'pin' || c.kind === 'image') && c.src_path)
    .map((c) => `${c.id}:${c.src_path}`)
    .join('|')
  useEffect(() => {
    let cancelled = false
    const ids = mediaKey ? mediaKey.split('|').map((s) => s.split(':')[0]) : []
    if (ids.length === 0) return // 没有媒体卡时旧缓存不会被渲染，无需在 effect 内 setState
    void Promise.all(
      ids.map(async (id) => [id, await clReadPreview(id).catch(() => null)] as const),
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const [id, url] of pairs) if (url) next[id] = url
      setPreviews(next)
    })
    return () => {
      cancelled = true
    }
  }, [mediaKey])

  const hasTimer = cards.some((c) => c.kind === 'timer' && (c.end_at ?? 0) > 0)
  useEffect(() => {
    if (!hasTimer) return
    const fired = new Set<string>()
    const check = () => {
      const now = Date.now()
      setNowTick(now)
      for (const c of cardsRef.current) {
        if (
          c.kind === 'timer' &&
          c.end_at &&
          c.end_at <= now &&
          !c.fired_at &&
          !fired.has(c.id)
        ) {
          fired.add(c.id)
          void clUpdateCard(c.id, { fired_at: now }).catch(() => undefined)
          void import('@tauri-apps/plugin-notification')
            .then((m) => m.sendNotification({ title: '晾衣绳 · 时间到', body: c.title || '计时结束' }))
            .catch(() => undefined)
        }
      }
    }
    check()
    const id = window.setInterval(check, 1000)
    return () => window.clearInterval(id)
  }, [hasTimer])

  const addCard = useCallback(
    async (kind: ClotheslineCard['kind'], patch: Partial<ClotheslineCard>, autoDropOldest = false) => {
      try {
        const card = await clAddCard(clMakeCard(kind, patch), fullAccess, autoDropOldest)
        setCards((prev) => sortCards([...prev, card]))
        flash('已挂到晾衣绳')
        return card
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
        return null
      }
    },
    [fullAccess, flash, setCards],
  )

  const takeDown = useCallback(
    async (card: ClotheslineCard) => {
      setCardMenu(null)
      setEditing(null)
      try {
        await clRemoveCard(card.id)
        setCards((prev) => prev.filter((c) => c.id !== card.id))
        setUndoCard({ id: card.id, label: `已取下「${cardCopy(card).title}」` })
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = window.setTimeout(() => setUndoCard(null), 10_000)
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCardMenu, setCards, setEditing, setUndoCard],
  )

  const undoTakeDown = useCallback(async () => {
    const u = undoCard
    if (!u) return
    try {
      const card = await clRestoreCard(u.id)
      setCards((prev) => sortCards([...prev.filter((c) => c.id !== card.id), card]))
      setUndoCard(null)
      flash('已放回原位')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }, [undoCard, flash, setCards, setUndoCard])

  const togglePin = useCallback(
    async (card: ClotheslineCard) => {
      setCardMenu(null)
      try {
        const next = await clUpdateCard(card.id, { pinned: !card.pinned })
        setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)))
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCardMenu, setCards],
  )

  /** 番茄卡上的暂停 / 继续 / 小重置 / +5 分（原型 .tm-btns）。
   *  ⚠️ 全部走 clUpdateCard 增量写盘，Rust 单一写锁不变；fired_at 清空避免重复通知。 */
  const timerAction = useCallback(
    async (card: ClotheslineCard, action: TimerAction) => {
      const now = Date.now()
      let patch: CardPatch
      if (action === 'pause') {
        if (card.end_at == null) return
        patch = { elapsed_before_pause_ms: Math.max(0, card.end_at - now), end_at: null }
      } else if (action === 'resume') {
        patch = { end_at: now + Math.max(0, card.elapsed_before_pause_ms), elapsed_before_pause_ms: 0 }
      } else if (action === 'reset') {
        const total = Math.max(60_000, (card.end_at ?? card.created_at) - card.created_at)
        patch = { end_at: now + total, elapsed_before_pause_ms: 0, fired_at: null }
      } else {
        patch = {
          end_at: (card.end_at ?? now + card.elapsed_before_pause_ms) + 5 * 60_000,
          fired_at: null,
        }
      }
      try {
        const next = await clUpdateCard(card.id, patch)
        setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)))
        setNowTick(Date.now())
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCards],
  )

  // ————————————— 拖绳 / 拉杆（PRD §11、§4.7、决策点 14）—————————————
  // 只改窗口物理坐标，绝不 resize 内容、绝不逐帧 IPC：拖动期间 rAF 节流，
  // 松手才写盘一次；anchor_y / pulltab_x_ratio 由 Rust 原子落 settings.json，重启原样还原。

  /** anchorY 上限：min(360, 工作区高×40%, 工作区高−绳高−24)；换屏自动按新屏重算。 */
  const anchorMax = useCallback(() => {
    const mon = geomRef.current?.mon
    if (!mon) return 360
    return Math.max(0, Math.min(360, Math.floor(mon.height * 0.4), mon.height - 300 - 24))
  }, [])

  const moveWindowY = useCallback((y: number) => {
    const geom = geomRef.current
    if (!geom) return
    const ropeH = expandedRef.current ? 300 : 120
    void clApplyBoundsAndShow(geom.winX, geom.mon.y + y, geom.panelW, ropeH).catch(() => undefined)
  }, [])

  const scheduleMoveY = useCallback(
    (y: number) => {
      pendingYRef.current = y
      if (ropeFrameRef.current !== null) return
      ropeFrameRef.current = window.requestAnimationFrame(() => {
        ropeFrameRef.current = null
        if (pendingYRef.current !== null) moveWindowY(pendingYRef.current)
      })
    },
    [moveWindowY],
  )

  const onRopePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!expandedRef.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const base = settings?.anchor_y ?? geomRef.current?.anchorY ?? 72
      ropeDragRef.current = { startY: e.clientY, startAnchor: base, nextY: base, moved: false }
      void clSetForceClickable(1500)
    },
    [settings],
  )

  const onRopePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = ropeDragRef.current
      if (!d) return
      const dy = e.clientY - d.startY
      if (Math.abs(dy) < 4 && !d.moved) return
      d.moved = true
      // 8px 网格吸附 + 顶部 40% / 360px 边界 clamp（PRD §5.12）。
      const snapped = Math.round(Math.min(anchorMax(), Math.max(0, d.startAnchor + dy)) / 8) * 8
      d.nextY = snapped
      scheduleMoveY(snapped)
    },
    [anchorMax, scheduleMoveY],
  )

  const onRopePointerUp = useCallback(() => {
    const d = ropeDragRef.current
    ropeDragRef.current = null
    if (ropeFrameRef.current !== null) {
      window.cancelAnimationFrame(ropeFrameRef.current)
      ropeFrameRef.current = null
    }
    if (!d || !d.moved) return
    const next = Math.min(anchorMax(), Math.max(0, d.nextY))
    if (next === d.startAnchor) return
    void clUpdateSettings({ anchor_y: next }).catch(() => undefined)
    if (next >= anchorMax()) flash('已到顶部 40% 边界 · 位置已保存')
    const mon = geomRef.current?.mon
    if (mon) void placeAndArm(next, expandedRef.current, mon, settings?.pulltab_x_ratio ?? 0.5)
  }, [anchorMax, flash, placeAndArm, settings])

  const onPullPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      pullDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startRatio: settings?.pulltab_x_ratio ?? 0.5,
        nextRatio: null,
        mode: 'none',
        moved: false,
      }
      // 收起态窗口默认穿透：拖动全程必须持续「临时强制可点」，否则 pointermove 会断。
      void clSetForceClickable(1500)
      if (pullKeepAliveRef.current !== null) window.clearInterval(pullKeepAliveRef.current)
      pullKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(1500), 900)
    },
    [settings],
  )

  const onPullPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = pullDragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    // 方向阈值仲裁：水平 >8px 判「拉杆平移」，垂直 >24px 判「下拉展开」（PRD §4.7）。
    if (d.mode === 'none') {
      if (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy)) d.mode = 'horizontal'
      else if (dy > 24) d.mode = 'vertical'
      else return
      d.moved = true
    }
    if (d.mode !== 'horizontal') return
    const w = Math.max(1, window.innerWidth)
    const ratio = Math.min(0.92, Math.max(0.08, (d.startRatio * w + dx) / w))
    d.nextRatio = ratio
    setDragRatio(ratio)
  }, [])

  const onPullPointerUp = useCallback(() => {
    const d = pullDragRef.current
    pullDragRef.current = null
    pullMovedRef.current = d?.moved ?? false
    if (pullKeepAliveRef.current !== null) {
      window.clearInterval(pullKeepAliveRef.current)
      pullKeepAliveRef.current = null
    }
    setDragRatio(null)
    if (!d) return
    if (d.mode === 'horizontal' && d.nextRatio !== null) {
      void clUpdateSettings({ pulltab_x_ratio: d.nextRatio }).catch(() => undefined)
      flash(`拉杆位置 ${Math.round(d.nextRatio * 100)}% · 已保存`)
    } else if (d.mode === 'vertical') {
      void toggleExpanded()
    }
  }, [flash, toggleExpanded])

  /** ＋菜单「显示屏幕」：多屏时循环切下一屏；只写盘，重定位交给设置变更广播，避免重复摆位。 */
  const cycleMonitor = useCallback(async () => {
    try {
      const ms = await clGetMonitors()
      if (ms.length < 2) {
        flash('当前只有一个屏幕')
        return
      }
      const cur = geomRef.current?.mon.stable_id ?? ''
      const i = ms.findIndex((m) => m.stable_id === cur)
      const next = ms[(i + 1) % ms.length]
      if (!next) return
      await clUpdateSettings({ monitor_stable_id: next.stable_id })
      flash(`晾衣绳已切到 ${next.name || '另一屏幕'} · 位置已保存`)
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }, [flash])

  const commitEdit = useCallback(
    async (id: string, value: string) => {
      setEditing(null)
      const text = value.trim()
      if (!text) return
      try {
        const target = cardsRef.current.find((c) => c.id === id)
        // 便利签单条事项：写回仍由主窗走 notes/store.ts，绳窗绝不写 prefs.json（R60）。
        if (target?.kind === 'note' && target.note_id && target.attach_to?.startsWith('item:')) {
          await emit(CL_EDIT_NOTE_ITEM, {
            noteId: target.note_id,
            itemId: target.attach_to.slice(5),
            text,
          })
        }
        const next = await clUpdateCard(id, { text })
        setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)))
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCards, setEditing],
  )

  const openSource = useCallback(
    async (card: ClotheslineCard) => {
      setCardMenu(null)
      try {
        if (card.kind === 'note' && card.note_id) await emit(CL_OPEN_NOTE, { id: card.note_id })
        else if (card.kind === 'task' && card.task_id) await emit(CL_OPEN_TASK, { id: card.task_id })
        else flash('这张卡的内容已存在卡片里，可直接编辑')
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCardMenu],
  )

  const submitCompose = useCallback(async () => {
    if (composing === 'timer') {
      const min = Math.min(720, Math.max(1, Number(composeMinutes) || 25))
      const ok = await addCard('timer', {
        title: `${min} 分钟计时`,
        text: '',
        end_at: Date.now() + min * 60_000,
        timer_direction: 'countdown',
        timer_elapsed_mode: 'wallclock',
      })
      if (ok) setComposing(null)
      return
    }
    const text = composeText.trim()
    if (!text) {
      setComposing(null)
      return
    }
    const ok = await addCard('text', { title: '随手记', text })
    if (ok) {
      setComposeText('')
      setComposing(null)
    }
  }, [composing, composeMinutes, composeText, addCard, setComposing, setComposeText])

  /** 本地图片：只用 DOM FileReader 压 ≤480px 缩略图，不碰 asset://、不碰 shot-last。 */
  const onPickImage = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        })
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = () => reject(new Error('图片解码失败'))
          el.src = dataUrl
        })
        const scale = Math.min(1, 480 / Math.max(1, img.naturalWidth))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const seed = clMakeCard('image', { title: file.name, text: '本地图片' })
        const path = await clSavePreview(seed.id, canvas.toDataURL('image/png'))
        await addCard('image', { ...seed, src_path: path })
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err))
      }
    },
    [addCard, flash],
  )

  const cancelTimers = useCallback((d: DragSession) => {
    if (d.timer !== null) window.clearTimeout(d.timer)
    if (d.keepAlive !== null) window.clearInterval(d.keepAlive)
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
  }, [])

  /** 按幽灵卡中心算出插入位置；只用 DOM rect，不逐帧问 Rust。 */
  const computePreview = (d: DragSession): string[] => {
    const ghostCenterX = d.lastX - d.offsetX + 84 // 与 .cl-card 宽 168px 对齐
    const deck = deckRef.current
    let insertAt = 0
    if (deck) {
      deck.querySelectorAll<HTMLElement>('[data-cl-card-id]').forEach((el) => {
        if (el.dataset.clCardId === d.id) return
        const rect = el.getBoundingClientRect()
        if (ghostCenterX > rect.left + rect.width / 2) insertAt += 1
      })
    }
    const rest = cardsRef.current.map((c) => c.id).filter((id) => id !== d.id)
    insertAt = Math.min(insertAt, rest.length)
    rest.splice(insertAt, 0, d.id)
    d.preview = rest
    return rest
  }

  const activateDrag = () => {
    const d = dragRef.current
    if (!d || d.active) return
    d.active = true
    d.preview = cardsRef.current.map((c) => c.id)
    muteClicks() // 拖完吞掉误触（大图预览 / 编辑态）
    // 拖动期间强制整窗可点，900ms 续期一次（不是逐帧 IPC）；松手 / 取消即停。
    void clSetForceClickable(1500).catch(() => undefined)
    d.keepAlive = window.setInterval(() => {
      void clSetForceClickable(1500).catch(() => undefined)
    }, 900)
    const order = computePreview(d)
    setDragVisual({
      id: d.id,
      card: d.card,
      x: d.startX - d.offsetX,
      y: d.startY - d.offsetY,
      order,
      insertAt: order.indexOf(d.id),
    })
  }

  /** commit=false（Esc / pointercancel / Rust 拒绝）一律回滚，不删卡、不改内容。 */
  const finishDrag = useCallback((commit: boolean) => {
    const d = dragRef.current
    if (!d) return
    cancelTimers(d)
    dragRef.current = null
    setDragVisual(null)
    if (!commit || !d.preview) return
    const before = cardsRef.current.map((c) => c.id).join('|')
    if (d.preview.join('|') === before) return // 原地松手，零写盘
    void clReorderCards(d.preview)
      .then((pairs) => {
        const orderMap = new Map(pairs.map(([id, o]) => [id, o]))
        const byId = new Map(cardsRef.current.map((c) => [c.id, c]))
        const next: ClotheslineCard[] = []
        for (const id of d.preview ?? []) {
          const c = byId.get(id)
          if (c) next.push({ ...c, order: orderMap.get(id) ?? next.length * 1024 })
        }
        // 拖动期间若别的窗口新增了卡，追加到尾部，绝不丢卡（R79）。
        for (const c of cardsRef.current) if (!byId.has(c.id) || !d.preview?.includes(c.id)) next.push(c)
        setCards(next)
        setReorderFailed(false)
        lsLog(`排序已保存 ${pairs.length} 张卡`)
      })
      .catch((err) => {
        setReorderFailed(true)
        window.setTimeout(() => setReorderFailed(false), 2600)
        lsLog(`排序失败已回滚: ${String(err)}`)
      })
  }, [cancelTimers, setCards, setDragVisual, setReorderFailed])

  const onCardPointerDown = (e: React.PointerEvent, card: ClotheslineCard, mode: DragMode) => {
    if (e.button !== 0) return
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-cl-card-id]')
    if (!el) return
    const rect = el.getBoundingClientRect()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 捕获失败退化为普通事件，仍能拖 */
    }
    const effective: DragMode = e.altKey ? 'alt' : mode
    const d: DragSession = {
      id: card.id,
      card,
      mode: effective,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      timer: null,
      keepAlive: null,
      preview: null,
    }
    dragRef.current = d
    if (effective === 'alt') {
      activateDrag()
    } else {
      d.timer = window.setTimeout(activateDrag, effective === 'clip' ? 120 : 350)
    }
  }

  const onCardPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    d.lastX = e.clientX
    d.lastY = e.clientY
    if (!d.active) {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
      if (d.mode === 'clip' && moved >= 6) activateDrag()
      else if (d.mode === 'longpress' && moved >= 12) {
        // 长按未成型就大幅移动 = 用户想平移甲板，放弃本次拖拽。
        cancelTimers(d)
        dragRef.current = null
      }
      return
    }
    if (dragFrameRef.current !== null) return // 每帧最多一次 setState
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null
      const cur = dragRef.current
      if (!cur || !cur.active) return
      const order = computePreview(cur)
      setDragVisual({
        id: cur.id,
        card: cur.card,
        x: cur.lastX - cur.offsetX,
        y: cur.lastY - cur.offsetY,
        order,
        insertAt: order.indexOf(cur.id),
      })
    })
  }

  const onCardPointerUp = (e: React.PointerEvent, commit: boolean) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const wasActive = d.active
    // 拖出绳窗范围松手 = 取消，不写盘、不改序（PRD §5.17.3）。
    const outside =
      d.active &&
      (e.clientX < 8 ||
        e.clientY < 8 ||
        e.clientX > window.innerWidth - 8 ||
        e.clientY > window.innerHeight - 8)
    finishDrag(commit && wasActive && !outside)
    if (wasActive) {
      e.preventDefault()
      e.stopPropagation()
      muteClicks()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current?.active) {
        e.preventDefault()
        finishDrag(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finishDrag])

  // StrictMode 卸载 / 窗口销毁：只清定时器，不在卸载期 setState。
  useEffect(
    () => () => {
      const d = dragRef.current
      if (d) cancelTimers(d)
      dragRef.current = null
      if (clickMuteTimerRef.current !== null) window.clearTimeout(clickMuteTimerRef.current)
    },
    [cancelTimers],
  )

  /** 拖动预览期间按 order 临时换序渲染；pose 仍按 id 哈希，绝不重新随机。 */
  const displayCards = useMemo(() => {
    if (!dragVisual) return cards
    const byId = new Map(cards.map((c) => [c.id, c]))
    const next: ClotheslineCard[] = []
    for (const id of dragVisual.order) {
      const c = byId.get(id)
      if (c) next.push(c)
    }
    for (const c of cards) if (!dragVisual.order.includes(c.id)) next.push(c)
    return next
  }, [cards, dragVisual])

  // 稳定的卡片（按 id 哈希算姿态；渲染顺序就是恢复的顺序，禁止重排）。
  const posedCards = useMemo(
    () =>
      displayCards.map((c) => {
        void notesTick // 便利签数据变更后强制重算快照（localStorage 同源只读）
        const copy = cardCopy(c)
        return {
          card: c,
          pose: hashPose(c.id),
          broken: copy.missing,
          copy,
          thumb: previews[c.id] ?? null,
          timer: c.kind === 'timer' ? timerText(c, nowTick) : null,
          ratio: c.kind === 'timer' ? timerRatio(c, nowTick) : 0,
        }
      }),
    [displayCards, previews, nowTick, notesTick],
  )

  // 卡片增减 / 换屏后可能超出可平移上限，钳回尾部（只在此处写 state）。
  useEffect(() => {
    const max = maxScrollX()
    if (scrollXRef.current > max) {
      scrollXRef.current = max
      setScrollX(max)
    }
  }, [ready, posedCards.length, expanded, maxScrollX])

  // 卡片增减 / 横向平移 / 菜单弹出 / 编辑态切换后，等 DOM 布局稳定再重算一次命中矩形。
  // 只在这些离散事件触发，绝不逐帧 IPC（PRD §4.7）。
  useEffect(() => {
    if (!ready || !expanded) return
    const id = window.setTimeout(() => void refreshHitRects(), 80)
    return () => window.clearTimeout(id)
  }, [ready, expanded, cards, posedCards.length, scrollX, addSheetOpen, cardMenu, composing, dragRatio, refreshHitRects])

  if (!settings || !monitor) {
    return <div className="cl-root" ref={rootRef} data-cl-state="booting" data-theme={theme} />
  }

  const pullRatio = settings.pulltab_x_ratio
  const cardLimit = fullAccess ? 24 : 12
  return (
    <div
      ref={rootRef}
      className={`cl-root ${expanded ? 'is-expanded' : 'is-collapsed'} ${
        settings.wind_effect ? 'has-wind' : ''
      } ${restoring ? 'is-restoring' : ''} ${windPaused ? 'wind-paused' : ''}`}
      data-cl-state={ready ? 'ready' : 'placing'}
      data-theme={theme}
      data-runtime="tauri"
      onPointerEnter={() => {
        if (windPauseTimerRef.current !== null) window.clearTimeout(windPauseTimerRef.current)
        setWindPaused(true) // PRD §4.6：移入冻结在当前相位，不重置。
      }}
      onPointerLeave={() => {
        if (windPauseTimerRef.current !== null) window.clearTimeout(windPauseTimerRef.current)
        windPauseTimerRef.current = window.setTimeout(() => setWindPaused(false), 200)
      }}
      onClick={() => {
        if (cardMenu) setCardMenu(null)
        if (addSheetOpen) setAddSheetOpen(false)
      }}
    >
      {/* 麻绳：SVG 下垂曲线 + 麻纤维虚线 + 两端固定钉（原型 .rope-svg） */}
      <div className="cl-rope" aria-hidden="true">
        <svg className="cl-rope-svg" viewBox="0 0 1000 64" preserveAspectRatio="none">
          <path className="cl-rope-under" d="M4 28 Q500 48 996 28" />
          <path className="cl-rope-main" d="M4 26 Q500 46 996 26" />
          <path className="cl-rope-fiber" d="M4 25 Q500 45 996 25" />
        </svg>
        <span className="cl-rope-nail cl-rope-nail-l" />
        <span className="cl-rope-nail cl-rope-nail-r" />
      </div>

      {/* 长按绳子上下拖改 anchorY（顶部 40% 内，8px 吸附，松手一次写盘） */}
      {expanded ? (
        <div
          className="cl-rope-hotzone"
          onPointerDown={onRopePointerDown}
          onPointerMove={onRopePointerMove}
          onPointerUp={onRopePointerUp}
          onPointerCancel={onRopePointerUp}
          title="按住上下拖动调整晾衣绳高度（顶部 40% 内）"
        />
      ) : null}

      {/* 顶部工具条：卡片计数 / 清风 / 收起 */}
      <div className="cl-toolbar" data-cl-hit="1">
        <span className="cl-tool-count">{cards.length}/{cardLimit}</span>
        <button
          type="button"
          className={`cl-tool-btn ${settings.wind_effect ? 'is-on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            void clUpdateSettings({ wind_effect: !settings.wind_effect })
              .then((s) => setSettings(s))
              .catch(() => undefined)
          }}
          title="清风动效 · 鼠标移入自动暂停"
        >
          清风
        </button>
        <button
          type="button"
          className="cl-tool-btn cl-tool-collapse"
          onClick={(e) => {
            e.stopPropagation()
            void toggleExpanded()
          }}
          title="收起晾衣绳"
        >
          收起 ⌃
        </button>
      </div>

      {/* ＋ 菜单：小圆按钮 + 弹出面板，取代原型外的三张常驻新建方块 */}
      <button
        type="button"
        className="cl-add-btn"
        data-cl-hit="1"
        onClick={(e) => {
          e.stopPropagation()
          setAddSheetOpen((v) => !v)
        }}
        title="新增卡片"
      >
        ＋
      </button>
      <div
        className={`cl-add-sheet ${addSheetOpen ? 'is-open' : ''}`}
        data-cl-hit="1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="cl-sheet-head">挂一张到晾衣绳</span>
        <button type="button" onClick={() => { setComposing('text'); setAddSheetOpen(false) }}>
          ✎ 随手记 <em>Ctrl+Enter</em>
        </button>
        <button type="button" onClick={() => { setComposing('timer'); setAddSheetOpen(false) }}>
          ◷ 计时 / 番茄 <em>25 分</em>
        </button>
        <button type="button" onClick={() => { imageInputRef.current?.click(); setAddSheetOpen(false) }}>
          ▣ 本地图片 <em>PNG</em>
        </button>
        <div className="cl-sheet-sep" />
        <span className="cl-sheet-head">从现有工具挂上来</span>
        <button type="button" onClick={() => { flash('在便利签标题栏点「挂到晾衣绳」'); setAddSheetOpen(false) }}>
          ▤ 便利签 / 单条事项
        </button>
        <button type="button" onClick={() => { flash('在待办行右侧点晾衣绳图标'); setAddSheetOpen(false) }}>
          ☑ 待办
        </button>
        <button type="button" onClick={() => { flash('在剪贴板 / 贴图悬停操作里点晾衣绳图标'); setAddSheetOpen(false) }}>
          ⎘ 剪贴板 / 截图 / 贴图
        </button>
        <div className="cl-sheet-sep" />
        <button type="button" onClick={() => { void cycleMonitor(); setAddSheetOpen(false) }}>
          ▣ 显示屏幕 <em>{monitor?.name || '主屏'}</em>
        </button>
        <button type="button" onClick={() => { void toggleTopmost(); setAddSheetOpen(false) }}>
          ☝ 晾衣绳置顶 <em>{settings.always_on_top ? '开' : '关'}</em>
        </button>
      </div>

      <button
        type="button"
        className="cl-handle"
        style={{ left: `calc(${(dragRatio ?? pullRatio) * 100}% - 22px)` }}
        onPointerDown={() => void clSetForceClickable(1200)}
        onClick={() => void toggleExpanded()}
        onContextMenu={(e) => {
          e.preventDefault() // 置顶唯一同源入口：把手右键（＋菜单第 7 行为主入口）
          void toggleTopmost()
        }}
        title={expanded ? '收起晾衣绳 · 右键切置顶' : '展开晾衣绳 · 右键切置顶'}
      >
        <span className="cl-clip" />
        <span className="cl-handle-label">{expanded ? '收起' : '展开'}</span>
      </button>

      {!expanded ? (
        <button
          type="button"
          className="cl-pulltab"
          style={{ left: `calc(${(dragRatio ?? pullRatio) * 100}% - 15px)` }}
          onPointerDown={onPullPointerDown}
          onPointerMove={onPullPointerMove}
          onPointerUp={onPullPointerUp}
          onPointerCancel={onPullPointerUp}
          onClick={(e) => {
            e.stopPropagation()
            // 拖动结束时 click 仍会到：吞掉，避免「想拖结果把绳展开」。
            if (pullMovedRef.current) {
              pullMovedRef.current = false
              return
            }
            void toggleExpanded()
          }}
          title="下拉展开 · 左右拖动可移动拉杆"
        >
          <span className="cl-pull-cord" />
          <span className="cl-pull-tab">
            <span className="cl-pull-grip" />
            <span className="cl-pull-foot">⌄</span>
          </span>
          <span className="cl-pull-badge">{cards.length} 张卡 · 点击展开</span>
        </button>
      ) : null}

      {/* 展开态卡片区：按 order 确定性还原；引用失效只占位，绝不删卡 / 前移槽位。
          阶段 2 只做只读呈现，拖动排序在阶段 3、卡片内容桥接在阶段 4。 */}
      {expanded ? (
        <div
          ref={deckRef}
          className="cl-deck"
          style={{ transform: `translateX(${-scrollX}px)` }}
          onWheel={onDeckWheel}
          onClickCapture={(e) => {
            if (clickSuppressed()) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
        >
          {posedCards.length === 0 ? (
            <div className="cl-deck-empty">
              <span className="cl-deck-hint">晾衣绳已就绪</span>
              <span className="cl-deck-sub">
                从便利签 / 截图 / 剪贴板挂一张卡片上来 · 右键木夹可切置顶
              </span>
            </div>
          ) : (
            posedCards.map(({ card, pose, broken, copy, thumb, timer, ratio }, index) => (
              <div
                key={card.id}
                data-cl-card-id={card.id}
                className={`cl-card cl-card-${card.kind} ${broken ? 'is-broken' : ''} ${
                  card.pinned ? 'is-pinned' : ''
                } ${dragVisual?.id === card.id ? 'is-dragging' : ''} ${
                  dragVisual && dragVisual.insertAt === index ? 'is-drop-target' : ''
                }`}
                style={{ '--cl-rot': `${pose.tilt}deg` } as CSSProperties}
                title="长按 / Alt+拖排序 · 双击编辑 · 右键更多"
                onPointerDown={(e) => onCardPointerDown(e, card, 'longpress')}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e) => onCardPointerUp(e, true)}
                onPointerCancel={(e) => onCardPointerUp(e, false)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (clickSuppressed()) return
                  if (card.kind === 'note' && card.note_id && card.attach_to?.startsWith('item:')) {
                    const itemId = card.attach_to.slice(5)
                    const item = readNoteLite(card.note_id)?.items?.find((it) => it.id === itemId)
                    setEditing({ id: card.id, value: item?.text ?? card.text })
                    return
                  }
                  if (broken) return
                  setEditing({ id: card.id, value: card.text })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCardMenu({ id: card.id, x: e.clientX, y: e.clientY })
                }}
              >
                <span
                  className="cl-card-clip"
                  role="button"
                  aria-label="拖动排序"
                  title="拖动排序 · Alt+拖可立即开始"
                  style={{ animationDelay: `${pose.windPhase}s` }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    onCardPointerDown(e, card, 'clip')
                  }}
                  onPointerMove={onCardPointerMove}
                  onPointerUp={(e) => onCardPointerUp(e, true)}
                  onPointerCancel={(e) => onCardPointerUp(e, false)}
                />
                {/* 悬停浮出的操作按钮：与右键菜单同源，绝不另起一套写入路径 */}
                <div className="cl-card-actions" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    title="置顶 / 取消置顶"
                    onClick={(e) => { e.stopPropagation(); void togglePin(card) }}
                  >
                    ☝
                  </button>
                  <button
                    type="button"
                    title="编辑文字"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (broken) {
                        flash('原内容已删除，可直接取下这张卡')
                      } else if (card.kind === 'note' && card.note_id && card.attach_to?.startsWith('item:')) {
                        const itemId = card.attach_to.slice(5)
                        const item = readNoteLite(card.note_id)?.items?.find((it) => it.id === itemId)
                        setEditing({ id: card.id, value: item?.text ?? card.text })
                      } else {
                        setEditing({ id: card.id, value: card.text })
                      }
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    title="取下这张卡"
                    onClick={(e) => { e.stopPropagation(); void takeDown(card) }}
                  >
                    ×
                  </button>
                </div>
                {broken ? (
                  <div className="cl-card-placeholder">
                    <span className="cl-ph-icon">⌁</span>
                    <span className="cl-ph-title">{copy.title}</span>
                    <span className="cl-ph-sub">卡片已保留在原位 · 右键可取下一张</span>
                  </div>
                ) : editing?.id === card.id ? (
                  <div className="cl-card-edit" onPointerDown={(e) => e.stopPropagation()}>
                    <textarea
                      autoFocus
                      value={editing.value}
                      onChange={(e) => setEditing({ id: card.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditing(null)
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          void commitEdit(card.id, editing.value)
                        }
                      }}
                      placeholder="写点什么…"
                    />
                    <div className="cl-edit-actions">
                      <button type="button" onClick={() => void commitEdit(card.id, editing.value)}>保存</button>
                      <button type="button" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <CardFace
                    card={card}
                    copy={copy}
                    thumb={thumb}
                    timer={timer}
                    ratio={ratio}
                    windPhase={pose.windPhase}
                    onTimerAction={(action) => void timerAction(card, action)}
                  />
                )}
              </div>
            ))
          )}
          {composing ? (
            <div className="cl-composer" data-cl-hit="1" onPointerDown={(e) => e.stopPropagation()}>
              <span className="cl-card-kind">
                {composing === 'timer' ? '计时卡' : '随手记'}
              </span>
              {composing === 'timer' ? (
                <label className="cl-minutes">
                  <input
                    autoFocus
                    type="number"
                    min={1}
                    max={720}
                    value={composeMinutes}
                    onChange={(e) => setComposeMinutes(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setComposing(null)
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void submitCompose()
                      }
                    }}
                  />
                  <span>分钟</span>
                </label>
              ) : (
                <textarea
                  autoFocus
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setComposing(null)
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void submitCompose()
                    }
                  }}
                  placeholder="写张小纸条，Ctrl+Enter 挂上去"
                />
              )}
              <div className="cl-edit-actions">
                <button type="button" onClick={() => void submitCompose()}>挂上</button>
                <button type="button" onClick={() => setComposing(null)}>取消</button>
              </div>
            </div>
          ) : (
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void onPickImage(e)}
            />
          )}
        </div>
      ) : null}

      {/* 卡片右键菜单：固定定位，点空白即关；所有写操作走 Rust 单一写锁 */}
      {cardMenu ? (
        <div
          className="cl-card-menu"
          data-cl-hit="1"
          style={{ left: Math.min(cardMenu.x, window.innerWidth - 168), top: Math.min(cardMenu.y, window.innerHeight - 190) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const c = cards.find((x) => x.id === cardMenu.id)
            if (!c) return null
            return (
              <>
                <button type="button" onClick={() => void togglePin(c)}>
                  {c.pinned ? '取消置顶' : '置顶这张'}
                </button>
                <button type="button" onClick={() => void openSource(c)}>打开原内容</button>
                <button
                  type="button"
                  onClick={() => {
                    setCardMenu(null)
                    if (refBroken(c) || cardCopy(c).missing) flash('原内容已删除，可直接取下这张卡')
                    else setEditing({ id: c.id, value: c.text })
                  }}
                >
                  编辑文字
                </button>
                <button type="button" className="is-danger" onClick={() => void takeDown(c)}>取下</button>
              </>
            )
          })()}
        </div>
      ) : null}

      {/* 拖拽幽灵卡：fixed 合成层，0 IPC 跟手 */}
      {dragVisual ? (
        <div
          className="cl-ghost"
          style={{ left: dragVisual.x, top: dragVisual.y }}
          aria-hidden="true"
        >
          <span className="cl-ghost-clip" />
          <span className="cl-card-kind">
            {dragVisual.card.kind === 'note' ? '便利签'
              : dragVisual.card.kind === 'shot' ? '截图'
              : dragVisual.card.kind === 'timer' ? '计时'
              : dragVisual.card.kind === 'clipboard' ? '剪贴板'
              : dragVisual.card.kind === 'image' ? '图片'
              : dragVisual.card.kind === 'pin' ? '贴图'
              : dragVisual.card.kind === 'task' ? '待办' : '文字'}
          </span>
          <span className="cl-card-text">
            {dragVisual.card.title || dragVisual.card.text || '（无标题）'}
          </span>
        </div>
      ) : null}

      {/* 恢复提示 / 排序失败提示：仅一次，不阻断 */}
      {((monitorFallback || recoveredFromBackup) && !restoring) || reorderFailed ? (
        <div className="cl-toast" role="status">
          {reorderFailed ? '卡片集合已变化，排序已取消 · ' : ''}
          {recoveredFromBackup ? '已从备份恢复卡片 · ' : ''}
          {monitorFallback ? '原屏幕已断开，晾衣绳已移到当前屏幕' : ''}
        </div>
      ) : null}
      {undoCard ? (
        <div className="cl-toast cl-toast-action" role="status">
          {undoCard.label}
          <button type="button" onClick={() => void undoTakeDown()}>撤销</button>
          <span className="cl-toast-limit">{fullAccess ? '' : ' · 免费最多 12 张'}</span>
        </div>
      ) : null}
      {hint ? <div className="cl-toast cl-toast-hint" role="status">{hint}</div> : null}
    </div>
  )
}
