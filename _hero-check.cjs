const { chromium } = require('playwright-core')
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })
  await page.goto('http://localhost:4088/', { waitUntil: 'load' })
  const hero = await page.$('#hero')
  await page.waitForTimeout(1200)
  await hero.screenshot({ path: 'release/_hero-check.png' })
  await page.waitForTimeout(2600) // 到达展开停留段
  await hero.screenshot({ path: 'release/_hero-check-expanded.png' })
  await browser.close()
  console.log('saved both')
}
main().catch((e) => { console.error(e); process.exit(1) })
