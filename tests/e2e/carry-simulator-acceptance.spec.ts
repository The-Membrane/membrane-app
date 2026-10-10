import { expect, test, type Locator, type Page } from '@playwright/test'

const routes: { path: string; anchor: (page: Page) => Locator }[] = [
  {
    path: '/ethereum/carry',
    anchor: (page) => page.getByText('Borrow against dollars that keep earning.'),
  },
  {
    path: '/ethereum/simulator',
    anchor: (page) =>
      page.getByRole('textbox', { name: 'Ethereum address to read a lending position from' }),
  },
  {
    path: '/ethereum/alerts',
    anchor: (page) => page.getByRole('heading', { name: 'Your alerts', level: 1 }),
  },
]

for (const mode of ['dark', 'light'] as const) {
  test(`${mode} carry, simulator and alerts fit the viewport`, async ({ context }) => {
    for (const { path, anchor } of routes) {
      // Inspect each route in a fresh page; the dev server can reload another
      // route's open page when its on-demand compilation completes.
      const page = await context.newPage()
      await page.emulateMedia({ colorScheme: mode })
      await page.addInitScript((theme) => localStorage.setItem('membrane.theme', theme), mode)
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await expect(page.locator('html')).toHaveAttribute('data-membrane-theme', mode)
      await expect(page.getByRole('status', { name: 'Loading The Membrane' })).toHaveCount(0)
      await expect(page.getByText('RPC node is unreachable.')).toHaveCount(0)

      const visibleAnchor = anchor(page)
      await expect(visibleAnchor).toBeVisible({ timeout: 30_000 })
      const bounds = await visibleAnchor.boundingBox()
      const viewport = page.viewportSize()
      expect(bounds, `${path} anchor has a painted box`).not.toBeNull()
      expect(viewport).not.toBeNull()
      expect(bounds!.width, `${path} anchor has usable width`).toBeGreaterThan(20)
      expect(bounds!.x, `${path} anchor left edge`).toBeGreaterThanOrEqual(-1)
      expect(bounds!.x + bounds!.width, `${path} anchor right edge`).toBeLessThanOrEqual(
        viewport!.width + 1,
      )

      const geometry = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }))
      expect(geometry.document, `${path} document horizontal overflow`).toBeLessThanOrEqual(
        geometry.viewport + 1,
      )
      expect(geometry.body, `${path} body horizontal overflow`).toBeLessThanOrEqual(
        geometry.viewport + 1,
      )
      if (path === '/ethereum/simulator') {
        for (const label of [
          'sGHO vault TVL · all depositors · GHO units',
          'post-watch borrower overlap · not route TVL',
        ]) {
          const text = page.getByText(label, { exact: true })
          await expect(text).toBeVisible()
          const size = await text.evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          )
          expect(size, `${label} type size`).toBeGreaterThanOrEqual(12)
        }
        const routeTypeFloor = await page
          .getByTestId('measured-route-row')
          .first()
          .evaluate((row) =>
            Math.min(
              ...Array.from(row.querySelectorAll('p')).map((element) =>
                parseFloat(getComputedStyle(element).fontSize),
              ),
            ),
          )
        expect(routeTypeFloor, 'measured route row type size').toBeGreaterThanOrEqual(12)
        const clippedRouteText = await page
          .getByTestId('measured-route-row')
          .first()
          .evaluate((row) =>
            Array.from(row.querySelectorAll('p'))
              .filter((element) => element.scrollWidth > element.clientWidth + 1)
              .map((element) => element.textContent?.trim()),
          )
        expect(clippedRouteText, 'measured route row text clipping').toEqual([])
        if (viewport!.width <= 400) {
          const firstRoute = page.getByTestId('measured-route-row').first()
          const capital = firstRoute.getByTestId('mobile-route-capital')
          await expect(capital).toBeVisible()
          await expect(capital).toContainText('Aug cohort capital')
          await expect(capital).toContainText('Unpriced')
          await expect(capital).toContainText(/\d+\/\d+ priced/)
          const mobileGeometry = await firstRoute.evaluate((row) => {
            const capitalRow = row.querySelector('[data-testid="mobile-route-capital"]')!
            const spread = row.querySelector('button[aria-label^="August sampled spread"]')!
            const rowBox = row.getBoundingClientRect()
            const capitalBox = capitalRow.getBoundingClientRect()
            const spreadBox = spread.getBoundingClientRect()
            return {
              withinRow: capitalBox.left >= rowBox.left - 1 && capitalBox.right <= rowBox.right + 1,
              belowSpread: capitalBox.top >= spreadBox.bottom,
              clipped: Array.from(capitalRow.querySelectorAll('p')).some(
                (element) => element.scrollWidth > element.clientWidth + 1,
              ),
              minTypeSize: Math.min(
                ...Array.from(capitalRow.querySelectorAll('p')).map((element) =>
                  parseFloat(getComputedStyle(element).fontSize),
                ),
              ),
            }
          })
          expect(mobileGeometry.withinRow, 'mobile capital stays inside route').toBe(true)
          expect(mobileGeometry.belowSpread, 'mobile capital has its own row').toBe(true)
          expect(mobileGeometry.clipped, 'mobile capital text is not clipped').toBe(false)
          expect(mobileGeometry.minTypeSize, 'mobile capital type size').toBeGreaterThanOrEqual(12)
        }
        const caveat = page.getByText(/^Aug 2026 route cohort, not a count of positions/)
        const caveatSize = await caveat.evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        )
        expect(caveatSize, 'financial caveat type size').toBeGreaterThanOrEqual(12)
      }
      if (path === '/ethereum/simulator' && process.env.MEMBRANE_E2E_CAPTURE === '1') {
        const viewportLabel = viewport!.width <= 400 ? 'mobile' : 'desktop'
        await page.screenshot({
          path: `/private/tmp/membrane-simulator-${mode}-${viewportLabel}.png`,
        })
        await page.getByTestId('sim-inline-board').screenshot({
          path: `/private/tmp/membrane-board-${mode}-${viewportLabel}.png`,
        })
      }
      await page.close()
    }
  })
}

test('Disco timing planner remains legible on mobile', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))
  await page.goto('/ethereum/carry', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await expect(page.getByText('Borrow against dollars that keep earning.')).toBeVisible({
    timeout: 30_000,
  })

  await page.getByText('Inspect local Disco intent timing').click()
  await page.getByRole('textbox', { name: 'Days until lower LTV might be needed' }).fill('8')
  await page.getByRole('textbox', { name: 'Assumed lower-LTV wait, in days' }).fill('7')
  await page.getByRole('textbox', { name: 'Assumed execution window, in days' }).fill('2')

  const result = page.getByText('Today is inside the hypothetical request interval.')
  await expect(result).toBeVisible()
  await expect(
    page.getByText(/Earliest useful request: 1 day ago · latest request: in 1 day/),
  ).toBeVisible()
  const bounds = await result.boundingBox()
  const viewport = page.viewportSize()
  expect(bounds).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1)
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1)

  await page.getByRole('textbox', { name: 'Days until lower LTV might be needed' }).fill('7.04')
  await page.getByRole('textbox', { name: 'Assumed execution window, in days' }).fill('0.01')
  await expect(
    page.getByText(/Earliest useful request: in 43.2 minutes · latest request: in 57.6 minutes/),
  ).toBeVisible()
  if (process.env.MEMBRANE_E2E_CAPTURE === '1') {
    await page.screenshot({ path: '/private/tmp/membrane-disco-mobile-light.png' })
  }

  const depositKey = `0x${'1'.repeat(64)}`
  await page.route('**/api/disco/decision-snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        chainId: 31337,
        depositKey,
        discoAddress: `0x${'2'.repeat(40)}`,
        blockNumber: '1',
        blockHash: `0x${'3'.repeat(64)}`,
        blockTimestamp: '1760000000',
        depositOwner: `0x${'4'.repeat(40)}`,
        ltvSwitchingPeriodSeconds: '604800',
        executionWindowSeconds: '172800',
        intent: null,
      }),
    }),
  )
  await page.getByRole('textbox', { name: 'Disco deposit ID' }).fill(depositKey)
  await page.getByRole('button', { name: 'Read deposit' }).click()
  await expect(page.getByText(/Reported lower-LTV wait:/)).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Days until lower LTV might be needed' })
    .fill('100000000')
  await expect(page.getByText(/Reported lower-LTV wait:/)).toBeVisible()
  await expect(page.getByText(/illustrative request-by/)).toHaveCount(0)
})

test('curator horizon rescales the same measured spread on mobile', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))
  await page.route('**/api/carry/live-routes', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usdePilot: null,
        destinationVaultTvl: null,
        matchedCapital: null,
        prospectiveOverlap: null,
        holderStock: null,
        exactAaveSpread: {
          borrowApy: 0.04,
          yieldApy: 0.05,
          spread: 0.01,
          observedAt: new Date().toISOString(),
          ageSeconds: 0,
          stale: false,
        },
      }),
    }),
  )
  await page.goto('/ethereum/carry', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await expect(page.getByText('Stress the carry before it moves')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('+8.22 GHO over your 30-day horizon')).toBeVisible()
  await page.getByRole('textbox', { name: 'Planning horizon (days)' }).fill('365')
  await expect(page.getByText('+100 GHO over your 365-day horizon')).toBeVisible()
  await expect(page.getByText('−100 GHO over your 365-day horizon', { exact: false })).toBeVisible()
  await expect(page.getByText(/not realized profit or a forecast/)).toBeVisible()
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1)
})
