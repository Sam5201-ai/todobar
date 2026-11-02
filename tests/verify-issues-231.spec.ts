import { expect, test } from '@playwright/test'

// 问题2:重复周期事项的「设置」按钮应能打开弹窗(打开其模板/整组设置)
test('recurring instance settings button opens the series settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(800)

  // 种入一条「每天」重复任务
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(300)
  await page.locator('.sheet-main-input').fill('每日早会')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(500)

  // 切到周待办,找到一个重复实例
  await page.locator('.tab-bar button').nth(1).click()
  await page.waitForTimeout(400)

  const node = page.locator('.tree-node', { hasText: '每日早会' }).first()
  await expect(node).toBeVisible()
  // 点击该实例的「设置」按钮(此前会因虚拟 id 找不到记录而无法打开)
  await node.getByRole('button', { name: /设置/ }).click()
  await page.waitForTimeout(400)

  // 弹窗应出现
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
})

// 问题3:tab 栏与日期栏在滚动列表时保持固定(不在滚动容器内)
test('tab bar and date bar stay fixed while list scrolls', async ({ page }) => {
  await page.goto('/?open=1&day')
  await expect(page.locator('.todo-sidebar')).toBeVisible()

  // 结构断言:tab-bar / date-strip 在固定的 .sidebar-pinned 中,且不在 .sidebar-scroll 内
  expect(await page.locator('.sidebar-pinned .tab-bar').count()).toBe(1)
  expect(await page.locator('.sidebar-pinned .date-strip').count()).toBe(1)
  expect(await page.locator('.sidebar-scroll .tab-bar').count()).toBe(0)
  expect(await page.locator('.sidebar-scroll .date-strip').count()).toBe(0)

  // 强制让列表区溢出,验证滚动时 tab 栏位置不变
  await page.evaluate(() => {
    const sc = document.querySelector('.sidebar-scroll') as HTMLElement
    const spacer = document.createElement('div')
    spacer.style.height = '3000px'
    spacer.style.flex = '0 0 auto'
    sc.appendChild(spacer)
  })
  const topBefore = (await page.locator('.tab-bar').boundingBox())?.y ?? 0
  await page.evaluate(() => {
    const sc = document.querySelector('.sidebar-scroll') as HTMLElement
    sc.scrollTop = 1500
  })
  await page.waitForTimeout(150)
  const topAfter = (await page.locator('.tab-bar').boundingBox())?.y ?? 0
  const scrolled = await page.evaluate(
    () => (document.querySelector('.sidebar-scroll') as HTMLElement).scrollTop,
  )

  expect(scrolled).toBeGreaterThan(0)
  expect(Math.abs(topAfter - topBefore)).toBeLessThan(1)
})
