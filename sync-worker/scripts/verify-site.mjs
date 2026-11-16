#!/usr/bin/env node
/**
 * R2 迁移部署后的 HTTP 层验收脚本:对两个自有域逐一探测关键入口,
 * 确认静态内容走新链路(x-served-by: r2)、/api/* 未受影响、安装包可断点续传。
 * 不依赖 wrangler,纯 fetch。用法:
 *   node scripts/verify-site.mjs
 *   node scripts/verify-site.mjs --base https://sync.tuanzhang.site   # 只测一个域
 */
const DOMAINS = ['https://sync.tuanzhang.site', 'https://todobar.tuanzhang.site']
const only = process.argv.includes('--base') ? [process.argv[process.argv.indexOf('--base') + 1]] : DOMAINS
const EXE_SIZE = 40690244 // release/Tacco-setup.exe 当前字节数

let pass = 0
let fail = 0
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`)
  ok ? pass++ : fail++
}

async function probe(url, init) {
  const t0 = Date.now()
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...init })
  return { res, ms: Date.now() - t0 }
}

for (const base of only) {
  console.log(`\n=== ${base} ===`)
  // 1) 首页
  try {
    const { res, ms } = await probe(`${base}/`)
    check('GET / 首页', res.status === 200 && (res.headers.get('content-type') || '').includes('text/html'),
      `${res.status} ${res.headers.get('content-type')} ${ms}ms served-by=${res.headers.get('x-served-by')}`)
    check('  首页标记走 R2', res.headers.get('x-served-by') === 'r2', `x-served-by=${res.headers.get('x-served-by')}`)
  } catch (e) { check('GET / 首页', false, String(e)) }

  // 2) version.json
  try {
    const { res } = await probe(`${base}/version.json`)
    const j = await res.json()
    check('GET /version.json', res.status === 200 && !!j.version, `${res.status} v=${j.version}`)
    check('  version.url 指回本域', typeof j.url === 'string' && j.url.startsWith(base), j.url)
  } catch (e) { check('GET /version.json', false, String(e)) }

  // 3) 后台 SPA
  try {
    const { res } = await probe(`${base}/admin/`)
    const body = await res.text()
    check('GET /admin/ 后台', res.status === 200 && body.length > 1000, `${res.status} ${body.length}B`)
  } catch (e) { check('GET /admin/ 后台', false, String(e)) }

  // 4) 后台深链回退(SPA)
  try {
    const { res } = await probe(`${base}/admin/any/deep/route`)
    check('GET /admin/deep 回退SPA', res.status === 200, `${res.status}`)
  } catch (e) { check('GET /admin/deep 回退SPA', false, String(e)) }

  // 5) 静态页 faq.html
  try {
    const { res } = await probe(`${base}/faq.html`)
    check('GET /faq.html', res.status === 200 && (res.headers.get('content-type') || '').includes('text/html'), `${res.status} ${res.headers.get('content-type')}`)
  } catch (e) { check('GET /faq.html', false, String(e)) }

  // 6) 资源 content-type
  try {
    const { res } = await probe(`${base}/assets/logo.webp`, { method: 'HEAD' })
    check('HEAD /assets/logo.webp', res.status === 200 && res.headers.get('content-type') === 'image/webp', `${res.status} ${res.headers.get('content-type')}`)
  } catch (e) { check('HEAD /assets/logo.webp', false, String(e)) }

  // 7) 安装包:完整响应头 + content-length
  try {
    const { res } = await probe(`${base}/Tacco-setup.exe?v=verify`, { method: 'HEAD' })
    const len = res.headers.get('content-length')
    check('HEAD /Tacco-setup.exe', res.status === 200 && res.headers.get('content-type') === 'application/octet-stream',
      `${res.status} ${res.headers.get('content-type')}`)
    check('  安装包 content-length', Number(len) === EXE_SIZE, `content-length=${len} 期望=${EXE_SIZE}`)
  } catch (e) { check('HEAD /Tacco-setup.exe', false, String(e)) }

  // 8) 安装包 Range 断点续传(关键:下载器/浏览器分片)
  try {
    const { res } = await probe(`${base}/Tacco-setup.exe?v=verify`, { headers: { range: 'bytes=0-1023' } })
    const buf = await res.arrayBuffer()
    check('Range bytes=0-1023', res.status === 206 && buf.byteLength === 1024 && (res.headers.get('content-range') || '').includes(`/${EXE_SIZE}`),
      `${res.status} got=${buf.byteLength}B range=${res.headers.get('content-range')}`)
  } catch (e) { check('Range bytes=0-1023', false, String(e)) }

  // 9) 后缀 Range
  try {
    const { res } = await probe(`${base}/Tacco-setup.exe?v=verify`, { headers: { range: 'bytes=-512' } })
    const buf = await res.arrayBuffer()
    check('Range bytes=-512(尾部)', res.status === 206 && buf.byteLength === 512, `${res.status} got=${buf.byteLength}B`)
  } catch (e) { check('Range bytes=-512(尾部)', false, String(e)) }

  // 10) 下载归因中转 302
  try {
    const { res } = await probe(`${base}/download/Tacco-setup.exe?v=verify&d=verify-device`)
    const loc = res.headers.get('location') || ''
    check('GET /download/ 归因302', res.status === 302 && loc.startsWith('/Tacco-setup.exe'),
      `${res.status} location=${loc}`)
  } catch (e) { check('GET /download/ 归因302', false, String(e)) }

  // 11) 安装包缺失不能被当 HTML(安全回归:旧坑)
  try {
    const { res } = await probe(`${base}/Tacco-setup-NOTEXIST.exe`)
    const ct = res.headers.get('content-type') || ''
    check('缺失 exe 返回真404非HTML', res.status === 404 && !ct.includes('text/html'), `${res.status} ${ct}`)
  } catch (e) { check('缺失 exe 返回真404非HTML', false, String(e)) }

  // 12) /api/* 未受影响(401 到业务层即正常)
  try {
    const { res } = await probe(`${base}/api/health`)
    check('GET /api/health 未受影响', res.status === 200 || res.status === 401, `${res.status}`)
  } catch (e) { check('GET /api/health 未受影响', false, String(e)) }

  // 13) CORS
  try {
    const { res } = await probe(`${base}/version.json`)
    check('CORS allow-origin', res.headers.get('access-control-allow-origin') === '*', `${res.headers.get('access-control-allow-origin')}`)
  } catch (e) { check('CORS allow-origin', false, String(e)) }
}

console.log(`\n[verify-site] PASS ${pass} / FAIL ${fail}`)
process.exit(fail ? 1 : 0)
