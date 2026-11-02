import { test, expect } from '@playwright/test'

/**
 * 验收:删除重复事项的「范围确认」弹窗。
 * 1) 点重复实例的设置→「删除事项」,弹出确认:仅删该日期 / 删全部日期
 * 2) 选「仅删除该日期」后,当天不再出现该实例,但整组在其它日期仍存在
 * 3) 选「删除全部日期」后,整组在所有日期都消失
 * 4) 一次性任务点「删除事项」直接删除,不弹确认
 */
test('recurring delete: scope dialog + single occurrence removal', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  // 种子:每天重复的「每日早会」
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('每日早会')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 日待办(默认)应出现今天的实例
  expect(await page.locator('.tree-body strong:has-text("每日早会")').count()).toBeGreaterThan(0)

  // 打开今天这条的设置
  await page.locator('button[aria-label="每日早会 设置"]').first().click()
  await page.waitForTimeout(400)
  // 点「删除事项」→ 应弹出范围确认
  await page.locator('.sheet-danger:has-text("删除事项")').click()
  await page.waitForTimeout(300)

  const confirm = page.locator('.confirm-sheet')
  await expect(confirm).toBeVisible()
  // 两个选项都存在
  await expect(confirm.locator('.sheet-danger:has-text("仅删除")')).toBeVisible()
  await expect(confirm.locator('.sheet-danger:has-text("删除全部日期")')).toBeVisible()
  console.log('CONFIRM DIALOG visible with two options: OK')

  // 选「仅删除该日期」
  await confirm.locator('.sheet-danger:has-text("仅删除")').click()
  await page.waitForTimeout(600)

  // 当天(日视图)该实例应消失
  const dayAfter = await page.locator('.tree-body strong:has-text("每日早会")').count()
  console.log('DAY after single-delete count:', dayAfter)
  expect(dayAfter).toBe(0)

  // 整组仍在:切到月视图,未来日期(如明天)仍应出现该实例——说明仅删了该日期
  await page.locator('.tab-bar button').nth(2).click()
  await page.waitForTimeout(500)
  const monthAfter = await page.locator('.tree-body strong:has-text("每日早会")').count()
  console.log('MONTH after single-delete count:', monthAfter, '(应 >=1,整组仍在)')
  expect(monthAfter).toBeGreaterThanOrEqual(1)
})

test('recurring delete: remove whole series', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('每日打卡')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 当天应出现实例
  expect(await page.locator('.tree-body strong:has-text("每日打卡")').count()).toBeGreaterThan(0)

  // 打开设置→删除→确认「删除全部日期」
  await page.locator('button[aria-label="每日打卡 设置"]').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-danger:has-text("删除事项")').click()
  await page.waitForTimeout(300)
  await page.locator('.confirm-sheet').locator('.sheet-danger:has-text("删除全部日期")').click()
  await page.waitForTimeout(600)

  // 日视图不再出现该实例
  const day = await page.locator('.tree-body strong:has-text("每日打卡")').count()
  console.log('DAY after delete-series count:', day, '(应 =0)')
  expect(day).toBe(0)

  // 周视图(整组)也不应再出现
  await page.locator('.tab-bar button').nth(1).click()
  await page.waitForTimeout(500)
  const week = await page.locator('.tree-body strong:has-text("每日打卡")').count()
  console.log('WEEK after delete-series count:', week, '(应 =0)')
  expect(week).toBe(0)
})

test('one-time task delete: no confirm dialog', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  // 一次性任务「买菜」
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-main-input').fill('买菜')
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(600)

  // 默认 tab(日)出现
  expect(await page.locator('.tree-body strong:has-text("买菜")').count()).toBeGreaterThan(0)

  // 点设置→删除:一次性任务不应弹确认,直接删除
  await page.locator('button[aria-label="买菜 设置"]').first().click()
  await page.waitForTimeout(400)
  await page.locator('.sheet-danger:has-text("删除事项")').click()
  await page.waitForTimeout(500)

  const confirm = page.locator('.confirm-sheet')
  await expect(confirm).toHaveCount(0)
  const day = await page.locator('.tree-body strong:has-text("买菜")').count()
  console.log('ONE-TIME after delete count:', day, '(应 =0)')
  expect(day).toBe(0)
})
