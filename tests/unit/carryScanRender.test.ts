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
import type { CarryScanView } from '@/lib/carryScan/load'
import type { CarryScanFile, ScoutRow } from '@/lib/carryScan/types'

const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
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

describe('the carry scout page, rendered', () => {
  const page = html(createElement(CarryScout, { view }))

  it('has exactly one h1: the page title', () => {
    expect(count(page, '<h1')).toBe(1)
    expect(page).toMatch(/<h1[^>]*>Stable venues that beat their own borrow rate<\/h1>/)
  })

  it('every number on a ranked row carries its label class', () => {
    // TVL, venue net, benchmark, (a), (a) base-only, (b) base, (b) with rewards, stability.
    const rows = page.split('data-testid="scout-row"').slice(1)
    expect(rows.length).toBe(fallback.rows.filter((r) => r.list === 'ranked').length)
    for (const r of rows) expect(count(r, 'data-label-class=')).toBe(8)
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
