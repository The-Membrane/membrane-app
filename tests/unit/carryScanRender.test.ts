// Server-renders the carry scout from the committed snapshot and checks what a reader sees:
// one page heading, a label class on every number, and no CTA on an Unverified row.
// (A .ts file: vitest only collects tests/unit/**/*.test.ts, so no JSX here.)

import { readFileSync } from 'fs'
import { join } from 'path'
import { ChakraProvider } from '@chakra-ui/react'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CarryScout } from '@/components/CarryScout/CarryScout'
import { ScoutRowView } from '@/components/CarryScout/ScoutRow'
import { upgradeFile, type CarryScanView } from '@/lib/carryScan/load'
import type { CarryScanFile, ScoutRow } from '@/lib/carryScan/types'
import { averagedVenueApy } from '@/lib/carryScan/venueApy'

const fallbackRaw = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
// The snapshot may predate schema 2: the app reads it through the loader's upgrade, so do the tests.
const fallback = upgradeFile(fallbackRaw)
const view: CarryScanView = {
  file: fallback,
  source: 'fallback',
  status: null,
  stale: false,
  banner: null,
}
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ChakraProvider, null, el))
const PRE_LAUNCH = { launched: false, factoriesConfigured: false }
const rowHtml = (row: ScoutRow) =>
  html(
    createElement(ScoutRowView, {
      row,
      sizeKey: '100k',
      share: {},
      launch: PRE_LAUNCH,
      rank: row.rank,
    }),
  )
const count = (s: string, needle: string) => s.split(needle).length - 1
/** The emotion rule that lifts a row or card above its siblings while its panel is open. */
const RAISED_WHEN_OPEN =
  /:has\(\[data-apy-open=(?:"|&quot;)true(?:"|&quot;)\]\)\{[^}]*z-index:\s*\d/
/** A row's markup outside the sources panel, and the panel itself (one per row). */
const splitPanel = (s: string): { outside: string; panel: string } => {
  const start = s.indexOf('data-testid="apy-sources"')
  if (start < 0) return { outside: s, panel: '' }
  const open = s.lastIndexOf('<div', start)
  // Walk to the panel's closing </div>, counting nested divs.
  let depth = 0
  let i = open
  const re = /<div\b|<\/div>/g
  re.lastIndex = open
  for (let m = re.exec(s); m; m = re.exec(s)) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) {
      i = m.index + m[0].length
      break
    }
  }
  return { outside: s.slice(0, open) + s.slice(i), panel: s.slice(open, i) }
}

describe('the carry scout page, rendered', () => {
  const page = html(createElement(CarryScout, { view }))

  it('has exactly one h1: the page title', () => {
    expect(count(page, '<h1')).toBe(1)
    expect(page).toMatch(/<h1[^>]*>Stable venues that beat their own borrow rate<\/h1>/)
  })

  it('every number on a ranked row carries its label class', () => {
    // TVL, venue net, benchmark, (a), (a) base-only, (b) base, (b) with rewards, stability —
    // plus one per source inside the venue-APY popover.
    const rows = page.split('data-testid="scout-row"').slice(1)
    const ranked = fallback.rows.filter((r) => r.list === 'ranked')
    expect(rows.length).toBe(ranked.length)
    rows.forEach((r, i) => {
      const { outside, panel } = splitPanel(r)
      expect(count(outside, 'data-label-class=')).toBe(8)
      expect(count(panel, 'data-label-class=')).toBe(ranked[i].venueApy.sources.length)
    })
  })

  // Owner ruling 1 (2026-10-11): the venue APY shows its sources on hover AND on tap/focus.
  it('the venue APY is a button that opens a sources panel: every source, its basis, value and as-of', () => {
    for (const row of fallback.rows.filter((r) => r.list === 'ranked')) {
      const out = rowHtml(row)
      expect(count(out, 'data-testid="apy-sources-trigger"')).toBe(1)
      // A real <button> (tap and Enter/Space are clicks), wired to the panel it controls.
      const trigger = out.match(/<button[^>]*data-testid="apy-sources-trigger"[^>]*>/)![0]
      expect(trigger).toContain('type="button"')
      expect(trigger).toContain('aria-haspopup="dialog"')
      expect(trigger).toContain('aria-expanded="false"')
      const controls = trigger.match(/aria-controls="([^"]+)"/)![1]
      const panelTag = out.match(/<div[^>]*data-testid="apy-sources"[^>]*>/)![0]
      expect(panelTag).toContain(`id="${controls}"`)
      expect(panelTag).toContain('role="dialog"')
      expect(panelTag).toMatch(/\shidden=""/)
      const { panel } = splitPanel(out)
      for (const src of row.venueApy.sources) {
        expect(panel).toContain(src.label)
        expect(panel).toContain(` · ${src.basis} · `)
      }
      expect(count(panel, 'data-averaged="true"')).toBe(
        row.venueApy.sources.filter((x) => x.averaged).length,
      )
      expect(panel).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
      expect(panel).toContain('never counted as 0')
    }
  })

  it('the panel counts sources as the cell does: “avg of 3” is “3 sources averaged”', () => {
    // 2026-10-11 refuter: the cell said "avg of 3" while the panel said "5 figures averaged".
    const averaged = fallback.rows.filter((r) => r.venueApy.method === 'average')
    expect(averaged.length).toBeGreaterThan(0)
    for (const row of averaged) {
      const { outside, panel } = splitPanel(rowHtml(row))
      const n = Number(outside.match(/avg of (\d+)/)![1])
      expect(panel, row.label).toContain(`${n} source${n === 1 ? '' : 's'} averaged`)
      expect(panel, row.label).not.toMatch(/\d+ figures? averaged/)
    }
  })

  it('an averaged vault row says “avg of N”, lists its spread, and a class route is shown, not hidden', () => {
    const base = fallback.rows.find((r) => r.list === 'ranked')!
    const row: ScoutRow = {
      ...base,
      kind: 'metamorpho',
      flags: [...base.flags, 'source-disagreement'],
      alsoBehindRoutes: ['USDC → Morpho Vault V2'],
      venueApy: averagedVenueApy({
        pool: {
          pool: 'pool-x',
          chain: 'Ethereum',
          project: 'morpho-blue',
          symbol: 'XUSDC',
          tvlUsd: 50e6,
          apy: 7.6,
          apyBase: 4.9,
          apyReward: 2.7,
          apyMean30d: 6,
          stablecoin: true,
          exposure: 'single',
          ilRisk: 'no',
          poolMeta: null,
          count: 200,
          outlier: false,
          underlyingTokens: null,
        },
        fetchedAt: 1_786_000_000,
        morpho: {
          address: '0x' + 'aa'.repeat(20),
          symbol: 'XUSDC',
          name: 'X',
          assetAddress: '0x' + 'bb'.repeat(20),
          version: 'v1',
          netApy: 0.0767,
          netApyExcludingRewards: 0.0488,
          fee: 0.05,
          totalAssetsUsd: 50e6,
        },
        onchain: { value: 0.0345, asOf: 1_786_000_000, address: '0x' + 'aa'.repeat(20) },
      }),
    }
    const out = rowHtml(row)
    expect(out).toContain('avg of 3')
    expect(out).toContain('also behind /carry route USDC → Morpho Vault V2')
    expect(out).toMatch(/source disagreement · 1\.\d\dpp/)
    const { panel } = splitPanel(out)
    expect(panel).toContain('Morpho API net APY, no rewards')
    expect(panel).toContain('On-chain 7-day share-price growth')
    expect(panel).toContain('sources spread base 1.45pp')
  })

  it('an Unverified row has no CTA; a ranked row has one, disabled before launch', () => {
    const unverified = fallback.rows.filter((r) => r.list === 'unverified')
    expect(unverified.length).toBeGreaterThan(0)
    for (const r of unverified) expect(rowHtml(r)).not.toContain('data-testid="scout-cta"')
    const ranked = rowHtml(fallback.rows.find((r) => r.list === 'ranked')!)
    expect(count(ranked, 'data-testid="scout-cta"')).toBe(1)
    expect(ranked).toMatch(
      /<button[^>]*disabled[^>]*data-testid="scout-cta"|data-testid="scout-cta"[^>]*disabled/,
    )
  })

  // Owner Q3 greys non-USDC rows out. Opacity 0.62 dropped their text below WCAG AA:
  // textSecondary 5.58:1 → 2.77:1 (dark theme), textTertiary 3.14:1 → 1.87:1. A grayscale
  // filter greys the row and keeps each colour's luminance (textSecondary stays 5.54:1).
  it('greys a not-deployable row with grayscale, never by dimming its text', () => {
    const greyed = fallback.rows.find((r) => r.readiness.tier === 'not-deployable')
    expect(greyed).toBeTruthy()
    const out = rowHtml(greyed!)
    expect(out).toContain('grayscale(1)')
    expect(out).not.toMatch(/opacity:\s*0?\.\d/)
    // The filter makes the row a stacking context, so a later greyed row painted over this
    // row's open sources panel whatever its z-index. A row with an open panel rises.
    expect(out).toMatch(RAISED_WHEN_OPEN)
    const usdc = rowHtml(fallback.rows.find((r) => r.readiness.tier !== 'not-deployable')!)
    expect(usdc).not.toContain('grayscale(')
    const strip = readFileSync(
      join(__dirname, '..', '..', 'components', 'CarryScout', 'ScoutStrip.tsx'),
      'utf8',
    )
    expect(strip).not.toMatch(/opacity=/)
    expect(strip).toContain('NOT_DEPLOYABLE_FILTER')
  })
})
