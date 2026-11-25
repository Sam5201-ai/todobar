/**
 * 随手记分类共享存储（2026-11-23）。
 *
 * 全局速记窗（label=quick-note）与晾衣绳窗（label=clothesline）是两个独立 WebView，
 * 但共用同一个 WebView2 数据目录、同源 → localStorage 天然共享。
 * 两个弹窗都从这里读写，保证「新增/编辑分类后，两边看到的分类列表一致」。
 *
 * - 分类表：最多 8 个，名称 ≤8 字。
 * - 上次选中：记住用户最近一次选中的分类，供下次打开弹窗默认带出。
 */
const CATS_KEY = 'todobar.quicknote.categories.v1'
const LAST_KEY = 'todobar.quicknote.lastCategory.v1'

export const MAX_CATEGORIES = 8

/** 读取分类表（容错：过滤空项、去重、限长）。 */
export function loadCategories(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CATS_KEY) || '[]')
    return Array.isArray(raw)
      ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 8)))].slice(0, MAX_CATEGORIES)
      : []
  } catch {
    return []
  }
}

/** 写回分类表（限长）。 */
export function saveCategories(cats: string[]): void {
  try {
    localStorage.setItem(CATS_KEY, JSON.stringify(cats.slice(0, MAX_CATEGORIES)))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 上次选中的分类（已不在分类表中时视为失效，返回空串）。 */
export function loadLastCategory(): string {
  try {
    const last = localStorage.getItem(LAST_KEY) || ''
    return last && loadCategories().includes(last) ? last : ''
  } catch {
    return ''
  }
}

/** 记住本次选中的分类；空串表示清除记忆（用户主动取消选中）。 */
export function saveLastCategory(cat: string): void {
  try {
    if (cat) localStorage.setItem(LAST_KEY, cat)
    else localStorage.removeItem(LAST_KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * 新增分类并返回「更新后的列表 + 选中名 + 失败原因」。
 * 已存在则复用原名；达到上限时返回 reason='full'（调用方据此提示用户）。
 *
 * ★2026-11-24 修复「有时添加失败」：不再信任调用方传入的快照——速记窗与绳窗是
 * 两个独立 WebView，各自持有 categories 副本，旧快照直接覆盖写盘会把另一窗口
 * 新增的分类抹掉（表现为偶尔添加失败/分类消失）。现在一律先读 localStorage
 * 最新表合并，再判断重复与上限。
 */
export function addCategory(_snapshot: string[], raw: string): { cats: string[]; name: string; reason: '' | 'empty' | 'full' } {
  const name = raw.trim().slice(0, 8)
  if (!name) return { cats: _snapshot, name: '', reason: 'empty' }
  const latest = loadCategories()
  if (latest.includes(name)) return { cats: latest, name, reason: '' }
  if (latest.length >= MAX_CATEGORIES) return { cats: latest, name: '', reason: 'full' }
  const next = [...latest, name]
  saveCategories(next)
  return { cats: next, name, reason: '' }
}

/**
 * ★2026-11-25 删除分类：读 localStorage 最新表后移除并写回；被删分类若是
 * 「上次选中」也一并清除记忆。返回更新后的列表（不存在该分类时原表原样返回）。
 * 注意：只删分类表本身，不改历史卡片上已写的 category 字段（卡片仍显示原分类）。
 */
export function removeCategory(name: string): string[] {
  const trimmed = name.trim()
  if (!trimmed) return loadCategories()
  const latest = loadCategories()
  if (!latest.includes(trimmed)) return latest
  const next = latest.filter((c) => c !== trimmed)
  saveCategories(next)
  if (loadLastCategory() === trimmed) saveLastCategory('')
  return next
}
