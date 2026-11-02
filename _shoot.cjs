const { chromium } = require('playwright-core')
const T = (title, dueDate, remindAt, pin) => ({
  id: 't_' + Math.random().toString(36).slice(2), title, listId: 'today',
  notes: '', meta: '', priority: pin ? 'high' : 'none',
  isImportant: !!pin, isPinned: !!pin, done: false,
  dueDate: dueDate ?? null, remindAt: remindAt ?? null, recurrence: null,
  seriesId: null, deletedAt: null, sortOrder: null,
  createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
})
const TASKS = [
  T('整理季度 OKR 评审材料', '2026-10-13T18:00:00', '2026-10-13T17:30:00', true),
  T('回复客户反馈邮件', '2026-10-13T20:00:00', null, false),
  T('健身房 · 力量训练 45min', '2026-10-13T21:00:00', '2026-10-13T20:45:00', false),
]
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })
  await page.addInitScript(([tasks, settings]) => {
    localStorage.setItem('todobar.tasks.v2', JSON.stringify(tasks))
    localStorage.setItem('todobar.sidebar.settings.v19', JSON.stringify(settings))
  }, [TASKS, { background: 'img-mountain', theme: 'light' }])
  await page.goto('http://localhost:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const cls = await page.evaluate(() => document.querySelector('.workspace')?.className ?? '')
  if (!cls.includes('is-sidebar-open')) {
    await page.evaluate(() => document.querySelector('.edge-handle')?.click())
    await page.waitForTimeout(600)
  }
  await page.evaluate(() => document.querySelector('button[aria-label="侧栏设置"]')?.click())
  await page.waitForTimeout(900)
  await page.locator('.page-panel').screenshot({ path: 'release/screenshots/settings-bg.png' })
  console.log('saved settings-bg.png')
  await browser.close(); process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
