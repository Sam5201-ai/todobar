/**
 * 首页顶栏快捷入口(0.4.62)。
 *
 * 此前顶栏 6 个图标是硬编码的,截图 / 便利签 / 剪贴板只能靠全局快捷键触发,
 * 用户找不到入口。这里把「工具注册表 + 启用/排序偏好 + 槽位计算」收在一处:
 * - 勾选数量不限,排序靠前的工具按面板宽度占用顶栏槽位,其余自动进「⋯ 更多」;
 * - 设置按钮固定,不参与配置;
 * - 偏好随 SidebarSettings 一起落 localStorage + 磁盘(~/.ticktask/prefs.json)。
 *
 * 槽位公式与 preview/topbar-tools-preview.html 逐行对齐,并沿用 App.css 的
 * 367 / 327 / 295 容器查询阈值(容器内容盒 = 面板宽度 − 33)。
 */

export type TopbarToolId =
  | 'screenshot'
  | 'note'
  | 'clipboard'
  | 'calculator'
  | 'huangli'
  | 'salary'
  | 'recorder'
  | 'sync'

export type TopbarTool = {
  id: TopbarToolId
  /** 菜单 / 配置行显示名。 */
  name: string
  /** 顶栏按钮的 tooltip。 */
  tip: string
  /** 是否显示「会员」徽标。 */
  vip: boolean
  /** 点击前是否需要会员闸门(未登录 / 试用过期走 handleLocked 分流)。
   *  录音机虽是会员功能,但闸门在页内「开始录音」,非会员仍可进页查看/回放,
   *  因此 vip=true 而 gated=false;同步则在 onHeaderSync 内部自行判定。 */
  gated: boolean
  /** 菜单右侧的默认快捷键提示(用户改过快捷键时由 App 动态覆盖)。 */
  keyHint: string
}

/** 顺序即默认优先级:新工具优先,同步与设置收尾。 */
export const TOPBAR_TOOLS: TopbarTool[] = [
  { id: 'screenshot', name: '截图', tip: '截图 · 框选识别', vip: true, gated: true, keyHint: 'Ctrl+Shift+A' },
  { id: 'note', name: '便利签', tip: '新建便利签', vip: true, gated: true, keyHint: 'Alt+N' },
  { id: 'clipboard', name: '剪贴板', tip: '剪贴板历史', vip: true, gated: true, keyHint: 'Ctrl+Shift+V' },
  { id: 'calculator', name: '计算器', tip: '计算器', vip: false, gated: false, keyHint: '' },
  { id: 'huangli', name: '黄历', tip: '黄历 · 万年历', vip: false, gated: false, keyHint: '' },
  { id: 'salary', name: '牛马计薪器', tip: '牛马计薪器', vip: false, gated: false, keyHint: '' },
  { id: 'recorder', name: '录音机', tip: '录音机', vip: true, gated: false, keyHint: '' },
  { id: 'sync', name: '同步', tip: '立即同步到云端', vip: false, gated: false, keyHint: '' },
]

export type TopbarToolsPref = {
  /** 全部工具的完整顺序(含未勾选项),长度恒等于 TOPBAR_TOOLS。 */
  order: TopbarToolId[]
  /** 勾选启用的工具,按 order 排序;至少保留 1 个。 */
  enabled: TopbarToolId[]
}

export const DEFAULT_TOPBAR_TOOLS: TopbarToolsPref = {
  order: TOPBAR_TOOLS.map((t) => t.id),
  enabled: TOPBAR_TOOLS.map((t) => t.id),
}

const ALL_IDS = TOPBAR_TOOLS.map((t) => t.id)
const BY_ID = Object.fromEntries(TOPBAR_TOOLS.map((t) => [t.id, t])) as Record<
  TopbarToolId,
  TopbarTool
>

/**
 * 归一化:过滤未知 id / 去重 / 补齐后加的工具 / 保证至少启用 1 个。
 * 老版本没有该字段时返回全启用默认;偏好升级或手工改坏 localStorage 都不会白屏。
 */
export function sanitizeTopbarTools(value: unknown): TopbarToolsPref {
  const raw = (value && typeof value === 'object' ? value : {}) as {
    order?: unknown
    enabled?: unknown
  }
  const order: TopbarToolId[] = []
  if (Array.isArray(raw.order)) {
    for (const id of raw.order) {
      if (ALL_IDS.includes(id as TopbarToolId) && !order.includes(id as TopbarToolId)) {
        order.push(id as TopbarToolId)
      }
    }
  }
  for (const id of ALL_IDS) if (!order.includes(id)) order.push(id)

  const rawEnabled = Array.isArray(raw.enabled) ? raw.enabled : null
  const enabled = rawEnabled
    ? order.filter((id) => rawEnabled.includes(id))
    : [...order]
  return { order, enabled: enabled.length > 0 ? enabled : [order[0]] }
}

/**
 * 顶栏可容纳的工具槽位数(不含「⋯ 更多」与固定设置按钮)。
 * 与预览一致:340px → 4 槽,300px → 5 槽(品牌文字收起腾出空间),500px → 6 槽(封顶)。
 * 面板宽度非原生模式还会被 `min(..., 100vw - 32px)` 压缩,这里按设置值计算即可,
 * 极端窄屏由 CSS 容器查询继续缩小按钮,不会溢出。
 */
export function topbarSlots(panelWidth: number): number {
  const content = panelWidth - 33
  const cq367 = content <= 367
  const cq327 = content <= 327
  const cq295 = content <= 295
  const btn = cq327 ? 26 : 30
  const gap = cq367 ? 3 : 5
  const brand = cq295 ? 24 : cq367 ? 84 : 86
  // 16 = header 左右 gap;2×btn = 更多 + 设置;末 16 = 按钮间距与右侧安全余量
  const usable = content - brand - 16 - btn - btn - 16
  return Math.max(2, Math.min(6, Math.floor(usable / (btn + gap))))
}

/** 按当前偏好与面板宽度,拆出「顶栏显示」与「收进更多」两组。 */
export function splitTopbarTools(
  pref: TopbarToolsPref,
  panelWidth: number,
): { shown: TopbarTool[]; hidden: TopbarTool[]; slots: number } {
  const list = pref.enabled.map((id) => BY_ID[id]).filter(Boolean)
  const slots = topbarSlots(panelWidth)
  return { shown: list.slice(0, slots), hidden: list.slice(slots), slots }
}

/** 设置页位置标签:未勾选 = off,启用且排在槽位内 = top,否则收进更多 = more。 */
export function topbarPosition(
  pref: TopbarToolsPref,
  id: TopbarToolId,
  panelWidth: number,
): 'top' | 'more' | 'off' {
  const index = pref.enabled.indexOf(id)
  if (index < 0) return 'off'
  return index < topbarSlots(panelWidth) ? 'top' : 'more'
}

/** 把 Tauri 快捷键写法转成菜单里显示的短标签。 */
export function formatShortcut(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Command/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/\bKey([A-Z])\b/g, '$1')
    .replace(/\bDigit([0-9])\b/g, '$1')
}
