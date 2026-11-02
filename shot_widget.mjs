// 临时脚本:截图三套组件样式(file:// dist 预览自查 + 生成设置页预览图,不走网络)
import { chromium } from 'playwright'

const base = 'file:///D:/Wordbuddy/2026-10-09-10-11-34/todobar/dist/index.html?widget=1&style='
const shots = [
  ['candy', 468, 344],
  ['wide', 588, 248],
  ['sunset', 588, 238],
]
const browser = await chromium.launch({ args: ['--no-proxy-server', '--allow-file-access-from-files'] })
try {
  for (const [style, w, h] of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    // 确保根容器铺满视口(浏览器预览无 Tauri 固定窗高,需显式 100%)
    await page.addStyleTag({ content: 'html,body,#root{height:100%!important}' })
    await page.goto(base + style, { waitUntil: 'load', timeout: 20000 })
    await page.waitForTimeout(1600)
    await page.screenshot({ path: `preview-${style}.png`, omitBackground: true })
    console.log('shot', style, 'errors:', errors.length ? errors.join(' | ') : 'none')
    await page.close()
  }
} finally {
  await browser.close()
}
