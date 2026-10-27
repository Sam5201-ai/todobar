// Todobar 下载页 + 国内直连 API 代理服务
// - 静态托管本目录的下载页(index.html / screenshots / 安装包)
// - /api/* 反向代理到 Cloudflare Worker(版本更新记录、任务同步),
//   让国内用户不开 VPN 也能通过本服务的域名访问这些接口
// 零依赖,Node 18+ 直接运行: node server.js (监听 $PORT)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 3000)
const HOST = '0.0.0.0'

// 代理上游:自定义域名优先,workers.dev 兜底
const UPSTREAMS = ['https://sync.tuanzhang.site', 'https://todobar-sync.level1232.workers.dev']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.exe': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  // 目录 index:/admin/ → /admin/index.html(管理后台 SPA)
  if (rel.endsWith('/')) rel += 'index.html'
  const filePath = path.join(__dirname, path.normalize(rel))
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      // /admin → /admin/(避免 SPA 兜底错误返回下载页)
      const qIndex = req.url.indexOf('?')
      const search = qIndex >= 0 ? req.url.slice(qIndex) : ''
      res.writeHead(301, { Location: pathname.replace(/\/?$/, '/') + search })
      return res.end()
    }
    if (err || !stat.isFile()) {
      // SPA 兜底:未知路径返回首页(下载页)
      const fallback = path.join(__dirname, 'index.html')
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Access-Control-Allow-Origin': '*',
      })
      return fs.createReadStream(fallback).pipe(res)
    }
    // 安装包/配置必须每次回源校验:URL 固定 + 长缓存会让浏览器/边缘节点
    // 在缓存有效期内继续发旧版本安装包(网页显示新版、下载到的却是旧版)。
    const noCache = path.extname(filePath) === '.html' || path.extname(filePath) === '.json' || path.extname(filePath) === '.exe' || path.extname(filePath) === '.dmg'
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

async function proxyApi(req, res, pathname, search) {
  const send = (upstream, payload) => {
    // 透传真实客户端 IP 给 Worker(否则 Worker 只看到 server.js 出口 IP,
    // 所有站点访客共享一个 IP,限流会被误伤、归因也无法做)
    const headers = {
      'content-type': req.headers['content-type'] || 'application/json',
      'x-client-ip': clientIp(req),
    }
    // 优先用客户端经自定义头送来的令牌(托管平台会剥离 Authorization),
    // 还原成标准 Authorization 头转发到 Cloudflare Worker。
    // 令牌来源:管理后台 X-Admin-Token / 客户端 X-Sync-Token / 标准 Authorization。
    const token =
      req.headers['x-admin-token'] ||
      req.headers['x-sync-token'] ||
      (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null)
    if (token) {
      headers.authorization = `Bearer ${token}`
      headers['x-admin-token'] = String(token)
    }
    return fetch(upstream + pathname + search, {
      method: req.method,
      headers,
      body: payload,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000), // 单次请求 10s 超时,避免悬挂
    })
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const payload = chunks.length ? Buffer.concat(chunks) : undefined
    let lastErr = null
    for (const upstream of UPSTREAMS) {
      // 每个上游最多尝试 2 次(网络瞬断时自动重试),仍失败则换下一个上游
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const resp = await send(upstream, payload)
          // 404 视为该上游未挂载该路由,跳过并尝试下一个上游。
          // 注意不要跳过 5xx:Worker 自身的应用错误(如发码 502)需原样返回给客户端,
          // 否则会把"邮件发送失败"这类真实报错误判为上游宕机而吞掉。
          if (resp.status === 404) {
            lastErr = new Error(`${upstream} -> HTTP 404 (路由缺失)`)
            break
          }
          const body = Buffer.from(await resp.arrayBuffer())
          res.writeHead(resp.status, {
            'content-type': resp.headers.get('content-type') || 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'Authorization, X-Admin-Token, X-Sync-Token, Content-Type',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'cache-control': 'no-store',
          })
          return res.end(body)
        } catch (e) {
          lastErr = e
          if (attempt < 2) await new Promise((r) => setTimeout(r, 300))
        }
      }
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({ error: 'upstream unreachable', detail: String(lastErr) }))
  })
}

// 真实客户端 IP(透传给 Worker,供限流键与下载→安装归因使用)
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return req.socket.remoteAddress || ''
}

// 下载中转:记录"设备 + 真实下载 IP"后 302 到真实安装包。
// 由 Worker 的 /api/track(site_download 事件)写入 site_downloads,供安装归因。
function handleDownload(req, res, url) {
  const file = decodeURIComponent(url.pathname.slice('/download/'.length))
  // 仅放行命名规范的安装包,防目录穿越
  if (!/^TickTask-[\w.\-]+\.(exe|dmg)$/i.test(file) || file.includes('..') || file.includes('/')) {
    res.writeHead(404)
    return res.end('Not Found')
  }
  const device = url.searchParams.get('d') || ''
  const realIp = clientIp(req)
  const payload = JSON.stringify({
    source: 'site',
    events: [{ event: 'site_download', device, visitor: device, page: 'download' }],
  })
  // 异步上报 Worker,失败忽略,绝不阻塞下载
  fetch(UPSTREAMS[0] + '/api/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-download-ip': realIp },
    body: payload,
  }).catch(() => {})
  // 真实文件仍走静态托管(保留 ?v= 缓存击穿)
  const target = '/' + file + (url.search || '')
  res.writeHead(302, { Location: target })
  res.end()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Admin-Token, X-Sync-Token, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    })
    return res.end()
  }
  if (url.pathname.startsWith('/download/')) {
    return handleDownload(req, res, url)
  }
  if (url.pathname.startsWith('/api/')) {
    return proxyApi(req, res, url.pathname, url.search)
  }
  return serveStatic(req, res, url.pathname)
})

server.listen(PORT, HOST, () => {
  console.log(`TickTask site server listening on http://${HOST}:${PORT}`)
})
