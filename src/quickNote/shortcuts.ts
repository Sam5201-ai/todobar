/** 全局速记（随手记）快捷键桥接：注册 / 监听触发 / 打开录入窗。 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** 触发事件：Rust 注册快捷键后发到主窗，主窗做会员闸门再开窗。 */
export const QUICK_NOTE_OPEN_TRIGGER = 'quick-note-open-trigger'

/** 注册 / 注销全局快捷键（空串=注销）。返回是否成功。 */
export async function applyQuickNoteShortcut(shortcut: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('register_quick_note_shortcut', { shortcut })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 监听快捷键触发。返回取消监听函数。 */
export async function initQuickNoteTrigger(cb: () => void): Promise<() => void> {
  return listen(QUICK_NOTE_OPEN_TRIGGER, () => cb())
}

/** 打开桌面录入窗（force_show=true：已开则聚焦而非 toggle）。 */
export async function openQuickNoteWindow(forceShow = true): Promise<void> {
  try {
    await invoke('quick_note_open', { forceShow })
  } catch {
    /* 开窗失败交由窗口内看门狗/日志，前端不打断 */
  }
}

/** 收起录入窗。 */
export async function hideQuickNoteWindow(): Promise<void> {
  try {
    await invoke('quick_note_hide')
  } catch {
    /* ignore */
  }
}
