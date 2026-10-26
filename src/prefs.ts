/**
 * 偏好设置的磁盘持久化封装。
 *
 * 背景/字体/主题(待办设置页)与计薪/浮窗配置原本只存在 WebView localStorage,
 * 重装应用或清理 WebView 缓存时会丢失。这里把它们镜像到主目录 ~/.ticktask/prefs.json,
 * 重装后自动回灌(与登录态自愈同机制)。
 */

import { invoke } from '@tauri-apps/api/core'

import { isTauriRuntime } from './useTaskStore'

/** 从磁盘读取某个偏好键;无或失败返回 null。 */
export async function loadDiskPref<T>(key: string): Promise<T | null> {
  if (!isTauriRuntime()) return null
  try {
    const raw = (await invoke('get_pref', { key })) as string | null
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** 写入某个偏好键到磁盘(失败静默)。 */
export async function saveDiskPref(key: string, value: unknown): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await invoke('set_pref', { key, value: JSON.stringify(value) })
  } catch {
    /* 静默 */
  }
}
