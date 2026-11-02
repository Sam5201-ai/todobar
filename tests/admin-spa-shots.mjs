// 管理后台各视图截图(供视觉检查)。运行:node tests/admin-spa-shots.mjs
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ADMIN_BASE || 'http://127.0.0.1:3199'
const OUT = path.resolve(import.meta.dirname, '..', '_admin-shots')

const OVERVIEW = {
  range: 30,
  users: { total: 128, newToday: 3, newInRange: 21, member: 12, trial: 40, churned: 74, blacklist: 2, conversionRate: 9.4 },
  active: { today: 18, d7: 46, d30: 88 },
  funnel: { visitors: 1520, clicks: 310, installs: 96, registrations: 21 },
  trends: {
    days: Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`),
    newUsers: Array.from({ length: 30 }, (_, i) => Math.round(2 + Math.sin(i / 3) * 2 + (i % 5))),
    cumulativeUsers: Array.from({ length: 30 }, (_, i) => 100 + i * 1.6),
    activeUsers: Array.from({ length: 30 }, (_, i) => Math.round(14 + Math.cos(i / 4) * 6 + (i % 4))),
    pageviews: Array.from({ length: 30 }, (_, i) => Math.round(60 + Math.sin(i / 2.5) * 25 + (i % 7) * 2)),
    downloadClicks: Array.from({ length: 30 }, (_, i) => Math.round(10 + Math.cos(i / 3) * 5 + (i % 3))),
  },
}
const USERS = {
  rows: [
    { id: 'u1', email: 'alice@example.com', nickname: '爱丽丝', avatar: null, created_at: '2026-10-01T10:00:00Z', activated: 1, activated_at: '2026-10-02T10:00:00Z', trial_ends_at: null, disabled: 0, devices: 2, last_seen_at: new Date(Date.now() - 3600_000).toISOString(), tasks: 56, birthdays: 3 },
    { id: 'u2', email: 'bob@example.com', nickname: null, avatar: null, created_at: '2026-10-05T10:00:00Z', activated: 0, activated_at: null, trial_ends_at: '2027-01-01T00:00:00Z', disabled: 0, devices: 1, last_seen_at: null, tasks: 12, birthdays: 0 },
    { id: 'u3', email: 'carol@example.com', nickname: '小黑', avatar: null, created_at: '2026-09-20T10:00:00Z', activated: 0, activated_at: null, trial_ends_at: null, disabled: 0, devices: 3, last_seen_at: '2026-10-10T10:00:00Z', tasks: 8, birthdays: 1 },
  ],
  total: 3,
}
const CODES = {
  rows: [
    { code: 'TK-ABCDEF2345', batch: 'B202610', note: '小红书活动首批', status: 'used', used_by: 'u1', used_at: '2026-10-10T10:00:00Z', issued_at: '2026-10-09T10:00:00Z', created_at: '2026-10-08T10:00:00Z', user_email: 'alice@example.com' },
    { code: 'TK-GHIJKL2345', batch: 'B202610', note: '', status: 'issued', used_by: null, used_at: null, issued_at: '2026-10-09T10:00:00Z', created_at: '2026-10-08T10:00:00Z', user_email: null },
    { code: 'TK-MNOPQR2345', batch: 'B202611', note: '备用批次', status: 'unissued', used_by: null, used_at: null, issued_at: null, created_at: '2026-10-08T10:00:00Z', user_email: null },
  ],
  total: 3,
  counts: { unissued: 1, issued: 1, used: 1 },
}
const STATS = {
  days: Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`),
  app: {
    pages: [
      { page: 'day', visitors: 120, clicks: 340 },
      { page: 'week', visitors: 66, clicks: 88 },
      { page: 'month', visitors: 41, clicks: 30 },
      { page: 'birthday', visitors: 33, clicks: 12 },
      { page: 'calculator', visitors: 22, clicks: 60 },
      { page: 'huangli', visitors: 18, clicks: 5 },
    ],
    trend: [], days: [],
  },
  site: { trend: [], days: [], totals: { visitors: 1520, clicks: 310 } },
}
const RELEASES = {
  releases: [
    { version: '0.2.3', release_date: '2026-10-15', title: '体验优化与本地存储', items: ['toast 提示移到页面顶部', '同步开关简化', '支持自定义本地存储路径'], created_at: '2026-10-15T12:00:00Z' },
    { version: '0.2.2', release_date: '2026-10-14', title: '稳定性修复', items: ['修复同步偶发失败的问题'], created_at: '2026-10-14T12:00:00Z' },
  ],
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  await page.route('**/api/admin/login', (r) => r.fulfill({ json: { ok: true, token: 'MOCK', expiresAt: 'x' } }))
  await page.route('**/api/admin/overview*', (r) => r.fulfill({ json: OVERVIEW }))
  await page.route('**/api/admin/users*', (r) => r.fulfill({ json: USERS }))
  await page.route('**/api/admin/codes*', (r) => r.fulfill({ json: CODES }))
  await page.route('**/api/admin/stats*', (r) => r.fulfill({ json: STATS }))
  await page.route('**/api/admin/releases*', (r) => r.fulfill({ json: RELEASES }))

  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(OUT, '0-login.png') })
  await page.fill('#login-email', '396770760@qq.com')
  await page.fill('#login-password', '66666666')
  await page.click('#login-form button[type=submit]')
  await page.waitForSelector('#ov-body .kpi-grid')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, '1-overview.png'), fullPage: true })

  for (const [hash, name] of [['#/users', '2-users'], ['#/codes', '3-codes'], ['#/stats', '4-stats'], ['#/releases', '5-releases']]) {
    await page.click(`a[href="${hash}"]`)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true })
  }
  // 版本记录编辑弹窗
  await page.click('#r-table tbody tr:nth-child(1) button[data-op="edit"]')
  await page.waitForSelector('#rm-version')
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(OUT, '6-release-edit.png') })

  await browser.close()
  console.log('screenshots ->', OUT)
}
main().catch((e) => { console.error(e); process.exit(1) })
