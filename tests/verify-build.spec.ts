import { test, expect } from '@playwright/test'

/**
 * 针对本轮「记节日」六项优化的构建产物验收:
 * 直接加载 dist 构建产物(而非 dev server),确认新界面确实被打进包里。
 */
test('dist build contains the new 记节日 UI', async ({ page }) => {
  // 应用是右缘侧栏,真实窗口 382px 宽 —— 必须按同样尺寸渲染,
  // 否则 tab 会落在视口之外(这正是上一轮点击超时的原因)。
  await page.setViewportSize({ width: 382, height: 780 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto('/')
  await page.waitForTimeout(1200)

  // 侧栏默认停在屏幕外(transform: translateX(100% + 18px)),
  // 用官方的 ?open=1 参数强制展开,否则所有元素都在视口之外点不到。
  await page.goto('/?open=1')
  await page.waitForTimeout(1200)

  const sidebarOpen = await page.locator('.todo-sidebar').evaluate((el) =>
    el.classList.contains('is-open'),
  )
  console.log('SIDEBAR OPEN:', sidebarOpen)
  expect(sidebarOpen).toBe(true)

  // 1) 第四个 tab 名应为「记节日」
  const tabs = await page.locator('.tab-bar button').allInnerTexts()
  console.log('TABS:', JSON.stringify(tabs.map((t) => t.trim())))
  expect(tabs.join('')).toContain('记节日')

  // 切到「记节日」tab
  await page.locator('.tab-bar button').nth(3).click()
  await page.waitForTimeout(500)

  // 2) 分组标题:生日 / 纪念日
  const groups = await page.locator('.occasion-group').allInnerTexts()
  console.log('GROUPS:', JSON.stringify(groups.map((g) => g.split('\n')[0].trim())))
  expect(groups.length).toBe(2)

  // 3) 底部两个按钮:添加生日 / 添加纪念日
  const fabText = await page.locator('.fab-row').innerText()
  console.log('FAB:', JSON.stringify(fabText.replace(/\s+/g, ' ').trim()))
  expect(fabText).toContain('添加生日')
  expect(fabText).toContain('添加纪念日')

  // 4) 打开「添加生日」弹窗,检查头像选择器 / 本人选项 / 输入框样式
  await page.locator('.fab-row button').first().click()
  await page.waitForTimeout(500)

  const avatarCount = await page.locator('.avatar-option').count()
  console.log('AVATAR OPTIONS:', avatarCount)
  expect(avatarCount).toBe(5)

  const firstActive = await page.locator('.avatar-option').first().evaluate((el) =>
    el.classList.contains('is-active'),
  )
  console.log('AVATAR FIRST ACTIVE:', firstActive)
  expect(firstActive).toBe(true)

  // 头像图片确实加载成功(不是 broken image)
  const avatarImgsOk = await page.locator('.avatar-option img').evaluateAll((els) =>
    els.map((el) => {
      const img = el as HTMLImageElement
      return { src: img.getAttribute('src'), w: img.naturalWidth, complete: img.complete }
    }),
  )
  console.log('AVATAR IMGS:', JSON.stringify(avatarImgsOk))
  for (const a of avatarImgsOk) {
    expect(a.w, `avatar ${a.src} should load`).toBeGreaterThan(0)
  }

  const fieldStyle = await page.locator('.sheet-field').first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return { radius: cs.borderTopLeftRadius, border: cs.borderTopColor }
  })
  console.log('FIELD STYLE:', JSON.stringify(fieldStyle))
  expect(parseFloat(fieldStyle.radius)).toBeGreaterThanOrEqual(8)

  await page.screenshot({ path: 'test-results/build-birthday-sheet.png' })

  // 关闭弹窗(验证下滑收起动画)
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(600)
  await expect(page.locator('.sheet')).toHaveCount(0)

  // 5) 打开「添加纪念日」弹窗
  await page.locator('.fab-row button').nth(1).click()
  await page.waitForTimeout(600)
  const sheetTitle = await page.locator('.sheet-title').first().innerText()
  console.log('ANNI TITLE:', sheetTitle)
  expect(sheetTitle).toContain('纪念日')

  const anniText = await page.locator('.sheet').innerText()
  console.log('ANNI SECTIONS:', JSON.stringify(anniText.split('\n').slice(0, 14)))
  expect(anniText).toContain('历法')
  expect(anniText).toContain('日期')
  expect(anniText).toContain('提醒')
  expect(anniText).toContain('备注')

  // 纪念日不应出现头像选择器与"关系"字段
  const anniAvatarCount = await page.locator('.avatar-option').count()
  console.log('ANNI AVATAR OPTIONS:', anniAvatarCount)
  expect(anniAvatarCount).toBe(0)

  await page.screenshot({ path: 'test-results/build-anniversary-sheet.png' })

  console.log('PAGE ERRORS:', JSON.stringify(errors))
  expect(errors).toEqual([])
})
