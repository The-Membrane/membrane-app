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
    route.fulfill({
      json: {
        count: 3,
        total_usd: 500,
        freshest_scan: '2026-09-23T00:00:00.000Z',
        strats: [
          {
            address: '0x1111111111111111111111111111111111111111',
            short_address: '0x1111…1111',
            label: 'Yield desk',
            watched_since: '2026-09-01T00:00:00.000Z',
            entry_total_usd: 280,
            current_total_usd: 300,
            delta_usd: 20,
            delta_dir: 'up',
            held: [
              { venue: 'susds', label: 'sUSDS', usd: 200, verdict: 'clear' },
              { venue: 'scrvusd', label: 'scrvUSD', usd: 100, verdict: 'caution' },
            ],
            verdict: 'caution',
            weakest_venue: 'scrvUSD',
            last_scanned_at: '2026-09-23T00:00:00.000Z',
            return_metrics: {
              status: 'complete',
              pnl_usd: 10,
              return_pct: 3.33,
              start_at: '2026-09-01T00:00:00.000Z',
              end_at: '2026-09-23T00:00:00.000Z',
              flow_count: 1,
              unpriced_count: 0,
              note: 'Tracked venues only; excludes borrowing costs.',
            },
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            short_address: '0x2222…2222',
            label: 'Quiet desk',
            watched_since: '2026-09-01T00:00:00.000Z',
            entry_total_usd: 145,
            current_total_usd: 150,
            delta_usd: 5,
            delta_dir: 'up',
            held: [{ venue: 'susds', label: 'sUSDS', usd: 150, verdict: 'clear' }],
            verdict: 'clear',
            weakest_venue: 'sUSDS',
            last_scanned_at: '2026-09-23T00:00:00.000Z',
          },
          {
            address: '0x3333333333333333333333333333333333333333',
            short_address: '0x3333…3333',
            label: 'Thin desk',
            watched_since: '2026-09-01T00:00:00.000Z',
            entry_total_usd: 100,
            current_total_usd: 50,
            delta_usd: -50,
            delta_dir: 'down',
            held: [{ venue: 'aave', label: 'Aave', usd: 50, verdict: 'exposed' }],
            verdict: 'exposed',
            weakest_venue: 'Aave',
            last_scanned_at: '2026-09-23T00:00:00.000Z',
          },
        ],
        provenance: {
          recorded: { window: '24h', note: 'fixture', flow_rows: 1, snapshot_rows: 1 },
          modelled: null,
        },
      },
    }),
  )
  await page.route('**/api/venues/log', (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            venue: 'scrvUSD',
            kind: 'param_changed',
            at: '2026-09-21T21:25:02.474Z',
            since: '2026-09-21T05:15:22.074Z',
            prev: { depth_usd: 24_589_947.676515 },
            next: { depth_usd: 30_505_294.031558 },
            provenance: 'observed',
          },
        ],
      },
    }),
  )
}

test.describe('landing conversion acceptance', () => {
  test('keeps strategy verdict controls and the table usable on a narrow screen', async ({
    page,
  }) => {
    await stubLandingEvidence(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    await page.getByRole('button', { name: /^Inspect the tracked books/ }).click()
    const strats = page.getByTestId('sim-inline-strats')
    await strats.getByRole('button', { name: 'Filter tracked strategies by verdict' }).click()
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
    await page.getByRole('menuitemradio', { name: /Exposed/ }).click()
    await expect(strats.getByTestId('strats-flow')).toHaveAttribute('data-risk-verdict', 'exposed')
    const table = strats.getByRole('region', { name: 'Tracked strategies table' })
    await expect(table).toBeVisible()
    expect(await table.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(440)
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1)
  })

  test('keeps carry routes distinct from strategy holdings and explains modeled waiting haircuts', async ({
    page,
  }) => {
    await stubLandingEvidence(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    await page.getByRole('button', { name: /^Open the carry board/ }).click()
    await expect(page.getByTestId('sim-inline-board')).toContainText(
      'Measured routes on other protocols',
    )
    await expect(page.getByTestId('sim-inline-board')).not.toContainText(
      'What the market is running',
    )
    await expect(page.getByTestId('sim-inline-board')).not.toContainText('Boards — top survivors')
    await expect(page.getByTestId('sim-inline-board')).toContainText(
      'not a count of positions still open today',
    )
    const routeExample = page.getByTestId('route-magnitude').first()
    await expect(routeExample).toContainText('+$1,153 / yr')
    await routeExample.click()
    await expect(routeExample).toContainText('15 observed')
    const underline = await page
      .getByRole('link', { name: 'full carry page →' })
      .evaluate((link) => {
        const style = getComputedStyle(link)
        return { thickness: style.textDecorationThickness, offset: style.textUnderlineOffset }
      })
    expect(underline.thickness).toBe('1px')
    expect(underline.offset).not.toBe('auto')

    await page.getByRole('button', { name: /^Inspect the tracked books/ }).click()
    const strats = page.getByTestId('sim-inline-strats')
    await expect(strats.getByTestId('strats-flow')).toContainText('Where tracked capital sits')
    await expect(strats.getByTestId('strats-flow')).toContainText('not transfers between them')
    await expect(strats.getByText('Entered → now')).toHaveCount(0)
    await expect(strats.getByText('Tracked return', { exact: true })).toBeVisible()
    await expect(strats.getByText('+$10', { exact: true })).toBeVisible()
    const table = strats.getByRole('region', { name: 'Tracked strategies table' })
    await expect(table).toBeVisible()
    expect(await table.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')

    const verdictFilter = strats.getByRole('button', {
      name: 'Filter tracked strategies by verdict',
    })
    await verdictFilter.click()
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
    await page.getByRole('menuitemradio', { name: /Caution/ }).click()
    await expect(page.getByRole('menu')).not.toBeVisible()
    await expect(strats.getByText('1 of 3 books')).toBeVisible()
    const cautionFlow = strats.getByTestId('strats-flow')
    await expect(cautionFlow).toHaveAttribute('data-risk-verdict', 'caution')
    const cautionColor = await cautionFlow
      .getByTestId('strats-flow-bar')
      .first()
      .evaluate((bar) => getComputedStyle(bar).backgroundColor)
    const riskColors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return {
        caution: root.getPropertyValue('--m-risk-caution').trim(),
        claim: root.getPropertyValue('--m-warning').trim(),
        danger: root.getPropertyValue('--m-danger').trim(),
      }
    })
    expect(riskColors.caution).not.toBe(riskColors.claim)
    expect(cautionColor).toBe(
      await page.evaluate((hex) => {
        const probe = document.createElement('span')
        probe.style.color = hex
        document.body.appendChild(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }, riskColors.caution),
    )
    await expect(verdictFilter).not.toHaveCSS('border-color', cautionColor)
    await verdictFilter.hover()
    expect(await verdictFilter.evaluate((button) => getComputedStyle(button).boxShadow)).not.toBe(
      'none',
    )

    await verdictFilter.click()
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
    await page.getByRole('menuitemradio', { name: /Exposed/ }).click()
    await expect(page.getByRole('menu')).not.toBeVisible()
    await expect(strats.getByTestId('strats-flow')).toHaveAttribute('data-risk-verdict', 'exposed')
    await expect(strats.getByText('1 of 3 books')).toBeVisible()
    await verdictFilter.click()
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
    await page.getByRole('menuitemradio', { name: /All verdicts/ }).click()
    await expect(page.getByRole('menu')).not.toBeVisible()
    await expect(strats.getByTestId('strats-flow')).toHaveAttribute('data-risk-verdict', 'all')
    await strats
      .getByTestId('strats-flow')
      .getByRole('button', { name: /scrvUSD.*100/ })
      .click()
    await expect(strats.getByText('1 of 3 books')).toBeVisible()
    await strats.getByLabel('Filter tracked strategies by address or label').fill('not here')
    await expect(strats.getByText('No tracked books match these filters.')).toBeVisible()

    await strats.getByRole('button', { name: 'How risk verdicts are assigned' }).click()
    const help = page.getByRole('dialog')
    await expect(help).toContainText('Coverage is below 1× or a cooldown exceeds 24 hours.')
    await expect(help).toContainText('no applicable evidence was recorded')
    await expect(help).toHaveCSS('opacity', '1')
    await help.getByRole('button', { name: 'Close verdict explanation' }).click()
    await expect(help).not.toBeVisible()

    await page.getByRole('button', { name: 'How the yield is discounted' }).click()
    const model = page.getByRole('dialog')
    await expect(model).toContainText('0.2–0.6% haircut')
    await expect(model).toContainText('0.8–2% haircut')
    await expect(model).toContainText('The wait length is not measured here.')
  })

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
      '$67M of debt protected from forced closure on 10 Oct 2025 alone.',
    )
    await expect(page.getByTestId('sim-oct10-comparison')).toBeVisible()
    await expect(page.getByText('scrvUSD exit capacity rose $5.92M')).toBeVisible()
    await expect(page.getByText('$24.59M → $30.51M over 16h', { exact: false })).toBeVisible()
    await expect(page.getByText('what you are assuming', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save share card' })).toHaveCount(0)
    await expect(page.getByTestId('sim-fineprint')).not.toHaveAttribute('open')
    await page.getByTestId('sim-fineprint').locator('summary').click()
    await expect(page.getByTestId('sim-fineprint')).toHaveAttribute('open')
    await expect(page.getByTestId('sim-fineprint')).toContainText(
      'URL parameters can override these inputs',
    )

    const doors = await page
      .getByRole('button', { name: /^Open the carry board|^Inspect the tracked books/ })
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(parseFloat(getComputedStyle(button).paddingLeft))),
      )
    expect(doors).toHaveLength(2)
    expect(doors[0]).toBe(doors[1])

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
