import { expect, test, type Page } from '@playwright/test'

const historyFixture = {
  address: '0x7AdA162d6BFF628db66189fc940179f1D824d142',
  since: { firstEventTs: 1_760_000_000 },
  episodes: [
    {
      startTs: 1_760_000_000,
      endTs: 1_760_000_000,
      protocol: 'Aave V3',
      collateral: 'WETH',
      events: [
        {
          ts: 1_760_000_000,
          protocol: 'Aave V3',
          collateral: 'WETH',
          actualSeizedUsd: 1_000,
          debtRepaidUsd: 800,
        },
      ],
      actualSeizedUsd: 1_000,
      membraneSeizedUsd: 0,
      membraneLiquidations: 0,
      verdict: 'saved',
      membraneShare: 0,
      why: 'price returned inside the window',
    },
    {
      startTs: 1_761_000_000,
      endTs: 1_761_000_000,
      protocol: 'Aave V3',
      collateral: 'WETH',
      events: [
        {
          ts: 1_761_000_000,
          protocol: 'Aave V3',
          collateral: 'WETH',
          actualSeizedUsd: 500,
          debtRepaidUsd: 400,
        },
      ],
      actualSeizedUsd: 500,
      membraneSeizedUsd: 200,
      membraneLiquidations: 1,
      verdict: 'partial',
      membraneShare: 0.4,
      why: 'one partial liquidation remained',
    },
  ],
  events: [],
  totals: {
    savedUsd: 1_000,
    savedCount: 1,
    partialKeptUsd: 300,
    partialCount: 1,
    brokeCount: 0,
    worseCount: 0,
    unknownCount: 0,
    membraneLiquidationsTotal: 1,
  },
  method: 'Deterministic browser fixture.',
  provenance: 'observed',
  scannedAt: '2026-09-23T00:00:00.000Z',
}

async function stubLandingEvidence(page: Page) {
  await page.route('**/api/sim/history/**', (route) => route.fulfill({ json: historyFixture }))
  await page.route('**/api/strats', (route) =>
    route.fulfill({ json: { count: 49, total_usd: 1_600_000_000 } }),
  )
  await page.route('**/api/venues/log', (route) => route.fulfill({ json: { entries: [] } }))
}

test.describe('landing conversion acceptance', () => {
  test('keeps the completed corpus claim honest and the primary action usable', async ({
    page,
  }) => {
    await stubLandingEvidence(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    await expect(page.getByRole('status', { name: 'Loading The Membrane' })).toHaveCount(0)

    await expect(page.getByTestId('sim-scale-line')).toContainText(
      'It would have kept $1.2B of collateral over 3.6 years of Aave V3.',
    )
    await expect(page.getByTestId('sim-scale-subline')).toHaveText(
      '$67M less debt would have been closed on 10 Oct 2025 alone.',
    )
    await expect(page.getByTestId('sim-oct10-comparison')).toBeVisible()

    const input = page.getByLabel('Ethereum address to read a lending position from').first()
    await input.fill('not-an-address')
    await input.press('Enter')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#sim-address-input-error')).toBeVisible()
  })

  test('fits a 375px viewport and labels every mobile history value', async ({ page }) => {
    await stubLandingEvidence(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    await expect(page.getByRole('status', { name: 'Loading The Membrane' })).toHaveCount(0)
    await expect(page.getByTestId('sim-scale-line')).toBeVisible()

    const history = page.getByTestId('sim-history')
    await expect(history.getByTestId('sim-history-headline')).toHaveText('$1,300')
    await expect(history.locator('..').getByText('4%.', { exact: true })).toHaveCount(0)
    const toggle = history.getByTestId('sim-history-details-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const collapsedWidths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    expect(collapsedWidths.document).toBeLessThanOrEqual(collapsedWidths.viewport + 1)
    expect(collapsedWidths.body).toBeLessThanOrEqual(collapsedWidths.viewport + 1)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const label of [
      'date',
      'venue',
      'collateral sold',
      'membrane would sell',
      'you keep',
      'verdict',
    ]) {
      await expect(history.getByText(label, { exact: true }).last()).toBeVisible()
    }

    const expandedWidths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    expect(expandedWidths.document).toBeLessThanOrEqual(expandedWidths.viewport + 1)
    expect(expandedWidths.body).toBeLessThanOrEqual(expandedWidths.viewport + 1)
  })
})
