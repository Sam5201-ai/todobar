/** 版本记录:从下载站 `/api/releases` 拉取发行记录(版本号 / 发布日期 / 标题 / 更新项)。
 *
 * 与 App.tsx 的 OFFICIAL_SITE、account.ts 的 AUTH_BASE 同源,server.js 已对该接口开
 * CORS,只读 GET,无需鉴权。
 * 策略:优先用本地缓存秒开,网络回来后覆盖;网络失败且有缓存时静默降级,不打扰用户。
 */
import { AUTH_BASE } from './account'

export interface ReleaseRecord {
  /** 版本号,如 0.4.51。 */
  version: string
  /** 发布日期,YYYY-MM-DD。 */
  release_date: string
  /** 版本标题。 */
  title: string
  /** 更新项列表。 */
  items: string[]
}

const CACHE_KEY = 'ticktask.changelog.v1'

/** 把任意来源(网络 / 缓存)的原始数组清洗成 ReleaseRecord。 */
function normalizeReleases(list: unknown): ReleaseRecord[] | null {
  if (!Array.isArray(list)) return null
  const out: ReleaseRecord[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const version = typeof r.version === 'string' ? r.version.trim() : ''
    if (!version) continue
    out.push({
      version,
      release_date: typeof r.release_date === 'string' ? r.release_date : '',
      title: typeof r.title === 'string' ? r.title : '',
      items: Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === 'string') : [],
    })
  }
  return out
}

/** 读取本地缓存(上一次拉取成功的结果),无缓存返回 null。 */
export function readReleaseCache(): ReleaseRecord[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { list?: unknown }
    const list = normalizeReleases(parsed.list)
    return list && list.length > 0 ? list : null
  } catch {
    return null
  }
}

/** 拉取远程版本记录,成功后刷新本地缓存。失败抛错由调用方决定是否降级。 */
export async function fetchReleases(): Promise<ReleaseRecord[]> {
  const res = await fetch(`${AUTH_BASE}/api/releases`)
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
  const data = (await res.json()) as { releases?: unknown }
  const list = normalizeReleases(data.releases)
  if (!list) throw new Error('版本记录格式错误')
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ list }))
  } catch {
    /* 存储配额异常忽略 */
  }
  return list
}

/** 当前应用版本号(动态导入,避免非 Tauri 环境加载失败)。取不到返回空串。 */
export async function currentAppVersion(): Promise<string> {
  try {
    const m = await import('@tauri-apps/api/app')
    return await m.getVersion()
  } catch {
    return ''
  }
}
