/**
 * 账号体系(P1)客户端模块:本地保存登录态 + 调用 Worker 的 /api/auth/* 接口。
 *
 * - 登录/注册成功后拿到的「会话令牌」即云同步令牌,登录即自动开启云同步(不再手填 48 位令牌)。
 * - 账号数据按会话令牌隔离,天然不会串。
 * - 发信走 Resend(服务端),客户端只负责调接口。
 */

// 与同步同源:经国内代理即可直连,无需 VPN。若自建后端改这里即可。
export const AUTH_BASE = 'https://todobar-app.app.workbuddy.host'

import { trackEvent } from './analytics'
import { invoke } from '@tauri-apps/api/core'

export const ACCOUNT_KEY = 'ticktask.account'
const DEVICE_KEY = 'ticktask.deviceId'

/** 桌面端:把登录态额外持久化到 Rust 管理的主目录配置文件(跨更新存活)。 */
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 把登录态写入主目录持久化配置(仅 account 字段,不动 data_dir)。失败静默。
 *  注意:传空字符串表示显式清除(Rust 端约定),否则退出登录后重启会"复活"僵尸登录态。 */
export function persistAccountDurable(a: AccountState | null): void {
  if (!IS_TAURI) return
  invoke('set_persist_config', { account: a ? JSON.stringify(a) : '' })
    .then(() => {})
    .catch(() => {})
}

/** 登录态失效(如令牌过期/在其他设备被解绑,云端返回 401)时广播,供账号面板与同步开关回到未登录态。 */
export const AUTH_INVALID_EVENT = 'ticktask-auth-invalid'

export function notifyAuthInvalid(): void {
  saveAccount(null)
  try {
    window.dispatchEvent(new Event(AUTH_INVALID_EVENT))
  } catch {
    /* 忽略 */
  }
}

export interface AccountUser {
  id: string
  email: string
  activated: boolean
  trialEndsAt: string | null
  nickname?: string | null
  avatar?: string | null
}

export interface AccountState {
  email: string
  token: string
  /** 服务端账号 ID(users.id):埋点事件携带,统计口径"已登录按账号去重"的依据。
   *  旧版本持久化数据无此字段(读出为 undefined),埋点侧按空串兜底走设备缝合。 */
  uid?: string
  deviceId: string
  activated: boolean
  trialEndsAt: string | null
  nickname: string | null
  avatar: string | null
}

/**
 * 登录态变更事件:任意 saveAccount(登录/登出/刷新会员状态)都会广播,
 * 供 React 组件经 useAccount() 订阅并实时刷新「是否全功能」判定。
 */
export const ACCOUNT_CHANGED_EVENT = 'ticktask-account-changed'

/** 试用是否有效(存在 trialEndsAt 且未到期)。 */
export function isTrialActive(a: AccountState | null): boolean {
  return !!a && !!a.trialEndsAt && Date.parse(a.trialEndsAt) > Date.now()
}

/** 是否拥有全功能权限:已激活会员,或处于试用期内。
 *  未登录(null)或试用已过期且无激活 = 受限状态(等同于未激活)。 */
export function isFullAccess(a: AccountState | null): boolean {
  return !!a && (a.activated || isTrialActive(a))
}

/** 受限用户(未登录 / 试用过期且未激活)单日可新建的「主任务」条数上限。 */
export const FREE_DAILY_TASK_LIMIT = 3

/** 受限功能统一提示文案(各入口点击后 toast 用)。 */
export const MEMBER_ONLY_TIP = '此为会员功能,开通会员后可无限制使用'

/** 按功能名拼受限提示:「XX为会员功能,开通会员后可无限制使用」。 */
export function memberOnly(feature: string): string {
  return `${feature}为会员功能,开通会员后可无限制使用`
}

export interface DeviceInfo {
  token: string
  deviceName: string | null
  deviceId: string | null
  createdAt: string
  lastSeenAt: string
  current: boolean
}

export interface MeResult {
  user: AccountUser
  devices: number
}

/** 每台设备安装后生成一次、长期保存,用于设备管理里区分不同机器。
 *  真源在 ~/.ticktask/config.json(Rust 持久化),localStorage 仅作同步缓存——
 *  缓存被清后若直接重新生成,同一台机器会被云端当成新设备(0.3.2 修复)。 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
    if (IS_TAURI) {
      // ⚠️ Tauri 2 参数命名:JS 侧必须 camelCase(deviceId),snake_case 会被
      // 当缺失参数静默忽略 → 设备 ID 永远写不进持久化文件(0.4.41 修复)。
      invoke('set_persist_config', { deviceId: id }).catch(() => {})
    }
  }
  return id
}

/** 设备硬件指纹(MachineGuid 哈希),用于统计口径的跨设备身份缝合。失败返回空。 */
export async function getDeviceFingerprint(): Promise<string> {
  if (!IS_TAURI) return ''
  try {
    return String((await invoke('device_fingerprint')) || '')
  } catch {
    return ''
  }
}

// 指纹进程级缓存:device_fingerprint 走 reg query 子进程,登录前串行等待会拖慢
// 首次登录。打开登录弹窗时即预热(warmDeviceFingerprint),登录时直接取缓存结果。
let fingerprintPromise: Promise<string> | null = null

/** 预取设备指纹(幂等,可重复调用;失败按空串处理,不阻塞登录)。 */
export function warmDeviceFingerprint(): void {
  if (!IS_TAURI || fingerprintPromise) return
  fingerprintPromise = getDeviceFingerprint().catch(() => '')
}

function cachedDeviceFingerprint(): Promise<string> {
  warmDeviceFingerprint()
  return fingerprintPromise ?? Promise.resolve('')
}

/**
 * 启动时从主目录持久化配置恢复设备身份与登录态(须在界面挂载前调用):
 * - device_id:localStorage 被清(崩溃/更新/清缓存)后沿用持久化 ID,不再生成新设备;
 * - account:此前只写不读,WebView 数据丢失后等于登出;现在缺失时从文件恢复。
 */
export async function hydrateIdentity(): Promise<void> {
  if (!IS_TAURI) return
  try {
    const pcfg = JSON.parse((await invoke('get_persist_config')) as string) as {
      account?: string | null
      device_id?: string | null
    }
    // 设备 ID:localStorage 优先(运行期真源),缺失时回落持久化文件
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id && pcfg.device_id) {
      id = pcfg.device_id
      localStorage.setItem(DEVICE_KEY, id)
    }
    if (!id) id = getDeviceId() // 两边都没有才真正生成新设备
    if (pcfg.device_id !== id) {
      invoke('set_persist_config', { deviceId: id }).catch(() => {})
    }
    // 登录态:localStorage 有账号但持久化缺失(旧版升级)→ 补写;
    // localStorage 缺失但持久化有 → 恢复(退出登录时两者会同时清空,不会复活僵尸态)。
    const local = localStorage.getItem(ACCOUNT_KEY)
    if (local && !pcfg.account) {
      invoke('set_persist_config', { account: local }).catch(() => {})
    } else if (!local && pcfg.account) {
      try {
        const a = JSON.parse(pcfg.account) as AccountState
        if (a && a.token) localStorage.setItem(ACCOUNT_KEY, pcfg.account)
      } catch {
        /* 持久化内容损坏,忽略 */
      }
    }
  } catch {
    /* 非 Tauri 或读取失败,沿用 localStorage */
  }
}

export function loadAccount(): AccountState | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY)
    if (!raw) return null
    const a = JSON.parse(raw) as AccountState
    if (!a.token) return null
    return a
  } catch {
    return null
  }
}

export function saveAccount(a: AccountState | null): void {
  if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a))
  else localStorage.removeItem(ACCOUNT_KEY)
  // 同步持久化到主目录配置,确保更新后登录态不丢失。
  persistAccountDurable(a)
  // 广播登录态变更(供 useAccount 订阅刷新受限功能判定)。
  try {
    window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT))
  } catch {
    /* 忽略 */
  }
}

/** 携带会话令牌的请求头(经代理时 Authorization 会被剥离,改由 x-sync-token 带回)。 */
function authHeaders(): Record<string, string> {
  const token = loadAccount()?.token
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (token) {
    h['authorization'] = `Bearer ${token}`
    h['x-sync-token'] = token
  }
  return h
}

async function errMsg(res: Response): Promise<string> {
  try {
    const d = (await res.json()) as { error?: unknown }
    if (d && typeof d.error === 'string' && d.error) return d.error
  } catch {
    /* 非 JSON */
  }
  return `请求失败(${res.status})`
}

function toAccount(email: string, data: { token: string; user: AccountUser }): AccountState {
  return {
    email,
    token: data.token,
    uid: data.user.id,
    deviceId: getDeviceId(),
    activated: data.user.activated,
    trialEndsAt: data.user.trialEndsAt,
    nickname: data.user.nickname ?? null,
    avatar: data.user.avatar ?? null,
  }
}

/**
 * 登录/注册/发码耗时打点:体感速度由「网络链路(国内代理→Cloudflare 回源)+
 * 服务端密码哈希(PBKDF2 10 万次迭代,防暴力破解的故意设计)」共同决定。
 * 这里记录请求总耗时,上报 auth_timing 事件并打印控制台日志,便于量化「慢在哪」。
 */
async function timedAuthFetch(label: string, url: string, init: RequestInit): Promise<Response> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, init)
    const ms = Math.round(performance.now() - t0)
    console.info(`[auth-timing] ${label}: ${ms}ms (HTTP ${res.status})`)
    trackEvent('auth_timing', 'account', `${label}=${ms}ms`)
    return res
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    console.warn(`[auth-timing] ${label}: 请求失败于 ${ms}ms`, err)
    trackEvent('auth_timing', 'account', `${label}=fail@${ms}ms`)
    throw err
  }
}

export async function sendCode(email: string, purpose: 'register' | 'reset'): Promise<void> {
  const res = await timedAuthFetch(`sendCode:${purpose}`, `${AUTH_BASE}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
}

export async function register(
  email: string,
  password: string,
  code: string,
  nickname?: string,
  avatar?: string | null,
): Promise<AccountState> {
  const fp = await cachedDeviceFingerprint()
  const res = await timedAuthFetch('register', `${AUTH_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      code,
      nickname,
      avatar,
      deviceId: getDeviceId(),
      deviceFingerprint: fp,
      deviceName: '此设备',
    }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
  const data = (await res.json()) as { token: string; user: AccountUser }
  const account = toAccount(email, data)
  saveAccount(account)
  // 埋点:注册成功(与云端注册数漏斗对齐)
  trackEvent('register', 'account')
  return account
}

export async function login(email: string, password: string): Promise<AccountState> {
  const fp = await cachedDeviceFingerprint()
  const res = await timedAuthFetch('login', `${AUTH_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      deviceId: getDeviceId(),
      deviceFingerprint: fp,
      deviceName: '此设备',
    }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
  const data = (await res.json()) as { token: string; user: AccountUser }
  const account = toAccount(email, data)
  saveAccount(account)
  return account
}

/** 退出登录:吊销当前设备会话并清除本地登录态。 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(),
    })
  } catch {
    /* 网络异常也照常清本地态 */
  }
  saveAccount(null)
}

/** 修改密码:成功后所有设备会话失效,需重新登录。 */
export async function changePassword(
  email: string,
  password: string,
  code: string,
): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
  saveAccount(null)
}

export async function fetchDevices(): Promise<{ devices: DeviceInfo[] }> {
  const res = await fetch(`${AUTH_BASE}/api/auth/devices`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errMsg(res))
  return (await res.json()) as { devices: DeviceInfo[] }
}

export async function revokeDevice(token: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/auth/devices/revoke`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
}

/** 一键解绑除当前设备外的所有设备(其他设备需重新登录)。
 *  用于清理同一台电脑因历史缺陷(deviceId 被重生成)在云端残留的幽灵设备。 */
export async function revokeOtherDevices(): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/auth/devices/revoke-others`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(await errMsg(res))
}

export async function fetchMe(): Promise<MeResult> {
  const res = await fetch(`${AUTH_BASE}/api/auth/me`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errMsg(res))
  return (await res.json()) as MeResult
}

/** 更新昵称/头像。成功后同步更新本地登录态并返回。 */
export async function updateProfile(
  patch: { nickname?: string; avatar?: string | null },
): Promise<AccountState> {
  const cur = loadAccount()
  if (!cur) throw new Error('未登录')
  const res = await fetch(`${AUTH_BASE}/api/auth/profile`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await errMsg(res))
  const data = (await res.json()) as { user: AccountUser }
  const next: AccountState = {
    ...cur,
    nickname: data.user.nickname ?? null,
    avatar: data.user.avatar ?? null,
  }
  saveAccount(next)
  return next
}

/**
 * 从云端刷新会员状态(激活/试用到期)。
 *
 * 后台手动激活、其他设备兑换激活码后,本地登录态不会自动知晓——打开设置页
 * 或 App 启动时调用本函数对齐。只合并会员相关字段(activated/trialEndsAt),
 * 不动昵称/头像(本地优先策略,避免覆盖尚未同步成功的本地修改)。
 * 网络异常时静默保留本地态,不打扰用户。返回值可直接喂给 setState。
 */
export async function refreshAccount(): Promise<AccountState | null> {
  const cur = loadAccount()
  if (!cur) return null
  try {
    const me = await fetchMe()
    // 状态未变且 uid 已就位才提前返回;旧持久化数据缺 uid 时借本次响应补齐
    if (me.user.activated === cur.activated && me.user.trialEndsAt === cur.trialEndsAt && cur.uid) {
      return cur
    }
    const next: AccountState = {
      ...cur,
      uid: cur.uid || me.user.id,
      activated: me.user.activated,
      trialEndsAt: me.user.trialEndsAt,
    }
    saveAccount(next)
    return next
  } catch (err) {
    // 令牌失效(401):清掉僵尸登录态并广播,让账号区立即回到未登录态。
    if (err instanceof Error && /\b401\b/.test(err.message)) notifyAuthInvalid()
    return cur
  }
}

/** 兑换激活码:成功后账号升级为会员(本地登录态同步刷新)。 */
export async function redeemActivationCode(code: string): Promise<AccountState> {
  const cur = loadAccount()
  if (!cur) throw new Error('未登录')
  const res = await fetch(`${AUTH_BASE}/api/activation/redeem`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
  const next: AccountState = {
    ...cur,
    activated: true,
  }
  saveAccount(next)
  return next
}

// ===== 用户反馈(联系客服):问题反馈 / 需求提报,提交到后台管理平台 =====

export type FeedbackKind = 'issue' | 'demand'

/** 单条反馈(本人历史记录)。 */
export interface FeedbackItem {
  id: number
  kind: FeedbackKind
  content: string
  status: 'open' | 'replied' | 'done'
  created_at: string
  replies: { id: number; body: string; created_at: string }[]
  unread: boolean
}

/** 提交反馈。允许未登录提交(匿名),已登录则自动带上账号身份便于回访。
 *  contact 为可选联系方式(微信等),用于后台详细沟通。 */
export async function submitFeedback(
  kind: FeedbackKind,
  content: string,
  contact?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const acc = loadAccount()
  if (acc?.token) headers['x-sync-token'] = acc.token
  const res = await fetch(`${AUTH_BASE}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind, content, contact_method: contact ?? '' }),
  })
  if (!res.ok) throw new Error(await errMsg(res))
}

/** 拉取本人反馈历史(需登录)。 */
export async function fetchFeedbackHistory(): Promise<FeedbackItem[]> {
  const acc = loadAccount()
  if (!acc?.token) return []
  const res = await fetch(`${AUTH_BASE}/api/feedback`, {
    method: 'GET',
    headers: { 'x-sync-token': acc.token },
  })
  if (!res.ok) throw new Error(await errMsg(res))
  const data = (await res.json()) as { items: FeedbackItem[] }
  return data.items ?? []
}

/** 标记本人全部反馈为已读(查看历史记录后调用)。 */
export async function markFeedbackRead(): Promise<void> {
  const acc = loadAccount()
  if (!acc?.token) return
  try {
    await fetch(`${AUTH_BASE}/api/feedback/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': acc.token },
    })
  } catch {
    /* 标记已读失败不影响主流程 */
  }
}
