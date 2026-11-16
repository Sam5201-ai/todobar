/**
 * 问题2 取证：用**真实 clothesline.css** 在 Chromium 里 hover 一张图片卡，
 * 逐元素 diff 全部 computed style。若有任何 alpha / transform / filter /
 * background / animation / box-shadow 变化，即为 CSS 侧根因；若零变化，
 * 则 CSS 彻底洗清，问题必在 WebView2 + DWM 合成层（Rust/平台侧）。
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/clothesline/clothesline.css'), 'utf8')

const WATCH = [
  'background-color', 'background-image', 'opacity', 'transform', 'filter',
  'backdrop-filter', 'box-shadow', 'outline', 'outline-color', 'border-color',
  'z-index', 'isolation', 'mix-blend-mode', 'will-change', 'animation',
  'animation-name', 'animation-play-state', 'transition', 'visibility',
  'color', 'display', 'position', 'clip-path', 'contain', 'perspective',
]

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent}
.probe-bg{position:fixed;inset:0;background:linear-gradient(160deg,#eef1f6,#dfe6f2)}
</style></head><body><div class="probe-bg"></div>
<div class="cl-root is-expanded has-wind" data-theme="light" data-runtime="tauri"
     data-cl-state="ready" style="width:1180px;height:300px">
  <div class="cl-rope-svg"><div class="cl-rope-under"></div></div>
  <div class="cl-deck" id="deck">
    <div class="cl-card-sway" style="--cl-wind-delay:-1.2s">
      <div class="cl-card cl-card-shot" id="target" style="--cl-rot:-1.1deg">
        <span class="cl-card-clip"></span>
        <div class="cl-card-actions">
          <button type="button">A</button><button type="button">B</button>
          <button type="button" class="is-danger">C</button>
        </div>
        <div class="cl-face">
          <button type="button" class="cl-photo" aria-label="点击查看大图">
            <span class="cl-photo-empty"><span class="cl-mini-shot"><span class="ms-bar"></span></span></span>
          </button>
          <div class="cl-caption">贴图</div>
          <div class="cl-meta">675×352</div>
        </div>
      </div>
    </div>
  </div>
</div></body></html>`

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } })
  await page.setContent(html, { waitUntil: 'load' })

  const snap = () => page.evaluate((keys) => {
    const out = {}
    const all = [...document.querySelectorAll('.cl-root, .cl-root *')]
    all.forEach((el, i) => {
      const cs = getComputedStyle(el)
      const rec = {}
      for (const k of keys) rec[k] = cs.getPropertyValue(k)
      out[`${i}:${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')}`] = rec
    })
    return out
  }, WATCH)

  const before = await snap()
  await page.hover('#target')
  await page.waitForTimeout(120)
  const after = await snap()
  await page.screenshot({ path: path.join(__dirname, 'cl-hover-probe.png') })

  const diffs = []
  for (const key of Object.keys(before)) {
    for (const prop of WATCH) {
      const a = before[key][prop]
      const b = after[key]?.[prop]
      if (a !== b) diffs.push({ el: key, prop, before: a, after: b })
    }
  }
  console.log('元素数:', Object.keys(before).length, ' 监视属性数:', WATCH.length)
  console.log('hover 前后 computed style 差异数:', diffs.length)
  for (const d of diffs) console.log('  ', d.el, '|', d.prop, '|', JSON.stringify(d.before), '->', JSON.stringify(d.after))
  console.log(diffs.length === 0
    ? '✅ CSS 侧零变化：hover 不改任何合成属性 → 纸面漏画必在 WebView2/DWM 平台层'
    : '⚠️ CSS 侧确有变化，需按上面条目逐条消除')
  await browser.close()
})().catch(e => { console.error(e); process.exit(1) })
