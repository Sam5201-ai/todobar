// 预览验证:主窗口注入测试任务 → 打开任务设置 sheet → 点「结束日期」→ 截图月历弹层
import { chromium } from 'playwright'

const browser = await chromium.launch({ args: ['--no-proxy-server', '--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 420, height: 1060 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('[pageerror]', String(e.stack || e).slice(0, 1200)))

const at = new Date().toISOString()
const task = {
  id: 't1', parentId: null, listId: 'l1', title: '家教老师要来上课', notes: '', meta: '',
  priority: 'normal', isImportant: false, isPinned: false, done: false,
  dueDate: new Date('2026-10-21T00:01:00').toISOString(),
  dueEndDate: new Date('2026-10-21T23:59:00').toISOString(),
  remindAt: null, deletedAt: null, createdAt: at, updatedAt: at,
}
const list = { id: 'l1', title: '默认', kind: 'todo', collapsed: false, position: 0 }
await page.addInitScript(
  (t, l) => {
    localStorage.setItem('todobar.tasks.v2', JSON.stringify([t]))
    localStorage.setItem('todobar.lists.v2', JSON.stringify([l]))
  },
  task, list,
)

await page.goto('file:///D:/Wordbuddy/2026-10-09-10-11-34/todobar/dist/index.html', { waitUntil: 'load' })
await page.waitForTimeout(2500)
await page.screenshot({ path: 'preview-dpop-0.png' })
const probe = await page.evaluate(() => ({
  bodyLen: document.body.innerText.length,
  hasTask: document.body.innerText.includes('家教老师要来上课'),
  gearCount: document.querySelectorAll('[aria-label*="设置"]').length,
}))
console.log('probe:', JSON.stringify(probe))

// 打开任务的设置弹窗:点任务行内的齿轮(aria-label = 「<标题> 设置」)
const gear = page.locator('[aria-label="家教老师要来上课 设置"]').first()
await gear.dispatchEvent('click')
await page.waitForTimeout(800)
console.log('sheet open:', await page.locator('.sheet').count())

// 点结束日期(第二个日期输入按钮)
const btns = page.locator('.sheet-dpop-input')
console.log('dpop inputs:', await btns.count())
await btns.nth(1).scrollIntoViewIfNeeded().catch(() => {})
await btns.nth(1).dispatchEvent('click')
await page.waitForTimeout(500)
console.log('popup open:', await page.locator('.sheet-dpop').count())

// 验证弹层完整落在可视区内
const clip = await page.evaluate(() => {
  const el = document.querySelector('.sheet-dpop')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight }
})
console.log('popup rect:', JSON.stringify(clip))

await page.screenshot({ path: 'preview-dpop.png' })
await browser.close()
console.log('DONE')
