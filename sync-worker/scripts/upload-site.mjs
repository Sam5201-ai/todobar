#!/usr/bin/env node
/**
 * 把 ../release/ 的静态内容批量上传到自有 R2 桶 tuanzhangyinqing。
 * 从 .env 读 CLOUDFLARE_API_TOKEN,经 deploy.mjs 同源的 wrangler r2 object put 上传。
 * 校验走 Cloudflare REST API 读取对象 size 元数据(不下载 body)。代理环境对 exe/dmg
 * 这类大文件的 wrangler get 下载会截断,回读字节数不可信,不能用下载回读判断上传是否成功。
 * 失败自动重试 2 次。exe/dmg 等大文件可用 --only 单独传,支持断点式逐对象补传。
 *
 * 用法:
 *   node scripts/upload-site.mjs            # 传全部(小文件优先,安装包最后)
 *   node scripts/upload-site.mjs --only exe # 只传安装包
 *   node scripts/upload-site.mjs --only pages
 *   node scripts/upload-site.mjs --verify   # 只用 API size 元数据校验,不上传(不下载 body)
 */
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const workerRoot = dirname(here)
const releaseDir = resolve(workerRoot, '..', 'release')
const BUCKET = 'tuanzhangyinqing'

// 读 token(与 deploy.mjs 一致)
try {
  for (const line of readFileSync(join(workerRoot, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error('[upload] 缺少 CLOUDFLARE_API_TOKEN(.env)')
  process.exit(1)
}

// wrangler 3.114 的 r2 object put --ct 在 Windows shell 下不接受带空格的
// "text/html; charset=utf-8"(空格被拆成未知参数)。R2 只存主 MIME,
// charset 由 Worker 返回时按类型补上,HTML 自身也有 <meta charset>。
const CT = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.exe': 'application/octet-stream',
  '.dmg': 'application/octet-stream',
}
const contentType = (f) => CT[f.slice(f.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream'

// [源文件, R2 key, 分组]
const FILES = [
  ['index.html', 'index.html', 'pages'],
  ['faq.html', 'faq.html', 'pages'],
  ['features.html', 'features.html', 'pages'],
  ['compare.html', 'compare.html', 'pages'],
  ['changelog.html', 'changelog.html', 'pages'],
  ['version.json', 'version.json', 'pages'],
  ['holidays.json', 'holidays.json', 'pages'],
  ['robots.txt', 'robots.txt', 'pages'],
  ['sitemap.xml', 'sitemap.xml', 'pages'],
  ['BingSiteAuth.xml', 'BingSiteAuth.xml', 'pages'],
  ['google3e6a1ccf82ce76c9.html', 'google3e6a1ccf82ce76c9.html', 'pages'],
  ['baidu_verify_codeva-b6YByVpS4S.html', 'baidu_verify_codeva-b6YByVpS4S.html', 'pages'],
  ['7c882b4d0faf44b8a24768f8e979496d.txt', '7c882b4d0faf44b8a24768f8e979496d.txt', 'pages'],
  ['favicon.png', 'favicon.png', 'assets'],
  ['favicon-32.png', 'favicon-32.png', 'assets'],
  ['favicon-512.png', 'favicon-512.png', 'assets'],
  ['logo.png', 'logo.png', 'assets'],
  ['wallpaper.jpg', 'wallpaper.jpg', 'assets'],
  ['admin/index.html', 'admin/index.html', 'pages'],
  ['assets/site.css', 'assets/site.css', 'assets'],
  // 下载站多语言:运行时引擎 + 字典(6 个)
  ['assets/site-i18n.js', 'assets/site-i18n.js', 'assets'],
  ['assets/i18n/common.js', 'assets/i18n/common.js', 'assets'],
  ['assets/i18n/index.js', 'assets/i18n/index.js', 'assets'],
  ['assets/i18n/features.js', 'assets/i18n/features.js', 'assets'],
  ['assets/i18n/faq.js', 'assets/i18n/faq.js', 'assets'],
  ['assets/i18n/compare.js', 'assets/i18n/compare.js', 'assets'],
  ['assets/i18n/changelog.js', 'assets/i18n/changelog.js', 'assets'],
  ['assets/logo.webp', 'assets/logo.webp', 'assets'],
  ['assets/panel-crop.webp', 'assets/panel-crop.webp', 'assets'],
  ['assets/wallpaper.webp', 'assets/wallpaper.webp', 'assets'],
  ...['01-todo', '02-birthday', '03-calculator', '04-huangli', '05-salary', '06-screenshot', '07-notes', '08-clipboard'].map(
    (n) => [`assets/shot-${n}.webp`, `assets/shot-${n}.webp`, 'assets'],
  ),
  ['assets/shot-09-clothesline.jpg', 'assets/shot-09-clothesline.jpg', 'assets'],
  ...['birthday', 'calculator', 'home-dark', 'home-light', 'huangli', 'panel-crop', 'salary', 'settings-bg'].map(
    (n) => [`screenshots/${n}.png`, `screenshots/${n}.png`, 'assets'],
  ),
  ['Tacco-setup.exe', 'Tacco-setup.exe', 'exe'],
  ['Tacco_0.4.82_aarch64.dmg', 'Tacco_0.4.82_aarch64.dmg', 'exe'],
  ['Tacco_0.4.82_x64.dmg', 'Tacco_0.4.82_x64.dmg', 'exe'],
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const verifyOnly = args.includes('--verify')
const order = { pages: 0, assets: 1, exe: 2 }
const list = FILES.filter((f) => !only || f[2] === only).sort((a, b) => order[a[2]] - order[b[2]])

function wrangler(sub) {
  return spawnSync('npx', ['wrangler', ...sub], { stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32', cwd: workerRoot })
}

// 校验通道:经 curl(走系统代理)调 CF REST API,只读对象 size 元数据,不下载 body。
// 代理对 exe/dmg 大文件的 wrangler get 会截断(40MB→0,20MB→半),下载回读不可信;
// size 元数据精确可靠,是判断"上传是否完整"的唯一可信依据。
function cfApi(path) {
  const r = spawnSync('curl', [
    '-sS', '-m', '30', '-H', `Authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    `https://api.cloudflare.com/client/v4${path}`,
  ], { encoding: 'utf8' })
  if (r.status !== 0) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

let _r2Sizes = null
function r2Sizes(force = false) {
  if (_r2Sizes && !force) return _r2Sizes
  const acc = cfApi('/accounts')?.result?.[0]?.id
  if (!acc) return null
  const resp = cfApi(`/accounts/${acc}/r2/buckets/${BUCKET}/objects?per_page=1000`)
  if (!Array.isArray(resp?.result)) return null
  _r2Sizes = new Map(resp.result.map((o) => [o.key, o.size]))
  return _r2Sizes
}

let ok = 0
let fail = 0
const sizes = r2Sizes() // 一次性加载全桶 size 元数据(精确、不下载 body)
const apiAvailable = !!sizes
if (!apiAvailable) console.log('  [warn] CF API 不可用,回退到 wrangler get 回读(大文件可能误报)')
for (const [rel, key, group] of list) {
  const src = join(releaseDir, rel)
  if (!existsSync(src)) {
    console.log(`  SKIP  ${key} (本地不存在: ${rel})`)
    continue
  }
  const size = statSync(src).size
  if (!verifyOnly) {
    let uploaded = false
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const r = wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', src, '--ct', contentType(rel)])
      if (r.status === 0) uploaded = true
      else {
        console.log(`  RETRY ${key} 第${attempt}次: ${(r.stderr || r.stdout || '').trim().slice(-160)}`)
      }
    }
    if (!uploaded) {
      console.log(`  FAIL  ${key} 上传失败(3次)`)
      fail++
      continue
    }
    // put 成功后即时更新本地快照,避免"上传前加载一次、之后不刷新"导致刚传的对象被误判不存在
    if (sizes) sizes.set(key, size)
  }
  // 校验:优先用 CF API 的 size 元数据(不下载 body,代理截断也不影响);API 不可用才回退 get 回读
  let pass = false
  let detail = ''
  if (apiAvailable) {
    const remote = sizes.get(key)
    pass = remote === size && size > 0
    detail = remote === undefined ? 'R2不存在' : `R2 ${(remote / 1024).toFixed(1)}KB`
  } else {
    const tmp = join(workerRoot, `.r2verify-${group}-${key.replace(/[\\/]/g, '_')}.tmp`)
    try { unlinkSync(tmp) } catch {}
    const g = wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', tmp])
    const got = existsSync(tmp) ? statSync(tmp).size : 0
    pass = g.status === 0 && got === size && size > 0
    detail = `回读 ${(got / 1024).toFixed(1)}KB`
    try { unlinkSync(tmp) } catch {}
  }
  console.log(`  ${pass ? 'OK  ' : 'BAD '} ${key.padEnd(38)} ${(size / 1024).toFixed(1)}KB -> ${detail} ${verifyOnly ? '(仅校验)' : ''}`)
  if (pass) ok++
  else fail++
}

console.log(`\n[upload-site] 成功 ${ok} / 失败 ${fail} / 共 ${list.length}`)
process.exit(fail ? 1 : 0)
