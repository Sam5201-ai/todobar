import {
  ArrowLeft,
  BookOpen,
  Cake,
  Calculator,
  Camera,
  ChevronUp,
  ClipboardList,
  Coins,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Ellipsis,
  Gift,
  ListTodo,
  History,
  MessageCircle,
  Mic,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shirt,
  StickyNote,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react'
import './App.css'
// 系统头像(DiceBear avataaars,男女各半),本地打包无需联网。
import avatarA1 from './assets/avatars/a1.png'
import avatarA2 from './assets/avatars/a2.png'
import avatarA3 from './assets/avatars/a3.png'
import avatarA4 from './assets/avatars/a4.png'
import avatarA5 from './assets/avatars/a5.png'
import { useSidebarSettings, fontStackOf, FONT_OPTIONS, BACKGROUND_OPTIONS } from './sidebarSettings'
import type { SidebarSettings } from './sidebarSettings'
import {
  dockFrame,
  dockMonitorCount,
  dockShouldIgnore,
  dockSignature,
  listDockMonitors,
  resolveDockTarget,
  type DockGeometry,
  type DockMonitorOption,
  type DockRect,
  type DockSide,
  type MonitorPref,
} from './dock'
import { AccountSetting, AccountModal } from './AccountSetting'
import ScreenshotSettingsPanel from './screenshot/ScreenshotSettingsPanel'
import { ShortcutField } from './ShortcutField'
import { applyNoteShortcut } from './notes/shortcuts'
import { useNotesBridge } from './notes/useNotesBridge'
import { applyClipboardShortcut, clipboardOpenWindow, clipboardSetActive } from './clipboard'
import { getSettings as getScreenshotSettings } from './screenshot/store'
import { startCapture } from './screenshot/bridge'
import { createNoteWithWindow, failText } from './notes/manager'
import {
  DEFAULT_TOPBAR_TOOLS,
  TOPBAR_TOOLS,
  formatShortcut,
  sanitizeTopbarTools,
  splitTopbarTools,
  topbarPosition,
  type TopbarTool,
  type TopbarToolId,
  type TopbarToolsPref,
} from './topbarTools'
import {
  submitFeedback,
  fetchFeedbackHistory,
  markFeedbackRead,
  FREE_DAILY_TASK_LIMIT,
  memberOnly,
  OPEN_LOGIN_EVENT,
  OPEN_LOGIN_GUIDE_EVENT,
  AUTH_BASE,
} from './account'
import type { FeedbackItem } from './account'
import { effectiveAutoSync, useAccount } from './membership'
import {
  currentAppVersion,
  fetchReleases,
  readReleaseCache,
} from './changelog'
import type { ReleaseRecord } from './changelog'
import type { UpdateState, UpdateNotice } from './update'
import {
  fetchLatestVersion,
  isNewerVersion,
  missedVersions,
  isUpdateShown,
  markUpdateShown,
  downloadAndInstall,
} from './update'
import { SqliteStore } from './db/repository'
import {
  CN_DAYS,
  CN_MONTHS,
  daysUntilBirthday,
  formatLunar,
  leapMonth,
  nextBirthdayDate,
} from './lunar'
import {
  PRIORITY_ORDER,
  type Birthday,
  type CalendarKind,
  type OccasionKind,
  type Recurrence,
  type Task,
} from './types'
import { DATA_MIGRATED_EVENT, useTaskStore } from './useTaskStore'
import { onOcrCreateTask } from './screenshot/ocr/ocrBridge'
import { trackFeature, trackPage } from './analytics'
import {
  expandRecurrences,
  occurrenceRemindAt,
  recurrenceLabel,
  parseInstanceId,
} from './recurrence'
import { loadHolidays } from './holidays'
import { HuangliView } from './HuangliView'
import { CalculatorView } from './CalculatorView'
import { ErrorBoundary } from './ErrorBoundary'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { SalaryView, STORE_KEY as SALARY_STORE_KEY } from './SalaryView'
import { RecorderView } from './RecorderView'
import { ClotheslineSettingsPage } from './clothesline/ClotheslineSettingsPage'
import {
  clGetSettings,
  clSetAlwaysOnTop,
  clAddCard,
  clMakeCard,
  CL_OPEN_TASK,
} from './clothesline/bridge'
import { listen } from '@tauri-apps/api/event'
import { useRecorderActive } from './recorder'
import { loadDiskPref, saveDiskPref } from './prefs'
import {
  SALARY_WIDGET_KEY,
  normalizeStyle,
  disableSalaryWidgetConfig,
  type SalaryWidgetConfig,
} from './salaryWidgetConfig'

const DRAG_THRESHOLD = 5
const isTauriRuntime = () =>
  new URLSearchParams(window.location.search).get('runtime') === 'tauri' ||
  window.location.protocol === 'tauri:' ||
  navigator.userAgent.includes('Tauri') ||
  '__TAURI_INTERNALS__' in window ||
  '__TAURI__' in window

type HandleDragState = {
  startScreenY: number
  startHandleY: number
  height: number
  moved: boolean
  latestHandleY: number | null
}

function sortTasks(taskList: Task[]) {
  return [...taskList].sort((a, b) => {
    // 手动排序优先(拖拽产生的 sortOrder),其余按自动规则
    const ao = a.sortOrder ?? null
    const bo = b.sortOrder ?? null
    if (ao !== null && bo !== null && ao !== bo) return ao - bo
    if (ao !== null) return -1
    if (bo !== null) return 1

    if (Boolean(a.done) !== Boolean(b.done)) {
      return a.done ? 1 : -1
    }
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
    if (a.isImportant !== b.isImportant) return a.isImportant ? -1 : 1

    const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (priorityDelta !== 0) return priorityDelta

    return a.createdAt < b.createdAt ? 1 : -1
  })
}

/**
 * 周/月视图的排序:以「截止日期远近」为主排序键,日期越近越靠前(早的在前)。
 * 同日(或都无截止日期)时,再沿用既有的手动排序/完成态/置顶/重要/优先级规则。
 * 重复事项的虚拟实例 dueDate 已是发生日,因此与一次性任务天然按发生日混合排序。
 */
function sortByDue(taskList: Task[]) {
  return [...taskList].sort((a, b) => {
    const da = a.dueDate ?? null
    const db = b.dueDate ?? null
    if (da && db && da !== db) return da < db ? -1 : 1
    if (da && !db) return -1
    if (!da && db) return 1

    const ao = a.sortOrder ?? null
    const bo = b.sortOrder ?? null
    if (ao !== null && bo !== null && ao !== bo) return ao - bo
    if (ao !== null) return -1
    if (bo !== null) return 1

    if (Boolean(a.done) !== Boolean(b.done)) {
      return a.done ? 1 : -1
    }
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
    if (a.isImportant !== b.isImportant) return a.isImportant ? -1 : 1

    const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (priorityDelta !== 0) return priorityDelta

    return a.createdAt < b.createdAt ? 1 : -1
  })
}

// ---- 日期工具(日/周/月三个 tab 共用) ---------------------------------------

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad2 = (n: number) => String(n).padStart(2, '0')

/** ISO(UTC) → 本地 "YYYY-MM-DD HH:mm",用于反馈历史时间展示。 */
function fmtTimeShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function dayKeyOfIso(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : dayKeyOf(d)
}

/** 事项是否覆盖某一天:处理日期起止区间(YYYY-MM-DD 字符串可直接比较)内都算;
 *  兼容旧数据(无 dueEndDate = 与 dueDate 同日)。 */
function taskCoversDay(t: Task, key: string): boolean {
  const start = dayKeyOfIso(t.dueDate)
  if (!start) return false
  if (start === key) return true
  const end = dayKeyOfIso(t.dueEndDate ?? null) ?? start
  return key >= start && key <= end
}

function parseDayKey(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

function endOfDayForKey(key: string): string {
  const d = parseDayKey(key)
  d.setHours(23, 59, 0, 0)
  return d.toISOString()
}

function mondayOf(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7))
  return r
}

type TabKey = 'day' | 'week' | 'month' | 'birthday'

/** 顶部 tab 栏只放待办分类;黄历不进 tab,由顶栏图标按钮开关。 */
const TABS: { key: TabKey; label: string }[] = [
  { key: 'day', label: '日待办' },
  { key: 'week', label: '周待办' },
  { key: 'month', label: '月待办' },
  { key: 'birthday', label: '记节日' },
]

/** 系统头像表:avatar 字段存 'a1'~'a5'。 */
const AVATARS: Record<string, string> = {
  a1: avatarA1,
  a2: avatarA2,
  a3: avatarA3,
  a4: avatarA4,
  a5: avatarA5,
}
const AVATAR_KEYS = ['a1', 'a2', 'a3', 'a4', 'a5']

/** 生日列表的排序键:先按「距离下一次生日还有几天」升序。 */
function sortBirthdays(items: Birthday[]): Birthday[] {
  return [...items].sort((a, b) => {
    const da = daysUntilBirthday(a.calendar, a.month, a.day, a.isLeapMonth) ?? 99_999
    const db = daysUntilBirthday(b.calendar, b.month, b.day, b.isLeapMonth) ?? 99_999
    if (da !== db) return da - db
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/**
 * 某条生日记录「今年(或下一个)发生的那一个时刻」。
 * 公历直接取当年同月同日;农历先换算今年的对应公历日期。都再加提醒时分,
 * 并减去「提前 N 天」。
 */
function birthdayOccurrence(b: Birthday, from: Date): Date | null {
  const next = nextBirthdayDate(b.calendar, b.month, b.day, b.isLeapMonth, from)
  if (!next) return null
  const at = new Date(next)
  at.setHours(b.remindHour, b.remindMinute, 0, 0)
  if (b.remindDaysBefore > 0) at.setDate(at.getDate() - b.remindDaysBefore)
  return at
}

/** 生日当天的公历日期(不含提醒时分),用于列表展示。 */
const CN_WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** 倒计时文案:0→今天,1→明天,其余→N 天后。 */
function countdownLabel(days: number | null): string {
  if (days === null) return '—'
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  if (days < 0) return '已过'
  if (days <= 30) return `${days} 天后`
  if (days <= 365) return `${Math.round(days / 30)} 个月后`
  return `${days} 天后`
}

function App() {
  const store = useTaskStore()
  // 会员权限:未登录 / 试用过期未激活 = 受限(云端同步、计薪组件、子任务、
  // 单日新建上限、提醒、生日纪念日均按此判定)。登录或激活后自动重渲染放行。
  const { fullAccess, account } = useAccount()
  const [isNative] = useState(() => isTauriRuntime())
  // 启动默认展开:此前默认收起,冷启动首帧只有贴边把手;在混合 DPI 或窗口尚未
  // 完成几何校正时把手会被裁出视口,表现为「托盘已有图标、桌面却什么都没有」,
  // 必须再点一次托盘 toggle 才看得到。默认展开后首帧就是完整面板。
  // 保留 ?open=0 作为调试用的强制收起入口。
  const [isOpen, setIsOpen] = useState(
    () => new URLSearchParams(window.location.search).get('open') !== '0',
  )
  const [isSettingsOpen, setIsSettingsOpen] = useState(
    () => new URLSearchParams(window.location.search).get('settings') === '1',
  )
  const [settings, updateSettings] = useSidebarSettings()
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const [dragHandleY, setDragHandleY] = useState<number | null>(null)
  // 主窗统一几何:ref 供 48ms 点击穿透轮询读取,state 供 CSS 宽度 / 设置页提示使用。
  const dockGeomRef = useRef<DockGeometry | null>(null)
  const [dockGeom, setDockGeom] = useState<DockGeometry | null>(null)
  const [dockTick, setDockTick] = useState(0)
  const didNativeLayout = useRef(false)
  const dragState = useRef<HandleDragState | null>(null)
  const suppressNextClick = useRef(false)
  const workspaceRef = useRef<HTMLElement | null>(null)
  // 展开/收起动画:token 保证连点时旧循环立即让位;ref 表示「CSS 过渡进行中」,
  // 期间窗口保持可点(不穿透),避免面板还在滑出就把点击放给桌面。
  const dockAnimToken = useRef(0)
  const dockAnimatingRef = useRef(false)
  /** 上一次真正落位的几何,用于识别「切屏/改边/改宽度」迁移(迁移不做动画)。 */
  const appliedDockRef = useRef<{ geom: DockGeometry } | null>(null)
  /**
   * 上次落位时的「布局输入」签名。签名未变 ⇒ 原生窗口矩形必然没变,
   * 展开/收起可以走零 RPC 快路径,把动画 100% 交给 CSS 合成器。
   * 若每次点击都再发一次 set_size/set_position + 三次显示器查询,这些 IPC
   * 会挤进动画首帧,WebView2 重排 + 主线程排队就是残余「卡顿/不丝滑」的来源。
   */
  const dockSettingsKeyRef = useRef('')

  // ---- tab 页与主视图状态 ----------------------------------------------------

  const [activeTab, setActiveTab] = useState<TabKey>('day')
  // 埋点:tab 切换即页面访问
  useEffect(() => {
    trackPage(activeTab)
  }, [activeTab])
  const [selectedDateKey, setSelectedDateKey] = useState(() => dayKeyOf(new Date()))
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  // 周/月视图日期栏「+」指定的目标日期;null = 走底部「添加事项」原有默认行为。
  const [addSheetDateKey, setAddSheetDateKey] = useState<string | null>(null)
  // 「恢复云端数据」的底部弹窗:true = 打开(展示覆盖/添加两种模式)
  const [restoreSheetOpen, setRestoreSheetOpen] = useState(false)
  const [settingsTaskId, setSettingsTaskId] = useState<string | null>(null)
  // 打开重复事项设置时记录其发生日,用于「仅删除该日期」选项。
  const [settingsOccurrenceKey, setSettingsOccurrenceKey] = useState<string | null>(null)
  // 重复事项的「本次 vs 整组」范围确认(改名 / 添加子任务)。
  const [recurScope, setRecurScope] = useState<
    | { kind: 'edit'; templateId: string; dateKey: string; newTitle: string }
    | { kind: 'child'; parentInstanceId: string; templateId: string; dateKey: string; title: string }
    | null
  >(null)
  const selectedChipRef = useRef<HTMLButtonElement | null>(null)
  const dateStripRef = useRef<HTMLDivElement | null>(null)

  // 记节日 tab 的弹窗状态:null = 关闭;'new-birthday'/'new-anniversary' = 新建;其余为要编辑的记录 id
  const [birthdaySheet, setBirthdaySheet] = useState<'new-birthday' | 'new-anniversary' | string | null>(null)
  // 生日/纪念日分组的展开收起(收起时只显示分组标题)
  const [occasionCollapsed, setOccasionCollapsed] = useState<{ birthday: boolean; anniversary: boolean }>({
    birthday: false,
    anniversary: false,
  })

  // 周/月视图的浏览锚点(支持上一周/下一周、上一月/下一月切换)
  const [weekAnchor, setWeekAnchor] = useState(() => mondayOf(new Date()).getTime())
  const [monthCursor, setMonthCursor] = useState(() => ({
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
  }))

  // 选中日期滚动到可见位置。
  // 依赖里必须带上 activeTab:日期条在切换走后会重新挂载,滚动位置归零,
  // 若此时 selectedDateKey 没变(仍是今天),effect 不会触发,选中的格子会停在视野外。
  //
  // 这里不再用 scrollIntoView():它会把"所有可滚动祖先"一起滚动(包括侧栏
  // 主容器,导致整屏上下跳),而且 inline:'center' 每次点击都强行居中,日期条
  // 会来回位移、看起来是闪烁。改为只对日期条本身做水平滚动,并且选中项已经
  // 完整可见时直接不动。
  useEffect(() => {
    if (activeTab !== 'day') return
    const raf = requestAnimationFrame(() => {
      const strip = dateStripRef.current
      const chip = selectedChipRef.current
      if (!strip || !chip) return

      const stripRect = strip.getBoundingClientRect()
      const chipRect = chip.getBoundingClientRect()
      const offsetInView = chipRect.left - stripRect.left
      const gutter = 8

      // 已经完整可见 -> 不动,避免每次切换日期都抖动
      if (offsetInView >= gutter && chipRect.right <= stripRect.right - gutter) return

      const target =
        strip.scrollLeft + offsetInView - (strip.clientWidth - chipRect.width) / 2
      const maxScroll = strip.scrollWidth - strip.clientWidth
      const left = Math.max(0, Math.min(target, maxScroll))

      // 位移很小时直接瞬移,避免为了几像素播一段平滑滚动
      if (Math.abs(left - strip.scrollLeft) < 4) return
      strip.scrollTo({ left, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [activeTab, selectedDateKey])

  const todayKey = dayKeyOf(new Date())

  // ---- 同步:顶部图标 + toast 反馈 -------------------------------------------

  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // ---- 版本更新:App 根统一持有状态,首页弹窗与设置页共用同一份进度 -------------
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  /** 已检查到新版本但尚未展示的弹窗数据(收起侧栏时先暂存)。 */
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null)
  const [updateNoticeOpen, setUpdateNoticeOpen] = useState(false)
  /** StrictMode 双挂载守卫:一次启动最多弹一次。 */
  const updatePromptedRef = useRef(false)

  // 全局登录弹窗 + 未登录引导弹窗:受限功能点击时分流——未登录 → 引导去登录;
  // 已登录但非会员(试用过期) → 维持「会员功能」提示 toast。
  const [loginModalOpen, setLoginModalOpen] = useState(false)
  const [loginView, setLoginView] = useState<'auth' | 'password'>('auth')
  const [loginGuide, setLoginGuide] = useState<{ open: boolean }>({ open: false })
  /** 全局弹窗的挂载点:挂进 .todo-sidebar 而非 document.body,让 absolute 遮罩只覆盖
   *  工具面板(左侧透明把手区不受遮罩/卡片影响),并继承 .workspace 上的主题变量。
   *  用 callback ref + state 拿节点,避免 render 阶段 querySelector 拿不到 DOM。 */
  const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null)

  // 任意入口派发 OPEN_LOGIN_EVENT → 打开全局登录弹窗(例如引导弹窗「去登录」按钮);
  // 派发 OPEN_LOGIN_GUIDE_EVENT → 打开「去登录」引导弹窗(未登录用户点击受限功能)。
  // ⚠️ 引导文案不再点名具体功能、也不承诺「登录后即可使用」:登录只是解锁的前提,
  // 具体能力还取决于账号当前是否在试用期 / 已激活会员,故事件携带的功能名不再读取。
  useEffect(() => {
    const openLogin = () => {
      setLoginView('auth')
      setLoginModalOpen(true)
    }
    const openGuide = () => setLoginGuide({ open: true })
    window.addEventListener(OPEN_LOGIN_EVENT, openLogin)
    window.addEventListener(OPEN_LOGIN_GUIDE_EVENT, openGuide)
    return () => {
      window.removeEventListener(OPEN_LOGIN_EVENT, openLogin)
      window.removeEventListener(OPEN_LOGIN_GUIDE_EVENT, openGuide)
    }
  }, [])

  // 受限功能统一拦截入口:未登录弹「去登录」引导;已登录非会员维持会员提示。
  const handleLocked = (feature: string) => {
    if (!account) {
      setLoginGuide({ open: true })
    } else {
      setToast({ kind: 'err', text: memberOnly(feature) })
    }
  }

  // 启动取当前版本号 + 拉取远程法定节假日。原先这两件事挂在设置页组件里,
  // 用户不进设置页就不跑;上移到根后首页弹窗才能拿到版本号,节假日也不再依赖设置页。
  useEffect(() => {
    void currentAppVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''))
    void loadHolidays()
  }, [])

  // 启动约 1.5s 后检查更新:version.json 判定最新版本 + 安装包 URL,
  // /api/releases 的版本记录提供弹窗文案。检查失败静默(设置页仍可手动检查)。
  // **检查与展示分离**:收起侧栏时只暂存数据,等展开再弹,避免贴边状态糊全屏遮罩。
  useEffect(() => {
    if (!appVersion) return
    let alive = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const latest = await fetchLatestVersion()
          if (!alive) return
          const hasNew = isNewerVersion(latest.version, appVersion)
          setUpdateState(
            hasNew
              ? { status: 'available', version: latest.version, url: latest.url }
              : { status: 'latest' },
          )
          if (!hasNew) return
          // 版本记录:网络优先,失败用本地缓存;都没有时靠 notes 兜底,不阻塞弹窗。
          let releases = readReleaseCache() ?? []
          try {
            releases = await fetchReleases()
          } catch {
            /* 静默降级到缓存 */
          }
          if (!alive) return
          const exact = releases.find((r) => r.version === latest.version) ?? null
          setUpdateNotice({
            version: latest.version,
            url: latest.url,
            notes: latest.notes,
            date: exact?.release_date ?? '',
            title: exact?.title ?? '',
            items: exact?.items ?? [],
            missed: missedVersions(releases, appVersion, latest.version),
            releases,
          })
        } catch {
          /* 检查失败不打扰用户 */
        }
      })()
    }, 1500)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [appVersion])

  // 仅侧栏展开、且没有其他全局弹窗占用时展示。去重标记改由弹窗组件在
  // **真正渲染成功后**写入(见 UpdateNoticeSheet);以前在「决定展示」时就写,
  // 弹窗自身渲染崩溃也会白耗这一版唯一一次机会,用户重启再也看不到更新说明。
  useEffect(() => {
    if (!updateNotice || updatePromptedRef.current) return
    if (isUpdateShown(updateNotice.version)) {
      setUpdateNotice(null)
      return
    }
    if (!isOpen || loginGuide.open || loginModalOpen) return
    updatePromptedRef.current = true
    setUpdateNoticeOpen(true)
  }, [isOpen, updateNotice, loginGuide.open, loginModalOpen])

  // 账号分库:启动时把游客库数据并入已登录账号库后广播,这里弹 toast 告知。
  useEffect(() => {
    const onMigrated = (e: Event) => {
      const n = (e as CustomEvent<number>).detail
      if (typeof n === 'number' && n > 0) setToast({ kind: 'ok', text: `已把本地 ${n} 条数据并入账号` })
    }
    window.addEventListener(DATA_MIGRATED_EVENT, onMigrated)
    return () => window.removeEventListener(DATA_MIGRATED_EVENT, onMigrated)
  }, [])

  // 便利签:磁盘回灌 + 注册快捷键 + 处理「转待办」请求,逻辑全在 notes/useNotesBridge。
  useNotesBridge({
    noteShortcut: settings.noteShortcut,
    store,
    setToast: (kind, text) => setToast({ kind, text }),
  })

  // 剪贴板浮窗快捷键:设置变化时注册 / 重注册。非会员不注册(会员专属);
  // 会员态变化(fullAccess)时也重注册 / 注销。失败静默降级(多为与系统快捷键冲突)。
  useEffect(() => {
    void applyClipboardShortcut(fullAccess ? settings.clipboardShortcut : '').then((r) => {
      if (!r.ok) console.warn('[clipboard] 快捷键注册失败:', r.error)
    })
  }, [settings.clipboardShortcut, fullAccess])

  // 会员态变化(登录 / 激活 / 试用过期)时,统一对齐各会员功能的后端状态:
  // - 后台剪贴板监听按会员开关启停(非会员彻底不记录);
  // - 截图 / 贴图快捷键按会员态重注册 / 注销(applyShortcuts 内部已自闸)。
  // 首次挂载也会执行,据此设置初始开关。
  useEffect(() => {
    void clipboardSetActive(fullAccess)
    void import('./screenshot/shortcuts').then((m) => m.applyShortcuts()).catch(() => {})
  }, [fullAccess])

  const prevSyncStatus = useRef(store.syncState.status)

  useEffect(() => {
    const status = store.syncState.status
    if (prevSyncStatus.current === 'syncing' && status === 'idle') {
      setToast({ kind: 'ok', text: '同步成功' })
    } else if (prevSyncStatus.current === 'syncing' && status === 'error') {
      // 未登录/非会员(如刚登出)不弹同步失败:此时本就不该同步,弹窗只会造成困扰。
      if (fullAccess) {
        setToast({ kind: 'err', text: `同步失败:${store.syncState.lastError ?? '网络异常'}` })
      }
    }
    prevSyncStatus.current = status
  }, [store.syncState.status, store.syncState.lastError, fullAccess])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  const onHeaderSync = () => {
    if (!store.syncConfig.enabled) {
      setToast({ kind: 'err', text: '请先登录账号以开启云同步' })
      return
    }
    // 会员闸门:受限用户(未登录 / 试用过期未激活)不能上传云端。
    if (!fullAccess) {
      handleLocked('云同步')
      return
    }
    trackFeature('sync')
    store.triggerSync()
  }

  // 「恢复云端数据」:唤起底部弹窗选择模式后执行,结果用 toast 精确反馈。
  const handleRestore = async (mode: 'overwrite' | 'merge') => {
    setRestoreSheetOpen(false)
    // 会员闸门:受限用户不能从云端恢复数据。
    if (!fullAccess) {
      handleLocked('恢复云端数据')
      return
    }
    if (!store.syncConfig.enabled) {
      setToast({ kind: 'err', text: '请先登录账号以开启云同步' })
      return
    }
    const r = await store.restoreFromCloud(mode)
    if (!r.ok) {
      setToast({ kind: 'err', text: `恢复失败:${r.reason ?? '未知错误'}` })
      return
    }
    if (mode === 'overwrite') {
      setToast({
        kind: 'ok',
        text: `已用云端覆盖本地:恢复 ${r.added ?? 0} 条,移除本地独有 ${r.removed ?? 0} 条`,
      })
    } else {
      setToast({
        kind: 'ok',
        text: `已从云端补充 ${r.added ?? 0} 条,跳过本地已有 ${r.skipped ?? 0} 条`,
      })
    }
  }

  const lastSyncLabel = useMemo(() => {
    const times = [store.syncState.lastPushAt, store.syncState.lastPullAt].filter(
      (x): x is string => Boolean(x),
    )
    if (times.length === 0) return ''
    const latest = new Date(times.sort()[times.length - 1])
    if (Number.isNaN(latest.getTime())) return ''
    return `${pad2(latest.getHours())}:${pad2(latest.getMinutes())}`
  }, [store.syncState.lastPushAt, store.syncState.lastPullAt])

  // 黄历是独立页面(仿设置页):顶栏图标进入,右上角 X 关闭。
  // 不占 tab,也不切换 activeTab;打开时整块替换侧栏内容。
  const [huangliOpen, setHuangliOpen] = useState(false)
  const toggleHuangli = () => {
    setClotheslineOpen(false)
    setHuangliOpen((c) => {
      if (!c) trackPage('huangli')
      return !c
    })
  }

  // 计算器是独立页面(仿设置页 / 万年历):顶栏图标进入,标题"计算器"。
  const [calculatorOpen, setCalculatorOpen] = useState(false)
  const toggleCalculator = () => {
    setClotheslineOpen(false)
    setCalculatorOpen((c) => {
      if (!c) trackPage('calculator')
      return !c
    })
  }

  // 牛马计薪器:顶栏独立入口图标(位于计算器左侧),点击打开计薪页面。
  const [salaryOpen, setSalaryOpen] = useState(false)
  const toggleSalary = () => {
    setClotheslineOpen(false)
    setSalaryOpen((c) => {
      if (!c) trackPage('salary')
      return !c
    })
  }

  // 录音机:顶栏独立入口图标(位于牛马计薪器左侧),点击打开录音页面。
  // 录音引擎独立于页面生命周期,录音中图标亮红点(useRecorderActive 仅订阅状态变化)。
  const [recorderOpen, setRecorderOpen] = useState(false)
  const toggleRecorder = () => {
    setClotheslineOpen(false)
    // 录音为会员专属,但闸门设在页内的「开始录音」按钮(RecorderView.handleStart):
    // 非会员仍可进页查看 / 回放 / 管理已有录音,点录音时才提示开通。
    setRecorderOpen((c) => {
      if (!c) trackPage('recorder')
      return !c
    })
  }
  const recorderActive = useRecorderActive()

  // 晾衣绳配置页(0.4.65:仿设置页的独立页面)。非会员可用(拉新记忆点),无闸门。
  const [clotheslineOpen, setClotheslineOpen] = useState(false)
  const toggleClothesline = () => {
    setClotheslineOpen((c) => {
      if (!c) {
        // 与其余独立页面互斥:避免多个绝对定位 PageShell 叠加。
        setIsSettingsOpen(false)
        setHuangliOpen(false)
        setCalculatorOpen(false)
        setSalaryOpen(false)
        setRecorderOpen(false)
        trackPage('clothesline')
      }
      return !c
    })
  }
  // ＋ 菜单第 7 行常驻置顶开关的真源镜像(写入只走 clothesline_set_always_on_top)。
  // 挂载即读磁盘真源(不硬编码 true)，并监听绳窗右键 / 其它入口的置顶变更，
  // 保证 ＋ 菜单显示与窗口实际置顶态始终一致。
  const [clTopmost, setClTopmost] = useState(true)
  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    void clGetSettings()
      .then((s) => {
        if (!cancelled) setClTopmost(s.always_on_top)
      })
      .catch(() => undefined)
    void listen<boolean>('clothesline-topmost-changed', (e) => {
      if (!cancelled) setClTopmost(e.payload)
    })
      .then((fn) => {
        if (cancelled) fn()
        else un = fn
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      un?.()
    }
  }, [])
  const toggleClTopmost = () => {
    const next = !clTopmost
    setClTopmost(next) // 乐观更新；失败回滚(事件监听也会同步真源)
    void clSetAlwaysOnTop(next).catch(() => setClTopmost(!next))
  }

  // 晾衣绳「打开原内容 · 待办」：只切到对应清单 + 日期并关掉设置页，
  // 不触碰任务数据（绳窗绝不直连 SQLite，避免第二个 repo 实例与同步引擎打架）。
  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    void listen<{ id: string }>(CL_OPEN_TASK, (e) => {
      if (cancelled) return
      const t = store.tasks.find((x) => x.id === e.payload.id)
      if (!t) {
        setToast({ kind: 'err', text: '这条待办已删除' })
        return
      }
      setActiveTab(t.listId === 'month' ? 'month' : 'day')
      if (t.dueDate) setSelectedDateKey(t.dueDate.slice(0, 10))
      setClotheslineOpen(false)
      setToast({ kind: 'ok', text: '已定位到这条待办' })
    })
      .then((fn) => {
        if (cancelled) fn()
        else un = fn
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      un?.()
    }
  }, [store.tasks, setClotheslineOpen, setActiveTab, setSelectedDateKey])

  // ---- 首页顶栏快捷入口:动态槽位 + 「⋯ 更多」溢出菜单 -----------------------
  const [moreOpen, setMoreOpen] = useState(false)
  /** 「管理顶栏入口…」直达设置页并滚动到配置分组,自增 token 触发一次定位。 */
  const [topbarFocus, setTopbarFocus] = useState(0)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)

  const topbar = useMemo(
    () => splitTopbarTools(settings.topbarTools, settings.panelWidth),
    [settings.topbarTools, settings.panelWidth],
  )

  // 菜单里的快捷键提示跟随设置页里用户改过的值(截图快捷键读运行时缓存)。
  const shortcutLabels = useMemo<Partial<Record<TopbarToolId, string>>>(() => ({
    screenshot: formatShortcut(getScreenshotSettings().shotShortcut || ''),
    note: formatShortcut(settings.noteShortcut),
    clipboard: formatShortcut(settings.clipboardShortcut),
    sync: lastSyncLabel ? `同步于 ${lastSyncLabel}` : '',
  }), [settings.noteShortcut, settings.clipboardShortcut, lastSyncLabel])

  // 侧栏收起时菜单不该残留;点击菜单外 / Esc 关闭(带 StrictMode 卸载守卫)。
  useEffect(() => {
    if (!isOpen) setMoreOpen(false)
  }, [isOpen])
  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (moreMenuRef.current?.contains(target) || moreBtnRef.current?.contains(target)) return
      setMoreOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  /** 顶栏 / 更多菜单的统一点击分发:会员闸门 → 埋点 → 触发对应功能。 */
  const runTopbarTool = (id: TopbarToolId, name: string) => {
    setMoreOpen(false)
    const tool = TOPBAR_TOOLS.find((t) => t.id === id)
    // 录音机 / 同步的闸门在各自页内或 onHeaderSync 内,这里只拦三个桌面套件入口。
    if (tool?.gated && !fullAccess) {
      handleLocked(name)
      return
    }
    trackFeature(`topbar:${id}`)
    switch (id) {
      case 'screenshot':
        // 区域模式进入,覆盖层工具栏可现场切换窗口 / 全屏(与截图快捷键一致)。
        void startCapture('region')
        break
      case 'note':
        void createNoteWithWindow(fullAccess).then((r) => {
          if (!r.ok) setToast({ kind: 'err', text: failText(r.reason) })
        })
        break
      case 'clipboard':
        void clipboardOpenWindow().then((ok) => {
          if (!ok) setToast({ kind: 'err', text: '剪贴板窗口打开失败，请重启工具后再试' })
        })
        break
      case 'calculator':
        toggleCalculator()
        break
      case 'huangli':
        toggleHuangli()
        break
      case 'salary':
        toggleSalary()
        break
      case 'recorder':
        toggleRecorder()
        break
      case 'clothesline':
        toggleClothesline()
        break
      case 'sync':
        onHeaderSync()
        break
    }
  }

  const openSettingsPage = () => {
    setMoreOpen(false)
    setClotheslineOpen(false)
    setIsSettingsOpen((c) => {
      if (!c) trackPage('settings')
      return !c
    })
  }

  const manageTopbarTools = () => {
    setMoreOpen(false)
    setIsSettingsOpen(true)
    trackPage('settings')
    setTopbarFocus((n) => n + 1)
  }

  // ---- 生日 tab 派生数据 -----------------------------------------------------

  const birthdayItems = useMemo(
    () => sortBirthdays(store.birthdays.filter((b) => (b.kind ?? 'birthday') === 'birthday')),
    [store.birthdays],
  )

  const anniversaryItems = useMemo(
    () => sortBirthdays(store.birthdays.filter((b) => b.kind === 'anniversary')),
    [store.birthdays],
  )

  const birthdayUpcomingCount = useMemo(
    () =>
      birthdayItems.filter((b) => {
        const d = daysUntilBirthday(b.calendar, b.month, b.day, b.isLeapMonth)
        return d !== null && d <= 30
      }).length,
    [birthdayItems],
  )

  const editingBirthday =
    birthdaySheet && !birthdaySheet.startsWith('new-')
      ? store.birthdays.find((b) => b.id === birthdaySheet) ?? null
      : null

  // 全量父子索引(子任务通过 parentId 挂载,与日期无关)
  const childMap = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of store.tasks) {
      if (!t.parentId) continue
      const arr = map.get(t.parentId) ?? []
      arr.push(t)
      map.set(t.parentId, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    return map
  }, [store.tasks])

  // 某一天的主任务列表(含旧数据兼容:无截止日期的 today 清单任务归入今天)
  const tasksForDay = useCallback(
    (key: string) => {
      const d = parseDayKey(key)
      const expanded = expandRecurrences(store.tasks, d, d)
      const top = expanded.filter(
        (t) =>
          !t.parentId &&
          (taskCoversDay(t, key) ||
            (!t.dueDate && t.listId === 'today' && key === todayKey)),
      )
      const visible = settings.showCompleted ? top : top.filter((t) => !t.done)
      return sortTasks(visible)
    },
    [store.tasks, todayKey, settings.showCompleted],
  )

  const dayTop = useMemo(() => tasksForDay(selectedDateKey), [tasksForDay, selectedDateKey])

  // 日期条(-7 ~ +14 天)圆点规则:
  // 当天无事项 → 无圆点;有未完成 → 红点;有事项但全部完成 → 蓝点
  const dateStrip = useMemo(() => {
    const base = parseDayKey(todayKey)
    const rangeStart = new Date(base)
    rangeStart.setDate(rangeStart.getDate() - 7)
    const rangeEnd = new Date(base)
    rangeEnd.setDate(rangeEnd.getDate() + 14)
    const expanded = expandRecurrences(store.tasks, rangeStart, rangeEnd)
    const chips: {
      key: string
      dayLabel: string
      weekLabel: string
      dot: 'none' | 'open' | 'done'
    }[] = []
    for (let offset = -7; offset <= 14; offset += 1) {
      const d = new Date(base)
      d.setDate(d.getDate() + offset)
      const key = dayKeyOf(d)
      const dayTasks = expanded.filter(
        (t) =>
          !t.parentId &&
          (taskCoversDay(t, key) ||
            (!t.dueDate && t.listId === 'today' && key === todayKey)),
      )
      const openCount = dayTasks.filter((t) => !t.done).length
      chips.push({
        key,
        dayLabel: `${d.getMonth() + 1}/${d.getDate()}`,
        weekLabel: offset === 0 ? '今天' : WEEKDAY_CN[d.getDay()],
        dot: dayTasks.length === 0 ? 'none' : openCount > 0 ? 'open' : 'done',
      })
    }
    return chips
  }, [store.tasks, todayKey])

  const selectedDateLabel = useMemo(() => {
    const d = parseDayKey(selectedDateKey)
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_CN[d.getDay()]}`
  }, [selectedDateKey])

  // 周/月视图日期栏「+」:把点击的那一天带进添加弹窗(展示用),保存时按该日期落库。
  const addSheetDateLabel = useMemo(() => {
    if (!addSheetDateKey) return null
    const d = parseDayKey(addSheetDateKey)
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_CN[d.getDay()]}`
  }, [addSheetDateKey])

  const openAddSheetForDate = (key: string) => {
    trackFeature('add-task')
    setAddSheetDateKey(key)
    setAddSheetOpen(true)
  }

  const weekGroups = useMemo(() => {
    const monday = new Date(weekAnchor)
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)
    const expanded = expandRecurrences(store.tasks, monday, sunday)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(d.getDate() + i)
      const key = dayKeyOf(d)
      return {
        key,
        label: `${key.slice(5)} ${WEEKDAY_CN[d.getDay()]}`,
        isToday: key === todayKey,
        items: sortByDue(
          (settings.showCompleted ? expanded : expanded.filter((t) => !t.done)).filter(
            (t) => !t.parentId && taskCoversDay(t, key),
          ),
        ),
      }
    })
  }, [store.tasks, todayKey, weekAnchor, settings.showCompleted])
  const weekTotal = weekGroups.reduce((sum, g) => sum + g.items.length, 0)

  const weekRangeLabel = useMemo(() => {
    const monday = new Date(weekAnchor)
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)
    const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
    const isCurrent = weekAnchor === mondayOf(new Date()).getTime()
    return { text: `${fmt(monday)} - ${fmt(sunday)}`, isCurrent }
  }, [weekAnchor])

  const monthGroups = useMemo(() => {
    const { year, month } = monthCursor
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const rangeStart = new Date(year, month, 1)
    const rangeEnd = new Date(year, month, daysInMonth)
    const expanded = expandRecurrences(store.tasks, rangeStart, rangeEnd)
    const groups: { key: string; label: string; isToday: boolean; items: Task[] }[] = []
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = dayKeyOf(new Date(year, month, day))
      const items = expanded.filter((t) => !t.parentId && taskCoversDay(t, key))
      if (items.length > 0) {
        const visible = settings.showCompleted ? items : items.filter((t) => !t.done)
        groups.push({
          key,
          label: `${key.slice(5)} ${WEEKDAY_CN[parseDayKey(key).getDay()]}`,
          isToday: key === todayKey,
          items: sortByDue(visible),
        })
      }
    }
    const now = new Date()
    const isCurrent = year === now.getFullYear() && month === now.getMonth()
    const undated = store.tasks.filter(
      (t) => !t.parentId && !t.dueDate && t.listId === 'month',
    )
    const visibleUndated = settings.showCompleted ? undated : undated.filter((t) => !t.done)
    if (visibleUndated.length > 0 && isCurrent) {
      groups.push({
        key: 'undated',
        label: '未安排日期',
        isToday: false,
        items: sortTasks(visibleUndated),
      })
    }
    return groups
  }, [store.tasks, todayKey, settings.showCompleted, monthCursor])
  const monthTotal = monthGroups.reduce((sum, g) => sum + g.items.length, 0)
  const monthLabel = `${monthCursor.year}年${monthCursor.month + 1}月`
  const monthIsCurrent =
    monthCursor.year === new Date().getFullYear() && monthCursor.month === new Date().getMonth()

  const shiftWeek = (delta: number) => {
    const next = new Date(weekAnchor)
    next.setDate(next.getDate() + delta * 7)
    setWeekAnchor(next.getTime())
  }
  const shiftMonth = (delta: number) => {
    setMonthCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  const settingsTask = useMemo(
    () => store.tasks.find((t) => t.id === settingsTaskId) ?? null,
    [store.tasks, settingsTaskId],
  )
  // 设置面板当前任务的父级。父级是重复模板(带 recurrence)时,该任务是「重复事项的
  // 整组子任务」,删除需弹「仅本次 / 所有重复日」范围确认。
  // 父级 id 带 @ 的「仅本次」子任务在真实表里查不到父级——范围本就只限本次,直接删。
  const settingsSubRecurrence = useMemo(() => {
    if (!settingsTask?.parentId) return null
    const parent = store.tasks.find((t) => t.id === settingsTask.parentId)
    return parent?.recurrence ?? null
  }, [store.tasks, settingsTask])

  const visibleHandleY = dragHandleY ?? settings.handleY
  const effectivePanelWidth = useMemo(() => {
    // 原生模式下直接用统一几何算出的面板宽度,保证 CSS 宽度、窗口物理宽度与
    // 点击穿透判定三者严格一致(此前各算一份,混合 DPI 下会出现边缘错位)。
    if (isNative && dockGeom) return dockGeom.panelCssWidth
    const availableWidth = Math.max(280, viewportWidth - settings.tabWidth - 8)
    return Math.min(settings.panelWidth, availableWidth)
  }, [dockGeom, isNative, settings.panelWidth, settings.tabWidth, viewportWidth])
  const nativeHandleCenter = useMemo(() => {
    const height = Math.max(settings.handleHeight, viewportHeight || 0)
    const half = settings.handleHeight / 2
    const travel = Math.max(0, height - settings.handleHeight)
    return Math.min(
      height - half - 8,
      Math.max(half + 8, half + (travel * visibleHandleY) / 100),
    )
  }, [settings.handleHeight, visibleHandleY, viewportHeight])
  const dockSurface = useMemo(() => {
    const width = settings.tabWidth + effectivePanelWidth
    const height = Math.max(settings.handleHeight, viewportHeight || 0)
    const x = settings.tabWidth
    const handleRadius = Math.max(0, Math.min(14, settings.tabWidth / 2 - 1, settings.handleHeight / 2 - 1))
    const half = settings.handleHeight / 2
    const travel = Math.max(0, height - settings.handleHeight)
    const center = Math.min(
      height - half - 8,
      Math.max(half + 8, half + (travel * visibleHandleY) / 100),
    )
    const top = center - half
    const bottom = center + half
    const topDockRadius = Math.max(0, Math.min(16, settings.tabWidth * 0.55, top))
    const bottomDockRadius = Math.max(0, Math.min(16, settings.tabWidth * 0.55, height - bottom))
    const topPanelRadius = Math.max(0, Math.min(settings.panelRadius, top - topDockRadius))
    const bottomPanelRadius = Math.max(0, Math.min(settings.panelRadius, height - bottom - bottomDockRadius))
    return {
      height,
      path: [
        `M ${x + topPanelRadius} 0`,
        `H ${width}`,
        `V ${height}`,
        `H ${x + bottomPanelRadius}`,
        `Q ${x} ${height} ${x} ${height - bottomPanelRadius}`,
        `V ${bottom + bottomDockRadius}`,
        `Q ${x} ${bottom} ${x - bottomDockRadius} ${bottom}`,
        `H ${handleRadius}`,
        `Q 0 ${bottom} 0 ${bottom - handleRadius}`,
        `V ${top + handleRadius}`,
        `Q 0 ${top} ${handleRadius} ${top}`,
        `H ${x - topDockRadius}`,
        `Q ${x} ${top} ${x} ${top - topDockRadius}`,
        `V ${topPanelRadius}`,
        `Q ${x} 0 ${x + topPanelRadius} 0`,
        'Z',
      ].join(' '),
      width,
    }
  }, [
    settings.handleHeight,
    settings.panelRadius,
    settings.tabWidth,
    effectivePanelWidth,
    visibleHandleY,
    viewportHeight,
  ])

  // Desktop reminders: fire a native notification when a task's remindAt passes.
  //
  // 生日/纪念日提醒与待办不同:它是「每年重复」的,去重 key 带上发生日
  // (`birthday:<id>:<YYYY-MM-DD>`),并持久化到 localStorage——否则应用重启后
  // remindedRef 清空,同一个提醒会再次弹出。生日/纪念日不像待办那样需要
  // 「未完成就反复提醒」,每次发生只提醒一次。
  const REMINDED_STORE_KEY = 'todobar.reminded.v1'
  const remindedRef = useRef<Set<string> | null>(null)
  if (remindedRef.current === null) {
    let saved: string[] = []
    try {
      saved = JSON.parse(localStorage.getItem(REMINDED_STORE_KEY) ?? '[]') as string[]
    } catch {
      saved = []
    }
    remindedRef.current = new Set(saved)
  }
  const rememberReminded = (key: string) => {
    const set = remindedRef.current!
    set.add(key)
    // 只保留最近 300 条,避免无限膨胀。
    const trimmed = [...set].slice(-300)
    remindedRef.current = new Set(trimmed)
    try {
      localStorage.setItem(REMINDED_STORE_KEY, JSON.stringify(trimmed))
    } catch {
      // 持久化失败只影响重启后的去重,不影响本次提醒。
    }
  }
  useEffect(() => {
    if (!isNative) return
    const tick = async () => {
      const now = Date.now()
      const notify = async (title: string, body: string) => {
        try {
          const { sendNotification } = await import('@tauri-apps/plugin-notification')
          sendNotification({ title, body })
        } catch {
          // Notifications are best-effort.
        }
      }

      // 重复模板投影出「今天」的虚拟实例:每个发生日按自己生效的提醒时间弹通知。
      // 模板本身不直接提醒(recurrence 非空即跳过);去重 key 用实例 id,天然带发生日。
      const todayInstances = expandRecurrences(store.tasks, new Date(now), new Date(now))
      for (const t of [...store.tasks, ...todayInstances]) {
        if (t.done || t.recurrence || !t.remindAt || remindedRef.current!.has(t.id)) continue
        if (new Date(t.remindAt).getTime() <= now) {
          remindedRef.current!.add(t.id)
          await notify('待办提醒', t.title)
        }
      }

      // 生日/纪念日提醒:把「每年 X 月 X 日 X 时 X 分」换算成今年的具体时刻再比较。
      // 提前 N 天提醒通过把发生时刻减去 N 天实现。每次发生只提醒一次(持久化去重,
      // 重启后也不会对同一次发生重复弹提醒)。
      const nowDate = new Date(now)
      for (const b of store.birthdays) {
        if (!b.remindEnabled || !b.name.trim()) continue
        const occurrence = birthdayOccurrence(b, nowDate)
        if (!occurrence) continue
        if (occurrence.getTime() > now) continue

        const key = `birthday:${b.id}:${dayKeyOf(occurrence)}`
        if (remindedRef.current!.has(key)) continue
        rememberReminded(key)

        const isAnniversary = (b.kind ?? 'birthday') === 'anniversary'
        const isToday = dayKeyOf(occurrence) === dayKeyOf(nowDate)
        const label = b.calendar === 'lunar'
          ? `农历${formatLunar(b.month, b.day, b.isLeapMonth)}`
          : `${b.month} 月 ${b.day} 日`
        await notify(
          isToday
            ? isAnniversary
              ? `今天是 ${b.name}`
              : `今天是 ${b.name} 的生日`
            : isAnniversary
              ? `${b.name} 快到了`
              : `${b.name} 的生日快到了`,
          isToday
            ? `${label}${b.relation ? ` · ${b.relation}` : ''}`
            : `${label} · 还有 ${daysUntilBirthday(b.calendar, b.month, b.day, b.isLeapMonth, nowDate)} 天`,
        )
      }
    }
    tick()
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [isNative, store.tasks, store.birthdays])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcut =
        event.shiftKey &&
        event.key.toLowerCase() === 't' &&
        (event.metaKey || event.ctrlKey)

      if (shortcut || event.key === 'Escape') {
        event.preventDefault()
        setIsOpen((current) => (event.key === 'Escape' ? false : !current))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const syncViewportSize = () => {
      // 动画期间窗口宽度逐帧变化,跳过 setState:否则整个 App 每帧重渲染,
      // 且 viewportWidth 会被 42px 的中间宽度污染。
      if (dockAnimatingRef.current) return
      if (isNative) {
        // 原生模式的面板宽度一律由 dock.ts 的目标屏几何给出(syncNativeWindow
        // 里已写入),这里只同步高度,不用跟逐帧变化的 innerWidth。
        setViewportHeight(window.innerHeight)
        return
      }
      setViewportWidth(window.innerWidth)
      setViewportHeight(window.innerHeight)
    }

    syncViewportSize()
    window.addEventListener('resize', syncViewportSize)
    return () => window.removeEventListener('resize', syncViewportSize)
  }, [isNative])

  useEffect(() => {
    document.documentElement.dataset.runtime = isNative ? 'tauri' : 'web'
    return () => {
      delete document.documentElement.dataset.runtime
    }
  }, [isNative])

  useEffect(() => {
    if (!isNative) return

    let unlistenToggle: (() => void) | undefined
    let unlistenSettings: (() => void) | undefined
    let unlistenHidden: (() => void) | undefined
    // [0.4.56 修复] cancelled 守卫:开发模式 StrictMode 下 effect 会 mount→cleanup→mount,
    // 而 listen() 是异步的——首次 mount 的清理函数在其解析前就同步执行,unlisten 为空操作,
    // 导致首次注册的监听器泄漏,最终 todobar-tray-toggle 挂上两个监听器;按一次快捷键触发
    // 两次 setIsOpen((c)=>!c),两次取反等于没变 → 「呼出/打开窗口快捷键点了没反应」。
    // 加此守卫后,被丢弃的首次 mount 在异步解析后直接 return,不注册,保证全局唯一监听器。
    let cancelled = false

    const setupTrayListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        unlistenToggle = await listen('todobar-tray-toggle', () => setIsOpen((c) => !c))
        if (cancelled) return
        unlistenSettings = await listen('todobar-tray-settings', () => {
          setIsOpen(true)
          setIsSettingsOpen(true)
        })
        // [0.4.57] 主窗口被关闭(拦截为隐藏)时,Rust 侧会发此事件把前端状态
        // 复位为「收起」,保证下次托盘单击直接展开而不是先被取反成收起。
        if (cancelled) return
        unlistenHidden = await listen('todobar-window-hidden', () => setIsOpen(false))
      } catch {
        // Tray events are only available in the native desktop shell.
      }
    }

    void setupTrayListeners()
    return () => {
      cancelled = true
      unlistenToggle?.()
      unlistenSettings?.()
      unlistenHidden?.()
    }
  }, [isNative])

  // 截图/贴图:恢复设置并注册全局快捷键(仅主窗口原生环境执行一次)。
  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    void (async () => {
      try {
        const { hydrateSettings } = await import('./screenshot/store')
        const { initScreenshotShortcuts } = await import('./screenshot/shortcuts')
        await hydrateSettings()
        if (!cancelled) await initScreenshotShortcuts()
      } catch {
        // best-effort:截图初始化失败不影响其他功能。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isNative])

  useEffect(() => {
    if (!isNative) return
    const enableAutostart = async () => {
      try {
        const { disable, enable, isEnabled } = await import('@tauri-apps/plugin-autostart')
        const enabled = await isEnabled()
        if (settings.launchAtLogin && !enabled) await enable()
        else if (!settings.launchAtLogin && enabled) await disable()
      } catch {
        // Autostart is best-effort.
      }
    }
    void enableAutostart()
  }, [isNative, settings.launchAtLogin])

  // 启动后按磁盘偏好自动拉起「牛马计薪器 · 桌面组件」(用户曾启用则悬浮在桌面)。
  // 同时把计薪配置(salary)从磁盘回灌到 localStorage:更新/清缓存会清掉 WebView
  // localStorage,若只在打开计薪页时回灌,主界面的其余入口会先读到默认值。
  // 与提权/自启自愈同级,失败不致命。
  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    // 会员闸门:受限用户(未登录 / 试用过期未激活)不能启用计薪器桌面组件;
    // 若组件此前已开着(如试用到期),此处走「正常关闭开关」的完整路径——
    // 先把配置置为关闭(localStorage + 磁盘偏好),再关窗口。
    // 只杀进程不同步配置会导致 UI 仍显示「启用中(置灰)」的割裂,绝不允许。
    if (!fullAccess) {
      const disabled = disableSalaryWidgetConfig()
      void saveDiskPref('salaryWidget', disabled).catch(() => {})
      void invoke('close_salary_widget').catch(() => {})
    }
    void (async () => {
      try {
        const cfg = await loadDiskPref<SalaryWidgetConfig>(SALARY_WIDGET_KEY)
        if (cfg && cfg.enabled && !cancelled && fullAccess) {
          await invoke('open_salary_widget', { style: normalizeStyle(cfg.style) })
        }
      } catch {
        /* 组件自启失败不致命 */
      }
      try {
        const salary = await loadDiskPref<Record<string, unknown>>('salary')
        if (salary && !cancelled && !localStorage.getItem(SALARY_STORE_KEY)) {
          localStorage.setItem(SALARY_STORE_KEY, JSON.stringify(salary))
        }
      } catch {
        /* 回灌失败不致命 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isNative, fullAccess])

  // 显示器插拔 / DPI 变化:低频轮询几何,签名变化才触发重定位。
  // 正常状态下不产生任何窗口 API 调用,不干扰展开动画与把手拖动。
  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    const check = async () => {
      const g = await resolveDockTarget(settings.targetMonitor, settings.dockSide, {
        panelWidth: settings.panelWidth,
        tabWidth: settings.tabWidth,
      })
      if (cancelled || !g) return
      const prev = dockGeomRef.current
      if (prev && dockSignature(prev) === dockSignature(g) && prev.fallback === g.fallback) return
      setDockTick((t) => t + 1)
    }
    const timer = window.setInterval(() => void check(), 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isNative, settings.dockSide, settings.panelWidth, settings.tabWidth, settings.targetMonitor])

  /**
   * 主窗几何 + 展开/收起(0.4.62 动画重构)。
   *
   * ⚠️ 原生窗口**恒定使用完整展开矩形**,不再逐帧改 size/position。旧实现每帧
   * 走一次 JS→Rust IPC,窗口每帧 resize 会逼 WebView2 重排 + 重绘,叠加 48ms
   * 点击穿透轮询抢主线程,帧间隔忽长忽短 —— 这就是「不丝滑、感觉卡顿」的根因。
   * 现在视觉过渡完全交给 .dock-layer 的 CSS transform(合成器动画、零 IPC、
   * 零重排),方向由 dock-left / dock-right 决定,时长沿用设置页「动画时长」。
   */
  useEffect(() => {
    if (!isNative) return
    const token = ++dockAnimToken.current
    let cancelled = false
    let animTimer = 0
    const alive = () => !cancelled && token === dockAnimToken.current

    /** 原子写窗口矩形:size + position 在 Rust 同一命令的同步块里完成。 */
    const bounds = (r: DockRect) =>
      invoke('set_main_window_bounds', {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    /**
     * ⚠️ 混合 DPI 下窗口矩形必须隔帧连写多次:
     * 窗口创建在 1.5x 主屏时,单次 set_size(PhysicalSize) 会被 Windows 按创建屏
     * 的缩放解释成逻辑尺寸;随后 set_position 把窗口搬到 1.0x 副屏,物理尺寸就
     * 整体缩水 1.5 倍(实测 394×1032 → 263×688),表现为面板右侧被裁切、收起后
     * 把手跟着内容一起移出视口。第二次写入时窗口已在目标屏,口径就正确了。
     * 只用于「启动定位 / 切屏迁移」这类低频路径,不碰展开/收起的零 RPC 动画。
     */
    const applyBounds = async (r: DockRect) => {
      for (let i = 0; i < 3; i += 1) {
        await bounds(r)
        await nextFrame()
        if (!alive()) return false
      }
      return true
    }
    const markAnimating = (on: boolean) => {
      dockAnimatingRef.current = on
    }
    // 布局输入签名:只有这些值变化才需要重新解析显示器 / 重写窗口矩形。
    const layoutKey = [
      dockTick,
      settings.dockSide,
      settings.targetMonitor,
      settings.panelWidth,
      settings.tabWidth,
    ].join('|')

    const syncNativeWindow = async () => {
      // ⚠️ 零 RPC 快路径(0.4.62 丝滑度关键):布局输入没变 ⇒ 原生窗口矩形必然没变,
      // 展开/收起 100% 交给 .dock-layer 的 CSS transform。这里只要发出任何一次
      // Tauri IPC(显示器查询 / set_size / set_position / setFocus),WebView2 就会
      // 在动画首帧重排,主线程排队 = 用户看到的「顿一下」。切屏 / 换边 / 改宽度
      // 会改变签名,自动落到下方完整路径做无动画快照迁移。
      if (
        didNativeLayout.current &&
        dockSettingsKeyRef.current === layoutKey &&
        dockGeomRef.current
      ) {
        markAnimating(true)
        // [0.4.57] 窗口可能被任务栏「关闭窗口」隐藏;展开时兜底 show()。
        // 用 fire-and-forget,不 await、不阻塞 transform 首帧。
        if (isOpen) {
          void import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().show())
            .catch(() => undefined)
        }
        animTimer = window.setTimeout(() => {
          if (!alive()) return
          markAnimating(false)
          // 抢焦点推迟到动画播完,避免这一次 IPC 撞上 transform 首帧。
          if (isOpen) {
            void import('@tauri-apps/api/window')
              .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
              .catch(() => undefined)
          }
        }, settings.motionMs + 50)
        return
      }
      markAnimating(true)
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const appWindow = getCurrentWindow()
        // 目标屏由 src/dock.ts 统一解析(主屏 / 副屏 / 具体显示器,用户选择已持久化)。
        const geom = await resolveDockTarget(settings.targetMonitor, settings.dockSide, {
          panelWidth: settings.panelWidth,
          tabWidth: settings.tabWidth,
        })
        if (!geom) {
          // [0.4.48] 拿不到显示器时也要显示窗口,否则会一直 visible:false 黑屏。
          try {
            await invoke('show_main_window_ready')
          } catch {
            /* 交给 Rust 看门狗兜底 */
          }
          markAnimating(false)
          return
        }
        if (!alive()) return

        const prevGeom = dockGeomRef.current
        dockGeomRef.current = geom
        // 只在几何真的变化时更新 state,避免每次开关都重渲染整个 App。
        if (
          !prevGeom ||
          dockSignature(prevGeom) !== dockSignature(geom) ||
          prevGeom.fallback !== geom.fallback
        ) {
          setDockGeom(geom)
        }
        setViewportWidth(geom.fullCssWidth)
        setViewportHeight(geom.fullCssHeight)

        // 窗口始终是完整展开矩形;收起只是 CSS 把内容层平移出可视区。
        const fullRect = dockFrame(geom, 1)
        const applied = appliedDockRef.current
        // 切屏 / 换停靠边 / 改宽度 = 迁移:直接搬到新屏,不做滑动动画(会跨屏)。
        const relocated = !applied ||
          applied.geom.monitorKey !== geom.monitorKey ||
          applied.geom.side !== geom.side ||
          applied.geom.scaleFactor !== geom.scaleFactor ||
          applied.geom.openX !== geom.openX ||
          applied.geom.openY !== geom.openY ||
          applied.geom.windowWidth !== geom.windowWidth ||
          applied.geom.closedWidth !== geom.closedWidth ||
          applied.geom.targetHeight !== geom.targetHeight

        if (!didNativeLayout.current) {
          didNativeLayout.current = true
          // 启动同样会跨 DPI(主屏创建 → 用户选的副屏),单次写入会被缩放吃掉。
          // 注意:即使中途 effect 已被取消,下面也必须把窗口显示出来(启动时
          // visible:false),否则会卡在黑屏,只能等 Rust 看门狗兜底。
          await applyBounds(fullRect)
          // [0.4.44] 窗口 visible:false 启动,等「定位完成 + 双 rAF 首帧绘制」
          // 后再显示,否则会以系统默认位置闪现 1.5~2.5s。
          await nextFrame()
          await nextFrame()
          try {
            await invoke('show_main_window_ready')
          } catch {
            /* 失败时由 Rust 侧 15s 看门狗兜底显示 */
          }
          appliedDockRef.current = { geom }
          dockSettingsKeyRef.current = layoutKey
          markAnimating(false)
          return
        }

        // [0.4.57] 展开前兜底 show():窗口可能已被任务栏「关闭窗口」隐藏。
        if (isOpen) await appWindow.show()

        if (relocated) {
          // Windows 跨不同 DPI 显示器会按「逻辑尺寸」重新缩放窗口,首次写入常被
          // 吃掉,连写三次按新屏物理像素校正(修掉「切到副屏仍是主屏尺寸」)。
          if (!(await applyBounds(fullRect))) return
          appliedDockRef.current = { geom }
          dockSettingsKeyRef.current = layoutKey
          markAnimating(false)
          if (isOpen) await appWindow.setFocus()
          return
        }

        // 布局签名变了但几何没变(如显示器插拔后同名屏重新接入):不做任何窗口
        // API 调用,只登记签名,动画继续由 CSS 承担。
        if (!alive()) return
        appliedDockRef.current = { geom }
        dockSettingsKeyRef.current = layoutKey
        if (isOpen) void appWindow.setFocus()
        // CSS transition 播完再恢复「收起态可穿透」。动画期间保持可点,
        // 否则面板还在滑出就把点击放给桌面了。
        animTimer = window.setTimeout(() => {
          if (alive()) markAnimating(false)
        }, settings.motionMs + 50)
      } catch {
        // 浏览器预览 / 窗口已销毁:忽略,但不能把动画标记留在页面上。
        if (alive()) markAnimating(false)
      }
    }
    void syncNativeWindow()
    return () => {
      cancelled = true
      dockAnimToken.current++
      window.clearTimeout(animTimer)
      dockAnimatingRef.current = false
    }
  }, [
    dockTick,
    isNative,
    isOpen,
    settings.dockSide,
    settings.motionMs,
    settings.panelWidth,
    settings.tabWidth,
    settings.targetMonitor,
  ])

  // 切屏 / 换停靠边 / 改宽度时,内容层 transform 的目标值会从 +panelWidth 跳到
  // -panelWidth(或幅度改变)。这一帧必须禁用 transition,否则会看到内容横穿窗口。
  useLayoutEffect(() => {
    const el = workspaceRef.current
    if (!el) return
    el.classList.add('is-dock-snap')
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => el.classList.remove('is-dock-snap'))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      el.classList.remove('is-dock-snap')
    }
  }, [
    dockGeom?.panelCssWidth,
    settings.dockSide,
    settings.targetMonitor,
    settings.panelWidth,
    settings.tabWidth,
  ])

  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    let isChecking = false
    let checkingSince = 0

    const syncHitTest = async () => {
      const now = performance.now()
      // 看门狗:若上一次 IPC 卡住不返回,isChecking 会永久为 true,后续轮询全被跳过,
      // 穿透状态被冻结 → 窗口永远点不动。超过 1.5s 强制放行一轮。
      if (isChecking && now - checkingSince < 1500) return
      isChecking = true
      checkingSince = now
      try {
        const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window')
        const appWindow = getCurrentWindow()
        // ⚠️ 0.4.62 丝滑度:展开态 / CSS 过渡期间判定恒为「不穿透」,无需每 48ms
        // 三次坐标 IPC。此前光标 + 窗口位置 + 窗口尺寸的查询会与动画首帧抢
        // 主线程,放大卡顿。仍无条件重发一次 false,保证竞态最多 48ms 自愈。
        if (isOpen || dockAnimatingRef.current) {
          if (!cancelled) await appWindow.setIgnoreCursorEvents(false)
          return
        }
        const [cursor, position, size] = await Promise.all([
          cursorPosition(),
          appWindow.outerPosition(),
          appWindow.outerSize(),
        ])
        // 几何信息缺失(目标屏还没解析出来 / 窗口位置拿不到)时,默认【不穿透】。
        const geom = dockGeomRef.current
        if (!geom || !position) {
          if (!cancelled) await appWindow.setIgnoreCursorEvents(false)
          return
        }
        // CSS 展开/收起过渡期间内容仍在移动,按「展开态」处理(整窗可点),
        // 否则面板还在滑出,点击就已经被放给桌面了。
        const shouldIgnore = dragState.current
          ? false
          : dockShouldIgnore(
              geom,
              isOpen || dockAnimatingRef.current,
              cursor.x - position.x,
              cursor.y - position.y,
              size.width,
              size.height,
              nativeHandleCenter,
              settings.handleHeight,
            )
        // ⚠️ 不做「状态变化才发 IPC」的短路:旧实现一旦被误判成穿透(true),
        // 或旧 effect cleanup 的 false 与新 effect 的 true 发生竞态,窗口会被
        // 永久锁在 WS_EX_TRANSPARENT,用户完全点不动。每轮无条件重发当前状态,
        // 任何竞态最多 48ms 内自愈。
        if (!cancelled) await appWindow.setIgnoreCursorEvents(shouldIgnore)
      } catch {
        // Pointer passthrough is best-effort.
      } finally {
        isChecking = false
      }
    }
    void syncHitTest()
    const interval = window.setInterval(syncHitTest, 48)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setIgnoreCursorEvents(false))
        .catch(() => undefined)
    }
  }, [dockGeom, isNative, isOpen, nativeHandleCenter, settings.handleHeight])

  // ---- 主视图操作 ------------------------------------------------------------

  const handleRename = (task: Task, title: string) => {
    const next = title.trim()
    if (!next || next === task.title) return
    // 重复事项的虚拟实例:弹出范围确认,让用户选择「仅本次」还是「应用到所有重复日」。
    if (task.seriesId && task.dueDate) {
      setRecurScope({
        kind: 'edit',
        templateId: task.seriesId,
        dateKey: task.dueDate,
        newTitle: next,
      })
      return
    }
    store.updateTask({ ...task, title: next })
  }

  // 重复事项范围确认的落点:仅本次 / 所有重复日。
  const applyRecurScope = (scope: 'this' | 'all') => {
    const pending = recurScope
    setRecurScope(null)
    if (!pending) return
    // 会员闸门:受限用户不能给重复事项添加子任务(- 与一次性事项同口径)。
    if (pending.kind === 'child' && !fullAccess) {
      handleLocked('添加子任务')
      return
    }
    if (pending.kind === 'edit') {
      if (scope === 'this') store.renameOccurrenceOnly(pending.templateId, pending.dateKey, pending.newTitle)
      else store.renameSeries(pending.templateId, pending.newTitle)
    } else if (scope === 'this') {
      store.addSubtask(pending.parentInstanceId, pending.title)
    } else {
      store.addSubtask(pending.templateId, pending.title)
    }
  }

  // 底部弹窗保存:创建主任务并级联创建子任务/下级(最多三层)
  // 注意:必须用 addChildTask(基于父任务对象)而不是 addSubtask(依赖最新 state),
  // 否则同一次提交里刚创建的父任务还不在 state 中,子任务会被静默丢弃。
  const handleAddTree = (
    mainTitle: string,
    subs: { title: string; children: { title: string }[] }[],
    recurrence: Recurrence | null = null,
  ) => {
    // 会员闸门①:受限用户单日新建主任务上限(子任务/下级不计入,只数主任务)。
    const quotaMsg = `单日最多新建 ${FREE_DAILY_TASK_LIMIT} 条,开通会员可解除限制`
    if (!fullAccess && store.freeQuotaUsed >= FREE_DAILY_TASK_LIMIT) {
      setToast({ kind: 'err', text: quotaMsg })
      return
    }
    // 周/月日期栏「+」指定了目标日期时优先用该日期;否则保持原有默认(日视图=选中日,周/月=今天)。
    const targetKey =
      addSheetDateKey ?? (activeTab === 'day' ? selectedDateKey : todayKey)
    const dueIso = endOfDayForKey(targetKey)
    const listId = activeTab === 'month' ? 'month' : 'today'
    // 重复事项存为模板(无子任务结构),一次性事项保留子任务层级。
    if (recurrence) {
      if (!store.addTask(listId, mainTitle, '', null, recurrence)) {
        setToast({ kind: 'err', text: quotaMsg })
      }
      return
    }
    const main = store.addTask(listId, mainTitle, '', dueIso)
    if (!main) {
      setToast({ kind: 'err', text: quotaMsg })
      return
    }
    // 会员闸门②:受限用户不能添加子任务 / 下级;主任务照常创建,只丢弃层级。
    if (!fullAccess) {
      if (subs.some((s) => s.title.trim())) {
        handleLocked('添加子任务')
      }
      return
    }
    for (const sub of subs) {
      if (!sub.title.trim()) continue
      const child = store.addChildTask(main, sub.title.trim())
      if (!child) continue
      for (const grand of sub.children) {
        if (grand.title.trim()) store.addChildTask(child, grand.title.trim())
      }
    }
  }

  // ---- OCR 转待办:截图/贴图子窗识别结果 → 今日清单逐行建任务 -----------------
  // 额度/会员校验复用 addTask 内部闸门(不旁路);订阅一次,回调经 ref 取最新
  // addTask / 额度状态,避免随渲染反复退订重挂。
  const ocrAddTaskRef = useRef(store.addTask)
  const ocrQuotaRef = useRef({ fullAccess, freeQuotaUsed: store.freeQuotaUsed })
  // ref 更新收敛到 effect(渲染期写 ref 违反 react-compiler 规则)。
  useEffect(() => {
    ocrAddTaskRef.current = store.addTask
    ocrQuotaRef.current = { fullAccess, freeQuotaUsed: store.freeQuotaUsed }
  }, [store.addTask, store.freeQuotaUsed, fullAccess])

  useEffect(() => {
    if (!isNative) return
    let off: (() => void) | null = null
    let disposed = false
    void onOcrCreateTask((lines) => {
      let added = 0
      for (const l of lines) {
        if (ocrAddTaskRef.current('today', l.text.trim())) added += 1
      }
      const dropped = lines.length - added
      if (added > 0) {
        const quotaHint = dropped > 0 && !ocrQuotaRef.current.fullAccess
        setToast({
          kind: 'ok',
          text: quotaHint
            ? `已添加 ${added} 条,超出单日上限的 ${dropped} 条未添加`
            : `已从截图添加 ${added} 条任务`,
        })
      } else {
        setToast({
          kind: 'err',
          text: `单日最多新建 ${FREE_DAILY_TASK_LIMIT} 条,开通会员可解除限制`,
        })
      }
    }).then((fn) => {
      if (disposed) fn()
      else off = fn
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [isNative])

  // ---- 长按拖拽排序 -----------------------------------------------------------
  // 长按约 320ms 进入拖拽;仅允许在同一层级列表内移动(主任务之间/同一父任务的子任务之间)。
  const [rowDrag, setRowDrag] = useState<RowDragState | null>(null)
  const rowDragRef = useRef<RowDragState | null>(null)
  const suppressRowClick = useRef(false)

  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string, sib: string) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    let armed = false
    let latest: RowDragState = { id, sib, y: startY, overId: null, overBefore: false }

    const armTimer = window.setTimeout(() => {
      armed = true
      suppressRowClick.current = true
      rowDragRef.current = latest
      setRowDrag({ ...latest })
      document.body.classList.add('is-row-dragging')
    }, 320)

    const cleanup = () => {
      window.clearTimeout(armTimer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('is-row-dragging')
      rowDragRef.current = null
      setRowDrag(null)
    }

    const onMove = (ev: globalThis.PointerEvent) => {
      if (!armed) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) cleanup()
        return
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-sib]') as
        | HTMLElement
        | null
      let overId: string | null = null
      let overBefore = false
      if (el?.dataset.sib === sib && el.dataset.nodeId && el.dataset.nodeId !== id) {
        overId = el.dataset.nodeId
        const rect = el.getBoundingClientRect()
        overBefore = ev.clientY < rect.top + rect.height / 2
      }
      latest = { id, sib, y: ev.clientY, overId, overBefore }
      rowDragRef.current = latest
      setRowDrag({ ...latest })
    }

    const onUp = () => {
      if (armed) {
        const d = rowDragRef.current
        if (d?.overId) {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-sib="${CSS.escape(sib)}"]`),
          )
          let ids = rows.map((el) => el.dataset.nodeId).filter((x): x is string => Boolean(x))
          ids = ids.filter((x) => x !== id)
          const targetIndex = ids.indexOf(d.overId)
          if (targetIndex >= 0) {
            ids.splice(d.overBefore ? targetIndex : targetIndex + 1, 0, id)
            store.reorderTasks(ids)
          }
        }
        window.setTimeout(() => {
          suppressRowClick.current = false
        }, 60)
      }
      cleanup()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** 把主任务挂到顶部晾衣绳。只写 cards.json，不碰任务库 / 同步引擎。 */
  const hangTaskToClothesline = async (task: Task) => {
    try {
      await clAddCard(
        clMakeCard('task', {
          task_id: task.id,
          title: task.title,
          text: task.meta || (task.dueDate ? task.dueDate.slice(0, 10) : ''),
        }),
        fullAccess,
      )
      setToast({ kind: 'ok', text: '已挂到晾衣绳' })
    } catch (e) {
      setToast({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  const treeCtx = {
    childMap,
    onToggleDone: (id: string) => store.toggleDone(id),
    onHang: (task: Task) => void hangTaskToClothesline(task),
    onToggleSeriesSub: (subId: string, dateKey: string) =>
      store.toggleSubtaskOccurrence(subId, dateKey),
    onRename: handleRename,
    onAddChild: (parentId: string, title: string) => {
      // 会员闸门:受限用户不能添加子任务。
      if (!fullAccess) {
        handleLocked('添加子任务')
        return
      }
      // 重复事项的虚拟实例:弹出范围确认(仅本次 / 整组),否则直接加子任务。
      const inst = parseInstanceId(parentId)
      if (inst) {
        setRecurScope({
          kind: 'child',
          parentInstanceId: parentId,
          templateId: inst.templateId,
          dateKey: inst.dateKey,
          title: title.trim(),
        })
        return
      }
      store.addSubtask(parentId, title)
    },
    onOpenSettings: (task: Task, occurrenceKey?: string | null) => {
      setSettingsTaskId(task.id)
      // 子任务来自重复事项实例时带上发生日:删除时可弹「仅本次/所有重复日」确认。
      setSettingsOccurrenceKey(occurrenceKey ?? null)
    },
    onOpenSeries: (templateId: string, dateKey?: string) => {
      setSettingsTaskId(templateId)
      setSettingsOccurrenceKey(dateKey ?? null)
    },
    onRowPointerDown,
    suppressClick: () => suppressRowClick.current,
    rowDrag,
  }

  // ---- edge handle drag -----------------------------------------------------

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isNative) return
    event.currentTarget.setPointerCapture(event.pointerId)
    suppressNextClick.current = false
    dragState.current = {
      startScreenY: event.screenY,
      startHandleY: visibleHandleY,
      height: window.innerHeight,
      moved: false,
      latestHandleY: null,
    }
  }

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current
    if (!drag) return
    const deltaY = event.screenY - drag.startScreenY
    if (Math.abs(deltaY) < DRAG_THRESHOLD && !drag.moved) return
    drag.moved = true
    suppressNextClick.current = true
    const travel = Math.max(1, drag.height - settings.handleHeight)
    const nextHandleY = Math.min(100, Math.max(0, drag.startHandleY + (deltaY / travel) * 100))
    drag.latestHandleY = Math.round(nextHandleY)
    setDragHandleY(nextHandleY)
  }

  const onHandlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current
    const shouldToggle = drag && !drag.moved
    if (drag?.moved && drag.latestHandleY !== null) updateSettings({ handleY: drag.latestHandleY })
    setDragHandleY(null)
    dragState.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture can already be gone.
    }
    if (shouldToggle) {
      suppressNextClick.current = true
      setIsOpen((c) => !c)
    }
  }

  const onHandleClick = () => {
    if (suppressNextClick.current) {
      suppressNextClick.current = false
      return
    }
    setIsOpen((c) => !c)
  }

  const appStyle = {
    '--panel-width': `${effectivePanelWidth}px`,
    '--tab-width': `${settings.tabWidth}px`,
    '--handle-height': `${settings.handleHeight}px`,
    '--handle-half': `${settings.handleHeight / 2}px`,
    '--handle-y': `${visibleHandleY}%`,
    '--native-handle-y-px': `${nativeHandleCenter}px`,
    '--motion-ms': `${settings.motionMs}ms`,
    '--panel-radius': `${settings.panelRadius}px`,
    '--surface-alpha': `${settings.surfaceAlpha / 100}`,
    '--task-row-height': `${settings.taskRowHeight}px`,
    '--task-gap': `${settings.taskGap}px`,
    '--task-title-size': `${settings.taskTextSize}px`,
    '--task-meta-size': `${Math.max(10, settings.taskTextSize - 1.5)}px`,
    '--task-title-font': fontStackOf(settings.taskFont),
  } as CSSProperties

  return (
    <main
      ref={workspaceRef}
      className={`workspace ${isNative ? 'is-native' : 'is-web-preview'} ${
        isOpen ? 'is-sidebar-open' : 'is-sidebar-closed'
      } dock-${settings.dockSide} theme-${settings.theme} bg-${settings.background}`}
      style={appStyle}
    >
      <section className="desktop-preview" aria-label="Tacco 桌面预览" aria-hidden={isNative}>
        <nav className="system-bar" aria-label="桌面菜单">
          <div className="window-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="system-title">
            <ListTodo size={16} />
            <span>Tacco</span>
          </div>
          <div className="system-actions">
            <button type="button" aria-label="搜索">
              <Search size={16} />
            </button>
            <button type="button" aria-label="设置">
              <Settings size={16} />
            </button>
          </div>
        </nav>
        <section className="canvas" aria-label="桌面工作区">
          <div className="desk-copy">
            <div className="mark">
              <PanelRightOpenIcon />
            </div>
            <h1>为专注工作而生的右缘待办栏。</h1>
            <p>
              浏览器页面仅为开发预览。正式产品是原生 macOS 与 Windows
              桌面工具,支持快捷键、悬浮窗口与云端同步。
            </p>
          </div>
        </section>
      </section>

      {/* 原生贴边层:展开/收起只靠这一层的 transform 平移(合成器动画,零 IPC)。
          原生窗口尺寸恒定;收起时内容整体移到屏边,只剩把手那一列可见。
          非原生预览态该层为 display:contents,不影响原有布局。 */}
      <div className="dock-layer">
      {isNative ? (
        <svg
          className="native-dock-surface"
          width={dockSurface.width}
          height={dockSurface.height}
          viewBox={`0 0 ${dockSurface.width} ${dockSurface.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={dockSurface.path} />
        </svg>
      ) : null}

      <button
        className={`edge-handle ${isOpen ? 'is-open' : ''}`}
        type="button"
        aria-label={isOpen ? '收起 Tacco' : '展开 Tacco'}
        aria-expanded={isOpen}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onClick={onHandleClick}
      >
        <span className="handle-symbol" aria-hidden="true">
          <PanelRightOpenIcon className="handle-icon-open" size={15} />
          <PanelRightCloseIcon className="handle-icon-close" size={15} />
        </span>
      </button>

      <aside
        ref={setSidebarHost}
        className={`todo-sidebar ${isOpen ? 'is-open' : ''}`}
        aria-label="Tacco 侧栏"
        aria-hidden={!isOpen}
      >
        {/* 独立页面(设置 / 万年历):绝对定位覆盖层,从右滑入展开、向右滑出关闭 */}
        <PageShell
          open={isSettingsOpen}
          title="待办设置"
          tone="settings"
          onClose={() => setIsSettingsOpen(false)}
        >
          {/* 两个设置面板共用同一个滚动容器:内层不再各自带 76px 底部预留,
              修掉「截图/贴图」区上方的大空隙(2026-10-22 用户反馈)。 */}
          <div className="settings-scroll">
            <SidebarSettingsPanel
              settings={settings}
              onChange={updateSettings}
              syncConfig={store.syncConfig}
              syncState={store.syncState}
              onSyncChange={store.setSyncConfig}
              onSwitchProfile={store.switchAccountProfile}
              onSyncNow={store.triggerSync}
              onOpenRestore={() => setRestoreSheetOpen(true)}
              onLocked={handleLocked}
              onToast={(kind, text) => setToast({ kind, text })}
              store={store}
              appVersion={appVersion}
              updateState={updateState}
              setUpdateState={setUpdateState}
              topbarFocus={topbarFocus}
              dockFallback={dockGeom?.fallback ?? false}
            />
            <ErrorBoundary label="截图与贴图">
              <ScreenshotSettingsPanel
                onToast={(kind, text) => setToast({ kind, text })}
                onLocked={handleLocked}
              />
            </ErrorBoundary>
          </div>
        </PageShell>
        <PageShell open={huangliOpen} title="万年历" onClose={() => setHuangliOpen(false)}>
          <HuangliView />
        </PageShell>
        <PageShell open={calculatorOpen} title="计算器" onClose={() => setCalculatorOpen(false)}>
          <ErrorBoundary label="计算器">
            <CalculatorView />
          </ErrorBoundary>
        </PageShell>
        <PageShell open={salaryOpen} title="牛马计薪器" onClose={() => setSalaryOpen(false)}>
          <ErrorBoundary label="牛马计薪器">
            <SalaryView />
          </ErrorBoundary>
        </PageShell>
        <PageShell open={recorderOpen} title="录音机" onClose={() => setRecorderOpen(false)}>
          <ErrorBoundary label="录音机">
            <RecorderView />
          </ErrorBoundary>
        </PageShell>
        <PageShell open={clotheslineOpen} title="晾衣绳" onClose={() => setClotheslineOpen(false)}>
          <ErrorBoundary label="晾衣绳设置">
            <ClotheslineSettingsPage />
          </ErrorBoundary>
        </PageShell>
        {/* 待办主视图:页面打开时被覆盖层遮在下方,关闭动画过程中可透视 */}
        <div className="sidebar-main" aria-hidden={isSettingsOpen || huangliOpen || calculatorOpen || salaryOpen || recorderOpen || clotheslineOpen}>
          <header className="sidebar-header">
              <div className="app-lockup">
                <span className="app-icon">
                  <img src="/applogo.png" alt="" draggable={false} />
                </span>
                <strong>Tacco</strong>
              </div>
              <div className="icon-cluster">
                {/* 动态槽位:按用户配置的顺序占用顶栏,装不下的收进「⋯ 更多」 */}
                {topbar.shown.map((t) => {
                  const active =
                    t.id === 'calculator' ? calculatorOpen
                      : t.id === 'huangli' ? huangliOpen
                        : t.id === 'salary' ? salaryOpen
                          : t.id === 'recorder' ? recorderOpen
                            : t.id === 'clothesline' ? clotheslineOpen
                              : false
                  const cls = [
                    t.id === 'recorder' ? 'rec-entry' : '',
                    active ? 'is-active' : '',
                    t.id === 'sync' && store.syncState.status === 'syncing' ? 'is-syncing' : '',
                  ].filter(Boolean).join(' ')
                  const button = (
                    <button
                      key={t.id}
                      type="button"
                      className={cls || undefined}
                      aria-label={t.name}
                      aria-pressed={active || undefined}
                      data-tip={t.tip}
                      onClick={() => runTopbarTool(t.id, t.name)}
                    >
                      <TopbarToolIcon id={t.id} />
                      {t.id === 'recorder' && recorderActive ? (
                        <i className="rec-dot" aria-hidden="true" />
                      ) : null}
                    </button>
                  )
                  // 同步图标下方仍挂「上次同步时间」,沿用原 .sync-cluster 包装。
                  if (t.id === 'sync') {
                    return (
                      <div className="sync-cluster" key={`wrap-${t.id}`}>
                        {button}
                        <em className="sync-cluster-time">{lastSyncLabel}</em>
                      </div>
                    )
                  }
                  return button
                })}
                {topbar.hidden.length > 0 ? (
                  <button
                    ref={moreBtnRef}
                    type="button"
                    className={moreOpen ? 'is-active' : ''}
                    aria-label="更多工具"
                    aria-expanded={moreOpen}
                    aria-haspopup="menu"
                    // 菜单展开时撤掉 tooltip:鼠标仍停在按钮上,气泡会盖住菜单头部。
                    data-tip={moreOpen ? undefined : `更多工具 (${topbar.hidden.length})`}
                    onClick={() => setMoreOpen((c) => !c)}
                  >
                    <Ellipsis size={16} />
                    <i className="more-dot" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={isSettingsOpen ? 'is-active' : ''}
                  aria-label="侧栏设置"
                  aria-pressed={isSettingsOpen}
                  data-tip="设置"
                  onClick={openSettingsPage}
                >
                  <Settings size={16} />
                </button>
              </div>

              {/* 溢出菜单:absolute 相对 .todo-sidebar 定位,继承主题变量。
                  工具注册表已有 9 项、topbarSlots 封顶 6 → hidden 恒 ≥3,菜单恒显示,
                  晾衣绳置顶开关(第 7 行)也因此恒可达(R85)。 */}
              {moreOpen && topbar.hidden.length > 0 ? (
                <TopbarMoreMenu
                  hidden={topbar.hidden}
                  shortcutLabels={shortcutLabels}
                  onRun={runTopbarTool}
                  onManage={manageTopbarTools}
                  menuRef={moreMenuRef}
                  topmost={clTopmost}
                  onToggleTopmost={toggleClTopmost}
                />
              ) : null}
            </header>

            <div className="sidebar-pinned">
              <nav className="tab-bar" role="tablist" aria-label="待办分类">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    className={activeTab === tab.key ? 'is-active' : ''}
                    onClick={() => {
                      setActiveTab(tab.key)
                      // 切换 tab 时一律回到当前周期(今天/本周/本月)
                      setSelectedDateKey(todayKey)
                      setWeekAnchor(mondayOf(new Date()).getTime())
                      const now = new Date()
                      setMonthCursor({ year: now.getFullYear(), month: now.getMonth() })
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              {activeTab === 'day' && (
                <>
                  <div className="date-strip" ref={dateStripRef} aria-label="日期选择">
                    {dateStrip.map((chip) => (
                      <button
                        type="button"
                        key={chip.key}
                        ref={chip.key === selectedDateKey ? selectedChipRef : undefined}
                        className={`date-chip ${chip.key === selectedDateKey ? 'is-selected' : ''} ${
                          chip.dot === 'open' ? 'dot-open' : chip.dot === 'done' ? 'dot-done' : ''
                        }`}
                        aria-pressed={chip.key === selectedDateKey}
                        aria-label={`${chip.dayLabel} ${chip.weekLabel}${
                          chip.dot === 'open' ? ',有未完成待办' : chip.dot === 'done' ? ',已全部完成' : ''
                        }`}
                        onClick={() => setSelectedDateKey(chip.key)}
                      >
                        <strong>{chip.dayLabel}</strong>
                        <span>{chip.weekLabel}</span>
                        <i className="date-dot" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <div className="range-label">
                    {selectedDateLabel}
                    <em>{dayTop.length} 项</em>
                  </div>
                </>
              )}

              {activeTab === 'week' && (
                <>
                  <div className="range-nav">
                    <button
                      type="button"
                      className="range-nav-button"
                      aria-label="上一周"
                      onClick={() => shiftWeek(-1)}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <div className="range-nav-label">
                      <strong>{weekRangeLabel.isCurrent ? '本周' : `一周`}</strong>
                      <em>{weekRangeLabel.text}</em>
                    </div>
                    <button
                      type="button"
                      className="range-nav-button"
                      aria-label="下一周"
                      onClick={() => shiftWeek(1)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  {!weekRangeLabel.isCurrent && (
                    <button
                      type="button"
                      className="range-today-link"
                      onClick={() => setWeekAnchor(mondayOf(new Date()).getTime())}
                    >
                      回到本周
                    </button>
                  )}
                  <div className="range-label">
                    本周待办
                    <em>{weekTotal} 项</em>
                  </div>
                </>
              )}

              {activeTab === 'month' && (
                <>
                  <div className="range-nav">
                    <button
                      type="button"
                      className="range-nav-button"
                      aria-label="上一月"
                      onClick={() => shiftMonth(-1)}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <div className="range-nav-label">
                      <strong>{monthLabel}</strong>
                    </div>
                    <button
                      type="button"
                      className="range-nav-button"
                      aria-label="下一月"
                      onClick={() => shiftMonth(1)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  {!monthIsCurrent && (
                    <button
                      type="button"
                      className="range-today-link"
                      onClick={() => {
                        const now = new Date()
                        setMonthCursor({ year: now.getFullYear(), month: now.getMonth() })
                      }}
                    >
                      回到本月
                    </button>
                  )}
                  <div className="range-label">
                    本月待办
                    <em>{monthTotal} 项</em>
                  </div>
                </>
              )}
            </div>

            <div className="sidebar-scroll main-scroll">
              {activeTab === 'day' && (
                <div className="tree-list list-anim" key={selectedDateKey}>
                  {dayTop.length === 0 ? (
                    <div className="tree-empty">当天暂无待办,点击下方「添加事项」新建。</div>
                  ) : (
                    dayTop.map((t) => (
                      <TaskNode
                        key={t.id}
                        task={t}
                        level={1}
                        ctx={treeCtx}
                        sibKey={`day:${selectedDateKey}`}
                      />
                    ))
                  )}
                </div>
              )}

              {activeTab === 'week' && (
                <>
                  {weekGroups.map((group) =>
                    group.items.length > 0 ? (
                      <div className="range-group" key={group.key}>
                        <div className={`range-group-title ${group.isToday ? 'is-today' : ''}`}>
                          <span>{group.label}</span>
                          <div className="range-group-actions">
                            <em>{group.items.filter((t) => !t.done).length} 待完成</em>
                            <button
                              type="button"
                              className="icon-button range-group-add"
                              aria-label={`在 ${group.label} 添加事项`}
                              onClick={() => openAddSheetForDate(group.key)}
                            >
                              <Plus size={13} />
                            </button>
                          </div>
                        </div>
                        <div className="tree-list">
                          {group.items.map((t) => (
                            <TaskNode
                              key={t.id}
                              task={t}
                              level={1}
                              ctx={treeCtx}
                              sibKey={`week:${group.key}`}
                            />
                          ))}
                        </div>
                      </div>
                    ) : null,
                  )}
                  {weekTotal === 0 && <div className="tree-empty">本周暂无待办。</div>}
                </>
              )}

              {activeTab === 'month' && (
                <>
                  {monthGroups.map((group) => (
                    <div className="range-group" key={group.key}>
                      <div className={`range-group-title ${group.isToday ? 'is-today' : ''}`}>
                        <span>{group.label}</span>
                        <div className="range-group-actions">
                          <em>{group.items.filter((t) => !t.done).length} 待完成</em>
                          {/* 「未安排日期」不是真实日期,不提供按日新增入口。 */}
                          {group.key !== 'undated' && (
                            <button
                              type="button"
                              className="icon-button range-group-add"
                              aria-label={`在 ${group.label} 添加事项`}
                              onClick={() => openAddSheetForDate(group.key)}
                            >
                              <Plus size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="tree-list">
                        {group.items.map((t) => (
                          <TaskNode
                            key={t.id}
                            task={t}
                            level={1}
                            ctx={treeCtx}
                            sibKey={`month:${group.key}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {monthTotal === 0 && <div className="tree-empty">本月暂无待办。</div>}
                </>
              )}

              {activeTab === 'birthday' && (
                <div className="birthday-view">
                  <OccasionGroup
                    title="生日"
                    icon={<Cake size={13} />}
                    items={birthdayItems}
                    collapsed={occasionCollapsed.birthday}
                    onToggle={() =>
                      setOccasionCollapsed((s) => ({ ...s, birthday: !s.birthday }))
                    }
                    onOpen={setBirthdaySheet}
                    emptyText="还没有记录生日,点下方「添加生日」记下家人和好友的生日吧。"
                    summary={
                      birthdayUpcomingCount > 0
                        ? `未来 30 天内有 ${birthdayUpcomingCount} 个生日`
                        : null
                    }
                  />
                  <OccasionGroup
                    title="纪念日"
                    icon={<Gift size={13} />}
                    items={anniversaryItems}
                    collapsed={occasionCollapsed.anniversary}
                    onToggle={() =>
                      setOccasionCollapsed((s) => ({ ...s, anniversary: !s.anniversary }))
                    }
                    onOpen={setBirthdaySheet}
                    emptyText="还没有纪念日,点下方「添加纪念日」记下值得纪念的日子吧。"
                    summary={null}
                  />
                </div>
              )}
            </div>

            {activeTab === 'birthday' ? (
              <div className="fab-row">
                <button
                  type="button"
                  className="fab-add"
                  onClick={() => {
                    // 会员闸门:受限用户不能新增生日(已有记录仍可查看编辑)。
                    if (!fullAccess) {
                      handleLocked('添加生日')
                      return
                    }
                    setBirthdaySheet('new-birthday')
                  }}
                >
                  <Cake size={16} />
                  添加生日
                </button>
                <button
                  type="button"
                  className="fab-add fab-secondary"
                  onClick={() => {
                    // 会员闸门:受限用户不能新增纪念日。
                    if (!fullAccess) {
                      handleLocked('添加纪念日')
                      return
                    }
                    setBirthdaySheet('new-anniversary')
                  }}
                >
                  <Gift size={16} />
                  添加纪念日
                </button>
              </div>
            ) : (
              <button type="button" className="fab-add" onClick={() => { trackFeature('add-task'); setAddSheetDateKey(null); setAddSheetOpen(true) }}>
                <Plus size={16} />
                添加事项
              </button>
            )}

            {addSheetOpen && (
              <AddTaskSheet
                dateLabel={
                  addSheetDateLabel ??
                  (activeTab === 'day' ? selectedDateLabel : activeTab === 'week' ? '本周' : '本月')
                }
                onClose={() => {
                  setAddSheetOpen(false)
                  setAddSheetDateKey(null)
                }}
                onSubmit={handleAddTree}
                onLocked={handleLocked}
              />
            )}
            {settingsTask && (
              <TaskSettingsSheet
                task={settingsTask}
                occurrenceKey={settingsOccurrenceKey}
                subRecurrence={settingsSubRecurrence}
                onClose={() => {
                  setSettingsTaskId(null)
                  setSettingsOccurrenceKey(null)
                }}
                onDeleteSeries={() => {
                  store.deleteTask(settingsTask.id)
                  setSettingsTaskId(null)
                  setSettingsOccurrenceKey(null)
                }}
                onDeleteOccurrence={(dateKey) => {
                  store.deleteOccurrence(settingsTask.id, dateKey)
                  setSettingsTaskId(null)
                  setSettingsOccurrenceKey(null)
                }}
                onDeleteSubThis={() => {
                  if (settingsOccurrenceKey) {
                    store.hideSubtaskOccurrence(settingsTask.id, settingsOccurrenceKey)
                  }
                  setSettingsTaskId(null)
                  setSettingsOccurrenceKey(null)
                }}
                onPinnedChange={(value) => store.setPinned(settingsTask.id, value)}
                onSetRemind={(iso) => store.setRemindAt(settingsTask.id, iso, settingsOccurrenceKey)}
                onSetDueRange={(dueIso, endIso) => store.setDueRange(settingsTask.id, dueIso, endIso)}
                onLocked={handleLocked}
              />
            )}
            {recurScope && (
              <div
                className="sheet-backdrop is-confirm"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setRecurScope(null)
                }}
              >
                <div
                  className="sheet confirm-sheet"
                  role="dialog"
                  aria-label="重复事项范围"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="sheet-grip" aria-hidden="true" />
                  <div className="sheet-title">
                    {recurScope.kind === 'edit' ? '编辑重复事项' : '添加子任务'}
                  </div>
                  <p className="confirm-desc">
                    该事项在多个日期重复出现,请选择本次
                    {recurScope.kind === 'edit' ? '修改' : '操作'}的范围:
                  </p>
                  <button
                    type="button"
                    className="sheet-danger"
                    onClick={() => applyRecurScope('this')}
                  >
                    仅本次（{recurScope.dateKey.slice(5)}{' '}
                    {WEEKDAY_CN[parseDayKey(recurScope.dateKey).getDay()]}）
                  </button>
                  <button
                    type="button"
                    className="sheet-danger is-strong"
                    onClick={() => applyRecurScope('all')}
                  >
                    应用到所有重复日
                  </button>
                  <div className="sheet-actions">
                    <button type="button" onClick={() => setRecurScope(null)}>
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}
            {birthdaySheet && (
              <BirthdaySheet
                birthday={editingBirthday}
                createKind={birthdaySheet === 'new-anniversary' ? 'anniversary' : 'birthday'}
                onClose={() => setBirthdaySheet(null)}
                onSubmit={(draft) => {
                  if (editingBirthday) {
                    store.updateBirthday(editingBirthday.id, draft)
                  } else if (!store.addBirthday(draft)) {
                    // 会员闸门兜底:入口已拦,这里防止其他路径绕过时静默失败。
                    handleLocked(
                      birthdaySheet === 'new-anniversary' ? '添加纪念日' : '添加生日',
                    )
                  }
                  setBirthdaySheet(null)
                }}
                onDelete={
                  editingBirthday
                    ? () => {
                        store.deleteBirthday(editingBirthday.id)
                        setBirthdaySheet(null)
                      }
                    : undefined
                }
              />
            )}
            {restoreSheetOpen && (
              <div
                className="sheet-backdrop is-confirm"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setRestoreSheetOpen(false)
                }}
              >
                <div
                  className="sheet confirm-sheet"
                  role="dialog"
                  aria-label="恢复云端数据"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="sheet-grip" aria-hidden="true" />
                  <div className="sheet-title">恢复云端数据</div>
                  <p className="confirm-desc">
                    将云端数据拉取到本设备。请选择恢复方式（不影响云端已保存的数据）：
                  </p>
                  <button type="button" className="sheet-danger is-strong" onClick={() => handleRestore('overwrite')}>
                    覆盖本地数据
                    <span className="sheet-sub">用云端完全替换本地：本地独有事项将被移除</span>
                  </button>
                  <button type="button" className="sheet-primary" onClick={() => handleRestore('merge')}>
                    在现有基础上添加
                    <span className="sheet-sub">仅补充云端有、本地无的事项；同名事项按 ID 跳过，不会产生重复</span>
                  </button>
                  <div className="sheet-actions">
                    <button type="button" onClick={() => setRestoreSheetOpen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}
        </div>

        {toast && (
          <div
            className={`sidebar-toast ${toast.kind === 'ok' ? 'is-ok' : 'is-err'}`}
            role="status"
            aria-live="polite"
          >
            {toast.kind === 'ok' ? <Check size={13} /> : <X size={13} />}
            {toast.text}
          </div>
        )}
      </aside>
      </div>
      {/* /dock-layer */}

      {/* 三个全局弹窗统一 portal 到 .todo-sidebar:absolute 遮罩 inset:0 只覆盖工具面板,
          与设置页内登录弹窗的视觉基准一致,不压住左侧透明把手区;同时继承主题变量。 */}
      {sidebarHost
        ? createPortal(
            loginModalOpen ? (
              <AccountModal
                view={loginView}
                account={account}
                onClose={() => setLoginModalOpen(false)}
                onOpenReset={() => setLoginView('password')}
                onLoggedIn={(acc) => {
                  setLoginModalOpen(false)
                  void (async () => {
                    try {
                      const migrated = (await store.switchAccountProfile(acc.email)) ?? 0
                      if (migrated > 0)
                        setToast({ kind: 'ok', text: `已把本地 ${migrated} 条数据并入账号` })
                    } catch (e) {
                      setToast({ kind: 'err', text: `切换账号数据失败: ${(e as Error).message}` })
                    }
                    store.setSyncConfig({ enabled: true, endpoint: AUTH_BASE, token: acc.token })
                  })()
                }}
                onPasswordChanged={() => {
                  setLoginModalOpen(false)
                  store.setSyncConfig({ enabled: false, token: '' })
                }}
              />
            ) : null,
            sidebarHost,
          )
        : null}
      {sidebarHost
        ? createPortal(
            <LoginGuideSheet
              open={loginGuide.open}
              onGoLogin={() => {
                setLoginGuide({ open: false })
                setLoginView('auth')
                setLoginModalOpen(true)
              }}
              onClose={() => setLoginGuide({ open: false })}
            />,
            sidebarHost,
          )
        : null}
      {/* 首页更新提示弹窗:状态与设置页共用,展示时机由 isOpen 控制 */}
      {sidebarHost
        ? createPortal(
            updateNoticeOpen && updateNotice ? (
              <ErrorBoundary label="更新提示">
                <UpdateNoticeSheet
                  notice={updateNotice}
                  currentVersion={appVersion}
                  update={updateState}
                  onClose={() => setUpdateNoticeOpen(false)}
                  onInstall={() =>
                    void downloadAndInstall(updateNotice.version, updateNotice.url, setUpdateState)
                  }
                />
              </ErrorBoundary>
            ) : null,
            sidebarHost,
          )
        : null}
    </main>
  )
}

function PanelRightOpenIcon(props: { className?: string; size?: number }) {
  return <PanelRightOpen {...props} />
}
function PanelRightCloseIcon(props: { className?: string; size?: number }) {
  return <PanelRightClose {...props} />
}

/** 顶栏工具的图标映射。注册表只存 id,避免纯数据模块依赖 React。 */
function TopbarToolIcon({ id, size = 16 }: { id: TopbarToolId; size?: number }) {
  switch (id) {
    case 'screenshot':
      return <Camera size={size} />
    case 'note':
      return <StickyNote size={size} />
    case 'clipboard':
      return <ClipboardList size={size} />
    case 'calculator':
      return <Calculator size={size} />
    case 'huangli':
      return <BookOpen size={size} />
    case 'salary':
      return <Coins size={size} />
    case 'recorder':
      return <Mic size={size} />
    case 'clothesline':
      return <Shirt size={size} />
    case 'sync':
      return <RefreshCw size={size} />
    default:
      return null
  }
}

/**
 * 「⋯ 更多」菜单:列出按面板宽度装不下、被收起的工具。
 * 直接渲染在 .sidebar-header 内(absolute 相对 .todo-sidebar 定位),因此能继承
 * .workspace 的主题变量,暗色下不会像 portal 到 body 那样出现「侧栏黑、卡片白」。
 */
function TopbarMoreMenu({
  hidden,
  shortcutLabels,
  onRun,
  onManage,
  menuRef,
  topmost,
  onToggleTopmost,
}: {
  hidden: TopbarTool[]
  shortcutLabels: Partial<Record<TopbarToolId, string>>
  onRun: (id: TopbarToolId, name: string) => void
  onManage: () => void
  menuRef: { current: HTMLDivElement | null }
  /** 晾衣绳置顶开关(0.4.65):＋菜单第 7 行常驻,不可隐藏、不进配置页(R85 单一真源)。 */
  topmost: boolean
  onToggleTopmost: () => void
}) {
  return (
    <div className="topbar-menu" ref={menuRef} role="menu" aria-label="更多工具">
      <div className="tm-head">
        <span>更多工具</span>
        <em>已收起 {hidden.length} 个</em>
      </div>
      {hidden.map((t) => (
        <button
          type="button"
          className="tm-item"
          key={t.id}
          role="menuitem"
          onClick={() => onRun(t.id, t.name)}
        >
          <TopbarToolIcon id={t.id} size={15} />
          <span className="nm">{t.name}</span>
          {t.vip ? <span className="tm-vip">会员</span> : null}
          {shortcutLabels[t.id] ? <span className="kd">{shortcutLabels[t.id]}</span> : null}
        </button>
      ))}
      <div className="tm-sep" />
      {/* 晾衣绳置顶开关:常驻不可隐藏。点击不关菜单,可连续切换;唯一真源 alwaysOnTop。 */}
      <button
        type="button"
        className="tm-item tm-cl-topmost"
        role="switch"
        aria-checked={topmost}
        onClick={(e) => {
          e.stopPropagation()
          onToggleTopmost()
        }}
      >
        <Shirt size={15} />
        <span className="nm">晾衣绳置顶</span>
        <span className={`tm-mini-switch ${topmost ? 'is-on' : ''}`}>
          <i />
        </span>
      </button>
      <button type="button" className="tm-manage" onClick={onManage}>
        <Settings size={14} />
        管理顶栏入口…
      </button>
    </div>
  )
}

/**
 * 设置页「顶栏快捷入口」入口行(0.4.62):8 行配置收进底部弹窗,
 * 不再平铺占用设置页空间;弹窗内是 draft,点「保存」才写回配置。
 */
function TopbarToolsSetting({
  pref,
  panelWidth,
  onChange,
  focusToken,
}: {
  pref: TopbarToolsPref
  panelWidth: number
  onChange: (patch: Partial<SidebarSettings>) => void
  focusToken: number
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const { shown, hidden } = splitTopbarTools(pref, panelWidth)
  const offCount = TOPBAR_TOOLS.length - pref.enabled.length

  // 「⋯ 更多 → 管理顶栏入口…」:直接打开配置弹窗(不再滚动到平铺分组)。
  useEffect(() => {
    if (!focusToken) return
    setSheetOpen(true)
  }, [focusToken])

  return (
    <div className="settings-group" id="topbar-tools-group">
      <div className="settings-group-title">顶栏快捷入口</div>
      <button
        type="button"
        className="tt-entry"
        onClick={() => setSheetOpen(true)}
        aria-label="管理顶栏快捷入口"
      >
        <span className="tt-entry-ico"><Settings size={15} /></span>
        <span className="tt-entry-text">
          <strong>管理工具入口</strong>
          <em>
            顶栏 {shown.length} 个 · 更多 {hidden.length} 个
            {offCount > 0 ? ` · 隐藏 ${offCount} 个` : ''}
          </em>
        </span>
        <ChevronRight size={14} />
      </button>
      <p className="settings-hint">可调整顶部栏工具顺序</p>
      {sheetOpen ? (
        <TopbarToolsSheet
          pref={pref}
          panelWidth={panelWidth}
          onSave={(next) => onChange({ topbarTools: next })}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * 底部弹窗:勾选启用 / 上下移动排序 / 恢复默认,全部改本地 draft,
 * 只有点「保存」才提交;取消 / 点遮罩 / Esc 一律丢弃改动。
 */
function TopbarToolsSheet({
  pref,
  panelWidth,
  onSave,
  onClose,
}: {
  pref: TopbarToolsPref
  panelWidth: number
  onSave: (next: TopbarToolsPref) => void
  onClose: () => void
}) {
  const { closing, requestClose } = useSheetClose(onClose)
  const [draft, setDraft] = useState<TopbarToolsPref>(() => sanitizeTopbarTools(pref))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const rows = draft.order
    .map((id) => TOPBAR_TOOLS.find((t) => t.id === id))
    .filter((t): t is TopbarTool => Boolean(t))

  const toggle = (id: TopbarToolId) => {
    const enabled = draft.enabled.includes(id)
      ? draft.enabled.filter((x) => x !== id)
      : draft.order.filter((x) => x === id || draft.enabled.includes(x))
    // 至少留一个入口,避免顶栏只剩「设置」
    if (enabled.length === 0) return
    setDraft({ ...draft, enabled })
  }

  const move = (id: TopbarToolId, delta: -1 | 1) => {
    const order = [...draft.order]
    const i = order.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    setDraft(sanitizeTopbarTools({ ...draft, order }))
  }

  const save = () => {
    onSave(sanitizeTopbarTools(draft))
    requestClose()
  }

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet tt-sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="顶栏快捷入口"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">顶栏快捷入口</div>
        <p className="settings-hint">
          勾选要显示的工具，用箭头调整顺序；靠前的优先占用顶栏，其余自动收进「⋯ 更多」。
        </p>
        <div className="tt-list">
          {rows.map((t, i) => {
            const on = draft.enabled.includes(t.id)
            const pos = topbarPosition(draft, t.id, panelWidth)
            return (
              <div className={`tt-row ${on ? '' : 'is-off'}`} key={t.id}>
                <button
                  type="button"
                  className={`tt-check ${on ? 'is-on' : ''}`}
                  aria-pressed={on}
                  aria-label={`${on ? '隐藏' : '显示'}${t.name}入口`}
                  onClick={() => toggle(t.id)}
                >
                  {on ? <Check size={11} strokeWidth={3} /> : null}
                </button>
                <span className="tt-icon"><TopbarToolIcon id={t.id} size={15} /></span>
                <span className="tt-nm">{t.name}</span>
                <span className={`tt-pos ${pos === 'top' ? 'is-top' : ''}`}>
                  {pos === 'top' ? '顶栏' : pos === 'more' ? '更多' : '隐藏'}
                </span>
                <span className="tt-move">
                  <button
                    type="button"
                    aria-label={`上移${t.name}`}
                    disabled={i === 0}
                    onClick={() => move(t.id, -1)}
                  >
                    <ChevronUp size={11} />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移${t.name}`}
                    disabled={i === rows.length - 1}
                    onClick={() => move(t.id, 1)}
                  >
                    <ChevronDown size={11} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
        <div className="tt-sheet-actions">
          <button
            type="button"
            className="tt-reset"
            onClick={() => setDraft({ ...DEFAULT_TOPBAR_TOOLS })}
          >
            恢复默认
          </button>
          <div className="tt-sheet-buttons">
            <button type="button" className="tt-btn" onClick={requestClose}>
              取消
            </button>
            <button type="button" className="tt-btn is-primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
        <p className="settings-hint">保存后才会更新顶栏；取消则保留原配置。</p>
      </div>
    </div>
  )
}

/** 设置页:窗口停靠边 + 目标屏幕。单屏时「显示屏幕」整行禁用(不隐藏)。 */
function DockPositionSetting({
  dockSide,
  targetMonitor,
  fallback,
  onChange,
}: {
  dockSide: DockSide
  targetMonitor: MonitorPref
  fallback: boolean
  onChange: (patch: Partial<SidebarSettings>) => void
}) {
  const [options, setOptions] = useState<DockMonitorOption[]>([
    { value: 'primary', label: '主屏' },
  ])
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [opts, n] = await Promise.all([listDockMonitors(), dockMonitorCount()])
      if (cancelled) return
      setOptions(opts)
      setCount(n)
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const multi = count > 1
  // 之前选过的屏被拔掉时,保留该项让用户看得见,配合「已回退」提示。
  const shownOptions = options.some((o) => o.value === targetMonitor)
    ? options
    : [...options, { value: targetMonitor, label: '原屏幕（当前不可用）' }]

  return (
    <div className="settings-group" id="dock-position-group">
      <div className="settings-group-title">窗口位置</div>
      <div className="dock-setting-row">
        <span>贴边方向</span>
        <div className="segmented-control" aria-label="贴边方向">
          <button
            type="button"
            className={dockSide === 'left' ? 'is-selected' : ''}
            onClick={() => onChange({ dockSide: 'left' })}
          >
            桌面左侧
          </button>
          <button
            type="button"
            className={dockSide === 'right' ? 'is-selected' : ''}
            onClick={() => onChange({ dockSide: 'right' })}
          >
            桌面右侧
          </button>
        </div>
      </div>
      <div className={`dock-setting-row ${multi ? '' : 'is-disabled'}`}>
        <span>显示屏幕</span>
        <select
          className="dock-select"
          value={targetMonitor}
          disabled={!multi}
          aria-label="显示屏幕"
          onChange={(e) => onChange({ targetMonitor: e.target.value })}
        >
          {shownOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <p className="settings-hint">
        {fallback
          ? '指定的屏幕当前不可用，已临时回退到主屏；重新接入后可切回。'
          : multi
            ? '切换后立即生效，无需重启。'
            : '当前仅检测到 1 个显示器，接入副屏后可选择。'}
      </p>
    </div>
  )
}

/** 独立页面过场动画时长(与 CSS --page-ms 保持一致):
 *  右贴从右滑入、向右滑出;左贴由 .workspace.dock-left 的 CSS 整体镜像。 */
const PAGE_EXIT_MS = 240

/**
 * 独立页面(设置 / 万年历)的外壳。
 * - 绝对定位覆盖在待办主视图之上:打开时从右滑入(向左展开),关闭时向右滑出;
 * - 头部:左侧返回图标 + 标题(点击返回即关闭页面回到待办列表),右侧可选操作;
 * - 关闭动画期间保持挂载(PAGE_EXIT_MS),播完再卸载,保证出场动画完整。
 */
function PageShell({
  open,
  title,
  tone,
  onClose,
  actions,
  children,
}: {
  open: boolean
  title: string
  /** settings:使用设置页表面色;默认跟随侧栏背景。 */
  tone?: 'settings'
  onClose: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    // 关闭:先播出场动画,结束后再卸载。
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, PAGE_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])
  if (!mounted) return null
  return (
    <div
      className={`page-panel ${tone === 'settings' ? 'tone-settings' : ''} ${
        closing ? 'is-closing' : ''
      }`}
      role="dialog"
      aria-label={title}
    >
      <div className="page-panel-header">
        <div className="page-panel-title">
          <button type="button" aria-label="返回" onClick={onClose}>
            <ArrowLeft size={16} />
          </button>
          <strong>{title}</strong>
        </div>
        {actions ? <div className="page-panel-actions">{actions}</div> : null}
      </div>
      <div className="page-panel-scroll">{children}</div>
    </div>
  )
}

/** 版本检查 / 安装 / 弹窗去重的实现统一放在 `src/update.ts`。 */

/** 设置页顶部的版本字段:显示当前版本,支持检查更新并站内下载安装。
 *  状态由 App 根持有(首页更新弹窗与这里共用),避免重复检查与状态分叉。 */
function VersionSetting({
  appVersion,
  update,
  setUpdate,
}: {
  appVersion: string
  update: UpdateState
  setUpdate: Dispatch<SetStateAction<UpdateState>>
}) {
  async function checkUpdate() {
    setUpdate({ status: 'checking' })
    try {
      const data = await fetchLatestVersion()
      setUpdate(
        isNewerVersion(data.version, appVersion || '0.0.0')
          ? { status: 'available', version: data.version, url: data.url }
          : { status: 'latest' },
      )
    } catch (err) {
      setUpdate({ status: 'error', message: `检查失败: ${(err as Error).message}` })
    }
  }
  return (
    <div className="settings-group settings-appearance">
      <div className="settings-group-title">版本</div>
      <div className="sync-now-button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', padding: 0, border: 'none', cursor: 'default' }}>
        <span style={{ fontSize: 13 }}>当前版本{appVersion ? ` v${appVersion}` : ''}</span>
        <button
          type="button"
          className="sync-now-button"
          style={{ width: 'auto', margin: 0 }}
          onClick={() => void checkUpdate()}
          disabled={update.status === 'checking' || update.status === 'downloading' || !appVersion}
        >
          {update.status === 'checking' ? '检查中…' : update.status === 'downloading' ? '下载中…' : '检查更新'}
        </button>
      </div>
      {update.status === 'available' ? (
        <button
          type="button"
          className="sync-now-button"
          onClick={() => void downloadAndInstall(update.version, update.url, setUpdate)}
        >
          {`下载并安装 v${update.version}`}
        </button>
      ) : null}
      {update.status === 'latest' ? (
        <div className="sync-status" aria-live="polite">已是最新版本</div>
      ) : null}
      {update.status === 'downloading' ? (
        <div className="sync-status" aria-live="polite">正在下载 v{update.version},完成后将自动打开安装程序…</div>
      ) : null}
      {update.status === 'installing' ? (
        <div className="sync-status" aria-live="polite">
          安装程序即将启动,Tacco 会先退出以完成覆盖安装;请在弹出的安装向导中点「安装」,完成后会自动创建桌面快捷方式。
        </div>
      ) : null}
      {update.status === 'error' ? (
        <div className="sync-status" aria-live="polite" style={{ lineHeight: 1.6 }}>
          {update.message}
          {update.url ? (
            <>
              <div style={{ marginTop: 6 }}>
                可手动下载安装包,双击运行即可覆盖安装(无需卸载旧版):
              </div>
              <div style={{ marginTop: 4, wordBreak: 'break-all' }}>
                <a href={update.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                  {update.url}
                </a>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 本地数据存储位置设置:可自定义目录(通过 app_config_dir 下的 junction 间接实现),
// 数据默认本地持久化;开启云同步后与云端定时/手动保持一致。
// ---------------------------------------------------------------------------
function DataDirSetting({ store }: { store: ReturnType<typeof useTaskStore> }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [current, setCurrent] = useState<string | null>(() => SqliteStore.getDataDir())
  const [scanning, setScanning] = useState(false)
  const [scanResults, setScanResults] = useState<string[]>([])

  // 回显真源是主目录持久化配置(跨更新存活),localStorage 仅作初始值/缓存:
  // 避免缓存丢失/被清后,设置页误显「默认(应用数据目录)」(0.2.9 修复)。
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void (async () => {
      try {
        const pcfg = JSON.parse((await invoke('get_persist_config')) as string) as {
          data_dir?: string | null
        }
        if (!cancelled) setCurrent(pcfg.data_dir || null)
      } catch {
        /* 忽略,保留 localStorage 读到的值 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 3200)
    return () => clearTimeout(t)
  }, [msg])

  /** 关闭连接 → 交给 Rust 迁移/建立 junction → 重开连接。target=null 表示恢复默认。 */
  async function applyDataDir(target: string | null) {
    await store.closeDbForMigration()
    let dbKey: string
    try {
      dbKey = (await invoke('set_data_dir', { target })) as string
    } catch (e) {
      await store.repointDb().catch(() => {})
      throw e
    }
    // 统一走 setDataDir(写 localStorage 缓存;真源在 Rust 持久化配置,由 set_data_dir 维护)。
    SqliteStore.setDataDir(target)
    SqliteStore.setDbKey(dbKey)
    await store.repointDb()
    setCurrent(target)
  }

  async function pickDir() {
    if (!isTauriRuntime()) {
      setMsg({ kind: 'err', text: '仅桌面端支持更改存储位置' })
      return
    }
    setBusy(true)
    setMsg(null)
    setScanResults([])
    try {
      const selected = await open({ directory: true, multiple: false })
      if (!selected || typeof selected !== 'string') {
        setBusy(false)
        return
      }
      await applyDataDir(selected)
      setMsg({ kind: 'ok', text: '存储位置已更改' })
    } catch (e) {
      setMsg({ kind: 'err', text: `更改失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  async function resetDir() {
    if (!isTauriRuntime()) {
      setMsg({ kind: 'err', text: '仅桌面端支持' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await applyDataDir(null)
      setMsg({ kind: 'ok', text: '已恢复默认存储位置' })
    } catch (e) {
      setMsg({ kind: 'err', text: `恢复失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  async function openFolder() {
    if (!isTauriRuntime()) {
      setMsg({ kind: 'err', text: '仅桌面端支持' })
      return
    }
    try {
      await invoke('reveal_path', { path: current ?? null })
    } catch (e) {
      setMsg({ kind: 'err', text: `打开失败: ${(e as Error).message}` })
    }
  }

  /** 扫描常见位置,找回误丢失的本地数据库目录。 */
  async function scan() {
    if (!isTauriRuntime()) {
      setMsg({ kind: 'err', text: '仅桌面端支持' })
      return
    }
    setScanning(true)
    setMsg(null)
    setScanResults([])
    try {
      const raw = (await invoke('scan_data_locations')) as string
      const list = JSON.parse(raw) as string[]
      // 过滤掉当前默认位置(todobar_data 内)
      const filtered = list.filter((p) => !p.endsWith('todobar_data'))
      if (filtered.length === 0) {
        setMsg({ kind: 'err', text: '未在常见位置找到本地数据库' })
      } else {
        setScanResults(filtered)
        setMsg({ kind: 'ok', text: `找到 ${filtered.length} 个含数据的目录,点击即可恢复` })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `扫描失败: ${(e as Error).message}` })
    } finally {
      setScanning(false)
    }
  }

  async function adopt(dir: string) {
    setBusy(true)
    setMsg(null)
    try {
      await applyDataDir(dir)
      setScanResults([])
      setMsg({ kind: 'ok', text: '已从该目录恢复本地数据' })
    } catch (e) {
      setMsg({ kind: 'err', text: `恢复失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-group">
      <div className="settings-group-title">本地数据存储</div>
      <div className="sync-status" style={{ fontSize: 12, marginBottom: 8 }}>
        待办与节日数据默认保存在本机,不删除该文件夹即不丢失;开启云同步后与云端定时/手动同步保持一致。
      </div>
      <div className="labeled-input" style={{ marginBottom: 10 }}>
        <span>
          <strong>当前位置</strong>
        </span>
        <div style={{ fontSize: 12, opacity: 0.85, wordBreak: 'break-all' }}>
          {current || '默认(应用数据目录)'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="sync-now-button" onClick={() => void pickDir()} disabled={busy}>
          {busy ? '处理中…' : '更改存储位置'}
        </button>
        <button type="button" className="account-link" onClick={() => void openFolder()}>
          打开数据文件夹
        </button>
        <button type="button" className="account-link" onClick={() => void scan()} disabled={scanning}>
          {scanning ? '扫描中…' : '查找本地数据'}
        </button>
        {current ? (
          <button type="button" className="account-link" onClick={() => void resetDir()}>
            恢复默认
          </button>
        ) : null}
      </div>
      {scanResults.length > 0 ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>点击以下目录以恢复其中的数据:</div>
          {scanResults.map((dir) => (
            <button
              key={dir}
              type="button"
              className="account-link"
              style={{ textAlign: 'left', wordBreak: 'break-all' }}
              onClick={() => void adopt(dir)}
              disabled={busy}
            >
              {dir}
            </button>
          ))}
        </div>
      ) : null}
      {msg ? (
        <div
          className="sync-status"
          style={{
            fontSize: 12,
            color: msg.kind === 'ok' ? '#16a34a' : '#dc2626',
            marginTop: 8,
          }}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  )
}

// 打开/关闭窗口快捷键:冲突校验(与截图/贴图快捷键、系统保留、备用 Alt+T 冲突则拦截)。
const WINDOW_SHORTCUT_RESERVED = [
  'CommandOrControl+Shift+Escape', // 任务管理器
  'Control+Alt+Delete',
  'CommandOrControl+Escape',
  'Alt+F4',
  'Alt+Tab',
  'Control+Alt+Tab',
  'CommandOrControl+Alt+Delete',
  // 备用呼出快捷键始终注册,禁止与之重复,否则会双击触发导致「呼出即收起」。
  'CommandOrControl+Alt+T',
]

function toggleWindowShortcutConflict(draft: string, current: string): string | null {
  if (!draft.trim()) return '快捷键不能为空'
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  // 与自身当前值相同:允许(视为未改)。
  if (norm(draft) === norm(current)) return null
  if (WINDOW_SHORTCUT_RESERVED.some((r) => norm(r) === norm(draft))) {
    return '该快捷键被系统 / 托盘占用,请换一个'
  }
  // 与截图 / 贴图快捷键重复。
  try {
    const shot = getScreenshotSettings()
    for (const s of [shot.shotShortcut, shot.pinShortcut, shot.exitShortcut]) {
      if (norm(s) === norm(draft)) return '与截图 / 贴图快捷键重复'
    }
  } catch {
    /* 读取失败忽略 */
  }
  const main = draft.split('+').pop()?.trim() ?? ''
  if (
    !main ||
    ['control', 'ctrl', 'commandorcontrol', 'command', 'cmd', 'alt', 'shift', 'super', 'meta'].includes(
      main.toLowerCase(),
    )
  ) {
    return '快捷键需包含一个主键(如 A、F2、数字),不能只有修饰键'
  }
  return null
}

/** 保存窗口快捷键:先让 Rust 重新注册全局快捷键,成功后再持久化到设置。 */
async function commitToggleWindowShortcut(
  v: string,
  onChange: (patch: Partial<SidebarSettings>) => void,
  onToast?: (kind: 'ok' | 'err', text: string) => void,
) {
  try {
    await invoke('set_toggle_window_shortcut', { shortcut: v })
    onChange({ toggleWindowShortcut: v })
    onToast?.('ok', '窗口快捷键已更新')
  } catch (e) {
    onToast?.('err', e instanceof Error ? e.message : String(e))
  }
}

/** 便利签快捷键冲突校验。 */
function noteShortcutConflict(draft: string, toggleShortcut: string): string | null {
  if (!draft.trim()) return '快捷键不能为空'
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  if (WINDOW_SHORTCUT_RESERVED.some((r) => norm(r) === norm(draft))) {
    return '该快捷键被系统 / 托盘占用,请换一个'
  }
  if (norm(draft) === norm(toggleShortcut)) return '与「打开 / 关闭窗口」快捷键重复'
  try {
    const shot = getScreenshotSettings()
    for (const s of [shot.shotShortcut, shot.pinShortcut, shot.exitShortcut]) {
      if (norm(s) === norm(draft)) return '与截图 / 贴图快捷键重复'
    }
  } catch {
    /* 读取失败忽略 */
  }
  const main = draft.split('+').pop()?.trim() ?? ''
  if (
    !main ||
    ['control', 'ctrl', 'commandorcontrol', 'command', 'cmd', 'alt', 'shift', 'super', 'meta'].includes(
      main.toLowerCase(),
    )
  ) {
    return '快捷键需包含一个主键(如 A、F2、数字),不能只有修饰键'
  }
  return null
}

/**
 * 保存便利签快捷键:**先注册成功、再写进设置**。
 * 顺序不能反 —— 否则会出现「面板显示已启用、快捷键实际没注册」的不同步,
 * 这类不一致在项目里被用户复报过多次,统一以「注册结果」为准。
 */
async function commitNoteShortcut(
  v: string,
  onChange: (patch: Partial<SidebarSettings>) => void,
  onToast?: (kind: 'ok' | 'err', text: string) => void,
) {
  const r = await applyNoteShortcut(v)
  if (!r.ok) {
    onToast?.('err', r.error || '便利签快捷键注册失败')
    return
  }
  onChange({ noteShortcut: v })
  onToast?.('ok', '便利签快捷键已更新')
}

/** 剪贴板浮窗快捷键冲突校验(与打开窗口、便利签、截图/贴图、系统保留冲突则拦截)。 */
function clipboardShortcutConflict(
  draft: string,
  toggleShortcut: string,
  noteShortcut: string,
): string | null {
  if (!draft.trim()) return '快捷键不能为空'
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  if (WINDOW_SHORTCUT_RESERVED.some((r) => norm(r) === norm(draft))) {
    return '该快捷键被系统 / 托盘占用,请换一个'
  }
  if (norm(draft) === norm(toggleShortcut)) return '与「打开 / 关闭窗口」快捷键重复'
  if (norm(draft) === norm(noteShortcut)) return '与「新建便利签」快捷键重复'
  try {
    const shot = getScreenshotSettings()
    for (const s of [shot.shotShortcut, shot.pinShortcut, shot.exitShortcut]) {
      if (norm(s) === norm(draft)) return '与截图 / 贴图快捷键重复'
    }
  } catch {
    /* 读取失败忽略 */
  }
  const main = draft.split('+').pop()?.trim() ?? ''
  if (
    !main ||
    ['control', 'ctrl', 'commandorcontrol', 'command', 'cmd', 'alt', 'shift', 'super', 'meta'].includes(
      main.toLowerCase(),
    )
  ) {
    return '快捷键需包含一个主键(如 A、F2、数字),不能只有修饰键'
  }
  return null
}

/**
 * 保存剪贴板快捷键:**先注册成功、再写进设置**(与便利签同顺序,避免面板与快捷键不同步)。
 */
async function commitClipboardShortcut(
  v: string,
  onChange: (patch: Partial<SidebarSettings>) => void,
  onToast?: (kind: 'ok' | 'err', text: string) => void,
) {
  const r = await applyClipboardShortcut(v)
  if (!r.ok) {
    onToast?.('err', r.error || '剪贴板快捷键注册失败')
    return
  }
  onChange({ clipboardShortcut: v })
  onToast?.('ok', '剪贴板快捷键已更新')
}

function SidebarSettingsPanel({
  settings,
  onChange,
  syncConfig,
  syncState,
  onSyncChange,
  onSwitchProfile,
  onSyncNow,
  onOpenRestore,
  onLocked,
  onToast,
  store,
  appVersion,
  updateState,
  setUpdateState,
  topbarFocus,
  dockFallback,
}: {
  appVersion: string
  updateState: UpdateState
  setUpdateState: Dispatch<SetStateAction<UpdateState>>
  /** 「⋯ 更多 → 管理顶栏入口…」的定位 token,变化即滚动到配置分组。 */
  topbarFocus: number
  /** 指定的目标屏幕当前不可用,设置页据此提示「已回退主屏」。 */
  dockFallback: boolean
  settings: SidebarSettings
  onChange: (patch: Partial<SidebarSettings>) => void
  syncConfig: import('./types').SyncConfig
  syncState: import('./types').SyncState
  onSyncChange: (patch: Partial<import('./types').SyncConfig>) => void
  /** 登录成功后切换到该账号的独立本地库(账号数据隔离)。 */
  onSwitchProfile: (email: string) => Promise<number>
  onSyncNow: () => void
  onOpenRestore: () => void
  /** 点击受限同步入口时的回调(功能名),由父组件弹 toast 提示开通会员。 */
  onLocked?: (feature: string) => void
  /** 保存结果提示(快捷键校验失败 / 注册失败等)。 */
  onToast?: (kind: 'ok' | 'err', text: string) => void
  store: ReturnType<typeof useTaskStore>
}) {
  const statusLabel =
    syncState.status === 'idle'
      ? syncState.pending > 0
        ? `待同步 ${syncState.pending} 项`
        : '已同步'
      : syncState.status === 'syncing'
        ? '正在同步…'
        : syncState.status === 'error'
          ? `同步失败: ${syncState.lastError ?? ''}`
          : syncState.status
  const [supportOpen, setSupportOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 版本记录:列表弹窗 + 详情弹窗(点击卡片后挂载第二层)。
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogItem, setChangelogItem] = useState<ReleaseRecord | null>(null)
  // 会员闸门:受限用户不能上传云端 / 从云端恢复,同步区整体置灰。
  const { fullAccess, showVip } = useAccount()
  const syncLocked = !fullAccess
  /** 自动同步开关的「生效值」:未登录 / 试用结束且未激活会员时一律显示为关,
   *  即使之前(试用期内)是打开的。底层 syncConfig.autoSync 保留用户偏好、不写死
   *  false —— 成为会员后开关与定时同步按原偏好自动恢复,不用用户重新打开。 */
  const autoSyncOn = effectiveAutoSync(syncConfig.autoSync, fullAccess)

  return (
    // 嵌套在外层 .settings-scroll 内:底部 76px 预留由外层承担,内层清零。
    <div className="settings-scroll settings-scroll-nested">
      <AccountSetting onSyncChange={onSyncChange} onSwitchProfile={onSwitchProfile} />
      <VersionSetting appVersion={appVersion} update={updateState} setUpdate={setUpdateState} />
      <TopbarToolsSetting
        pref={settings.topbarTools}
        panelWidth={settings.panelWidth}
        onChange={onChange}
        focusToken={topbarFocus}
      />
      <DockPositionSetting
        dockSide={settings.dockSide}
        targetMonitor={settings.targetMonitor}
        fallback={dockFallback}
        onChange={onChange}
      />
      <div className="settings-group settings-appearance">
        <div className="settings-group-title">外观</div>
        <div className="segmented-control" aria-label="外观">
          <button
            type="button"
            className={settings.theme === 'light' ? 'is-selected' : ''}
            onClick={() => onChange({ theme: 'light' })}
          >
            浅色
          </button>
          <button
            type="button"
            className={settings.theme === 'dark' ? 'is-selected' : ''}
            onClick={() => onChange({ theme: 'dark' })}
          >
            深色
          </button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">背景</div>
        <div className="bg-grid">
          {BACKGROUND_OPTIONS.map((b) => (
            <button
              type="button"
              key={b.key}
              className={`bg-swatch bg-${b.key} ${settings.background === b.key ? 'is-selected' : ''}`}
              onClick={() => onChange({ background: b.key })}
              aria-label={b.label}
              title={b.label}
            >
              <span>{b.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">桌面</div>
        <ToggleSetting
          label="开机自动登录"
          checked={settings.launchAtLogin}
          onChange={(launchAtLogin) => onChange({ launchAtLogin })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">窗口</div>
        <SliderSetting
          label="面板宽度"
          value={settings.panelWidth}
          min={300}
          max={500}
          step={4}
          suffix="px"
          onChange={(panelWidth) => onChange({ panelWidth })}
        />
        <SliderSetting
          label="可见把手宽度"
          value={settings.tabWidth}
          min={34}
          max={62}
          step={2}
          suffix="px"
          onChange={(tabWidth) => onChange({ tabWidth })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">边缘把手</div>
        <SliderSetting
          label="把手高度"
          value={settings.handleHeight}
          min={72}
          max={132}
          step={2}
          suffix="px"
          onChange={(handleHeight) => onChange({ handleHeight })}
        />
        <SliderSetting
          label="垂直位置"
          value={settings.handleY}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(handleY) => onChange({ handleY })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">任务</div>
        <ToggleSetting
          label="显示已完成"
          checked={settings.showCompleted}
          onChange={(showCompleted) => onChange({ showCompleted })}
        />
        <SliderSetting
          label="行高"
          value={settings.taskRowHeight}
          min={40}
          max={62}
          step={1}
          suffix="px"
          onChange={(taskRowHeight) => onChange({ taskRowHeight })}
        />
        <SliderSetting
          label="行间距"
          value={settings.taskGap}
          min={4}
          max={14}
          step={1}
          suffix="px"
          onChange={(taskGap) => onChange({ taskGap })}
        />
        <SliderSetting
          label="文字大小"
          value={settings.taskTextSize}
          min={11}
          max={14}
          step={0.5}
          suffix="px"
          onChange={(taskTextSize) => onChange({ taskTextSize })}
        />
        <div className="labeled-select">
          <span>字体</span>
          <select
            value={settings.taskFont}
            onChange={(e) => onChange({ taskFont: e.target.value })}
            aria-label="待办事项字体"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">同步</div>
        <ToggleSetting
          label="自动同步"
          checked={autoSyncOn}
          onLocked={syncLocked ? () => onLocked?.('云端同步') : undefined}
          onChange={(autoSync) => onSyncChange({ autoSync })}
        />
        {autoSyncOn ? (
          <OptionSetting
            label="自动间隔"
            value={
              SYNC_INTERVAL_OPTIONS.some((o) => o.value === syncConfig.intervalSec)
                ? syncConfig.intervalSec
                : 300
            }
            options={SYNC_INTERVAL_OPTIONS}
            onChange={(intervalSec) => onSyncChange({ intervalSec })}
          />
        ) : null}
        <div className="sync-buttons">
          <button
            type="button"
            className="sync-now-button"
            onClick={() => (syncLocked ? onLocked?.('云端同步') : onSyncNow())}
            disabled={syncState.status === 'syncing' || !syncConfig.enabled}
          >
            {syncState.status === 'syncing' ? '同步中…' : '立即同步'}
          </button>
          <button
            type="button"
            className="sync-now-button sync-restore-button"
            onClick={() => (syncLocked ? onLocked?.('恢复云端数据') : onOpenRestore())}
            disabled={!syncConfig.enabled}
            aria-label="恢复云端数据"
          >
            恢复云端数据
          </button>
        </div>
        {syncLocked ? (
          <div className="sheet-hint">云端同步(上传 / 恢复)为会员功能,开通会员后可无限制使用</div>
        ) : null}
        <div className="sync-status" aria-live="polite">
          {statusLabel}
          {syncState.status === 'error'
            ? ''
            : syncState.lastPushAt
              ? ` · 上次推送 ${new Date(syncState.lastPushAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : ''}
        </div>
      </div>

      <DataDirSetting store={store} />

      <div className="settings-group">
        <div className="settings-group-title">观感</div>
        <SliderSetting
          label="动画时长"
          value={settings.motionMs}
          min={140}
          max={360}
          step={10}
          suffix="ms"
          onChange={(motionMs) => onChange({ motionMs })}
        />
        <SliderSetting
          label="面板圆角"
          value={settings.panelRadius}
          min={12}
          max={28}
          step={1}
          suffix="px"
          onChange={(panelRadius) => onChange({ panelRadius })}
        />
        <SliderSetting
          label="不透明度"
          value={settings.surfaceAlpha}
          min={86}
          max={100}
          step={1}
          suffix="%"
          onChange={(surfaceAlpha) => onChange({ surfaceAlpha })}
        />
      </div>

      {/* 三个全局快捷键与紧随其后的「截图 / 贴图」快捷键归在同一区块(0.4.62 用户反馈)。 */}
      <div className="settings-group">
        <div className="settings-group-title">快捷键</div>
        <ShortcutField
          label="打开窗口"
          value={settings.toggleWindowShortcut}
          conflictFor={(draft) => toggleWindowShortcutConflict(draft, settings.toggleWindowShortcut)}
          onCommit={(v) => void commitToggleWindowShortcut(v, onChange, onToast)}
        />
        <ShortcutField
          label="新建便利签"
          value={settings.noteShortcut}
          conflictFor={(draft) => noteShortcutConflict(draft, settings.toggleWindowShortcut)}
          onCommit={(v) => void commitNoteShortcut(v, onChange, onToast)}
          locked={!fullAccess}
          onLocked={() => onLocked?.('便利签')}
          vip={showVip}
        />
        <ShortcutField
          label="打开剪贴板"
          value={settings.clipboardShortcut}
          conflictFor={(draft) =>
            clipboardShortcutConflict(draft, settings.toggleWindowShortcut, settings.noteShortcut)
          }
          onCommit={(v) => void commitClipboardShortcut(v, onChange, onToast)}
          locked={!fullAccess}
          onLocked={() => onLocked?.('剪贴板')}
          vip={showVip}
        />
        <p className="settings-hint">
          双击编辑框即可修改；与下方截图 / 贴图同属全局快捷键，请勿设置成相同组合。
        </p>
      </div>

      {/* 悬浮入口:固定在设置页底部,滚动时始终可见,两个按钮同一行 */}
      <div className="fab-row">
        <button
          type="button"
          className="fab-support fab-secondary"
          onClick={() => setChangelogOpen(true)}
          aria-label="版本记录"
        >
          <History size={14} />
          版本记录
        </button>
        <button
          type="button"
          className="fab-support"
          onClick={() => setSupportOpen(true)}
          aria-label="联系客服"
        >
          <MessageCircle size={14} />
          联系客服
        </button>
      </div>

      {/* 条件渲染:关即卸载,避免复用实例残留 is-closing 遮罩卡死整页 */}
      {changelogOpen ? (
        <ChangelogSheet
          onClose={() => setChangelogOpen(false)}
          onOpenDetail={(r) => setChangelogItem(r)}
        />
      ) : null}
      {changelogItem ? (
        <ChangelogDetailSheet item={changelogItem} onClose={() => setChangelogItem(null)} />
      ) : null}
      {supportOpen ? (
        <SupportSheet
          onClose={() => setSupportOpen(false)}
          onOpenHistory={() => {
            setSupportOpen(false)
            setHistoryOpen(true)
          }}
        />
      ) : null}
      {historyOpen ? <SupportHistorySheet onClose={() => setHistoryOpen(false)} /> : null}
    </div>
  )
}

/** 自动同步间隔预设:最短 5 分钟,最长 12 小时。 */
const SYNC_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 300, label: '5分钟' },
  { value: 600, label: '10分钟' },
  { value: 1800, label: '30分钟' },
  { value: 3600, label: '1小时' },
  { value: 10800, label: '3小时' },
  { value: 21600, label: '6小时' },
  { value: 43200, label: '12小时' },
]

function OptionSetting({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: number
  options: { value: number; label: string }[]
  onChange: (value: number) => void
}) {
  return (
    <div className="option-setting">
      <strong>{label}</strong>
      <div className="option-setting-list" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'is-active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleSetting({
  label,
  checked,
  onChange,
  onLocked,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** 受限(未激活)时的点击回调:阻止勾选并弹提示。入口不置灰,保持可点。 */
  onLocked?: () => void
}) {
  return (
    <label
      className="toggle-setting"
      onClick={(e) => {
        if (!onLocked) return
        // 阻止 label 的默认「激活关联控件」行为,开关不会被真的拨动。
        e.preventDefault()
        onLocked()
      }}
    >
      <span>
        <strong>{label}</strong>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <em aria-hidden="true" />
    </label>
  )
}

function SliderSetting({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <label className="slider-setting">
      <span>
        <strong>{label}</strong>
        <em>
          {value}
          {suffix}
        </em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function atHourOffset(dayOffset: number, hour: number): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

function endOfDayOffset(dayOffset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(23, 59, 0, 0)
  return d.toISOString()
}

function startOfDayOffset(dayOffset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(0, 1, 0, 0)
  return d.toISOString()
}

function formatDueShort(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 23 && d.getMinutes() === 59) return base
  return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type RowDragState = {
  id: string
  sib: string
  y: number
  overId: string | null
  overBefore: boolean
}

type TreeCtx = {
  childMap: Map<string, Task[]>
  onToggleDone: (id: string) => void
  /** 挂到顶部晾衣绳（只写 clothesline/cards.json）。 */
  onHang: (task: Task) => void
  /** 「整组」子任务在某个发生日下的独立勾选(写子任务 completedDates,不影响其他日期)。 */
  onToggleSeriesSub: (subtaskId: string, dateKey: string) => void
  onRename: (task: Task, title: string) => void
  onAddChild: (parentId: string, title: string) => void
  onOpenSettings: (task: Task, occurrenceKey?: string | null) => void
  onOpenSeries: (templateId: string, dateKey?: string) => void
  onRowPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string, sib: string) => void
  suppressClick: () => boolean
  rowDrag: RowDragState | null
}

/**
 * 树节点:主任务/子任务/下级共三层。
 * - 点击事项框原地编辑,Enter 或失焦保存,Esc 取消
 * - 右侧常驻 "+"(三层除外)与设置图标
 * - 有下级时显示展开/收起箭头,默认收起(进入页面时子任务不自动展开)
 * - 任意层级都可勾选完成(置灰 + 划线)
 */
function TaskNode({
  task,
  level,
  ctx,
  sibKey,
  occurrenceKey,
}: {
  task: Task
  level: 1 | 2 | 3
  ctx: TreeCtx
  sibKey: string
  /** 所在重复事项实例的发生日(YYYY-MM-DD);非重复实例的子树为 null。 */
  occurrenceKey?: string | null
}) {
  const children = useMemo(() => {
    // 重复事项实例:合并「仅本次」子任务(parentId=实例id)与「整组」子任务(parentId=模板id),
    // 后者会在每个发生日下都显示;已被「仅本次隐藏」(deletedDates 含该发生日)的整组子任务除外。
    const own = ctx.childMap.get(task.id) ?? []
    const dateKey = task.dueDate ?? ''
    const series = task.seriesId
      ? (ctx.childMap.get(task.seriesId) ?? []).filter(
          (c) => !(c.deletedDates ?? []).includes(dateKey),
        )
      : []
    return sortTasks([...own, ...series])
  }, [ctx.childMap, task.id, task.seriesId, task.dueDate])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  // 进入日/周/月待办页面时,子任务默认收起;用户点箭头或新增下级后再展开。
  const [expanded, setExpanded] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [childDraft, setChildDraft] = useState('')

  // 「整组」子任务(以及它的下级)挂在重复模板下,会在每个发生日重复显示:
  // 它们的完成状态按发生日独立存储在 completedDates,而不是共享的 done 字段。
  // 虚拟实例本身(id 带 @)与「仅本次」子任务(parentId 为实例 id)不适用。
  const occDate = occurrenceKey ?? null
  const isDateUnique =
    task.id.includes('@') || (task.parentId != null && task.parentId.includes('@'))
  const perDate = Boolean(occDate) && !isDateUnique
  const effDone = perDate ? (task.completedDates ?? []).includes(occDate!) : task.done

  const isDragging = ctx.rowDrag?.id === task.id
  const isDropAbove = ctx.rowDrag?.overId === task.id && ctx.rowDrag.overBefore
  const isDropBelow = ctx.rowDrag?.overId === task.id && !ctx.rowDrag.overBefore

  const beginEdit = () => {
    setDraft(task.title)
    setEditing(true)
  }
  const commitEdit = () => {
    const next = draft.trim()
    if (next && next !== task.title) ctx.onRename(task, next)
    setEditing(false)
  }
  const commitChild = () => {
    const next = childDraft.trim()
    if (next) {
      ctx.onAddChild(task.id, next)
      setChildDraft('')
      setExpanded(true)
    }
    setAddingChild(false)
  }

  return (
    <div
      className={`tree-node lv-${level} ${effDone ? 'is-done' : ''} ${
        task.isPinned ? 'is-pinned' : ''
      }`}
    >
      <div
        className={`tree-row ${editing ? 'is-editing' : ''} ${isDragging ? 'is-dragging' : ''} ${
          isDropAbove ? 'is-drop-above' : ''
        } ${isDropBelow ? 'is-drop-below' : ''} ${
          // 有标签/提醒时间等 meta 行时,圆圈需改为与标题首行对齐(见 CSS has-meta 规则)
          !editing && (task.seriesId || task.remindAt || task.isPinned) ? 'has-meta' : ''
        }`}
        data-node-id={task.id}
        data-sib={sibKey}
        onPointerDown={(e) => ctx.onRowPointerDown(e, task.id, sibKey)}
      >
        <span className="tree-toggle">
          {children.length > 0 ? (
            <button
              type="button"
              aria-label={expanded ? '收起下级' : '展开下级'}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : null}
        </span>
        <button
          type="button"
          className="check-button"
          aria-label={effDone ? `将 ${task.title} 标记为未完成` : `完成 ${task.title}`}
          onClick={(e) => {
            e.stopPropagation()
            if (perDate) ctx.onToggleSeriesSub(task.id, occDate!)
            else ctx.onToggleDone(task.id)
          }}
        >
          {effDone ? <Check size={13} /> : <Circle size={13} />}
        </button>
        <div
          className="tree-body"
          onClick={() => {
            if (editing || ctx.suppressClick()) return
            // 重复事项的虚拟实例也支持原地编辑;提交时由 onRename 弹出范围确认。
            beginEdit()
          }}
        >
          {editing ? (
            <input
              className="tree-edit-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') setEditing(false)
              }}
              onBlur={commitEdit}
            />
          ) : (
            <>
              <strong className={effDone ? 'is-done' : ''}>{task.title}</strong>
              {(task.seriesId || task.remindAt || task.isPinned) && (
                <span className="tree-meta">
                  {/* 重复周期标签与提醒时间同行显示,避免独占一行挤压标题空间 */}
                  {task.seriesId &&
                    (task.seriesRecurrence ? (
                      <span className="recur-tag">{recurrenceLabel(task.seriesRecurrence)}</span>
                    ) : (
                      <i className="recur-tag">↻</i>
                    ))}
                  {task.remindAt ? `⏰ ${formatDueShort(task.remindAt)}` : ''}
                  {task.isPinned && <i className="pinned-tag">置顶</i>}
                </span>
              )}
            </>
          )}
        </div>
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <button type="button" className="icon-button" aria-label="保存" onClick={commitEdit}>
              <Check size={13} />
            </button>
          ) : (
            <>
              {level === 1 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`把 ${task.title} 挂到晾衣绳`}
                  title="挂到晾衣绳"
                  onClick={() => ctx.onHang(task)}
                >
                  <Shirt size={13} />
                </button>
              )}
              {level < 3 && (
                <button
                  type="button"
                  className={`icon-button ${addingChild ? 'is-active' : ''}`}
                  aria-label={`为 ${task.title} 添加下级`}
                  onClick={() => {
                    setAddingChild((v) => !v)
                    setExpanded(true)
                  }}
                >
                  <Plus size={13} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`${task.title} 设置`}
                onClick={() => {
                  // 重复事项的虚拟实例没有独立记录,设置入口应打开其模板(整组规则)。
                  if (task.seriesId) {
                    ctx.onOpenSeries(task.seriesId, task.dueDate ?? undefined)
                    return
                  }
                  // 子任务带上所在实例的发生日:删除时才能弹「仅本次/所有重复日」范围确认。
                  ctx.onOpenSettings(task, occurrenceKey ?? null)
                }}
              >
                <Settings size={13} />
              </button>
            </>
          )}
        </span>
      </div>

      {children.length > 0 ? (
        <div className={`tree-children-wrap ${expanded ? 'is-open' : ''}`}>
          <div className="tree-children">
            {children.map((child) => (
              <TaskNode
                key={child.id}
                task={child}
                level={level === 1 ? 2 : 3}
                ctx={ctx}
                sibKey={`p:${task.id}`}
                occurrenceKey={task.seriesId ? task.dueDate ?? null : occurrenceKey ?? null}
              />
            ))}
          </div>
        </div>
      ) : null}

      {addingChild && (
        <div className="tree-child-add">
          <input
            autoFocus
            placeholder="输入下级标题,回车保存,Esc 取消"
            value={childDraft}
            onChange={(e) => setChildDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitChild()
              if (e.key === 'Escape') {
                setChildDraft('')
                setAddingChild(false)
              }
            }}
            onBlur={commitChild}
          />
        </div>
      )}
    </div>
  )
}

type DraftNode = { key: number; title: string; children: DraftNode[] }

/** 底部弹窗:录入主任务 + 子任务 + 下级(最多三层) + 重复规则 */
function AddTaskSheet({
  dateLabel,
  onClose,
  onSubmit,
  onLocked,
}: {
  dateLabel: string
  onClose: () => void
  onSubmit: (mainTitle: string, subs: DraftNode[], recurrence: Recurrence | null) => void
  /** 点击受限入口时回调(功能名),由父组件弹 toast 提示开通会员。 */
  onLocked?: (feature: string) => void
}) {
  const [mainTitle, setMainTitle] = useState('')
  const [subs, setSubs] = useState<DraftNode[]>([])
  const [recMode, setRecMode] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none')
  const [weekday, setWeekday] = useState<number>(((new Date().getDay() + 6) % 7) + 1)
  const [monthDay, setMonthDay] = useState<number>(1)
  const [skipHolidays, setSkipHolidays] = useState(false)
  const keyRef = useRef(1)
  // 会员闸门:入口照常展示(不隐藏、不置灰),点击时才提示「子任务为会员功能」。
  const { fullAccess } = useAccount()

  const addSub = () => {
    if (!fullAccess) {
      onLocked?.('添加子任务')
      return
    }
    setSubs((list) => [...list, { key: (keyRef.current += 1), title: '', children: [] }])
  }

  const removeSub = (key: number) => setSubs((list) => list.filter((s) => s.key !== key))

  const updateSub = (key: number, title: string) =>
    setSubs((list) => list.map((s) => (s.key === key ? { ...s, title } : s)))

  const addGrand = (parentKey: number) => {
    if (!fullAccess) {
      onLocked?.('添加下级')
      return
    }
    setSubs((list) =>
      list.map((s) =>
        s.key === parentKey
          ? {
              ...s,
              children: [...s.children, { key: (keyRef.current += 1), title: '', children: [] }],
            }
          : s,
      ),
    )
  }

  const updateGrand = (parentKey: number, gKey: number, title: string) =>
    setSubs((list) =>
      list.map((s) =>
        s.key === parentKey
          ? { ...s, children: s.children.map((g) => (g.key === gKey ? { ...g, title } : g)) }
          : s,
      ),
    )

  const removeGrand = (parentKey: number, gKey: number) =>
    setSubs((list) =>
      list.map((s) =>
        s.key === parentKey ? { ...s, children: s.children.filter((g) => g.key !== gKey) } : s,
      ),
    )

  const submit = () => {
    if (!mainTitle.trim()) return
    let recurrence: Recurrence | null = null
    if (recMode === 'daily') recurrence = { freq: 'daily', skipHolidays }
    else if (recMode === 'weekly') recurrence = { freq: 'weekly', weekdays: [weekday], skipHolidays }
    else if (recMode === 'monthly') recurrence = { freq: 'monthly', monthDay, skipHolidays }
    onSubmit(mainTitle, subs, recurrence)
    onClose()
  }

  const { closing, requestClose } = useSheetClose(onClose)

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="添加事项"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">添加事项</div>
        <div className="sheet-subtitle">
          {fullAccess
            ? `日期:${dateLabel} · 支持主任务 / 子任务 / 下级,最多三层`
            : `日期:${dateLabel} · 单日上限 ${FREE_DAILY_TASK_LIMIT} 条,子任务为会员功能`}
        </div>
        <input
          className="sheet-main-input"
          placeholder="输入主任务标题…"
          value={mainTitle}
          autoFocus
          onChange={(e) => setMainTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {subs.map((sub) => (
          <div className="sheet-l2" key={sub.key}>
            <div className="sheet-l2-row">
              <input
                placeholder="子任务…"
                value={sub.title}
                onChange={(e) => updateSub(sub.key, e.target.value)}
              />
              <button
                type="button"
                className="sheet-remove"
                aria-label="移除该子任务"
                onClick={() => removeSub(sub.key)}
              >
                <X size={13} />
              </button>
            </div>
            {sub.children.map((grand) => (
              <div className="sheet-l3-row" key={grand.key}>
                <input
                  placeholder="子任务的子任务…"
                  value={grand.title}
                  onChange={(e) => updateGrand(sub.key, grand.key, e.target.value)}
                />
                <button
                  type="button"
                  className="sheet-remove"
                  aria-label="移除该下级"
                  onClick={() => removeGrand(sub.key, grand.key)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="sheet-add-link" onClick={() => addGrand(sub.key)}>
              + 子任务的子任务
            </button>
          </div>
        ))}
        <button type="button" className="sheet-add-link sheet-add-main" onClick={addSub}>
          + 子任务
        </button>
        <div className="sheet-section">重复</div>
        <div className="recur-row">
          {(['none', 'daily', 'weekly', 'monthly'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`recur-chip ${recMode === m ? 'is-active' : ''}`}
              onClick={() => setRecMode(m)}
            >
              {m === 'none' ? '不重复' : m === 'daily' ? '每天' : m === 'weekly' ? '每周' : '每月'}
            </button>
          ))}
        </div>
        {recMode === 'weekly' && (
          <div className="recur-row">
            {[1, 2, 3, 4, 5, 6, 7].map((wd) => (
              <button
                key={wd}
                type="button"
                className={`recur-chip ${weekday === wd ? 'is-active' : ''}`}
                onClick={() => setWeekday(wd)}
              >
                {WEEKDAY_CN[(wd % 7)]}
              </button>
            ))}
          </div>
        )}
        {recMode === 'monthly' && (
          <div className="recur-row">
            <span className="recur-hint">每月</span>
            <input
              className="recur-day-input"
              type="number"
              min={1}
              max={31}
              value={monthDay}
              onChange={(e) => {
                const v = Math.min(31, Math.max(1, Number(e.target.value) || 1))
                setMonthDay(v)
              }}
            />
            <span className="recur-hint">号</span>
          </div>
        )}
        {recMode !== 'none' && (
          <label className="toggle-setting sheet-toggle recur-skip">
            <span>
              <strong>跳过法定节假日</strong>
              <span className="recur-skip-hint">节假日当天不生成待办</span>
            </span>
            <input
              type="checkbox"
              checked={skipHolidays}
              onChange={(e) => setSkipHolidays(e.target.checked)}
            />
            <em />
          </label>
        )}
        <div className="sheet-actions">
          <button type="button" onClick={requestClose}>
            取消
          </button>
          <button type="button" className="is-primary" onClick={submit}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 弹层挂载点:挂进 .workspace 以继承主题变量(--* 变量都定义在 .workspace 上,
 * 挂 document.body 会全部失效→背景透明/颜色丢失);fixed 定位不受
 * .workspace 的 position:relative/overflow:hidden 影响,仍按可视区定位与翻转。
 */
function popPortalHost(): HTMLElement {
  return document.querySelector('.workspace') ?? document.body
}

/**
 * 自绘月历弹层(处理日期用):替代原生 <input type="date"> 的 showPicker。
 * 原生日历由 WebView2 定位,输入框贴近窗口右缘时弹窗会被截断;自绘弹层用
 * fixed 定位并按可视区翻转/收拢,保证完整展示。
 */
function SheetDatePicker({
  value,
  min,
  onChange,
  ariaLabel,
}: {
  /** YYYY-MM-DD 或 ''(未选)。 */
  value: string
  /** 早于该日期的格子禁用(可选)。 */
  min?: string
  onChange: (v: string) => void
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  /** 日历视图所显示的年月(与选中值解耦,翻页不改变选择)。 */
  const [view, setView] = useState(() => {
    const base = value ? parseDayKey(value) : new Date()
    return { y: base.getFullYear(), m: base.getMonth() }
  })
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const keyOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const openPop = () => {
    const base = value ? parseDayKey(value) : new Date()
    setView({ y: base.getFullYear(), m: base.getMonth() })
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const popW = 248
      const popH = 296
      // 右缘放不下则整体左移;下方放不下则翻转到输入框上方
      const left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8))
      const top = r.bottom + 6 + popH > window.innerHeight - 8 ? Math.max(8, r.top - popH - 6) : r.bottom + 6
      setPos({ left, top })
    }
    setOpen(true)
  }

  // 点击弹层/输入框以外区域或按 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 42 格月历(周一起始,与原生日历一致),前后用相邻月份补齐
  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7 // 周一=0
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(view.y, view.m, 1 - firstDow + i))
  }
  const todayKey = keyOf(new Date())

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="sheet-dpop-input"
        onClick={openPop}
        aria-label={ariaLabel}
        data-open={open || undefined}
      >
        <span className={value ? undefined : 'is-placeholder'}>{value ? value.replaceAll('-', '/') : '选择日期'}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3" y="4.5" width="14" height="12.5" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 8.4h14" stroke="currentColor" strokeWidth="1.6" />
          <path d="M6.8 2.8v3M13.2 2.8v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div className="sheet-dpop" ref={popRef} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="选择日期">
            <div className="sheet-dpop-head">
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { ...v, m: v.m - 1 }))}
                aria-label="上一月"
              >
                ‹
              </button>
              <span className="sheet-dpop-title">
                {view.y}年{view.m + 1}月
              </span>
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { ...v, m: v.m + 1 }))}
                aria-label="下一月"
              >
                ›
              </button>
            </div>
            <div className="sheet-dpop-grid">
              {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                <span key={w} className="sheet-dpop-wd">
                  {w}
                </span>
              ))}
              {cells.map((d) => {
                const k = keyOf(d)
                const inMonth = d.getMonth() === view.m
                const disabled = min ? k < min : false
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled}
                    className={[
                      'sheet-dpop-day',
                      inMonth ? '' : 'is-out',
                      k === todayKey ? 'is-today' : '',
                      k === value ? 'is-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      onChange(k)
                      setOpen(false)
                    }}
                  >
                    {d.getDate()}
                  </button>
                )
              })}
            </div>
          </div>,
          popPortalHost(),
        )}
    </>
  )
}

/**
 * 自绘「日期 + 时间」弹层(提醒用):与 SheetDatePicker 同源的 fixed + Portal 布局,
 * 在月历下方附加 时/分 两个可滚动选择列,替代原生 <input type="datetime-local"> 的 showPicker
 * (后者在 WebView2 贴右缘时会被截断)。
 */
function SheetDateTimePicker({
  value,
  onChange,
  ariaLabel,
  onLocked,
}: {
  /** ISO 时间戳或 ''。 */
  value: string
  onChange: (iso: string | null) => void
  ariaLabel: string
  /** 受限(未激活)时点击的回调:不展开面板,由父组件弹「会员功能」提示。 */
  onLocked?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => {
    const base = value ? new Date(value) : new Date()
    return { y: base.getFullYear(), m: base.getMonth() }
  })
  // 选中日期(本地)与时分;打开时从现有值初始化,无值则默认今天 + 当前时间
  const [sel, setSel] = useState<{ date: Date | null; hour: number; minute: number }>(() => {
    const d = value ? new Date(value) : new Date()
    return { date: value ? d : null, hour: d.getHours(), minute: d.getMinutes() }
  })
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const keyOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const emit = (date: Date | null, hour: number, minute: number) => {
    if (!date) {
      onChange(null)
      return
    }
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0)
    onChange(d.toISOString())
  }

  const openPop = () => {
    const d = value ? new Date(value) : new Date()
    setView({ y: d.getFullYear(), m: d.getMonth() })
    setSel({ date: value ? d : null, hour: d.getHours(), minute: d.getMinutes() })
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const popW = 248
      const popH = 430
      // 右缘放不下则整体左移;下方放不下则翻转到输入框上方
      const left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8))
      const top = r.bottom + 6 + popH > window.innerHeight - 8 ? Math.max(8, r.top - popH - 6) : r.bottom + 6
      setPos({ left, top })
    }
    setOpen(true)
  }

  // 点击弹层/输入框以外区域或按 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 打开时把已选时/分滚动到可视区中部
  useEffect(() => {
    if (!open) return
    const scs = popRef.current?.querySelectorAll<HTMLDivElement>('.sheet-dpop-time-scroll')
    scs?.forEach((sc) => {
      const sel = sc.querySelector<HTMLElement>('.is-selected')
      if (sel) sc.scrollTop = sel.offsetTop - sc.clientHeight / 2 + sel.clientHeight / 2
    })
  }, [open])

  // 42 格月历(周一起始,与原生日历一致),前后用相邻月份补齐
  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7 // 周一=0
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(view.y, view.m, 1 - firstDow + i))
  }
  const todayKey = keyOf(new Date())
  const selKey = sel.date ? keyOf(sel.date) : ''

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="sheet-dpop-input"
        onClick={onLocked ? onLocked : openPop}
        aria-label={ariaLabel}
        data-open={open || undefined}
      >
        <span className={value ? undefined : 'is-placeholder'}>
          {value ? formatDueShort(value) : '选择提醒时间'}
        </span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M10 6.6V10l2.4 1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            className="sheet-dpop"
            ref={popRef}
            style={{ left: pos.left, top: pos.top }}
            role="dialog"
            aria-label="选择提醒时间"
          >
            <div className="sheet-dpop-head">
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { ...v, m: v.m - 1 }))}
                aria-label="上一月"
              >
                ‹
              </button>
              <span className="sheet-dpop-title">
                {view.y}年{view.m + 1}月
              </span>
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { ...v, m: v.m + 1 }))}
                aria-label="下一月"
              >
                ›
              </button>
            </div>
            <div className="sheet-dpop-grid">
              {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                <span key={w} className="sheet-dpop-wd">
                  {w}
                </span>
              ))}
              {cells.map((d) => {
                const k = keyOf(d)
                const inMonth = d.getMonth() === view.m
                const selected = k === selKey
                return (
                  <button
                    key={k}
                    type="button"
                    className={[
                      'sheet-dpop-day',
                      inMonth ? '' : 'is-out',
                      k === todayKey ? 'is-today' : '',
                      selected ? 'is-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sel.hour, sel.minute, 0, 0)
                      setSel((s) => ({ ...s, date: next }))
                      emit(next, sel.hour, sel.minute)
                    }}
                  >
                    {d.getDate()}
                  </button>
                )
              })}
            </div>
            <div className="sheet-dpop-time">
              <div className="sheet-dpop-time-col">
                <span className="sheet-dpop-time-label">时</span>
                <div className="sheet-dpop-time-scroll">
                  {Array.from({ length: 24 }, (_, h) => (
                    <button
                      key={h}
                      type="button"
                      className={`sheet-dpop-time-item ${sel.date && sel.hour === h ? 'is-selected' : ''}`}
                      onClick={() => {
                        setSel((s) => ({ ...s, hour: h }))
                        if (sel.date) emit(sel.date, h, sel.minute)
                      }}
                    >
                      {String(h).padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sheet-dpop-time-col">
                <span className="sheet-dpop-time-label">分</span>
                <div className="sheet-dpop-time-scroll">
                  {Array.from({ length: 60 }, (_, m) => (
                    <button
                      key={m}
                      type="button"
                      className={`sheet-dpop-time-item ${sel.date && sel.minute === m ? 'is-selected' : ''}`}
                      onClick={() => {
                        setSel((s) => ({ ...s, minute: m }))
                        if (sel.date) emit(sel.date, sel.hour, m)
                      }}
                    >
                      {String(m).padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          popPortalHost(),
        )}
    </>
  )
}

/** 底部弹窗:单个任务的设置(删除 / 置顶 / 提醒 / 截止日期) */
function TaskSettingsSheet({
  task,
  occurrenceKey,
  subRecurrence,
  onClose,
  onDeleteSeries,
  onDeleteOccurrence,
  onDeleteSubThis,
  onPinnedChange,
  onSetRemind,
  onSetDueRange,
  onLocked,
}: {
  task: Task
  /** 点击受限提醒入口时的回调(功能名),由父组件弹 toast 提示开通会员。 */
  onLocked?: (feature: string) => void
  /** 重复事项的某个发生日(YYYY-MM-DD);来自具体某次实例时传入,用于「仅删除该日期」。 */
  occurrenceKey?: string | null
  /** 父级是重复模板时非空:表示这是重复事项的子任务,删除时需确认范围。 */
  subRecurrence?: Recurrence | null
  onClose: () => void
  onDeleteSeries: () => void
  onDeleteOccurrence: (dateKey: string) => void
  /** 仅本次隐藏该子任务(写入子任务 deletedDates,不影响其他发生日)。 */
  onDeleteSubThis: () => void
  onPinnedChange: (value: boolean) => void
  onSetRemind: (iso: string | null) => void
  onSetDueRange: (dueIso: string | null, endIso: string | null) => void
}) {
  const { closing, requestClose } = useSheetClose(onClose)
  // 会员闸门:受限用户不能新增/修改提醒(已有提醒仍可清除,历史数据保留)。
  const { fullAccess } = useAccount()
  // 删除确认:重复事项的某次实例点删除时,询问「仅删该日期」还是「删整组」;
  // 重复事项的子任务点删除时,询问「仅本次不显示」还是「删所有重复日」。
  const [confirmScope, setConfirmScope] = useState<'series' | 'subtask' | null>(null)
  const isSeriesInstance = Boolean(task.recurrence) && Boolean(occurrenceKey)
  const isSeriesSubtask = Boolean(subRecurrence) && Boolean(occurrenceKey)
  // 重复事项的某次实例:显示该发生日实际生效的提醒时间
  // (单日例外优先,否则该发生日自己的日期 + 系列默认时刻),不用模板上的陈旧绝对值。
  const seriesRemindAt =
    isSeriesInstance && task.recurrence && occurrenceKey
      ? occurrenceRemindAt(task.recurrence, occurrenceKey)
      : null
  // 重复事项的快捷提醒直接落在发生日当天(写入系列默认时刻),快捷按钮文案随之调整。
  const quickSeriesAt = (hour: number) =>
    `${occurrenceKey}T${String(hour).padStart(2, '0')}:00:00`
  // 提示里展示的当前生效时刻(本地时分);无提醒时待用户选择后再定。
  const seriesRemindTimeText = seriesRemindAt
    ? (() => {
        const d = new Date(seriesRemindAt)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      })()
    : '所选时刻'
  const occurrenceLabel = occurrenceKey
    ? `${occurrenceKey.slice(5)} ${WEEKDAY_CN[parseDayKey(occurrenceKey).getDay()]}`
    : ''
  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="任务设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{task.title}</div>
        <div className="sheet-section">提醒</div>
        {isSeriesInstance ? (
          <div className="sheet-hint" style={{ marginTop: 0 }}>
            将对所有重复日生效:每个发生日都在「自己的日期 + {seriesRemindTimeText}」提醒
          </div>
        ) : null}
        <SheetDateTimePicker
          ariaLabel="提醒时间"
          value={(seriesRemindAt ?? task.remindAt) ?? ''}
          onLocked={fullAccess ? undefined : () => onLocked?.('设置待办提醒')}
          onChange={(v) => onSetRemind(v)}
        />
        <div className="date-picker-quick">
          {isSeriesInstance ? (
            <>
              <button
                type="button"
                onClick={() =>
                  fullAccess ? onSetRemind(quickSeriesAt(20)) : onLocked?.('设置待办提醒')
                }
              >
                当天 20:00
              </button>
              <button
                type="button"
                onClick={() =>
                  fullAccess ? onSetRemind(quickSeriesAt(9)) : onLocked?.('设置待办提醒')
                }
              >
                当天 09:00
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() =>
                  fullAccess ? onSetRemind(atHourOffset(0, 20)) : onLocked?.('设置待办提醒')
                }
              >
                今晚 20:00
              </button>
              <button
                type="button"
                onClick={() =>
                  fullAccess ? onSetRemind(atHourOffset(1, 9)) : onLocked?.('设置待办提醒')
                }
              >
                明早 09:00
              </button>
            </>
          )}
          <button type="button" className="is-danger" onClick={() => onSetRemind(null)}>
            清除
          </button>
        </div>
        {fullAccess ? null : (
          <div className="sheet-hint">设置待办提醒为会员功能,开通后可设置;已有提醒可清除</div>
        )}
        <div className="sheet-section">处理日期</div>
        <div className="sheet-date-row">
          <SheetDatePicker
            ariaLabel="开始日期"
            value={task.dueDate ? dayKeyOfIso(task.dueDate) ?? '' : ''}
            onChange={(v) => {
              if (!v) {
                onSetDueRange(null, null)
                return
              }
              const startIso = new Date(`${v}T00:01:00`).toISOString()
              // 结束日缺省与开始日同日;已有结束日且不早于新开始日则保留
              const endVal = task.dueEndDate ? dayKeyOfIso(task.dueEndDate) ?? '' : ''
              const effEnd = endVal && endVal >= v ? endVal : v
              onSetDueRange(startIso, new Date(`${effEnd}T23:59:00`).toISOString())
            }}
          />
          <span className="sheet-date-sep" aria-hidden="true">至</span>
          <SheetDatePicker
            ariaLabel="结束日期"
            value={
              task.dueEndDate
                ? dayKeyOfIso(task.dueEndDate) ?? ''
                : task.dueDate
                  ? dayKeyOfIso(task.dueDate) ?? ''
                  : ''
            }
            min={task.dueDate ? dayKeyOfIso(task.dueDate) ?? undefined : undefined}
            onChange={(v) => {
              if (!v) {
                onSetDueRange(task.dueDate, null)
                return
              }
              // 尚无开始日时,结束日同时作为开始日(默认同一天)
              const startVal = task.dueDate ? dayKeyOfIso(task.dueDate) ?? v : v
              const effEnd = v >= startVal ? v : startVal
              onSetDueRange(
                new Date(`${startVal}T00:01:00`).toISOString(),
                new Date(`${effEnd}T23:59:00`).toISOString(),
              )
            }}
          />
        </div>
        <div className="date-picker-quick">
          <button type="button" onClick={() => onSetDueRange(startOfDayOffset(0), endOfDayOffset(0))}>今天</button>
          <button type="button" onClick={() => onSetDueRange(startOfDayOffset(1), endOfDayOffset(1))}>明天</button>
          <button type="button" onClick={() => onSetDueRange(startOfDayOffset(7), endOfDayOffset(7))}>一周后</button>
          <button type="button" className="is-danger" onClick={() => onSetDueRange(null, null)}>
            清除
          </button>
        </div>
        <div className="sheet-hint">起止日期区间内的每天都显示该事项;今天没做完,把结束日改到明天即可顺延</div>
        <label className="toggle-setting sheet-toggle">
          <span>
            <strong>置顶显示</strong>
          </span>
          <input
            type="checkbox"
            checked={task.isPinned}
            onChange={(e) => onPinnedChange(e.target.checked)}
          />
          <em aria-hidden="true" />
        </label>
        <button
          type="button"
          className="sheet-danger"
          onClick={() => {
            if (isSeriesInstance) setConfirmScope('series')
            else if (isSeriesSubtask) setConfirmScope('subtask')
            else onDeleteSeries()
          }}
        >
          删除事项
        </button>
        <div className="sheet-actions">
          <button type="button" onClick={requestClose}>
            关闭
          </button>
        </div>
      </div>

      {confirmScope && (
        <div
          className="sheet-backdrop is-confirm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmScope(null)
          }}
        >
          <div
            className="sheet confirm-sheet"
            role="dialog"
            aria-label={confirmScope === 'subtask' ? '删除子任务' : '删除重复事项'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-grip" aria-hidden="true" />
            <div className="sheet-title">
              {confirmScope === 'subtask' ? '删除子任务' : '删除重复事项'}
            </div>
            <p className="confirm-desc">
              {confirmScope === 'subtask'
                ? '该子任务属于重复事项,请选择本次删除的范围:'
                : '该事项在多个日期重复出现,请选择本次删除的范围:'}
            </p>
            {confirmScope === 'subtask' ? (
              <>
                <button type="button" className="sheet-danger" onClick={onDeleteSubThis}>
                  仅本次（{occurrenceLabel}）不显示该子任务
                </button>
                <button type="button" className="sheet-danger is-strong" onClick={onDeleteSeries}>
                  删除所有重复日的该子任务
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="sheet-danger"
                  onClick={() => onDeleteOccurrence(occurrenceKey as string)}
                >
                  仅删除 {occurrenceLabel} 的这一条
                </button>
                <button type="button" className="sheet-danger is-strong" onClick={onDeleteSeries}>
                  删除全部日期的该重复事项
                </button>
              </>
            )}
            <div className="sheet-actions">
              <button type="button" onClick={() => setConfirmScope(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 底部弹窗的关闭动画:点背景/取消时先播 180ms 下滑动画再真正卸载。
 * 各 sheet 组件共用;`closing` 用于给 backdrop 和 sheet 附加 is-closing 类。
 */
function useSheetClose(onClose: () => void) {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, 190)
  }, [onClose])
  return { closing, requestClose }
}

/** 联系客服底部弹窗:tab1 问题反馈 / tab2 需求提报,提交到后台「用户反馈」。
 *  由父组件条件渲染(关即卸载),与 AddTaskSheet 等弹窗同模式——
 *  不能做成 open 常驻组件:useSheetClose 的 closingRef 关闭后不复位,
 *  复用实例会让下次打开带着 is-closing 遮罩盖死整页。 */
function SupportSheet({ onClose, onOpenHistory }: { onClose: () => void; onOpenHistory: () => void }) {
  const { closing, requestClose } = useSheetClose(onClose)
  const [tab, setTab] = useState<'issue' | 'demand'>('issue')
  const [text, setText] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [unread, setUnread] = useState(false)

  // 进入弹窗即拉取本人历史,计算是否存在未读平台回复(仅登录用户有意义)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const items = await fetchFeedbackHistory()
        if (alive) setUnread(items.some((f) => f.unread))
      } catch {
        /* 忽略:未登录或网络异常不显示红点 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const submit = () => {
    const content = text.trim()
    if (!content) {
      setStatus({ ok: false, text: '请先填写内容' })
      return
    }
    setSubmitting(true)
    setStatus(null)
    void (async () => {
      try {
        await submitFeedback(tab, content, contact.trim() || undefined)
        setStatus({ ok: true, text: '已提交,感谢你的反馈!' })
        setUnread(false)
        window.setTimeout(() => {
          requestClose()
        }, 900)
      } catch (e) {
        setSubmitting(false)
        setStatus({ ok: false, text: e instanceof Error ? e.message : '提交失败,请稍后再试' })
      }
    })()
  }

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="联系客服"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">联系客服</div>
        <div className="fb-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'issue'}
            className={tab === 'issue' ? 'is-active' : ''}
            onClick={() => setTab('issue')}
          >
            问题反馈
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'demand'}
            className={tab === 'demand' ? 'is-active' : ''}
            onClick={() => setTab('demand')}
          >
            需求提报
          </button>
        </div>
        {/* 字数上限固定显示在文本框右下角(overlay,不占独立行) */}
        <div className="fb-textarea-wrap">
          <textarea
            className="fb-textarea"
            placeholder={
              tab === 'issue'
                ? '请描述你遇到的问题,例如:同步失败、提醒不生效、界面显示异常…'
                : '说出你想要的功能,例如:待办导出、日历订阅、数据统计…'
            }
            rows={5}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={submitting}
          />
          <span className="fb-count">{text.length}/1000</span>
        </div>
        <input
          className="fb-contact"
          type="text"
          placeholder="请填写你的微信,以便详细沟通(选填)"
          maxLength={60}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          disabled={submitting}
        />
        {status ? (
          <div className={`fb-status ${status.ok ? 'is-ok' : 'is-err'}`} aria-live="polite">
            {status.text}
          </div>
        ) : null}
        {/* 提交与历史记录同一行,宽度比 历史:提交 = 1:3 */}
        <div className="fb-foot">
          <button type="button" className="fb-history-btn" onClick={onOpenHistory}>
            <History size={14} />
            历史记录
            {unread ? <span className="fb-dot" aria-label="有未读回复" /> : null}
          </button>
          <button type="button" className="fb-submit" onClick={submit} disabled={submitting}>
            {submitting ? '提交中…' : '提交'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 本人反馈历史的本地缓存键:打开历史记录弹窗时先画缓存,云端静默刷新。 */
const FBH_CACHE_KEY = 'ticktask.fbHistory.v1'

function readFbHistoryCache(): FeedbackItem[] | null {
  try {
    const raw = localStorage.getItem(FBH_CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return null
    return data.filter(
      (x): x is FeedbackItem =>
        !!x && typeof x === 'object' && typeof (x as FeedbackItem).id === 'number' && Array.isArray((x as FeedbackItem).replies),
    )
  } catch {
    return null
  }
}

/** 历史记录弹窗:展示本人提交的问题反馈与需求提报,以及平台回复与已读状态。
 *  缓存优先渲染(无「加载中」闪烁),云端静默刷新;回复默认收起只显示 1 条。 */
function SupportHistorySheet({ onClose }: { onClose: () => void }) {
  const { closing, requestClose } = useSheetClose(onClose)
  const [items, setItems] = useState<FeedbackItem[] | null>(() => readFbHistoryCache())
  const [err, setErr] = useState<string | null>(null)
  // 记录挂载时是否有缓存(决定失败时是否展示错误,有缓存则静默)
  const hasCacheRef = useRef(items !== null)
  // 展开/收起:记录已展开的反馈 id,默认全部收起(只显示第 1 条回复)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const data = await fetchFeedbackHistory()
        if (!alive) return
        setItems(data)
        // 刷新本地缓存(打开即视为已读,缓存中不再保留未读标记)
        try {
          localStorage.setItem(FBH_CACHE_KEY, JSON.stringify(data.map((f) => ({ ...f, unread: false }))))
        } catch {
          /* 存储异常忽略 */
        }
        // 打开即视为已读,清除红点
        await markFeedbackRead()
      } catch (e) {
        if (alive && !hasCacheRef.current) setErr(e instanceof Error ? e.message : '加载失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const statusLabel = (s: FeedbackItem['status']) =>
    s === 'done' ? '已处理' : s === 'replied' ? '已回复' : '待反馈'

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="历史记录"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">历史记录</div>
        <div className="fbh-body">
          {items === null && !err ? (
            <div className="fbh-loading">加载中…</div>
          ) : err ? (
            <div className="fbh-empty">{err}</div>
          ) : (items ?? []).length === 0 ? (
            <div className="fbh-empty">暂无反馈记录</div>
          ) : (
            (items ?? []).map((f) => {
              const isExpanded = expanded.has(f.id)
              const shownReplies = isExpanded ? f.replies : f.replies.slice(0, 1)
              return (
                <div className={`fbh-item ${f.unread ? 'is-unread' : ''}`} key={f.id}>
                  <div className="fbh-head">
                    <span className={`fbh-kind ${f.kind === 'demand' ? 'is-demand' : ''}`}>
                      {f.kind === 'demand' ? '需求提报' : '问题反馈'}
                    </span>
                    <span className={`fbh-status fbh-status-${f.status}`}>{statusLabel(f.status)}</span>
                    <span className="fbh-time">{fmtTimeShort(f.created_at)}</span>
                  </div>
                  <div className="fbh-content">{f.content}</div>
                  {f.replies.length > 0 ? (
                    <div className="fbh-replies">
                      {shownReplies.map((r) => (
                        <div className="fbh-reply" key={r.id}>
                          <div className="fbh-reply-head">
                            <span className="fbh-reply-tag">平台回复</span>
                            <span className="fbh-reply-time">{fmtTimeShort(r.created_at)}</span>
                          </div>
                          <div className="fbh-reply-body">{r.body}</div>
                        </div>
                      ))}
                      {f.replies.length > 1 ? (
                        <button type="button" className="fbh-toggle" onClick={() => toggleExpand(f.id)}>
                          {isExpanded ? '收起' : `展开全部 ${f.replies.length} 条回复`}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** 版本记录列表弹窗:从下载站 `/api/releases` 拉取历史版本,每张卡片含
 *  「版本号 + 发布日期 + 标题」,点击卡片再叠一层详情弹窗。
 *  同 SupportHistorySheet:缓存优先避免加载闪烁,网络失败且无缓存才提示错误。 */
function ChangelogSheet({
  onClose,
  onOpenDetail,
}: {
  onClose: () => void
  onOpenDetail: (r: ReleaseRecord) => void
}) {
  const { closing, requestClose } = useSheetClose(onClose)
  const [list, setList] = useState<ReleaseRecord[] | null>(() => readReleaseCache())
  const [err, setErr] = useState<string | null>(null)
  // 挂载时是否有缓存:有缓存则网络失败也静默,不打扰用户。
  const hasCacheRef = useRef(list !== null)
  const [current, setCurrent] = useState('')

  useEffect(() => {
    let alive = true
    void currentAppVersion().then((v) => {
      if (alive) setCurrent(v)
    })
    void (async () => {
      try {
        const data = await fetchReleases()
        if (alive) setList(data)
      } catch (e) {
        if (alive && !hasCacheRef.current) {
          setErr(e instanceof Error ? e.message : '加载失败')
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const rows = list ?? []

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label="版本记录"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">版本记录</div>
        <div className="cl-body">
          {rows.length === 0 && !err ? (
            <div className="cl-empty">加载中…</div>
          ) : err ? (
            <div className="cl-empty">{err}</div>
          ) : rows.length === 0 ? (
            <div className="cl-empty">暂无版本记录</div>
          ) : (
            rows.map((r) => {
              const isCurrent = !!current && r.version === current
              return (
                <button
                  type="button"
                  className={`cl-card ${isCurrent ? 'is-current' : ''}`}
                  key={r.version}
                  onClick={() => onOpenDetail(r)}
                >
                  <div className="cl-card-head">
                    <span className="cl-version">v{r.version}</span>
                    {isCurrent ? <span className="cl-current-tag">当前版本</span> : null}
                    <span className="cl-date">{r.release_date || '—'}</span>
                  </div>
                  <div className="cl-title">{r.title || '版本更新'}</div>
                  {r.items.length > 0 ? (
                    <div className="cl-count">{r.items.length} 项更新</div>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** 版本详情弹窗:单条版本记录的完整更新项列表。数据来自列表弹窗,不再二次请求。 */
function ChangelogDetailSheet({ item, onClose }: { item: ReleaseRecord; onClose: () => void }) {
  const { closing, requestClose } = useSheetClose(onClose)

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label={`版本 ${item.version} 详情`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">版本详情</div>
        <div className="cl-body">
          <div className="cl-detail-head">
            <span className="cl-version is-lg">v{item.version}</span>
            <span className="cl-date">{item.release_date || '—'}</span>
          </div>
          <div className="cl-detail-title">{item.title || '版本更新'}</div>
          {item.items.length > 0 ? (
            <ul className="cl-items">
              {item.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          ) : (
            <div className="cl-empty">暂无更新说明</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 生日/纪念日分组:可展开收起的标题 + 列表。 */
function OccasionGroup({
  title,
  icon,
  items,
  collapsed,
  onToggle,
  onOpen,
  emptyText,
  summary,
}: {
  title: string
  icon: ReactNode
  items: Birthday[]
  collapsed: boolean
  onToggle: () => void
  onOpen: (id: string) => void
  emptyText: string
  summary: string | null
}) {
  return (
    <section className="occasion-group">
      <button
        type="button"
        className="occasion-group-header"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="occasion-group-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="occasion-group-title">{title}</span>
        <span className="occasion-group-count">{items.length}</span>
        <ChevronDown
          size={14}
          className={`occasion-group-chevron ${collapsed ? 'is-collapsed' : ''}`}
          aria-hidden="true"
        />
      </button>
      {!collapsed && (
        <div className="occasion-group-body">
          {summary && <div className="birthday-summary">{summary}</div>}
          {items.length === 0 ? (
            <div className="tree-empty">{emptyText}</div>
          ) : (
            <div className="birthday-list list-anim">
              {items.map((b) => (
                <OccasionRow key={b.id} item={b} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** 单条生日/纪念日行。 */
function OccasionRow({ item, onOpen }: { item: Birthday; onOpen: (id: string) => void }) {
  const days = daysUntilBirthday(item.calendar, item.month, item.day, item.isLeapMonth)
  const next = nextBirthdayDate(item.calendar, item.month, item.day, item.isLeapMonth)
  const dateText =
    item.calendar === 'lunar'
      ? `农历${formatLunar(item.month, item.day, item.isLeapMonth)}`
      : `${item.month} 月 ${item.day} 日`
  const isToday = days === 0
  const isSoon = days !== null && days > 0 && days <= 7
  const avatarSrc = AVATARS[item.avatar ?? '']

  return (
    <div
      className={`birthday-row ${isToday ? 'is-today' : ''}`}
      onClick={() => onOpen(item.id)}
    >
      <div className="birthday-avatar" aria-hidden="true">
        {avatarSrc ? (
          <img src={avatarSrc} alt="" draggable={false} />
        ) : (
          item.name.trim().slice(0, 1) || '?'
        )}
      </div>
      <div className="birthday-main">
        <div className="birthday-name-line">
          <span className="birthday-name">{item.name || '未命名'}</span>
          {item.relation && <span className="birthday-relation">{item.relation}</span>}
          {item.remindEnabled ? (
            <span className="birthday-bell" title="已开启年度提醒">
              🔔
            </span>
          ) : null}
        </div>
        <div className="birthday-sub">
          <span>{dateText}</span>
          <span className="birthday-dot">·</span>
          <span>
            {next
              ? `${next.getMonth() + 1}/${next.getDate()} 周${CN_WEEKDAY_SHORT[next.getDay()]}`
              : '—'}
          </span>
          <span className="birthday-dot">·</span>
          <span className="birthday-calendar-tag">
            {item.calendar === 'lunar' ? '农历' : '公历'}
          </span>
        </div>
      </div>
      <div className={`birthday-countdown ${isToday ? 'is-today' : isSoon ? 'is-soon' : ''}`}>
        <span className="birthday-countdown-value">{countdownLabel(days)}</span>
        {days !== null && days > 1 && (
          <span className="birthday-countdown-unit">{days} 天</span>
        )}
      </div>
    </div>
  )
}

/**
 * 底部弹窗:新增/编辑一条生日或纪念日记录。
 * `createKind` 只在新建时生效,决定弹窗表单形态(生日带头像/关系,纪念日不带)。
 */
function BirthdaySheet({
  birthday,
  createKind = 'birthday',
  onClose,
  onSubmit,
  onDelete,
}: {
  birthday: Birthday | null
  createKind?: OccasionKind
  onClose: () => void
  onSubmit: (draft: Partial<Birthday>) => void
  onDelete?: () => void
}) {
  const { closing, requestClose } = useSheetClose(onClose)
  const kind = birthday?.kind ?? createKind
  const isBirthday = kind === 'birthday'
  const isEdit = Boolean(birthday)
  const title = isEdit
    ? isBirthday
      ? '编辑生日'
      : '编辑纪念日'
    : isBirthday
      ? '添加生日'
      : '添加纪念日'

  const [name, setName] = useState(birthday?.name ?? '')
  const [relation, setRelation] = useState(birthday?.relation ?? '')
  const [avatar, setAvatar] = useState(birthday?.avatar ?? 'a1')
  const [calendar, setCalendar] = useState<CalendarKind>(birthday?.calendar ?? 'solar')
  const [month, setMonth] = useState(birthday?.month ?? 1)
  const [day, setDay] = useState(birthday?.day ?? 1)
  const [isLeapMonth, setIsLeapMonth] = useState(birthday?.isLeapMonth ?? false)
  const [remindEnabled, setRemindEnabled] = useState(birthday?.remindEnabled ?? true)
  const [remindHour, setRemindHour] = useState(birthday?.remindHour ?? 9)
  const [remindMinute, setRemindMinute] = useState(birthday?.remindMinute ?? 0)
  const [remindDaysBefore, setRemindDaysBefore] = useState(birthday?.remindDaysBefore ?? 0)
  const [note, setNote] = useState(birthday?.note ?? '')

  const maxDay = calendar === 'lunar' ? 30 : new Date(2024, month, 0).getDate()
  // 切换月份/历法后,原来的「日」可能越界(如 31 日切到 2 月),这里做一次收敛
  useEffect(() => {
    if (day > maxDay) setDay(maxDay)
  }, [day, maxDay])

  // 修复:闰月开关不再依赖「今年是否有闰月」。闰月只在部分年份出现,
  // 勾选后无闰月的年份自动按平月换算(lunarInSolarYear 已处理该回退),
  // 因此农历下始终可勾选,避免「今年没有闰X月就永远打不开」的问题。

  const preview = useMemo(() => {
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null
    const next = nextBirthdayDate(calendar, month, day, isLeapMonth)
    if (!next) return null
    const days = daysUntilBirthday(calendar, month, day, isLeapMonth)
    const solarText = `${next.getFullYear()} 年 ${next.getMonth() + 1} 月 ${next.getDate()} 日 周${CN_WEEKDAY_SHORT[next.getDay()]}`
    const lunarText =
      calendar === 'lunar' ? `农历${formatLunar(month, day, isLeapMonth)}` : `公历 ${month} 月 ${day} 日`
    return { solarText, lunarText, days }
  }, [calendar, month, day, isLeapMonth])

  const submit = () => {
    if (!name.trim()) return
    onSubmit({
      name: name.trim(),
      kind,
      relation: relation.trim(),
      avatar: isBirthday ? avatar : '',
      calendar,
      month,
      day,
      isLeapMonth: calendar === 'lunar' ? isLeapMonth : false,
      remindEnabled,
      remindHour,
      remindMinute,
      remindDaysBefore,
      note: note.trim(),
    })
  }

  return (
    <div
      className={`sheet-backdrop ${closing ? 'is-closing' : ''}`}
      onClick={requestClose}
    >
      <div
        className={`sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{title}</div>
        <div className="sheet-subtitle">
          {preview
            ? `${preview.lunarText} → ${preview.solarText}${
                preview.days === 0
                  ? ' · 就是今天'
                  : preview.days === 1
                    ? ' · 明天'
                    : ` · 还有 ${preview.days} 天`
              }`
            : isBirthday
              ? '请填写名称与生日日期'
              : '请填写纪念日名称与日期'}
        </div>

        <div className="sheet-section">{isBirthday ? '名称' : '纪念日名称'}</div>
        <input
          className="sheet-field"
          placeholder={isBirthday ? '好友或家人的名字' : '如:结婚纪念日、相识纪念日'}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />

        {isBirthday && (
          <>
            <div className="sheet-section">头像</div>
            <div className="avatar-picker" role="radiogroup" aria-label="选择头像">
              {AVATAR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={avatar === key}
                  className={`avatar-option ${avatar === key ? 'is-active' : ''}`}
                  onClick={() => setAvatar(key)}
                >
                  <img src={AVATARS[key]} alt="" draggable={false} />
                </button>
              ))}
            </div>

            <div className="sheet-section">关系（可选）</div>
            <div className="date-picker-quick">
              {['本人', '家人', '好友', '同事', '同学'].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={relation === r ? 'is-active' : ''}
                  onClick={() => setRelation(relation === r ? '' : r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="sheet-section">历法</div>
        <div className="date-picker-quick">
          <button
            type="button"
            className={calendar === 'solar' ? 'is-active' : ''}
            onClick={() => setCalendar('solar')}
          >
            公历
          </button>
          <button
            type="button"
            className={calendar === 'lunar' ? 'is-active' : ''}
            onClick={() => setCalendar('lunar')}
          >
            农历
          </button>
        </div>

        <div className="sheet-section">日期</div>
        <div className="birthday-picker">
          <label className="birthday-picker-field">
            <span>月</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {calendar === 'lunar' ? CN_MONTHS[m - 1] : `${m} 月`}
                </option>
              ))}
            </select>
          </label>
          <label className="birthday-picker-field">
            <span>日</span>
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {calendar === 'lunar' ? CN_DAYS[d - 1] : `${d} 日`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {calendar === 'lunar' && (
          <label className="toggle-setting sheet-toggle">
            <span>
              <strong>按闰月计</strong>
              <small>
                {leapMonth(new Date().getFullYear()) === month
                  ? `今年确有闰${CN_MONTHS[month - 1]}，将按闰月换算`
                  : `无闰月的年份自动按平月换算`}
              </small>
            </span>
            <input
              type="checkbox"
              checked={isLeapMonth}
              onChange={(e) => setIsLeapMonth(e.target.checked)}
            />
            <em aria-hidden="true" />
          </label>
        )}

        <div className="sheet-section">年度提醒</div>
        <label className="toggle-setting sheet-toggle">
          <span>
            <strong>开启提醒</strong>
            <small>每年到这一天自动提醒</small>
          </span>
          <input
            type="checkbox"
            checked={remindEnabled}
            onChange={(e) => setRemindEnabled(e.target.checked)}
          />
          <em aria-hidden="true" />
        </label>

        {remindEnabled && (
          <>
            <div className="birthday-picker">
              <label className="birthday-picker-field">
                <span>时</span>
                <select value={remindHour} onChange={(e) => setRemindHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                    <option key={h} value={h}>{`${pad2(h)} 时`}</option>
                  ))}
                </select>
              </label>
              <label className="birthday-picker-field">
                <span>分</span>
                <select
                  value={remindMinute}
                  onChange={(e) => setRemindMinute(Number(e.target.value))}
                >
                  {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                    <option key={m} value={m}>{`${pad2(m)} 分`}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="date-picker-quick">
              {[0, 1, 3, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={remindDaysBefore === d ? 'is-active' : ''}
                  onClick={() => setRemindDaysBefore(d)}
                >
                  {d === 0 ? '当天提醒' : `提前 ${d} 天`}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="sheet-section">备注（可选）</div>
        <input
          className="sheet-field"
          placeholder={isBirthday ? '想送什么、喜欢什么…' : '这一天的意义、想怎么过…'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {onDelete && (
          <button type="button" className="sheet-danger" onClick={onDelete}>
            删除记录
          </button>
        )}

        <div className="sheet-actions">
          <button type="button" onClick={requestClose}>
            取消
          </button>
          <button type="button" className="is-primary" disabled={!name.trim()} onClick={submit}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 未登录引导弹窗:受限功能点击时,未登录用户先看到「去登录」引导,点按才打开登录弹窗。
// 已登录但非会员(试用过期)不走这里,由 handleLocked 直接弹会员提示 toast。
// ---------------------------------------------------------------------------
/** 首页更新提示弹窗:每个新版本最多弹一次(去重在 App 根完成)。
 *  内容来自后台版本记录里精确匹配最新版本的一条;后台漏录时回退 version.json.notes。
 *  跨版本升级只列最新版更新项,中间版本给一行提示,完整记录可在弹窗内展开,
 *  这样不依赖设置页的版本记录弹窗是否已挂载。 */
function UpdateNoticeSheet({
  notice,
  currentVersion,
  update,
  onClose,
  onInstall,
}: {
  notice: UpdateNotice
  currentVersion: string
  update: UpdateState
  onClose: () => void
  onInstall: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  // 弹窗真正渲染成功才消耗「每版本最多一次」额度(幂等,StrictMode 双跑无副作用)。
  useEffect(() => {
    markUpdateShown(notice.version)
  }, [notice.version])
  const busy = update.status === 'downloading' || update.status === 'installing'
  const items = notice.items.slice(0, 5)
  const extraCount = notice.items.length - items.length
  const missed = notice.missed
  // ⚠️ missed 为空(当前版本正好是上一版,没有跳过的中间版本)时不能取
  // missed[-1],否则抛 "Cannot read properties of undefined (reading 'version')",
  // 顶层 ErrorBoundary 会把整个主界面换成错误页(0.4.62/0.4.63 的实际故障)。
  const missedLabel =
    missed.length === 0
      ? ''
      : missed.length === 1
        ? `v${missed[0].version}`
        : `v${missed[missed.length - 1].version} ~ v${missed[0].version}`
  const allNew = notice.releases
    .filter((r) => isNewerVersion(r.version, currentVersion))
    .sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : 1))

  return (
    <div
      className="account-modal-overlay update-notice-overlay"
      onClick={busy ? undefined : onClose}
      role="presentation"
    >
      <div
        className="account-modal update-notice"
        role="dialog"
        aria-modal="true"
        aria-label="发现新版本"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-modal-head">
          <strong>发现新版本 v{notice.version}</strong>
          <button
            type="button"
            className="account-modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="update-notice-body">
          <div className="update-notice-meta">
            <span>v{currentVersion || '—'} → v{notice.version}</span>
            {notice.date ? <span>{notice.date}</span> : null}
          </div>

          {showAll ? (
            <div className="update-notice-all">
              <button type="button" className="account-link" onClick={() => setShowAll(false)}>
                ← 返回新版本介绍
              </button>
              {allNew.length === 0 ? (
                <div className="cl-empty">暂无版本记录</div>
              ) : (
                allNew.map((r) => (
                  <div className="update-notice-group" key={r.version}>
                    <div className="update-notice-group-head">
                      <span className="cl-version">v{r.version}</span>
                      <span className="cl-date">{r.release_date || '—'}</span>
                    </div>
                    <div className="update-notice-group-title">{r.title || '版本更新'}</div>
                    {r.items.length > 0 ? (
                      <ul className="update-notice-list">
                        {r.items.map((t, i) => <li key={i}>{t}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              {notice.title ? <div className="update-notice-title">{notice.title}</div> : null}
              {items.length > 0 ? (
                <ul className="update-notice-list">
                  {items.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              ) : (
                <p className="update-notice-notes">
                  {notice.notes || '本次为稳定性优化与问题修复。'}
                </p>
              )}
              {extraCount > 0 ? (
                <div className="update-notice-extra">
                  还有 {extraCount} 项更新，可在完整版本记录中查看
                </div>
              ) : null}
              {missed.length > 0 ? (
                <div className="update-notice-missed">
                  期间还发布了 {missed.length} 个版本（{missedLabel}）
                </div>
              ) : null}
              <button
                type="button"
                className="account-link update-notice-all-link"
                onClick={() => setShowAll(true)}
              >
                查看完整版本记录 →
              </button>
            </>
          )}

          {update.status === 'error' ? (
            <div className="update-notice-error">{update.message}</div>
          ) : null}
          {update.status === 'installing' ? (
            <div className="update-notice-error is-ok">
              安装程序即将启动，Tacco 会先退出以完成覆盖安装；请在安装向导中点「安装」。
            </div>
          ) : null}
        </div>

        <div className="login-guide-actions">
          <button type="button" className="account-link" onClick={onClose} disabled={busy}>
            稍后再说
          </button>
          <button type="button" className="vip-buy-btn" onClick={onInstall} disabled={busy}>
            {update.status === 'downloading'
              ? '下载中…'
              : update.status === 'installing'
                ? '即将安装…'
                : '立即更新'}
          </button>
        </div>
      </div>
    </div>
  )
}

function LoginGuideSheet({
  open,
  onGoLogin,
  onClose,
}: {
  open: boolean
  onGoLogin: () => void
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="account-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="account-modal login-guide"
        role="dialog"
        aria-modal="true"
        aria-label="登录"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-modal-head">
          <strong>登录</strong>
          <button type="button" className="account-modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {/* ⚠️ 不再写「登录后即可使用 XX、解锁全部会员能力」:会员能力还要看账号
            是否在试用期 / 已激活,登录本身不构成可用承诺。 */}
        <div className="login-guide-body">
          <p>登录后可解锁更多功能的使用，支持数据同步云端</p>
        </div>
        <div className="login-guide-actions">
          <button type="button" className="account-link" onClick={onClose}>
            暂不
          </button>
          <button type="button" className="vip-buy-btn" onClick={onGoLogin}>
            去登录
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
