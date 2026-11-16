/** 把三款拉杆设计提案渲染成 PNG，便于用户直接看图选择。 */
const path = require('path')
const { chromium } = require('playwright')

;(async () => {
  const file = 'file:///' + path.resolve(__dirname, 'clothesline-pulltab-designs.html').replace(/\\/g, '/')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 }, deviceScaleFactor: 2 })
  await page.goto(file, { waitUntil: 'load' })
  await page.screenshot({ path: path.join(__dirname, 'cl-design-sheet.png'), fullPage: true })
  for (const k of ['a', 'b', 'c']) {
    const el = await page.$(`.opt-${k}`)
    await el.screenshot({ path: path.join(__dirname, `cl-design-${k.toUpperCase()}.png`) })
  }
  // 单看放大态的三款静止图，方便并排比较
  const stage = await page.$('.opt-a .stage[data-state="idle"] .wall')
  console.log('stage box', await stage.boundingBox())
  await browser.close()
  console.log('OK: cl-design-sheet.png / cl-design-A.png / cl-design-B.png / cl-design-C.png')
})().catch(e => { console.error(e); process.exit(1) })
