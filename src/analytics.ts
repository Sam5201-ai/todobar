// 工具内数据埋点:本地队列 + 批量上报 + 离线重试。
// 设计原则:埋点失败绝不影响任何业务流程——所有 IO 均 try/catch 包裹,
// 队列持久化在 localStorage,网络恢复或下次启动自动补发。
//
// 事件(与后台 Worker ALLOWED_EVENTS 对齐):
//   app_open     每次启动
//   install      首次运行(安装)仅一次
//   page_visit   页面/视图切换(day/week/month/birthday/huangli/calculator/settings)
//   feature_click 关键功能点击(sync/add-task/check-update/…)

import { AUTH_BASE, getDeviceId, loadAccount } from './account'
import { invoke } from '@tauri-apps/api/core'

export type TrackEventName =
  | 'app_open'
  | 'install'
  | 'register'
  | 'auth_timing'
  | 'page_visit'
  | 'feature_click'

export interface TrackEvent {
  event: TrackEventName
  page?: string
  meta?: string
}

const QUEUE_KEY = 'todobar-analytics-queue'
const INSTALLED_KEY = 'todobar-analytics-installed'
const MAX_QUEUE = 200 // 队列上限,超出丢弃最旧事件,防止 localStorage 无限增长
const BATCH_SIZE = 20
const FLUSH_DELAY_MS = 1500 // 首个事件入队后延迟发出,合并短时间内的连续事件
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] // 指数退避,最后一次之后按 5 分钟重试
const RETRY_CAP_MS = 300_000

// 延迟求值:account.ts 也反向引用本模块(trackEvent),模块加载期读取 AUTH_BASE
// 会触发 TDZ,故放到调用时再取。
function trackEndpoint(): string {
  return `${AUTH_BASE}/api/track`
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function loadQueue(): TrackEvent[] {
  const s = safeStorage()
  if (!s) return []
  try {
    const raw = s.getItem(QUEUE_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (e): e is TrackEvent =>
        !!e && typeof e === 'object' && typeof (e as TrackEvent).event === 'string',
    )
  } catch {
    return []
  }
}

function persistQueue(): void {
  const s = safeStorage()
  if (!s) return
  try {
    if (queue.length === 0) s.removeItem(QUEUE_KEY)
    else s.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    /* 存储不可用(隐私模式等):仅内存保留 */
  }
}

/** 匿名访客 ID:复用账号模块的设备 ID(真源 ~/.ticktask/config.json 持久化,
 *  清 WebView 数据/重装后保持不变)。此前本模块自建纯 localStorage 的 ID,
 *  清一次数据就换新身份,导致独立访客数严重虚高(0.4.20 修复)。 */
function currentVisitorId(): string {
  try {
    return getDeviceId()
  } catch {
    // account 模块异常时的兜底:临时 ID(仅当前批次生效)
    return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
  }
}

// 设备硬件指纹(Rust 侧读 MachineGuid 哈希),用于统计口径的"设备去重"。
// 与 register/login 上报的 deviceFingerprint 一致,后端据此做跨设备身份缝合。
let deviceFp: string | null = null
let deviceFpTried = false
function ensureDeviceId(): Promise<string> {
  if (deviceFp !== null) return Promise.resolve(deviceFp)
  if (deviceFpTried) return Promise.resolve('')
  deviceFpTried = true
  return new Promise((resolve) => {
    try {
      invoke('device_fingerprint')
        .then((v) => {
          deviceFp = String(v || '')
          resolve(deviceFp)
        })
        .catch(() => resolve(''))
    } catch {
      resolve('')
    }
  })
}

let queue: TrackEvent[] = loadQueue()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let sending = false
let retryStep = 0
let listenersBound = false

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushAnalytics()
  }, delay)
}

function bindListeners(): void {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true
  // 进入后台/关闭前尽量把已入队事件发出
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAnalytics()
  })
  // 网络恢复立即补发
  window.addEventListener('online', () => void flushAnalytics())
}

/** 记录一个埋点事件(内存 + 持久化,并调度一次批量上报)。 */
export function trackEvent(name: TrackEventName, page?: string, meta?: string): void {
  bindListeners()
  const ev: TrackEvent = { event: name }
  if (page) ev.page = page.slice(0, 40)
  if (meta) ev.meta = meta.slice(0, 120)
  queue.push(ev)
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE)
  persistQueue()
  scheduleFlush()
}

/** 页面访问。 */
export function trackPage(page: string): void {
  trackEvent('page_visit', page)
}

/** 功能点击。 */
export function trackFeature(name: string, meta?: string): void {
  trackEvent('feature_click', name, meta)
}

/**
 * 应用启动埋点:app_open 每次上报;install 仅首次运行上报一次。
 * 应在 store 初始化(本地库就绪)后调用。
 */
export function trackAppOpen(): void {
  const s = safeStorage()
  if (s) {
    try {
      if (!s.getItem(INSTALLED_KEY)) {
        s.setItem(INSTALLED_KEY, '1')
        trackEvent('install', 'app')
      }
    } catch {
      /* ignore */
    }
  }
  trackEvent('app_open', 'app')
}

/**
 * 立即上报队列(最多一批)。成功的一批从队列移除;失败保留并按退避延迟重试。
 * 返回 Promise 供测试/调试 await;业务代码无需关心其结果。
 */
export async function flushAnalytics(): Promise<void> {
  if (sending) return
  if (queue.length === 0) {
    retryStep = 0
    return
  }
  sending = true
  const batch = queue.slice(0, BATCH_SIZE)
  const device = await ensureDeviceId()
  // 已登录事件携带账号 ID:统计口径"已登录按账号去重(跨设备=1)、未登录按设备指纹"
  // 的第一优先依据;未登录为空串,由服务端按设备指纹(或设备↔账号缝合)归并。
  const uid = loadAccount()?.uid || ''
  const payload = {
    source: 'app' as const,
    events: batch.map((e) => ({ ...e, visitor: currentVisitorId(), device, uid })),
  }
  try {
    const res = await fetch(trackEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      queue = queue.slice(batch.length)
      persistQueue()
      retryStep = 0
      sending = false
      if (queue.length > 0) scheduleFlush(300)
      return
    }
    // 4xx(除 429)说明请求本身不被接受,重试无意义,直接丢弃该批
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      queue = queue.slice(batch.length)
      persistQueue()
      retryStep = 0
      sending = false
      if (queue.length > 0) scheduleFlush(300)
      return
    }
    throw new Error(`track failed: ${res.status}`)
  } catch {
    sending = false
    const delay = RETRY_DELAYS_MS[Math.min(retryStep, RETRY_DELAYS_MS.length - 1)]
    retryStep = Math.min(retryStep + 1, RETRY_DELAYS_MS.length)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void flushAnalytics()
    }, Math.min(delay, RETRY_CAP_MS))
  }
}

/** 测试辅助:清空内存队列与持久化(不影响设备身份与 install 标记)。 */
export function __resetAnalyticsForTest(): void {
  queue = []
  persistQueue()
  if (flushTimer) clearTimeout(flushTimer)
  if (retryTimer) clearTimeout(retryTimer)
  flushTimer = null
  retryTimer = null
  sending = false
  retryStep = 0
}
