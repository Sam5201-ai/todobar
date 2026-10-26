import { describe, expect, it, vi } from 'vitest'
import { MapStore, type TaskRepository } from '../db/repository'
import { createTask } from '../types'
import { SyncEngine } from './engine'
import { taskToWire, type SyncClient } from './client'

function makeClient(opts: { onPull?: (since: string | null) => any[] } = {}): SyncClient & {
  pushes: { tasks: any[]; deleted: string[] }[]
  pulls: (string | null)[]
} {
  const client: any = {
    pushes: [],
    pulls: [],
    async push(tasks: any[], deleted: string[]) {
      client.pushes.push({ tasks: tasks.map(taskToWire), deleted })
      return { server_now: 'SVR_NOW', accepted: tasks.length, removed: deleted.length }
    },
    async pull(since: string | null) {
      client.pulls.push(since)
      return {
        server_now: 'SVR_NOW',
        tasks: opts.onPull ? opts.onPull(since) : [],
        birthdays: [],
      }
    },
  }
  return client
}

describe('SyncEngine', () => {
  it('drains the outbox on push and clears it', async () => {
    const repo: TaskRepository = new MapStore()
    await repo.init()
    const t = createTask('today', 'Buy milk')
    await repo.saveTask(t)

    const client = makeClient()
    const engine = new SyncEngine(repo, client)
    await engine.push()

    expect(client.pushes).toHaveLength(1)
    expect(client.pushes[0].tasks[0].id).toBe(t.id)
    const outbox = await repo.getOutbox()
    expect(outbox).toHaveLength(0)
    const state = await repo.getSyncState()
    expect(state.lastPushAt).toBe('SVR_NOW')
    expect(state.pending).toBe(0)
    expect(state.status).toBe('idle')
  })

  it('reports an error state when the network fails', async () => {
    const repo: TaskRepository = new MapStore()
    await repo.init()
    await repo.saveTask(createTask('today', 'x'))
    const failing: SyncClient = {
      push: async () => {
        throw new Error('network down')
      },
      pull: async () => ({ server_now: '', tasks: [] }),
    }
    const engine = new SyncEngine(repo, failing)
    await expect(engine.push()).rejects.toThrow('network down')
    const state = await repo.getSyncState()
    expect(state.status).toBe('error')
    expect(state.lastError).toBe('network down')
  })

  it('merges only newer pulled tasks (Last-Write-Wins)', async () => {
    const repo: TaskRepository = new MapStore()
    await repo.init()
    const base = 1_700_000_000_000
    const local = createTask('today', 'local', { updatedAt: new Date(base + 1000).toISOString() })
    await repo.saveTask(local)

    const wireNewer = taskToWire(
      createTask('today', 'remote-newer', { id: local.id, updatedAt: new Date(base + 2000).toISOString() }),
    )
    const wireOlder = taskToWire(
      createTask('today', 'remote-older', { id: local.id, updatedAt: new Date(base).toISOString() }),
    )

    const client = makeClient({ onPull: (since) => (since === null ? [wireNewer] : [wireOlder]) })
    const engine = new SyncEngine(repo, client)

    await engine.pull(null)
    let stored = (await repo.getAllTasks()).find((t) => t.id === local.id)!
    expect(stored.title).toBe('remote-newer')

    await engine.pull('SVR_NOW')
    stored = (await repo.getAllTasks()).find((t) => t.id === local.id)!
    expect(stored.title).toBe('remote-newer') // older pull must NOT overwrite
  })

  it('pulls incrementally using lastPullAt on repeated syncOnce', async () => {
    const repo: TaskRepository = new MapStore()
    await repo.init()
    const client = makeClient()
    const engine = new SyncEngine(repo, client)

    await engine.syncOnce()
    expect(client.pulls[0]).toBe(null) // first pull is a full fetch

    await engine.syncOnce()
    expect(client.pulls[1]).toBe('SVR_NOW') // subsequent pull is incremental
  })

  it('auto-sync interval drives syncOnce', async () => {
    vi.useFakeTimers()
    const repo: TaskRepository = new MapStore()
    await repo.init()
    const client = makeClient()
    const engine = new SyncEngine(repo, client)
    const spy = vi.spyOn(engine, 'syncOnce')
    engine.startAuto(5)
    expect(engine.isAuto).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(spy).toHaveBeenCalledTimes(1)
    engine.stopAuto()
    vi.useRealTimers()
  })
})
