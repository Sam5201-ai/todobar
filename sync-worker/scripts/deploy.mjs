#!/usr/bin/env node
/**
 * 部署包装脚本：从 sync-worker/.env 读取 CLOUDFLARE_API_TOKEN 后转发给 wrangler。
 * 用法:
 *   node scripts/deploy.mjs            # 等价于 npx wrangler deploy
 *   node scripts/deploy.mjs whoami     # 验证凭证
 *   node scripts/deploy.mjs d1 migrations apply todobar --remote
 * token 不要写进代码或提交到 git（.gitignore 已忽略 .env）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  // .env 不存在时交给下方校验报错
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error('[deploy] 未找到 CLOUDFLARE_API_TOKEN：请在 sync-worker/.env 中配置一行 CLOUDFLARE_API_TOKEN=xxx')
  process.exit(1)
}

const args = process.argv.slice(2)
const cmd = args.length ? args : ['deploy']
console.log(`[deploy] wrangler ${cmd.join(' ')}`)
const r = spawnSync('npx', ['wrangler', ...cmd], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  cwd: root,
})
process.exit(r.status ?? 1)
