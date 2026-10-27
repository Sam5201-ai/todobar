import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// analytics 模块在 import 时会读取 window.localStorage(node 环境下不存在),
// 因此先注入最小浏览器环境,再动态 import,使队列持久化路径可被测试覆盖。
class MemStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null
  }
}

const listeners: Record<string, Array<() => void>> = {}

function installBrowserEnv(): MemStorage {
  const storage = new MemStorage()
  ;(globalThis as any).window = {
    localStorage: storage,
    addEventListener: (type: string, fn: () => void) => {
      ;(listeners[type] ||= []).push(fn)
    },
  }
  // account.ts 的 loadAccount 读裸 localStorage(浏览器里与 window.localStorage 同一对象)
  ;(globalThis as any).localStorage = storage
  ;(globalThis as any).document = { visibilityState: 'visible' }
  return storage
}

let storage: MemStorage
let analytics: typeof import('./analytics')

beforeEach(async () => {
  vi.useFakeTimers()
  for (const k of Object.keys(listeners)) delete listeners[k]
  storage = installBrowserEnv()
  analytics = await import('./analytics')
})

afterEach(() => {
  analytics.__resetAnalyticsForTest()
  vi.useRealTimers()
  delete (globalThis as any).window
  delete (globalThis as any).document
})

describe('analytics 埋点队列', () => {
  it('批量上报:多个事件合并为一次 POST,source=app 且带 visitor', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    analytics.trackPage('day')
    analytics.trackFeature('sync')
    // 1.5s 防抖窗口内的连续事件应合并
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/track')
    const body = JSON.parse(String(init.body))
    expect(body.source).toBe('app')
    expect(body.events).toHaveLength(2)
    expect(body.events.map((e: { event: string }) => e.event)).toEqual(['page_visit', 'feature_click'])
    // visitor 复用账号模块的稳定设备 ID(UUID),同一台机器清数据后不变
    expect(typeof body.events[0].visitor).toBe('string')
    expect((body.events[0].visitor as string).length).toBeGreaterThan(0)
    // 未登录:uid 为空串(服务端按设备指纹归并)
    expect(body.events[0].uid).toBe('')
    expect(body.events[0].page).toBe('day')
  })

  it('已登录时事件携带账号 uid(统计按账号去重的依据)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    storage.setItem(
      'ticktask.account',
      JSON.stringify({ email: 'me@example.com', token: 'tok', uid: 'u_abc', deviceId: 'dev' }),
    )
    analytics.trackPage('day')
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.events[0].uid).toBe('u_abc')
  })

  it('队列持久化:事件先落 localStorage,上报成功后清除', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    analytics.trackPage('month')
    const queued = storage.getItem('todobar-analytics-queue')
    expect(queued).toBeTruthy()
    expect(JSON.parse(queued as string)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 成功后队列清空(key 被移除)
    expect(storage.getItem('todobar-analytics-queue')).toBeNull()
  })

  it('断网重试:fetch 失败时队列保留,按退避延迟自动重发', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    analytics.trackPage('week')
    await vi.advanceTimersByTimeAsync(1500) // 触发首次 flush(失败)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 队列仍在
    expect(storage.getItem('todobar-analytics-queue')).toBeTruthy()

    // 退避 5s 后自动重试并成功
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(storage.getItem('todobar-analytics-queue')).toBeNull()
  })

  it('4xx(非 429)直接丢弃该批,不做无意义重试', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    analytics.trackPage('day')
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(storage.getItem('todobar-analytics-queue')).toBeNull()

    // 之后不应再有任何重试
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('install 仅首次运行上报一次,app_open 每次启动都上报', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    analytics.trackAppOpen()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)

    analytics.trackAppOpen()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)

    const events = fetchMock.mock.calls.flatMap(
      (c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).events,
    )
    expect(events.filter((e: { event: string }) => e.event === 'install')).toHaveLength(1)
    expect(events.filter((e: { event: string }) => e.event === 'app_open')).toHaveLength(2)
  })

  it('超过 20 条时分批上报,每批不超过 BATCH_SIZE', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < 25; i++) analytics.trackFeature('f' + i)
    // 第一批立即发出(20 条),剩余 5 条在 300ms 后的下一批
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).events).toHaveLength(20)

    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).events).toHaveLength(5)
    expect(storage.getItem('todobar-analytics-queue')).toBeNull()
  })
})
