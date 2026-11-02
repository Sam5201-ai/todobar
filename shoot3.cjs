// 截万年历页 + 收集展开/收起动画帧
const { chromium } = require('playwright-core')
const fs = require('fs')

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
  T('阅读《纳瓦尔宝典》第 3 章', '2026-10-14T22:00:00', null, false),
]

async function newPage(browser, { dpr = 2, width = 1500, height = 950 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(([tasks, settings]) => {
    localStorage.setItem('todobar.tasks.v2', JSON.stringify(tasks))
    localStorage.setItem('todobar.sidebar.settings.v18', JSON.stringify(settings))
  }, [TASKS, { background: 'img-mountain', theme: 'light' }])
  await page.goto('http://localhost:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  return page
}

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })

  // ===== 1. 万年历页截图 =====
  {
    const page = await newPage(browser)
    const cls = await page.evaluate(() => document.querySelector('.workspace')?.className ?? '')
    if (!cls.includes('is-sidebar-open')) {
      await page.evaluate(() => document.querySelector('.edge-handle')?.click())
      await page.waitForTimeout(600)
    }
    await page.evaluate(() => document.querySelector('[data-tip="黄历 · 万年历"]')?.click())
    await page.waitForTimeout(1000)
    await page.locator('.page-panel').screenshot({ path: 'release/screenshots/huangli.png' })
    console.log('saved huangli.png')
    await page.close()
  }

  // ===== 2. 展开/收起动画帧(收起 -> 展开 -> 收起) =====
  {
    fs.mkdirSync('frames', { recursive: true })
    const page = await newPage(browser, { dpr: 1, width: 1280, height: 800 })
    await page.waitForTimeout(400)
    let i = 0
    const snap = async () => {
      await page.screenshot({ path: `frames/f${String(i++).padStart(3, '0')}.png` })
    }
    // 收起状态停几帧
    await snap(); await snap(); await snap(); await snap()
    // 展开
    await page.evaluate(() => document.querySelector('.edge-handle')?.click())
    for (let k = 0; k < 14; k++) await snap()
    // 展开状态停几帧
    for (let k = 0; k < 6; k++) await snap()
    // 收起
    const cls = await page.evaluate(() => document.querySelector('.workspace')?.className ?? '')
    if (cls.includes('is-sidebar-open')) {
      // 展开态的关闭按钮/再次点击 edge-handle? 展开后 handle 仍在
      await page.evaluate(() => document.querySelector('.edge-handle')?.click())
    }
    for (let k = 0; k < 14; k++) await snap()
    for (let k = 0; k < 4; k++) await snap()
    console.log('frames total:', i)
    // 校验最后一帧侧栏是否收起
    const final = await page.evaluate(() => document.querySelector('.workspace')?.className ?? '')
    console.log('final workspace:', final.slice(0, 100))
    await page.close()
  }

  await browser.close()
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
