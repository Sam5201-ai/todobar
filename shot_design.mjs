// 设计稿截图:把状态模块设计.html 里的四块渲染为 PNG
import { chromium } from 'playwright'

const browser = await chromium.launch({ args: ['--no-proxy-server'] })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1800 }, deviceScaleFactor: 2 })
  await page.goto('file:///D:/Wordbuddy/2026-10-09-10-11-34/todobar/design-preview/状态模块设计.html', { waitUntil: 'load' })
  await page.waitForTimeout(800)
  const cards = page.locator('body > div')
  const n = await cards.count()
  console.log('sections:', n)
  for (let i = 0; i < n; i++) {
    await cards.nth(i).screenshot({ path: `design-preview/设计图${i + 4}-状态模块.png` })
    console.log('shot', i + 4)
  }
} finally {
  await browser.close()
}
