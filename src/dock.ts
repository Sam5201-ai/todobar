/**
 * 主窗口「目标屏幕 + 停靠边」统一几何。
 *
 * 解决的问题:此前主窗(App.tsx syncNativeWindow)、便利签(notes/manager.ts)、
 * 剪贴板(ClipboardView)各用一套方式猜屏幕,且混用逻辑/物理坐标 —— 混合 DPI
 * 多屏下便利签会跳到主屏、甚至落到屏幕外。这里把「目标屏」收敛成唯一真源。
 *
 * ⚠️ 坐标铁律:本模块所有 x/y/width/height 一律是**物理像素**,可直接传给
 * Tauri 的 PhysicalPosition / PhysicalSize。CSS 侧的尺寸仍是逻辑像素,
 * 换算只在边界处用 scaleFactor 做一次。
 *
 * 便利签 / 剪贴板等独立浮窗是否消费本模块由各自决定:
 * - 新建便利签 → 跟随这里的目标屏(用户决策 3/5)
 * - 便利签召回 / 截图 / 剪贴板 → 保持各自原逻辑(尊重拖动、保持光标所在屏)
 */

import {
  availableMonitors,
  primaryMonitor,
  type Monitor,
} from '@tauri-apps/api/window'

import {
  SIDEBAR_SETTINGS_KEY,
  defaultSidebarSettings,
  normalizeMonitorPref,
  type SidebarSettings,
} from './sidebarSettings'

export type DockSide = 'left' | 'right'

/** 'primary' 主屏 / 'secondary' 副屏 / 显示器稳定 key。旧 'auto' 已下线,统一归主屏。 */
export type MonitorPref = 'primary' | 'secondary' | string

export type DockMonitorOption = {
  value: string
  label: string
}

export type DockGeometry = {
  side: DockSide
  /** 目标屏工作区,物理像素(已扣除任务栏)。 */
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  /** 实际命中的显示器 key;解析失败时为主屏 key。 */
  monitorKey: string | null
  /** 实际命中的显示器可读名,写进便利签做诊断用。 */
  monitorName: string | null
  /** 指定的屏幕找不到了(拔屏/改名)或副屏不存在,已回退主屏。 */
  fallback: boolean
  /** 目标屏整屏的 CSS 尺寸,用于设置视口与面板宽度上限。 */
  fullCssWidth: number
  fullCssHeight: number
  /** 实际生效的面板宽度(CSS 像素)。 */
  panelCssWidth: number
  /** 把手宽度 / 展开态窗口宽 / 收起态窗口宽 / 窗口高度,物理像素。 */
  tabWidthPhys: number
  windowWidth: number
  /** ⚠️ 收起态窗口收窄到「只有把手」的宽度,而不是把整窗推出屏幕。 */
  closedWidth: number
  targetHeight: number
  /** 展开 / 收起时窗口左上角的物理 x、y。两者都保证窗口完整落在目标屏工作区内。 */
  openX: number
  closedX: number
  openY: number
}

/** 显示器稳定 key:name 可能为空(部分 Windows 驱动),退而用物理左上角坐标。 */
export function monitorKey(m: Monitor): string {
  return m.name && m.name.trim()
    ? m.name.trim()
    : `mon@${m.position.x},${m.position.y}`
}

function workAreaOf(m: Monitor) {
  const wa = m.workArea
  const pos = wa?.position ?? m.position
  const size = wa?.size ?? m.size
  const width = size?.width && size.width > 0 ? size.width : m.size.width
  const height = size?.height && size.height > 0 ? size.height : m.size.height
  return { x: pos.x, y: pos.y, width, height }
}

function humanName(m: Monitor, index: number): string {
  const raw = m.name?.trim()
  return raw ? raw : `显示器 ${index + 1}`
}

/**
 * 设置页下拉的选项。单屏时调用方仍会渲染,但整行禁用(用户决策 1)。
 * ⚠️ 0.4.62 起不再提供「默认 · 跟随窗口所在屏」:主窗是无边框贴边窗,
 * 「跟随当前窗口所在屏」实际等于「固定在启动那块屏」,容易被误读成跟随鼠标。
 * 现在默认就是主屏,用户明确选主屏 / 副屏 / 具体显示器,选择会被持久化。
 * 三屏及以上追加精确显示器项,避免「副屏」只能选到第一块外接屏。
 */
export async function listDockMonitors(): Promise<DockMonitorOption[]> {
  let monitors: Monitor[] = []
  let primary: Monitor | null = null
  try {
    ;[monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()])
  } catch {
    // 浏览器预览 / 非 Tauri 环境:至少给出主屏项,由调用方禁用整行。
    return [{ value: 'primary', label: '主屏' }]
  }
  const first = primary ?? monitors[0] ?? null
  const options: DockMonitorOption[] = [
    { value: 'primary', label: first ? `主屏 · ${humanName(first, 0)}` : '主屏' },
  ]
  if (!first) return options
  if (monitors.length > 1) {
    options.push({ value: 'secondary', label: '副屏' })
  }
  if (monitors.length > 2) {
    const pk = primary ? monitorKey(primary) : null
    monitors.forEach((m, i) => {
      const key = monitorKey(m)
      options.push({
        value: key,
        label: `${key === pk ? '主屏' : `副屏 ${i}`} · ${humanName(m, i)}`,
      })
    })
  }
  return options
}

/** 屏幕数量,设置页据此决定「显示屏幕」行是否禁用。 */
export async function dockMonitorCount(): Promise<number> {
  try {
    return (await availableMonitors()).length
  } catch {
    return 0
  }
}

/**
 * 解析目标屏并算出主窗全部几何。失败(拿不到任何显示器)返回 null,
 * 调用方保留原行为并走 Rust 看门狗,绝不让窗口卡在 visible:false。
 */
export async function resolveDockTarget(
  rawPref: MonitorPref,
  side: DockSide,
  dims: { panelWidth: number; tabWidth: number },
): Promise<DockGeometry | null> {
  // 兼容老版本落盘的 'auto' / 空值:一律归到主屏,不再依赖 currentMonitor()
  // (贴边无边框窗的「当前所在屏」几乎恒等于启动那块屏,语义含混且不可复现)。
  const pref = normalizeMonitorPref(rawPref)
  let monitors: Monitor[] = []
  let primary: Monitor | null = null
  try {
    ;[monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()])
  } catch {
    return null
  }
  if (monitors.length === 0) return null

  const primaryMon = primary ?? monitors[0]
  const primaryKey = monitorKey(primaryMon)
  let target: Monitor | null = null
  let fallback = false

  if (pref === 'primary') {
    target = primaryMon
  } else if (pref === 'secondary') {
    target = monitors.find((m) => monitorKey(m) !== primaryKey) ?? null
    if (!target) {
      target = primaryMon
      fallback = true
    }
  } else {
    target = monitors.find((m) => monitorKey(m) === pref) ?? null
    if (!target) {
      target = primaryMon
      fallback = true
    }
  }

  const wa = workAreaOf(target)
  const sf = target.scaleFactor || 1
  const fullCssWidth = Math.round(wa.width / sf)
  const fullCssHeight = Math.round(wa.height / sf)
  const panelCssWidth = Math.min(
    dims.panelWidth,
    Math.max(280, fullCssWidth - dims.tabWidth - 8),
  )
  const windowWidth = Math.round((dims.tabWidth + panelCssWidth) * sf)
  const tabWidthPhys = Math.round(dims.tabWidth * sf)

  // ⚠️ 收起态绝不把窗口推出目标屏:此前用「整窗平移 + 只露把手」(closedX =
  // wa.x - windowWidth + tabWidth),窗口左边会落到相邻屏(混合 DPI 下尤其致命):
  //   - Windows 按窗口中心所在屏重新缩放 WebView → 面板内容被裁切、尺寸错乱;
  //   - currentMonitor / outerPosition 与 cursorPosition 口径不一致 → 点击穿透
  //     被误判成 true 且锁死,表现为「窗口跨屏 + 点哪儿都没反应」。
  // 改为收起时把窗口**缩窄到把手宽度**并贴到屏边,窗口始终完整在目标屏内。
  // CSS 侧 native-dock-surface 用固定 SVG 尺寸(不再 100vw),只截取把手那一列。
  const closedWidth = tabWidthPhys
  const openX = side === 'right' ? wa.x + wa.width - windowWidth : wa.x
  const closedX = side === 'right' ? wa.x + wa.width - closedWidth : wa.x

  const index = monitors.findIndex((m) => monitorKey(m) === monitorKey(target))
  return {
    side,
    workArea: wa,
    scaleFactor: sf,
    monitorKey: monitorKey(target),
    monitorName: humanName(target, index < 0 ? 0 : index),
    fallback,
    fullCssWidth,
    fullCssHeight,
    panelCssWidth,
    tabWidthPhys,
    windowWidth,
    closedWidth,
    targetHeight: wa.height,
    openX,
    closedX,
    openY: wa.y,
  }
}

/** 几何签名,用于低频轮询时判断「屏幕插拔/DPI 变化」是否真的需要重定位。 */
export function dockSignature(g: DockGeometry): string {
  const w = g.workArea
  return [
    g.side, g.monitorKey, g.scaleFactor, w.x, w.y, w.width, w.height,
    g.panelCssWidth, g.windowWidth, g.closedWidth, g.openX, g.closedX,
  ].join('|')
}

/** 一帧窗口矩形,物理像素(x/y/width/height),可直接交给主窗几何写入命令。 */
export type DockRect = { x: number; y: number; width: number; height: number }

/**
 * 原生窗口矩形(物理像素)。
 *
 * ⚠️ 0.4.62 起展开/收起**不再逐帧改窗口尺寸**:JS→Rust 每帧 IPC + WebView2
 * 每帧重排是「卡顿/不丝滑」的根因。现在原生窗口恒定使用 progress=1 的完整
 * 矩形,展开/收起交给 CSS transform 平移内容层(合成器动画,零 IPC、零重排)。
 * progress=0 的收起矩形只保留给几何校验与历史兼容,运行时不再写入窗口。
 */
export function dockFrame(g: DockGeometry, progress: number): DockRect {
  const p = Math.min(1, Math.max(0, progress))
  const width = Math.round(g.closedWidth + (g.windowWidth - g.closedWidth) * p)
  const rightEdge = g.openX + g.windowWidth
  const x = g.side === 'right' ? rightEdge - width : g.openX
  return { x, y: g.openY, width, height: g.targetHeight }
}

/**
 * 点击穿透判定。
 *
 * ⚠️ 历史事故:展开态曾按「面板/把手矩形」细分判定,混合 DPI 跨屏时
 * outerPosition 与 cursorPosition 单位不一致,relX/relY 变成垃圾值,判定恒为
 * 穿透;叠加前端 lastIgnored 短路后窗口被永久锁成 WS_EX_TRANSPARENT,
 * 表现为「点哪儿都没反应」。现在展开态一律不穿透(窗口内全是实打实的 UI),
 * 只有收起态才对把手竖条放行,并对坐标口径异常做安全兜底。
 *
 * ⚠️ 0.4.62:原生窗口收起时**保持全宽**,可见内容由 CSS transform 整体平移到
 * 屏边,只剩把手那一列。因此不能再拿实测窗口宽度当「把手宽度」——否则整条
 * 面板高度的横向区域都会被判定成把手、把桌面点击吞掉。可点区域固定为:
 *   右贴 → 窗口右缘 tabWidthPhys;左贴 → 窗口左缘 tabWidthPhys。
 *
 * relX/relY 均为「光标物理坐标 - 窗口 outerPosition 物理坐标」;
 * winWidthPhys / winHeightPhys 为 outerSize() 实测值。
 */
export function dockShouldIgnore(
  g: DockGeometry,
  isOpen: boolean,
  relX: number,
  relY: number,
  winWidthPhys: number,
  winHeightPhys: number,
  handleCenterCss: number,
  handleHeightCss: number,
): boolean {
  // 展开态(含展开/收起动画期间):整个窗口都是面板/把手,不该把用户锁在门外。
  if (isOpen) return false

  const sf = g.scaleFactor || 1
  const slop = 3 * sf
  const w = winWidthPhys > 0 && Number.isFinite(winWidthPhys)
    ? winWidthPhys
    : g.windowWidth
  const h = winHeightPhys > 0 && Number.isFinite(winHeightPhys)
    ? winHeightPhys
    : g.targetHeight

  // 坐标系兜底:相对坐标明显越出窗口矩形时,说明两个 API 的 DPI 口径不一致。
  // 此时宁可让窗口短暂可点,也不能误判成永久穿透。
  if (relX < -w - slop || relX > w * 2 + slop || relY < -h || relY > h * 2) {
    return false
  }

  const tab = g.tabWidthPhys || g.closedWidth
  const stripLeft = g.side === 'right' ? Math.max(0, w - tab) : 0
  const stripRight = g.side === 'right' ? w : Math.min(w, tab)
  const top = (handleCenterCss - handleHeightCss / 2) * sf
  const bottom = (handleCenterCss + handleHeightCss / 2) * sf
  const onHandle =
    relX >= stripLeft - slop && relX <= stripRight + slop &&
    relY >= top - slop && relY <= bottom + slop
  return !onHandle
}

/**
 * 便利签等**非 React 上下文**读取当前停靠偏好(主窗口内必定已写入 localStorage)。
 * 不引入 IPC,避免每次新建便利签多一次往返。
 */
export function readDockPref(): Pick<
  SidebarSettings,
  'targetMonitor' | 'dockSide' | 'panelWidth' | 'tabWidth'
> {
  const fallback = {
    targetMonitor: defaultSidebarSettings.targetMonitor,
    dockSide: defaultSidebarSettings.dockSide,
    panelWidth: defaultSidebarSettings.panelWidth,
    tabWidth: defaultSidebarSettings.tabWidth,
  }
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SETTINGS_KEY)
    if (!raw) return fallback
    const v = JSON.parse(raw) as Partial<SidebarSettings>
    return {
      targetMonitor: normalizeMonitorPref(v.targetMonitor),
      dockSide: v.dockSide === 'left' ? 'left' : 'right',
      panelWidth:
        typeof v.panelWidth === 'number' && Number.isFinite(v.panelWidth)
          ? v.panelWidth
          : fallback.panelWidth,
      tabWidth:
        typeof v.tabWidth === 'number' && Number.isFinite(v.tabWidth)
          ? v.tabWidth
          : fallback.tabWidth,
    }
  } catch {
    return fallback
  }
}
