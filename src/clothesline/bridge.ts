/**
 * 晾衣绳 <-> Rust 桥接层。
 *
 * 隔离铁律（PRD §14.5 / 项目 MEMORY）：
 * - 只调 clothesline_* 命令，**绝不调 set_pref / 绝不写 prefs.json**（整文件覆盖竞态会丢主题/宽度/快捷键）。
 * - localStorage 键一律 `todobar.clothesline.*` 前缀，与既有键严格隔离（各窗共享 WebView2 数据目录）。
 * - 图片/数据落 `~/.ticktask/clothesline/`，由 Rust 原子写；前端只经命令读写，不碰主窗 shot-last。
 */
import { invoke } from '@tauri-apps/api/core'

/** 跨窗口事件名统一在此定义，主窗 / 绳窗 / 截图窗共用同一字符串。 */
export const CL_CARDS_CHANGED = 'clothesline-cards-changed'
export const CL_ORDER_CHANGED = 'clothesline-order-changed'
export const CL_CARD_DROPPED = 'clothesline-card-dropped'
export const CL_CARD_REMOVED = 'clothesline-card-removed'
/** 绳窗 → 主窗：打开原便利签 / 定位待办（主窗是这些数据的唯一写入方）。 */
export const CL_OPEN_NOTE = 'clothesline-open-note'
export const CL_OPEN_TASK = 'clothesline-open-task'
/** 绳窗 → 主窗：单条事项编辑（写回仍由主窗走 notes/store.ts，避免绳窗写 prefs.json）。 */
export const CL_EDIT_NOTE_ITEM = 'clothesline-edit-note-item'
/** 主窗配置页改了 6 项偏好后广播；绳窗据此本次会话内即时生效（无需重启）。 */
export const CL_SETTINGS_CHANGED = 'clothesline-settings-changed'

/** 与 src-tauri/src/clothesline.rs::ClotheslineSettings 字段一一对应。 */
export interface ClotheslineSettings {
  enabled: boolean
  auto_show_on_boot: boolean
  expanded: boolean
  monitor_stable_id: string
  wind_effect: boolean
  auto_fly_shot: boolean
  always_on_top: boolean
  anchor_y: number
  pulltab_x_ratio: number
}

/** 与 clothesline.rs::MonitorInfo 对应，全物理像素。 */
export interface MonitorInfo {
  stable_id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  scale_factor: number
  is_primary: boolean
}

/** 与 clothesline.rs::HitRect 对应，屏幕绝对物理坐标。 */
export interface HitRect {
  x: number
  y: number
  width: number
  height: number
}

/** 与 clothesline.rs::CardKind 对应。 */
export type CardKind =
  | 'note'
  | 'shot'
  | 'clipboard'
  | 'pin'
  | 'image'
  | 'task'
  | 'text'
  | 'timer'

/** 与 clothesline.rs::ClotheslineCard 对应。order 是唯一顺序真源。 */
export interface ClotheslineCard {
  id: string
  kind: CardKind
  order: number
  pinned: boolean
  attach_to: string | null
  note_id: string | null
  pin_id: string | null
  clip_id: string | null
  task_id: string | null
  text: string
  title: string
  src_path: string | null
  end_at: number | null
  elapsed_before_pause_ms: number
  timer_direction: string
  timer_elapsed_mode: string
  fired_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** 与 clothesline.rs::SessionState 对应。 */
export interface SessionState {
  scroll_x: number
  collapsed: boolean
  last_exit_at: number
  clean_exit: boolean
  geo_sig: string
  anchor_y: number
  pulltab_x_ratio: number
  monitor_stable_id: string
}

/** 与 clothesline.rs::RestoreState 对应，启动一次读齐。 */
export interface RestoreState {
  settings: ClotheslineSettings
  cards: ClotheslineCard[]
  session: SessionState
  monitors: MonitorInfo[]
  recovered_from_backup: boolean
  target_monitor_stable_id: string
  monitor_fallback: boolean
}

/** 增量更新：undefined = 不改；null = 清空（Rust 侧 Option<Option<T>> 接收）。 */
export interface CardPatch {
  title?: string
  text?: string
  src_path?: string | null
  end_at?: number | null
  elapsed_before_pause_ms?: number
  timer_direction?: string
  fired_at?: number | null
  pinned?: boolean
}

/** 新卡由前端生成稳定 id（Webview 支持 randomUUID），Rust 负责 order / 时间戳 / 配额。 */
export function clMakeCard(kind: CardKind, patch: Partial<ClotheslineCard> = {}): ClotheslineCard {
  const now = Date.now()
  return {
    id: patch.id ?? `cl-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    order: patch.order ?? 0,
    pinned: patch.pinned ?? false,
    attach_to: patch.attach_to ?? null,
    note_id: patch.note_id ?? null,
    pin_id: patch.pin_id ?? null,
    clip_id: patch.clip_id ?? null,
    task_id: patch.task_id ?? null,
    text: patch.text ?? '',
    title: patch.title ?? '',
    src_path: patch.src_path ?? null,
    end_at: patch.end_at ?? null,
    elapsed_before_pause_ms: patch.elapsed_before_pause_ms ?? 0,
    timer_direction: patch.timer_direction ?? 'countdown',
    timer_elapsed_mode: patch.timer_elapsed_mode ?? 'wallclock',
    fired_at: patch.fired_at ?? null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
}

export const clGetSettings = () => invoke<ClotheslineSettings>('clothesline_get_settings')

export const clSetEnabled = (enabled: boolean) =>
  invoke<void>('clothesline_set_enabled', { enabled })

export const clUpdateSettings = (patch: Partial<ClotheslineSettings>) =>
  invoke<ClotheslineSettings>('clothesline_update_settings', { patch })

export const clSetAlwaysOnTop = (on: boolean) =>
  invoke<void>('clothesline_set_always_on_top', { on })

/** 首帧就绪后：Rust 三连写物理矩形 → show。x/y/w/h 均为物理像素。 */
export const clApplyBoundsAndShow = (x: number, y: number, width: number, height: number) =>
  invoke<void>('clothesline_apply_bounds_and_show', { x, y, width, height })

/**
 * 上报可点矩形（屏幕绝对物理坐标）。空数组 = 展开态整窗可点。
 * ⚠️ 绝不能用 pointermove 写穿透布尔值——窗口穿透后收不到鼠标事件会永久锁死（R68）。
 */
export const clSetHitRects = (rects: HitRect[]) =>
  invoke<void>('clothesline_set_hit_rects', { rects })

/** 拖拽 / 编辑期间临时强制可点，durationMs 后自动过期，避免拖到一半穿透。 */
export const clSetForceClickable = (durationMs: number) =>
  invoke<void>('clothesline_set_force_clickable', { durationMs })

/** 截图会话级挂起 / 恢复（capture_screen 内部另有 RAII 自守卫兜底）。 */
export const clCaptureSuspend = () => invoke<void>('clothesline_capture_suspend')
export const clCaptureResume = () => invoke<void>('clothesline_capture_resume')

export const clGetMonitors = () => invoke<MonitorInfo[]>('clothesline_get_monitors')

/** 启动恢复：一次读齐 settings + cards(+bak) + session + monitors（只读，不写 cards.json）。 */
export const clGetRestoreState = () => invoke<RestoreState>('clothesline_get_restore_state')

/** 退出时写 session.json + 提交挂起的软删除。 */
export const clSaveSession = (session: SessionState) =>
  invoke<void>('clothesline_save_session', { session })

/** 拖动排序：一次 IPC + 一次原子写。Rust 校验 id 集合一致，否则拒绝（前端回滚）。 */
export const clReorderCards = (orderedIds: string[]) =>
  invoke<Array<[string, number]>>('clothesline_reorder_cards', { orderedIds })

/** 新增卡片。autoDropOldest 只给「截图自动飞入」用：满额时撕下最旧非置顶卡。 */
export const clAddCard = (card: ClotheslineCard, member: boolean, autoDropOldest = false) =>
  invoke<ClotheslineCard>('clothesline_add_card', { card, member, autoDropOldest })

/** 增量改卡片内容 / 置顶 / 计时；order 只归 clReorderCards 管。 */
export const clUpdateCard = (id: string, patch: CardPatch) =>
  invoke<ClotheslineCard>('clothesline_update_card', { id, patch })

/** 取下（软删除，10s 内可原位撤销）。 */
export const clRemoveCard = (id: string) =>
  invoke<void>('clothesline_remove_card', { id })

/** 撤销取下：保留原 order，回到原槽位。 */
export const clRestoreCard = (id: string) =>
  invoke<ClotheslineCard>('clothesline_restore_card', { id })

/** 缩略图落盘（前端先压到 ≤480px PNG）→ 返回绝对路径，只写 src_path，绝不进 localStorage。 */
export const clSavePreview = (id: string, pngDataUrl: string) =>
  invoke<string>('clothesline_save_preview', { id, dataUrl: pngDataUrl })

/** 读回缩略图 data URL（不用 asset://：未授权 asset scope 且会污染 canvas）。 */
export const clReadPreview = (id: string) =>
  invoke<string | null>('clothesline_read_preview', { id })

/** 只读卡片用量，配置页状态条显示「已挂 n/limit」。 */
export const clGetCardUsage = () => invoke<number>('clothesline_get_card_usage')
