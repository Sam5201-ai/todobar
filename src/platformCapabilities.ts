/**
 * 平台能力表（前端侧单一真源镜像）。
 *
 * 数据来源：Rust `capabilities.rs` 的 `platform_capabilities` 命令，进程内只取一次并缓存。
 * 禁止在业务组件里用 navigator.userAgent / navigator.platform 判断 OS —— 一律走这里。
 *
 * 浏览器预览态（非 Tauri 环境）回落为「全开」，保证开发预览与 Windows 行为一致。
 */

import { invoke } from '@tauri-apps/api/core'

export interface PlatformCapabilities {
  /** "windows" | "macos" | "other" */
  os: 'windows' | 'macos' | 'other'
  /** 截图 / 贴图 / 图片保存 / 框选 / 窗口截图 */
  screenshot: boolean
  /** OCR 识别（依附截图输入链路） */
  ocr: boolean
  /** 剪贴板历史（Mac 端已实现） */
  clipboardHistory: boolean
  /** 晾衣绳 */
  clothesline: boolean
  /** 应用内检查更新中的「下载并安装」 */
  inAppUpdate: boolean
  /** 全应用复制通道 */
  clipboardWrite: boolean
  /** 录音的文件打开 / 定位 / 打开目录 / 权限设置跳转 */
  recordingShell: boolean
}

export type CapabilityId = Exclude<keyof PlatformCapabilities, 'os'>

const ALL_ON: PlatformCapabilities = {
  os: 'windows',
  screenshot: true,
  ocr: true,
  clipboardHistory: true,
  clothesline: true,
  inAppUpdate: true,
  clipboardWrite: true,
  recordingShell: true,
}

let cached: PlatformCapabilities | null = null
let pending: Promise<PlatformCapabilities> | null = null

function inTauri(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Tauri')
}

/** 幂等加载：重复调用只发一次 invoke；失败回落全开，不影响桌面端正常使用。 */
export function loadCapabilities(): Promise<PlatformCapabilities> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  if (!inTauri()) {
    cached = ALL_ON
    return Promise.resolve(cached)
  }
  pending = invoke<PlatformCapabilities>('platform_capabilities')
    .then((caps) => {
      cached = caps
      return caps
    })
    .catch(() => {
      cached = ALL_ON
      return cached
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** 同步读取已加载的能力表；未加载完成时返回全开（调用方应在加载完成后再渲染受控入口）。 */
export function caps(): PlatformCapabilities {
  return cached ?? ALL_ON
}

/** 能力表是否已就绪。 */
export function capsReady(): boolean {
  return cached !== null
}

export function isMac(): boolean {
  return caps().os === 'macos'
}

export function allows(id: CapabilityId): boolean {
  return caps()[id]
}
