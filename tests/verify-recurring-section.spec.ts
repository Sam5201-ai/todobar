import { test, expect } from '@playwright/test'

/**
 * 验收:重复事项「常驻显示规则行」。
 * 1) 添加重复事项后,日视图顶部的「重复事项」区立即可见(不依赖发生日是否在当前视图)
 * 2) 非今天发生的重复事项(如每周三)也出现在该区,解决「加完看不到」的问题
 * 3) 点击规则行可打开整组设置弹窗
 */
test('recurring rules show in persistent section after adding', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  // 添加「每天」重复任务
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('每日早会')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 添加「每周三」重复任务(今天周日,周三不在日/本周视图的发生日里)
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('每周三读书')
  await page.locator('.recur-chip:has-text("每周")').click()
  await page.waitForTimeout(150)
  await page.locator('.recur-chip:has-text("周三")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 「重复事项」常驻区应出现,且含 2 条规则(每天 + 每周三)
  const section = page.locator('.recurring-section')
  await expect(section).toBeVisible()
  const rows = section.locator('.recur-rule-row')
  const rowCount = await rows.count()
  console.log('RECURRING SECTION rows:', rowCount, '(应 =2)')
  expect(rowCount).toBe(2)

  const titles = await rows.locator('strong').allInnerTexts()
  console.log('RECURRING ROW TITLES:', JSON.stringify(titles))
  expect(titles).toContain('每日早会')
  expect(titles).toContain('每周三读书')

  // 每条应显示规则文案与「下次」提示(行按新建倒序:首行=每周三读书,次行=每日早会)
  const metas = await rows.locator('.recur-rule-meta').allInnerTexts()
  const joinedMeta = metas.map((m) => m.replace(/\s+/g, ' ')).join(' | ')
  console.log('ROW METAS:', joinedMeta)
  expect(joinedMeta).toContain('每天')
  expect(joinedMeta).toContain('每周三')
  expect(joinedMeta).toContain('下次')

  // 点击规则行 → 打开整组设置弹窗
  await rows.first().click()
  await page.waitForTimeout(400)
  const sheetVisible = await page.locator('.sheet').first().isVisible().catch(() => false)
  console.log('SETTINGS SHEET visible after click rule row:', sheetVisible)
  expect(sheetVisible).toBe(true)
})
