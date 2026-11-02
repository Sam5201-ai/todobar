import { test, expect } from '@playwright/test'

/**
 * 验收:关闭「启用同步」后,系统不再触发云端同步。
 *  - 设置中「立即同步」按钮应被禁用
 *  - (scheduleSync 由 enabled ref 守卫,本地改动不再发起请求)
 */
test('sync toggle off disables manual sync button', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 820 })
  await page.goto('/?open=1')
  await page.waitForTimeout(1000)

  // 打开设置抽屉
  await page.locator('.sidebar-header button[aria-label="设置"], .icon-cluster button').last().click()
  await page.waitForTimeout(400)
  // 直接定位设置里的「设置」入口(齿轮)。若上面没点到,改用文本。
  const settingsBtn = page.locator('button:has-text("设置")').first()
  if (await settingsBtn.count()) {
    await settingsBtn.click().catch(() => {})
    await page.waitForTimeout(400)
  }

  // 找到「启用同步」开关(点击 label,因为 checkbox input 被文字遮挡)
  const enableRow = page.locator('label:has-text("启用同步"), .toggle-row:has-text("启用同步")').first()
  const enableInput = enableRow.locator('input')
  await expect(enableRow).toBeVisible({ timeout: 5000 })
  const isChecked = await enableInput.isChecked()
  console.log('ENABLED BEFORE:', isChecked)

  // 关闭开关(若当前是开)
  if (isChecked) {
    await enableRow.click()
    await page.waitForTimeout(400)
  }

  // 立即同步按钮应被禁用(核心验收点:关闭启用同步后系统不再触发同步)
  const syncNow = page.locator('button.sync-now-button')
  await expect(syncNow).toBeVisible()
  const disabled = await syncNow.isDisabled()
  console.log('SYNC NOW DISABLED AFTER OFF:', disabled)
  expect(disabled).toBe(true)

  // 再打开开关,等待自动同步状态稳定后,按钮应恢复可用
  await enableRow.click()
  await page.waitForTimeout(600)
  // 等待 syncing 状态结束(自动同步会立刻触发一次)
  await expect
    .poll(async () => (await syncNow.isDisabled()) === false, { timeout: 15000 })
    .toBeTruthy()
  const disabled2 = await syncNow.isDisabled()
  console.log('SYNC NOW DISABLED AFTER ON:', disabled2)
  expect(disabled2).toBe(false)

  await page.screenshot({ path: 'test-results/sync-toggle.png' })
})
