// 管理后台 SPA 冒烟测试:mock /api/admin/* 接口,走通全部六个视图。
// 运行:node tests/admin-spa-smoke.mjs (需 release/server.js 已在 3199 端口运行)
import { chromium } from 'playwright'

const BASE = process.env.ADMIN_BASE || 'http://127.0.0.1:3199'
const errors = []

const OVERVIEW = {
  range: 30,
  users: { total: 128, newToday: 3, newInRange: 21, member: 12, trial: 40, churned: 74, blacklist: 2, conversionRate: 9.4 },
  active: { today: 18, d7: 46, d30: 88 },
  funnel: { visitors: 1520, clicks: 310, installs: 96, registrations: 21 },
  trends: {
    days: Array.from({ length: 30 }, (_, i) => `2026-09-${String(15 + (i % 15) + 1).padStart(2, '0')}`),
    newUsers: Array.from({ length: 30 }, () => Math.floor(Math.random() * 5)),
    cumulativeUsers: Array.from({ length: 30 }, (_, i) => 100 + i * 2),
    activeUsers: Array.from({ length: 30 }, () => Math.floor(Math.random() * 20)),
    pageviews: Array.from({ length: 30 }, () => Math.floor(Math.random() * 80)),
    downloadClicks: Array.from({ length: 30 }, () => Math.floor(Math.random() * 15)),
  },
}

const USERS = {
  rows: [
    { id: 'u1', email: 'alice@example.com', nickname: '爱丽丝', avatar: null, created_at: '2026-10-01T10:00:00Z', activated: 1, activated_at: '2026-10-02T10:00:00Z', trial_ends_at: null, disabled: 0, devices: 2, last_seen_at: new Date(Date.now() - 3600_000).toISOString(), tasks: 56, birthdays: 3 },
    { id: 'u2', email: 'bob@example.com', nickname: null, avatar: null, created_at: '2026-10-05T10:00:00Z', activated: 0, activated_at: null, trial_ends_at: '2027-01-01T00:00:00Z', disabled: 0, devices: 1, last_seen_at: null, tasks: 12, birthdays: 0 },
    { id: 'u3', email: 'c@example.com', nickname: '小黑', avatar: null, created_at: '2026-09-20T10:00:00Z', activated: 0, activated_at: null, trial_ends_at: null, disabled: 1, devices: 3, last_seen_at: '2026-10-10T10:00:00Z', tasks: 8, birthdays: 1 },
  ],
  total: 3,
}

const CODES = {
  rows: [
    { code: 'TK-ABCDEF2345', batch: 'B1', note: '小红书首批', status: 'used', used_by: 'u1', used_at: '2026-10-10T10:00:00Z', issued_at: '2026-10-09T10:00:00Z', created_at: '2026-10-08T10:00:00Z', user_email: 'alice@example.com' },
    { code: 'TK-GHIJKL2345', batch: 'B1', note: '', status: 'issued', used_by: null, used_at: null, issued_at: '2026-10-09T10:00:00Z', created_at: '2026-10-08T10:00:00Z', user_email: null },
    { code: 'TK-MNOPQR2345', batch: 'B2', note: '备用', status: 'unissued', used_by: null, used_at: null, issued_at: null, created_at: '2026-10-08T10:00:00Z', user_email: null },
  ],
  total: 3,
  counts: { unissued: 1, issued: 1, used: 1 },
}

// 注意:与真实 Worker 返回结构保持一致 —— 顶层 days 是数字,日期数组在 app.days / site.days
const DAY_LIST = Array.from({ length: 30 }, (_, i) => `2026-09-${String(15 + (i % 15) + 1).padStart(2, '0')}`)
const STATS = {
  days: 30,
  app: {
    pages: [
      { page: 'day', visitors: 120, clicks: 340 },
      { page: 'week', visitors: 66, clicks: 88 },
      { page: 'month', visitors: 41, clicks: 30 },
      { page: 'birthday', visitors: 33, clicks: 12 },
      { page: 'calculator', visitors: 22, clicks: 60 },
      { page: 'huangli', visitors: 18, clicks: 5 },
    ],
    trend: [],
    days: DAY_LIST,
  },
  site: {
    trend: [],
    days: DAY_LIST,
    totals: { visitors: 1520, clicks: 310 },
  },
}

const RELEASES = {
  releases: [
    { version: '0.2.3', release_date: '2026-10-15', title: '体验优化', items: ['toast 位置调整', '同步开关简化'], created_at: '2026-10-15T12:00:00Z' },
    { version: '0.2.2', release_date: '2026-10-14', title: '稳定性修复', items: ['修复同步偶发失败'], created_at: '2026-10-14T12:00:00Z' },
  ],
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

  // mock 管理端 API(同源路径)
  await page.route('**/api/admin/login', (route) =>
    route.fulfill({ json: { ok: true, token: 'MOCK_TOKEN', expiresAt: '2026-10-16T00:00:00Z' } }))
  await page.route('**/api/admin/overview*', (route) => route.fulfill({ json: OVERVIEW }))
  await page.route('**/api/admin/users*', (route) => route.fulfill({ json: USERS }))
  await page.route('**/api/admin/users/**', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/admin/codes*', (route) => route.fulfill({ json: CODES }))
  await page.route('**/api/admin/stats*', (route) => route.fulfill({ json: STATS }))
  await page.route('**/api/admin/releases*', (route) => route.fulfill({ json: RELEASES }))
  await page.route('**/api/admin/logout', (route) => route.fulfill({ json: { ok: true } }))

  const assert = (cond, msg) => { if (!cond) { errors.push('ASSERT: ' + msg) } else { console.log('  ✓', msg) } }

  // ---- 登录页 ----
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' })
  assert(await page.locator('#login-form').count() === 1, '登录页渲染')
  await page.fill('#login-email', '396770760@qq.com')
  await page.fill('#login-password', '66666666')
  await page.click('#login-form button[type=submit]')
  await page.waitForSelector('#ov-body .kpi-grid', { timeout: 5000 })

  // ---- 概览 ----
  assert(await page.locator('.kpi-grid .kpi').count() === 4, '概览 4 张 KPI 卡')
  assert((await page.locator('#ov-body').textContent()).includes('9.4%'), '转化率展示')
  assert(await page.locator('#ov-body svg').count() >= 4, '概览图表渲染(≥4 个 SVG:增长/活跃/占比/站点)')
  assert((await page.locator('#ov-body').textContent()).includes('下载站转化漏斗'), '漏斗卡片')
  assert((await page.locator('#ov-body').textContent()).includes('用户状态占比'), '状态占比卡片')
  // 切换天数
  await page.click('#ov-days button[data-d="7"]')
  await page.waitForTimeout(300)
  assert((await page.locator('#ov-body').textContent()).includes('近 7 天'), '概览天数切换')

  // ---- 用户管理 ----
  await page.click('a[href="#/users"]')
  await page.waitForSelector('#u-table table tbody tr', { timeout: 5000 })
  assert(await page.locator('#u-table tbody tr').count() === 3, '用户列表 3 行')
  assert((await page.locator('#u-table').textContent()).includes('alice@example.com'), '用户邮箱展示')
  assert((await page.locator('#u-table').textContent()).includes('试用中'), '试用状态徽章')
  // 拉黑按钮交互(confirm 自动接受)
  page.on('dialog', (d) => d.accept())
  await page.click('#u-table tbody tr:nth-child(1) button[data-act="blacklist"]')
  await page.waitForTimeout(400)
  assert((await page.locator('.toast').last().textContent()).includes('拉黑成功'), '拉黑操作反馈')

  // ---- 激活码 ----
  await page.click('a[href="#/codes"]')
  await page.waitForSelector('#c-table table tbody tr', { timeout: 5000 })
  assert((await page.locator('#c-counts').textContent()).includes('未发放'), '激活码计数卡')
  assert(await page.locator('#c-table tbody tr').count() === 3, '激活码列表 3 行')
  assert((await page.locator('#c-table').textContent()).includes('TK-ABCDEF2345'), '激活码展示')
  // 生成弹窗
  await page.click('#c-gen')
  await page.waitForSelector('#gm-count', { timeout: 3000 })
  assert(await page.locator('.modal').count() === 1, '生成弹窗打开')
  await page.click('#gm-cancel')
  assert(await page.locator('.modal').count() === 0, '生成弹窗关闭')

  // ---- 数据统计 ----
  await page.click('a[href="#/stats"]')
  await page.waitForSelector('#s-body .kpi-grid', { timeout: 5000 })
  assert(await page.locator('#s-body svg').count() >= 2, '统计图表渲染')
  assert((await page.locator('#s-body').textContent()).includes('day'), '页面表格含 day')
  assert((await page.locator('#s-body').textContent()).includes('工具内页面访客趋势'), '页面趋势卡片')

  // ---- 版本记录 ----
  await page.click('a[href="#/releases"]')
  await page.waitForSelector('#r-table table tbody tr', { timeout: 5000 })
  assert(await page.locator('#r-table tbody tr').count() === 2, '版本记录 2 行')
  assert((await page.locator('#r-table').textContent()).includes('v0.2.3'), '版本号展示')
  // 编辑弹窗
  await page.click('#r-table tbody tr:nth-child(1) button[data-op="edit"]')
  await page.waitForSelector('#rm-version', { timeout: 3000 })
  assert((await page.locator('#rm-version').inputValue()) === '0.2.3', '编辑弹窗回填')
  assert((await page.locator('#rm-items').inputValue()).includes('toast 位置调整'), '条目回填')
  await page.click('#rm-cancel')

  // ---- 退出登录 ----
  await page.click('#logout-link')
  await page.waitForSelector('#login-form', { timeout: 3000 })
  assert(await page.locator('#login-form').count() === 1, '退出后回到登录页')

  await browser.close()

  if (errors.length) {
    console.error('\n✗ 发现问题:')
    errors.forEach((e) => console.error('  -', e))
    process.exit(1)
  }
  console.log('\n全部通过 ✓')
}

main().catch((e) => { console.error(e); process.exit(1) })
