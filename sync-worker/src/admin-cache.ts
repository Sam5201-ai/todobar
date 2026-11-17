/**
 * 后台统计接口的服务端结果缓存(降低 D1 读取行数)。
 *
 * 采用 Worker isolate 内的模块级内存 Map:
 *  - 单管理员、访问量小,isolate 复用率高,缓存命中可省去整条 D1 全表聚合;
 *  - 命中仍是 1 次 Worker invocation,只降 D1 读取(与 Workers 请求额度无关);
 *  - 写操作按前缀失效用 Map 遍历即可,可靠且无 Cache API 前缀删除的限制;
 *  - 不持久化、不跨 isolate 共享:多 colo 下每个 isolate 各自缓存,写操作只清
 *    当前 isolate。对单管理员场景可接受,最坏情况是别的 colo 最多陈旧一个 TTL。
 *
 * 键按完整查询参数(含 days/status/q/page/pageSize)分,互不串味;
 * 强制刷新(force)读时忽略缓存并用最新结果覆盖。
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 分钟

interface CacheEntry {
  data: unknown
  expiresAt: number
}

const store = new Map<string, CacheEntry>()

/** 构造缓存键:接口名 + 全部筛选参数(键排序,忽略空值)。 */
function cacheKey(name: string, params: Record<string, string | number>): string {
  const parts: string[] = [name]
  for (const k of Object.keys(params).sort()) {
    const v = params[k]
    if (v !== '' && v !== undefined && v !== null) parts.push(`${k}=${v}`)
  }
  return parts.join('|')
}

export interface CachedResult<T> {
  data: T
  /** true = 本次结果来自缓存(未查询 D1)。 */
  cached: boolean
}

/**
 * 缓存包裹:命中且未过期则回缓存数据;未命中、已过期或 force 则执行 compute 并回填。
 * force 时用最新结果覆盖当前 key,保证「刷新数据」拿到新数据。
 */
export async function cached<T>(
  name: string,
  params: Record<string, string | number>,
  force: boolean,
  compute: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<CachedResult<T>> {
  const key = cacheKey(name, params)
  const now = Date.now()
  if (!force) {
    const hit = store.get(key)
    if (hit && hit.expiresAt > now) return { data: hit.data as T, cached: true }
  }
  const data = await compute()
  store.set(key, { data, expiresAt: Date.now() + ttlMs })
  return { data, cached: false }
}

/** 按接口名前缀失效(如 'codes' / 'overview' / 'stats')。 */
export async function invalidate(names: string[]): Promise<void> {
  for (const key of store.keys()) {
    for (const n of names) {
      if (key === n || key.startsWith(n + '|')) {
        store.delete(key)
        break
      }
    }
  }
}
