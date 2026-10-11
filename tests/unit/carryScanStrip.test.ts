// Server-renders the "New this week" strip on /carry from the committed snapshot, the way the
// page sees it after /api/carry-scan?view=strip answers: a label class on both carry figures,
// the greyed non-USDC row, the stale/failed banner, and no zero or "free" Membrane charge.
// (A .ts file: vitest only collects tests/unit/**/*.test.ts, so no JSX here.)

import { readFileSync } from 'fs'
import { join } from 'path'
import { ChakraProvider } from '@chakra-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ScoutStrip } from '@/components/CarryScout/ScoutStrip'
import { ZERO_OR_FREE } from '@/lib/carryScan/format'
import { upgradeFile, type CarryScanView } from '@/lib/carryScan/load'
import { stripOf, type StripPayload } from '@/lib/carryScan/strip'
import type { CarryScanFile } from '@/lib/carryScan/types'

// useChainRoute reads next/router, which has no router outside a Next request.
vi.mock('@/hooks/useChainRoute', () => ({
  useChainRoute: () => ({ chainName: 'ethereum', walletChainName: 'ethereum', isValidChain: true }),
}))

const fallbackRaw = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
// The snapshot may predate schema 2: the app reads it through the loader's upgrade, so do the tests.
const fallback = upgradeFile(fallbackRaw)

const render = (payload: StripPayload) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['carry_scan_strip'], payload)
  return renderToStaticMarkup(
    createElement(
      ChakraProvider,
      null,
      createElement(QueryClientProvider, { client: qc }, createElement(ScoutStrip)),
    ),
  )
}
const count = (s: string, needle: string) => s.split(needle).length - 1
const text = (html: string) => html.replace(/<[^>]+>/g, ' ')

describe('the /carry strip, rendered', () => {
  const view: CarryScanView = {
    file: fallback,
    source: 'fallback',
    status: null,
    stale: false,
    banner: null,
  }
  const payload = stripOf(view)

  it('shows the top NEW rows, each carry figure with its label class', () => {
    expect(payload.rows.length).toBeGreaterThan(0)
    const html = render(payload)
    for (const r of payload.rows) expect(html).toContain(r.label)
    // The venue APY, (a) and (b) base on every row that has an (a); venue and (b) otherwise —
    // plus one per source inside each venue-APY popover.
    const tags = payload.rows.reduce((n, r) => n + (r.carryA ? 3 : 2), 0)
    const sources = payload.rows.reduce((n, r) => n + r.venueApy.sources.length, 0)
    expect(count(html, 'data-label-class=')).toBe(tags + sources)
    expect(html).toContain('href="/ethereum/carry-scout"')
    expect(html).toContain(' · snapshot')
  })

  // Owner ruling 1 (2026-10-11): the strip's venue APY opens its sources on hover AND tap/focus.
  it('the venue APY at $100K opens its sources from a button, not a hover-only title', () => {
    const html = render(payload)
    expect(count(html, 'data-testid="apy-sources-trigger"')).toBe(payload.rows.length)
    expect(count(html, 'data-testid="apy-sources"')).toBe(payload.rows.length)
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*data-testid="apy-sources-trigger"/)
    for (const r of payload.rows)
      for (const src of r.venueApy.sources) expect(html).toContain(src.label)
    // A strip payload cached before schema 2 has no venueApy: the row still renders.
    const old = { ...payload, rows: payload.rows.map(({ venueApy: _v, venueNet: _n, ...r }) => r) }
    const legacy = render(old as unknown as StripPayload)
    expect(legacy).not.toContain('apy-sources')
    for (const r of payload.rows) expect(legacy).toContain(r.label)
  })

  it('greys a non-USDC row with grayscale and says why', () => {
    const usdc = payload.rows.find((r) => !r.notDeployable)!
    const other = { ...usdc, label: 'Some PYUSD vault', stable: 'PYUSD', notDeployable: true }
    const greyed = render({ ...payload, rows: [other] })
    expect(greyed).toContain('grayscale(1)')
    expect(greyed).not.toMatch(/opacity:\s*0?\.\d/)
    // A greyed card is a stacking context: it rises while its sources panel is open, or the
    // next greyed card paints over the panel.
    expect(greyed).toMatch(
      /:has\(\[data-apy-open=(?:"|&quot;)true(?:"|&quot;)\]\)\{[^}]*z-index:\s*\d/,
    )
    expect(greyed).toContain('not deployable yet (vaults hold USDC)')
    const plain = render({ ...payload, rows: [usdc] })
    expect(plain).not.toContain('grayscale(')
    expect(plain).not.toContain('not deployable yet')
  })

  it('repeats the page banner (a failed or stale scan)', () => {
    const banner = 'Last scan failed 2026-10-19: gate 1: source failed; showing 2026-W41'
    expect(render({ ...payload, banner })).toContain(banner)
  })

  it('never states a zero or "free" Membrane charge, and never promises carry', () => {
    const t = text(render(payload))
    expect(t).not.toMatch(ZERO_OR_FREE)
    expect(t).toContain('not a promise')
    expect(t).not.toMatch(/guarantee/i)
  })
})
