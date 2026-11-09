/**
 * 会员/权限订阅 hook。
 *
 * 全应用统一判定「是否全功能」:未登录(未激活)= 受限,已激活或试用中 = 全功能。
 * 基于 useSyncExternalStore 监听 ACCOUNT_CHANGED_EVENT(saveAccount 时广播),
 * 登录/登出/刷新会员状态后组件自动重渲染,无需手动传参透传。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_KEY,
  isFullAccess,
  isTrialActive,
  type AccountState,
} from './account'

function subscribe(cb: () => void): () => void {
  const handler = () => cb()
  window.addEventListener(ACCOUNT_CHANGED_EVENT, handler)
  return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, handler)
}

// ⚠️ 快照必须引用稳定:useSyncExternalStore 会在每次渲染后复验 getSnapshot,
// 若两次调用返回不同引用,会判定「数据又变了」而强制重渲染 → 无限循环(React #185)。
// loadAccount() 内部 JSON.parse 每次都产生新对象,不能直接当快照用;
// 这里以 localStorage 原始串为指纹做缓存:同一原始串 => 同一对象引用。
let snapRaw: string | null | undefined
let snapCache: AccountState | null = null

function getSnapshot(): AccountState | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ACCOUNT_KEY)
  } catch {
    raw = null
  }
  if (raw === snapRaw) return snapCache
  snapRaw = raw
  if (!raw) {
    snapCache = null
    return null
  }
  try {
    const a = JSON.parse(raw) as AccountState
    snapCache = a && a.token ? a : null
  } catch {
    snapCache = null
  }
  return snapCache
}

export interface MembershipState {
  /** 当前登录态(可能为 null)。 */
  account: AccountState | null
  /** 是否拥有全功能权限(已激活会员或试用期内)。 */
  fullAccess: boolean
  /** 是否处于试用期内。 */
  trialActive: boolean
  /** 是否受限(未登录 / 试用过期且未激活)。 */
  restricted: boolean
  /** VIP 角标是否显示:仅在「试用结束且未激活」(含未登录)的受限态显示;
   *  试用期中或已是会员则不显示。用于设置页标记会员专属功能。 */
  showVip: boolean
}

/**
 * 「自动同步」开关的生效值(唯一真源)。
 *
 * - 受限态(未登录 / 试用期结束且未激活会员)一律关闭,即使试用期内原本是打开的;
 * - 成为会员(激活或重新进入试用)后按用户原有偏好自动恢复,无需手动重开。
 *
 * ⚠️ 只影响「显示与是否启动定时同步」,不改写持久化的 autoSync 偏好:
 * 把偏好写死成 false 会导致成为会员后无法自动启用,也抹掉用户主动关闭过的选择。
 */
export function effectiveAutoSync(pref: boolean, fullAccess: boolean): boolean {
  return fullAccess && pref
}

/** 订阅登录态与权限。受限功能入口统一用本 hook 判定。 */
export function useAccount(): MembershipState {
  const account = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // ⚠️ 试用期在应用常驻期间自然到期时**不会**触发 ACCOUNT_CHANGED_EVENT(账号数据没变),
  // 而 isFullAccess / isTrialActive 是按 Date.now() 实时比较的:不主动重算的话,
  // 受限功能入口与「自动同步」开关会一直停在「试用中」。这里 30s 检测一次,
  // 到期后只强制重渲染一次并注销定时器,不产生持续开销。
  const [, bumpTrialCheck] = useState(0)
  useEffect(() => {
    if (!account || account.activated || !account.trialEndsAt) return
    const endsAt = Date.parse(account.trialEndsAt)
    if (!Number.isFinite(endsAt) || endsAt <= Date.now()) return
    const timer = window.setInterval(() => {
      if (Date.now() < endsAt) return
      window.clearInterval(timer)
      bumpTrialCheck((n) => n + 1)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [account])
  const fullAccess = isFullAccess(account)
  const trialActive = isTrialActive(account)
  return {
    account,
    fullAccess,
    trialActive,
    restricted: !fullAccess,
    showVip: !fullAccess && !trialActive,
  }
}
