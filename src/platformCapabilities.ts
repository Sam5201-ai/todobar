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

/** 与 Rust capabilities.rs 的 macOS 分支逐字段对齐。
 *  仅在 Tauri 下 invoke 失败时兜底:绝不能回落 ALL_ON —— 那会让 Mac 误判成 Windows,
 *  把已隐藏的截图/贴图入口全部放出来。os 由 UA 推断(本文件是唯一允许判 OS 的地方)。 */
function fallbackForCurrentOs(): PlatformCapabilities {
  const isMacOs = /Macintosh|Mac OS X/i.test(navigator.userAgent || '')
  if (!isMacOs) return ALL_ON
  return {
    os: 'macos',
    screenshot: false,
    ocr: false,
    clipboardHistory: true,
    // 晾衣绳 0.4.81 起在 Mac 实装(与 Rust capabilities.rs 同步);改这里时两处都要改。
    clothesline: true,
    inAppUpdate: false,
    clipboardWrite: true,
    recordingShell: true,
  }
}

let cached: PlatformCapabilities | null = null
let pending: Promise<PlatformCapabilities> | null = null

function inTauri(): boolean {
  // ⚠️ 回归修复：只能用 UA 判定，恢复 Windows 的同步回落路径。
  // 上一版叠加 __TAURI_INTERNALS__ / protocol 等多重判定后，Windows 开发版
  // 掉进 invoke 异步分支且未及时返回 → cached 恒 null → capsReady() 恒 false
  // → 顶栏截图图标 / 设置页截图快捷键被 capsReady 守卫隐藏（快捷键因 caps()
  // 回落 ALL_ON 仍可用）。真正的平台兜底交给 fallbackForCurrentOs()（按 UA 判
  // OS），Mac 即使不走 invoke 也能拿到 screenshot=false 的能力表。
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Tauri')
}

/** 幂等加载：重复调用只发一次 invoke；失败回落全开，不影响桌面端正常使用。 */
export function loadCapabilities(): Promise<PlatformCapabilities> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  if (!inTauri()) {
    // 非 Tauri（含浏览器预览 / UA 不含 Tauri 的 Mac WebView）不可一律 ALL_ON：
    // Mac WKWebView 默认 UA 不含 Tauri，会被误判成浏览器 → 截图/贴图入口全部放出。
    // 按 UA 判 OS 回落：Windows=ALL_ON，macOS=与 Rust 对齐的 Mac 表。同步赋值保证
    // capsReady() 立即为 true，顶栏 / 设置页的 capsReady 守卫不会误隐藏入口。
    cached = fallbackForCurrentOs()
    return Promise.resolve(cached)
  }
  // invoke 超时兜底：任何原因（开发预览的 mock 后端 / WebView 未就绪）导致
  // platform_capabilities 久挂不回时，也必须让 cached 落地、capsReady() 转 true，
  // 否则顶栏截图图标与设置页截图快捷键会被 capsReady 守卫永久隐藏。
  const withTimeout = Promise.race<PlatformCapabilities>([
    invoke<PlatformCapabilities>('platform_capabilities'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('platform_capabilities timeout')), 2500),
    ),
  ])
  pending = withTimeout
    .then((caps) => {
      cached = caps
      return caps
    })
    .catch(() => {
      cached = fallbackForCurrentOs()
      return cached
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** 同步读取能力表。未加载完成时按 UA 回落平台正确表：
 *  Windows→ALL_ON(screenshot=true)、macOS→screenshot=false 的 Mac 表。
 *  ⚠️ 绝不无条件回落 ALL_ON——那会让 Mac 首帧闪出截图入口。
 *  由于回落表已按 UA 给出平台正确值，调用方无需再等 capsReady()（该门控已废弃移除）。 */
export function caps(): PlatformCapabilities {
  return cached ?? fallbackForCurrentOs()
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
