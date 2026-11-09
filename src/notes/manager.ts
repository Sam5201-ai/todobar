/**
 * 便利签的窗口调度层。
 *
 * 集中在这里是为了让"新建便利签"的唯一入口(全局快捷键 / 顶栏)逻辑稳定可复用,
 * 避免双份实现漂移。
 *
 * 上限在此处统一把关:
 *   - MAX_NOTES        = 50 账面上限(同时存在的便利签总数)
 *   - MAX_VISIBLE_NOTES= 12 同时显示上限(窗口数)
 */

import { invoke } from '@tauri-apps/api/core'

import { readDockPref, resolveDockTarget } from '../dock'
import {
  canOpenAnother,
  createNote,
  getNotes,
  MAX_NOTES,
  MAX_VISIBLE_NOTES,
  visibleNotes,
  type Note,
} from './store'

const DEFAULT_SIZE = { w: 240, h: 220 }

export type FailReason = 'member' | 'total' | 'visible'

export function failText(reason: FailReason): string {
  switch (reason) {
    case 'member':
      return '便利签为会员功能,开通会员后可用'
    case 'total':
      return `便利签总数已达上限 ${MAX_NOTES} 个,请先删除一些再新建`
    case 'visible':
      return `同时显示已达上限 ${MAX_VISIBLE_NOTES} 个,请先关闭一些再新建`
  }
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

export type NoteSpot = {
  /** 逻辑像素坐标(相对该签的 scaleFactor),与 Note.x/y 同口径。 */
  x: number
  y: number
  scaleFactor: number
  monitorName: string | null
}

/**
 * 为新建便利签找一个**不与任何当前显示中便利签重叠**的位置(你的要求:完全不重合)。
 *
 * 目标屏来自 src/dock.ts 的统一几何 —— 工具面板显示在哪块屏,新建便利签就落在
 * 哪块屏(用户决策 5)。起点放在「面板之外的可用区」居中,避免一新建就压住工具。
 *
 * ⚠️ 几何计算全程用物理像素(显示器 workArea / position / size 都是物理的),
 * 只在写回 Note 时按目标屏 scaleFactor 换成逻辑坐标;旧数据没有 scaleFactor,
 * 碰撞检测中用目标屏缩放近似换算,仅影响启发式排布、不影响显示位置。
 */
export async function pickFreeSpot(
  size = DEFAULT_SIZE,
  excludeId?: string,
): Promise<NoteSpot> {
  const { targetMonitor, dockSide, panelWidth, tabWidth } = readDockPref()
  const geom = await resolveDockTarget(targetMonitor, dockSide, {
    panelWidth,
    tabWidth,
  })

  const wa = geom?.workArea ?? { x: 0, y: 0, width: 1280, height: 720 }
  const sf = geom?.scaleFactor ?? 1
  const monitorName = geom?.monitorName ?? null
  const wPhys = Math.round(size.w * sf)
  const hPhys = Math.round(size.h * sf)

  // 每条 note 都按自身 scaleFactor 换算成物理,统一到同一坐标系做碰撞检测。
  const others = visibleNotes()
    .filter((n) => n.id !== excludeId)
    .map((n) => {
      const s = n.scaleFactor ?? sf
      return { x: n.x * s, y: n.y * s, w: n.w * s, h: n.h * s }
    })

  // 面板占据目标屏一侧,把落点放在另一侧可用区居中。
  const panelPhys = geom?.windowWidth ?? 0
  const usableX = geom?.side === 'right' ? wa.x : wa.x + panelPhys
  const usableW = Math.max(wPhys, wa.width - panelPhys)
  const step = Math.max(12, Math.round(24 * sf))
  const clampX = (v: number) =>
    Math.min(Math.max(v, wa.x), Math.max(wa.x, wa.x + wa.width - wPhys))
  const clampY = (v: number) =>
    Math.min(Math.max(v, wa.y), Math.max(wa.y, wa.y + wa.height - hPhys))

  let x = clampX(usableX + usableW / 2 - wPhys / 2)
  let y = clampY(wa.y + wa.height / 2 - hPhys / 2)
  let found = false

  for (let i = 0; i < 240; i += 1) {
    const hit = others.some((n) => overlaps(x, y, wPhys, hPhys, n.x, n.y, n.w, n.h))
    if (!hit) {
      found = true
      break
    }
    x = clampX(x + step)
    y = clampY(y + step)
    // 撞到右/下边界就换行重来。
    if (x + wPhys >= wa.x + wa.width || y + hPhys >= wa.y + wa.height) {
      const line = Math.floor(i / 8)
      x = clampX(usableX + Math.round(40 * sf) + line * step)
      y = clampY(wa.y + Math.round(40 * sf) + line * step)
    }
  }
  // 12 张便利签都铺满时给一个安全兜底,绝不把签放到屏幕外。
  if (!found) {
    x = clampX(usableX + Math.round(60 * sf))
    y = clampY(wa.y + Math.round(60 * sf))
  }

  return {
    x: Math.round(x / sf),
    y: Math.round(y / sf),
    scaleFactor: sf,
    monitorName,
  }
}

/** 新建便利签并开窗。三道闸门按「会员 → 总数 → 同时显示」顺序判定。 */
export async function createNoteWithWindow(
  isMember: boolean,
): Promise<{ ok: true; note: Note } | { ok: false; reason: FailReason }> {
  if (!isMember) return { ok: false, reason: 'member' }
  if (getNotes().length >= MAX_NOTES) return { ok: false, reason: 'total' }
  if (!canOpenAnother()) return { ok: false, reason: 'visible' }

  const spot = await pickFreeSpot()

  // L2 低延迟:向 Rust 领取一个启动时预建的隐藏窗口(其 label 已带预留 id)。
  // 命中后不再新建 WebView2,Alt+N 到显示只剩「写数据 → 事件 → 前端 show」。
  // 命令不存在(旧版二进制 / 浏览器预览)时静默回落到原新建路径。
  let claimedId: string | null = null
  try {
    claimedId = await invoke<string | null>('notes_claim_window')
  } catch {
    /* 回落原路径 */
  }
  // 极端防御:预留 id 万一与已有数据撞车,宁可放弃池窗也不要造出重复 id。
  if (claimedId && getNotes().some((n) => n.id === claimedId)) claimedId = null

  const note = createNote({
    ...(claimedId ? { id: claimedId } : {}),
    x: spot.x,
    y: spot.y,
    w: DEFAULT_SIZE.w,
    h: DEFAULT_SIZE.h,
    scaleFactor: spot.scaleFactor,
    monitorName: spot.monitorName ?? undefined,
  })
  if (!note) return { ok: false, reason: 'total' }

  // 池窗已存在时该命令只走「复用」分支(不新建 WebView2);
  // 池窗若被意外销毁,它会自动补建,是必要的安全兜底。
  try {
    await invoke('notes_open_window', { noteId: note.id, pinned: note.pinned })
  } catch {
    /* 开窗失败不回滚数据:窗口可由快捷键重建 */
  }
  return { ok: true, note }
}
