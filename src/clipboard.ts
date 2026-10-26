// 剪贴板历史的 Rust 桥接 + 统一复制通道。
//
// 设计:
// - 所有「TickTask 主动写入剪贴板」都走 copyText(),底层调用 clipboard_write_text,
//   该命令会打 self-write 标记 → 监听线程据此跳过自身内容,不污染历史。
// - 自定义命令无需在 capabilities 显式声明(与 notes/screenshot 同机制),窗口只要有
//   core:default 等基础权限即可调用。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isTauriRuntime } from './useTaskStore'

export type ClipItem = {
  id: string
  text: string
  preview: string
  created_at: number
  source: string | null
  pinned: boolean
  pinned_at?: number
  len: number
}

export type ClipConfig = {
  enabled: boolean
  paused: boolean
  max_count: number
  skip_password: boolean
  show_source: boolean
  auto_paste: boolean
  max_chars: number
}

export async function clipboardList(): Promise<ClipItem[]> {
  try {
    return (await invoke('clipboard_list')) as ClipItem[]
  } catch {
    return []
  }
}

export async function clipboardDelete(id: string): Promise<void> {
  await invoke('clipboard_delete', { id }).catch(() => {})
}

export async function clipboardClear(): Promise<void> {
  await invoke('clipboard_clear').catch(() => {})
}

export async function clipboardPin(id: string, pinned: boolean): Promise<void> {
  await invoke('clipboard_pin', { id, pinned }).catch(() => {})
}

export async function clipboardSetPaused(paused: boolean): Promise<void> {
  await invoke('clipboard_set_paused', { paused }).catch(() => {})
}

export async function clipboardSetConfig(cfg: ClipConfig): Promise<void> {
  await invoke('clipboard_set_config', { value: JSON.stringify(cfg) }).catch(() => {})
}

/** 写入系统剪贴板(自带 self-write 标记,不污染历史)。返回是否成功自动粘贴到上一窗口。 */
export async function clipboardCopyBack(id: string): Promise<boolean> {
  try {
    return (await invoke('clipboard_copy_back', { id })) as boolean
  } catch {
    return false
  }
}

export async function clipboardHideWindow(): Promise<void> {
  await invoke('clipboard_hide_window').catch(() => {})
}

/** 统一复制通道:TickTask 内部所有「复制到剪贴板」都应走这里,避免被历史记录。 */
export async function copyText(text: string): Promise<void> {
  if (!isTauriRuntime()) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
    return
  }
  await invoke('clipboard_write_text', { text }).catch(() => {
    // 兜底:极端情况下 Rust 写入失败,退化为浏览器 API。
    try {
      void navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
  })
}

/** 注册 / 注销「唤出剪贴板」快捷键。空串表示注销。 */
export async function applyClipboardShortcut(
  shortcut: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke('register_clipboard_shortcut', { shortcut })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 设置后台监听的会员开关:非会员不记录剪贴板历史。 */
export async function clipboardSetActive(allowed: boolean): Promise<void> {
  await invoke('clipboard_set_active', { allowed }).catch(() => {})
}

/** 监听历史变更(后台监听线程 emit 到本窗口)。 */
export async function onClipboardChanged(cb: () => void): Promise<UnlistenFn> {
  try {
    return await listen('clipboard-changed', () => cb())
  } catch {
    return () => {}
  }
}
