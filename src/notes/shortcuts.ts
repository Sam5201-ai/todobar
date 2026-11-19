// 便利签:全局快捷键的注册与触发。
//
// 模式与 screenshot/shortcuts.ts 一致:设置存 localStorage → 由前端调用 Rust 命令
// 注册 → 触发后 Rust 把事件发回主窗口。
// 差异:**会员闸门在前端**(需要 hasFullAccess() 与统一提示文案),故 Rust 只负责
// 「按下了」这个信号,是否真的创建由 App 侧决定。
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

let initialized = false

/**
 * 注册 / 注销「新建便利签」快捷键。空字符串表示注销且不注册。
 * 失败(多为与系统/其他快捷键冲突)返回 error,调用方据此处设置页标红。
 */
export async function applyNoteShortcut(
  shortcut: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('register_note_shortcut', { shortcut })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 建立触发监听(只做一次)。触发后回调由 App 决定要不要创建。
 */
export async function initNoteShortcuts(onTriggered: () => void): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    await listen('note-create-trigger', () => {
      onTriggered()
    })
  } catch {
    /* 非 Tauri 环境(纯浏览器预览)事件不可用 */
  }
}

// ——— 打开归档页 全局快捷键(2026-11-18 归档) ———

/**
 * 注册 / 注销「打开归档页」快捷键。空字符串表示注销。非会员功能,不做会员闸门。
 */
export async function applyArchiveShortcut(
  shortcut: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('register_archive_shortcut', { shortcut })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 建立归档快捷键触发监听(只做一次)。Rust 触发后向主窗发 archive-open-trigger。
 */
export async function initArchiveShortcutTrigger(onTriggered: () => void): Promise<void> {
  try {
    await listen('archive-open-trigger', () => {
      onTriggered()
    })
  } catch {
    /* 非 Tauri 环境(纯浏览器预览)事件不可用 */
  }
}
