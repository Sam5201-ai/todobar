import { beforeEach, describe, expect, it } from 'vitest'
import { cached, invalidate } from './admin-cache'

describe('admin-cache', () => {
  beforeEach(async () => {
    await invalidate(['overview', 'stats', 'codes'])
  })

  it('caches compute result and returns cached=true on second read', async () => {
    let calls = 0
    const compute = async () => ++calls
    const a = await cached('overview', { days: 30 }, false, compute)
    const b = await cached('overview', { days: 30 }, false, compute)
    expect(a.data).toBe(1)
    expect(a.cached).toBe(false)
    expect(b.data).toBe(1)
    expect(b.cached).toBe(true)
    expect(calls).toBe(1)
  })

  it('isolates cache by params', async () => {
    let calls = 0
    const compute = async () => ++calls
    await cached('overview', { days: 30 }, false, compute)
    await cached('overview', { days: 7 }, false, compute)
    expect(calls).toBe(2)
  })

  it('force bypasses cache and overwrites with fresh result', async () => {
    let value = 1
    const compute = async () => value
    await cached('stats', { days: 30 }, false, compute)
    value = 2
    const fresh = await cached('stats', { days: 30 }, true, compute)
    expect(fresh.data).toBe(2)
    expect(fresh.cached).toBe(false)
    const after = await cached('stats', { days: 30 }, false, compute)
    expect(after.data).toBe(2)
    expect(after.cached).toBe(true)
  })

  it('invalidate clears only matching prefix', async () => {
    let calls = 0
    const compute = async () => ++calls
    await cached('codes', { page: 1 }, false, compute)
    await cached('overview', { days: 30 }, false, compute)
    await invalidate(['codes'])
    await cached('codes', { page: 1 }, false, compute)
    await cached('overview', { days: 30 }, false, compute)
    expect(calls).toBe(3) // codes recomputed, overview still cached
  })
})
