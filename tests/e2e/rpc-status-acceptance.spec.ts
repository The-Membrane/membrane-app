import { expect, test } from '@playwright/test'

test('compact RPC failure leaves the mobile logo and chain selector usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 })
  await page.route('http://127.0.0.1:8545/**', (route) => route.abort())
  await page.goto('/ethereum/borrow', { waitUntil: 'domcontentloaded', timeout: 90_000 })

  const status = page.getByRole('button', { name: 'RPC offline; view connection details' })
  const logo = page.getByRole('link', { name: 'Membrane home' })
  const chain = page.getByRole('button', { name: 'Select chain' })
  await expect(status).toBeVisible({ timeout: 30_000 })
  await expect(logo).toBeVisible()
  await expect(chain).toBeVisible()

  const statusBox = await status.boundingBox()
  const logoBox = await logo.boundingBox()
  const chainBox = await chain.boundingBox()
  expect(statusBox).not.toBeNull()
  expect(logoBox).not.toBeNull()
  expect(chainBox).not.toBeNull()
  expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(statusBox!.x + 1)
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(chainBox!.x + 1)
  await status.click()
  await expect(page.getByText('Local contract RPC unavailable', { exact: true })).toBeVisible()
})
