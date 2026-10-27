import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// account 模块 import 时会读取 window.localStorage / crypto(node 环境不存在),
// 先注入最小浏览器环境再动态 import,使本地登录态路径可被测试覆盖。
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

const ACCOUNT_KEY = 'ticktask.account'

function seedAccount(patch: Record<string, unknown> = {}): void {
  const acc = {
    email: 'me@example.com',
    token: 'tok',
    uid: 'u_test',
    deviceId: 'dev',
    activated: false,
    trialEndsAt: '2026-10-20T00:00:00.000Z',
    nickname: null,
    avatar: null,
    ...patch,
  }
  storage.setItem(ACCOUNT_KEY, JSON.stringify(acc))
}

function readAccount(): any {
  return JSON.parse(storage.getItem(ACCOUNT_KEY) as string)
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  ;(globalThis as any).fetch = vi.fn((input: string) => Promise.resolve(handler(String(input))))
}

function meResponse(user: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ user, devices: 1 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let storage: MemStorage

beforeEach(() => {
  storage = new MemStorage()
  // account.ts 读裸 localStorage(浏览器里两者同一对象),node 环境两处都注入
  ;(globalThis as any).localStorage = storage
  ;(globalThis as any).window = {
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 'uuid-test' },
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshAccount(会员状态云端对齐)', () => {
  it('后台激活后:合并云端 activated=true 并写回本地登录态', async () => {
    seedAccount({ activated: false })
    mockFetch(() =>
      meResponse({
        email: 'me@example.com',
        activated: true,
        trialEndsAt: '2026-10-20T00:00:00.000Z',
        nickname: '我',
        avatar: null,
      }),
    )
    const { refreshAccount, loadAccount } = await import('./account')
    const next = await refreshAccount()
    expect(next?.activated).toBe(true)
    expect(loadAccount()?.activated).toBe(true)
    expect(readAccount().activated).toBe(true)
  })

  it('云端与本地一致:不重复写库,返回原值', async () => {
    seedAccount({ activated: true })
    const setSpy = vi.spyOn(storage, 'setItem')
    mockFetch(() =>
      meResponse({
        email: 'me@example.com',
        activated: true,
        trialEndsAt: '2026-10-20T00:00:00.000Z',
        nickname: null,
        avatar: null,
      }),
    )
    const { refreshAccount } = await import('./account')
    const next = await refreshAccount()
    expect(next?.activated).toBe(true)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('旧格式登录态缺 uid:借 /me 响应回填,不影响会员字段', async () => {
    seedAccount({ uid: undefined, activated: true })
    const meUser = {
      id: 'u_backfill',
      email: 'me@example.com',
      activated: true,
      trialEndsAt: '2026-10-20T00:00:00.000Z',
      nickname: null,
      avatar: null,
    }
    mockFetch(() => meResponse(meUser))
    const { refreshAccount, loadAccount } = await import('./account')
    const next = await refreshAccount()
    expect(next?.uid).toBe('u_backfill')
    expect(loadAccount()?.uid).toBe('u_backfill')
    expect(next?.activated).toBe(true)
  })

  it('网络异常:静默保留本地态(仍显示试用,不报错)', async () => {
    seedAccount({ activated: false })
    ;(globalThis as any).fetch = vi.fn(() => Promise.reject(new Error('offline')))
    const { refreshAccount } = await import('./account')
    const next = await refreshAccount()
    expect(next?.activated).toBe(false)
    expect(readAccount().activated).toBe(false)
  })

  it('未登录:直接返回 null,不发请求', async () => {
    const fetchSpy = vi.fn()
    ;(globalThis as any).fetch = fetchSpy
    const { refreshAccount } = await import('./account')
    expect(await refreshAccount()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('请求 /api/auth/me 并携带会话令牌', async () => {
    seedAccount({ token: 'tok-123' })
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        meResponse({
          email: 'me@example.com',
          activated: true,
          trialEndsAt: null,
          nickname: null,
          avatar: null,
        }),
      ),
    )
    ;(globalThis as any).fetch = fetchSpy
    const { refreshAccount } = await import('./account')
    await refreshAccount()
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/auth/me')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-123')
    expect(headers['x-sync-token']).toBe('tok-123')
  })
})
