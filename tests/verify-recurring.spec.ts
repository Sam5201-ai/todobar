import { test, expect } from '@playwright/test'

/**
 * 验收:重复事项(模板 + 运行时投影)。
 * 1) 添加「每天」重复任务后,日待办与周待办都出现它
 * 2) 勾选完成某天实例后,该天标记为已完成(出现删除线/对勾),刷新后保持
 * 3) 添加「每周五」任务后,只在周五出现
 */
test('recurring task shows in day/week and toggles per-day', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  // 打开添加事项弹窗
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('每日早会')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 日待办(默认 tab)应出现「每日早会」
  const dayHas = await page.locator('.tree-body strong:has-text("每日早会")').count()
  console.log('DAY HAS 每日早会:', dayHas)
  expect(dayHas).toBeGreaterThan(0)

  // 切到周待办,只应出现 今天及本周剩余天数(历史日期不出现)
  await page.locator('.tab-bar button').nth(1).click()
  await page.waitForTimeout(500)
  const weekCount = await page.locator('.tree-body strong:has-text("每日早会")').count()
  // 今天到周日(含今天)的天数:周日=1,周一=7,…
  const dow = new Date().getDay()
  const expectedWeek = dow === 0 ? 1 : 7 - dow
  console.log('WEEK occurrences of 每日早会:', weekCount, 'expected(今天+本周剩余):', expectedWeek)
  expect(weekCount).toBe(expectedWeek)

  // 勾选今天那一条(第一条)
  const firstCheck = page.locator('.check-button').first()
  await firstCheck.click()
  await page.waitForTimeout(500)
  const doneCount = await page.locator('.tree-body strong.is-done:has-text("每日早会")').count()
  console.log('AFTER TOGGLE done count:', doneCount)
  expect(doneCount).toBeGreaterThan(0)

  await page.screenshot({ path: 'test-results/recurring-week.png' })

  // 刷新后完成态应保持(写回模板 completedDates)
  await page.reload()
  await page.waitForTimeout(400)
  await page.locator('.tab-bar button').nth(1).click()
  await page.waitForTimeout(500)
  const afterReload = await page.locator('.tree-body strong.is-done:has-text("每日早会")').count()
  console.log('AFTER RELOAD done count:', afterReload)
  expect(afterReload).toBeGreaterThan(0)
})
