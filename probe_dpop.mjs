import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-proxy-server', '--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: 420, height: 1060 }, deviceScaleFactor: 2 })
const at = new Date().toISOString()
const remind = new Date(); remind.setHours(14, 30, 0, 0)
const task = { id: 't1', parentId: null, listId: 'l1', title: '家教老师要来上课', notes: '', meta: '', priority: 'normal', isImportant: false, isPinned: false, done: false, dueDate: new Date('2026-10-21T00:01:00').toISOString(), dueEndDate: new Date('2026-10-21T23:59:00').toISOString(), remindAt: remind.toISOString(), deletedAt: null, createdAt: at, updatedAt: at }
const list = { id: 'l1', title: '默认', kind: 'todo', collapsed: false, position: 0 }
await page.addInitScript((t, l) => { localStorage.setItem('todobar.tasks.v2', JSON.stringify([t])); localStorage.setItem('todobar.lists.v2', JSON.stringify([l])) }, task, list)
await page.goto('file:///D:/Wordbuddy/2026-10-09-10-11-34/todobar/dist/index.html', { waitUntil: 'load' })
await page.waitForTimeout(2500)
await page.locator('[aria-label="家教老师要来上课 设置"]').first().dispatchEvent('click')
await page.waitForTimeout(800)
await page.locator('.sheet-dpop-input').nth(0).dispatchEvent('click')
await page.waitForTimeout(500)
const info = await page.evaluate(() => {
  const pop = document.querySelector('.sheet-dpop')
  const cs = getComputedStyle(pop)
  // 弹层标题行中心点,看命中的是谁
  const head = pop.querySelector('.sheet-dpop-title').getBoundingClientRect()
  const hit = document.elementFromPoint(head.left + head.width / 2, head.top + head.height / 2)
  // 时/分列滚动位置
  const scs = [...pop.querySelectorAll('.sheet-dpop-time-scroll')]
  return {
    bg: cs.backgroundColor, z: cs.zIndex, pos: cs.position,
    topEl: hit ? hit.className || hit.tagName : null,
    headRect: { t: Math.round(head.top), b: Math.round(head.bottom) },
    scrollTops: scs.map((s) => s.scrollTop),
  }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
