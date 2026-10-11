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
import type { CarryScanView } from '@/lib/carryScan/load'
import { stripOf, type StripPayload } from '@/lib/carryScan/strip'
import type { CarryScanFile } from '@/lib/carryScan/types'

// useChainRoute reads next/router, which has no router outside a Next request.
vi.mock('@/hooks/useChainRoute', () => ({
  useChainRoute: () => ({ chainName: 'ethereum', walletChainName: 'ethereum', isValidChain: true }),
}))

const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile

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
    // (a) and (b) base on every row that has an (a); (b) alone otherwise.
    const tags = payload.rows.reduce((n, r) => n + (r.carryA ? 2 : 1), 0)
    expect(count(html, 'data-label-class=')).toBe(tags)
    expect(html).toContain('href="/ethereum/carry-scout"')
    expect(html).toContain(' · snapshot')
  })

  it('greys a non-USDC row with grayscale and says why', () => {
    const usdc = payload.rows.find((r) => !r.notDeployable)!
    const other = { ...usdc, label: 'Some PYUSD vault', stable: 'PYUSD', notDeployable: true }
    const greyed = render({ ...payload, rows: [other] })
    expect(greyed).toContain('grayscale(1)')
    expect(greyed).not.toMatch(/opacity:\s*0?\.\d/)
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
