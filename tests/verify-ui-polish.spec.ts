import { expect, test } from '@playwright/test'

// 验证两项 UI 优化:
// 1) 待办页(.sidebar-scroll)与设置页(.settings-drawer/.settings-scroll)隐藏滚动轴但保留滚动
// 2) 周待办内的分组按日期升序(日期越近越靠前)
test('todo + settings scroll areas hide scrollbar', async ({ page }) => {
  await page.goto('/?open=1')
  await expect(page.locator('.todo-sidebar')).toBeVisible()

  // 待办页主滚动区:隐藏滚动轴
  const sidebarScroll = page.locator('.sidebar-scroll')
  await expect(sidebarScroll).toBeVisible()
  const sbWidth = await sidebarScroll.evaluate(
    (el) => getComputedStyle(el).scrollbarWidth,
  )
  expect(sbWidth).toBe('none')

  // 打开设置页(aria-label 为中文「侧栏设置」)
  await page.getByRole('button', { name: '侧栏设置' }).click()
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()

  // 设置页滚动容器:隐藏滚动轴(响应式容器优先,非响应式 .settings-drawer 兜底)
  const drawer = page.locator('.settings-drawer')
  if (await drawer.count()) {
    const drawerWidth = await drawer.evaluate(
      (el) => getComputedStyle(el).scrollbarWidth,
    )
    expect(drawerWidth).toBe('none')
  }
  const settingsScroll = page.locator('.settings-scroll')
  if (await settingsScroll.count()) {
    const ssWidth = await settingsScroll.evaluate(
      (el) => getComputedStyle(el).scrollbarWidth,
    )
    expect(ssWidth).toBe('none')
  }
})

test('week todo groups are ordered by date ascending (near first)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(800)

  // 种入一条「每天」重复任务,周视图会从今天投影到本周日
  await page.locator('.fab-add').first().click()
  await page.waitForTimeout(300)
  await page.locator('.sheet-main-input').fill('每日早会')
  await page.locator('.recur-chip:has-text("每天")').click()
  await page.waitForTimeout(150)
  await page.locator('.sheet-actions .is-primary').click()
  await page.waitForTimeout(500)

  // 切到周待办
  await page.locator('.tab-bar button').nth(1).click()
  await page.waitForTimeout(400)

  const labels = await page.locator('.range-group-title span').allInnerTexts()
  expect(labels.length).toBeGreaterThan(0)

  // 标签形如 "MM-DD 周X";按 MM-DD 升序即日期升序(越近越靠前)
  const keys = labels.map((l) => l.split(' ')[0])
  const sorted = [...keys].sort()
  expect(keys).toEqual(sorted)
})
