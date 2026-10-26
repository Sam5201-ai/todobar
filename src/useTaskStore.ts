import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { BrowserStore, SqliteStore, type TaskRepository } from './db/repository'
import {
  createBirthday as makeBirthday,
  createTask as makeTask,
  touch,
  touchBirthday,
  type Birthday,
  type Recurrence,
  type SyncConfig,
  type SyncState,
  type Task,
  type TaskList,
} from './types'
import { parseInstanceId } from './recurrence'
import { SyncEngine } from './sync/engine'
import { createHttpSyncClient, wireToTask, wireToBirthday } from './sync/client'
// 同步地址与令牌在系统层面写死:地址固定为账号体系同源域名,令牌即登录会话令牌。
// 用户无需、也不能手动填写,登录后即自动拥有可用的云端凭据(见 AccountSetting 登录回写)。
import {
  AUTH_BASE,
  ACCOUNT_KEY,
  ACCOUNT_CHANGED_EVENT,
  AUTH_INVALID_EVENT,
  FREE_DAILY_TASK_LIMIT,
  MEMBER_ONLY_TIP,
  isFullAccess,
  loadAccount,
  notifyAuthInvalid,
  refreshAccount,
} from './account'
import { trackAppOpen } from './analytics'

export type CustomList = {
  id: string
  title: string
  tasks: Task[]
  collapsed: boolean
}

/** 「恢复云端数据」的执行结果,供界面给出精确反馈。 */
export type RestoreResult = {
  ok: boolean
  mode?: 'overwrite' | 'merge'
  /** 新增到本地的云端事项条数(merge:云端有本地无;overwrite:云端总数)。 */
  added?: number
  /** 跳过的同名事项(merge 模式下本地已存在,按 ID 去重不重复写入)。 */
  skipped?: number
  /** overwrite 模式下被本地移除的本地独有事项条数。 */
  removed?: number
  /** 失败原因。 */
  reason?: string
}

export function isTauriRuntime(): boolean {
  return (
    new URLSearchParams(window.location.search).get('runtime') === 'tauri' ||
    window.location.protocol === 'tauri:' ||
    navigator.userAgent.includes('Tauri') ||
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window
  )
}

const PRIORITY_CYCLE = ['normal', 'focus', 'later'] as const

/** 本地日期键(YYYY-MM-DD),用于按「当天」统计新建事项数(存 UTC、显本地)。 */
function localDayKey(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- 受限用户「单日新建主任务」配额 ----------------------------------------
//
// 计数独立于事项表:首次启动会写入 5 条示例种子数据,若直接按「今天新建的主任务条数」
// 统计,新用户一上来就撞上限。这里用单独的当日计数器,跨天自动清零。
const QUOTA_KEY = 'ticktask.freeQuota.v1'
type QuotaState = { day: string; used: number }

function todayKey(): string {
  return localDayKey(new Date().toISOString()) ?? ''
}

function loadQuota(): QuotaState {
  const today = todayKey()
  try {
    const raw = localStorage.getItem(QUOTA_KEY)
    if (!raw) return { day: today, used: 0 }
    const q = JSON.parse(raw) as QuotaState
    // 跨天自动清零(计数器只认当天)。
    return q && q.day === today ? q : { day: today, used: 0 }
  } catch {
    return { day: today, used: 0 }
  }
}

/** 受限用户当天已新建的主任务条数。 */
export function readFreeQuotaUsed(): number {
  return loadQuota().used
}

/** 配额 +1(仅受限用户新建主任务成功时调用),返回最新已用条数。 */
function bumpQuota(): number {
  const q = loadQuota()
  const next = { day: q.day, used: q.used + 1 }
  try {
    localStorage.setItem(QUOTA_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式下写入失败不致命 */
  }
  return next.used
}

/** 实时读取当前会员状态:已激活或试用中 = 全功能;未登录 / 试用过期未激活 = 受限。
 *  这里每次调用都现读登录态(而非闭包快照),保证刷新会员状态后立即生效。 */
function hasFullAccess(): boolean {
  return isFullAccess(loadAccount())
}

/**
 * Single source of truth for tasks and lists. Backed by SQLite on the desktop
 * and localStorage in the web preview. Every local write is persisted and
 * queued for the sync engine (offline-first).
 */
export function useTaskStore() {
  const repoRef = useRef<TaskRepository | null>(null)
  const engineRef = useRef<SyncEngine | null>(null)
  const syncDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 镜像「启用同步」开关,供 scheduleSync / triggerSync 在回调内读取最新值,
  // 避免闭包拿到旧的 enabled 状态。
  const syncEnabledRef = useRef(false)

  const [ready, setReady] = useState(false)
  const [allRaw, setAllRaw] = useState<Task[]>([])
  // 受限用户当天已新建主任务条数(界面据此预判是否已达单日上限)。
  const [freeQuotaUsed, setFreeQuotaUsed] = useState(() => readFreeQuotaUsed())
  const [tasks, setTasks] = useState<Task[]>([])
  const [lists, setLists] = useState<TaskList[]>([])
  const [birthdays, setBirthdays] = useState<Birthday[]>([])
  const [syncConfig, setSyncConfigState] = useState<SyncConfig>({
    enabled: false,
    endpoint: '',
    token: '',
    autoSync: true,
    intervalSec: 30,
  })
  const [syncState, setSyncState] = useState<SyncState>({
    status: 'idle',
    lastPushAt: null,
    lastPullAt: null,
    pending: 0,
    lastError: null,
  })

  const reload = useCallback(async (): Promise<void> => {
    const repo = repoRef.current
    if (!repo) return
    const [raw, listsResult, state, birthdayRows] = await Promise.all([
      repo.getAllTasks(),
      repo.getAllLists(),
      repo.getSyncState(),
      repo.getAllBirthdays(),
    ])
    setAllRaw(raw)
    setTasks(raw.filter((t) => !t.deletedAt))
    setLists(listsResult.sort((a, b) => a.position - b.position))
    setSyncState(state)
    setBirthdays(birthdayRows.filter((b) => !b.deletedAt))
  }, [])

  const scheduleSync = useCallback(() => {
    // 产品决策(2026-10-15):关闭「每次增删改都触发同步」,改为仅保留
    // ① 定时自动同步(engine.startAuto)与 ② 手动「立即同步」(triggerSync),
    // 避免高频本地操作无谓消耗 Cloudflare Worker 调用额度。故此处为空实现。
    return
  }, [reload])

  useEffect(() => {
    const repo = isTauriRuntime() ? new SqliteStore() : new BrowserStore()
    repoRef.current = repo

    void (async () => {
      // 桌面端:先从主目录持久化配置恢复「存储位置指针」与「登录态」。
      // 这一步把跨更新存活的状态回灌到内存/缓存,避免更新后 localStorage 被清导致
      // 存储位置回退默认空库、登录态丢失(即 0.2.7 暴露的两类问题)。
      if (isTauriRuntime()) {
        try {
          let pcfg = JSON.parse((await invoke('get_persist_config')) as string) as {
            data_dir?: string | null
            account?: string | null
            legacy_migrated?: boolean
            cache_cleared?: boolean
          }
          // ① 一次性迁移:旧 localStorage 里可能还有上一版留下的指针/登录态,
          //    先抢救进主目录配置,再清缓存(清缓存会抹掉 localStorage)。
          if (!pcfg.legacy_migrated) {
            let legacyDir: string | null = null
            let legacyAcct: string | null = null
            try {
              legacyDir = localStorage.getItem(SqliteStore.DB_DIR_KEY)
              legacyAcct = localStorage.getItem(ACCOUNT_KEY)
            } catch {
              /* 忽略 */
            }
            // ⚠️ Tauri 2 参数命名铁律:JS 侧必须传 camelCase(dataDir/legacyMigrated),
            // 传 snake_case 会被反序列化当缺失参数静默忽略 → 标记永远写不进
            // config.json → 下方 clear_webview_cache **每次启动都执行**,
            // 每次启动都把 localStorage(含截图设置缓存)整个清空。
            await invoke('set_persist_config', {
              dataDir: pcfg.data_dir || legacyDir || '',
              account: pcfg.account || legacyAcct || '',
              legacyMigrated: true,
            }).catch(() => {})
            pcfg = {
              ...pcfg,
              data_dir: pcfg.data_dir || legacyDir,
              account: pcfg.account || legacyAcct,
              legacy_migrated: true,
            }
          }
          // ② 一次性清理 WebView2 缓存:旧版本前端资源被缓存导致更新后界面仍旧
          //    (用户实测:0.2.8 里仍显示早已删除的「同步 (Cloudflare)」标题)。
          if (!pcfg.cache_cleared) {
            await invoke('clear_webview_cache').catch(() => {})
            await invoke('set_persist_config', { cacheCleared: true }).catch(() => {})
          }
          // ③ 把持久化登录态注入 localStorage 缓存,供同步的 loadAccount() 同步读取。
          if (pcfg.account) {
            try {
              localStorage.setItem(ACCOUNT_KEY, pcfg.account)
              // 清缓存会抹掉设备 ID:从持久化账号里恢复,避免设备管理里重复计数。
              const acct = JSON.parse(pcfg.account) as { deviceId?: string }
              if (acct.deviceId) localStorage.setItem('ticktask.deviceId', acct.deviceId)
            } catch {
              /* 忽略 */
            }
          }
          // ④ 重建 junction / 决定连接路径(更新后即使 localStorage 丢失也能自愈)。
          const dbKey = (await invoke('init_data_dir')) as string
          SqliteStore.setDbKey(dbKey)
          SqliteStore.setDataDir(pcfg.data_dir ?? null)
        } catch (e) {
          console.warn('[bootstrap] 持久化配置恢复失败,回退默认:', e)
        }
      }

      await repo.init()
      // 历史缺陷修复:旧版本对重复事项的虚拟实例执行「修改/重命名」时,会把
      // 运行期实例(id 带 @)当作真实任务落库。这些副本勾选永远不生效,启动时清理。
      for (const t of await repo.getAllTasks()) {
        if (t.id.includes('@')) await repo.purgeTask(t.id)
      }
      // 仅在「默认库且确为空」时塞示例数据;自定义存储位置下不污染用户目录。
      const customDir = SqliteStore.getDataDir()
      if ((await repo.getAllTasks()).length === 0 && !customDir) {
        const seeds: Task[] = [
          makeTask('today', '设计侧栏框架', { meta: '今天', priority: 'focus' }),
          makeTask('today', '验证桌面快捷键', { meta: '原生钩子' }),
          makeTask('today', '收集收件箱', { meta: '快速添加', done: true }),
          makeTask('month', '开源路线图', { meta: '里程碑 0.1', priority: 'focus' }),
          makeTask('month', '随手记点灵感', { meta: '稍后', priority: 'later' }),
        ]
        for (const t of seeds) await repo.saveTask(t)
      }
      const cfg = await repo.getSettings()
      // 自愈:登录态还在(持久化恢复),但当前库的同步开关是关的(如更新后
      // 换了空库/设置丢失)。有账号就自动用账号令牌把同步重新打开,
      // 消除「账号区显示已登录、点同步却提示请先登录」的割裂状态(0.2.8 反馈)。
      const bootAccount = loadAccount()
      if (bootAccount?.token && (!cfg.enabled || !cfg.token)) {
        cfg.enabled = true
        cfg.endpoint = AUTH_BASE
        cfg.token = bootAccount.token
        await repo.saveSettings(cfg)
      }
      setSyncConfigState(cfg)
      syncEnabledRef.current = cfg.enabled
      await reload()
      const engine = new SyncEngine(
        repo,
        createHttpSyncClient(AUTH_BASE, loadAccount()?.token ?? cfg.token),
      )
      engine.onStateChange = setSyncState
      engineRef.current = engine
      // 会员闸门:未激活(且非试用)用户不上传云端、不从云端恢复,故不启动定时同步。
      if (cfg.enabled && hasFullAccess()) {
        engine.startAuto(cfg.autoSync ? cfg.intervalSec : 0)
        // 新设备/空库首次联网:自动从云端补齐缺失数据(只增不删,本地多出的不动)。
        const st = await repo.getSyncState()
        if (!st.lastPullAt) void autoFillFromCloud()
      }
      // 埋点:app_open(每次)+ install(仅首次),本地队列异步批量上报,不阻塞启动
      trackAppOpen()
      // 会员状态静默刷新:后台激活/兑换后,下次启动本地登录态即与云端对齐(失败无感知)
      void refreshAccount()
      setReady(true)
    })()

    // 令牌失效(云端 401,如密码修改/设备被解绑/会话过期):账号面板与同步开关
    // 一并回到未登录态,消除「显示已登录但同步一直失败」的割裂(0.2.9 修复)。
    const onAuthInvalid = () => {
      syncEnabledRef.current = false
      setSyncConfigState((prev) => ({ ...prev, enabled: false, token: '' }))
      const repo = repoRef.current
      if (repo)
        void repo.getSettings().then((cur) => repo.saveSettings({ ...cur, enabled: false, token: '' }))
      engineRef.current?.stopAuto()
    }
    window.addEventListener(AUTH_INVALID_EVENT, onAuthInvalid)

    return () => {
      window.removeEventListener(AUTH_INVALID_EVENT, onAuthInvalid)
      engineRef.current?.stopAuto()
      if (syncDebounce.current) clearTimeout(syncDebounce.current)
    }
  }, [reload])

  // 会员状态联动:登录/登出/激活/试用到期都会广播 ACCOUNT_CHANGED_EVENT,
  // 此处据此启停定时同步——受限用户不向云端上传、不从云端恢复;恢复权限后自动接着同步。
  useEffect(() => {
    if (!ready) return
    const apply = () => {
      if (!hasFullAccess()) {
        engineRef.current?.stopAuto()
        return
      }
      if (syncConfig.enabled && syncConfig.autoSync) {
        engineRef.current?.startAuto(syncConfig.intervalSec)
      }
    }
    apply()
    window.addEventListener(ACCOUNT_CHANGED_EVENT, apply)
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, apply)
  }, [ready, syncConfig.enabled, syncConfig.autoSync, syncConfig.intervalSec])

  // ---- task operations -----------------------------------------------------

  const addTask = useCallback(
    (
      listId: string,
      title: string,
      meta = '',
      dueDate: string | null = null,
      recurrence: Recurrence | null = null,
    ) => {
      const repo = repoRef.current
      if (!repo) return null
      if (!title.trim()) return null
      // 会员闸门:受限用户单日新建主任务上限(子任务/下级不计入,由 addSubtask 单独拦截)。
      const limited = !hasFullAccess()
      if (limited && readFreeQuotaUsed() >= FREE_DAILY_TASK_LIMIT) return null
      const task = makeTask(listId, title.trim(), { meta, dueDate })
      // 带重复规则的任务存为「模板」:不落具体日期,由运行时投影出实例。
      if (recurrence) {
        task.recurrence = recurrence
        task.dueDate = null
        task.listId = 'recurring'
        task.completedDates = []
      }
      if (limited) setFreeQuotaUsed(bumpQuota())
      void repo
        .saveTask(task)
        .catch((e) => console.error('[todobar] 新建任务失败:', e))
        .then(() => {
          void reload()
          scheduleSync()
        })
      return task
    },
    [reload, scheduleSync],
  )

  const updateTask = useCallback(
    (task: Task) => {
      const repo = repoRef.current
      if (!repo) return
      // 虚拟实例(重复事项的某次发生,id 形如 模板id@YYYY-MM-DD)不是独立记录,
      // 禁止落库:否则会生成一条勾选永远不生效的脏数据副本(历史缺陷根因)。
      if (task.id.includes('@')) return
      void repo
        .saveTask(touch(task, {}))
        .catch((e) => console.error('[todobar] 保存任务失败:', e))
        .then(() => {
          void reload()
          scheduleSync()
        })
    },
    [reload, scheduleSync],
  )

  const updateListTasks = useCallback(
    (listId: string, updater: (listTasks: Task[]) => Task[]) => {
      const repo = repoRef.current
      if (!repo) return
      const current = tasks.filter((t) => t.listId === listId)
      const next = updater(current)
      void Promise.all(next.map((t) => repo.saveTask(t))).then(() => {
        void reload()
        scheduleSync()
      })
    },
    [tasks, reload, scheduleSync],
  )

  const markOccurrence = useCallback(
    (templateId: string, dateKey: string) => {
      const repo = repoRef.current
      if (!repo) return
      void (async () => {
        const all = await repo.getAllTasks()
        const tpl = all.find((x) => x.id === templateId)
        if (!tpl || !tpl.recurrence) return
        const set = new Set(tpl.completedDates ?? [])
        if (set.has(dateKey)) set.delete(dateKey)
        else set.add(dateKey)
        const next = { ...tpl, completedDates: [...set].sort() }
        await repo.saveTask(next)
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  // 「整组」子任务(挂在重复模板下、会在每个发生日重复显示)的完成状态:
  // 按发生日独立存储在子任务自身的 completedDates 里——勾掉 A 日期的这条子任务,
  // 不影响其他日期的同一条子任务。
  const toggleSubtaskOccurrence = useCallback(
    (subtaskId: string, dateKey: string) => {
      const repo = repoRef.current
      if (!repo) return
      void (async () => {
        const all = await repo.getAllTasks()
        const sub = all.find((x) => x.id === subtaskId)
        if (!sub) return
        const set = new Set(sub.completedDates ?? [])
        if (set.has(dateKey)) set.delete(dateKey)
        else set.add(dateKey)
        await repo.saveTask(touch(sub, { completedDates: [...set].sort() }))
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  // 仅删除某次重复发生日(不影响整组):把该日期写入模板的 deletedDates。
  const deleteOccurrence = useCallback(
    (templateId: string, dateKey: string) => {
      const repo = repoRef.current
      if (!repo) return
      void (async () => {
        const all = await repo.getAllTasks()
        const tpl = all.find((x) => x.id === templateId)
        if (!tpl || !tpl.recurrence) return
        const set = new Set(tpl.deletedDates ?? [])
        set.add(dateKey)
        const next = { ...tpl, deletedDates: [...set].sort() }
        await repo.saveTask(next)
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  // 仅本次隐藏重复事项的某个「整组」子任务:把该发生日写入子任务自身的
  // deletedDates,投影实例 children 时按日期过滤——不影响其他发生日,也不删记录。
  const hideSubtaskOccurrence = useCallback(
    (subtaskId: string, dateKey: string) => {
      const repo = repoRef.current
      if (!repo) return
      void (async () => {
        const all = await repo.getAllTasks()
        const sub = all.find((x) => x.id === subtaskId)
        if (!sub) return
        const set = new Set(sub.deletedDates ?? [])
        set.add(dateKey)
        await repo.saveTask(touch(sub, { deletedDates: [...set].sort() }))
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  // 改名「整组」:直接改模板标题,所有发生日一起变。
  const renameSeries = useCallback(
    (templateId: string, title: string) => {
      const repo = repoRef.current
      if (!repo || !title.trim()) return
      const tpl = tasks.find((x) => x.id === templateId)
      if (!tpl) return
      void repo
        .saveTask(touch(tpl, { title: title.trim() }))
        .catch((e) => console.error('[todobar] 修改重复事项失败:', e))
        .then(() => {
          void reload()
          scheduleSync()
        })
    },
    [tasks, reload, scheduleSync],
  )

  // 改名「仅本次」:把该发生日从模板拆成一条独立的一次性任务(保留原属性,套用新标题),
  // 同时把该日期写入模板 deletedDates,让模板不再投影这一天。
  const renameOccurrenceOnly = useCallback(
    (templateId: string, dateKey: string, title: string) => {
      const repo = repoRef.current
      if (!repo || !title.trim()) return
      void (async () => {
        const all = await repo.getAllTasks()
        const tpl = all.find((x) => x.id === templateId)
        if (!tpl) return
        const deletedDates = Array.from(new Set([...(tpl.deletedDates ?? []), dateKey])).sort()
        await repo.saveTask(touch(tpl, { deletedDates }))
        const standalone = makeTask(tpl.listId, title.trim(), {
          dueDate: dateKey,
          meta: tpl.meta,
          priority: tpl.priority,
          isImportant: tpl.isImportant,
          isPinned: tpl.isPinned,
          remindAt: tpl.remindAt ?? null,
          done: (tpl.completedDates ?? []).includes(dateKey),
        })
        await repo
          .saveTask(standalone)
          .catch((e) => console.error('[todobar] 拆分重复事项失败:', e))
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  const toggleDone = useCallback(
    (id: string) => {
      // 重复事项的虚拟实例:勾选只影响该发生日的完成态,写回模板 completedDates。
      const inst = parseInstanceId(id)
      if (inst) {
        markOccurrence(inst.templateId, inst.dateKey)
        return
      }
      const t = tasks.find((x) => x.id === id)
      if (t) updateTask({ ...t, done: !t.done })
    },
    [tasks, updateTask, markOccurrence],
  )

  const cyclePriority = useCallback(
    (id: string) => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return
      const idx = PRIORITY_CYCLE.indexOf(t.priority)
      const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]
      updateTask({ ...t, priority: next })
    },
    [tasks, updateTask],
  )

  const setImportant = useCallback(
    (id: string, value: boolean) => {
      const t = tasks.find((x) => x.id === id)
      if (t) updateTask({ ...t, isImportant: value })
    },
    [tasks, updateTask],
  )

  const setPinned = useCallback(
    (id: string, value: boolean) => {
      const t = tasks.find((x) => x.id === id)
      if (t) updateTask({ ...t, isPinned: value })
    },
    [tasks, updateTask],
  )

  const setRemindAt = useCallback(
    (id: string, value: string | null) => {
      // 会员闸门:受限用户不能「新增/修改」提醒时间,但允许清除已有提醒
      // (历史数据保留原则:可删不可增,避免用户被卡在已设提醒里)。
      if (value !== null && !hasFullAccess()) return
      const t = tasks.find((x) => x.id === id)
      if (t) updateTask({ ...t, remindAt: value })
    },
    [tasks, updateTask],
  )

  const setDueDate = useCallback(
    (id: string, value: string | null) => {
      const t = tasks.find((x) => x.id === id)
      if (t) updateTask({ ...t, dueDate: value })
    },
    [tasks, updateTask],
  )

  /** 设置处理日期区间:dueDate 为开始日,dueEndDate 为结束日(早于开始日时收敛为同日)。 */
  const setDueRange = useCallback(
    (id: string, due: string | null, end: string | null) => {
      const t = tasks.find((x) => x.id === id)
      if (!t) return
      let dueEnd: string | null = null
      if (due && end) {
        dueEnd = new Date(end).getTime() < new Date(due).getTime() ? due : end
      }
      updateTask({ ...t, dueDate: due, dueEndDate: dueEnd })
    },
    [tasks, updateTask],
  )

  const addSubtask = useCallback(
    (parentId: string, title: string) => {
      const repo = repoRef.current
      if (!repo || !title.trim()) return null
      // 会员闸门:受限用户不能添加子任务。
      if (!hasFullAccess()) return null
      const parent = tasks.find((x) => x.id === parentId)
      // 重复事项的虚拟实例(id 形如 模板id@日期)不在真实任务表里,但子任务仍可挂载:
      // - parentId = 实例 id  → 仅本次发生日显示该子任务;
      // - parentId = 模板 id  → 该子任务在所有发生日显示(整组)。
      // 因此这里不再强制要求 parent 一定存在于 tasks。
      const listId = parent?.listId ?? 'today'
      const task = makeTask(listId, title.trim(), { parentId })
      void repo
        .saveTask(task)
        .catch((e) => console.error('[todobar] 添加子任务失败:', e))
        .then(() => {
          void reload()
          scheduleSync()
        })
      return task
    },
    [tasks, reload, scheduleSync],
  )

  // 直接基于父任务对象创建下级(不依赖最新 state,支持级联创建)
  const addChildTask = useCallback(
    (parent: Task, title: string) => {
      const repo = repoRef.current
      if (!repo || !title.trim()) return null
      // 会员闸门:受限用户不能添加下级(与 addSubtask 同一口径)。
      if (!hasFullAccess()) return null
      const task = makeTask(parent.listId, title.trim(), { parentId: parent.id })
      void repo.saveTask(task).then(() => {
        void reload()
        scheduleSync()
      })
      return task
    },
    [reload, scheduleSync],
  )

  // 拖拽排序:按给定顺序重排同级列表,为每个任务写入 sortOrder
  const reorderTasks = useCallback(
    (orderedIds: string[]) => {
      const repo = repoRef.current
      if (!repo) return
      const updates = orderedIds
        .map((id, index) => {
          const t = tasks.find((x) => x.id === id)
          if (!t) return null
          if (t.sortOrder === index) return null
          return touch(t, { sortOrder: index })
        })
        .filter((t): t is Task => t !== null)
      if (updates.length === 0) return
      void repo.saveTasks(updates).then(() => {
        void reload()
        scheduleSync()
      })
    },
    [tasks, reload, scheduleSync],
  )

  const deleteTask = useCallback(
    (id: string) => {
      const repo = repoRef.current
      if (!repo) return
      const at = new Date().toISOString()
      const targets = allRaw.filter((t) => t.id === id || t.parentId === id)
      void Promise.all(targets.map((t) => repo.deleteTask(t.id, at))).then(() => {
        void reload()
        scheduleSync()
      })
    },
    [allRaw, reload, scheduleSync],
  )

  const purgeTask = useCallback(
    (id: string) => {
      const repo = repoRef.current
      if (!repo) return
      void repo.purgeTask(id).then(() => void reload())
    },
    [reload],
  )

  const restoreTask = useCallback(
    (id: string) => {
      const repo = repoRef.current
      if (!repo) return
      const t = allRaw.find((x) => x.id === id)
      if (!t) return
      void repo.saveTask(touch(t, { deletedAt: null })).then(() => {
        void reload()
        scheduleSync()
      })
    },
    [allRaw, reload, scheduleSync],
  )

  // ---- list operations -----------------------------------------------------

  const listMeta = useCallback(
    (id: string) => lists.find((l) => l.id === id),
    [lists],
  )

  const setListCollapsed = useCallback(
    (id: string, collapsed: boolean) => {
      const repo = repoRef.current
      const meta = listMeta(id)
      if (!repo || !meta) return
      void repo.saveList({ ...meta, collapsed }).then(() => void reload())
    },
    [listMeta, reload],
  )

  const addList = useCallback(
    (title: string) => {
      const repo = repoRef.current
      if (!repo || !title.trim()) return
      const id = makeTask('x', '').id
      void repo
        .saveList({
          id,
          title: title.trim(),
          kind: 'custom',
          collapsed: false,
          position: lists.length,
        })
        .then(() => void reload())
    },
    [lists.length, reload],
  )

  const deleteList = useCallback(
    (id: string) => {
      const repo = repoRef.current
      if (!repo) return
      void repo.deleteList(id).then(() => void reload())
    },
    [reload],
  )

  // ---- birthday operations -------------------------------------------------
  //
  // 生日记录不做本地 seed,列表为空即为正常的空态。

  const addBirthday = useCallback(
    (patch: Partial<Birthday>) => {
      const repo = repoRef.current
      if (!repo) return null
      // 会员闸门:受限用户不能新增生日 / 纪念日(已有的仍可查看与编辑)。
      if (!hasFullAccess()) return null
      const birthday = makeBirthday(patch)
      if (!birthday.name.trim()) return null
      void repo.saveBirthday(birthday).then(() => {
        void reload()
        scheduleSync()
      })
      return birthday
    },
    [reload, scheduleSync],
  )

  const updateBirthday = useCallback(
    (id: string, patch: Partial<Birthday>) => {
      const repo = repoRef.current
      if (!repo) return
      void (async () => {
        const current = (await repo.getAllBirthdays()).find((b) => b.id === id)
        if (!current) return
        await repo.saveBirthday(touchBirthday(current, patch))
        await reload()
        scheduleSync()
      })()
    },
    [reload, scheduleSync],
  )

  const deleteBirthday = useCallback(
    (id: string) => {
      const repo = repoRef.current
      if (!repo) return
      void repo.deleteBirthday(id, new Date().toISOString()).then(() => {
        void reload()
        scheduleSync()
      })
    },
    [reload, scheduleSync],
  )

  // ---- sync configuration --------------------------------------------------

  const setSyncConfig = useCallback(
    (patch: Partial<SyncConfig>) => {
      const repo = repoRef.current
      setSyncConfigState((prev) => {
        const next = { ...prev, ...patch }
        if (repo) void repo.saveSettings(next)
        const wasEnabled = syncEnabledRef.current
        syncEnabledRef.current = next.enabled
        engineRef.current?.stopAuto()
        if (next.enabled) {
          engineRef.current = new SyncEngine(
            repo!,
            createHttpSyncClient(AUTH_BASE, loadAccount()?.token ?? next.token),
          )
          // 会员闸门:受限用户不自动上传云端(其启停还由上面的会员联动 effect 兜底)。
          if (next.autoSync && hasFullAccess()) engineRef.current.startAuto(next.intervalSec)
          // 登录成功(同步从关到开)后自动从云端补齐缺失数据:
          // 换设备/重装/清库后登录,无需手动点「恢复云端数据」即可拿回云端事项。
          // 只增不删:本地多出的数据保留,云端已删除的墓碑不会复活。
          if (!wasEnabled && next.enabled) {
            window.setTimeout(() => void autoFillFromCloud(), 300)
          }
        }
        return next
      })
    },
    // autoFillFromCloud 通过闭包引用(useEffect 同理,运行时已初始化)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const triggerSync = useCallback(() => {
    const repo = repoRef.current
    if (!repo) return
    // 关闭「启用同步」时,手动同步也不应触发。
    if (!syncEnabledRef.current) return
    // 会员闸门:受限用户(未登录 / 试用过期未激活)不能上传云端。
    if (!hasFullAccess()) return
    // 写状态的同时刷新界面 state,保证图标动画与 toast 能即时反馈
    const pushState = async (patch: Partial<SyncState>) => {
      await repo.setSyncState(patch)
      setSyncState(await repo.getSyncState())
    }
    void (async () => {
      await pushState({ status: 'syncing' })
      try {
        await engineRef.current?.syncOnce()
        await pushState({ status: 'idle', lastError: null })
      } catch (err) {
        await pushState({
          status: 'error',
          lastError: err instanceof Error ? err.message : String(err),
        })
      }
      await reload()
    })()
  }, [reload])

  /**
   * 「恢复云端数据」:从云端拉取全量快照并落到本地。
   * - mode='overwrite':云端完整覆盖本地——本地独有事项被移除,云端全部写入本地;
   *   本地仅做硬删除并清理出站,不会把删除回推到云端(云端不丢数据)。
   * - mode='merge':在现有基础上添加——仅写入「云端有、本地无」的事项;
   *   本地已存在的同名事项(按事项 ID 判断)直接跳过,绝不产生重复两条。
   * 两种模式均会清理出站队列,避免恢复下来的数据被原样回推到云端浪费额度。
   * 注意:云端快照包含软删除墓碑(deleted_at 非空,用于跨设备传播删除),
   * 恢复时一律过滤——已删除的事项绝不"复活"回本地(0.2.9 修复)。
   * 前置条件:必须已启用同步(有云端凭据);否则直接返回失败原因。
   */
  const restoreFromCloud = useCallback(
    async (mode: 'overwrite' | 'merge'): Promise<RestoreResult> => {
      const repo = repoRef.current
      const engine = engineRef.current
      if (!repo || !engine) return { ok: false, reason: '本地数据未就绪' }
      // 会员闸门:受限用户不能从云端恢复数据(上传/下载双向限制)。
      if (!hasFullAccess()) return { ok: false, reason: MEMBER_ONLY_TIP }
      if (!syncEnabledRef.current) return { ok: false, reason: '尚未开启云同步' }
      const pushState = async (patch: Partial<SyncState>) => {
        await repo.setSyncState(patch)
        setSyncState(await repo.getSyncState())
      }
      await pushState({ status: 'syncing' })
      try {
        const snapshot = await engine.fetchCloudSnapshot()
        const cloudTasks = snapshot.tasks.map(wireToTask).filter((t) => !t.deletedAt)
        const cloudBirthdays = snapshot.birthdays.map(wireToBirthday).filter((b) => !b.deletedAt)
        const cloudTaskIds = new Set(cloudTasks.map((t) => t.id))
        const cloudBdIds = new Set(cloudBirthdays.map((b) => b.id))

        if (mode === 'overwrite') {
          const localTasks = await repo.getAllTasks()
          const localBirthdays = await repo.getAllBirthdays()
          const localOnlyTasks = localTasks.filter((t) => !cloudTaskIds.has(t.id))
          const localOnlyBd = localBirthdays.filter((b) => !cloudBdIds.has(b.id))
          // 本地独有事项:硬删本地(不入删除出站,避免误删云端)。
          for (const t of localOnlyTasks) await repo.purgeTask(t.id)
          for (const b of localOnlyBd) await repo.purgeBirthday(b.id)
          // 云端全部覆盖写入本地。
          for (const t of cloudTasks) await repo.saveTask(t)
          for (const b of cloudBirthdays) await repo.saveBirthday(b)
          // 清理出站:恢复下来的数据不应再被推回云端。
          const touchedTasks = [...cloudTaskIds, ...localOnlyTasks.map((t) => t.id)]
          const touchedBd = [...cloudBdIds, ...localOnlyBd.map((b) => b.id)]
          await repo.clearOutbox(touchedTasks, touchedTasks)
          await repo.clearBirthdayOutbox(touchedBd, touchedBd)
          await pushState({ status: 'idle', lastError: null })
          await reload()
          return {
            ok: true,
            mode,
            added: cloudTasks.length,
            removed: localOnlyTasks.length,
          }
        }

        // merge:仅添加「云端有、本地无」;本地已存在的按 ID 跳过,不产生重复。
        const localTasks = await repo.getAllTasks()
        const localIds = new Set(localTasks.map((t) => t.id))
        const localBirthdays = await repo.getAllBirthdays()
        const localBdIds = new Set(localBirthdays.map((b) => b.id))
        const addedTasks = cloudTasks.filter((t) => !localIds.has(t.id))
        const addedBd = cloudBirthdays.filter((b) => !localBdIds.has(b.id))
        for (const t of addedTasks) await repo.saveTask(t)
        for (const b of addedBd) await repo.saveBirthday(b)
        const addedIds = addedTasks.map((t) => t.id)
        const addedBdIds = addedBd.map((b) => b.id)
        await repo.clearOutbox(addedIds, addedIds)
        await repo.clearBirthdayOutbox(addedBdIds, addedBdIds)
        await pushState({ status: 'idle', lastError: null })
        await reload()
        return {
          ok: true,
          mode,
          added: addedTasks.length,
          skipped: cloudTasks.length - addedTasks.length,
        }
      } catch (err) {
        await pushState({
          status: 'error',
          lastError: err instanceof Error ? err.message : String(err),
        })
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    },
    [reload],
  )

  /**
   * 登录后/新设备首次同步时自动从云端补齐缺失数据(只增不删)。
   * - 云端有、本地无 → 写入本地;
   * - 本地已有(按 ID 判断) → 跳过,绝不产生重复;
   * - 云端已删除的墓碑(deleted_at 非空) → 跳过,绝不把已删数据"复活";
   * - 本地多出的数据 → 原样保留,不覆盖不剔除。
   * 全程静默(不改同步状态灯),失败仅控制台告警;供登录回调与启动自愈调用。
   */
  const autoFillFromCloud = useCallback(async (): Promise<RestoreResult> => {
    const repo = repoRef.current
    if (!repo) return { ok: false, reason: '本地数据未就绪' }
    const account = loadAccount()
    if (!account?.token) return { ok: false, reason: '未登录' }
    // 会员闸门:受限用户不做云端补齐(登录后的自动恢复同样受限)。
    if (!hasFullAccess()) return { ok: false, reason: MEMBER_ONLY_TIP }
    try {
      const client = createHttpSyncClient(AUTH_BASE, account.token)
      const snapshot = await client.pull(null)
      // 过滤云端墓碑:已删除的事项不参与补齐。
      const cloudTasks = snapshot.tasks.map(wireToTask).filter((t) => !t.deletedAt)
      const cloudBirthdays = snapshot.birthdays.map(wireToBirthday).filter((b) => !b.deletedAt)
      const localTasks = await repo.getAllTasks()
      const localIds = new Set(localTasks.map((t) => t.id))
      const localBirthdays = await repo.getAllBirthdays()
      const localBdIds = new Set(localBirthdays.map((b) => b.id))
      const addedTasks = cloudTasks.filter((t) => !localIds.has(t.id))
      const addedBd = cloudBirthdays.filter((b) => !localBdIds.has(b.id))
      if (addedTasks.length > 0 || addedBd.length > 0) {
        for (const t of addedTasks) await repo.saveTask(t)
        for (const b of addedBd) await repo.saveBirthday(b)
        // 清理出站:补齐的数据不应被原样回推浪费额度。
        const addedIds = addedTasks.map((t) => t.id)
        const addedBdIds = addedBd.map((b) => b.id)
        await repo.clearOutbox(addedIds, addedIds)
        await repo.clearBirthdayOutbox(addedBdIds, addedBdIds)
        await reload()
      }
      return { ok: true, mode: 'merge', added: addedTasks.length, skipped: cloudTasks.length - addedTasks.length }
    } catch (err) {
      if (/\b401\b/.test(err instanceof Error ? err.message : String(err))) notifyAuthInvalid()
      console.warn('[autoFill] 云端补齐失败(静默):', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }, [reload])

  // ---- 本地数据目录迁移(设置页「更改存储位置」) ----------------------------
  const closeDbForMigration = useCallback(async (): Promise<void> => {
    const repo = repoRef.current
    if (repo instanceof SqliteStore) await repo.closeForMigration()
  }, [])

  const repointDb = useCallback(async () => {
    const repo = repoRef.current
    if (repo instanceof SqliteStore) await repo.repoint()
  }, [])

  // ---- derived views --------------------------------------------------------

  const today = useMemo(() => tasks.filter((t) => t.listId === 'today'), [tasks])
  const month = useMemo(() => tasks.filter((t) => t.listId === 'month'), [tasks])
  const deleted = useMemo(() => allRaw.filter((t) => t.deletedAt), [allRaw])
  const customLists = useMemo(
    () =>
      lists
        .filter((l) => l.kind === 'custom')
        .map((l) => ({
          id: l.id,
          title: l.title,
          collapsed: l.collapsed,
          tasks: tasks.filter((t) => t.listId === l.id),
        })),
    [lists, tasks],
  )

  return {
    ready,
    today,
    month,
    customLists,
    tasks,
    deleted,
    birthdays,
    freeQuotaUsed,
    syncConfig,
    syncState,
    addTask,
    updateTask,
    updateListTasks,
    toggleDone,
    markOccurrence,
    toggleSubtaskOccurrence,
    deleteOccurrence,
    hideSubtaskOccurrence,
    renameSeries,
    renameOccurrenceOnly,
    cyclePriority,
    setImportant,
    setPinned,
    setRemindAt,
    setDueDate,
    setDueRange,
    addSubtask,
    addChildTask,
    reorderTasks,
    deleteTask,
    purgeTask,
    restoreTask,
    setListCollapsed,
    addList,
    deleteList,
    addBirthday,
    updateBirthday,
    deleteBirthday,
    setSyncConfig,
    triggerSync,
    restoreFromCloud,
    autoFillFromCloud,
    closeDbForMigration,
    repointDb,
  }
}
