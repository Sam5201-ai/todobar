import { chromium } from 'playwright-core'
const EXE = 'C:/Users/HUAWEI/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe'
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('console', m=>console.log('CONSOLE',m.type(),m.text()))
page.on('pageerror', e=>console.log('PAGEERROR', e.message))
await page.goto('http://127.0.0.1:8123/?open=1', { waitUntil: 'networkidle' })
await page.locator('button[aria-label="计算器"]').click()
await page.waitForSelector('.calc-grid')
const nPanels = await page.locator('.page-panel').count()
console.log('page-panel count:', nPanels)
const html = await page.locator('.page-panel').last().innerHTML().catch(e=>'ERR '+e.message)
console.log('LAST PANEL HTML (first 600):\n', html.slice(0,600))
await browser.close()
