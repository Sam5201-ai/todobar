import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Copy, ListTodo, X } from 'lucide-react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import {
  clGetRestoreState,
  clSaveSession,
  clGetMonitors,
  clApplyBoundsAndShow,
  clSetBounds,
  clSetPosition,
  clSetHitRects,
  clSetForceClickable,
  clSetDismissOnOutside,
  clGetSettings,
  clUpdateSettings,
  clSetAlwaysOnTop,
  clReorderCards,
  clAddCard,
  clUpdateCard,
  clRemoveCard,
  clRestoreCard,
  clArchiveCard,
  clDeleteArchived,
  clReadPreview,
  clSavePreview,
  clSaveOriginal,
  clReadOriginal,
  clMakeCard,
  CL_CARDS_CHANGED,
  CL_ORDER_CHANGED,
  CL_CARD_DROPPED,
  CL_OPEN_NOTE,
  CL_OPEN_TASK,
  CL_OPEN_SETTINGS,
  CL_OPEN_ARCHIVE,
  CL_ARCHIVE_CARD,
  CL_ARCHIVE_LANDED,
  type ClArchiveLanded,
  CL_CREATE_NOTE,
  CL_EDIT_NOTE_ITEM,
  CL_SETTINGS_CHANGED,
  CL_TOAST,
  CL_DISMISS_OVERLAY,
  CL_NOTE_ITEM_ACTION,
  CL_DROP_NOTE_WINDOW,
  CL_NOTE_HUNG,
  CL_NOTE_COLOR_ACTION,
  CL_RECORDER_CMD,
  CL_RECORDER_STATE,
  type ClNoteItemAction,
  type ClDropNoteWindow,
  type ClArchiveCard,
  type ClRecorderState,
  type ClToastPayload,
  type ClotheslineSettings,
  type ClotheslineCard,
  type MonitorInfo,
  type SessionState,
  type HitRect,
  type CardPatch,
} from './bridge'
import type { RecorderStatus } from '../recorder'
import { copyText } from '../clipboard'
import { useAccount } from '../membership'
import { addCategory, loadCategories, loadLastCategory, removeCategory, saveLastCategory } from '../quickNote/categories'
import { RichText, RICH_PREFIX, hasRichMarkup, isRichText, richToPlain, sanitizeRichHtml } from '../utils/richtext'
import { t, useI18n } from '../i18n'
import './clothesline.css'
// ★2026-11-24 问题3：随手记新建/编辑弹窗复用全局速记窗的 qn 系样式（标题输入/工具行/正文/分类），
// 视觉与交互以全局速记的随手记弹窗为准（仅按钮文案不同）。
import '../quickNote/quick-note.css'

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
    lsLog(`render crashed (kept transparent): ${error.message}`)
  }
  render() {
    // 失败只留透明节点，窗口继续存在但不可见——绝不打断桌面其它功能。
    return this.state.failed ? <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} /> : this.props.children
  }
}

/** 与 Rust geometry_signature 逐字一致：工作区宽x高@缩放。签名未变则锚点原样。 */
const geoSignature = (mon: MonitorInfo) =>
  `${mon.width}x${mon.height}@${mon.scale_factor}`

/** OS 窗口矩形（屏幕绝对物理像素）。★第二十一轮绳带窄窗：窗口本体 = 内容矩形，
 *  展开态 = 顶部整宽横带、收起态 = 拉杆处 180×96 小窗、预览 = 临时整屏。 */
type ClRect = { x: number; y: number; width: number; height: number }

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

/** ★2026-11-17 需求1：番茄卡样式的可选键。
 *  paper=经典（旧 minimal/glass 继续按经典视觉渲染，弹窗编辑时归入经典）；
 *  watch=黄铜怀表 / ticket=站台车票 / lcd=像素掌机 / can=番茄罐头 /
 *  board=咖啡小黑板 / marquee=剧场灯牌 —— 与 preview/clothesline-timer-card-designs.html 对应。
 *  ★2026-11-23 异形卡 4 选：tomato=番茄 / pocket=口袋怀表 / hourglass=沙漏 / moon=月相 ——
 *  与 preview/timer-shape-final-reference.html 定稿逐笔一致（SVG 异形卡面）。 */
const TIMER_STYLE_KEYS = [
  'paper', 'watch', 'ticket', 'lcd', 'can', 'board', 'marquee',
  'tomato', 'pocket', 'hourglass', 'moon',
] as const
type TimerStyleKey = (typeof TIMER_STYLE_KEYS)[number]

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
type NoteLite = {
  id: string
  items?: Array<{ id: string; text: string; done: boolean }>
  colorKey?: string
}
const NOTES_LS_KEY = 'ticktask.notes.v1'
/** 与 notes/store.ts::NOTE_COLORS 同步的只读色板（绝不 import store 的写入模块）。
 *  ⚠️ 一律用不带 alpha 的实色 hex：透明置顶窗里 rgba 背景会被合成层算成半透明。
 *  颜色名是用户可见文案，渲染期经 t() 取词（模块级常量会在启动时冻结语言）。 */
const clNotePalette = () => [
  { key: 'yellow', label: t('clothesline.color.lemon'), bg: '#fdd86e', fg: '#4a3710' },
  { key: 'pink', label: t('clothesline.color.sakura'), bg: '#fcbac8', fg: '#5c2131' },
  { key: 'blue', label: t('clothesline.color.sky'), bg: '#a8d6fa', fg: '#123a55' },
  { key: 'green', label: t('clothesline.color.mint'), bg: '#afe8c7', fg: '#12462f' },
  { key: 'purple', label: t('clothesline.color.lavender'), bg: '#d4bef5', fg: '#3a2352' },
  { key: 'gray', label: t('clothesline.color.graphite'), bg: '#ced4da', fg: '#2c3033' },
] as const
/** ★2026-11-15 需求5/6：随手记 / 番茄钟弹窗的自定义卡色（bg=null = 沿用类型默认纸色）。
 *  全部为不透明浅色（透明置顶窗铁律：卡片绝不引入 alpha 背景）。
 *  颜色名是用户可见文案，渲染期经 t() 取词（模块级常量会在启动时冻结语言）。 */
const clCardPalette = () => [
  { key: '', label: t('clothesline.color.default'), bg: null },
  { key: 'yellow', label: t('clothesline.color.wheat'), bg: '#fff8e6' },
  { key: 'pink', label: t('clothesline.color.petal'), bg: '#fdeef1' },
  { key: 'blue', label: t('clothesline.color.mist'), bg: '#eef3fb' },
  { key: 'green', label: t('clothesline.color.moss'), bg: '#eef7ee' },
  { key: 'peach', label: t('clothesline.color.peach'), bg: '#fdf3ef' },
  { key: 'purple', label: t('clothesline.color.vine'), bg: '#f3effb' },
  { key: 'gray', label: t('clothesline.color.graphite'), bg: '#ced4da' },
] as const
const MAX_NOTE_ITEMS_ON_ROPE = 30
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

/** ★2026-11-23 需求：番茄计时弹窗样式选项表（后 7 种 = 会员专属）。
 *  受限用户（非会员且试用过期未激活）：点击不选中并 toast 提示；showVip 时右上角挂 VIP 角标。 */
const TIMER_STYLE_OPTS: { key: TimerStyleKey; label: Parameters<typeof t>[0]; vipOnly?: boolean }[] = [
  { key: 'paper', label: 'clothesline.compose.stylePaper' },
  { key: 'watch', label: 'clothesline.compose.styleWatch' },
  { key: 'ticket', label: 'clothesline.compose.styleTicket' },
  { key: 'lcd', label: 'clothesline.compose.styleLcd', vipOnly: true },
  { key: 'can', label: 'clothesline.compose.styleCan' },
  { key: 'board', label: 'clothesline.compose.styleBoard', vipOnly: true },
  { key: 'marquee', label: 'clothesline.compose.styleMarquee', vipOnly: true },
  { key: 'tomato', label: 'clothesline.compose.styleTomato', vipOnly: true },
  { key: 'pocket', label: 'clothesline.compose.stylePocket', vipOnly: true },
  { key: 'hourglass', label: 'clothesline.compose.styleHourglass', vipOnly: true },
  { key: 'moon', label: 'clothesline.compose.styleMoon', vipOnly: true },
]

/** ★2026-11-24 问题3/4：随手记弹窗（绳窗新建/编辑）复用全局速记窗的富文本工具行
 *  （B/I/U/S/字体颜色，execCommand）。与速记窗一致：onMouseDown preventDefault 保住
 *  编辑器选区，命令才能作用在已选中文字上。 */
function QnToolbarRow({ onFmt }: { onFmt: (cmd: string, value?: string) => void }) {
  return (
    <div className="qn-toolbar">
      <button type="button" className="qn-fmt" aria-label={t('quickNote.bold')} onMouseDown={(e) => e.preventDefault()} onClick={() => onFmt('bold')}>
        <b>B</b>
      </button>
      <button type="button" className="qn-fmt" aria-label={t('quickNote.italic')} onMouseDown={(e) => e.preventDefault()} onClick={() => onFmt('italic')}>
        <i>I</i>
      </button>
      <button type="button" className="qn-fmt" aria-label={t('quickNote.underline')} onMouseDown={(e) => e.preventDefault()} onClick={() => onFmt('underline')}>
        <u>U</u>
      </button>
      <button type="button" className="qn-fmt" aria-label={t('quickNote.strike')} onMouseDown={(e) => e.preventDefault()} onClick={() => onFmt('strikeThrough')}>
        <s>S</s>
      </button>
      <input
        type="color"
        className="qn-color"
        aria-label={t('quickNote.color')}
        defaultValue="#2c2c2a"
        onChange={(e) => onFmt('foreColor', e.target.value)}
      />
    </div>
  )
}

function cardCopy(card: ClotheslineCard): { title: string; text: string; missing: boolean } {
  if (refBroken(card)) {
    return { title: t('clothesline.card.refDeletedTitle'), text: t('clothesline.card.refDeletedText'), missing: true }
  }
  if (card.kind === 'note') {
    const note = readNoteLite(card.note_id)
    if (!note) return { title: t('clothesline.card.refDeletedTitle'), text: t('clothesline.card.refDeletedText'), missing: true }
    const items = note.items ?? []
    const itemId = card.attach_to?.startsWith('item:') ? card.attach_to.slice(5) : null
    if (itemId) {
      const item = items.find((it) => it.id === itemId)
      if (!item) return { title: t('clothesline.card.itemDeleted'), text: t('clothesline.card.refDeletedText'), missing: true }
      return { title: t('clothesline.card.noteSingle'), text: `${item.done ? '✓ ' : '· '}${item.text}`, missing: false }
    }
    return {
      title: t('clothesline.card.note'),
      text: items.length ? items.map((it) => `${it.done ? '✓ ' : '· '}${it.text}`).join('\n') : t('clothesline.card.noteEmpty'),
      missing: false,
    }
  }
  const title = card.title || (
    card.kind === 'timer' ? t('clothesline.card.kindTimer')
      : card.kind === 'clipboard' ? t('clothesline.card.kindClipboard')
      : card.kind === 'audio' ? t('clothesline.card.kindAudio')
      : card.kind === 'task' ? t('clothesline.card.kindTask') : ''
  )
  // ★2026-11-15 反馈3：截图 / 贴图 / 图片卡不再显示固定标题「截图」「贴图」，
  //   只呈现用户编写的内容（card.text）；没有就什么都不渲染。
  //   ★反馈批3：用户要求恢复默认标题「截图 / 贴图 / 图片」（卡片下方显得太空）——
  //   用户自定义过的标题原样保留，没有标题时回落到类型默认值。
  //   「W×H」尺寸文案仍从源头不再写入、渲染期剥离存量。
  if (card.kind === 'shot' || card.kind === 'pin' || card.kind === 'image') {
    const legacyText = /^\d+×\d+$/.test(card.text) ? '' : card.text
    // ★2026-11-23 需求2：截图/贴图/图片卡不再回落默认标题「截图/贴图/图片」——
    //   只有用户编辑时写入的 title/text 才上卡（此前曾按反馈恢复过默认标题，本次按
    //   用户最新要求再次去掉）。存量卡里已写入数据的默认标题如何剥离：
    //   title 若等于类型默认词也视为空（避免老卡一直顶着「截图」）。
    const stockTitle = title === t('clothesline.card.kindShot') || title === t('clothesline.card.kindPin') || title === t('clothesline.card.kindImage') ? '' : title
    return { title: stockTitle, text: legacyText, missing: false }
  }
  return { title, text: card.text, missing: false }
}

/** 仅用于 toast / 菜单文案的类型名（不进入卡片画面）。
 *  渲染期经 t() 取词，组件随 locale 变化重渲染时取到当前语言。 */
function kindLabel(card: ClotheslineCard): string {
  return card.kind === 'shot' ? t('clothesline.card.kindShot')
    : card.kind === 'timer' ? t('clothesline.card.kindTimer')
    : card.kind === 'clipboard' ? t('clothesline.card.kindClipboard')
    : card.kind === 'image' ? t('clothesline.card.kindImage')
    : card.kind === 'pin' ? t('clothesline.card.kindPin')
    : card.kind === 'task' ? t('clothesline.card.kindTask')
    : card.kind === 'audio' ? t('clothesline.card.kindAudio')
    : card.kind === 'note' ? t('clothesline.card.note') : t('clothesline.card.kindText')
}

/** 计时卡时间正文（纯 mm:ss / h:mm:ss，不含「剩余 / 已计」前缀 —— 圆环中心直接展示）。
 *  ★2026-11-15 需求6 修复：旧版暂停（end_at=null）与结束时 remain=0 → 返回「时间到」，
 *  而圆环中心把状态词 strip 掉后只剩空串 → 「圆环内显示为空」。现在暂停显示
 *  冻结的剩余时长，正计时显示已计时长，结束显示 00:00，永远不为空。 */
function fmtTimerBody(ms: number): string {
  const abs = Math.max(0, ms)
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const s = Math.floor((abs % 60_000) / 1000)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 随手记（信件样式）卡片的落款时间：YYYY-MM-DD HH:mm（本地时区）。 */
function fmtCardDate(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 字号调节档位（便利签 / 随手记卡共用）。null 视为 1。 */
const FONT_SCALES = [1, 0.85, 0.72, 1.15] as const

/** ★批12 随手记字体格式（新建/编辑弹窗可调）：标题/内容独立字号 + 字体族 + 加粗/倾斜。
 *  落盘为 ClotheslineCard 的 7 个可选字段；null/缺省 = 默认。 */
type TextFormat = {
  titleSize: number | null // 标题字号 px（null=默认 12.5，恒不受字号档位影响）
  bodySize: number | null // 正文字号基准 px（null=默认 10，渲染仍乘字号档位）
  family: string // 自定义字体族（''=默认 Segoe UI）
  titleBold: boolean // 标题加粗（默认 true）
  titleItalic: boolean
  bodyBold: boolean
  bodyItalic: boolean
}
const TEXT_FMT_DEFAULT: TextFormat = {
  titleSize: null,
  bodySize: null,
  family: '',
  titleBold: true,
  titleItalic: false,
  bodyBold: false,
  bodyItalic: false,
}
/** 从既有卡读回格式状态（编辑弹窗预填）。 */
const cardTextFormat = (card: ClotheslineCard): TextFormat => ({
  titleSize: card.title_size ?? null,
  bodySize: card.body_size ?? null,
  family: card.font_family ?? '',
  titleBold: card.title_bold !== false,
  titleItalic: !!card.title_italic,
  bodyBold: !!card.body_bold,
  bodyItalic: !!card.body_italic,
})

/** 计时卡：结束时间写盘，重启后续算而非重开（wallclock）。 */
function timerText(card: ClotheslineCard, now: number): string {
  if (card.end_at == null) return fmtTimerBody(card.elapsed_before_pause_ms || 0)
  if (card.timer_direction === 'countup') return fmtTimerBody(Math.max(0, now - card.created_at))
  return fmtTimerBody(card.end_at - now)
}

/** 番茄圆环进度：总时长由 created_at→end_at 推出，绝不 render 期读 Date.now()。
 *  暂停中（end_at=null）按「冻结的剩余时长 / 总时长」静止显示，圆环不再清零。 */
function timerRatio(card: ClotheslineCard, now: number): number {
  const end = card.end_at ?? now
  const total = Math.max(1, end - card.created_at)
  if (card.end_at == null) {
    return Math.min(1, Math.max(0, (card.elapsed_before_pause_ms || 0) / total))
  }
  if (card.timer_direction === 'countup') {
    return Math.min(1, Math.max(0, (now - card.created_at) / total))
  }
  return Math.min(1, Math.max(0, (end - now) / total))
}

type TimerAction = 'pause' | 'resume' | 'reset' | 'plus5'
type AudioAction = 'pause' | 'resume' | 'reset' | 'save'
/** 录音卡静态声波条高度（px）。纯装饰、纯静态 —— 绳窗铁律禁 CSS animation。 */
const AU_WAVE = [6, 14, 20, 10, 16, 8, 18, 12, 6, 14, 9, 15]
/** 绳卡关联的录音引擎状态（主窗 5Hz 广播；null = 与本卡无关/未开始）。 */
type AudioLive = { status: RecorderStatus; elapsedMs: number } | null
type CardFaceProps = {
  card: ClotheslineCard
  copy: { title: string; text: string; missing: boolean }
  thumb: string | null
  timer: string | null
  ratio: number
  onTimerAction: (action: TimerAction) => void
  /** 一键录音卡：控制命令发回主窗执行（绳窗不碰录音引擎）。 */
  audio: AudioLive
  onAudioAction: (card: ClotheslineCard, action: AudioAction) => void
  /** 卡上标题改名（写 card.title；保存时主窗按它重命名落盘文件）。 */
  onRenameAudio: (card: ClotheslineCard, title: string) => void
  /** 问题8：点图片区打开大图预览浮层（仅截图 / 贴图 / 本地图片卡）。 */
  onPreview: (card: ClotheslineCard) => void
  /** ★2026-11-19 反馈5：长按图片拖出功能已整体移除（易与点击预览误触），点击直接开预览。
   *  ★2026-11-19 右键图片区：复制图片到系统剪贴板。 */
  onPhotoCopy: (card: ClotheslineCard) => void
  /** ⑥ 便利签条目操作（发事件给主窗 store 代写，绳窗绝不自己写）。 */
  onNoteAction: (p: ClNoteItemAction) => void
  /** 达到 30 条上限等提示，复用主组件的 toast。 */
  onToast: (msg: string) => void
}

/**
 * 原型多态卡片（clothesline-preview.html §各类卡片）：便利签勾选清单 / 待办行 /
 * 番茄圆环 + 控制 / 大图 caption+meta / 楷体便签 / 等宽剪贴板。
 * ⚠️ 这里只做呈现，所有写操作仍由主组件走 clUpdateCard / clRemoveCard，单一写锁不变。
 */
function CardFace({ card, copy, thumb, timer, ratio, audio, onAudioAction, onRenameAudio, onTimerAction, onPreview, onPhotoCopy, onNoteAction, onToast }: CardFaceProps) {
  // ★清风相位已移到卡片外层 .cl-card-sway 的稳定 CSS 变量，内容层不再挂动画、
  //   也不再有任何 inline animationDelay（根因A：否则每次重渲染都会重启动画 → 抖动）。
  const pinMark = card.pinned ? t('clothesline.card.pinnedMark') : ''
  // ★⑥ 便利签内联编辑：Tauri wry / WebView2 **未实现 JS dialog**，window.prompt 在透明
  //   置顶绳窗里根本不会弹出（直接返回 null / 抛错），旧版「＋加一条 / 双击编辑」点了
  //   毫无反应，正是用户所说「挂上去后的便利签与现有便利签功能完全不一致」的直接原因。
  //   改为卡片内固定的一行 input + 确定 / 取消，编辑条与工具条等高，绝不改变卡片
  //   布局高度（否则进入编辑时整卡会抖一下 —— 用户第 5 条反馈）。
  const [noteEdit, setNoteEdit] = useState<{ mode: 'add' | 'edit'; itemId?: string; value: string } | null>(null)
  // ★一键录音：卡上标题行内编辑（null=非编辑态）。录音卡状态 5Hz 刷新，
  //   输入框是受控组件，重渲染不影响正在输入的内容。
  const [audioTitleEdit, setAudioTitleEdit] = useState<string | null>(null)
  // ★2026-11-23 需求1：图片卡比例钳制（竖图 3:4 / 横图 4:3）。img onLoad 读
  //   naturalWidth/Height 求原始宽高比并钳制后落 state（hook 必须在组件顶层），
  //   .cl-photo 以 inline aspect-ratio 定形；加载完成前回落自然比例。
  const [imgRatio, setImgRatio] = useState(0)

  if (card.kind === 'timer') {
    const frozen = card.end_at == null
    // 结束判定：由 ratio 推出（不读 Date.now()）。倒计时 ratio≤0 / 正计时 ratio≥1。
    const ended = !frozen && (card.timer_direction === 'countup' ? ratio >= 1 : ratio <= 0)
    // ★2026-11-17 需求1：番茄卡 7 款样式（经典 paper/minimal/glass + 怀表/车票/掌机/罐头/小黑板/灯牌）。
    // 新 6 款与设计稿 preview/clothesline-timer-card-designs.html 一一对应；
    // 按钮文案统一为 暂停/重置/+5 分（需求2：小重置→重置）；脚注不再提「右键更多」（需求3）。
    const tstyle = card.card_style ?? 'paper'
    const isClassic = tstyle === 'paper' || tstyle === 'minimal' || tstyle === 'glass'
    // 计时进度 p∈[0,1]：正计时=已计比例，倒计时=已耗比例（ratio 是剩余比例）。
    const progress = Math.min(1, Math.max(0, card.timer_direction === 'countup' ? ratio : 1 - ratio))
    const remain = 1 - progress
    const statusText = frozen ? t('clothesline.card.statusPaused') : ended ? t('clothesline.card.statusDone') : t('clothesline.card.statusRunning')
    const dirText = card.timer_direction === 'countup' ? t('clothesline.card.dirCountup') : t('clothesline.card.dirCountdown')
    const timeCls = ended || card.fired_at ? 'is-fired' : ''
    const pinMark = card.pinned ? t('clothesline.card.pinnedMark') : ''
    const timerBtns = (
      <div className="cl-tm-btns" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => onTimerAction(frozen ? 'resume' : 'pause')}>
          {frozen ? t('clothesline.card.resume') : t('clothesline.card.pause')}
        </button>
        <button type="button" onClick={() => onTimerAction('reset')}>{t('clothesline.card.reset')}</button>
        <button type="button" onClick={() => onTimerAction('plus5')}>{t('clothesline.card.plus5')}</button>
      </div>
    )
    // ★2026-11-23 异形计时卡公共件：悬停浮现的玻璃操作钮（❚❚/▶ ↺ +5′）+ 形内文案。
    // shapeTitle 截断 8 字防溢出形内胶囊；shapeSub 运行中显示方向、暂停/结束显示状态。
    const shapeTitle = copy.title.length > 8 ? `${copy.title.slice(0, 8)}…` : copy.title
    const shapeSub = frozen || ended ? statusText : dirText
    const shapeLong = !!timer && timer.split(':').length > 2
    const shapeDone = ended ? ' is-done' : ''
    const shapePaused = frozen ? ' is-paused' : ''
    const shapeBtns = (
      <div className="cl-shape-btns" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          data-tip={frozen ? t('clothesline.card.resume') : t('clothesline.card.pause')}
          aria-label={frozen ? t('clothesline.card.resume') : t('clothesline.card.pause')}
          onClick={() => onTimerAction(frozen ? 'resume' : 'pause')}
        >
          {frozen ? '▶' : '❚❚'}
        </button>
        <button type="button" data-tip={t('clothesline.card.reset')} aria-label={t('clothesline.card.reset')} onClick={() => onTimerAction('reset')}>↺</button>
        <button type="button" data-tip={t('clothesline.card.plus5')} aria-label={t('clothesline.card.plus5')} onClick={() => onTimerAction('plus5')}>+5′</button>
      </div>
    )
    if (isClassic) {
      return (
        <div className="cl-face">
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
            {/* ★2026-11-15 需求6：圆环中心永远有内容 —— timerText 已改为纯时间正文
                （暂停=冻结剩余、正计时=已计、结束=00:00），不再被状态词 strip 成空串。 */}
            <span className={`cl-tm-time ${timeCls}`}>
              {timer ?? '--:--'}
            </span>
          </div>
          {timerBtns}
          <span className="cl-tm-foot">
            {frozen ? t('clothesline.card.footPaused') : ended ? t('clothesline.card.footDone') : ''}
            {dirText}
            {pinMark}
          </span>
        </div>
      )
    }
    if (tstyle === 'watch') {
      // A 黄铜怀表：燕尾铜牌 + 双层表圈表盘（刻度环 dasharray）+ 表冠钮
      return (
        <div className="cl-face">
          <span className="cl-tw-plaque">{copy.title}{pinMark}</span>
          <div className="cl-tm-ring is-watch">
            <svg className="cl-tm-svg" viewBox="0 0 96 96" aria-hidden="true">
              <circle className="cl-tw-bezel" cx="48" cy="48" r="44" />
              <circle className="cl-tw-bezel2" cx="48" cy="48" r="39.5" />
              <circle className="cl-tw-ticks" cx="48" cy="48" r="42.5" />
              <circle
                className="cl-tw-prog"
                cx="48"
                cy="48"
                r="33"
                style={{ strokeDashoffset: 207.3 * (1 - ratio) }}
              />
            </svg>
            {/* ★问题3：h:mm:ss（7 字符）比设计稿的 mm:ss 宽 40%，21/19px 会压到
                进度弧 —— 带小时时切小字号（真实怀表的紧凑表盘数字样式）。 */}
            <span className={`cl-tw-time ${timeCls}${timer && timer.split(':').length > 2 ? ' is-long' : ''}`}>
              {timer ?? '--:--'}
            </span>
          </div>
          <span className="cl-tw-sub">
            {frozen ? t('clothesline.card.watchPaused') : ended ? t('clothesline.card.watchDone') : t('clothesline.card.watchRemain')}
          </span>
          {timerBtns}
          <span className="cl-tw-foot">{statusText} · {dirText}</span>
        </div>
      )
    }
    if (tstyle === 'ticket') {
      // B 站台车票：墨绿票头（标题+票号尾号）+ 等宽时间窗 + 检票剪线进度
      const done = Math.round(progress * 10)
      return (
        <div className="cl-face">
          <span className="cl-tk-head">
            <span className="cl-tk-title">{copy.title}{pinMark}</span>
            <span className="cl-tk-no">NO.{card.id.slice(-4)}</span>
          </span>
          <span className={`cl-tk-time ${timeCls}`}>{timer ?? '--:--'}</span>
          <span className="cl-tk-sub">
            {ended ? t('clothesline.card.ticketDone') : frozen ? t('clothesline.card.ticketPaused') : t('clothesline.card.ticketRemain')}
          </span>
          <span className="cl-tk-perf" aria-hidden="true">
            <span className="is-done">{'●'.repeat(done)}</span>
            <span className="is-cut">✂</span>
            <span>{'○'.repeat(Math.max(0, 10 - done))}</span>
          </span>
          {timerBtns}
          <span className="cl-tk-foot">TACCO STATION · {statusText}</span>
        </div>
      )
    }
    if (tstyle === 'lcd') {
      // C 像素掌机：外壳标牌 + 内嵌 LCD 屏（液晶时间 + 分段电量条）
      return (
        <div className="cl-face">
          <span className="cl-lc-label">◉ TOMATO · {copy.title}{pinMark}</span>
          <div className="cl-lc-screen">
            <span className={`cl-lc-time ${timeCls}`}>{timer ?? '--:--'}</span>
            <span className="cl-lc-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
          </div>
          {timerBtns}
          <span className="cl-lc-foot">{statusText} · ©TACCO</span>
        </div>
      )
    }
    if (tstyle === 'can') {
      // D 番茄罐头：金属罐顶（CSS 伪元素）+ 波普红条 + 容量条进度
      return (
        <div className="cl-face">
          <span className="cl-cn-band">
            <span className="cl-cn-title">{copy.title}{pinMark}</span>
            <span className="cl-cn-en">TOMATO · TACCO FOODS</span>
          </span>
          <span className={`cl-cn-time ${timeCls}`}>{timer ?? '--:--'}</span>
          <span className="cl-cn-cap">
            <em>{Math.round(remain * 100)}% LEFT</em>
            <span className="cl-cn-bar"><i style={{ width: `${Math.round(remain * 100)}%` }} /></span>
          </span>
          {timerBtns}
          <span className="cl-cn-foot">NET WT · {statusText}</span>
        </div>
      )
    }
    if (tstyle === 'board') {
      // E 咖啡小黑板：木框（卡身）+ 粉笔标题 + 「正」字计数进度
      const strokes = Math.round(progress * 10)
      const groups = Math.floor(strokes / 5)
      return (
        <div className="cl-face">
          <span className="cl-eb-title">{t('clothesline.card.boardToday')} · {copy.title}{pinMark}</span>
          <span className={`cl-eb-time ${timeCls}`}>{timer ?? '--:--'}</span>
          <span className="cl-eb-sub">
            {ended ? t('clothesline.card.boardDone') : frozen ? t('clothesline.card.statusPaused') : t('clothesline.card.boardRemain', { time: timer ?? '' })}
          </span>
          <span className="cl-eb-tally" aria-hidden="true">
            <span className="is-done">{t('clothesline.card.tallyMark').repeat(groups)}{t('clothesline.card.tallyBar').repeat(strokes % 5)}</span>
            <span className="is-rest">{t('clothesline.card.tallyBar').repeat(Math.max(0, 10 - strokes))}</span>
          </span>
          {timerBtns}
          <span className="cl-eb-foot">{statusText} · {dirText}</span>
        </div>
      )
    }
    if (tstyle === 'tomato') {
      // ★2026-11-23 异形计时卡① 番茄：白瓷表盘 + 红弧=剩余（C=289），
      // 完成整果转金（cl-shape-gold）+ 右上对勾徽标。与定稿方案A 逐笔一致；
      // 绳窗铁律：内容层零 CSS animation（进度弧纯 strokeDashoffset 内联样式）。
      const uid = card.id.slice(-6)
      return (
        <div className={`cl-face cl-shape is-tomato${shapeDone}${shapePaused}`}>
          <svg className="cl-shape-svg" viewBox="0 0 218 252" aria-hidden="true">
            <defs>
              <radialGradient id={`tmB-${uid}`} cx="35%" cy="26%" r="85%">
                <stop offset="0" stopColor="#ff8a70" />
                <stop offset=".45" stopColor="#e84433" />
                <stop offset=".85" stopColor="#c22c1e" />
                <stop offset="1" stopColor="#9e2015" />
              </radialGradient>
              <radialGradient id={`tmG-${uid}`} cx="35%" cy="26%" r="85%">
                <stop offset="0" stopColor="#ffdf8a" />
                <stop offset=".5" stopColor="#eda43c" />
                <stop offset="1" stopColor="#b06f1c" />
              </radialGradient>
              <clipPath id={`tmC-${uid}`}>
                <path d="M109 34 C68 30 30 64 30 120 C30 174 66 208 109 208 C152 208 188 174 188 120 C188 64 150 30 109 34 Z" />
              </clipPath>
            </defs>
            {/* ★2026-11-23 反馈2：SVG 顶部补挂绳（y0 → 果蒂），卡顶即绳下，夹子咬住挂绳 */}
            <line x1="109" y1="0" x2="109" y2="14" stroke="#c9ac77" strokeWidth="2" />
            <path d="M109 34 C68 30 30 64 30 120 C30 174 66 208 109 208 C152 208 188 174 188 120 C188 64 150 30 109 34 Z" fill={`url(#tmB-${uid})`} />
            <g clipPath={`url(#tmC-${uid})`}>
              <rect className="cl-shape-gold" x="30" y="30" width="158" height="180" fill={`url(#tmG-${uid})`} />
            </g>
            <ellipse cx="78" cy="72" rx="30" ry="15" fill="#ffffff" opacity=".32" transform="rotate(-16 78 72)" />
            <path d="M109 34 C104 26 100 20 104 12" stroke="#3e8a4c" strokeWidth="5" strokeLinecap="round" fill="none" />
            <g fill="#3f9e4d">
              <path d="M109 36 C96 28 80 30 72 42 C86 42 100 44 109 48 Z" />
              <path d="M109 36 C122 28 138 30 146 42 C132 42 118 44 109 48 Z" />
              <path d="M109 36 C102 24 88 18 76 24 C88 30 102 36 109 42 Z" fill="#2e7d32" />
              <path d="M109 36 C116 24 130 18 142 24 C130 30 116 36 109 42 Z" fill="#2e7d32" />
            </g>
            <circle cx="109" cy="128" r="54" fill="#fff9f5" />
            <circle className="cl-shape-track" cx="109" cy="128" r="46" strokeWidth="8" />
            <circle
              className="cl-shape-arc"
              cx="109"
              cy="128"
              r="46"
              strokeWidth="8"
              strokeDasharray="289"
              style={{ strokeDashoffset: 289 * (1 - ratio) }}
              transform="rotate(-90 109 128)"
            />
            <text className={`cl-shape-time${shapeLong ? ' is-long' : ''}`} x="109" y="127" textAnchor="middle">{timer ?? '--:--'}</text>
            <text className="cl-shape-sub" x="109" y="152" textAnchor="middle">{shapeSub}</text>
            <rect className="cl-shape-pill" x="55" y="188" width="108" height="22" rx="11" />
            <text className="cl-shape-title" x="109" y="203" textAnchor="middle">{shapeTitle}{pinMark}</text>
            <g className="cl-shape-badge" transform="rotate(12 186 34)">
              <circle cx="186" cy="34" r="14" fill="#2bb673" />
              <path d="M180 34 L184.5 38.5 L192.5 29.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </g>
          </svg>
          {shapeBtns}
        </div>
      )
    }
    if (tstyle === 'pocket') {
      // ② 口袋怀表：吊环挂夹下 + 黄铜表壳 + 表盘外弧=剩余（C=421）+ 12 刻度 + 铭牌。
      const uid = card.id.slice(-6)
      return (
        <div className={`cl-face cl-shape is-pocket${shapeDone}${shapePaused}`}>
          <svg className="cl-shape-svg" viewBox="0 0 206 248" aria-hidden="true">
            <defs>
              <linearGradient id={`pwC-${uid}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#f6dc9c" />
                <stop offset=".5" stopColor="#dcae52" />
                <stop offset="1" stopColor="#a97b2b" />
              </linearGradient>
            </defs>
            {/* ★2026-11-23 反馈2：SVG 顶部补挂绳（y0 → 吊环顶），夹子咬住挂绳 */}
            <line x1="103" y1="0" x2="103" y2="13" stroke="#c9ac77" strokeWidth="2" />
            <circle cx="103" cy="24" r="12" fill="none" stroke={`url(#pwC-${uid})`} strokeWidth="6" />
            <rect x="94" y="34" width="18" height="14" rx="5" fill={`url(#pwC-${uid})`} />
            <circle cx="103" cy="134" r="88" fill={`url(#pwC-${uid})`} />
            <circle cx="103" cy="134" r="76" fill="#fffdf4" />
            <circle className="cl-shape-track" cx="103" cy="134" r="67" strokeWidth="10" />
            <circle
              className="cl-shape-arc"
              cx="103"
              cy="134"
              r="67"
              strokeWidth="10"
              strokeDasharray="421"
              style={{ strokeDashoffset: 421 * (1 - ratio) }}
              transform="rotate(-90 103 134)"
            />
            <g stroke="#c4b083" strokeWidth="2" strokeLinecap="round">
              <line x1="103" y1="72" x2="103" y2="80" />
              <line x1="103" y1="188" x2="103" y2="196" />
              <line x1="41" y1="134" x2="49" y2="134" />
              <line x1="157" y1="134" x2="165" y2="134" />
              <line x1="59.5" y1="90.5" x2="65" y2="96" />
              <line x1="141" y1="172" x2="146.5" y2="177.5" />
              <line x1="146.5" y1="90.5" x2="141" y2="96" />
              <line x1="65" y1="172" x2="59.5" y2="177.5" />
            </g>
            <text className={`cl-shape-time${shapeLong ? ' is-long' : ''}`} x="103" y="136" textAnchor="middle">{timer ?? '--:--'}</text>
            <text className="cl-shape-sub" x="103" y="158" textAnchor="middle">{shapeSub}</text>
            <rect className="cl-shape-pill" x="55" y="176" width="96" height="20" rx="10" />
            <text className="cl-shape-title" x="103" y="190" textAnchor="middle">{shapeTitle}{pinMark}</text>
            <g className="cl-shape-badge" transform="rotate(12 179 46)">
              <circle cx="179" cy="46" r="14" fill="#2bb673" />
              <path d="M173 46 L177.5 50.5 L185.5 41.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </g>
          </svg>
          {shapeBtns}
        </div>
      )
    }
    if (tstyle === 'hourglass') {
      // ③ 沙漏：上腔沙=剩余（满 51px）、下腔沙=流逝（满 87px），静态流沙虚线；
      // 木吊牌放标题 + 时间。倒计时上沙减少；正计时下沙累积（语义自动成立）。
      const uid = card.id.slice(-6)
      const sandRemain = card.timer_direction === 'countup' ? 1 - ratio : ratio
      const sandProg = 1 - sandRemain
      return (
        <div className={`cl-face cl-shape is-hourglass${shapeDone}${shapePaused}`}>
          <svg className="cl-shape-svg" viewBox="0 0 190 240" aria-hidden="true">
            <defs>
              <linearGradient id={`hgW-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#c99a5f" />
                <stop offset="1" stopColor="#8d6437" />
              </linearGradient>
              <linearGradient id={`hgS-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f2cf7e" />
                <stop offset="1" stopColor="#d9a640" />
              </linearGradient>
              <clipPath id={`hgT-${uid}`}><path d="M42 22 H148 C148 52 116 62 95 68 C74 62 42 52 42 22 Z" /></clipPath>
              <clipPath id={`hgB-${uid}`}><path d="M95 71 C116 77 148 87 148 118 L148 158 L42 158 L42 118 C42 87 74 77 95 71 Z" /></clipPath>
            </defs>
            {/* ★2026-11-23 反馈2：SVG 顶部补挂绳（y0 → 顶木条） */}
            <line x1="95" y1="0" x2="95" y2="9" stroke="#c9ac77" strokeWidth="2" />
            <path d="M42 22 H148 C148 52 116 62 95 68 C74 62 42 52 42 22 Z" fill="rgba(210,224,248,.10)" stroke="rgba(190,205,235,.45)" strokeWidth="2" />
            <path d="M95 71 C116 77 148 87 148 118 L148 158 L42 158 L42 118 C42 87 74 77 95 71 Z" fill="rgba(210,224,248,.10)" stroke="rgba(190,205,235,.45)" strokeWidth="2" />
            <g clipPath={`url(#hgT-${uid})`}>
              <rect x="42" y={70 - 51 * sandRemain} width="106" height={Math.max(0, 51 * sandRemain)} fill={`url(#hgS-${uid})`} />
            </g>
            {/* ★2026-11-23 反馈1：流沙滴漏动效。用 SMIL <animate> 而非 CSS animation ——
                SMIL 时钟独立于 React 重渲染（5Hz tick 不会重启动画，绳窗铁律不破）；
                暂停/结束时卸载 <animate> 即停流。 */}
            <line className="cl-shape-stream" x1="95" y1="68" x2="95" y2="112" strokeDasharray="4 4">
              {!frozen && !ended && (
                <animate attributeName="stroke-dashoffset" from="0" to="-8" dur="0.9s" repeatCount="indefinite" />
              )}
            </line>
            <g clipPath={`url(#hgB-${uid})`}>
              <rect x="42" y={158 - 87 * sandProg} width="106" height={Math.max(0, 87 * sandProg)} fill={`url(#hgS-${uid})`} />
            </g>
            <rect x="34" y="8" width="122" height="14" rx="7" fill={`url(#hgW-${uid})`} />
            <rect x="34" y="158" width="122" height="14" rx="7" fill={`url(#hgW-${uid})`} />
            <line x1="95" y1="172" x2="95" y2="182" stroke="#8d6437" strokeWidth="2" />
            <rect x="42" y="182" width="106" height="52" rx="10" fill={`url(#hgW-${uid})`} />
            <text className="cl-shape-title" x="95" y="200" textAnchor="middle">{shapeTitle}{pinMark}</text>
            <text className={`cl-shape-time${shapeLong ? ' is-long' : ''}`} x="95" y="224" textAnchor="middle">{timer ?? '--:--'}</text>
            <g className="cl-shape-badge" transform="rotate(12 160 16)">
              <circle cx="160" cy="16" r="13" fill="#2bb673" />
              <path d="M154.5 16 L158.5 20 L166 12.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </g>
          </svg>
          {shapeBtns}
        </div>
      )
    }
    if (tstyle === 'moon') {
      // ④ 月相：深夜蓝星球盘 + 星光点缀 + 金弧沿边缘扫过=剩余（C=465）；
      // 与口袋怀表形成一明一暗对照。完成弧光熄灭 + 对勾徽标。
      const uid = card.id.slice(-6)
      return (
        <div className={`cl-face cl-shape is-moon${shapeDone}${shapePaused}`}>
          <svg className="cl-shape-svg" viewBox="0 0 210 246" aria-hidden="true">
            <defs>
              <radialGradient id={`mnN-${uid}`} cx="38%" cy="30%" r="85%">
                <stop offset="0" stopColor="#3c4a78" />
                <stop offset=".7" stopColor="#242d4c" />
                <stop offset="1" stopColor="#161c30" />
              </radialGradient>
            </defs>
            {/* ★2026-11-23 反馈2：SVG 顶部补挂绳（y0 → 月盘顶 y36），夹子咬住挂绳 */}
            <line x1="105" y1="0" x2="105" y2="38" stroke="#c9ac77" strokeWidth="2" />
            <circle cx="105" cy="118" r="82" fill={`url(#mnN-${uid})`} stroke="rgba(140,160,220,.3)" />
            <circle cx="85" cy="94" r="54" fill="#f2c766" opacity=".10" />
            <g fill="#cdd7f5">
              <circle cx="58" cy="76" r="1.6" opacity=".8" />
              <circle cx="152" cy="82" r="2" opacity=".9" />
              <circle cx="72" cy="162" r="1.5" opacity=".7" />
              <circle cx="146" cy="152" r="1.4" opacity=".7" />
            </g>
            <path d="M148 74 L148 90 M140 82 L156 82" stroke="#e8d9a0" strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
            <circle className="cl-shape-track" cx="105" cy="118" r="74" strokeWidth="8" />
            <circle
              className="cl-shape-arc"
              cx="105"
              cy="118"
              r="74"
              strokeWidth="8"
              strokeDasharray="465"
              style={{ strokeDashoffset: 465 * (1 - ratio) }}
              transform="rotate(-90 105 118)"
            />
            <text className={`cl-shape-time${shapeLong ? ' is-long' : ''}`} x="105" y="114" textAnchor="middle">{timer ?? '--:--'}</text>
            <text className="cl-shape-sub" x="105" y="140" textAnchor="middle">{shapeSub}</text>
            <rect className="cl-shape-pill" x="60" y="156" width="90" height="22" rx="11" />
            <text className="cl-shape-title" x="105" y="171" textAnchor="middle">{shapeTitle}{pinMark}</text>
            <g className="cl-shape-badge" transform="rotate(12 176 44)">
              <circle cx="176" cy="44" r="14" fill="#2bb673" />
              <path d="M170 44 L174.5 48.5 L182.5 39.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </g>
          </svg>
          {shapeBtns}
        </div>
      )
    }
    // F 剧场灯牌：金色 dotted 灯泡边框（伪元素）+ 灯泡倒数进度
    const lit = Math.ceil(remain * 10)
    return (
      <div className="cl-face">
        <span className="cl-mq-title">{copy.title}{pinMark}</span>
        <span className={`cl-mq-time ${timeCls}`}>{timer ?? '--:--'}</span>
        <span className="cl-mq-sub">
          {ended ? t('clothesline.card.marqueeDone') : frozen ? t('clothesline.card.statusPaused') : t('clothesline.card.marqueeSoon')}
        </span>
        <span className="cl-mq-bulbs" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} className={i < lit ? 'is-lit' : ''} />
          ))}
        </span>
        {timerBtns}
        <span className="cl-mq-foot">TACCO THEATER · {statusText}</span>
      </div>
    )
  }

  // ★2026-11-15 一键录音卡（方案六·墨黑胶囊）：录音引擎在主窗，这里只是遥控器
  // + 状态显示。时长由 CL_RECORDER_STATE 事件驱动渲染（5Hz），铁律：无 CSS animation。
  if (card.kind === 'audio') {
    const status = audio?.status ?? 'idle'
    const word = audio == null ? t('clothesline.audio.preparing')
      : status === 'starting' ? t('clothesline.audio.connecting')
      : status === 'recording' ? t('clothesline.audio.recording')
      : status === 'paused' ? t('clothesline.card.statusPaused')
      : status === 'saving' ? t('clothesline.audio.saving') : t('clothesline.audio.stopped')
    // starting/saving 期间按钮全部锁住（引擎侧同样有状态闸门，双保险）；
    // audio==null（状态还没广播到 / 已结束）同样只允许 × 取下。
    const locked = audio == null || status === 'starting' || status === 'saving'
    const pill = audio == null ? '···'
      : status === 'recording' || status === 'starting' ? 'REC'
      : status === 'paused' ? 'PAUSE'
      : status === 'saving' ? 'SAVE' : 'STOP'
    const commitTitle = () => {
      if (audioTitleEdit !== null) onRenameAudio(card, audioTitleEdit)
      setAudioTitleEdit(null)
    }
    return (
      <div className="cl-face cl-au-face">
        <span className={`cl-au-pill ${status === 'paused' ? 'is-hold' : status === 'saving' ? 'is-save' : ''}`}>
          {pill}
        </span>
        {audioTitleEdit !== null ? (
          <input
            className="cl-au-title-input"
            data-cl-hit="1"
            autoFocus
            value={audioTitleEdit}
            maxLength={60}
            placeholder={t('clothesline.audio.titlePlaceholder')}
            onChange={(e) => setAudioTitleEdit(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle() }
              if (e.key === 'Escape') { e.preventDefault(); setAudioTitleEdit(null) }
            }}
            onBlur={commitTitle}
          />
        ) : (
          <button
            type="button"
            className="cl-au-title"
            data-cl-hit="1"
            title={t('clothesline.audio.titleTip')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setAudioTitleEdit(card.title || t('clothesline.audio.defaultTitle'))
            }}
          >
            {copy.title || t('clothesline.audio.defaultTitle')}
          </button>
        )}
        <span className="cl-au-time">{fmtTimerBody(audio?.elapsedMs ?? 0)}</span>
        <div className="cl-au-line" aria-hidden="true">
          {AU_WAVE.map((h, i) => (
            <i key={i} style={{ height: `${h}px` }} />
          ))}
        </div>
        <div className="cl-au-btns" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled={locked}
            title={status === 'paused' ? t('recorder.ariaResume') : t('recorder.ariaPause')}
            onClick={() => onAudioAction(card, status === 'paused' ? 'resume' : 'pause')}
          >
            {status === 'paused' ? '▶' : '❚❚'}
          </button>
          <button
            type="button"
            disabled={locked}
            title={t('clothesline.audio.resetTip')}
            onClick={() => onAudioAction(card, 'reset')}
          >
            ⟲
          </button>
          <button
            type="button"
            className="cl-au-save"
            disabled={locked}
            title={t('clothesline.audio.saveTip')}
            onClick={() => onAudioAction(card, 'save')}
          >
            {status === 'saving' ? '…' : t('common.save')}
          </button>
        </div>
        <span className="cl-au-foot">{t('clothesline.audio.foot', { status: word, pinned: pinMark })}</span>
      </div>
    )
  }

  if (card.kind === 'note') {
    const note = readNoteLite(card.note_id)
    const itemId = card.attach_to?.startsWith('item:') ? card.attach_to.slice(5) : null
    // ★问题10「加到 6 条就加不了」的真根因：旧版 slice(0,6) 只渲染 6 条，
    //   第 7 条其实已经写进 store 却永远看不见，且「加一条」按钮被内容挤出卡片
    //   可视区 → 用户以为不能再加。现在全量渲染 + 列表区自身滚动，上限 30 条。
    const allItems = (note?.items ?? []).filter((it) => !itemId || it.id === itemId)
    const items = allItems.slice(0, MAX_NOTE_ITEMS_ON_ROPE)
    const noteId = card.note_id ?? ''
    const commitNoteEdit = () => {
      const text = noteEdit?.value.trim() ?? ''
      if (noteEdit && noteId && text) {
        if (noteEdit.mode === 'add') {
          onNoteAction({ action: 'add', noteId, text })
        } else if (noteEdit.itemId) {
          onNoteAction({ action: 'edit', noteId, itemId: noteEdit.itemId, text })
        }
      }
      setNoteEdit(null)
    }
    // 输入框全宽（放在列表最末一条下方 / 直接替换被编辑的那一行）。
    // ★问题5：按用户要求**不再渲染「确定 / 取消」按钮** —— Enter 保存、Esc 取消，
    //   只留一条整宽输入框，长文本也能看清。autoFocus 后立刻滚进列表可视区
    //   （条目超过一屏时新输入框在底部，不滚过去用户会以为没反应）。
    const editBar = noteEdit ? (
      <div className="cl-note-editbar" data-cl-hit="1" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="cl-note-input"
          data-cl-hit="1"
          autoFocus
          value={noteEdit.value}
          placeholder={noteEdit.mode === 'add' ? t('clothesline.note.editPlaceholder') : t('clothesline.note.editPlaceholderRow')}
          onChange={(e) => setNoteEdit({ ...noteEdit, value: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitNoteEdit() }
            if (e.key === 'Escape') { e.preventDefault(); setNoteEdit(null) }
          }}
        />
      </div>
    ) : null
    return (
      <div className="cl-face cl-note-face">
        <div className="cl-note-head">
          <span className="cl-note-title">{itemId ? t('clothesline.card.noteSingle') : copy.title}{pinMark}</span>
        </div>
        <ul className="cl-note-list" data-cl-note-list="1">
          {items.map((it) =>
            noteEdit?.mode === 'edit' && noteEdit.itemId === it.id ? (
              <li key={it.id} className="cl-note-row">{editBar}</li>
            ) : (
              <li key={it.id} className={`cl-note-row ${it.done ? 'is-done' : ''}`}>
                <button
                  type="button"
                  className="cl-note-check"
                  data-cl-hit="1"
                  aria-label={it.done ? t('clothesline.note.ariaUncheck') : t('clothesline.note.ariaCheck')}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onNoteAction({ action: 'toggle', noteId, itemId: it.id })
                  }}
                >
                  {it.done ? '✓' : ''}
                </button>
                {/* 问题9：单击即编辑（原双击），且阻止冒泡到整卡的单击编辑。 */}
                <span
                  className="cl-note-text"
                  aria-label={t('clothesline.note.ariaEditRow')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setNoteEdit({ mode: 'edit', itemId: it.id, value: it.text })
                  }}
                >
                  {it.text}
                </span>
                {/* ★2026-11-15 反馈4：操作项与桌面便利签一致 —— 悬停行时浮出
                    （不占内容空间）：复制 / 加入待办 / 删除。写回仍走主窗单一写方。 */}
                <span className="cl-note-ops" data-cl-hit="1" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="cl-note-op"
                    data-cl-hit="1"
                    title={t('clothesline.note.copyTip')}
                    aria-label={t('clothesline.note.copyTip')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void copyText(it.text)
                        .then(() => onToast(t('clothesline.note.copied')))
                        .catch(() => onToast(t('clothesline.note.copyFail')))
                    }}
                  >
                    <Copy size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="cl-note-op"
                    data-cl-hit="1"
                    title={t('clothesline.note.toTask')}
                    aria-label={t('clothesline.note.toTask')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onNoteAction({ action: 'totask', noteId, text: it.text })
                    }}
                  >
                    <ListTodo size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="cl-note-op is-danger"
                    data-cl-hit="1"
                    title={t('clothesline.note.deleteRow')}
                    aria-label={t('clothesline.note.deleteRow')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onNoteAction({ action: 'remove', noteId, itemId: it.id })
                    }}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </span>
              </li>
            ),
          )}
          {/* 问题10：新增文本框直接出现在最末一条内容下方，宽度撑满整张卡。 */}
          {noteEdit?.mode === 'add' ? <li className="cl-note-row cl-note-addrow">{editBar}</li> : null}
        </ul>
        {items.length === 0 && !noteEdit ? <span className="cl-note-more">{t('clothesline.card.noteEmpty')}</span> : null}
        {/* ★2026-11-15 需求1：「＋加一条 / 打开原窗」按钮排移除，改为底部固定添加
            文本框（与桌面便利签一致）。回车即新增；编辑已有条目仍单击文本进入编辑条。 */}
        {noteId && !itemId ? (
          <form
            className="cl-note-addbar"
            data-cl-hit="1"
            onPointerDown={(e) => e.stopPropagation()}
            onSubmit={(e) => e.preventDefault()}
          >
            <input
              className="cl-note-input"
              data-cl-hit="1"
              placeholder={t('clothesline.note.addPlaceholder', { cur: items.length, max: MAX_NOTE_ITEMS_ON_ROPE })}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const text = e.currentTarget.value.trim()
                if (!text) return
                if (items.length >= MAX_NOTE_ITEMS_ON_ROPE) {
                  onToast(t('clothesline.note.maxRows', { max: MAX_NOTE_ITEMS_ON_ROPE }))
                  return
                }
                onNoteAction({ action: 'add', noteId, text })
                e.currentTarget.value = ''
              }}
            />
          </form>
        ) : null}
      </div>
    )
  }

  if (card.kind === 'task') {
    const lines = copy.text.split('\n').filter(Boolean).slice(0, 5)
    return (
      <div className="cl-face">
        <span className="cl-task-title">{copy.title}{pinMark}</span>
        {lines.length ? (
          lines.map((line, i) => (
            <div className="cl-task-row" key={`${i}-${line}`}><i /><span>{line}</span></div>
          ))
        ) : (
          <div className="cl-task-row"><i /><span>{t('clothesline.task.empty')}</span></div>
        )}
      </div>
    )
  }

  if (card.kind === 'shot' || card.kind === 'pin' || card.kind === 'image') {
    return (
      <div className="cl-face">
        {thumb ? (
          <div
            className="cl-photo"
            role="button"
            tabIndex={0}
            aria-label={t('clothesline.photo.aria')}
            style={imgRatio > 0 ? { aspectRatio: String(imgRatio) } : undefined}
            onClick={(e) => {
              e.stopPropagation()
              onPreview(card)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onPhotoCopy(card)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPreview(card)
              }
            }}
          >
            <img
              src={thumb}
              alt={t('clothesline.photo.alt')}
              draggable={false}
              onLoad={(e) => {
                // ★2026-11-23 需求1：原始宽高比钳制在 [3:4, 4:3] ——
                // 竖长截图统一 3:4、横宽截图统一 4:3，不再按原比例无限拉伸卡高；
                // 超出范围的图片由 object-fit:contain 在钳制框内居中留白。
                const el = e.currentTarget
                if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                  const r = el.naturalWidth / el.naturalHeight
                  setImgRatio(Math.min(Math.max(r, 3 / 4), 4 / 3))
                }
              }}
            />
          </div>
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
        {/* ★2026-11-15 需求7：去掉固定标题「截图 / 贴图 / 图片」，只显示用户编写内容；
            没有内容时 caption / meta 整行不渲染（不再兜底「挂在晾衣绳上」）。 */}
        {copy.title ? <span className="cl-caption">{copy.title}{pinMark}</span> : null}
        {copy.text ? <span className="cl-meta">{copy.text}</span> : null}
      </div>
    )
  }

  if (card.kind === 'text') {
    return (
      <div className="cl-face cl-letter-face">
        {/* ★2026-11-15 反馈批8：随手记卡改版「方案二 · 晨雾渐变」—— 圆徽章标题区
            （徽章 + 标题 + 落款日期）+ 正文 + 底部三色渐变条；样式见
            .cl-letter-head / .cl-letter-badge / .cl-letter-bar。 */}
        <div className="cl-letter-head">
          <span className="cl-letter-badge" aria-hidden="true">✎</span>
          <span className="cl-letter-headtxt">
            {copy.title ? <span className="cl-caption">{copy.title}</span> : null}
            <span className="cl-letter-date">
              {fmtCardDate(card.created_at)}
              {card.category?.trim() ? (
                <span className="cl-letter-cat">{card.category.trim()}</span>
              ) : null}
            </span>
          </span>
        </div>
        {/* ★2026-11-24 随手记支持富文本（'@@RICH@@'前缀 + 白名单净化 HTML）；
            纯文本走原样渲染，换行仍由 .cl-txt 的 pre-wrap 承接 */}
        {copy.text ? <RichText className="cl-txt" text={copy.text} /> : null}
        {pinMark ? <span className="cl-letter-sign">{pinMark.trim()}</span> : null}
        <span className="cl-letter-bar" aria-hidden="true" />
      </div>
    )
  }

  // clipboard（等宽）
  return (
    <div className="cl-face">
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

/** 收起态可点矩形（第二十一轮绳带窄窗）：就是 OS 窗口矩形本身——180×96 小窗已与
 *  拉绳/拉手视觉完全对齐（拉手绘制在窗体水平中央），无需再做 CSS 布局换算。
 *  ⚠️ 本表只服务 Rust 侧「浮层关闭检测」（问题13），不参与 OS 命中测试。 */
/** 窗口 CSS 逻辑高度（原型视口）：展开态容纳 186px 卡 + 32 top + 24 底；收起态容纳垂下的拉手。
 *  ★传给 Rust 的永远是「逻辑高 × scaleFactor」的物理像素——旧代码写死物理 300，
 *    在 125%/150% DPI 下只有 240/200 逻辑像素，卡片被 overflow:hidden 裁掉底部（问题1）。 */
// 问题6：番茄卡（环形 92 + 标题 + 3 按钮 + 页脚）实际内容高约 190px，叠加 .cl-deck 顶
//   32px + padding-top 12px + 木夹上探后，268px 逻辑高会被 overflow:hidden 裁掉底部按钮，
//   而滚轮只做横向平移救不了纵向截断。改回与 clothesline.css 设计基线一致的 300px。
const EXPANDED_CSS_H = 300
const COLLAPSED_CSS_H = 96

function collapsedHitRects(winRect: ClRect): HitRect[] {
  return [{ x: winRect.x, y: winRect.y, width: winRect.width, height: winRect.height }]
}

export function ClotheslineView() {
  const { t, locale } = useI18n()
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
  // ＋ 菜单（原型 .add-sheet）。清风冻结改为「仅悬停单卡时局部冻结」（CSS :hover），
  // 不再整窗 pointerEnter 全暂停——否则绳窗横贯桌面、鼠标常驻其内，清风永远停着（问题5）。
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  // ＋ 菜单浮层 DOM（测量内容高度，临时加高窗口用）。
  const addSheetRef = useRef<HTMLDivElement | null>(null)
  // ＋ 菜单打开期间窗口被临时加高的标记；悬停自动收起在该期间必须让位，否则
  // 光标落在菜单下半段（原 300px 横带之外）会被 OS 判为「离开面板」把菜单连窗收掉。
  const menuBoostRef = useRef(false)
  // ★2026-11-20 操作指引弹窗（复用全屏弹窗机制；首次启用自动弹一次）。
  const [guideOpen, setGuideOpen] = useState(false)
  const [draggingRope, setDraggingRope] = useState(false)
  // 拖绳 / 拉杆会话（PRD §11 / §4.7）：声明必须在事件监听 effect 之前，避免 TDZ。
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ropeDragRef = useRef<{
    /** ★问题1/2 抖动根因：拖动位移必须用**屏幕绝对坐标**（screenX/Y），
     *  绝不能用 clientX/Y —— clientX 是「相对窗口视口」的坐标，拖动时窗口自己在移动，
     *  窗口左移 10px → 同一根手指的 clientX 立刻 +10 → dx 变大 → 窗口再左移 …
     *  形成正反馈振荡，肉眼就是「明显抖动 + 拉扯感 + 只能往左跑」。 */
    startSX: number
    startSY: number
    /** 屏幕坐标(CSS px) → 窗口物理像素的换算系数。 */
    dpr: number
    startAnchor: number
    /** 按下瞬间的**窗口真实物理 x** + 允许范围（问题1：一切以像素为准，比例只用于落盘）。 */
    startX: number
    minX: number
    maxX: number
    /** 按下瞬间按真实 x 反算的比例，仅用于「是否有变化」的比较与提示。 */
    startRatio: number
    nextY: number
    nextX: number
    moved: boolean
  } | null>(null)
  const pullDragRef = useRef<{
    /** 同 ropeDragRef：一律屏幕绝对坐标，见上方抖动根因注释。 */
    startSX: number
    startSY: number
    dpr: number
    /** 按下瞬间的窗口真实物理 x / 允许范围 / 对应比例（问题1 像素真源）。 */
    startX: number
    minX: number
    maxX: number
    startRatio: number
    nextX: number
    mode: 'none' | 'horizontal' | 'vertical'
    /** 下拉进度 0~1（只驱动拉绳/拉手的 CSS 变量，松手弹回）。 */
    pull: number
    moved: boolean
    monY: number
  } | null>(null)
  const pullMovedRef = useRef(false)
  const ropeFrameRef = useRef<number | null>(null)
  // 收起态拉手拖动的 rAF 句柄 / 待写位置（与展开态 ropeFrameRef 分开，互不干扰）。
  const pullFrameRef = useRef<number | null>(null)
  const pendingPullXRef = useRef<number | null>(null)
  // 问题4：rAF 节流里同时携带窗口绝对 x 与 y 锚点，避免每帧两次 IPC。
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const ropeKeepAliveRef = useRef<number | null>(null)
  const pullKeepAliveRef = useRef<number | null>(null)
  // 问题8：全屏预览期间持续强制整屏可点的定时器句柄。
  const previewKeepAliveRef = useRef<number | null>(null)
  // 问题8/13：预览 id 与设置经 ref 暴露给「只挂载一次」的监听器，避免闭包读到陈旧值。
  const previewCardIdRef = useRef<string | null>(null)
  // 只挂载一次的事件 effect 用它调用「最新」的 closePreview，避免闭包捕获首次渲染版本。
  const closePreviewRef = useRef<() => void>(() => undefined)
  const settingsRef = useRef<ClotheslineSettings | null>(null)
  // 问题9：拖图片入绳期间持续强制可点（否则 48ms 命中循环会把 drop 穿透掉）。
  const dropKeepAliveRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  // 收起态拉绳按钮：下拉进度直接写它的 CSS 变量（--cl-pull），不 setState → 零重渲染。
  const pullTabRef = useRef<HTMLButtonElement>(null)
  /** 添加 / 编辑弹窗打开标志（ref 版）：refreshHitRects 在弹窗期间必须跳过
   *  面板矩形上报（弹窗期间命中矩形 = 弹窗矩形，见 armModalHit effect）。 */
  const fullscreenModalRef = useRef(false)
  const geomRef = useRef<{
    mon: MonitorInfo
    /** 面板（.cl-root 盒子）左上角的屏幕绝对物理 x —— 持久化比例 win_x_ratio /
     *  pulltab_x_ratio 的像素真源。展开态窗口 = 整宽横带（x=mon.x），面板在带内偏移；
     *  收起态窗口 = 拉杆小窗，面板盒子 480 逻辑px 宽、中心与窗体中心重合。 */
    winX: number
    panelW: number
    anchorY: number
    ropeH: number
    /** 面板相对目标屏顶的物理 y（展开=anchorY，收起=0）。 */
    panelY: number
    expanded: boolean
    /** ★第二十一轮：OS 窗口矩形（内容大小）。展开/收起/预览三态各自不同，
     *  拖拽逐帧只改其 x/y（clSetPosition），尺寸只随离散切换变。 */
    winRect: ClRect
    /** 拖动开始时就缓存的可用区，逐帧绝不再 mainWindowOccupancy() 读 localStorage。 */
    availX: number
    availW: number
    /** ★问题1「只能从居中往左拖、不能往右」的像素真源：
     *  窗口 x 的**可取范围**（屏幕绝对物理 px）。拖动只在这对值内做像素钳制，
     *  不再用「比例 × travel」反推（比例会因 history 里的陈旧值直接顶到 1.0 而卡死）。 */
    minX: number
    maxX: number
  } | null>(null)

  /**
   * ★第二十一轮绳带窄窗：OS 窗口本体 = 内容矩形（展开 = 顶部 mon.width×ropeH 横带；
   * 收起 = 拉杆处 180×96 小窗；预览 = 临时整屏）。--cl-panel-* 语义改为
   * 「面板相对窗口原点」的逻辑 px：窗口移动（clSetPosition）时内容随窗口整体平移、
   * 变量值不变；只有离散切换（展开↔收起 / 预览开关 / 换屏）才同时变窗口矩形与变量。
   */
  const applyPanelVars = useCallback((geom: NonNullable<typeof geomRef.current>) => {
    const el = rootRef.current
    if (!el) return
    const sf = geom.mon.scale_factor || 1
    el.style.setProperty('--cl-panel-x', `${Math.round((geom.winX - geom.winRect.x) / sf)}px`)
    el.style.setProperty('--cl-panel-y', `${Math.round((geom.mon.y + geom.panelY - geom.winRect.y) / sf)}px`)
    el.style.setProperty('--cl-panel-w', `${Math.round(geom.panelW / sf)}px`)
    el.style.setProperty('--cl-panel-h', `${Math.round(geom.ropeH / sf)}px`)
  }, [])

  /** ★2026-11-14 第二十一轮（绳带窄窗）：命中矩形**只服务浮层关闭检测**
   *  （问题13：Rust 侧判定「左键点在面板外」→ 关菜单），不参与 OS 命中测试——
   *  命中由窄窗的普通矩形窗口语义天然完成（窗口外点击直达桌面）。
   *  展开态 = 面板矩形（浮层都画在面板内）；收起态 = 窗口矩形本身。 */
  const panelHitRects = useCallback((geom: NonNullable<typeof geomRef.current>): HitRect[] => {
    if (!geom.expanded) {
      return collapsedHitRects(geom.winRect)
    }
    return [
      {
        x: geom.winX,
        y: geom.mon.y + geom.panelY,
        width: geom.panelW,
        height: geom.ropeH,
      },
    ]
  }, [])

  const scrollXRef = useRef(0)
  const [scrollX, setScrollX] = useState(0) // transform 平移用 state，render 期绝不读 ref。
  // 根因C：窗口逻辑宽（placeAndArm 写入）。卡片不足一屏时据此把卡片组居中，
  // 而不是让麻绳横贯全屏、卡片却全挤在左边（用户说的「没有水平居中」）。
  const [viewportW, setViewportW] = useState(0)
  const sessionRef = useRef<SessionState | null>(null)
  // 主窗配置页改偏好后的广播比对基准：避免本窗自己写盘→广播回环导致重复定位。
  const lastSettingsRef = useRef<ClotheslineSettings | null>(null)
  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  // 监听器只在挂载时注册一次；settings 经 ref 读最新版（render 期不写 ref）。
  // previewCardId 的 ref 同步放在其 state 声明处（见下方，避免 TDZ）。
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  /** transform 平移上限 = 内容右边界 − 视口宽（PRD §4.1 无滚动条横向平移）。
   *  ★根因C（反复修不好的「右侧卡片永远被硬切」）：旧版用 deck.scrollWidth 算内容宽，
   *    但 deck 是 width:max-content + min-width:100% + overflow:visible，Chrome 对这类
   *    元素的 scrollWidth 会退化成 clientWidth（= 视口宽）或漏掉尾部 padding，
     *    算出的上限接近 0 / 只够滚几十像素 → 最后一张卡永远滚不进视口、右侧恒被裁。
   *  ★2026-11-15 卡片尺寸 zoom 后再次失准：offsetLeft/offsetWidth 返回的是 zoom 前的
   *    布局值，cs>1 时内容宽被系统性算小 → 「滚到头右侧卡片仍显示不全」。
   *    改用 getBoundingClientRect（缩放 + transform 后的真实视觉几何）：
   *    lastRect.right − deckRect.left 天然抵消 deck 自身的 translateX(-scrollX)
   *    （transform 同步移动二者），且自动包含 zoom 缩放，与实现细节彻底解耦。 */
  const maxScrollX = useCallback(() => {
    const deck = deckRef.current
    const root = rootRef.current
    if (!deck || !root) return 0
    const viewport = root.clientWidth || window.innerWidth
    const sways = deck.querySelectorAll<HTMLElement>(':scope > .cl-card-sway')
    if (!sways.length) return 0
    const deckRect = deck.getBoundingClientRect()
    const lastRect = sways[sways.length - 1].getBoundingClientRect()
    const contentRight = lastRect.right - deckRect.left
    const cs = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
    const padRight = 30 * cs // 与 .cl-deck padding-right 一致（zoom 会放大它）
    // ★2026-11-15 反馈批8：尾部余量 40 → 12 —— 旧值让滚到头时右侧恒留 ~70px 空白，
    // 用户观感「晾衣绳右侧空白太多」；12px 足够覆盖取整误差与阴影。
    return Math.max(0, contentRight + padRight + 12 - viewport)
  }, [])
  /** 滚轮横向平移：deltaX / 纵向 deltaY 都映射到水平位移；不产生任何滚动条。
   *  ★第二十一轮：force 已是无窗口副作用的兼容桩（绳带窄窗无穿透/可点双态，
   *  滚动期间窗口样式零写入），保留调用仅为接口稳定。 */
  const onDeckWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
    // ★问题4：滚轮事件是从 root 冒泡上来的，旧版一律换算成甲板平移 →
    //   在＋菜单里滚（菜单自己可滚）、在便利签条目列表里滚（列表自己可滚）、
    //   或在大图预览上滚时，整排卡片会跟着左右滑动，非常错乱。
    //   命中这些「自带滚动上下文」的容器时直接交还原生滚动，绝不碰 scrollX。
    const tgt = e.target as HTMLElement
    // ★2026-11-15 反馈批4：随手记正文自带垂直滚动 —— 仅当它真的装不下
    // （scrollHeight > clientHeight）时才交还原生滚动；内容不足一屏时仍由
    // 甲板横向平移，避免滚轮落在正文上变成「死区」。
    const txt = tgt.closest('.cl-txt') as HTMLElement | null
    if (txt && txt.scrollHeight > txt.clientHeight + 1) return
    if (tgt.closest('.cl-add-sheet, .cl-note-list, .cl-preview, input, textarea, select')) return
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    scrollXRef.current = Math.min(maxScrollX(), Math.max(0, scrollXRef.current + delta))
    setScrollX(scrollXRef.current)
    void clSetForceClickable(1200)
  }, [maxScrollX, setScrollX])

  /** ★2026-11-15 反馈6：木夹必须挂在麻绳曲线上（用户：「夹子的一端必须要与晾衣绳连接」）。
   *  麻绳是 preserveAspectRatio="none" 的 SVG 下垂曲线（viewBox 0 0 1000 64，
   *  主绳 M4 26 Q500 46 996 26 → 绳上 y = 26 + 40·t·(1−t)，t = 夹子中心x / 面板宽），
   *  旧版所有卡片固定同一高度 → 绳中间下垂处夹子肉眼可见地悬空。
   *  做法：逐卡测量木夹的真实视觉几何（getBoundingClientRect 天然包含 zoom /
   *  居中 / translateX 滚动），把「夹子顶边 − 绳曲线 y」的差值写成 .cl-card-sway
   *  的 --cl-hang（0 时该变量不改变任何 transform）。差值用 WeakMap 记账：
   *  当前 rect 已含上一次 hang，减掉即得 hang=0 基线，避免每次先归零再强刷布局。 */
  const hangMapRef = useRef<WeakMap<HTMLElement, number>>(new WeakMap())
  const syncCardHang = useCallback(() => {
    const deck = deckRef.current
    const root = rootRef.current
    if (!deck || !root) return
    // 展开 / 收起动画进行中绝不测量：drop-in/pull-up 的 keyframes 会让 rect
    // 偏离静态位 → 算出错误的 hang。动画结束 ropePhase 回 idle 后会再同步。
    if (root.classList.contains('is-expanding') || root.classList.contains('is-collapsing')) return
    const rootRect = root.getBoundingClientRect()
    const panelW = rootRect.width
    if (panelW <= 0) return
    // ★2026-11-17 问题1：ropeTop 改用面板顶（rootRect.top）这一**静态基准**。
    // 旧版量 .cl-rope-svg 的 rect —— 清风开启时绳身带 cl-rope-breath（±2px 呼吸），
    // 每次渲染（时钟 / 计时每秒）都把呼吸相位差写进 --cl-hang → 卡片逐帧上下
    // 阶梯跳动，正是「左右摆之外还有上上下下卡顿感」的来源。面板顶不参与
    // 任何动画，天然稳定；0.25px 变更守卫从此恒不触发，动画零打断。
    const ropeTop = rootRect.top
    const sways = deck.querySelectorAll<HTMLElement>(':scope > .cl-card-sway')
    // ★2026-11-19 反馈1：清风开启时「写一次后冻结」。旧修复只解决了绳身呼吸
    // （ropeTop 基准），但 `.cl-card-sway` 本身的摆动动画（rotate ±1.6°）会让
    // 每次重渲染测得的 clipRect.top 出现 >0.25px 的亚像素差异——逐秒时钟 /
    // 计时渲染反复改写 --cl-hang → 卡片上下阶梯跳动又复现。冻结策略：清风
    // 开启时，已有 hang 记账的卡跳过测量改写（写一次后不再动）；新挂的卡
    // （WeakMap 无记录）仍测一次避免悬浮；清风关闭恢复常规同步。
    const windOn = root.classList.contains('has-wind')
    // zoom 会等比缩放子树内的 transform 位移：--cl-hang 存 CSS px，
    // 视觉位移 = hang × zoom → 写入值 = 视觉需求 ÷ zoom（旧版漏了这一步）。
    const cs = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
    sways.forEach((sway) => {
      if (windOn && hangMapRef.current.get(sway) !== undefined) return
      const clip = sway.querySelector<HTMLElement>('.cl-card-clip')
      if (!clip) return
      const prevApplied = hangMapRef.current.get(sway) ?? 0
      const clipRect = clip.getBoundingClientRect()
      // t = 夹子中心x / 面板宽；绳曲线 y = 26 + 40·t·(1−t)（主绳 Q 控制点 46 的展开式）。
      const t = Math.min(1, Math.max(0, (clipRect.left + clipRect.width / 2 - rootRect.left) / panelW))
      const ropeY = ropeTop + 26 + 40 * t * (1 - t)
      // 绳要从木夹上部约 1/4 处穿过（与两端绳钉处的原始视觉一致）。
      const desiredTop = ropeY - clipRect.height * 0.25
      const base = clipRect.top - prevApplied * cs // 撤掉现有 hang 后的夹子顶边
      const applied = (desiredTop - base) / cs
      // 变更守卫：每秒的时钟渲染不写无变化的 style（避免无谓的样式失效）。
      if (Math.abs(applied - prevApplied) < 0.25) return
      hangMapRef.current.set(sway, applied)
      sway.style.setProperty('--cl-hang', `${applied.toFixed(2)}px`)
    })
  }, [])

  /**
   * ★第二十一轮（绳带窄窗）：本表**只服务 Rust 侧浮层关闭检测**（问题13）。
   *
   * ⚠️ 2026-11-12 统一根因（反复修不好的真凶）：旧版把麻绳、每张卡、每个按钮
   *    都作为独立小矩形上报，光标在间隙移动时每 48ms 跨入跨出，Rust 反复翻转
   *    set_ignore_cursor_events → 重写 GWL_EXSTYLE 的 WS_EX_TRANSPARENT →
   *    DWM 重建透明合成层 → hover 变透明、拖动抖动、预览样式突变。
   *
   * ★2026-11-14 第十九/二十轮（均已证伪，勿回退）：region 裁剪毒化 alpha；
   *    恒 LAYERED 在 WebView2/DWM 合成窗上没有逐像素命中（那只存在于
   *    UpdateLayeredWindow 的 GDI 路径），整屏窗 + 恒 LAYERED = 启动即全屏冻结。
   *
   * ★第二十一轮定案：命中 = 窄窗的普通矩形窗口语义（窗口外点击直达桌面），
   *    与矩形表彻底解耦；矩形表只剩「面板内/外」判定一个职责。
   *    空数组仅在预览/拖放会话中上报（窗外判定暂停），8s 超时兜底回退。
   *
   * ⚠️ 窄窗语义：浮层 DOM（＋菜单 / 右键菜单）都渲染在面板矩形内，浮层开合
   *    都不改命中矩形：点面板内不关闭，点面板外由 Rust OS 轮询判定为 outside
   *    （问题13）。预览是唯一例外，由 openPreview 显式上报空数组（窗口已临时
   *    放大整屏、遮罩铺满窗口，暂停窗外判定）。
   */
  const refreshHitRects = useCallback(async () => {
    const geom = geomRef.current
    if (!geom) return
    // ★2026-11-15 反馈2：添加 / 编辑弹窗打开期间，命中矩形 = 弹窗自身矩形
    //   （armModalHit effect 上报），绝不能被面板矩形覆盖——否则 8 秒空表兜底 /
    //   重算竞态会把居中弹窗判成「点在外面」→ 弹窗被 dismiss 关闭。
    if (fullscreenModalRef.current || previewCardIdRef.current !== null) return
    await clSetHitRects(panelHitRects(geom))
  }, [panelHitRects])

  /** 把**面板**摆到目标屏 + 应用窄窗矩形 + 上报命中矩形。所有坐标物理像素。
   *  ★2026-11-14 第二十一轮绳带窄窗：窗口本体 = 内容矩形——
   *    展开 = (mon.x, mon.y+anchorY, mon.width, ropeH) 顶部横带（绳横贯全屏宽）；
   *    收起 = 拉杆处 (winX+212sf, mon.y, 56sf, 96sf) 小窗（面板盒 480 逻辑px，
   *          .cl-pulltab 恒 left:calc(50% - 240px) → 拉手中心 = 面板中心 = 窗体中心）；
   *  矩形与上次不同才写窗口（clSetBounds 单次；冷启动 / 换屏走三连写 + show），
   *  同态重算（拖完松手）零窗口写入。
   *  pullRatio = 收起态拉杆比例，winXRatio = 展开态晾衣绳比例（两态独立，绝不共用）。
  *  winXPx：仅「同态重算」时传当前真实面板 x（像素真源）；切换展开/收起时**必须不传**，
  *          让目标态用自己的比例 + 自己的 minX/maxX 落位，否则两态位置又被绑死。 */
  const placeAndArm = useCallback(async (
    anchorY: number,
    isExpanded: boolean,
    mon: MonitorInfo,
    pullRatio: number,
    winXRatio: number,
    coldStart = false,
    winXPx?: number,
  ) => {
    // ★2026-11-13 解绑两态水平位置：win_x_ratio 专管「展开态晾衣绳」，
    //   pulltab_x_ratio 专管「收起态拉杆」。旧版两者共用同一份 geom.winX /
    //   win_x_ratio，切换展开收起时还把上一态的像素 winXPx 硬带过来，于是
    //   「拖拉杆 → 晾衣绳跟着跑；收起 → 拉杆按另一态范围反推回屏幕中央」。
    //   现在按 isExpanded 选各自的持久化比例，谁也不覆盖谁。
    const sf = mon.scale_factor || 1
    // ★2026-11-15 需求2/6/10：绳长度（可用区占比）与卡片尺寸（zoom 系数）进设置。
    //   展开横带高度随卡片尺寸放大（否则 2× 卡片会被 300px 带裁掉下半截）。
    const cs = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
    const ropeRatio = Math.min(1, Math.max(0.3, settingsRef.current?.rope_width_ratio ?? 0.86))
    const ropeH = Math.round((isExpanded ? EXPANDED_CSS_H * cs : COLLAPSED_CSS_H) * sf)
    const clampedAnchor = Math.min(anchorY, Math.max(0, mon.height - ropeH - 24))
    // 收起态拉手固定贴工作区顶部（问题11：原型收起态是一根从桌面顶部垂下的拉绳，
    // 不是停在拖绳记忆的高度）；展开态沿用可拖的 anchorY。
    const winY = isExpanded ? mon.y + clampedAnchor : mon.y

    // ★空间避让贴边主窗（PRD R3 / §4.2，不可关）：绳窗只占「对侧」的安全区。
    const occ = mainWindowOccupancy(mon)
    const occupyPhys = occ?.occupyPhys ?? 0
    // 可用区起点：主窗贴左 → 从主窗右侧起；否则从屏左缘起，到主窗左侧止。
    const availX = occ?.side === 'left' ? mon.x + occupyPhys : mon.x
    const availW = Math.max(0, mon.width - occupyPhys)
    // ★问题1/8 真正的几何根因：旧版 panelW = min(1180sf, availW - 40sf) 让窗口
    //   **几乎撑满可用区**，travel = availW - panelW 恒只有 40sf。于是：
    //     · win_x_ratio 从 0 到 1 只能把窗口挪 40px → 「无法左右移动 / 可拖区域小」；
    //     · 默认 0.5 只偏移 20px，窗口仍贴着可用区左缘 → 「不居中」。
    //   改为窗口占可用区 86%（上限 1180 逻辑px），travel 恒 ≥ 14%：
    //   1920 屏 → 1180px 窗口 + 740px 余量；1366 屏 → 1175px 窗口 + 191px 余量。
    //   默认 ratio=0.5 时窗口（连同麻绳与卡片组）真正落在可用区中央。
    //   物理 = 逻辑 × sf（遵守 dock.ts 物理/逻辑铁律）。
    //   ★2026-11-15 需求2/6：86% 改为用户可调（设置页「晾衣绳长度」30%~100%）。
    //   ★批17：去掉 1180 逻辑px 硬顶 —— 用户要求绳长最大 ≥ 屏宽 95%。旧公式
    //   Math.min(1180*sf, availW*ratio) 让 1180 成为天花板，大屏上即使拉满 100%
    //   也只有 1180 逻辑px。现在 panelW = availW × ropeRatio 直映可用区，
    //   ratio=1.0 时铺满可用区（无贴边主窗时 = 整个屏宽）；travel 随之自然
    //   收窄，ratio=1.0 时窗口铺满不可横移（用户主动选满宽，符合预期）。
    // ★2026-11-17 问题5：绳长 100% 必须 = 整屏宽。availW 永远保守避让贴边主窗
    // （主窗收起也按展开满宽预留），导致拉满 100% 屏幕两侧仍是大片空白。
    // ratio=1 时无视避让直接铺满整屏 —— 用户主动选满宽，覆盖主窗区域属预期；
    // ratio<1 时保持原避让公式不变。
    const fullW = ropeRatio >= 0.999
      ? mon.width
      : Math.max(
          Math.min(availW, Math.round(300 * sf)),
          Math.round(availW * ropeRatio),
        )
    // ★第二十一轮：展开态面板宽仍按可用区 86%；收起态面板 = .cl-pulltab 盒子的
    //   480 逻辑px（窄窗架构下不再需要「宽窗口给拉杆容错」——窗口本身只有 56sf 宽，
    //   面板盒只是 DOM 坐标系，拉手绘制在其中心）。
    const panelW = isExpanded ? fullW : Math.round(480 * sf)

    // ★★2026-11-13 问题1 真根因（这次按像素重写，不再靠比例反推）：
    //   旧版 `x = availX + (availW - panelW) * ratio`，而拖动的**起点比例**取自
    //   持久化 settings.win_x_ratio。一旦磁盘里留着一个比当前几何更极端的值
    //   （本例实测就是 1.0，可用区一变宽它就等于「已贴右」），拖动会话一开始就
    //   顶在 clamp 上：往右 dt 再大也被 Math.min(1, …) 吃掉 → 只有往左能动。
    //   现在改成：几何只暴露「面板 x 的像素可取范围 [minX, maxX]」，拖动直接
    //   x = clamp(当前真实 winX + dx)，比例只用于落盘/还原，绝不参与拖动本身。
    //
    //   展开态：左界仍避让贴边主窗；右界按用户确认**放开到显示器右缘**，
    //          右侧那块原本被避让预留的空白现在真正可达。
    //   收起态：钳制的是面板中心（= 拉手中心）的可达范围，换算到窗体 x 后留
    //          edgePad 呼吸感；窄窗 56sf 可轻微越出屏缘（越界部分完全透明）。
    let minX: number
    let maxX: number
    if (isExpanded) {
      // ★问题5：ratio=1 面板=整屏宽，起点也回到屏幕左缘（否则右侧被裁）。
      minX = ropeRatio >= 0.999 ? mon.x : availX
      maxX = mon.x + mon.width - panelW
    } else {
      const half = Math.round(panelW / 2)
      const edgePad = Math.round(20 * sf) // 拉手不贴死屏幕边缘，留一点呼吸感
      minX = availX - half + edgePad
      maxX = mon.x + mon.width - half - edgePad
      if (maxX < minX) {
        minX = Math.round(availX + (availW - panelW) / 2)
        maxX = minX
      }
    }
    if (maxX < minX) maxX = minX
    // 展开态读 win_x_ratio，收起态读 pulltab_x_ratio —— 两套范围（minX/maxX）不同，
    // 各自的比例只在自己的范围内反推，互不影响。
    const activeRatio = isExpanded ? winXRatio : pullRatio
    const ratio = Number.isFinite(activeRatio) ? Math.min(1, Math.max(0, activeRatio)) : 0.5
    // ★运行期「同一态内」用真实像素 x（避免脏 ratio 反复反推）；
    //   「切换态」调用方不传 winXPx，才会按目标态自己的比例重新落位。
    const desiredX = typeof winXPx === 'number' && Number.isFinite(winXPx)
      ? winXPx
      : minX + (maxX - minX) * ratio
    const winX = Math.round(Math.min(maxX, Math.max(minX, desiredX)))
    const panelY = isExpanded ? clampedAnchor : 0
    // ★第二十一轮：OS 窗口矩形 = 内容矩形（见函数头注释）。展开横带 y 随 anchor 走；
    //   收起小窗窗体中心 = 拉手中心（winX + 240sf）→ 窗体 x = winX + 240sf - 28sf。
    //   ★2026-11-15 需求8：收起窗从 180×96 收窄到 56×96 逻辑px —— 只框住拉手
    //   （30×36）与拉绳周围的呼吸边；旧 180 宽窗会把拉手左右两侧的桌面条带挡住，
    //   用户无法点到拉杆附近的桌面内容。badge 已移到拉手正下方，不再依赖侧向宽度。
    const winRect: ClRect = isExpanded
      ? { x: mon.x, y: mon.y + panelY, width: mon.width, height: ropeH }
      : {
          x: winX + Math.round(240 * sf) - Math.round(28 * sf),
          y: mon.y,
          width: Math.round(56 * sf),
          height: Math.round(COLLAPSED_CSS_H * sf),
        }
    const prevGeom = geomRef.current
    const rectChanged =
      !prevGeom ||
      prevGeom.winRect.x !== winRect.x ||
      prevGeom.winRect.y !== winRect.y ||
      prevGeom.winRect.width !== winRect.width ||
      prevGeom.winRect.height !== winRect.height
    const monChanged = !!prevGeom && prevGeom.mon.stable_id !== mon.stable_id

    if (coldStart) {
      // 启动窗口几何写入：窄窗矩形（三连写防混合 DPI 丢尺寸）+ show。
      const rect = winRect
      const applyCold = () => {
        void clApplyBoundsAndShow(rect.x, rect.y, rect.width, rect.height).then(() => setReady(true))
      }
      applyCold()
      window.setTimeout(applyCold, 60) // 冷启动兜底：首帧丢帧时 60ms 后再写一次（幂等）。
    } else if (monChanged) {
      // 换屏唯一允许的运行期「三连写」：跨混合 DPI 时单次 set_size 可能被 /1.5 吞掉。
      // 写入失败则整体放弃（geomRef 未动），调用方保持原屏原几何。
      try {
        await clApplyBoundsAndShow(winRect.x, winRect.y, winRect.width, winRect.height)
      } catch (e) {
        lsLog(`monitor switch failed: window geometry not written, keep old screen ${prevGeom?.mon.stable_id}: ${String(e)}`)
        return
      }
    } else if (rectChanged) {
      // 展开↔收起 / 收起态换比例等离散切换：单次 SetWindowPos 写矩形（不 show）。
      try {
        await clSetBounds(winRect.x, winRect.y, winRect.width, winRect.height)
      } catch (e) {
        lsLog(`narrow rect write failed (best effort): ${String(e)}`)
      }
    }

    geomRef.current = {
      mon,
      winX,
      panelW,
      anchorY: clampedAnchor,
      ropeH,
      panelY,
      expanded: isExpanded,
      winRect,
      availX,
      availW,
      minX,
      maxX,
    }
    setViewportW(Math.round(panelW / sf)) // 卡片组居中判定用（逻辑 px）
    applyPanelVars(geomRef.current)

    if (!coldStart) setReady(true)
    lsLog(
      `place screen=${mon.stable_id} panel@${winX},${winY} ${panelW}x${ropeH} (sf${sf})` +
        ` win${winRect.width}x${winRect.height}@${winRect.x},${winRect.y}` +
        ` x∈[${minX},${maxX}] ratio=${ratio.toFixed(3)}` +
        (occ ? ` dodge-left ${occ.side} main ${occupyPhys}px` : ''),
    )

    // ★第二十一轮：矩形表只服务浮层关闭检测（问题13）——展开态上报面板矩形，
    // 收起态上报窗口矩形；OS 命中测试由窄窗矩形语义天然完成。
    await clSetHitRects(panelHitRects(geomRef.current))
  }, [applyPanelVars, panelHitRects])

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
          lsLog('restore state read failed (kept transparent)')
          return
        }
        const mon =
          state.monitors.find((m) => m.stable_id === state!.target_monitor_stable_id) ??
          state.monitors.find((m) => m.is_primary) ??
          state.monitors[0]
        if (!mon) {
          lsLog('no usable monitor (kept transparent)')
          return
        }

        setSettings(state.settings)
        // ★2026-11-15 需求2/6/10：placeAndArm 读 settingsRef（effect 晚于本异步块），
        //   这里先同步写入，保证首次布窗就用上绳长度占比与卡片尺寸。
        settingsRef.current = state.settings
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
            `anchorY=${state.session.anchor_y}${state.recovered_from_backup ? ' (from backup)' : ''}`,
        )

        // 拔屏 / 首次启用 → 自固化新稳定 ID（唯一允许的启动时写，不碰 cards.json）。
        if (state.settings.monitor_stable_id !== mon.stable_id) {
          const updated = await clUpdateSettings({ monitor_stable_id: mon.stable_id }).catch(
            () => null,
          )
          if (!cancelled && updated) setSettings(updated)
        }

        // coldStart=true：首帧窗口还没显示，必须三连写 + 60ms 兜底（混合 DPI 防 /1.5）。
        await placeAndArm(
          state.session.anchor_y,
          initExpanded,
          mon,
          state.settings.pulltab_x_ratio,
          state.settings.win_x_ratio ?? 0.5,
          true,
        )
        // 恢复完成，下一帧结束 restoring（跳过入场动画）。
        window.setTimeout(() => {
          if (!cancelled) setRestoring(false)
        }, 80)
      } catch (e) {
        lsLog(`restore failed (kept transparent): ${String(e)}`)
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

  // 问题8：展开 / 收起动效。收起时先播「卡片向上收起」，动画结束才真正改窗口高度；
  // 展开时先把窗口放大，再播「卡片从绳上落下 + 轻微回弹」。相位用 state 驱动 CSS class，
  // 动画只改 transform（不改 alpha / box-shadow），透明置顶窗不会重建合成层。
  const [ropePhase, setRopePhase] = useState<'idle' | 'expanding' | 'collapsing'>('idle')
  const toggleExpanded = useCallback(async () => {
    if (!settings || !monitor || ropePhase !== 'idle') return
    await clSetForceClickable(900)
    if (expanded) {
      setRopePhase('collapsing')
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260))
      setExpanded(false)
      setRopePhase('idle')
      await clUpdateSettings({ expanded: false }).catch(() => undefined)
      // ★切态不传 winXPx：收起态用 settings.pulltab_x_ratio 按收起态范围落位，
      //   展开态的位置留在 win_x_ratio 里，绝不互相覆盖（问题2 解绑）。
      await placeAndArm(settings.anchor_y, false, monitor, settings.pulltab_x_ratio, settings.win_x_ratio ?? 0.5)
    } else {
      setExpanded(true)
      setRopePhase('expanding')
      await clUpdateSettings({ expanded: true }).catch(() => undefined)
      // 同理：展开态只认 win_x_ratio，拉杆位置留在 pulltab_x_ratio 里。
      await placeAndArm(settings.anchor_y, true, monitor, settings.pulltab_x_ratio, settings.win_x_ratio ?? 0.5)
      window.setTimeout(() => setRopePhase('idle'), 470)
    }
  }, [settings, monitor, expanded, ropePhase, placeAndArm])

  // ★2026-11-19 反馈4：悬停自动展开。Rust 命中循环（OS 级光标检测）发事件，
  // 这里经 toggleRef 调最新闭包（toggleExpanded 依赖 settings/monitor/expanded，
  // 直接在监听 effect 里引用会拿到旧闭包）。
  const toggleRef = useRef(toggleExpanded)
  useEffect(() => {
    toggleRef.current = toggleExpanded
  }, [toggleExpanded])

  // ★2026-11-15 反馈批8：挂绳同步与滚动定位都改为**每次渲染后执行**（不带依赖数组）。
  // 旧版依赖数组的致命漏洞：启动时组件先渲染 booting 早返回分支，切到主树时
  // React 认为 deps 未变不重跑 layout effect → 首屏挂绳同步被永久跳过，夹子悬空。
  // 每渲染都跑的成本可忽略：syncCardHang 内部有展开/收起跳过 + 逐卡 0.25px
  // 变更守卫，时钟渲染（每秒）绝大多数时候不写任何样式。
  useLayoutEffect(() => {
    syncCardHang()
  })
  // 面板宽是 placeAndArm 命令式写入的 CSS 变量（--cl-panel-w），不经过 React state，
  // 渲染感知不到 —— 用 ResizeObserver 兜住拖绳 / 改锚点 / 换显示器。
  // ★依赖带 settings：booting 分支切换到主树时 root 元素会换新，必须重挂观察器。
  useEffect(() => {
    if (!expanded || !settings) return
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => syncCardHang())
    ro.observe(root)
    return () => ro.disconnect()
  }, [expanded, settings, syncCardHang])

  // ★2026-11-15 反馈批8-1：新建卡片后自动滚动定位到该卡。
  // 用户场景：卡片多时新卡挂在第二屏，「已挂到晾衣绳」的 toast 让人误以为
  // 没创建成功。addCard 成功后记下目标 id，本 effect（每次渲染后跑）把甲板
  // 平移到新卡**完整可见**为止——最小位移原则，绝不追求居中：旧版居中目标
  // 与 maxScrollX 钳制叠加会滚过头（卡被截断 + 绳右侧大片空白）。
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (!scrollTargetId || !expanded) return
    const deck = deckRef.current
    const root = rootRef.current
    if (!deck || !root) return
    if (root.classList.contains('is-expanding') || root.classList.contains('is-collapsing')) return
    const sway = deck
      .querySelector(`[data-cl-card-id="${CSS.escape(scrollTargetId)}"]`)
      ?.closest('.cl-card-sway') as HTMLElement | null
    if (!sway) return // 卡片还没渲染进甲板，等下一次渲染再试（目标不清空）
    const rootRect = root.getBoundingClientRect()
    const swayRect = sway.getBoundingClientRect()
    const viewW = rootRect.width
    const viewL = swayRect.left - rootRect.left
    const viewR = swayRect.right - rootRect.left
    const margin = 14
    let next = scrollXRef.current
    let need = false
    if (viewL < margin) {
      next = scrollXRef.current + (viewL - margin) // 新卡在视口左侧外 → 右滚
      need = true
    } else if (viewR > viewW - margin) {
      next = scrollXRef.current + (viewR - viewW + margin) // 新卡在视口右侧外 → 左滚
      need = true
    }
    setScrollTargetId(null) // 无论滚不滚都消费掉目标，防止反复触发
    if (!need) return
    next = Math.min(maxScrollX(), Math.max(0, next))
    if (Math.abs(next - scrollXRef.current) < 1) return
    scrollXRef.current = next
    setScrollX(next)
    // deck 的 translateX(-scrollX) 由 React 下一次渲染写入，本 effect 无需手改 DOM。
  })

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
  const { fullAccess, showVip } = useAccount()
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [notesTick, setNotesTick] = useState(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  // ★2026-11-17 需求3：卡片右键菜单已整体移除（cardMenu state 一并删除）。
  // ★2026-11-15 需求1c：便利签卡顶部的颜色图标弹出色板（与右键菜单同一交互族）。
  const [colorMenu, setColorMenu] = useState<{ cardId: string; noteId: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [composing, setComposing] = useState<'text' | 'timer' | null>(null)
  // ★2026-11-15 反馈3：截图 / 贴图 / 图片 / 随手记卡的「编辑内容」改为桌面居中弹窗
  //   （与随手记添加弹窗同交互）：支持编辑标题 + 内容，保存走 clUpdateCard 增量写盘。
  const [editModal, setEditModal] = useState<{
    id: string
    title: string
    text: string
    /** ★批12：随手记卡的字体格式（undefined=非随手记卡，不显示该段）。 */
    fmt?: TextFormat
    /** ★2026-11-23 随手记分类（仅 text 卡有值，与全局速记窗共享分类表）。 */
    category?: string
    cats?: string[]
    newCat?: string
    addingCat?: boolean
  } | null>(null)
  const [composeText, setComposeText] = useState('')
  /** ★2026-11-23 随手记分类：与全局速记窗共享同一份分类表（同源 localStorage）。 */
  const [composeCats, setComposeCats] = useState<string[]>(loadCategories)
  const [composeCategory, setComposeCategory] = useState('')
  const [composeNewCat, setComposeNewCat] = useState('')
  const [composeAddingCat, setComposeAddingCat] = useState(false)
  const [composeMinutes, setComposeMinutes] = useState('25')
  const [undoCard, setUndoCard] = useState<{ id: string; label: string } | null>(null)
  /** ★2026-11-18 归档：便利签/随手记/番茄卡 × → 「归档 / 删除」两选弹窗的目标卡。 */
  const [takedownConfirm, setTakedownConfirm] = useState<ClotheslineCard | null>(null)
  /** ★2026-11-22 归档飞出动画：正在飞出的卡片 + 终点位移（飞出结束才真正归档）。
   *  dx/dy 按 dockSide 动态算到工具窗所在的屏幕边缘，故每次点击时现算。 */
  const [archiveFly, setArchiveFly] = useState<{ id: string; dx: number; dy: number } | null>(null)
  /** 退场动画标记:关闭确认弹窗先播 140ms 缩退动画再卸载,避免「瞬间消失」的卡顿感。 */
  const [takedownClosing, setTakedownClosing] = useState(false)
  // ★批15：撤销条 3 秒自动关闭（原 10 秒，用户反馈显示时间过长）。
  const UNDO_TOAST_MS = 3_000
  /** ★2026-11-22 归档飞出动画时长（与 clothesline.css .is-archive-fly 的 0.46s 一致）。 */
  const ARCHIVE_FLY_MS = 460
  const [hint, setHint] = useState('')
  // ★批14：toast 锚定卡片的逻辑坐标（null=回落：水平居中 + 面板底部，沿用 CSS）。
  const [hintX, setHintX] = useState<number | null>(null)
  const [hintY, setHintY] = useState<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const undoTimerRef = useRef<number | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  // 问题8：大图预览。只存 card id，图片本体读 previews[id]（data URL，绝不用 asset://）。
  // 采用绳窗内覆盖浮层、不改窗口几何——避免放大窗口带来的命中矩形 / 位置记忆回归。
  const [previewCardId, setPreviewCardId] = useState<string | null>(null)
  // ★2026-11-19 反馈2：预览优先显示全分辨率原图（originals/{id} 落盘），
  // 异步取回前 / 老卡没有原图时回退缩略图 previews[id]。null=未加载或无原图。
  const [previewOriginal, setPreviewOriginal] = useState<string | null>(null)
  // 与直接写 ref 的 openPreview/closePreview 保持一致兜底（Esc / 外部 state 变更也能同步）。
  useEffect(() => {
    previewCardIdRef.current = previewCardId
  }, [previewCardId])
  // 问题9：拖图片文件入绳（配合 Rust 建窗 .drag_and_drop(false)，DOM 才拿得到 dataTransfer.files）。
  const [dragOver, setDragOver] = useState(false)
  const dragDepthRef = useRef(0)

  const flash = useCallback((msg: string, cardId?: string | null) => {
    // ★批14：可选锚定到某张卡（绳上便利签「加入待办」结果提示）——水平对齐该卡
    //   视觉中心、垂直叠放在该卡**标题栏**位置（卡顶 +4px，用户明确要求提示出现
    //   在标题栏上）。卡 rect 在 deck 的 CSS zoom 内（视觉 px），toast 挂在面板根
    //   （逻辑 px），偏移必须 ÷card_size 回逻辑坐标（批6 同款换算）；卡不在 DOM
    //   （已取下/收起态）时回落面板底部居中。钳边防被 overflow:hidden 裁切。
    let x: number | null = null
    let y: number | null = null
    if (cardId) {
      const el = document.querySelector(`[data-cl-card-id="${cardId}"]`)
      const root = document.querySelector('.cl-root')
      if (el && root) {
        const cs = lastSettingsRef.current?.card_size ?? 1
        const r = el.getBoundingClientRect()
        const rr = root.getBoundingClientRect()
        x = Math.round((r.left + r.width / 2 - rr.left) / cs)
        y = Math.round((r.top - rr.top) / cs) + 4
        const half = 110 // 经验半宽：toast 文案短，钳边防被裁切
        x = Math.min(Math.max(x, half), Math.round(rr.width) - half)
        y = Math.min(Math.max(y, 4), Math.round(rr.height) - 36)
      }
    }
    setHint(msg)
    setHintX(x)
    setHintY(y)
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => {
      setHint('')
      setHintX(null)
      setHintY(null)
    }, 2800)
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

  /** ★批10-2：已见过的卡 id 基线（null = 首次广播，只记录不定位）。
   *  新卡自动滚动定位不能只挂在 addCard 包装器上——便利签挂卡 / 拖放截图 /
   *  剪贴板 / 录音卡等创建路径都不走它（用户批10反馈：多次修不好）。
   *  CL_CARDS_CHANGED 是所有创建路径的唯一汇合点，在此 diff 新 id 通用登记。 */
  const knownCardIdsRef = useRef<Set<string> | null>(null)

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
      reg<ClotheslineCard[]>(CL_CARDS_CHANGED, (list) => {
        const sorted = sortCards(list)
        const prevIds = knownCardIdsRef.current
        knownCardIdsRef.current = new Set(sorted.map((c) => c.id))
        // 恰好新增一张卡 → 登记滚动定位目标（覆盖全部创建路径）。
        // 首次广播 / 会话恢复是整批「新增」→ 只记基线，绝不触发滚动。
        if (prevIds) {
          const fresh = sorted.filter((c) => !prevIds.has(c.id))
          if (fresh.length === 1) setScrollTargetId(fresh[0].id)
        }
        setCards(sorted)
      })
      // ★批14：主窗写方回发的结果 toast（如便利签「加入待办」）→ 锚到对应卡显示。
      reg<ClToastPayload>(CL_TOAST, (p) => {
        const card = p.noteId ? cardsRef.current.find((c) => c.note_id === p.noteId) : null
        flash(p.msg, card?.id ?? null)
      })
      reg<Array<[string, number]>>(CL_ORDER_CHANGED, (pairs) => {
        const map = new Map(pairs)
        setCards((prev) =>
          [...prev]
            .map((c) => ({ ...c, order: map.get(c.id) ?? c.order }))
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
        )
      })
      reg<string>(CL_CARD_DROPPED, (id) => {
        setUndoCard({ id, label: t('clothesline.toast.dropped') })
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = window.setTimeout(() => setUndoCard(null), UNDO_TOAST_MS)
      })
      // 主窗配置页改了 6 项偏好 → 本次会话内即时生效（清风 / 比例靠 state；展开 / 换屏要重定位）。
      reg<ClotheslineSettings>(CL_SETTINGS_CHANGED, (next) => {
        const prev = lastSettingsRef.current
        lastSettingsRef.current = next
        // ★问题2：settingsRef 本体在 useEffect [settings]（渲染后才）更新，而下方
        //   bandChanged 会**立刻**调 placeAndArm 读 settingsRef.rope_width_ratio /
        //   card_size —— 不同步刷新就拿到旧值：滑杆拉满后绳子「弹回旧长度」，
        //   收起再展开（placeAndArm 晚于渲染）才恢复满宽。事件回调里写 ref 合法
        //   （render 期不写 ref 的铁律不冲突）。
        settingsRef.current = next
        setSettings(next) // 清风 wind_effect / pulltab 比例：class、样式立即响应。
        const geom = geomRef.current
        if (!geom) return // 恢复未完成，忽略；启动恢复本身已按磁盘摆位。
        const expandedChanged = next.expanded !== expandedRef.current
        const monitorChanged =
          next.monitor_stable_id !== geom.mon.stable_id &&
          (!prev || prev.monitor_stable_id !== next.monitor_stable_id)
        // ★2026-11-15 需求2/6/10：绳长度 / 卡片尺寸改动时，展开态横带（宽/高）会变，
        //   需要重新 placeAndArm 写窗口矩形；收起态两者都不影响窄窗，不重摆。
        const bandChanged =
          !!prev &&
          (prev.rope_width_ratio !== next.rope_width_ratio ||
            prev.card_size !== next.card_size)
        if (!expandedChanged && !monitorChanged && !(bandChanged && expandedRef.current)) return
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
                // ★第二十一轮：窄窗矩形 = 目标屏上的内容矩形，由 placeAndArm 按目标屏
                //   几何现算（检测 mon.stable_id 变化 → 走三连写 + show 通道），本处不再
                //   预写窗口矩形；placeAndArm 写入失败会整体放弃（geomRef 未动），保持
                //   原屏原几何，绝不只重算 CSS/命中矩形造成错位。
                void (async () => {
                  if (cancelled) return
                  setMonitor(target)
                  await placeAndArm(next.anchor_y, next.expanded, target, next.pulltab_x_ratio, next.win_x_ratio ?? 0.5)
                })()
              }
            })
            .catch(() => undefined)
        } else {
          // ★两态解绑：能走到这里说明 expandedChanged（纯偏好改动的广播已在上方 return）。
          //   旧版把旧态的 geom.winX 当第 7 参传给新态，等于展开↔收起互相带着跑；
          //   现在一律不传 winXPx，让目标态用自己的比例 + 自己的范围落位。
          void placeAndArm(next.anchor_y, next.expanded, geom.mon, next.pulltab_x_ratio, next.win_x_ratio ?? 0.5)
        }
      })
      // 便利签是 localStorage 同源共享；两通道保证主窗写入后本窗立即刷新。
      // 问题13：Rust 命中循环检测到「点在可点区外」→ 关闭右键菜单 / ＋菜单 / 大图预览。
      // ★不在 setState updater 里调副作用（StrictMode 下 updater 会执行两次）；
      //   本 effect 只挂载一次，直接引用 closePreview 会闭包捕获首次渲染的陈旧函数，
      //   故统一走 closePreviewRef.current（每次渲染后由 effect 同步为最新实现）。
      // ★2026-11-19 反馈4：悬停自动展开 / 移开自动收起（Rust OS 命中循环驱动）。
      // 预览覆盖层 / 全屏弹窗打开期间绝不自动收起（用户正在看图或填弹窗）。
      reg<unknown>('cl-auto-expand', () => {
        if (!expandedRef.current) void toggleRef.current()
      })
      reg<unknown>('cl-auto-collapse', () => {
        // ★2026-11-20：＋菜单打开期间窗口已临时加高，光标在菜单下半段（原横带外）
        // 会被 OS 判为离开面板 → 绝不能自动收起把菜单连窗收掉。
        if (
          expandedRef.current &&
          !fullscreenModalRef.current &&
          previewCardIdRef.current === null &&
          !menuBoostRef.current
        ) {
          void toggleRef.current()
        }
      })
      reg<unknown>(CL_DISMISS_OVERLAY, () => {
        setAddSheetOpen(false)
        // ★2026-11-15 需求5/6：随手记 / 番茄钟编辑弹窗无遮罩，点击弹窗外 = 取消；
        //   窗口矩形 / 命中矩形 / dismiss 开关由 composing 的 effect 清理函数还原。
        setComposing(null)
        setEditModal(null)
        setTakedownConfirm(null) // ★2026-11-18 归档：取下确认弹窗点外 = 取消
        setGuideOpen(false) // ★2026-11-20：操作指引点外 = 关闭（窗口矩形由其 effect 还原）
        if (previewCardIdRef.current !== null) closePreviewRef.current()
        void clSetDismissOnOutside(false)
      })
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
      if (ropeFrameRef.current !== null) window.cancelAnimationFrame(ropeFrameRef.current)
      if (pullFrameRef.current !== null) window.cancelAnimationFrame(pullFrameRef.current)
      if (ropeKeepAliveRef.current !== null) window.clearInterval(ropeKeepAliveRef.current)
      if (pullKeepAliveRef.current !== null) window.clearInterval(pullKeepAliveRef.current)
      if (previewKeepAliveRef.current !== null) window.clearInterval(previewKeepAliveRef.current)
      if (dropKeepAliveRef.current !== null) window.clearInterval(dropKeepAliveRef.current)
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
          !fired.has(c.id) &&
          // ★2026-11-15 需求6：番茄钟弹窗可勾选「结束提醒」，关闭时不弹系统通知
          //   （fired_at 也不写，避免「已完成」态被标记为已提醒过）。
          c.remind !== false
        ) {
          fired.add(c.id)
          void clUpdateCard(c.id, { fired_at: now }).catch(() => undefined)
          void import('@tauri-apps/plugin-notification')
            .then((m) => m.sendNotification({ title: t('clothesline.notify.timerDone'), body: c.title || t('clothesline.notify.timerFinished') }))
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
        // ★按 id 去重（问题6 一张卡显示两次）：Rust 在写盘后会 emit CL_CARDS_CHANGED
        // 全量列表，本窗监听也会 setCards(list)。若广播先于 invoke resolve 到达，
        // 旧的 [...prev, card] 会把同一张卡再追加一遍 → 用 filter 保证幂等。
        setCards((prev) => sortCards([...prev.filter((c) => c.id !== card.id), card]))
        // ★2026-11-15 反馈批7-1：新卡可能在第二屏 —— 立即登记滚动定位目标，
        // 布局 effect 会把甲板平移到新卡完整可见（尽量居中），用户不再「以为没创建成功」。
        setScrollTargetId(card.id)
        flash(t('clothesline.toast.hung'))
        return card
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // ★2026-11-23 需求：非会员满额时统一 toast 文案（会员仍显示 Rust 原始错误）。
        flash(!fullAccess && msg.includes('最多挂') ? t('clothesline.toast.freeCardLimit') : msg)
        return null
      }
    },
    [fullAccess, flash, setCards],
  )

  // ——— ★2026-11-15 一键录音（引擎在主窗；绳窗 = 遥控器 + 状态显示）———————
  /** 主窗广播的录音引擎状态（录音中约 5Hz）。cardId 匹配的卡由 CardFace 渲染状态。 */
  const [audioState, setAudioState] = useState<ClRecorderState | null>(null)
  /** 供回调读最新值（避免 5Hz setState 造成的闭包陈旧问题）。 */
  const audioStateRef = useRef<ClRecorderState | null>(null)
  useEffect(() => {
    let un: (() => void) | undefined
    let alive = true
    void listen<ClRecorderState>(CL_RECORDER_STATE, (e) => {
      const st = e.payload
      if (!alive || !st.cardId) return
      const cardId = st.cardId
      audioStateRef.current = st
      setAudioState(st)
      if (st.done === 'saved') {
        // 保存成功：卡片自动取下（软删除；不进撤销条 —— 已保存的东西无需撤销）。
        audioStateRef.current = null
        setAudioState(null)
        flash(t('clothesline.toast.savedViewRecorder'))
        void clRemoveCard(cardId)
          .then(() => setCards((prev) => prev.filter((c) => c.id !== cardId)))
          .catch(() => undefined)
      } else if (st.done === 'failed') {
        audioStateRef.current = null
        setAudioState(null)
        flash(st.error || t('clothesline.toast.recordFailed'))
        void clRemoveCard(cardId)
          .then(() => setCards((prev) => prev.filter((c) => c.id !== cardId)))
          .catch(() => undefined)
      }
    })
      .then((fn) => {
        if (alive) un = fn
        else fn()
      })
      .catch(() => undefined)
    return () => {
      alive = false
      un?.()
    }
  }, [flash, setCards])

  /** ＋菜单「一键录音」：自动命名（方案A）→ 建录音卡 → 发命令让主窗开录。 */
  const startRopeRecording = useCallback(async () => {
    setAddSheetOpen(false)
    const live = audioStateRef.current
    if (live && live.status !== 'idle') {
      flash(t('recorder.busy'))
      return
    }
    if (cardsRef.current.some((c) => c.kind === 'audio')) {
      flash(t('clothesline.toast.ropeHasAudio'))
      return
    }
    // 方案A 自动命名（与录音页默认标题同格式）；卡上可随时改名。
    const d = new Date()
    const p0 = (n: number) => String(n).padStart(2, '0')
    const title = t('recorder.defaultTitle', { m: d.getMonth() + 1, d: d.getDate(), time: `${p0(d.getHours())}:${p0(d.getMinutes())}` })
    const card = await addCard('audio', { title, text: '' })
    if (!card) return
    try {
      await emit(CL_RECORDER_CMD, { action: 'start', cardId: card.id, title })
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }, [addCard, flash])

  /** 录音卡控制：命令转发主窗执行（reset = 重新计时；save 携带卡上当前标题）。 */
  const audioAction = useCallback(
    async (card: ClotheslineCard, action: 'pause' | 'resume' | 'reset' | 'save') => {
      try {
        if (action === 'pause') await emit(CL_RECORDER_CMD, { action: 'pause' })
        else if (action === 'resume') await emit(CL_RECORDER_CMD, { action: 'resume' })
        else if (action === 'reset') await emit(CL_RECORDER_CMD, { action: 'reset', title: card.title })
        else await emit(CL_RECORDER_CMD, { action: 'save', title: card.title })
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash],
  )

  /** 卡上改名：写 card.title；保存时主窗按它重命名落盘文件（保持文件名=标题）。 */
  const renameAudioCard = useCallback(
    async (card: ClotheslineCard, title: string) => {
      const trimmed = title.trim()
      if (!trimmed || trimmed === card.title) return
      try {
        const next = await clUpdateCard(card.id, { title: trimmed })
        setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)))
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCards],
  )

  /** ⑥ 绳上便利签条目操作：一律发事件让主窗 store 代写（绳窗只读快照）。 */
  const onNoteItemAction = useCallback((p: ClNoteItemAction) => {
    void emit(CL_NOTE_ITEM_ACTION, p).catch(() => undefined)
  }, [])

  // ★2026-11-15 需求1d：右键菜单「打开原内容」保留（openSource → CL_OPEN_NOTE）；
  //   useNotesBridge 侧把桌面便利签标为未折叠再开窗，关闭它只折叠不删数据。

  /** 问题10：绳上便利签换色 → 主窗 notes/store.ts 单一写方（与桌面便利签共用色板）。 */
  const onNoteColorChange = useCallback((noteId: string, colorKey: string) => {
    void emit(CL_NOTE_COLOR_ACTION, { noteId, colorKey }).catch(() => undefined)
  }, [])

  /** ⑥ 便利签窗口被拖到桌面顶部释放 → 挂整张便利签到绳上。
   *  便利签窗口是独立 Tauri 窗，跨窗拖放不走 DOM dataTransfer，
   *  由其标题栏拖动结束时 emit 本事件，绳窗在这里接住并去重挂卡。 */
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<ClDropNoteWindow>(CL_DROP_NOTE_WINDOW, (e) => {
      if (cancelled) return
      const p = e.payload
      if (!p?.noteId) return
      const exists = cardsRef.current.some(
        (c) => c.kind === 'note' && c.note_id === p.noteId && !c.attach_to,
      )
      if (exists) {
        void emit(CL_OPEN_NOTE, { id: p.noteId }).catch(() => undefined)
        return
      }
      void addCard('note', {
        note_id: p.noteId,
        title: t('clothesline.card.note'),
        text: p.text ?? '',
      }).then((card) => {
        if (!card) return
        // 问题1：拖入挂绳成功后桌面便利签自动收起（主窗统一改 collapsed + 关窗）。
        void emit(CL_NOTE_HUNG, { noteId: p.noteId }).catch(() => undefined)
      })
    }).then((u) => {
      if (cancelled) u()
      else unlisten = u
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [addCard])

  const takeDown = useCallback(
    async (card: ClotheslineCard) => {
      setEditing(null)
      // ★2026-11-18 归档：便利签/随手记/番茄卡 × → 两选弹窗（归档 / 删除）。
      //   ★2026-11-19 录音卡 × → 两选弹窗（保存 / 不保存）；截图卡 × → 两选弹窗
      //   （归档 / 删除，归档页可查看并全屏预览）；贴图/图片/待办/剪贴板保持
      //   软删 + 10s 撤销不变。
      if (
        card.kind === 'note' ||
        card.kind === 'text' ||
        card.kind === 'timer' ||
        card.kind === 'audio' ||
        card.kind === 'shot'
      ) {
        setTakedownConfirm(card)
        return
      }
      try {
        await clRemoveCard(card.id)
        setCards((prev) => prev.filter((c) => c.id !== card.id))
        // ★2026-11-15 需求7：截图/贴图/图片卡不再有兜底标题，toast 文案退回类型名。
        setUndoCard({ id: card.id, label: t('clothesline.toast.takenDown', { name: card.title || kindLabel(card) }) })
        if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
        undoTimerRef.current = window.setTimeout(() => setUndoCard(null), UNDO_TOAST_MS)
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCards, setEditing, setUndoCard],
  )

  /** ★2026-11-19 反馈3：弹窗动画已删，即时关闭（保留异步边界防同帧 setState 嵌套）。 */
  const closeTakedownAnimated = useCallback((after?: () => void) => {
    if (takedownClosing) return
    setTakedownClosing(true)
    window.setTimeout(() => {
      setTakedownClosing(false)
      setTakedownConfirm(null)
      after?.()
    }, 0)
  }, [takedownClosing])

  /** ★2026-11-18 归档：两选弹窗的执行（归档 / 永久删除）。
      ★2026-11-19 录音卡两选：audio-save=让主窗引擎落盘（saved 广播回绳窗后
      自动取下卡片）；audio-discard=丢弃录音（abort 停引擎）+ 直接取下卡片。 */
  const confirmTakedown = useCallback(
    (card: ClotheslineCard, mode: 'archive' | 'delete' | 'audio-save' | 'audio-discard') => {
      closeTakedownAnimated(() => {
        void (async () => {
          try {
            if (mode === 'audio-save') {
              await emit(CL_RECORDER_CMD, { action: 'save', title: card.title })
              return
            }
            if (mode === 'audio-discard') {
              audioStateRef.current = null
              setAudioState(null)
              try {
                await emit(CL_RECORDER_CMD, { action: 'abort' })
              } catch {
                /* 引擎可能已停，忽略 */
              }
              await clRemoveCard(card.id)
              setCards((prev) => prev.filter((c) => c.id !== card.id))
              flash(t('clothesline.toast.discarded'))
              return
            }
            if (mode === 'archive') {
              // ★2026-11-22 同窗飞出：先给卡片挂飞出 class，动画结束再落库，
              // 否则 clArchiveCard 广播 CL_CARDS_CHANGED 会把卡从 DOM 移除、飞不起来。
              // 终点按 dockSide 动态算到工具窗所在的屏幕边缘（对齐确认过的预览），
              // 不再写死 180px 右上 —— 那时工具窗靠左时方向是反的、距离也太短。
              const el = document.querySelector(`[data-cl-card-id="${card.id}"]`)
              const r = el?.getBoundingClientRect()
              const cx = r ? r.left + r.width / 2 : window.innerWidth / 2
              const cy = r ? r.top + r.height / 2 : 60
              const targetX = readDockSide() === 'right' ? window.innerWidth - 24 : 24
              const targetY = 48 // 顶栏归档图标高度附近
              setArchiveFly({
                id: card.id,
                dx: Math.round(targetX - cx),
                dy: Math.round(targetY - cy),
              })
              await new Promise((r) => window.setTimeout(r, ARCHIVE_FLY_MS))
              if (card.kind === 'note') {
                // 绳上便利签卡 = 桌面便利签的引用 → 主窗编排「一体归档」（note + card）。
                void emit(CL_ARCHIVE_CARD, {
                  action: 'archive',
                  cardId: card.id,
                  noteId: card.note_id ?? undefined,
                } satisfies ClArchiveCard).catch(() => undefined)
                setCards((prev) => prev.filter((c) => c.id !== card.id))
              } else {
                await clArchiveCard(card.id)
                setCards((prev) => prev.filter((c) => c.id !== card.id))
              }
              setArchiveFly(null)
              // 飞入落地 → 主窗顶栏归档角标 +1 脉冲（预览里的「到达反馈」）。
              void emit(CL_ARCHIVE_LANDED, { source: 'rope' } satisfies ClArchiveLanded).catch(() => undefined)
              flash(t('clothesline.toast.archived'))
            } else {
              // 删除 = 永久删除（弹窗本身即确认，无撤销）：软删 + 立即物理清除两连击。
              if (card.kind === 'note') {
                void emit(CL_ARCHIVE_CARD, {
                  action: 'delete-note',
                  cardId: card.id,
                  noteId: card.note_id ?? undefined,
                } satisfies ClArchiveCard).catch(() => undefined)
                setCards((prev) => prev.filter((c) => c.id !== card.id))
              } else {
                await clRemoveCard(card.id)
                await clDeleteArchived(card.id)
                setCards((prev) => prev.filter((c) => c.id !== card.id))
              }
              flash(t('clothesline.toast.deleted'))
            }
          } catch (e) {
            flash(e instanceof Error ? e.message : String(e))
          }
        })()
      })
    },
    [closeTakedownAnimated, flash, setCards, setAudioState],
  )

  const undoTakeDown = useCallback(async () => {
    const u = undoCard
    if (!u) return
    try {
      const card = await clRestoreCard(u.id)
      setCards((prev) => sortCards([...prev.filter((c) => c.id !== card.id), card]))
      setUndoCard(null)
      flash(t('clothesline.toast.restored'))
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }, [undoCard, flash, setCards, setUndoCard])

  /** ★2026-11-15 反馈4：便利签 / 随手记卡字号循环调节（100% → 85% → 72% → 115% → 100%）。
   *  真源是 card.font_scale（Rust 落盘，重启保留）；CSS 侧 --cl-card-fs 消费。 */
  const cycleFont = useCallback(
    async (card: ClotheslineCard) => {
      const cur = card.font_scale ?? 1
      const idx = FONT_SCALES.findIndex((s) => Math.abs(s - cur) < 0.01)
      const next = FONT_SCALES[(idx + 1 + FONT_SCALES.length) % FONT_SCALES.length]
      try {
        const updated = await clUpdateCard(card.id, { font_scale: next })
        setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
        flash(t('clothesline.toast.fontScale', { n: Math.round(next * 100) }))
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash, setCards],
  )

  /** ★2026-11-15 反馈3：截图 / 贴图 / 图片 / 随手记卡的编辑入口走桌面居中弹窗
   *  （标题 + 内容两栏）；其余类型保持原有行内编辑。 */
  const openCardEditor = useCallback((card: ClotheslineCard) => {
    setEditing(null)
    const isText = card.kind === 'text'
    setEditModal({
      id: card.id,
      title: card.title,
      // ★2026-11-24 问题4：text 卡保留原始正文（富文本含 @@RICH@@ 前缀），编辑弹窗
      // 用富文本编辑器整段还原（格式与全局速记一致）；非 text 卡仍是纯文本 textarea。
      text: card.text,
      // ★批12：随手记卡带字体格式编辑段（其余类型不显示）。
      fmt: isText ? cardTextFormat(card) : undefined,
      // ★2026-11-23：随手记卡带出分类编辑（共享分类表，每次打开重新读取）。
      category: isText ? (card.category ?? '') : undefined,
      cats: isText ? loadCategories() : undefined,
      newCat: '',
      addingCat: false,
    })
  }, [])

  const commitEditModal = useCallback(async () => {
    const m = editModal
    if (!m) return
    // ★2026-11-24 问题4：text 卡正文由富文本编辑器提供，落库格式与全局速记一致。
    let body = m.text
    if (m.fmt) {
      const editor = editEditorRef.current
      const rawHtml = editor?.innerHTML ?? ''
      const plain = (editor?.innerText ?? m.text).trim()
      body = hasRichMarkup(rawHtml) ? RICH_PREFIX + sanitizeRichHtml(rawHtml) : plain
    }
    // ★批12：随手记字体格式增量补丁（DoubleOption：null=清空回默认）。
    //   加粗默认开 → true 时清空（走默认 800）；关闭时显式写 false。
    const f = m.fmt
    const fmtPatch = f
      ? {
          title_size: f.titleSize,
          body_size: f.bodySize,
          font_family: f.family || null,
          title_bold: f.titleBold ? null : false,
          title_italic: f.titleItalic ? true : null,
          body_bold: f.bodyBold ? true : null,
          body_italic: f.bodyItalic ? true : null,
        }
      : {}
    // ★2026-11-23：随手记卡的分类增量补丁（仅 text 卡带 category）。
    const catPatch: CardPatch = m.fmt ? { category: (m.category ?? '').trim() || null } : {}
    try {
      const updated = await clUpdateCard(m.id, { title: m.title.trim(), text: body, ...fmtPatch, ...catPatch })
      setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      setEditModal(null)
      flash(t('clothesline.toast.saved'))
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }, [editModal, flash, setCards])

  // ★2026-11-24 问题4：编辑弹窗（text 卡）打开时把原始正文一次性还原进富文本编辑器。
  useEffect(() => {
    if (!editModal?.fmt) return
    const el = editEditorRef.current
    if (!el) return
    const raw = editModal.text
    if (isRichText(raw)) el.innerHTML = sanitizeRichHtml(raw.slice(RICH_PREFIX.length))
    else el.textContent = raw
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editModal?.id])

  /** 番茄卡上的暂停 / 继续 / 重置 / +5 分（原型 .tm-btns）。
   *  ⚠️ 全部走 clUpdateCard 增量写盘，Rust 单一写锁不变；fired_at 清空避免重复通知。 */
  const timerAction = useCallback(
    async (card: ClotheslineCard, action: TimerAction) => {
      const now = Date.now()
      const countup = card.timer_direction === 'countup'
      let patch: CardPatch
      if (action === 'pause') {
        if (card.end_at == null) return
        // ★2026-11-15 反馈4 修复：暂停冻结值按方向区分 —— 倒计时冻结「剩余」，
        //   正计时冻结「已计时长」（旧版一律存 end_at-now，正计时存成了剩余，
        //   暂停后圆环显示的不是当前计时值；计时到尾后暂停则直接是 00:00）。
        //   同时落 timer_total_ms（正计时暂停后 end_at 已空，总时长唯一真源）。
        const frozen = countup ? Math.max(0, now - card.created_at) : Math.max(0, card.end_at - now)
        patch = { elapsed_before_pause_ms: frozen, timer_total_ms: Math.max(60_000, card.end_at - card.created_at), end_at: null }
      } else if (action === 'resume') {
        const frozen = Math.max(0, card.elapsed_before_pause_ms || 0)
        const total = card.timer_total_ms ?? Math.max(60_000, (card.end_at ?? now + frozen) - card.created_at)
        const remaining = countup ? Math.max(0, total - frozen) : frozen
        patch = { end_at: now + remaining, elapsed_before_pause_ms: 0, timer_total_ms: total, fired_at: null }
      } else if (action === 'reset') {
        // 旧版对暂停中的卡算出 total=0 → 被钳成 1 分钟；优先用 timer_total_ms。
        // ★2026-11-18 重置语义按方向区分：倒计时恢复到初始设定时长（剩余=total）；
        //   正计时从 0 重新计 —— 显示=now-created_at，必须重设 created_at 锚点
        //   （旧版只推 end_at，正计时的显示与圆环根本不变，重置等于无效）。
        //   两种方向统一重设锚点 + end_at=now+total。
        const total = card.timer_total_ms ?? Math.max(60_000, (card.end_at ?? now) - card.created_at)
        patch = { created_at: now, end_at: now + total, elapsed_before_pause_ms: 0, timer_total_ms: total, fired_at: null }
      } else {
        if (card.end_at != null) {
          patch = { end_at: card.end_at + 5 * 60_000, timer_total_ms: Math.max(60_000, (card.timer_total_ms ?? card.end_at - card.created_at) + 5 * 60_000), fired_at: null }
        } else {
          const frozen = Math.max(0, card.elapsed_before_pause_ms || 0)
          const total = card.timer_total_ms ?? Math.max(60_000, frozen)
          const remaining = countup ? Math.max(60_000, total - frozen) : Math.max(60_000, frozen)
          patch = { end_at: now + remaining + 5 * 60_000, elapsed_before_pause_ms: 0, timer_total_ms: total + 5 * 60_000, fired_at: null }
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
    const sf = mon.scale_factor || 1
    // ★2026-11-15 需求10：横带高度随卡片尺寸放大，anchor 上限同步放行。
    const cs = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
    const ropeH = Math.round(EXPANDED_CSS_H * cs * sf)
    // PRD §5.12「顶部 40% / 360 逻辑px」——anchor_y 与拖动位移都是**物理像素**，
    // 所以 360 必须乘 sf 再比，否则 150% 屏上只能拖 240 逻辑px（高度上限提前触发）。
    return Math.max(0, Math.min(Math.round(360 * sf), Math.floor(mon.height * 0.4), mon.height - ropeH - 24))
  }, [])

  /** 逐帧应用拖动位置（展开态拖绳会话）。x 是**屏幕绝对物理像素**的面板 x（已由
   *  调用方在 [minX, maxX] 内钳好；这里绝不再做「比例 → 位置」的反推）。
   *  ★第二十一轮绳带窄窗：水平位移只改 CSS 变量（横带窗口恒为整屏宽，x=mon.x 不动）；
   *  垂直位移改 anchor → 窗口本体 y 跟随，走 clSetPosition（只改位置零重排零 resize）。 */
  const moveWindowXY = useCallback((x: number, y: number) => {
    const geom = geomRef.current
    if (!geom) return
    // 同步几何缓存：下一次拖动的起点读它，保证「视觉停在哪，逻辑就在哪」（问题1）。
    geom.winX = x
    geom.anchorY = y
    geom.panelY = geom.expanded ? y : 0
    if (geom.expanded) {
      const ny = geom.mon.y + geom.panelY
      if (ny !== geom.winRect.y) {
        geom.winRect = { ...geom.winRect, x: geom.mon.x, y: ny }
        void clSetPosition(geom.mon.x, ny).catch(() => undefined)
      }
      applyPanelVars(geom)
    }
  }, [applyPanelVars])

  const scheduleMoveXY = useCallback(
    (x: number, y: number) => {
      pendingMoveRef.current = { x, y }
      if (ropeFrameRef.current !== null) return
      ropeFrameRef.current = window.requestAnimationFrame(() => {
        ropeFrameRef.current = null
        const p = pendingMoveRef.current
        if (p) moveWindowXY(p.x, p.y)
      })
    },
    [moveWindowXY],
  )

  /** 像素 x → 持久化比例（只用于落盘 / 重启还原）。范围退化时保留原比例。 */
  const ratioOfX = useCallback((x: number, fallback: number) => {
    const geom = geomRef.current
    if (!geom || geom.maxX <= geom.minX) return fallback
    const r = (x - geom.minX) / (geom.maxX - geom.minX)
    return Math.min(1, Math.max(0, r))
  }, [])

  // 问题4：拖动全窗（专用把手 + 麻绳热区共用同一会话），同时支持上下（anchor_y）与左右。
  const beginWindowDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!expandedRef.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const geom = geomRef.current
      const baseY = geom?.anchorY ?? settings?.anchor_y ?? 72
      ropeDragRef.current = {
        startSX: e.screenX,
        startSY: e.screenY,
        dpr: window.devicePixelRatio || geom?.mon.scale_factor || 1,
        startAnchor: baseY,
        // ★问题1 真根因修复：起点 x 一律取**窗口当前真实物理位置**（geom.winX），
        //   不再取 settings.win_x_ratio。旧版只要磁盘里残留一个极端比例（实测 1.0），
        //   拖动一开局就顶在 clamp 上 → 往右完全不动、只有往左能动。
        startX: geom?.winX ?? 0,
        minX: geom?.minX ?? 0,
        maxX: geom?.maxX ?? 0,
        startRatio: ratioOfX(geom?.winX ?? 0, settings?.win_x_ratio ?? 0.5),
        nextY: baseY,
        nextX: geom?.winX ?? 0,
        moved: false,
      }
      setDraggingRope(true) // 冻结绳身摆动，避免拖动时抖动（问题5 配套）。
      // 拖动全程持续强制可点：窗口随拖动移动，命中矩形每帧重算前若被判穿透，
      // pointermove 会丢失导致拖到一半卡住。900ms 续期、松手即停（问题4）。
      void clSetForceClickable(1500)
      if (ropeKeepAliveRef.current !== null) window.clearInterval(ropeKeepAliveRef.current)
      ropeKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(1500), 900)
    },
    [ratioOfX, settings],
  )

  const moveWindowDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = ropeDragRef.current
      if (!d) return
      // ★屏幕绝对位移（物理像素）：与窗口当前位置完全无关 → 无振荡，1:1 跟手。
      const dx = (e.screenX - d.startSX) * d.dpr
      const dy = (e.screenY - d.startSY) * d.dpr
      if (Math.abs(dx) < 3 * d.dpr && Math.abs(dy) < 3 * d.dpr && !d.moved) return
      d.moved = true
      const nextY = Math.round(Math.min(anchorMax(), Math.max(0, d.startAnchor + dy)))
      // ★问题1：水平位移直接作用在**像素 x** 上，再在 [minX, maxX] 内钳制。
      //   1:1 跟手、左右对称，且永远以真实位置为基准（不再有「比例顶到 1.0 卡死」）。
      const nextX = Math.round(Math.min(d.maxX, Math.max(d.minX, d.startX + dx)))
      d.nextY = nextY
      d.nextX = nextX
      scheduleMoveXY(nextX, nextY)
    },
    [anchorMax, scheduleMoveXY],
  )

  const endWindowDrag = useCallback(() => {
    const d = ropeDragRef.current
    ropeDragRef.current = null
    if (ropeFrameRef.current !== null) {
      window.cancelAnimationFrame(ropeFrameRef.current)
      ropeFrameRef.current = null
    }
    if (ropeKeepAliveRef.current !== null) {
      window.clearInterval(ropeKeepAliveRef.current)
      ropeKeepAliveRef.current = null
    }
    setDraggingRope(false)
    if (!d || !d.moved) return
    const nextY = Math.min(anchorMax(), Math.max(0, d.nextY))
    const nextRatio = ratioOfX(d.nextX, d.startRatio)
    const patch: Partial<ClotheslineSettings> = {}
    if (nextY !== d.startAnchor) patch.anchor_y = nextY
    // 展开态麻绳拖动只写 win_x_ratio（展开态专用），收起态拉杆比例原样保留。
    if (Math.abs(nextRatio - d.startRatio) > 0.001) patch.win_x_ratio = nextRatio
    if (Object.keys(patch).length) {
      void clUpdateSettings(patch).then((next) => setSettings(next)).catch(() => undefined)
    }
    if (nextY >= anchorMax() && nextY !== d.startAnchor) flash(t('clothesline.toast.topBoundary'))
    // ★拖动后只刷新命中矩形与 CSS 变量（零窗口写入），杜绝松手瞬间再抖一下。
    const mon = geomRef.current?.mon
    if (mon) void placeAndArm(nextY, expandedRef.current, mon, settings?.pulltab_x_ratio ?? 0.5, nextRatio, false, d.nextX)
  }, [anchorMax, flash, placeAndArm, ratioOfX, settings])

  const onPullPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      const geom = geomRef.current
      pullDragRef.current = {
        startSX: e.screenX,
        startSY: e.screenY,
        dpr: window.devicePixelRatio || geom?.mon.scale_factor || 1,
        // ★问题1：起点一律取窗口**真实物理 x**（geom.winX）+ 允许范围，
        //   与展开态同一套像素语义；旧版拿 settings.win_x_ratio 当起点，
        //   磁盘里一旦残留 1.0 就「只能往左拉」。
        startX: geom?.winX ?? 0,
        minX: geom?.minX ?? 0,
        maxX: geom?.maxX ?? 0,
        // 收起态拉杆的拖动起点比例读 pulltab_x_ratio，绝不读展开态的 win_x_ratio。
        startRatio: ratioOfX(geom?.winX ?? 0, settings?.pulltab_x_ratio ?? 0.5),
        nextX: geom?.winX ?? 0,
        mode: 'none',
        pull: 0,
        moved: false,
        monY: geom?.mon.y ?? 0,
      }
      // 收起态窗口默认穿透：拖动全程必须持续「临时强制可点」，否则 pointermove 会断。
      void clSetForceClickable(1500)
      if (pullKeepAliveRef.current !== null) window.clearInterval(pullKeepAliveRef.current)
      pullKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(1500), 900)
    },
    [ratioOfX, settings],
  )

  /** 下拉进度写到 DOM 变量（直接改样式，不 setState → 不触发整棵卡片树重渲染）。 */
  const setPullProgress = useCallback((v: number) => {
    const el = pullTabRef.current
    if (!el) return
    el.style.setProperty('--cl-pull', Math.max(0, Math.min(1, v)).toFixed(3))
    el.classList.toggle('is-pulling', v > 0.004)
  }, [])

  const onPullPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = pullDragRef.current
    if (!d) return
    // ★屏幕绝对位移（物理像素），同展开态：杜绝窗口移动反向改写位移的正反馈。
    const dx = (e.screenX - d.startSX) * d.dpr
    const dy = (e.screenY - d.startSY) * d.dpr
    // 方向阈值仲裁：水平 >8 逻辑px 判「拉杆平移」，垂直 >24 逻辑px 判「下拉展开」（PRD §4.7）。
    // ⚠️ dx/dy 现在是物理像素，阈值必须乘 dpr，否则高 DPI 下会过早/过晚判定方向。
    if (d.mode === 'none') {
      // 下拉反馈：还没到判定阈值时也先让绳子「绷一下」，手感才像真拉绳（问题4）。
      if (dy > 2 * d.dpr && dy >= Math.abs(dx)) setPullProgress(dy / (56 * d.dpr))
      if (Math.abs(dx) > 8 * d.dpr && Math.abs(dx) >= Math.abs(dy)) d.mode = 'horizontal'
      else if (dy > 24 * d.dpr) d.mode = 'vertical'
      else return
      d.moved = true
    }
    if (d.mode === 'horizontal') {
      setPullProgress(0) // 判定为平移 → 立刻收回下拉形变，避免两种动效打架
      // ★问题1：与展开态同一套「像素真源」——x = clamp(真实 x + dx)。
      //   旧版按 availW/panelW 反算比例，窗口只有 520 宽、travel 巨大，
      //   一旦比例顶到 1.0 往右就彻底不动（用户实测的「拉杆也只能往左」）。
      const x = Math.round(Math.min(d.maxX, Math.max(d.minX, d.startX + dx)))
      d.nextX = x
      pendingPullXRef.current = x
      if (pullFrameRef.current !== null) return
      pullFrameRef.current = window.requestAnimationFrame(() => {
        pullFrameRef.current = null
        const px = pendingPullXRef.current
        if (px === null) return
        const geom = geomRef.current
        if (!geom) return
        // ★第二十一轮绳带窄窗：窗口本体（56sf 拉手小窗，2026-11-15 需求8）随拉手整体平移
        //   —— clSetPosition 逐帧只改位置、零 resize 零重排；面板盒 480 逻辑px 相对窗口
        //   的偏移恒为 -152 逻辑px（面板 x = 窗体 x + 28sf），内容随窗口走，无需逐帧写变量。
        const sf = geom.mon.scale_factor || 1
        const wx = px + Math.round(240 * sf) - Math.round(28 * sf)
        void clSetPosition(wx, d.monY).catch(() => undefined)
        geom.winX = px // 同步真源：下一次拖动从视觉位置起算
        geom.winRect = { ...geom.winRect, x: wx, y: d.monY }
      })
    } else if (d.mode === 'vertical') {
      // 下拉到底：绳子被拉到最长，继续下拉不再变化（避免拉出窗口外）。
      setPullProgress(Math.min(1, dy / (56 * d.dpr)))
    }
  }, [setPullProgress])

  const onPullPointerUp = useCallback(() => {
    const d = pullDragRef.current
    pullDragRef.current = null
    pullMovedRef.current = d?.moved ?? false
    if (pullFrameRef.current !== null) {
      window.cancelAnimationFrame(pullFrameRef.current)
      pullFrameRef.current = null
    }
    pendingPullXRef.current = null
    if (pullKeepAliveRef.current !== null) {
      window.clearInterval(pullKeepAliveRef.current)
      pullKeepAliveRef.current = null
    }
    setDragRatio(null)
    // 松手：先摘掉 is-pulling（恢复 transition），再把进度归零 → 拉绳/拉手弹回原位。
    const el = pullTabRef.current
    if (el) {
      el.classList.remove('is-pulling')
      el.classList.add('is-released')
      el.style.setProperty('--cl-pull', '0')
      window.setTimeout(() => el.classList.remove('is-released'), 420)
    }
    if (!d) return
    if (d.mode === 'horizontal') {
      const nextRatio = ratioOfX(d.nextX, d.startRatio)
      // ★两态解绑：拉杆只写 pulltab_x_ratio，展开态的 win_x_ratio 原样不动。
      //   旧版这里写 win_x_ratio，还把 nextRatio 当成第 5 参传给 placeAndArm，
      //   等于把拉杆位置同时写进晾衣绳 → 收起/展开必然互相带着跑。
      void clUpdateSettings({ pulltab_x_ratio: nextRatio })
        .then((next) => setSettings(next))
        .catch(() => undefined)
      const mon = geomRef.current?.mon
      if (mon) {
        void placeAndArm(
          settings?.anchor_y ?? 72,
          false,
          mon,
          nextRatio,                       // 收起态：拉杆自己的新比例
          settings?.win_x_ratio ?? 0.5,     // 展开态：晾衣绳比例保持不动
          false,
          d.nextX,                          // 同态像素真源，视觉不跳
        )
      }
      // ★批14：去掉「拉杆水平位置 X% · 已保存」toast——收起态窗口就是拉手本体，
      //   面板居中的黑底 toast 恰好贴在拉手正下方，看起来像异常黑色浮窗。
    } else if (d.mode === 'vertical') {
      void toggleExpanded()
    }
  }, [flash, toggleExpanded, placeAndArm, ratioOfX, settings])

  /** ＋菜单「显示屏幕」：多屏时循环切下一屏；只写盘，重定位交给设置变更广播，避免重复摆位。 */
  const cycleMonitor = useCallback(async () => {
    try {
      const ms = await clGetMonitors()
      if (ms.length < 2) {
        flash(t('clothesline.toast.singleScreen'))
        return
      }
      const cur = geomRef.current?.mon.stable_id ?? ''
      const i = ms.findIndex((m) => m.stable_id === cur)
      const next = ms[(i + 1) % ms.length]
      if (!next) return
      await clUpdateSettings({ monitor_stable_id: next.stable_id })
      flash(t('clothesline.toast.switchedScreen', { name: next.name || t('clothesline.toast.anotherScreen') }))
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
      try {
        if (card.kind === 'note' && card.note_id) await emit(CL_OPEN_NOTE, { id: card.note_id })
        else if (card.kind === 'task' && card.task_id) await emit(CL_OPEN_TASK, { id: card.task_id })
        else flash(t('clothesline.toast.selfContained'))
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [flash],
  )

  /** ★2026-11-15 需求5/6：新增/编辑弹窗的表单态（标题 / 正文 / 颜色 / 计时专属字段）。
   *  上次选中的计时分钟数持久化在 localStorage —— 下次打开番茄钟弹窗默认带出。 */
  const TIMER_LAST_MIN_KEY = 'todobar.clothesline.lastTimerMin'
  const [composeTitle, setComposeTitle] = useState('')
  const [composeDirection, setComposeDirection] = useState<'countdown' | 'countup'>('countdown')
  const [composeColor, setComposeColor] = useState('')
  /** ★2026-11-17 需求1：番茄卡样式 7 选 1 —— 经典(paper，旧 minimal/glass 也归经典视觉) +
      怀表 watch / 车票 ticket / 掌机 lcd / 罐头 can / 小黑板 board / 灯牌 marquee。 */
  const [composeStyle, setComposeStyle] = useState<TimerStyleKey>('paper')
  /** ★2026-11-15 反馈批9：随手记卡样式（创建时可选）——晨雾渐变 / 和纸胶带 / 墨夜磁贴。 */
  const [composeTextStyle, setComposeTextStyle] = useState<'mist' | 'tape' | 'night'>('mist')
  /** ★批12：随手记字体格式（标题/内容独立字号 + 字体族 + 加粗/倾斜）。 */
  const [composeFormat, setComposeFormat] = useState<TextFormat>(TEXT_FMT_DEFAULT)
  const [composeRemind, setComposeRemind] = useState(true)
  /** 必填校验错误提示（2026-11-15 反馈4：标题/任务名必填，否则不允许保存）。 */
  const [composeErr, setComposeErr] = useState('')
  /** ★2026-11-15 反馈4：编辑既有番茄卡时记录目标卡 id（null=新增）。 */
  const [composeEditId, setComposeEditId] = useState<string | null>(null)

  // ★2026-11-24 问题3/4：随手记弹窗（新建/编辑）复用全局速记的富文本正文编辑器
  //（contentEditable + qn 工具行）。editorRef 的 innerHTML 是正文真源，composeText /
  // editModal.text 只是 innerText 镜像（供空值校验与依赖数组），落库前统一走
  // hasRichMarkup → '@@RICH@@' + 净化 HTML 的存储格式（与全局速记完全一致）。
  const composeEditorRef = useRef<HTMLDivElement>(null)
  const editEditorRef = useRef<HTMLDivElement>(null)
  // openComposer('text', init) 预填的原始正文（富文本卡含 @@RICH@@ 前缀），
  // 弹窗切到 text 分支后由 effect 一次性还原进编辑器。
  const composeEditorInitRef = useRef('')
  const styleWithCssOnceRef = useRef(false)
  if (!styleWithCssOnceRef.current) {
    styleWithCssOnceRef.current = true
    document.execCommand('styleWithCSS', false, 'true')
  }
  const syncComposeText = useCallback(
    () => setComposeText(composeEditorRef.current?.innerText ?? ''),
    [],
  )
  const composeFmt = useCallback((cmd: string, value?: string) => {
    composeEditorRef.current?.focus()
    document.execCommand(cmd, false, value)
    setComposeText(composeEditorRef.current?.innerText ?? '')
  }, [])
  const editFmt = useCallback((cmd: string, value?: string) => {
    editEditorRef.current?.focus()
    document.execCommand(cmd, false, value)
    setEditModal((m) => (m ? { ...m, text: editEditorRef.current?.innerText ?? '' } : m))
  }, [])

  const submitCompose = useCallback(async () => {
    if (composing === 'timer') {
      if (!composeTitle.trim()) {
        setComposeErr(t('clothesline.compose.errTaskName'))
        return
      }
      setComposeErr('')
      const min = Math.min(720, Math.max(1, Number(composeMinutes) || 25))
      try {
        window.localStorage.setItem(TIMER_LAST_MIN_KEY, String(min))
      } catch { /* 隐私模式等场景写入失败可忽略 */ }
      if (composeEditId) {
        // 编辑既有番茄卡：设置立即生效并按新时长重新计时。
        try {
          const updated = await clUpdateCard(composeEditId, {
            title: composeTitle.trim(),
            timer_direction: composeDirection,
            end_at: Date.now() + min * 60_000,
            elapsed_before_pause_ms: 0,
            timer_total_ms: min * 60_000,
            fired_at: null,
            // ★2026-11-17 问题3：番茄卡配色严格按设计图，不再落自定义卡色
            //（编辑保存顺带清掉旧数据里残留的 card_color）。
            card_color: null,
            card_style: composeStyle,
            remind: composeRemind,
          })
          setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
          setNowTick(Date.now())
          setComposing(null)
          flash(t('clothesline.toast.savedRetimed'))
        } catch (e) {
          flash(e instanceof Error ? e.message : String(e))
        }
        return
      }
      const ok = await addCard('timer', {
        title: composeTitle.trim() || t('clothesline.compose.defaultTimerTitle', { n: min }),
        text: '',
        end_at: Date.now() + min * 60_000,
        timer_direction: composeDirection,
        timer_elapsed_mode: 'wallclock',
        card_color: null, // ★2026-11-17 问题3：番茄卡配色严格按设计图。
        card_style: composeStyle,
        remind: composeRemind,
      })
      // ★2026-11-23 需求：满额失败走 toast 提示（addCard 内已按会员态映射文案），
      //   不再在弹窗内联显示「挂上失败」；toast 层级已提到弹窗之上保证可见。
      if (ok) setComposing(null)
      return
    }
    // ★2026-11-24 问题3/4：正文改由富文本编辑器（qn 系）提供，落库格式与全局速记一致：
    // 有真实格式标记 → '@@RICH@@' + 净化 HTML；纯文本/纯换行 → 纯文本。
    const editor = composeEditorRef.current
    const plain = (editor?.innerText ?? composeText).trim()
    if (!composeTitle.trim()) {
      setComposeErr(t('clothesline.compose.errTitle'))
      return
    }
    setComposeErr('')
    if (!plain) {
      setComposing(null)
      return
    }
    const rawHtml = editor?.innerHTML ?? ''
    const body = hasRichMarkup(rawHtml) ? RICH_PREFIX + sanitizeRichHtml(rawHtml) : plain
    const ok = await addCard('text', {
      title: composeTitle.trim(),
      text: body,
      card_color: composeColor || null,
      card_style: composeTextStyle,
      // ★2026-11-23：随手记分类（与全局速记窗共享，保存即记住供下次带出）。
      category: composeCategory.trim() || null,
      // ★批12：字体格式（创建 = 完整卡对象；null 字段 = 默认）。
      title_size: composeFormat.titleSize,
      body_size: composeFormat.bodySize,
      font_family: composeFormat.family || null,
      title_bold: composeFormat.titleBold,
      title_italic: composeFormat.titleItalic,
      body_bold: composeFormat.bodyBold,
      body_italic: composeFormat.bodyItalic,
    })
    if (ok) {
      saveLastCategory(composeCategory.trim())
      setComposeText('')
      if (composeEditorRef.current) composeEditorRef.current.innerHTML = ''
      setComposeTitle('')
      setComposing(null)
    }
  }, [composing, composeEditId, composeMinutes, composeTitle, composeDirection, composeColor, composeStyle, composeTextStyle, composeFormat, composeRemind, composeText, composeCategory, addCard, clUpdateCard, flash, setCards, setNowTick, setComposing, setComposeText])

  // ★2026-11-24：compose text 弹窗打开时，把 openComposer 暂存的 init 原文一次性
  // 还原进编辑器（富文本剥 @@RICH@@ 前缀 + 净化；纯文本 textContent；无 init 清空）。
  useEffect(() => {
    if (composing !== 'text') return
    const el = composeEditorRef.current
    if (!el) return
    const raw = composeEditorInitRef.current
    if (raw && isRichText(raw)) el.innerHTML = sanitizeRichHtml(raw.slice(RICH_PREFIX.length))
    else if (raw) el.textContent = raw
    else el.innerHTML = ''
    composeEditorInitRef.current = ''
  }, [composing])

  /** ★2026-11-15 需求5/6：打开添加/编辑弹窗（桌面居中）。番茄钟默认带出上次时长。
   *  ★反馈4：传入 init（既有卡）时预填该卡设置并把弹窗切到「编辑」模式
   *  （番茄卡右上角 ✎ 即走这里，不再使用行内文本框）。 */
  const openComposer = useCallback((kind: 'text' | 'timer', init?: ClotheslineCard) => {
    setComposeErr('')
    setComposeEditId(init?.id ?? null)
    if (kind === 'timer') {
      if (init) {
        const totalMs = init.timer_total_ms ?? Math.max(60_000, (init.end_at ?? Date.now()) - init.created_at)
        setComposeMinutes(String(Math.min(720, Math.max(1, Math.round(totalMs / 60_000)))))
        setComposeDirection(init.timer_direction === 'countup' ? 'countup' : 'countdown')
        // 旧值 minimal/glass 仍按经典视觉渲染，编辑时归入「经典」选择。
        setComposeStyle(
          init.card_style && TIMER_STYLE_KEYS.includes(init.card_style as TimerStyleKey)
            ? (init.card_style as TimerStyleKey)
            : 'paper',
        )
        setComposeRemind(init.remind ?? true)
      } else {
        let saved = ''
        try { saved = window.localStorage.getItem(TIMER_LAST_MIN_KEY) ?? '' } catch { /* 忽略 */ }
        const n = Math.min(720, Math.max(1, Number(saved) || 25))
        setComposeMinutes(String(n))
        setComposeDirection('countdown')
        setComposeStyle('paper')
        setComposeRemind(true)
      }
    }
    if (kind === 'text') {
      // ★2026-11-15 反馈批9：随手记样式预填（openComposer('text', init) 预留编辑路径）。
      setComposeTextStyle(init && (init.card_style === 'tape' || init.card_style === 'night') ? init.card_style : 'mist')
      // ★批12：字体格式预填（编辑既有卡带出；新建回默认）。
      setComposeFormat(init ? cardTextFormat(init) : { ...TEXT_FMT_DEFAULT })
      // ★2026-11-23：分类表每次打开重新读（可能与速记窗间有新增）；
      //  编辑带出卡片自身分类，新建则默认带出上次选中的分类。
      const cats = loadCategories()
      setComposeCats(cats)
      setComposeCategory(init ? (init.category ?? '') : loadLastCategory())
      setComposeNewCat('')
      setComposeAddingCat(false)
    }
    setComposeTitle(init?.title ?? '')
    // ★2026-11-17 问题3：番茄卡不再支持自定义卡色（弹窗已隐藏色板），预填恒空。
    setComposeColor(kind === 'timer' ? '' : (init?.card_color ?? ''))
    // ★2026-11-24 问题3/4：正文真源是 contentEditable 编辑器；init 原文暂存，
    // 弹窗切到 text 分支后由 effect 还原（富文本剥前缀 + 净化，纯文本 textContent）。
    composeEditorInitRef.current = init?.text ?? ''
    setComposeText(init ? richToPlain(init.text) : '')
    setAddSheetOpen(false)
    setComposing(kind)
  }, [setAddSheetOpen, setComposeColor, setComposeDirection, setComposeMinutes, setComposeRemind, setComposeStyle, setComposeTextStyle, setComposeText, setComposeTitle])

  /** 弹窗打开期间绳窗临时放大整屏（与预览同一套离散 resize 机制）：
   *  弹窗 fixed 居中于桌面；关闭（提交 / Esc / 点弹窗外被 Rust 判定为 outside）
   *  时缩回横带并还原命中矩形。周边不画遮罩 —— 「不带遮罩层」的语义。 */
  const composerKeepAliveRef = useRef<number | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)
  // 添加弹窗（随手记 / 番茄钟）与编辑弹窗共用同一套「临时整屏 + 点外关闭」机制。
  // ★2026-11-18 归档：取下确认弹窗（归档 / 删除）同样复用这套机制。
  // ★2026-11-20：操作指引弹窗（guideOpen）也走同一机制 —— 绳窗只有 ~300 逻辑 px 高，
  // 指引内容放不下，必须临时整屏展示。
  const fullscreenModal =
    (guideOpen ? 'guide' : null) ??
    composing ??
    (editModal ? 'edit' : null) ??
    (takedownConfirm ? 'takedown' : null)
  useEffect(() => {
    fullscreenModalRef.current = fullscreenModal !== null
  }, [fullscreenModal])
  // 弹窗打开期间命中矩形表 = 弹窗自身矩形（物理 px）。
  // ★2026-11-15 反馈2 根因：旧版写空数组，8 秒后 Rust 空表兜底回退到最近非空快照
  //   （= 横带矩形），此后点居中弹窗（横带之外）被 OS 轮询判为「点在外面」→
  //   触发 dismiss 把弹窗关掉 —— 表现为「颜色点了没反应（弹窗被关闭）」。
  //   改为上报弹窗矩形后：点弹窗内不再 dismiss（色板可正常选中），
  //   点弹窗外仍触发 dismiss 取消，语义与旧版一致且永不回退。
  useEffect(() => {
    const armModalHit = () => {
      const el = modalRef.current
      const g = geomRef.current
      if (!el || !g) return
      const r = el.getBoundingClientRect()
      const sf = g.mon.scale_factor
      void clSetHitRects([
        {
          x: g.mon.x + Math.round(r.left * sf) - 16,
          y: g.mon.y + Math.round(r.top * sf) - 16,
          width: Math.round(r.width * sf) + 32,
          height: Math.round(r.height * sf) + 32,
        },
      ]).catch(() => undefined)
    }
    if (!fullscreenModal) return
    // 弹窗尺寸稳定后测一次；clSetBounds 异步放大窗口会触发 resize → 重测
    // （fixed 居中的弹窗以视口为中心，窗口尺寸变化会移动弹窗）。
    const t1 = window.setTimeout(armModalHit, 140)
    const t2 = window.setTimeout(armModalHit, 480)
    window.addEventListener('resize', armModalHit)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.removeEventListener('resize', armModalHit)
    }
  }, [fullscreenModal, composing, editModal, takedownConfirm])
  useEffect(() => {
    if (!fullscreenModal) return
    const geom = geomRef.current
    if (!geom) return
    const full: ClRect = {
      x: geom.mon.x,
      y: geom.mon.y,
      width: geom.mon.width,
      height: geom.mon.height,
    }
    if (
      geom.winRect.x !== full.x ||
      geom.winRect.y !== full.y ||
      geom.winRect.width !== full.width ||
      geom.winRect.height !== full.height
    ) {
      geom.winRect = full
      void clSetBounds(full.x, full.y, full.width, full.height).catch(() => undefined)
    }
    // 命中矩形由上方 armModalHit effect 上报（= 弹窗自身矩形）；这里只开 dismiss。
    void clSetDismissOnOutside(true) // 点弹窗外 → CL_DISMISS_OVERLAY → 取消并还原
    void clSetForceClickable(2500)
    if (composerKeepAliveRef.current !== null) window.clearInterval(composerKeepAliveRef.current)
    composerKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(2500), 1000)
    return () => {
      if (composerKeepAliveRef.current !== null) {
        window.clearInterval(composerKeepAliveRef.current)
        composerKeepAliveRef.current = null
      }
      const g = geomRef.current
      if (g) {
        const band: ClRect = g.expanded
          ? { x: g.mon.x, y: g.mon.y + g.panelY, width: g.mon.width, height: g.ropeH }
          : { ...g.winRect }
        if (
          g.winRect.x !== band.x ||
          g.winRect.y !== band.y ||
          g.winRect.width !== band.width ||
          g.winRect.height !== band.height
        ) {
          g.winRect = band
          void clSetBounds(band.x, band.y, band.width, band.height).catch(() => undefined)
        }
        void clSetHitRects(panelHitRects(g)).catch(() => undefined)
      }
      void clSetDismissOnOutside(false)
      void clSetForceClickable(0)
    }
  }, [fullscreenModal, panelHitRects])

  // ★2026-11-20：＋菜单单屏显示。绳窗展开态只有 ~300 逻辑 px 高，9 个菜单项放不下，
  // 旧版只能在菜单内部滚动（用户反馈要去掉滚动条）。菜单打开时测量浮层内容底边，
  // 临时把窗口向下加高到刚好容纳（窗口透明，多出区域不可见），关闭时还原横带矩形。
  // 期间整窗可点（空命中表）：窗口加高后旧命中矩形只盖原高度，菜单下半段会点不到；
  // 点击菜单外空白由根 onClick 的 setAddSheetOpen(false) 兜底关闭。
  useEffect(() => {
    if (!addSheetOpen) return
    const g = geomRef.current
    const sheet = addSheetRef.current
    if (!g || !sheet || !g.expanded) return
    const sf = g.mon.scale_factor
    const needPhysical = Math.round((sheet.getBoundingClientRect().bottom + 8) * sf)
    if (needPhysical > g.winRect.height) {
      menuBoostRef.current = true
      void clSetBounds(g.winRect.x, g.winRect.y, g.winRect.width, needPhysical).catch(() => undefined)
      void clSetHitRects([]).catch(() => undefined)
    }
    void clSetForceClickable(2500)
    const keep = window.setInterval(() => void clSetForceClickable(2500), 1000)
    return () => {
      window.clearInterval(keep)
      menuBoostRef.current = false
      const gg = geomRef.current
      if (gg) {
        const band: ClRect = gg.expanded
          ? { x: gg.mon.x, y: gg.mon.y + gg.panelY, width: gg.mon.width, height: gg.ropeH }
          : { ...gg.winRect }
        void clSetBounds(band.x, band.y, band.width, band.height).catch(() => undefined)
        void clSetHitRects(panelHitRects(gg)).catch(() => undefined)
      }
      void clSetForceClickable(0)
    }
  }, [addSheetOpen, panelHitRects])

  // ★2026-11-20：首次启用晾衣绳自动弹一次操作指引。启用入口（设置页开关 / 顶栏开关）
  // 都会重建绳窗 → 挂载时检查一次即可覆盖。收起态不弹（弹窗依赖展开态几何还原），
  // 留到下次以展开态建窗时再弹；guide_shown 落盘后永不再打扰。
  useEffect(() => {
    let cancelled = false
    void clGetSettings()
      .then((s) => {
        if (cancelled || !s.enabled || s.guide_shown || !s.expanded) return
        setGuideOpen(true)
        void clUpdateSettings({ guide_shown: true }).catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /** 图片文件 → 缩略图落盘 → 挂绳。文件选择器与拖放共用这一条写入路径（问题9）。
   *  只用 DOM FileReader 压 ≤480px，不碰 asset://、不碰 shot-last、绝不写 prefs.json。 */
  const attachImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        flash(t('clothesline.toast.imageOnly'))
        return
      }
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
          el.onerror = () => reject(new Error(t('clothesline.image.decodeFail')))
          el.src = dataUrl
        })
        const scale = Math.min(1, 480 / Math.max(1, img.naturalWidth))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const seed = clMakeCard('image', { title: file.name, text: t('clothesline.image.local') })
        // ★2026-11-19 反馈2：落盘全分辨率原图（dataUrl 是文件原始数据），
        // 预览覆盖层优先显示它；缩略图只做卡片挂绳小图。
        void clSaveOriginal(seed.id, file.type || 'image/png', dataUrl).catch(() => undefined)
        const path = await clSavePreview(seed.id, canvas.toDataURL('image/png'))
        await addCard('image', { ...seed, src_path: path })
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err))
      }
    },
    [addCard, flash],
  )

  /** 文件选择器（下拉菜单「本地图片」）。 */
  const onPickImage = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      void attachImageFile(file)
    },
    [attachImageFile],
  )

  /** 问题9：拖图片入绳期间整窗保持可点。
   *  ★根因：透明命中窗平时 ignore_cursor_events=true，Windows 的 WS_EX_TRANSPARENT 让 OLE
   *    拖放也命中不到窗口 → drop 永远不触发；即便光标恰在热区让 dragenter 发生，一旦移出
   *    热区窗口又穿透、drop 丢失。修正：dragenter 后立即 clSetHitRects([])（整窗可点，不穿透）
   *    + 高频续期 force clickable，直到 drop / dragleave 结束才恢复真实热区。 */
  const dropArmRef = useRef(false)
  const armDrop = useCallback(() => {
    if (dropArmRef.current) return
    dropArmRef.current = true
    void clSetHitRects([]) // 空 = 整窗可点，拖放期间绝不穿透
    void clSetForceClickable(2500)
    if (dropKeepAliveRef.current !== null) window.clearInterval(dropKeepAliveRef.current)
    dropKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(2500), 900)
  }, [])
  const disarmDrop = useCallback(() => {
    if (!dropArmRef.current) return
    dropArmRef.current = false
    if (dropKeepAliveRef.current !== null) {
      window.clearInterval(dropKeepAliveRef.current)
      dropKeepAliveRef.current = null
    }
    void clSetForceClickable(0)
    // 预览态与拖放互斥：仅非预览时恢复真实热区（预览由自身整屏可点逻辑管）。
    if (previewCardIdRef.current === null) void refreshHitRects()
  }, [refreshHitRects])

  /** 用 dragenter/leave 计数抵消子元素冒泡，避免高亮闪烁。 */
  const onRootDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
    armDrop()
  }, [armDrop])
  const onRootDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    armDrop() // dragover 持续续期，覆盖「先从热区外进入」的边界
  }, [armDrop])
  const onRootDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragOver(false)
      disarmDrop()
    }
  }, [disarmDrop])
  const onRootDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepthRef.current = 0
      setDragOver(false)
      disarmDrop()
      const files = Array.from(e.dataTransfer?.files ?? [])
      const image = files.find((f) => f.type.startsWith('image/'))
      if (image) void attachImageFile(image)
      else if (files.length) flash(t('clothesline.toast.imageOnly'))
    },
    [attachImageFile, flash, disarmDrop],
  )

  /** 问题3/8：打开全屏大图预览。★第二十一轮绳带窄窗：窗口平时只是顶部横带，
   *  预览是**唯一**的「窗口临时放大」离散 resize——窗口放大到目标屏整屏（clSetBounds
   *  单次写矩形），--cl-panel-* 相对偏移不变（展开态窗口原点本就 = mon.x），面板
   *  一个像素都不会动；关闭时缩回横带。放大/缩回各一次离散 resize，可接受（无动画）。
   *  预览期间窗口 = 整屏，遮罩 position:fixed 铺满视口；clSetHitRects([]) + force
   *  clickable 每秒续期，遮罩任意处点击都能关闭；Rust 侧另有空矩形超时自愈兜底。
   *  拖动刚结束的误触由 clickSuppressed 吞掉。 */
  const openPreview = (card: ClotheslineCard) => {
    if (clickSuppressed()) return
    if (!previews[card.id]) return
    const geom = geomRef.current
    if (!geom) return
    setAddSheetOpen(false)
    previewCardIdRef.current = card.id // 同步 ref：state 异步更新窗口内 Rust 回发 dismiss 也能读到。
    setPreviewCardId(card.id)
    // ★2026-11-19 反馈2：异步取全分辨率原图（缩略图先顶上，取到后无感替换）。
    setPreviewOriginal(null)
    void clReadOriginal(card.id)
      .then((orig) => {
        // 预览已切走（连点两张图）时丢弃过期结果。
        if (previewCardIdRef.current === card.id && orig) setPreviewOriginal(orig)
      })
      .catch(() => undefined)
    // 窗口临时放大整屏（只在展开态可打开预览 → geom.winRect 必为横带）。
    // 坐标零变化（横带 x/y 与整屏 x/y 相同），只有 width/height 变化。
    const full: ClRect = {
      x: geom.mon.x,
      y: geom.mon.y,
      width: geom.mon.width,
      height: geom.mon.height,
    }
    if (
      geom.winRect.x !== full.x ||
      geom.winRect.y !== full.y ||
      geom.winRect.width !== full.width ||
      geom.winRect.height !== full.height
    ) {
      geom.winRect = full
      void clSetBounds(full.x, full.y, full.width, full.height).catch(() => undefined)
    }
    void clSetHitRects([]) // 空 = 整屏可点，预览遮罩任意处都能关闭
    void clSetForceClickable(2500) // 预览期间强制可点；Rust 侧已封顶 2.5s，关闭时显式清零
    if (previewKeepAliveRef.current !== null) window.clearInterval(previewKeepAliveRef.current)
    previewKeepAliveRef.current = window.setInterval(() => void clSetForceClickable(2500), 1000)
  }

  // ——— ★2026-11-19 图片卡：右键复制图片（长按拖出已按反馈5整体移除）———

  /** 图片区右键：把原图写入系统剪贴板（位图，可直接粘贴）。 */
  const copyCardImage = useCallback(
    async (card: ClotheslineCard) => {
      if (!card.src_path) return
      try {
        await invoke('cl_copy_card_image', { path: card.src_path })
        flash(t('clothesline.toast.imageCopied'))
      } catch (err) {
        flash(t('clothesline.toast.copyFailed', { detail: err instanceof Error ? err.message : String(err) }))
      }
    },
    [flash],
  )

  const closePreview = useCallback(() => {
    previewCardIdRef.current = null
    setPreviewOriginal(null)
    if (previewKeepAliveRef.current !== null) {
      window.clearInterval(previewKeepAliveRef.current)
      previewKeepAliveRef.current = null
    }
    // ★第二十一轮：窗口从整屏缩回窄带矩形（展开态）。placeAndArm 之外唯一的逆向
    //   resize；直接按 geomRef 现算，不走 placeAndArm（避免它误判「rect 变化」重复落盘）。
    setPreviewCardId(null)
    const geom = geomRef.current
    if (geom) {
      const band: ClRect = geom.expanded
        ? { x: geom.mon.x, y: geom.mon.y + geom.panelY, width: geom.mon.width, height: geom.ropeH }
        : { ...geom.winRect }
      if (
        geom.winRect.x !== band.x ||
        geom.winRect.y !== band.y ||
        geom.winRect.width !== band.width ||
        geom.winRect.height !== band.height
      ) {
        geom.winRect = band
        void clSetBounds(band.x, band.y, band.width, band.height).catch(() => undefined)
      }
      void clSetHitRects(panelHitRects(geom)).catch(() => undefined)
    }
    void clSetForceClickable(0)
  }, [panelHitRects, setPreviewCardId])
  // 供只挂载一次的事件 effect 调用最新版本（React Compiler：effect 同步 ref，不在 render 期写）。
  useEffect(() => {
    closePreviewRef.current = closePreview
  }, [closePreview])

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
    // ★2026-11-15 需求10：甲板 zoom 缩放后真实卡宽 = 168×cs，幽灵卡中心随之偏移。
    const cs = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
    const ghostCenterX = d.lastX - d.offsetX + 84 * cs // 与 .cl-card 宽 168×cs 对齐
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
        lsLog(`sort saved ${pairs.length} cards`)
      })
      .catch((err) => {
        setReorderFailed(true)
        window.setTimeout(() => setReorderFailed(false), 2600)
        lsLog(`sort failed, rolled back: ${String(err)}`)
      })
  }, [cancelTimers, setCards, setDragVisual, setReorderFailed])

  const onCardPointerDown = (e: React.PointerEvent, card: ClotheslineCard, mode: DragMode) => {
    if (e.button !== 0) return
    // ★问题5「点便利签某一行不进编辑、反而弹出空白编辑框」的真根因：
    //   旧版对卡片内**任何** pointerdown 都 setPointerCapture 到卡片本体，
    //   指针捕获会把后续 click 的 target 重定向为卡片元素本身 →
    //   行文本的 onClick 永远不触发，冒泡到卡片的 onClick（target=卡片，守卫全部落空）
    //   于是进入「整卡编辑」，而便利签卡的 card.text 本来就是空串 → 空白编辑框。
    //   正确做法：命中可交互子元素时**根本不进拖拽会话、也不做指针捕获**，
    //   让 click 正常落到按钮 / 行文本 / 输入框上。
    const interactive = (e.target as HTMLElement).closest<HTMLElement>(
      'button, input, textarea, select, [contenteditable="true"], [data-cl-hit], .cl-note-text, .cl-photo, .cl-card-actions, .cl-card-edit',
    )
    if (interactive) return
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
      if (e.key !== 'Escape') return
      // 优先级：正在拖动 → 先取消拖动；否则若大图预览打开 → 关预览（问题8）。
      if (dragRef.current?.active) {
        e.preventDefault()
        finishDrag(false)
      } else if (previewCardId) {
        e.preventDefault()
        closePreview()
      } else if (colorMenu) {
        e.preventDefault()
        setColorMenu(null)
      } else if (editModal) {
        // ★2026-11-15 反馈3：编辑弹窗 Esc = 取消。
        e.preventDefault()
        setEditModal(null)
      } else if (takedownConfirm) {
        // ★2026-11-18 归档：取下确认弹窗 Esc = 取消。
        e.preventDefault()
        setTakedownConfirm(null)
      } else if (composing) {
        // ★2026-11-15 需求5/6：编辑弹窗 Esc = 取消（还原窗口矩形走 composing effect 清理）。
        e.preventDefault()
        setComposing(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finishDrag, previewCardId, closePreview, colorMenu, composing, editModal, takedownConfirm])

  // 问题13：任一浮层（＋菜单 / 大图预览）打开 → 通知 Rust 命中循环检测
  // 「点在可点区外」并回发 CL_DISMISS_OVERLAY；全部关闭则停止检测。透明穿透窗收不到
  // 窗外 click，这是唯一可靠的「点外面关菜单」通道。
  // ★2026-11-17 需求3：右键菜单移除后 overlay 不再包含 cardMenu。
  const overlayOpen = Boolean(addSheetOpen || previewCardId)
  useEffect(() => {
    void clSetDismissOnOutside(overlayOpen).catch(() => undefined)
    // 命中矩形恒为面板矩形，浮层开合不改变它；但预览期间要维持 openPreview 写入的
    // 空数组（整屏可点），否则遮罩边缘会穿透、预览关不掉，故预览态跳过重算。
    if (!previewCardIdRef.current) void refreshHitRects().catch(() => undefined)
    return () => {
      void clSetDismissOnOutside(false).catch(() => undefined)
    }
  }, [overlayOpen, refreshHitRects])

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
          // 问题10：颜色来自桌面便利签同一份 localStorage 快照，改色后 notesTick 触发重算。
          noteColor:
            c.kind === 'note'
              ? (clNotePalette().find((p) => p.key === readNoteLite(c.note_id)?.colorKey) ?? clNotePalette()[0])
              : null,
        }
      }),
    [displayCards, previews, nowTick, notesTick, locale],
  )

  // 卡片增减 / 换屏后可能超出可平移上限，钳回尾部（只在此处写 state）。
  // ★批16：补 viewportW / ropePhase 两个依赖——旧版只在卡片数变化时钳一次：
  //   a) boot 时 session 恢复的 scroll_x 是在面板未落位（CSS 默认 1180px 视口）时
  //      钳制的，placeAndArm 把面板设为真实屏宽（如 1920）后视口变宽、真上限变小，
  //      却没有任何机制再钳 → scrollX 保持虚高 → 内容整体左移出视口，绳上呈现
  //      大片空白 + 最后一张卡残影贴左缘（拖入便利签 / 截图飞入 / 新建后均可见）；
  //   b) 收起态（窗口 180px）下钳过的 scrollX 在展开后同样虚高。
  //   动画进行中（expanding/collapsing）测量不可靠（rect 含 keyframes 偏移），
  //   跳过；ropePhase 回 idle / viewportW 落位后会因依赖变化重跑再钳。
  useEffect(() => {
    if (ropePhase !== 'idle') return
    const max = maxScrollX()
    if (scrollXRef.current > max) {
      scrollXRef.current = max
      setScrollX(max)
    }
  }, [ready, posedCards.length, expanded, ropePhase, viewportW, maxScrollX])

  // 卡片增减 / 横向平移 / 菜单弹出 / 编辑态切换后，等 DOM 布局稳定再重算一次命中矩形。
  // 只在这些离散事件触发，绝不逐帧 IPC（PRD §4.7）。
  useEffect(() => {
    if (!ready || !expanded) return
    const id = window.setTimeout(() => {
      // ★问题3/8：预览期间窗口已临时放大整屏、遮罩铺满视口，必须维持 openPreview
      //   写入的空数组（整屏可点）；若按面板矩形重算，遮罩边缘会穿透、预览关不掉。
      //   关闭预览时才恢复面板热区。
      if (previewCardIdRef.current !== null) {
        void clSetHitRects([])
      } else {
        void refreshHitRects()
      }
    }, 80)
    return () => window.clearTimeout(id)
  // viewportW（根因C）：窗口尺寸 / 卡片组居中状态变化后，卡片 DOM 位置整体改变，
  // 必须重算命中矩形，否则「看得见点不到」。centeredDeck 由其派生，无需重复列入。
  }, [ready, expanded, cards, posedCards.length, scrollX, addSheetOpen, composing, dragRatio, previewCardId, viewportW, refreshHitRects])

  if (!settings || !monitor) {
    return <div className="cl-root" ref={rootRef} data-cl-state="booting" data-theme={theme} />
  }

  const pullRatio = settings.pulltab_x_ratio
  // 卡片少到不需滚动时，把整组卡片水平居中（麻绳仍横贯全屏，视觉重心回到屏幕中央）。
  // 卡片多到需要滚动时退回左对齐，保证 transform 平移 + 首尾padding 的完整显示语义。
  // ★2026-11-15 需求10：卡片尺寸缩放（CSS zoom 在 .cl-deck 上），JS 侧布局宽同步乘 cs。
  const csDeck = Math.min(2, Math.max(1, settings.card_size ?? 1))
  // ★批18：deck 左右内边距 30 → 64（给绳端 ＋ 按钮让位），内容宽公式同步。
  const deckContentW =
    posedCards.length * 168 * csDeck + Math.max(0, posedCards.length - 1) * 16 * csDeck + 128 * csDeck
  const centeredDeck = posedCards.length > 0 && viewportW > 0 && deckContentW <= viewportW
  const cardLimit = fullAccess ? 24 : 12
  // 问题8：预览卡与其文案先算好，避免 JSX 里堆一堆 fallback 对象。
  const previewCard = previewCardId ? (cards.find((c) => c.id === previewCardId) ?? null) : null
  const previewCopy = previewCard ? cardCopy(previewCard) : null
  return (
    <div
      ref={rootRef}
      className={`cl-root ${expanded ? 'is-expanded' : 'is-collapsed'} ${
        settings.wind_effect ? 'has-wind' : ''
      } ${restoring ? 'is-restoring' : ''} ${draggingRope ? 'is-dragging-rope' : ''} ${
        previewCardId ? 'has-preview' : ''
      } ${ropePhase !== 'idle' ? `is-${ropePhase}` : ''} ${
        addSheetOpen ? 'is-menu-open' : ''
      }`}
      data-cl-state={ready ? 'ready' : 'placing'}
      data-theme={theme}
      data-pulltab={settings.pulltab_style ?? 'porcelain'}
      data-runtime="tauri"
      style={{
        // ★2026-11-15 需求10：卡片尺寸缩放系数，.cl-deck 的 CSS zoom 消费此变量。
        '--cl-card-zoom': csDeck,
      } as CSSProperties}
      onMouseDown={(e) => {
        // 问题12：点击任意区域先摘掉焦点，杜绝 WebView2 的 focus ring / 蓝色方框残留。
        // ★不能误伤正在编辑的输入框/文本域（否则第一个字符打不进去）——只 blur 按钮类元素。
        const tgt = e.target as HTMLElement
        if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }}
      onClick={() => {
        if (addSheetOpen) setAddSheetOpen(false)
        if (colorMenu) setColorMenu(null)
      }}
      onDragEnter={onRootDragEnter}
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
      /* 根因C：滚轮监听放在整层 root，卡片之间的透明空隙也能滚（不再只挂 deck）。 */
      onWheel={onDeckWheel}
    >
      {/* 麻绳：SVG 下垂曲线 + 麻纤维虚线 + 两端固定钉（原型 .rope-svg）。
          ★2026-11-17 绳身换肤：跟随 data-pulltab（设置页拉杆样式）切换绳+钉材质。
          新增装饰路径均由同一条曲线坐标公式派生（26+40·t(1−t)），几何零变化：
          stitch=素瓷绞股纹 / shine+rings=黄铜车刻高光与环纹 / dew=琉璃静露。
          默认全部 visibility:hidden，由 clothesline.css 各皮肤段按需点亮。 */}
      <div className="cl-rope" aria-hidden="true">
        <svg className="cl-rope-svg" viewBox="0 0 1000 64" preserveAspectRatio="none">
          <defs>
            {/* 琉璃露珠渐变：浅色 / 深色两套，CSS fill:url(#…) 按主题切换 */}
            <radialGradient id="cl-dew-l" cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="45%" stopColor="#c7dcf8" />
              <stop offset="100%" stopColor="#6f9fdd" />
            </radialGradient>
            <radialGradient id="cl-dew-d" cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#dceafc" />
              <stop offset="45%" stopColor="#8fb4e6" />
              <stop offset="100%" stopColor="#4f7bbb" />
            </radialGradient>
          </defs>
          <path className="cl-rope-under" d="M4 28 Q500 48 996 28" />
          <path className="cl-rope-main" d="M4 26 Q500 46 996 26" />
          <path className="cl-rope-fiber" d="M4 25 Q500 45 996 25" />
          <path className="cl-rope-stitch" d="M4 26.8 Q500 46.8 996 26.8" />
          <path className="cl-rope-shine" d="M4 24.4 Q500 44.4 996 24.4" />
          <path className="cl-rope-rings" d="M4 26 Q500 46 996 26" />
          {/* 静露 x 均布，y = 26+40·t(1−t) + 3（露珠上缘贴线悬挂感） */}
          <circle className="cl-rope-dew" cx="180" cy="34.9" r="4.5" />
          <circle className="cl-rope-dew" cx="390" cy="39" r="5.2" />
          <circle className="cl-rope-dew" cx="610" cy="39" r="4.2" />
          <circle className="cl-rope-dew" cx="830" cy="34.6" r="4.8" />
        </svg>
        <span className="cl-rope-nail cl-rope-nail-l" />
        <span className="cl-rope-nail cl-rope-nail-r" />
      </div>

      {/* 长按绳子上下拖改 anchorY（顶部 40% 内，8px 吸附，松手一次写盘） */}
      {expanded ? (
        <div
          className="cl-rope-hotzone"
          onPointerDown={beginWindowDrag}
          onPointerMove={moveWindowDrag}
          onPointerUp={endWindowDrag}
          onPointerCancel={endWindowDrag}
          aria-label={t('clothesline.toolbar.ropeAria')}
        />
      ) : null}

      {/* 顶部工具条：拖动把手 / 卡片计数 / 清风 / 收起 */}
      <div className="cl-toolbar" data-cl-hit="1">
        {/* 问题4：专用拖动把手——用户明确要求「长按该图标上下左右拖动整条晾衣绳」。
            与麻绳热区共用同一拖动会话（anchor_y + win_x_ratio），松手一次写盘 + 重算命中矩形。 */}
        <button
          type="button"
          className={`cl-drag-handle ${draggingRope ? 'is-dragging' : ''}`}
          data-cl-hit="1"
          onPointerDown={beginWindowDrag}
          onPointerMove={moveWindowDrag}
          onPointerUp={endWindowDrag}
          onPointerCancel={endWindowDrag}
          onClick={(e) => e.stopPropagation()}
          aria-label={t('clothesline.toolbar.dragAria')}
        >
          ⠿
        </button>
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
          aria-label={t('clothesline.toolbar.windAria')}
        >
          {t('clothesline.toolbar.wind')}
        </button>
        <button
          type="button"
          className="cl-tool-btn cl-tool-collapse"
          onClick={(e) => {
            e.stopPropagation()
            void toggleExpanded()
          }}
          aria-label={t('clothesline.toolbar.collapseAria')}
        >
          {t('clothesline.toolbar.collapse')}
        </button>
        {/* ★2026-11-20：操作指引入口（收起按钮右侧的问号）。悬停显示小浮窗提示。 */}
        <button
          type="button"
          className="cl-tool-btn cl-tool-help"
          data-tip={t('clothesline.guide.aria')}
          onClick={(e) => {
            e.stopPropagation()
            setGuideOpen(true)
          }}
          aria-label={t('clothesline.guide.aria')}
        >
          ?
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
        aria-label={t('clothesline.menu.addAria')}
      >
        ＋
      </button>
      <div
        ref={addSheetRef}
        className={`cl-add-sheet ${addSheetOpen ? 'is-open' : ''}`}
        data-cl-hit="1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="cl-sheet-head">{t('clothesline.menu.head')}</span>
        <button
          type="button"
          onClick={() => {
            setAddSheetOpen(false)
            // ★2026-11-15 反馈6：新建便利签 = 创建即挂绳。便利签数据由主窗单一写方
            //   创建（collapsed，不开桌面窗），随后直接 clAddCard 挂绳，一步到位。
            void clUpdateSettings({ expanded: true }).catch(() => undefined)
            void emit(CL_CREATE_NOTE, {}).catch(() => undefined)
          }}
        >
          {t('clothesline.menu.newNote')} <em>{t('clothesline.menu.newNoteSub')}</em>
        </button>
        <button type="button" onClick={() => openComposer('text')}>
          {t('clothesline.menu.text')} <em>{t('clothesline.menu.textSub')}</em>
        </button>
        <button type="button" onClick={() => openComposer('timer')}>
          {t('clothesline.menu.timer')} <em>{t('clothesline.menu.timerSub', { n: composeMinutes })}</em>
        </button>
        {/* ★2026-11-15 一键录音：建卡即开录（引擎在主窗），保存后卡片自动取下。
            ★0.4.81：标题包进独立 span 强制单行，副标题精简为「挂绳即录」。 */}
        <button type="button" className="cl-mi-record" onClick={() => void startRopeRecording()}>
          <span className="cl-mi-label">{t('clothesline.menu.record')}</span><em>{t('clothesline.menu.recordSub')}</em>
        </button>
        <button type="button" onClick={() => { imageInputRef.current?.click(); setAddSheetOpen(false) }}>
          {t('clothesline.menu.image')} <em>PNG</em>
        </button>
        {/* ★2026-11-15 反馈批3：「从现有工具挂上来」整组（便利签/待办/剪贴板贴图截图）
            按需求移除 —— 各工具内容仍在原工具内通过晾衣绳图标一键挂绳。 */}
        <div className="cl-sheet-sep" />
        <button type="button" onClick={() => { void cycleMonitor(); setAddSheetOpen(false) }}>
          {t('clothesline.menu.screen')} <em>{monitor?.name || t('dock.primary')}</em>
        </button>
        <button type="button" onClick={() => { void toggleTopmost(); setAddSheetOpen(false) }}>
          {t('clothesline.menu.topmost')} <em>{settings.always_on_top ? t('clothesline.menu.on') : t('clothesline.menu.off')}</em>
        </button>
        {/* ★2026-11-18 归档：＋菜单直达主窗归档页（不改绳身展开态）。 */}
        <button
          type="button"
          className="cl-sheet-archive"
          onClick={() => {
            setAddSheetOpen(false)
            void emit(CL_OPEN_ARCHIVE, {}).catch(() => undefined)
          }}
        >
          {t('clothesline.menu.archive')} <em>{t('clothesline.menu.archiveSub')}</em>
        </button>
        {/* 2026-11-15 反馈2：菜单直达晾衣绳设置页。收起态先展开绳身，再通知主窗
            （主窗若折叠会自动展开并打开「晾衣绳」页，见 App.tsx 的监听）。 */}
        <button
          type="button"
          onClick={() => {
            setAddSheetOpen(false)
            void clUpdateSettings({ expanded: true }).catch(() => undefined)
            void emit(CL_OPEN_SETTINGS, {}).catch(() => undefined)
          }}
        >
          {t('clothesline.menu.settings')} <em>{t('clothesline.menu.settingsSub')}</em>
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
        aria-label={expanded ? t('clothesline.handle.collapseAria') : t('clothesline.handle.expandAria')}
      >
        <span className="cl-clip" />
        <span className="cl-handle-label">{expanded ? t('clothesline.handle.collapse') : t('clothesline.handle.expand')}</span>
      </button>

      {!expanded ? (
        <button
          ref={pullTabRef}
          type="button"
          className="cl-pulltab"
          // 拉手恒在窗口中央；整窗位置由 win_x_ratio 决定。拖动时窗口本身 setPosition 移动，
          // 拉手自然跟手；松手后 placeAndArm 重定位 + 重算命中矩形（问题11 视觉与命中不再脱节）。
          // ★按钮盒子宽 480（= Rust 命中带宽），所以 left 要减去半宽让视觉拉手仍居中。
          style={{ left: 'calc(50% - 240px)' }}
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
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // 收起态木夹把手已隐藏（原型收起态只有拉绳），置顶能力挪到拉绳右键，避免丢失。
            void toggleTopmost()
          }}
          aria-label={t('clothesline.pull.aria')}
        >
          {/* ① 丝线：从桌面顶垂下的细绳，下拉时按 --cl-pull 纵向拉伸（只改 transform）。 */}
          <span className="cl-pull-cord" aria-hidden="true" />
          {/* ② 绳结/瓷珠：挂在绳末端，下拉时随绳下移，松手弹回。 */}
          <span className="cl-pull-bead" aria-hidden="true" />
          {/* ③ 拉手：温润的瓷白小柄，蓝线握位 + 下滑提示。 */}
          <span className="cl-pull-tab">
            <span className="cl-pull-grip" aria-hidden="true" />
            <span className="cl-pull-foot" aria-hidden="true" />
          </span>
          <span className="cl-pull-badge">
            {/* ★2026-11-15 需求8：窗口收窄到拉手本身，badge 移到拉手正下方并缩短文案。 */}
            {cards.length ? t('clothesline.pull.count', { n: cards.length }) : t('clothesline.pull.empty')}
          </span>
        </button>
      ) : null}

      {/* 展开态卡片区：按 order 确定性还原；引用失效只占位，绝不删卡 / 前移槽位。
          阶段 2 只做只读呈现，拖动排序在阶段 3、卡片内容桥接在阶段 4。 */}
      {expanded ? (
        /* ★批16 根因修复：translateX 必须与 zoom 分离。旧版 deck 同时挂
           zoom(卡片缩放) 与 translateX(-scrollX) —— CSS zoom 会等比放大 transform
           位移（用户 145% 档实测：scrollX=2616 而甲板实际偏移 -3793，比值恰为
           1.45），导致新卡聚焦 / 滚轮 / 钳制全部过冲 45%，绳上呈现大片空白、
           新卡停在视口左缘。平移上移到不缩放的包装层，zoom 留在内层，
           scrollX 的位移语义回到逻辑 px，与 maxScrollX / 聚焦 / 钳制的
           视觉坐标测量完全一致。 */
        <div
          className="cl-deck-pan"
          /* ★问题2 预防：scrollX 为 0 时**不写** identity transform。
             静止态下让平移层保持「无 transform」的普通绘制块，合成器不会为它保留
             独立的变换层 —— 透明置顶窗里层越少，hover 重绘时丢 alpha 的机会越少。 */
          style={scrollX ? { transform: `translateX(${-scrollX}px)` } : undefined}
        >
        <div
          ref={deckRef}
          className={`cl-deck ${centeredDeck ? 'is-centered' : ''}`}
          onClickCapture={(e) => {
            if (clickSuppressed()) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
        >
          {posedCards.length === 0 ? (
            <div className="cl-deck-empty">
              <span className="cl-deck-hint">{t('clothesline.empty.title')}</span>
              <span className="cl-deck-sub">
                {t('clothesline.empty.hint')}
              </span>
            </div>
          ) : (
            posedCards.map(({ card, pose, broken, copy, thumb, timer, ratio, noteColor }, index) => (
              <div
                key={card.id}
                data-cl-card-id={card.id}
                /* ★根因A：清风摆动只挂这一层（整张卡绕夹点摆），相位是稳定 CSS 变量，
                   不是每次 render 新建的 inline animationDelay → 重渲染绝不重启动画。 */
                className={`cl-card-sway ${dragVisual?.id === card.id ? 'is-still' : ''} ${archiveFly?.id === card.id ? 'is-archive-fly' : ''}`}
                style={{
                  // ★0.4.80 方案A：倾角变量必须设在外壳层 —— 全部 transform / 摆动动画
                  // 已移到 .cl-card-sway，CSS 变量只向下继承，父层读不到子元素上的 --cl-rot。
                  // card 层保留同名变量仅作兼容，不再驱动任何 transform。
                  // ★2026-11-17 需求4：清风关（wind_effect=false）时倾角归零 —— 卡片
                  // 垂直摆正，不再东晃西倒；清风开时保留 ±2° 随机静置倾角。
                  '--cl-wind-delay': `-${pose.windPhase.toFixed(2)}s`,
                  '--cl-rot': settings.wind_effect ? `${pose.tilt}deg` : '0deg',
                  // ★2026-11-22 归档飞出终点（相对卡片当前位置，点击时按 dockSide 现算）。
                  ...(archiveFly?.id === card.id
                    ? { '--fly-x': `${archiveFly.dx}px`, '--fly-y': `${archiveFly.dy}px` }
                    : {}),
                } as CSSProperties}
            >
              {/* ★批10-3 根因修复：木夹必须放在 .cl-card **外层**（sway 直接子元素）。
                  旧版夹子是 .cl-card 的子元素且 top:-19px，而 .cl-card 是
                  overflow:hidden —— 露在卡外的上半段（19px/32px）从头到尾就没被
                  绘制过，用户看到的只是卡内残留的 13px 小木块；--cl-hang 无论怎么
                  算得再准，绳子也永远「悬空」在可见夹子上方（批6/批8 两轮修复
                  无效的真凶）。移出后夹子完整可见，绳从其上部 1/4 处穿过。
                  z-index:4 高于纸面（position:relative z-auto），夹子压住卡的上缘。 */}
              <span
                className="cl-card-clip"
                role="button"
                aria-label={t('clothesline.action.dragSort')}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onCardPointerDown(e, card, 'clip')
                }}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e) => onCardPointerUp(e, true)}
                onPointerCancel={(e) => onCardPointerUp(e, false)}
              />
              {/* ★2026-11-17 绳身换肤：琉璃皮肤的「第二枚水滴夹」（右 75% 处，
                  与主夹 25% / ±8° 镜像相向微倾，两夹与卡片左右边缘等距）。
                  默认 display:none，仅 glass 皮肤显示；复用主夹同一套指针处理，
                  右侧液滴同样可拖拽排序。悬挂测量 syncCardHang 只量主夹
                  （.cl-card-clip），双夹等大等高，绳曲线在两夹位间的 y 差
                  最大约 3px（面板边缘处），视觉上可忽略。 */}
              <span
                className="cl-card-clip2"
                role="button"
                aria-label={t('clothesline.action.dragSort')}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onCardPointerDown(e, card, 'clip')
                }}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e) => onCardPointerUp(e, true)}
                onPointerCancel={(e) => onCardPointerUp(e, false)}
              />
              <div
                data-cl-card-id={card.id}
                data-style={card.kind === 'timer' ? (card.card_style ?? 'paper') : undefined}
                className={`cl-card cl-card-${card.kind} ${
                  /* ★2026-11-15 反馈批9：随手记卡样式（创建弹窗可选）——
                     tape=和纸胶带 / night=墨夜磁贴 / 其余(含历史卡)回落 mist=晨雾渐变。 */
                  card.kind === 'text'
                    ? `is-${card.card_style === 'tape' || card.card_style === 'night' ? card.card_style : 'mist'}`
                    : ''
                } ${broken ? 'is-broken' : ''} ${
                  card.pinned ? 'is-pinned' : ''
                } ${dragVisual?.id === card.id ? 'is-dragging' : ''} ${
                  dragVisual && dragVisual.insertAt === index ? 'is-drop-target' : ''
                }`}
                style={{
                  // ★2026-11-17 需求4：与 sway 层同规则 —— 清风关时 0deg（垂直摆正）。
                  '--cl-rot': settings.wind_effect ? `${pose.tilt}deg` : '0deg',
                  ...(noteColor
                    ? {
                        '--cl-note': noteColor.bg,
                        '--cl-note-line': noteColor.bg,
                        '--cl-note-ink': noteColor.fg,
                      }
                    : {}),
                  // ★2026-11-17 问题3：番茄卡（kind='timer'）忽略 card_color ——
                  // 配色严格按设计图；旧数据残留的自定义色不再染新皮肤。
                  // 其余卡型 --cl-card-bg 是各类型底色变量的
                  //   统一兜底值（clothesline.css 各 kind 的 background-color / 纹理渐变
                  //   都引用它），覆盖一处即整卡换色，不透明、无 alpha，命中安全。
                  // ★2026-11-17 需求1：--cl-card-tint 仅在选了自定义卡色时存在，
                  //   新 6 款番茄皮肤用它染强调件（表圈/票头/外壳/红条/木框/灯金），
                  //   卡身保持各款固定底色 —— var(--cl-card-tint, 默认 token) 双态。
                  ...(card.kind !== 'timer' && card.card_color
                    ? { '--cl-card-bg': card.card_color, '--cl-card-tint': card.card_color }
                    : {}),
                  // ★2026-11-15 反馈批9：墨夜样式的左侧竖条取自定义卡色（未选色用默认粉）。
                  ...(card.kind === 'text' && card.card_color
                    ? { '--cl-night-bar': card.card_color }
                    : {}),
                  // ★2026-11-15 反馈4：字号调节档位（便利签 / 随手记卡）。
                  '--cl-card-fs': card.font_scale ?? 1,
                  // ★批12：随手记字体格式 → CSS 变量（undefined = 不设，走 CSS 默认）。
                  ...(card.kind === 'text'
                    ? {
                        '--cl-title-size':
                          card.title_size != null ? `${card.title_size}px` : undefined,
                        '--cl-body-size':
                          card.body_size != null ? `${card.body_size}px` : undefined,
                        '--cl-card-font': card.font_family || undefined,
                        '--cl-title-weight': card.title_bold === false ? '500' : undefined,
                        '--cl-title-style': card.title_italic ? 'italic' : undefined,
                        '--cl-body-weight': card.body_bold ? '700' : undefined,
                        '--cl-body-style': card.body_italic ? 'italic' : undefined,
                      }
                    : {}),
                } as CSSProperties}
                aria-label={t('clothesline.action.cardAria')}
                onPointerDown={(e) => onCardPointerDown(e, card, 'longpress')}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e) => onCardPointerUp(e, true)}
                onPointerCancel={(e) => onCardPointerUp(e, false)}
                /* 问题9：双击编辑 → 单击编辑。守卫所有可交互子元素，避免点按钮/图片/输入框
                   时被误判成「编辑整卡」。 */
                onClick={(e) => {
                  const tgt = e.target as HTMLElement
                  if (tgt.closest('button, input, textarea, select, [contenteditable="true"], [data-cl-hit], .cl-photo, .cl-note-text')) return
                  if (clickSuppressed()) return
                  // 便利签卡的内容来自 notes/store（单一写方），card.text 恒为空。
                  // 整卡编辑对便利签没有意义，点空白处不再弹空白编辑框；条目编辑走行内。
                  if (card.kind === 'note') return
                  // 录音卡：标题编辑在卡面内（点标题），空白处点击不做任何事。
                  if (card.kind === 'audio') return
                  if (broken) return
                  // ★2026-11-15 反馈3：截图 / 贴图 / 图片 / 随手记卡 → 居中弹窗（标题+内容）；
                  //   其余类型保持行内编辑；番茄卡 → 居中编辑弹窗（反馈4）。
                  if (card.kind === 'shot' || card.kind === 'pin' || card.kind === 'image' || card.kind === 'text') {
                    openCardEditor(card)
                    return
                  }
                  if (card.kind === 'timer') {
                    openComposer('timer', card)
                    return
                  }
                  setEditing({ id: card.id, value: card.text })
                }}
                /* ★2026-11-17 需求3：去掉卡片右键下拉菜单 —— 「打开原内容」菜单独有
                   入口改为悬停图标 ⧉；★问题2：置顶功能（📌）整体移除。 */
              >
                {/* ★批10-3：木夹已移到 sway 层（.cl-card overflow:hidden 会裁掉
                    露在卡外的上半段，导致夹子永远连不上麻绳）。 */}
                {/* 悬停浮出的操作按钮：写操作全部走 clUpdateCard / clRemoveCard 单一写锁。
                    ★2026-11-17 需求3：右键菜单移除后，原菜单独有的「打开原内容」
                    收敛为悬停图标 ⧉（仅便利签 / 待办卡渲染）；★问题2：置顶已移除。 */}
                <div className="cl-card-actions" onPointerDown={(e) => e.stopPropagation()}>
                  {(card.kind === 'note' || card.kind === 'task') && !broken ? (
                    <button
                      type="button"
                      aria-label={t('clothesline.action.openSource')}
                      title={t('clothesline.action.openSource')}
                      onClick={(e) => { e.stopPropagation(); void openSource(card) }}
                    >
                      ⧉
                    </button>
                  ) : null}
                  {(card.kind === 'note' || card.kind === 'text') && !broken ? (
                    <button
                      type="button"
                      aria-label={t('clothesline.action.fontScale')}
                      title={t('clothesline.action.fontScaleTip', { n: Math.round((card.font_scale ?? 1) * 100) })}
                      onClick={(e) => {
                        e.stopPropagation()
                        void cycleFont(card)
                      }}
                    >
                      A
                    </button>
                  ) : null}
                  {/* ★2026-11-15 需求1c：便利签卡在编辑图标左侧新增换色图标（弹色板）。 */}
                  {card.kind === 'note' && card.note_id && !broken ? (
                    <button
                      type="button"
                      aria-label={t('clothesline.action.recolor')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setColorMenu({
                          cardId: card.id,
                          noteId: card.note_id!,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }}
                    >
                      🎨
                    </button>
                  ) : null}
                  {/* ★2026-11-15 需求1：绳上便利签不再有「打开原窗」路径 —— 内容编辑
                      全部行内化（单击条目文本），✎ 编辑图标对便利签卡不渲染，
                      避免弹出空白编辑框（card.text 恒为空）。 */}
                  {!broken && card.kind !== 'audio' && !(card.kind === 'note' && card.note_id) ? (
                    <button
                      type="button"
                      aria-label={t('clothesline.action.edit')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (broken) {
                          flash(t('clothesline.toast.brokenTakeDown'))
                        } else if (card.kind === 'shot' || card.kind === 'pin' || card.kind === 'image' || card.kind === 'text') {
                          openCardEditor(card)
                        } else if (card.kind === 'timer') {
                          openComposer('timer', card)
                        } else {
                          setEditing({ id: card.id, value: card.text })
                        }
                      }}
                    >
                      ✎
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="is-danger"
                    aria-label={t('clothesline.action.takeDown')}
                    onClick={(e) => { e.stopPropagation(); void takeDown(card) }}
                  >
                    ×
                  </button>
                </div>
                {broken ? (
                  <div className="cl-card-placeholder">
                    <span className="cl-ph-icon">⌁</span>
                    <span className="cl-ph-title">{copy.title}</span>
                    <span className="cl-ph-sub">{t('clothesline.card.brokenHint')}</span>
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
                      placeholder={t('clothesline.action.editPlaceholder')}
                    />
                    <div className="cl-edit-actions">
                      <button type="button" onClick={() => void commitEdit(card.id, editing.value)}>{t('common.save')}</button>
                      <button type="button" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <CardFace
                    card={card}
                    copy={copy}
                    thumb={thumb}
                    timer={timer}
                    ratio={ratio}
                    audio={
                      audioState && audioState.cardId === card.id
                        ? { status: audioState.status, elapsedMs: audioState.elapsedMs }
                        : null
                    }
                    onAudioAction={(c, a) => void audioAction(c, a)}
                    onRenameAudio={(c, title) => void renameAudioCard(c, title)}
                    onTimerAction={(action) => void timerAction(card, action)}
                    onPreview={openPreview}
                    onPhotoCopy={(c) => void copyCardImage(c)}
                    onNoteAction={onNoteItemAction}
                    onToast={flash}
                  />
                )}
              </div>
              </div>
            ))
          )}

          {/* ★2026-11-15 需求5/6：添加/编辑弹窗从「挂在甲板里」改为桌面居中的独立弹窗
              （不带遮罩）。弹窗打开时绳窗临时整屏（见 composing effect），
              本体 fixed 居中；点弹窗外 → Rust dismiss → 取消并缩回横带。 */}
        </div>
        </div>
      ) : null}

      {/* ★2026-11-20：操作指引弹窗 —— 复用全屏弹窗机制（临时整屏 + 点外关闭），
          避免绳窗 300px 高度裁切内容。 */}
      {guideOpen ? (
        <div
          ref={modalRef}
          className="cl-modal cl-guide"
          data-cl-hit="1"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <span className="cl-modal-title">{t('clothesline.guide.title')}</span>
          <ul className="cl-guide-list">
            <li>{t('clothesline.guide.reorder')}</li>
            <li>{t('clothesline.guide.move')}</li>
            <li>{t('clothesline.guide.copyImage')}</li>
            <li>{t('clothesline.guide.rope')}</li>
            <li>{t('clothesline.guide.settings')}</li>
            <li>{t('clothesline.guide.hover')}</li>
          </ul>
          <button
            type="button"
            className="cl-guide-close"
            onClick={() => setGuideOpen(false)}
          >
            {t('clothesline.guide.close')}
          </button>
        </div>
      ) : null}

      {composing ? (
        <div
          ref={modalRef}
          className="cl-modal cl-modal-anim"
          data-cl-hit="1"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <span className="cl-modal-title">{composing === 'timer' ? (composeEditId ? t('clothesline.compose.editTimer') : t('clothesline.compose.addTimer')) : (composeEditId ? t('clothesline.compose.editText') : t('clothesline.compose.addText'))}</span>
          {composing === 'text' ? (
            // ★2026-11-24 问题3：随手记标题输入与全局速记同款（qn-input，无行标签）。
            <input
              autoFocus
              className="qn-input"
              value={composeTitle}
              onChange={(e) => { setComposeTitle(e.target.value); if (composeErr) setComposeErr('') }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setComposing(null)
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitCompose()
                }
              }}
              placeholder={t('clothesline.compose.textPlaceholder')}
            />
          ) : (
            <div className="cl-modal-row">
              <span className="cl-modal-label">
                {composing === 'timer' ? t('clothesline.compose.taskNameLabel') : t('clothesline.compose.titleLabel')}
              </span>
              <input
                className="cl-modal-input"
                autoFocus
                value={composeTitle}
                onChange={(e) => { setComposeTitle(e.target.value); if (composeErr) setComposeErr('') }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setComposing(null)
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitCompose()
                  }
                }}
                placeholder={composing === 'timer' ? t('clothesline.compose.taskPlaceholder') : t('clothesline.compose.textPlaceholder')}
              />
            </div>
          )}
          {composeErr ? <span className="cl-modal-err">{composeErr}</span> : null}
          {composing === 'timer' ? (
            <>
              <div className="cl-modal-row">
                <span className="cl-modal-label">{t('clothesline.compose.direction')}</span>
                <div className="cl-modal-seg">
                  <button
                    type="button"
                    className={composeDirection === 'countdown' ? 'is-active' : ''}
                    onClick={() => setComposeDirection('countdown')}
                  >
                    {t('clothesline.card.dirCountdown')}
                  </button>
                  <button
                    type="button"
                    className={composeDirection === 'countup' ? 'is-active' : ''}
                    onClick={() => setComposeDirection('countup')}
                  >
                    {t('clothesline.card.dirCountup')}
                  </button>
                </div>
              </div>
              <div className="cl-modal-row">
                <span className="cl-modal-label">{t('clothesline.compose.duration')}</span>
                <label className="cl-minutes">
                  <input
                    type="range"
                    min={1}
                    max={720}
                    step={1}
                    value={Math.min(720, Math.max(1, Number(composeMinutes) || 25))}
                    onChange={(e) => setComposeMinutes(e.target.value)}
                  />
                  <input
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
                  <span>{t('clothesline.compose.minutesUnit')}</span>
                </label>
                <div className="cl-modal-quick">
                  {[5, 10, 15, 25].map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={Number(composeMinutes) === m ? 'is-active' : ''}
                      onClick={() => setComposeMinutes(String(m))}
                    >
                      {t('clothesline.compose.quick', { n: m })}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cl-modal-row">
                <span className="cl-modal-label">{t('clothesline.compose.style')}</span>
                <div className="cl-modal-seg is-7">
                  {TIMER_STYLE_OPTS.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={composeStyle === s.key ? 'is-active' : ''}
                      onClick={() => {
                        // ★2026-11-23 会员闸门：受限用户点会员样式 → toast，不选中。
                        if (s.vipOnly && !fullAccess) {
                          flash(t('clothesline.compose.vipStyleLocked'))
                          return
                        }
                        setComposeStyle(s.key)
                      }}
                    >
                      {t(s.label)}
                      {s.vipOnly && showVip ? <i className="cl-vip-tag">VIP</i> : null}
                    </button>
                  ))}
                </div>
              </div>
              <label className="cl-modal-check">
                <input
                  type="checkbox"
                  checked={composeRemind}
                  onChange={(e) => setComposeRemind(e.target.checked)}
                />
                {t('clothesline.compose.remindCheck')}
              </label>
            </>
          ) : composing === 'text' ? (
            // ★2026-11-24 问题3：随手记正文 = 全局速记同款富文本编辑器（qn 工具行 +
            // contentEditable），弹窗样式与内容以全局速记的随手记弹窗为准。
            <>
              <QnToolbarRow onFmt={composeFmt} />
              <div
                ref={composeEditorRef}
                className="qn-textarea qn-in-modal"
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline
                data-placeholder={t('clothesline.compose.bodyPlaceholder')}
                onInput={syncComposeText}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setComposing(null)
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void submitCompose()
                  }
                }}
              />
            </>
          ) : (
            <div className="cl-modal-row">
              <span className="cl-modal-label">{t('clothesline.compose.bodyLabel')}</span>
              <textarea
                className="cl-modal-textarea"
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setComposing(null)
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void submitCompose()
                  }
                }}
                placeholder={t('clothesline.compose.bodyPlaceholder')}
              />
            </div>
          )}
          {/* ★2026-11-23 随手记分类：与全局速记窗共享同一份分类表（同源 localStorage）。
              单选 chip + 内联新建，最多 8 个、名称 ≤8 字；取消选中清除记忆。
              ★2026-11-24 问题3：分类行改用全局速记的 qn 系样式（视觉一致）。 */}
          {composing === 'text' ? (
            <div className="qn-cats">
              <span className="qn-cats-label">{t('quickNote.category')}</span>
              <div className="qn-cats-chips">
                {composeCats.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={`qn-chip ${composeCategory === c ? 'is-active' : ''}`}
                    onClick={() => {
                      const next = composeCategory === c ? '' : c
                      setComposeCategory(next)
                      saveLastCategory(next)
                    }}
                  >
                    {c}
                    {/* ★2026-11-25 问题2：分类可删除（与全局速记窗一致） */}
                    <span
                      role="button"
                      aria-label={t('quickNote.catDelete')}
                      title={t('quickNote.catDelete')}
                      className="qn-chip-x"
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = removeCategory(c)
                        setComposeCats(next)
                        if (composeCategory === c) {
                          setComposeCategory('')
                          saveLastCategory('')
                        }
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
                {composeAddingCat ? (
                  <input
                    className="qn-cat-input"
                    value={composeNewCat}
                    autoFocus
                    maxLength={8}
                    placeholder={t('quickNote.catPlaceholder')}
                    onChange={(e) => setComposeNewCat(e.target.value)}
                    onBlur={() => {
                      // ★2026-11-24 问题5：addCategory 内部已读最新表；满额给出提示
                      const { cats: next, name, reason } = addCategory(composeCats, composeNewCat)
                      if (name) {
                        setComposeCats(next)
                        setComposeCategory(name)
                        saveLastCategory(name)
                      } else if (reason === 'full') {
                        flash(t('quickNote.catFull'))
                      }
                      setComposeNewCat('')
                      setComposeAddingCat(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') {
                        setComposeAddingCat(false)
                        setComposeNewCat('')
                      }
                    }}
                  />
                ) : (
                  <button type="button" className="qn-chip qn-chip-add" onClick={() => setComposeAddingCat(true)}>
                    ＋ {t('quickNote.catNew')}
                  </button>
                )}
              </div>
            </div>
          ) : null}
          {/* ★2026-11-15 反馈批9：随手记创建时可选卡片样式（晨雾 / 胶带 / 墨夜）。
              墨夜磁贴以左侧竖条取自定义卡色，胶带样式以卡色作纸底。
              ★批19：此行仅随手记显示 —— 番茄钟分支内已有「纸感/极简/玻璃」样式行，
              旧版无条件渲染导致番茄钟弹窗出现两个「卡片样式」字段。 */}
          {composing !== 'timer' ? (
          <div className="cl-modal-row">
            <span className="cl-modal-label">{t('clothesline.compose.style')}</span>
            <div className="cl-modal-seg">
              <button
                type="button"
                className={composeTextStyle === 'mist' ? 'is-active' : ''}
                onClick={() => setComposeTextStyle('mist')}
              >
                {t('clothesline.compose.styleMist')}
              </button>
              <button
                type="button"
                className={composeTextStyle === 'tape' ? 'is-active' : ''}
                onClick={() => setComposeTextStyle('tape')}
              >
                {t('clothesline.compose.styleTape')}
              </button>
              <button
                type="button"
                className={composeTextStyle === 'night' ? 'is-active' : ''}
                onClick={() => setComposeTextStyle('night')}
              >
                {t('clothesline.compose.styleNight')}
              </button>
            </div>
          </div>
          ) : null}
          {/* ★2026-11-17 问题3：番茄钟弹窗不再提供卡片颜色 —— 卡片配色严格按
              设计图（7 款样式各有固定配色），自定义色会把新皮肤染丑。 */}
          {composing !== 'timer' ? (
          <div className="cl-modal-row">
            <span className="cl-modal-label">{t('clothesline.compose.colorLabel')}</span>
            <div className="cl-modal-swatches">
              {clCardPalette().map((c) => (
                <button
                  key={c.key || 'default'}
                  type="button"
                  className={`cl-modal-swatch ${(c.bg ?? '') === composeColor ? 'is-active' : ''}`}
                  style={{ background: c.bg ?? 'var(--cl-paper)' }}
                  aria-label={c.label}
                  title={c.label}
                  onClick={() => setComposeColor(c.bg ?? '')}
                />
              ))}
            </div>
          </div>
          ) : null}
          {/* ★2026-11-24 问题3：qn 富文本工具行已取代字体格式段；按钮与全局速记弹窗
              同款（仅文案不同：保存 / 取消）。其余类型保持原按钮。 */}
          {composing === 'text' ? (
            <div className="qn-actions">
              <button type="button" className="qn-btn qn-btn-hang" onClick={() => void submitCompose()}>
                {composeEditId ? t('common.save') : t('clothesline.compose.submitAdd')}
              </button>
              <button type="button" className="qn-btn qn-btn-archive" onClick={() => setComposing(null)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="cl-edit-actions">
              <button type="button" onClick={() => void submitCompose()}>
                {composeEditId ? t('common.save') : t('clothesline.compose.submitAdd')}
              </button>
              <button type="button" onClick={() => setComposing(null)}>{t('common.cancel')}</button>
            </div>
          )}
        </div>
      ) : null}
      {/* ★2026-11-15 反馈3：截图 / 贴图 / 图片 / 随手记卡的居中编辑弹窗
          （与随手记添加弹窗同交互：临时整屏 + 点外关闭 + 命中矩形 = 弹窗矩形）。
          支持编辑标题与内容，保存走 clUpdateCard 增量写盘。 */}
      {editModal ? (
        <div
          ref={modalRef}
          className="cl-modal cl-modal-anim"
          data-cl-hit="1"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="cl-modal-head">
            <span className="cl-modal-title">{t('clothesline.edit.title')}</span>
          </div>
          {editModal.fmt ? (
            // ★2026-11-24 问题3/4：随手记编辑弹窗复用全局速记的 qn 系样式（标题输入 /
            // 富文本工具行 / 正文编辑器），正文格式与全局速记新建保存的完全一致。
            <>
              <input
                autoFocus
                className="qn-input"
                value={editModal.title}
                onChange={(e) => setEditModal((m) => (m ? { ...m, title: e.target.value } : m))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditModal(null)
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitEditModal()
                  }
                }}
                placeholder={t('clothesline.edit.titlePlaceholder')}
              />
              <QnToolbarRow onFmt={editFmt} />
              <div
                ref={editEditorRef}
                className="qn-textarea qn-in-modal"
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline
                data-placeholder={t('clothesline.edit.contentPlaceholder')}
                onInput={(e) => setEditModal((m) => (m ? { ...m, text: e.currentTarget.innerText } : m))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditModal(null)
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void commitEditModal()
                  }
                }}
              />
            </>
          ) : (
            <>
              <label className="cl-modal-row">
                <span className="cl-modal-label">{t('clothesline.edit.titleLabel')}</span>
                <input
                  autoFocus
                  className="cl-modal-input"
                  value={editModal.title}
                  onChange={(e) => setEditModal((m) => (m ? { ...m, title: e.target.value } : m))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditModal(null)
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commitEditModal()
                    }
                  }}
                  placeholder={t('clothesline.edit.titlePlaceholder')}
                />
              </label>
              <div className="cl-modal-row">
                <span className="cl-modal-label">{t('clothesline.edit.contentLabel')}</span>
                <textarea
                  className="cl-modal-textarea"
                  value={editModal.text}
                  onChange={(e) => setEditModal((m) => (m ? { ...m, text: e.target.value } : m))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditModal(null)
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void commitEditModal()
                    }
                  }}
                  placeholder={t('clothesline.edit.contentPlaceholder')}
                />
              </div>
            </>
          )}
          {/* ★2026-11-23 随手记编辑弹窗的分类段（仅 text 卡；与全局速记窗共享分类表）。
              位置与新建弹窗一致：正文编辑框下方。
              ★2026-11-24 问题3：分类行改用全局速记的 qn 系样式（视觉一致）。 */}
          {editModal.fmt ? (
            <div className="qn-cats">
              <span className="qn-cats-label">{t('quickNote.category')}</span>
              <div className="qn-cats-chips">
                {(editModal.cats ?? []).map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={`qn-chip ${editModal.category === c ? 'is-active' : ''}`}
                    onClick={() => setEditModal((m) => {
                      if (!m) return m
                      const next = m.category === c ? '' : c
                      saveLastCategory(next)
                      return { ...m, category: next }
                    })}
                  >
                    {c}
                    {/* ★2026-11-25 问题2：分类可删除（与全局速记窗一致） */}
                    <span
                      role="button"
                      aria-label={t('quickNote.catDelete')}
                      title={t('quickNote.catDelete')}
                      className="qn-chip-x"
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = removeCategory(c)
                        if (editModal.category === c) {
                          saveLastCategory('')
                          setEditModal((m) => (m ? { ...m, category: '' } : m))
                        }
                        setEditModal((m) => (m ? { ...m, cats: next } : m))
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
                {editModal.addingCat ? (
                  <input
                    className="qn-cat-input"
                    value={editModal.newCat ?? ''}
                    autoFocus
                    maxLength={8}
                    placeholder={t('quickNote.catPlaceholder')}
                    onChange={(e) => setEditModal((m) => (m ? { ...m, newCat: e.target.value } : m))}
                    onBlur={() => setEditModal((m) => {
                      if (!m) return m
                      const { cats: next, name, reason } = addCategory(m.cats ?? [], m.newCat ?? '')
                      if (name) {
                        saveLastCategory(name)
                        return { ...m, cats: next, category: name, newCat: '', addingCat: false }
                      }
                      if (reason === 'full') flash(t('quickNote.catFull'))
                      return { ...m, newCat: '', addingCat: false }
                    })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setEditModal((m) => (m ? { ...m, addingCat: false, newCat: '' } : m))
                    }}
                  />
                ) : (
                  <button type="button" className="qn-chip qn-chip-add" onClick={() => setEditModal((m) => (m ? { ...m, addingCat: true } : m))}>
                    ＋ {t('quickNote.catNew')}
                  </button>
                )}
              </div>
            </div>
          ) : null}
          {/* ★2026-11-24 问题3：字体格式段移除（qn 富文本工具行取代）；按钮与全局速记
              弹窗同款（仅文案不同：保存 / 取消）。非随手记卡保持原按钮。 */}
          {editModal.fmt ? (
            <div className="qn-actions">
              <button type="button" className="qn-btn qn-btn-hang" onClick={() => void commitEditModal()}>
                {t('common.save')}
              </button>
              <button type="button" className="qn-btn qn-btn-archive" onClick={() => setEditModal(null)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="cl-edit-actions">
              <button type="button" onClick={() => void commitEditModal()}>{t('common.save')}</button>
              <button type="button" onClick={() => setEditModal(null)}>{t('common.cancel')}</button>
            </div>
          )}
        </div>
      ) : null}

      {/* ★2026-11-18 归档：便利签/随手记/番茄卡 × → 「归档 / 删除」两选弹窗。
          复用 fullscreenModal 机制（命中矩形上报 + 点外取消 + Esc 取消）；
          进场 pop / 退场 drop 动画（140ms 合成器属性，无布局抖动）。 */}
      {takedownConfirm ? (
        <div
          ref={modalRef}
          className={`cl-modal cl-modal-confirm ${takedownClosing ? 'is-closing' : ''}`}
          data-cl-hit="1"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {takedownConfirm.kind === 'audio' ? (
            <>
              {/* ★2026-11-19 录音卡 ×：确认是否保存本次录音。 */}
              <div className="cl-modal-head">
                <span className="cl-modal-title">{t('clothesline.takedown.title', { name: takedownConfirm.title || t('clothesline.audio.defaultTitle') })}</span>
              </div>
              <div className="cl-modal-label">
                {t('clothesline.takedown.audioBody')}
              </div>
              <div className="cl-edit-actions">
                <button type="button" className="cl-btn" onClick={() => closeTakedownAnimated()}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="cl-btn is-danger"
                  onClick={() => confirmTakedown(takedownConfirm, 'audio-discard')}
                >
                  {t('clothesline.takedown.discard')}
                </button>
                <button
                  type="button"
                  className="cl-btn is-primary"
                  onClick={() => confirmTakedown(takedownConfirm, 'audio-save')}
                >
                  {t('common.save')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="cl-modal-head">
                <span className="cl-modal-title">{t('clothesline.takedown.title', { name: takedownConfirm.title || kindLabel(takedownConfirm) })}</span>
              </div>
              <div className="cl-modal-label">
                {t('clothesline.takedown.body')}
              </div>
              <div className="cl-edit-actions">
                <button type="button" className="cl-btn" onClick={() => closeTakedownAnimated()}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="cl-btn is-danger"
                  onClick={() => confirmTakedown(takedownConfirm, 'delete')}
                >
                  {t('clothesline.takedown.delete')}
                </button>
                <button
                  type="button"
                  className="cl-btn is-primary"
                  onClick={() => confirmTakedown(takedownConfirm, 'archive')}
                >
                  {t('clothesline.takedown.archive')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void onPickImage(e)}
      />

      {/* ★2026-11-17 需求3：卡片右键下拉菜单整体移除 —— 「打开原内容」收敛为
          卡片悬停图标 ⧉，「编辑 / 取下」本就有悬停按钮；★问题2：置顶已移除。 */}

      {/* ★2026-11-15 需求1c：便利签卡顶部 🎨 图标弹出的色板（与桌面便利签同族色板）。 */}
      {colorMenu ? (
        <div
          className="cl-color-menu"
          data-cl-hit="1"
          style={{ left: Math.min(colorMenu.x - 70, window.innerWidth - 160), top: Math.min(colorMenu.y + 8, window.innerHeight - 40) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {clNotePalette().map((c) => {
            const cur = cards.find((x) => x.id === colorMenu.cardId)
            const note = cur && cur.note_id ? readNoteLite(cur.note_id) : null
            const active = note?.colorKey === c.key
            return (
              <button
                key={c.key}
                type="button"
                className={active ? 'is-current' : ''}
                style={{ background: c.bg }}
                aria-label={c.label}
                title={c.label}
                onClick={(e) => {
                  e.stopPropagation()
                  onNoteColorChange(colorMenu.noteId, c.key)
                  setColorMenu(null)
                }}
              />
            )
          })}
        </div>
      ) : null}

      {/* 问题9：拖图片入绳的全窗提示遮罩。pointer-events:none 不吞 drop（drop 挂在根 div）。 */}
      {dragOver ? (
        <div className="cl-drop-overlay" aria-hidden="true">
          <div className="cl-drop-card">
            <span className="cl-drop-icon">▣</span>
            <span className="cl-drop-title">{t('clothesline.drop.title')}</span>
            <span className="cl-drop-sub">{t('clothesline.drop.sub')}</span>
          </div>
        </div>
      ) : null}

      {/* 问题3/8：全屏大图预览。★窗口恒为目标屏整屏，本层 position:fixed 相对视口铺满，
          openPreview / closePreview 都**零窗口几何写入**，绳身一个像素都不动。
          图片读 previews[card.id] 的 data URL（Rust 落盘，禁用 asset:// 防污染 canvas）。
          所有关闭路径（遮罩 / 关闭按钮 / Esc / Rust 点外部）统一走 closePreview，
          它会恢复面板命中矩形并清掉 force clickable。 */}
      {previewCardId && previews[previewCardId] && previewCard ? (
        <div
          className="cl-preview"
          data-cl-hit="1"
          onClick={() => closePreview()}
          role="presentation"
        >
          <button
            type="button"
            className="cl-pv-close"
            onClick={(e) => { e.stopPropagation(); closePreview() }}
            aria-label={t('clothesline.preview.closeAria')}
          >
            ✕
          </button>
          <div className="cl-pv-card cl-pv-image" onClick={(e) => e.stopPropagation()}>
            <div className="cl-pv-photo">
              <img
                src={previewOriginal ?? previews[previewCardId]}
                alt={previewCopy?.title || t('clothesline.preview.fallback')}
                draggable={false}
              />
            </div>
            <div className="cl-pv-info">
              <span>{previewCopy?.title || t('clothesline.preview.fallback')}</span>
              <small>{previewCopy?.text || t('clothesline.preview.onRope')}</small>
            </div>
          </div>
        </div>
      ) : null}

      {/* 拖拽幽灵卡：fixed 合成层，0 IPC 跟手。
          ★2026-11-15 需求9：旧版自绘「白纸 + 一行字」的简化卡，长按拖动时卡片瞬间
          变成白块（用户：太丑）。现在直接渲染真实 CardFace + 木夹，纸色 / 纹理 /
          圆环 / 勾选清单与静置时完全一致；颜色 / 样式 / 暗色变量同样随卡带过去。
          交互一律 pointer-events:none（见 CSS），只跟手不接点。 */}
      {dragVisual ? (() => {
        const src = cards.find((c) => c.id === dragVisual.id) ?? dragVisual.card
        const posed = posedCards.find((p) => p.card.id === dragVisual.id) ?? null
        const copy = posed?.copy ?? cardCopy(src)
        const noteColor =
          posed?.noteColor ??
          (src.note_id
            ? (clNotePalette().find((c) => c.key === readNoteLite(src.note_id)?.colorKey) ?? clNotePalette()[0])
            : null)
        const csG = Math.min(2, Math.max(1, settingsRef.current?.card_size ?? 1))
        return (
          <div
            className="cl-ghost"
            style={{ left: dragVisual.x, top: dragVisual.y, width: 168 * csG }}
            aria-hidden="true"
          >
            <div
              className={`cl-card cl-card-${src.kind}`}
              style={{
                '--cl-rot': '0deg',
                ...(noteColor
                  ? {
                      '--cl-note': noteColor.bg,
                      '--cl-note-line': noteColor.bg,
                      '--cl-note-ink': noteColor.fg,
                    }
                  : {}),
                ...(src.card_color ? { '--cl-card-bg': src.card_color } : {}),
                '--cl-card-fs': src.font_scale ?? 1,
              } as CSSProperties}
              data-style={src.kind === 'timer' ? (src.card_style ?? 'paper') : undefined}
            >
              <span className="cl-ghost-clip" />
              <CardFace
                card={src}
                copy={copy}
                thumb={posed?.thumb ?? (previews[src.id] ?? null)}
                timer={posed?.timer ?? (src.kind === 'timer' ? timerText(src, nowTick) : null)}
                ratio={posed?.ratio ?? (src.kind === 'timer' ? timerRatio(src, nowTick) : 0)}
                audio={null}
                onAudioAction={() => undefined}
                onRenameAudio={() => undefined}
                onTimerAction={() => undefined}
                onPreview={() => undefined}
                onPhotoCopy={() => undefined}
                onNoteAction={() => undefined}
                onToast={() => undefined}
              />
            </div>
          </div>
        )
      })() : null}

      {/* 恢复提示 / 排序失败提示：仅一次，不阻断 */}
      {((monitorFallback || recoveredFromBackup) && !restoring) || reorderFailed ? (
        <div className="cl-toast" role="status">
          {reorderFailed ? t('clothesline.toast.reorderCancelled') : ''}
          {recoveredFromBackup ? t('clothesline.toast.restoredBackup') : ''}
          {monitorFallback ? t('clothesline.toast.monitorFallback') : ''}
        </div>
      ) : null}
      {undoCard ? (
        <div className="cl-toast cl-toast-action" role="status">
          {undoCard.label}
          <button type="button" onClick={() => void undoTakeDown()}>{t('clothesline.toast.undo')}</button>
          <span className="cl-toast-limit">{fullAccess ? '' : t('clothesline.toast.freeLimit')}</span>
        </div>
      ) : null}
      {hint ? (
        <div
          className="cl-toast cl-toast-hint"
          role="status"
          style={
            hintX == null || hintY == null
              ? undefined
              : { left: `${hintX}px`, top: `${hintY}px`, bottom: 'auto' }
          }
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}
