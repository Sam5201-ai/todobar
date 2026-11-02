import { test, expect } from '@playwright/test'

/**
 * 回归:重复事项只对当前及未来日期生效,历史日期不出现。
 * 添加「每天」任务后,在月视图里它只应出现在 今天及之后 的日期分组,
 * 绝不应出现在今天之前的日期。
 */
test('recurring items appear only from today onward', async ({ page }) => {
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

  // 切到月视图(当月)
  await page.locator('.tab-bar button').nth(2).click()
  await page.waitForTimeout(500)

  const today = new Date().getDate()
  // 收集所有含「每日早会」的日期分组(.range-group)标签,形如 "10/11 周日"
  const groups = page.locator('.range-group').filter({
    has: page.locator('.tree-body strong:has-text("每日早会")'),
  })
  const labels = await groups.locator('.range-group-title').allInnerTexts()
  console.log('MONTH GROUPS WITH 每日早会 (labels):', JSON.stringify(labels))
  // 解析每个标签里的「日」数字(标签形如 M/D 周X)
  const days = labels
    .map((l) => {
      const m = l.match(/(\d{1,2})-(\d{1,2})/)
      return m ? Number(m[2]) : NaN
    })
    .filter((n) => !Number.isNaN(n))
  console.log('OCCURRENCE DAYS:', JSON.stringify(days))
  expect(days.length).toBeGreaterThan(0)
  for (const d of days) {
    expect(d, `历史日期 ${d} 不应出现重复事项`).toBeGreaterThanOrEqual(today)
  }
})
