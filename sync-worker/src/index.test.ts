import { describe, expect, it } from 'vitest'
import worker from './index'
import { makeD1, makeKV } from '../test/d1-shim.mjs'

async function makeEnv(opts: { apiTokens?: string; kv?: Awaited<ReturnType<typeof makeKV>> } = {}) {
  return {
    DB: await makeD1(),
    API_TOKENS: opts.apiTokens,
    TOKENS: opts.kv,
  } as any
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext
const TOKEN = 'test-token'

function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    list_id: 'today',
    title: 'Write report',
    updated_at: new Date(1_700_000_000_000).toISOString(),
    created_at: new Date(1_700_000_000_000).toISOString(),
    ...over,
  }
}

async function postTasks(env: any, tasks: unknown[], deleted: string[] = []) {
  return worker.fetch(
    new Request('https://x/api/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tasks, deleted }),
    }),
    env,
    ctx,
  )
}

async function getTasks(env: any, since?: string) {
  const url = since ? `https://x/api/tasks?since=${encodeURIComponent(since)}` : 'https://x/api/tasks'
  return worker.fetch(
    new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } }),
    env,
    ctx,
  )
}

describe('auth', () => {
  it('rejects requests without a bearer token', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const res = await worker.fetch(new Request('https://x/api/tasks'), env, ctx)
    expect(res.status).toBe(401)
  })

  it('accepts a token listed in API_TOKENS (env mode)', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const res = await getTasks(env)
    expect(res.status).toBe(200)
  })

  it('maps a KV token to its userId', async () => {
    const kv = makeKV({ [TOKEN]: 'user:alice' })
    const env = await makeEnv({ kv })
    const res = await getTasks(env)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.tasks).toEqual([])
  })

  it('rejects an unknown KV token', async () => {
    const kv = makeKV({ other: 'user:bob' })
    const env = await makeEnv({ kv })
    const res = await getTasks(env)
    expect(res.status).toBe(401)
  })
})

describe('upsert + read', () => {
  it('stores a new task and reads it back', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const res = await postTasks(env, [task()])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accepted).toBe(1)

    const get = await getTasks(env)
    const data = await get.json()
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].title).toBe('Write report')
  })

  it('enforces server-side Last-Write-Wins by updated_at', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const base = 1_700_000_000_000
    const v1 = task({ updated_at: new Date(base + 1000).toISOString(), title: 'v1' })
    const older = task({ updated_at: new Date(base).toISOString(), title: 'OLDER' })
    const newer = task({ updated_at: new Date(base + 2000).toISOString(), title: 'v2' })

    await postTasks(env, [v1])
    // A stale write must NOT overwrite the newer existing row.
    const stale = await postTasks(env, [older])
    expect((await stale.json()).accepted).toBe(1)
    let data = await (await getTasks(env)).json()
    expect(data.tasks[0].title).toBe('v1')

    // A genuinely newer write must win.
    await postTasks(env, [newer])
    data = await (await getTasks(env)).json()
    expect(data.tasks[0].title).toBe('v2')
    expect(data.tasks).toHaveLength(1)
  })
})

describe('incremental pull', () => {
  it('returns only tasks changed after `since`', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const base = 1_700_000_000_000
    await postTasks(env, [
      task({ id: 'a', updated_at: new Date(base).toISOString() }),
      task({ id: 'b', updated_at: new Date(base + 5000).toISOString() }),
    ])
    const since = new Date(base + 3000).toISOString()
    const res = await getTasks(env, since)
    const data = await res.json()
    expect(data.tasks.map((t: any) => t.id)).toEqual(['b'])
  })
})

describe('hard delete', () => {
  it('removes purged rows', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    await postTasks(env, [task({ id: 'a' }), task({ id: 'b' })])
    const del = await postTasks(env, [], ['a'])
    expect((await del.json()).removed).toBe(1)
    const data = await (await getTasks(env)).json()
    expect(data.tasks.map((t: any) => t.id)).toEqual(['b'])
  })
})

describe('settings', () => {
  it('round-trips user settings with LWW', async () => {
    const env = await makeEnv({ apiTokens: TOKEN })
    const put = await worker.fetch(
      new Request('https://x/api/settings', {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ theme: 'dark', panelWidth: 320 }),
      }),
      env,
      ctx,
    )
    expect(put.status).toBe(200)
    const get = await worker.fetch(
      new Request('https://x/api/settings', { headers: { authorization: `Bearer ${TOKEN}` } }),
      env,
      ctx,
    )
    const data = await get.json()
    expect(data.settings).toEqual({ theme: 'dark', panelWidth: 320 })
  })
})
