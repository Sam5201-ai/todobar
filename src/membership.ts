/**
 * 会员/权限订阅 hook。
 *
 * 全应用统一判定「是否全功能」:未登录(未激活)= 受限,已激活或试用中 = 全功能。
 * 基于 useSyncExternalStore 监听 ACCOUNT_CHANGED_EVENT(saveAccount 时广播),
 * 登录/登出/刷新会员状态后组件自动重渲染,无需手动传参透传。
 */

import { useSyncExternalStore } from 'react'
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

/** 订阅登录态与权限。受限功能入口统一用本 hook 判定。 */
export function useAccount(): MembershipState {
  const account = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
