/**
 * 便利签的窗口调度层。
 *
 * 集中在这里是为了让"新建便利签"的唯一入口(全局快捷键)逻辑稳定可复用,
 * 避免双份实现漂移。
 *
 * 上限在此处统一把关:
 *   - MAX_NOTES        = 50 账面上限(同时存在的便利签总数)
 *   - MAX_VISIBLE_NOTES= 12 同时显示上限(窗口数)
 */

import { invoke } from '@tauri-apps/api/core'
import { availableMonitors } from '@tauri-apps/api/window'

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

/**
 * 为新建便利签找一个**不与任何当前显示中便利签重叠**的位置(你的要求:完全不重合)。
 *
 * 策略:主屏居中起步 → 逐个 +24px 级联偏移 → 碰撞则继续偏移;
 * 撞到右/下边界就换行重来。找不到理想位置时返回一个安全兜底坐标。
 * ⚠️ 显示器信息必须用前端 availableMonitors(Rust 侧 current_monitor 实测不可靠)。
 */
export async function pickFreeSpot(
  size = DEFAULT_SIZE,
  excludeId?: string,
): Promise<{ x: number; y: number }> {
  const others = visibleNotes().filter((n) => n.id !== excludeId)
  let mx = 100
  let my = 100
  let mw = 1280
  let mh = 720
  try {
    const monitors = await availableMonitors()
    if (monitors.length > 0) {
      const m = monitors[0]
      const sf = m.scaleFactor || 1
      mx = m.position.x / sf
      my = m.position.y / sf
      mw = m.size.width / sf
      mh = m.size.height / sf
    }
  } catch {
    /* 非 Tauri 环境用默认值 */
  }

  const step = 24
  let x = Math.round(mx + mw / 2 - size.w / 2)
  let y = Math.round(my + mh / 2 - size.h / 2)

  for (let i = 0; i < 240; i += 1) {
    const hit = others.some((n) => overlaps(x, y, size.w, size.h, n.x, n.y, n.w, n.h))
    if (!hit) return { x, y }
    x += step
    y += step
    // 超出可视区就换行,回到左侧继续尝试。
    if (x + size.w > mx + mw || y + size.h > my + mh) {
      const line = Math.floor(i / 8)
      x = Math.round(mx + 40 + line * step)
      y = Math.round(my + 40 + line * step)
    }
  }
  return { x: Math.round(mx + 60), y: Math.round(my + 60) }
}

/** 新建便利签并开窗。三道闸门按「会员 → 总数 → 同时显示」顺序判定。 */
export async function createNoteWithWindow(
  isMember: boolean,
): Promise<{ ok: true; note: Note } | { ok: false; reason: FailReason }> {
  if (!isMember) return { ok: false, reason: 'member' }
  if (getNotes().length >= MAX_NOTES) return { ok: false, reason: 'total' }
  if (!canOpenAnother()) return { ok: false, reason: 'visible' }

  const spot = await pickFreeSpot()
  const note = createNote({ x: spot.x, y: spot.y, w: DEFAULT_SIZE.w, h: DEFAULT_SIZE.h })
  if (!note) return { ok: false, reason: 'total' }

  try {
    await invoke('notes_open_window', { noteId: note.id, pinned: note.pinned })
  } catch {
    /* 开窗失败不回滚数据:窗口可由快捷键重建 */
  }
  return { ok: true, note }
}
