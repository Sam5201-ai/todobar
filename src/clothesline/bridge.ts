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
/** 2026-11-15：绳窗 ＋ 菜单「晾衣绳设置」→ 主窗展开侧栏并打开晾衣绳设置页。 */
export const CL_OPEN_SETTINGS = 'clothesline-open-settings'
/** 绳窗 → 主窗：单条事项编辑（写回仍由主窗走 notes/store.ts，避免绳窗写 prefs.json）。 */
export const CL_EDIT_NOTE_ITEM = 'clothesline-edit-note-item'
/** 主窗配置页改了 6 项偏好后广播；绳窗据此本次会话内即时生效（无需重启）。 */
export const CL_SETTINGS_CHANGED = 'clothesline-settings-changed'
/** Rust 命中循环检测到「点在可点区外」→ 前端关闭右键/＋菜单（问题13）。 */
export const CL_DISMISS_OVERLAY = 'cl-dismiss-overlay'
/** 绳窗 → 主窗：便利签条目操作（toggle/add/remove/edit）。
 *  绳窗只读 localStorage 快照，所有写回一律由主窗 notes/store.ts 单一写方执行。 */
export const CL_NOTE_ITEM_ACTION = 'clothesline-note-item-action'
export type ClNoteItemAction =
  | { action: 'toggle'; noteId: string; itemId: string }
  | { action: 'add'; noteId: string; text: string }
  | { action: 'remove'; noteId: string; itemId: string }
  | { action: 'edit'; noteId: string; itemId: string; text: string }
  | { action: 'totask'; noteId: string; text: string }
/** 绳窗 ＋ 菜单「新建便利签」→ 主窗创建便利签数据（不开桌面窗）并直接挂上晾衣绳。 */
export const CL_CREATE_NOTE = 'clothesline-create-note'
/** 便利签窗口 → 绳窗：拖整张便利签到绳上（用户把便利签窗口拖到桌面顶部释放）。 */
export const CL_DROP_NOTE_WINDOW = 'clothesline-drop-note-window'
export type ClDropNoteWindow = { noteId: string; text: string }
/** 绳窗 → 主窗：卡片已成功挂到绳上，请隐藏桌面上那张便利签（数据保留，仅收起）。 */
export const CL_NOTE_HUNG = 'clothesline-note-hung'
export type ClNoteHung = { noteId: string }
/** 绳窗 → 主窗：切换绳上便利签的颜色（与桌面便利签共用 NOTE_COLORS 色板）。 */
export const CL_NOTE_COLOR_ACTION = 'clothesline-note-color-action'
export type ClNoteColorAction = { noteId: string; colorKey: string }

/** 绳窗/便签窗 → 主窗：归档绳上卡（主窗编排「一体归档」：便利签卡同时 archiveNote）。
 *  archive：noteId/cardId 至少一个；主窗 archiveNote + clArchiveCard（cardId 缺省时反查）。
 *  delete-note：永久删除——removeNote(noteId) + 删除活跃绳卡(cardId) + 清理归档残留。 */
export const CL_ARCHIVE_CARD = 'clothesline-archive-card'
export type ClArchiveCard = {
  action: 'archive' | 'delete-note'
  cardId?: string
  noteId?: string
}
/** 绳窗 ＋ 菜单「归档」→ 主窗唤起并打开归档页。 */
export const CL_OPEN_ARCHIVE = 'clothesline-open-archive'

/** ★批14 主窗 → 绳窗：操作结果 toast（绳上便利签「加入待办」等）。
 *  写方在主窗（单一写方红线），但用户不会一直开着工具窗——结果提示必须弹回
 *  绳窗并锚到 noteId 对应卡片的水平位置；卡不在/未带 noteId 时回落面板居中。 */
export const CL_TOAST = 'clothesline-toast'
export type ClToastPayload = { kind: 'ok' | 'err'; msg: string; noteId?: string | null }

/** ★2026-11-15 一键录音：绳窗 ＋ 菜单 → 主窗执行录音。录音引擎（recorder.ts 模块级
 *  单例）只活在主窗 —— 绳窗是独立 WebView 上下文，绝不 import recorder（会双实例抢
 *  麦克风 + 双写元数据），只发遥控命令 + 收状态广播。
 *  reset = 重新计时：主窗丢弃已录内容（删半成品文件）并以同标题立即重开；
 *  save/reset 携带卡片上的当前标题（用户可在卡上改名），保存时按它重命名落盘文件。 */
export const CL_RECORDER_CMD = 'clothesline-recorder-cmd'
export type ClRecorderCmd =
  | { action: 'start'; cardId: string; title: string }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'reset'; title: string }
  | { action: 'save'; title: string }
  | { action: 'abort' }

/** 主窗 → 绳窗：录音引擎状态广播（录音中约 5Hz 由 200ms 计时 tick 驱动）。
 *  cardId = 发起本次录音的绳卡 id；null = 录音页等其它入口发起，绳窗忽略。
 *  done 是一次性终态信号：saved=已保存（绳窗取卡）；failed=失败（绳窗取卡+提示）。 */
export const CL_RECORDER_STATE = 'clothesline-recorder-state'
export type ClRecorderState = {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'saving'
  elapsedMs: number
  title: string | null
  cardId: string | null
  error: string | null
  done: 'saved' | 'failed' | null
}

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
  /** 整窗在可用区内的水平位置 0~1（0.5=居中）。问题1/4/11 统一位置真源。 */
  win_x_ratio: number
  /** 收起态拉杆皮肤：素瓷 / 黄铜 / 琉璃。默认 porcelain。 */
  pulltab_style: ClPulltabStyle
  /** Rust 端一次性脏 ratio 迁移标记；前端只读、不写。 */
  win_x_migrated_v2?: boolean
  /** Rust 端两态位置解绑的存量迁移标记；前端只读、不写。 */
  x_ratio_split_v1?: boolean
  /** 晾衣绳长度 = 可用区宽度占比 0.3~1.0（默认 0.86），影响单屏可挂卡片数量。 */
  rope_width_ratio: number
  /** 卡片尺寸缩放 1.0~2.0（1.0=最小=当前默认，2.0=放大一倍）。 */
  card_size: number
}

export type ClPulltabStyle = 'porcelain' | 'brass' | 'glass'

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

/** 与 clothesline.rs::CardKind 对应。audio = 一键录音卡（会话级，重启不恢复）。 */
export type CardKind =
  | 'note'
  | 'shot'
  | 'clipboard'
  | 'pin'
  | 'image'
  | 'task'
  | 'text'
  | 'timer'
  | 'audio'

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
  /** 番茄总时长（正计时暂停后恢复 / 重置 / +5 需要它，end_at 已置空时唯一真源）。 */
  timer_total_ms: number | null
  timer_direction: string
  timer_elapsed_mode: string
  fired_at: number | null
  /** 自定义底色（CSS 十六进制；null=类型默认纸色）。 */
  card_color: string | null
  /** 番茄钟卡片样式 paper / minimal / glass（null=paper）。 */
  card_style: string | null
  /** 计时卡结束是否弹提醒（默认 true）。 */
  remind: boolean
  /** 卡内文字缩放（0.6~1.4，null=1）。便利签 / 随手记卡的字号调节真源。 */
  font_scale: number | null
  /** ★批12 随手记字体格式（null/缺省=默认）。标题字号恒不受 font_scale 影响。 */
  title_size?: number | null
  /** 正文字号基准（px，渲染时仍乘 font_scale；null=默认 10）。 */
  body_size?: number | null
  /** 自定义字体族（CSS font-family 值；null=默认 Segoe UI）。 */
  font_family?: string | null
  title_bold?: boolean | null
  title_italic?: boolean | null
  body_bold?: boolean | null
  body_italic?: boolean | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  /** 归档时间戳（ms）。有值 = 已归档：不在绳上，但保留供归档页查看/恢复。 */
  archived_at?: number | null
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
  timer_total_ms?: number | null
  /** ★2026-11-18 重置语义：正计时重置重设计时锚点（Rust CardPatch 同步）。 */
  created_at?: number
  timer_direction?: string
  fired_at?: number | null
  pinned?: boolean
  card_color?: string | null
  card_style?: string | null
  remind?: boolean
  font_scale?: number | null
  /** ★批12：DoubleOption 语义 —— 缺省=不改 / null=清空回默认 / 值=设置。 */
  title_size?: number | null
  body_size?: number | null
  font_family?: string | null
  title_bold?: boolean | null
  title_italic?: boolean | null
  body_bold?: boolean | null
  body_italic?: boolean | null
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
    timer_total_ms: patch.timer_total_ms ?? null,
    timer_direction: patch.timer_direction ?? 'countdown',
    timer_elapsed_mode: patch.timer_elapsed_mode ?? 'wallclock',
    fired_at: patch.fired_at ?? null,
    card_color: patch.card_color ?? null,
    card_style: patch.card_style ?? null,
    remind: patch.remind ?? true,
    font_scale: patch.font_scale ?? null,
    title_size: patch.title_size ?? null,
    body_size: patch.body_size ?? null,
    font_family: patch.font_family ?? null,
    title_bold: patch.title_bold ?? null,
    title_italic: patch.title_italic ?? null,
    body_bold: patch.body_bold ?? null,
    body_italic: patch.body_italic ?? null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    archived_at: null,
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
 * ★问题3「点大图预览时晾衣绳晃动一下」：**单次 SetWindowPos** 写矩形，绝不做三连写。
 * 三连写会让窗口出现「先移动、后改尺寸」的中间帧（旧位置 + 新宽度），肉眼就是
 * 「像重新调整了一次位置」。预览放大 / 复原这类高频几何切换必须走这条一次性通道。
 */
export const clSetBounds = (x: number, y: number, width: number, height: number) =>
  invoke<void>('clothesline_set_bounds', { x, y, width, height })

/**
 * 拖拽逐帧移动（第二十一轮绳带窄窗）：只改窗口位置、绝不改尺寸 → 视口恒定、零重排。
 * 收起态拉杆平移 / 展开态垂直 anchor 拖动走这条通道；展开态水平拖动仍是纯 CSS 变量。
 */
export const clSetPosition = (x: number, y: number) =>
  invoke<void>('clothesline_set_position', { x, y })

/**
 * 上报命中矩形（屏幕绝对物理坐标）。★2026-11-14 第二十一轮（绳带窄窗）：
 * 本表**只服务 Rust 侧浮层关闭检测**（问题13「左键点在面板外」判定），不再参与 OS
 * 命中测试——命中由绳带窄窗的普通矩形窗口语义天然完成（窗口外点击直达桌面）。
 * 空数组 = 预览/拖放会话（面板外判定暂停；过期后 Rust 8s 兜底回退最近非空矩形）。
 * ⚠️ 绝不能用 pointermove 写穿透布尔值——运行期窗口样式写入会触发 DWM 重建层（R68）。
 */
export const clSetHitRects = (rects: HitRect[]) =>
  invoke<void>('clothesline_set_hit_rects', { rects })

/** 兼容桩（第二十一轮起 force 无窗口副作用，绳带窄窗无穿透/可点双态）。 */
export const clSetForceClickable = (durationMs: number) =>
  invoke<void>('clothesline_set_force_clickable', { durationMs })

/** 浮层开合（问题13）：打开→Rust 命中循环检测窗外左键→发 CL_DISMISS_OVERLAY。 */
export const clSetDismissOnOutside = (on: boolean) =>
  invoke<void>('clothesline_set_dismiss_on_outside', { on })

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

/** 归档卡片：绳上消失但持久保留；Timer 顺带清 end_at/fired_at（停止计时与提醒）。 */
export const clArchiveCard = (id: string) =>
  invoke<ClotheslineCard>('clothesline_archive_card', { id })

/** 归档清单（归档页数据源）：按归档时间倒序。 */
export const clListArchived = () =>
  invoke<ClotheslineCard[]>('clothesline_list_archived')

/** 取消归档：清 archived_at，order 不动 → 恢复回原槽位。 */
export const clUnarchiveCard = (id: string) =>
  invoke<ClotheslineCard>('clothesline_unarchive_card', { id })

/** 永久删除归档卡（物理移除，无撤销；调用方自行承担确认语义）。 */
export const clDeleteArchived = (id: string) =>
  invoke<void>('clothesline_delete_archived', { id })

/** 缩略图落盘（前端先压到 ≤480px PNG）→ 返回绝对路径，只写 src_path，绝不进 localStorage。 */
export const clSavePreview = (id: string, pngDataUrl: string) =>
  invoke<string>('clothesline_save_preview', { id, dataUrl: pngDataUrl })

/** 读回缩略图 data URL（不用 asset://：未授权 asset scope 且会污染 canvas）。 */
export const clReadPreview = (id: string) =>
  invoke<string | null>('clothesline_read_preview', { id })

/** 只读卡片用量，配置页状态条显示「已挂 n/limit」。 */
export const clGetCardUsage = () => invoke<number>('clothesline_get_card_usage')
