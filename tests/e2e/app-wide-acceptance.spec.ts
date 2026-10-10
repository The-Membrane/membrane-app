import { expect, test } from '@playwright/test'

const PUBLIC_TOOLS = [
  { path: '/ethereum/evidence', heading: 'What our engine would have done' },
  { path: '/ethereum/carry', heading: 'Borrow against dollars that keep earning.' },
  { path: '/ethereum/radar', heading: 'Carry Radar' },
  { path: '/ethereum/receipts', heading: 'Called It' },
  { path: '/ethereum/alerts', heading: 'Your alerts' },
] as const

test('public Ethereum tools expose one heading and keep light mode inside the viewport', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'one bounded two-viewport sweep')
  await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })
    for (const tool of PUBLIC_TOOLS) {
      await page.goto(tool.path, { waitUntil: 'domcontentloaded' })
      // A visible heading can be present behind the first-load overlay. Judge
      // the settled page, not the boot splash that covers it during hydration.
      await expect(page.getByRole('status', { name: 'Loading The Membrane' })).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-membrane-theme', 'light')
      await expect(page.getByRole('heading', { level: 1, name: tool.heading })).toBeVisible()
      await expect(page.locator('h1')).toHaveCount(1)
      await expect
        .poll(async () => {
          try {
            return await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            )
          } catch (error) {
            // A cold Next dev compile can reload once after the heading appears.
            if (String(error).includes('Execution context was destroyed')) return Infinity
            throw error
          }
        })
        .toBeLessThanOrEqual(1)
    }
  }
})
