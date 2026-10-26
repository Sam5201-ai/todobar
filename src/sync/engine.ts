import type { TaskRepository } from '../db/repository'
import { wireToBirthday, wireToTask, type PullResult, type SyncClient } from './client'
import { notifyAuthInvalid } from '../account'
import type { SyncState } from '../types'

/** 云端返回 401 说明令牌已失效(过期/被解绑):清掉本地僵尸登录态并广播,
 *  否则账号面板显示"已登录"而同步一直报错,用户无所适从(0.2.8 用户反馈)。 */
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b401\b/.test(msg)
}

/**
 * Offline-first sync engine.
 *
 *  - Local writes always land in the repository first and are queued in the
 *    outbox, so the UI never blocks on the network.
 *  - `push()` drains the outbox to the server (batch upsert + hard-delete list).
 *  - `pull()` fetches everything changed since the last successful pull and
 *    merges with Last-Write-Wins on `updatedAt`.
 *  - The caller drives auto-sync by polling `syncOnce()` on an interval.
 */
export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null
  private repo: TaskRepository
  private client: SyncClient
  /** Optional live-state push so the UI can react mid-sync (spinner / toast). */
  onStateChange?: (state: SyncState) => void

  constructor(repo: TaskRepository, client: SyncClient) {
    this.repo = repo
    this.client = client
  }

  /** 写状态时同步广播给 UI,避免同步过程对界面不可见(图标不转/无提示)。 */
  private async applyState(patch: Partial<SyncState>): Promise<void> {
    await this.repo.setSyncState(patch)
    this.onStateChange?.(await this.repo.getSyncState())
  }

  async push(): Promise<void> {
    const tasks = await this.repo.getOutbox()
    const deleted = await this.repo.getOutboxDeleted()
    const birthdays = await this.repo.getOutboxBirthdays()
    const deletedBirthdays = await this.repo.getOutboxBirthdayDeleted()
    const total = tasks.length + deleted.length + birthdays.length + deletedBirthdays.length
    if (total === 0) {
      // 无待推送内容:保持当前状态不动,后续 pull 仍照常执行
      return
    }
    await this.applyState({ status: 'syncing', pending: total })
    try {
      const res = await this.client.push(tasks, deleted, birthdays, deletedBirthdays)
      await this.repo.clearOutbox(
        tasks.map((t) => t.id),
        deleted,
      )
      await this.repo.clearBirthdayOutbox(
        birthdays.map((b) => b.id),
        deletedBirthdays,
      )
      await this.applyState({
        status: 'idle',
        lastPushAt: res.server_now,
        lastError: null,
        pending: 0,
      })
    } catch (err) {
      if (isAuthError(err)) notifyAuthInvalid()
      await this.applyState({
        status: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  async pull(since: string | null): Promise<void> {
    try {
      const res = await this.client.pull(since)
      for (const wire of res.tasks) {
        await this.repo.mergeTask(wireToTask(wire))
      }
      for (const wire of res.birthdays) {
        await this.repo.mergeBirthday(wireToBirthday(wire))
      }
      await this.applyState({ lastPullAt: res.server_now })
    } catch (err) {
      if (isAuthError(err)) notifyAuthInvalid()
      throw err
    }
  }

  /** 拉取云端全量快照(忽略增量游标),供「恢复云端数据」使用,不做任何合并。 */
  async fetchCloudSnapshot(): Promise<PullResult> {
    return this.client.pull(null)
  }

  /** Push local changes, then pull remote changes incrementally. */
  async syncOnce(): Promise<void> {
    await this.push()
    const state = await this.repo.getSyncState()
    await this.pull(state.lastPullAt)
  }

  startAuto(intervalSec: number): void {
    this.stopAuto()
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => undefined)
    }, Math.max(5, intervalSec) * 1000)
  }

  stopAuto(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  get isAuto(): boolean {
    return this.timer !== null
  }
}
