/** 版本检查 / 更新提示去重 / 应用内安装:App 根(首页弹窗)与设置页共用。
 *
 * 数据流刻意分开:
 *  - `version.json` 负责**判定**(最新版本 + 安装包 URL),每次发版必更新,最可靠;
 *  - `/api/releases` 的**版本记录**负责弹窗文案(标题 + 更新项),由 `changelog.ts` 读取;
 *    后台漏录时弹窗回退 `version.json.notes`,不会「发现新版本却没有内容」。
 *
 * 安装包是完整 NSIS 全量程序(不是增量补丁),跨任意多个版本都只需下载安装一次。
 */
import type { ReleaseRecord } from './changelog'

/** 官方下载页(国内直连),版本检查与安装包下载都走这里,无需 VPN。 */
export const OFFICIAL_SITE = 'https://todobar-app.app.workbuddy.host'

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest' }
  | { status: 'available'; version: string; url: string }
  | { status: 'downloading'; version: string }
  | { status: 'installing'; version: string }
  | { status: 'error'; message: string; url?: string }

export interface LatestVersion {
  version: string
  url: string
  /** 版本记录缺失时的兜底文案。 */
  notes: string
}

/** 首页更新弹窗所需的全部数据(由 App 根在启动时组装)。 */
export interface UpdateNotice {
  version: string
  url: string
  notes: string
  /** 后台版本记录里精确匹配最新版本的一条;缺失时以下三项为空,弹窗回退 notes。 */
  date: string
  title: string
  items: string[]
  /** 用户错过的中间版本(当前版本 < v < 最新版本),按版本降序。 */
  missed: ReleaseRecord[]
  /** 完整版本记录(缓存或网络),供「查看完整版本记录」展开。 */
  releases: ReleaseRecord[]
}

export async function fetchLatestVersion(): Promise<LatestVersion> {
  const res = await fetch(`${OFFICIAL_SITE}/version.json?t=${Date.now()}`)
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
  const data = (await res.json()) as { version?: string; url?: string; notes?: string }
  if (!data.version || !data.url) throw new Error('版本信息格式错误')
  return {
    version: data.version,
    url: data.url,
    notes: typeof data.notes === 'string' ? data.notes : '',
  }
}

/** 比较点分版本号 a 是否大于 b。 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** 从版本记录里挑出「用户错过的中间版本」。后台漏录的版本不会出现在这里,
 *  宁可少提示也不编造;调用方不给中间版本提示行即可。 */
export function missedVersions(
  releases: ReleaseRecord[],
  current: string,
  latest: string,
): ReleaseRecord[] {
  return releases
    .filter((r) => isNewerVersion(r.version, current) && isNewerVersion(latest, r.version))
    .sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : 1))
}

// ---- 弹窗去重:每个最新版本号最多弹一次 ------------------------------------

// [0.4.64] v1 里残留了「弹窗渲染崩溃却被提前标记」的版本号(0.4.63 的
// missedLabel 崩溃),升级到 v2 让这些用户重新获得一次最新版提示机会。
// 写入时机也改为弹窗真实渲染成功后(见 UpdateNoticeSheet),不再空耗额度。
const UPDATE_PROMPT_KEY = 'ticktask.updatePrompt.v2'
const MAX_SHOWN = 10

export function readShownUpdates(): string[] {
  try {
    const raw = localStorage.getItem(UPDATE_PROMPT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function isUpdateShown(version: string): boolean {
  return readShownUpdates().includes(version)
}

/** 由弹窗组件在渲染成功后调用:网络失败 / 弹窗崩溃 / 用户没看到都不消耗额度。 */
export function markUpdateShown(version: string): void {
  try {
    const arr = readShownUpdates().filter((v) => v !== version)
    arr.push(version)
    localStorage.setItem(UPDATE_PROMPT_KEY, JSON.stringify(arr.slice(-MAX_SHOWN)))
  } catch {
    /* 存储配额异常忽略 */
  }
}

// ---- 应用内下载并覆盖安装 --------------------------------------------------

/** ArrayBuffer → Base64(把浏览器下载的安装包字节传给 Rust 落盘到临时目录)。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

/** 下载完整 NSIS 安装包 → Rust 落盘 → 拉起安装向导并退出当前应用。
 *  状态由调用方持有的 `UpdateState` 驱动,设置页与首页弹窗显示同一份进度。 */
export async function downloadAndInstall(
  version: string,
  url: string,
  setUpdate: (s: UpdateState) => void,
): Promise<void> {
  setUpdate({ status: 'downloading', version })
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // 下载走浏览器(复用用户浏览器网络/代理/证书),避免此前 Rust 直连在特殊网络下失败。
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`)
    const b64 = arrayBufferToBase64(await resp.arrayBuffer())
    const path = await invoke<string>('save_update_file', { data: b64 })
    await invoke('install_update', { path })
    setUpdate({ status: 'installing', version })
  } catch (err) {
    setUpdate({ status: 'error', message: `更新失败: ${(err as Error).message}`, url })
  }
}
