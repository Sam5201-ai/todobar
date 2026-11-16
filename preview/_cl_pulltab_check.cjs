/**
 * 收起态拉杆（.cl-pulltab）渲染校验：
 * 1) 用**真实 clothesline.css** 渲染三种状态（静止 / 下拉 55% / 下拉 100%），出图供人眼比对；
 * 2) 数值断言：命中盒仍是 480×96、丝线/瓷珠/小柄水平居中、下拉时按 --cl-pull 线性位移、
 *    且布局锚点（小柄 top/宽高）与 Rust collapsedHitRects 的口径一致；
 * 3) 三套皮肤（素瓷 / 黄铜 / 琉璃）**几何骨架逐像素一致**，但材质确实不同
 *    —— 配置页三选一后，命中带与 --cl-pull 动效不能因换皮肤而变。
 *
 * 运行：node preview/_cl_pulltab_check.cjs
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/clothesline/clothesline.css'), 'utf8')

const html = (pull, extraClass = '', skin = 'porcelain') => `<!doctype html><html><head><meta charset="utf-8">
<style>${CSS}
/* 与真实应用一致：index.css 里是全局 border-box（少了它 34×38 会算成 36×40） */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent}
/* 校验用背板：真实环境是透明置顶窗，铺一块浅色才看得清白瓷柄边缘 */
.cv-bg{position:fixed;inset:0;background:linear-gradient(160deg,#eef1f6,#dfe6f2)}
</style></head>
<body><div class="cv-bg"></div>
<div class="cl-root is-collapsed" data-theme="light" data-runtime="tauri" data-cl-state="ready"
     data-pulltab="${skin}" style="width:520px;height:96px">
  <button type="button" class="cl-pulltab ${extraClass}"
          style="left:calc(50% - 240px); --cl-pull:${pull}">
    <span class="cl-pull-cord"></span>
    <span class="cl-pull-bead"></span>
    <span class="cl-pull-tab">
      <span class="cl-pull-grip"></span>
      <span class="cl-pull-foot"></span>
    </span>
    <span class="cl-pull-badge">9 张挂在这里</span>
  </button>
</div>
</body></html>`

const SKINS = ['porcelain', 'brass', 'glass']
const cases = [
  { name: 'idle', pull: 0, cls: '' },
  { name: 'pull-55', pull: 0.55, cls: 'is-pulling' },
  { name: 'pull-100', pull: 1, cls: 'is-pulling' },
]

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 520, height: 96 }, deviceScaleFactor: 2 })
  const bySkin = {}
  const fails = []

  for (const skin of SKINS) {
    const out = []
    for (const c of cases) {
      await page.setContent(html(c.pull, c.cls, skin), { waitUntil: 'load' })
      // 关掉无限提示动画带来的相位差异，让三张图可逐像素比较
      await page.addStyleTag({ content: '.cl-pull-foot{animation:none !important}' })
      await page.waitForTimeout(60)
      const m = await page.evaluate(() => {
        const r = (el) => {
          const b = el.getBoundingClientRect()
          return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
        }
        const tab = document.querySelector('.cl-pull-tab')
        return {
          box: r(document.querySelector('.cl-pulltab')),
          cord: r(document.querySelector('.cl-pull-cord')),
          bead: r(document.querySelector('.cl-pull-bead')),
          handle: r(tab),
          cordTransform: getComputedStyle(document.querySelector('.cl-pull-cord')).transform,
          handleBg: getComputedStyle(tab).backgroundImage,
        }
      })
      out.push({ name: c.name, ...m })
      // 只有默认款出图，避免三套图互相覆盖
      if (skin === 'porcelain') {
        await page.screenshot({ path: path.join(__dirname, `_cl_pulltab_${c.name}.png`), omitBackground: true })
      }
    }
    bySkin[skin] = out
  }

  await browser.close()

  // —— 断言（全部基于数值，不靠肉眼） ——
  const cx = 260 // 窗口 520 宽 → 中心
  const near = (a, b, tol = 1.2) => Math.abs(a - b) <= tol
  const geom = (o) => JSON.stringify([o.box, o.cord, o.bead, o.handle])

  for (const skin of SKINS) {
    const [idle, half, full] = bySkin[skin]
    const tag = `[${skin}]`
    if (!(near(idle.box.w, 480) && near(idle.box.h, 96)))
      fails.push(`${tag} 命中盒应为 480×96，实际 ${idle.box.w}×${idle.box.h}`)
    for (const o of bySkin[skin]) {
      const n = `${tag} ${o.name}`
      // 丝线 / 瓷珠 / 小柄都必须以窗口中心对齐（Rust 命中带也按中心算）
      if (!near(o.cord.x + o.cord.w / 2, cx)) fails.push(`${n}: 丝线未居中 (${o.cord.x}+${o.cord.w}/2)`)
      if (!near(o.bead.x + o.bead.w / 2, cx)) fails.push(`${n}: 瓷珠未居中`)
      if (!near(o.handle.x + o.handle.w / 2, cx)) fails.push(`${n}: 小柄未居中`)
    }
    // 小柄几何锚点（与 collapsedHitRects 的 96px 高带一致：底边不得越出 96）
    if (!(near(idle.handle.y, 28) && near(idle.handle.w, 30) && near(idle.handle.h, 36)))
      fails.push(`${tag} 静止态小柄应为 top28 / 30×36，实际 ${idle.handle.y} / ${idle.handle.w}×${idle.handle.h}`)
    if (full.handle.y + full.handle.h > 96)
      fails.push(`${tag} 拉到最深时小柄底边越出窗口 (${full.handle.y + full.handle.h} > 96)`)
    // 下拉位移：55% ≈ 14.8px，100% = 27px
    if (!near(half.handle.y - idle.handle.y, 27 * 0.55, 2))
      fails.push(`${tag} 55% 下拉位移应 ≈14.8px，实际 ${(half.handle.y - idle.handle.y).toFixed(1)}`)
    if (!near(full.handle.y - idle.handle.y, 27, 2))
      fails.push(`${tag} 100% 下拉位移应 =27px，实际 ${(full.handle.y - idle.handle.y).toFixed(1)}`)
    // 丝线在 100% 时纵向拉伸约 2.05 倍（scaleY 1 + 1.05）
    if (!/matrix\(1,\s*0,\s*0,\s*2\.0/.test(full.cordTransform))
      fails.push(`${tag} 丝线应被纵向拉伸 ≈2.05，实际 ${full.cordTransform}`)
  }

  // 三套皮肤几何骨架必须逐像素一致（换皮肤不能改变命中盒 / 拉绳位置 / 下拉位移）
  for (const skin of SKINS.slice(1)) {
    for (let i = 0; i < cases.length; i++) {
      if (geom(bySkin.porcelain[i]) !== geom(bySkin[skin][i]))
        fails.push(`[${skin}] ${cases[i].name} 几何与素瓷不一致`)
    }
  }
  // 三套材质确实不同（防止选择器没生效、三款长得一样）
  const bgs = SKINS.map((s) => bySkin[s][0].handleBg)
  if (new Set(bgs).size !== SKINS.length)
    fails.push(`三套皮肤材质未生效（backgroundImage 只有 ${new Set(bgs).size} 种）`)

  console.log(JSON.stringify(bySkin.porcelain.map(({ handleBg, ...rest }) => rest), null, 2))
  console.log('\n皮肤几何一致性：' + SKINS.join(' / '))
  if (fails.length) {
    console.log('\n❌ FAIL')
    fails.forEach((f) => console.log(' - ' + f))
    process.exit(1)
  }
  console.log('\n✅ 三套皮肤几何 / 下拉动效全部断言通过')
})()
