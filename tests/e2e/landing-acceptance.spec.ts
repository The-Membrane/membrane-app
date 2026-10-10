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
    const strats = page.getByTestId('sim-inline-strats')
    await expect(strats).toBeVisible()
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

  test('puts percentage routes before the unified strategy rack with transient row feedback', async ({
    page,
  }) => {
    await stubLandingEvidence(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
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
    await expect(page.getByTestId('sim-inline-board')).toContainText('sGHO')
    await expect(page.getByTestId('sim-inline-board')).toContainText('UmbrellaStakeToken')
    const routeRegion = page.getByRole('region', { name: 'Measured carry routes' })
    await expect(routeRegion).toBeVisible()
    expect(
      await routeRegion.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true)
    const routeExample = page.getByTestId('measured-route-row').first()
    await expect(routeExample).toContainText('+11.53%')
    await expect(routeExample).toContainText('Unpriced')
    await expect(page.getByTestId('sim-inline-board')).toContainText('≈$860k')
    const restingBorder = await routeExample.evaluate((row) => getComputedStyle(row).borderTopColor)
    await routeExample.hover()
    expect(await routeExample.evaluate((row) => getComputedStyle(row).boxShadow)).not.toBe('none')
    await routeExample.click()
    await expect(routeExample).toHaveCSS('border-top-color', restingBorder)
    await expect(routeExample).toContainText('15 observed')
    const underline = await page
      .getByRole('link', { name: 'full carry board →' })
      .evaluate((link) => {
        const style = getComputedStyle(link)
        return { thickness: style.textDecorationThickness, offset: style.textUnderlineOffset }
      })
    expect(underline.thickness).toBe('1px')
    expect(underline.offset).not.toBe('auto')

    const strats = page.getByTestId('sim-inline-strats')
    await expect(strats).toBeVisible()
    await expect(strats.getByTestId('strats-flow')).toContainText('Where tracked capital sits')
    await expect(strats.getByTestId('strats-flow')).toContainText('not transfers between them')
    const capitalRow = strats.getByTestId('strats-venue-row').first()
    const idleCapitalStyle = await capitalRow.evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderColor, shadow: style.boxShadow }
    })
    await capitalRow.hover()
    expect(await capitalRow.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
      idleCapitalStyle.shadow,
    )
    await capitalRow.click()
    await page.mouse.move(0, 0)
    await expect(capitalRow).toHaveCSS('border-color', idleCapitalStyle.border)
    await strats.getByTestId('strats-all-venues').click()
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
    await expect(help).toContainText(
      'Recorded instant inventory is below 1× the position or a recorded cooldown exceeds 24 hours.',
    )
    await expect(help).toContainText('no applicable check is available')
    await expect(help).toContainText('Inventory does not verify this holder can exit.')
    await expect(help).toHaveCSS('opacity', '1')
    await help.getByRole('button', { name: 'Close verdict explanation' }).click()
    await expect(help).not.toBeVisible()

    await expect(page.getByRole('button', { name: 'How the yield is discounted' })).toHaveCount(0)
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
    await expect(page.getByRole('heading', { name: 'What you keep after the exit' })).toHaveCount(0)
    await expect(page.getByText('the run', { exact: true })).toHaveCount(0)
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

    await expect(
      page.getByRole('button', { name: /^Open the carry board|^Inspect the tracked books/ }),
    ).toHaveCount(0)

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

  test('keeps share actions transient and moves history details behind an info control', async ({
    page,
  }) => {
    await stubLandingEvidence(page)
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    await page
      .getByLabel('Ethereum address to read a lending position from')
      .first()
      .fill(historyFixture.address)
    await page.getByRole('button', { name: 'Run mine' }).click()

    const card = page.getByTestId('address-evidence')
    await expect(card).toBeVisible()
    await expect(card).toContainText(
      'Actual collateral seized minus modeled Membrane collateral seized across 2 priced episodes.',
    )
    await expect(card).not.toContainText('First recorded episode')
    await card.getByRole('button', { name: 'About this liquidation history' }).click()
    const details = page.getByRole('dialog')
    await expect(details).toContainText('First recorded episode')
    await expect(details).toContainText('Membrane outcomes are modeled')
    await details.getByRole('button', { name: 'Close history details' }).click()

    const copy = card.getByRole('button', { name: 'Copy result link' })
    const restingBorder = await copy.evaluate((element) => getComputedStyle(element).borderTopColor)
    await copy.hover()
    await expect(copy).not.toHaveCSS('box-shadow', 'none')
    await expect(copy).toHaveCSS('border-top-color', restingBorder)
    await copy.click()
    await expect(copy).toHaveCSS('border-top-color', restingBorder)

    const save = card.getByRole('button', { name: 'Save card image' })
    await save.hover()
    await expect(save).not.toHaveCSS('box-shadow', 'none')
    await expect(save).toHaveCSS('border-top-color', restingBorder)
  })

  test('keeps tracked-capital summary and venue flow inside narrow viewports', async ({ page }) => {
    await stubLandingEvidence(page)
    await page.goto('/ethereum/simulator', { waitUntil: 'load' })
    const strats = page.getByTestId('sim-inline-strats')
    const summary = strats.getByTestId('strats-summary')
    const flow = strats.getByTestId('strats-flow')
    await expect(summary).toContainText('Total tracked')
    await expect(flow).toContainText('Where tracked capital sits')

    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 812 })
      for (const section of [summary, flow]) {
        const geometry = await section.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            viewport: document.documentElement.clientWidth,
          }
        })
        expect(geometry.left).toBeGreaterThanOrEqual(-1)
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1)
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
      }
    }
  })

  test('keeps light landing proof copy legible at mobile and desktop widths', async ({ page }) => {
    await stubLandingEvidence(page)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))

    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/ethereum/simulator', { waitUntil: 'load' })
      await expect(page.locator('html')).toHaveAttribute('data-membrane-theme', 'light')
      await expect(page.getByTestId('sim-scale-line')).toBeVisible()
      await expect(page.getByRole('status', { name: 'Loading The Membrane' })).toHaveCount(0)
      const geometry = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.right > document.documentElement.clientWidth + 1
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            testId: element.getAttribute('data-testid'),
            text: element.textContent?.trim().slice(0, 35),
            right: Math.round(element.getBoundingClientRect().right),
          })),
      }))

      const undersized = await page.evaluate(() => {
        const selectors = [
          '[data-testid="sim-guarantee"]',
          '[data-testid="sim-history"]',
          '[data-testid="sim-carry-section"]',
        ]
        return selectors.flatMap((selector) => {
          const root = document.querySelector(selector)
          if (!root) return []
          return [...root.querySelectorAll('p,span,button,a,label')]
            .filter((element) => {
              const style = getComputedStyle(element)
              return (
                [...element.childNodes].some(
                  (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
                ) &&
                element.getClientRects().length > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                !element.closest('[aria-hidden="true"]') &&
                Number.parseFloat(style.fontSize) < 12
              )
            })
            .slice(0, 12)
            .map((element) => ({
              text: element.textContent?.trim().slice(0, 50),
              size: getComputedStyle(element).fontSize,
            }))
        })
      })
      const lowContrast = await page.evaluate(() => {
        const colorChannels = (value: string) =>
          [...value.matchAll(/[\d.]+/g)].slice(0, 4).map((match) => Number(match[0]))
        const luminance = (rgb: number[]) => {
          const linear = rgb.slice(0, 3).map((channel) => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
        }
        const rootStyle = getComputedStyle(document.documentElement)
        const probe = document.createElement('span')
        document.body.appendChild(probe)
        const neutralColors = new Set(
          ['--m-text-primary', '--m-text-secondary', '--m-text-tertiary'].map((token) => {
            probe.style.color = rootStyle.getPropertyValue(token)
            return getComputedStyle(probe).color
          }),
        )
        probe.remove()
        return [
          '[data-testid="sim-guarantee"]',
          '[data-testid="sim-history"]',
          '[data-testid="sim-carry-section"]',
        ].flatMap((selector) => {
          const root = document.querySelector(selector)
          if (!root) return []
          return [...root.querySelectorAll('p,span,button,a,label')]
            .filter((element) => {
              const style = getComputedStyle(element)
              return (
                [...element.childNodes].some(
                  (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
                ) &&
                element.getClientRects().length > 0 &&
                style.visibility !== 'hidden' &&
                !element.closest('[aria-hidden="true"]') &&
                neutralColors.has(style.color)
              )
            })
            .flatMap((element) => {
              const foreground = colorChannels(getComputedStyle(element).color)
              let background: number[] | null = null
              for (let node: Element | null = element; node; node = node.parentElement) {
                const channels = colorChannels(getComputedStyle(node).backgroundColor)
                if (channels.length === 3 || channels[3] === 1) {
                  background = channels
                  break
                }
              }
              if (!background) return [{ text: 'missing opaque background' }]
              const values = [luminance(foreground), luminance(background)]
              const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
              return ratio < 4.5
                ? [
                    {
                      text: element.textContent?.trim().slice(0, 50),
                      ratio: Number(ratio.toFixed(2)),
                    },
                  ]
                : []
            })
            .slice(0, 12)
        })
      })
      if (process.env.MEMBRANE_E2E_CAPTURE === '1') {
        await page.screenshot({ path: `/private/tmp/membrane-landing-light-${width}.png` })
      }
      expect(geometry.document, JSON.stringify(geometry.offenders)).toBeLessThanOrEqual(
        geometry.viewport + 1,
      )
      expect(undersized, `undersized visible proof copy at ${width}px`).toEqual([])
      expect(lowContrast, `neutral proof text below 4.5:1 at ${width}px`).toEqual([])
    }
  })
})
