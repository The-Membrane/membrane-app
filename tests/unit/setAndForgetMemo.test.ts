/**
 * docs/research/SET-AND-FORGET-LTV.md and the exit-capacity copy trace to the data (review
 * 2026-10-07): a statement the published JSON or the generated analog rows contradict fails
 * here instead of reaching a reader.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { EXIT_CAPACITY_BOOK_ROWS } from '@/lib/position-sim/exitCapacityAnalogs'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const MEMO = read('docs/research/SET-AND-FORGET-LTV.md')
const SIM = JSON.parse(read('public/data/price-history/set-and-forget-ltv.json')) as {
  paths: { pathId: string; rows: { horizon: string; n: number }[] }[]
}

const fmt = (n: number) => n.toLocaleString('en-US')

describe('SET-AND-FORGET-LTV.md traces to its data', () => {
  it("states each asset's own start-hour counts (ETH and BTC differ by one hour)", () => {
    for (const asset of ['ETH', 'BTC']) {
      const rows = SIM.paths.find((p) => p.pathId === asset)!.rows
      const n = ['30d', '90d', '365d'].map((h) => {
        const ns = [...new Set(rows.filter((r) => r.horizon === h).map((r) => r.n))]
        expect(ns, `${asset} ${h}`).toHaveLength(1)
        return ns[0]
      })
      expect(MEMO).toContain(`${asset} ${n.map(fmt).join(' / ')} `)
    }
  })

  it('names the ranking tie-break for levels that cover the book whole, not "the earliest"', () => {
    const at = (id: string) => EXIT_CAPACITY_BOOK_ROWS.find((r) => r.id === id)!
    const typical = at('aave-usdc-10m-typical')
    const bad = at('aave-usdc-10m-bad')
    // Both cover the $10M book whole, and the level named at the median is the LATER event:
    // the named event at an m = 1 rank is not the earliest of the events that tie there.
    expect([typical.mult, bad.mult]).toEqual([1, 1])
    expect(bad.rank).toBeLessThan(typical.rank)
    expect(bad.onset < typical.onset).toBe(true)
    expect(MEMO).not.toMatch(/is the earliest of them/)
    // venueStressAnalogs.compareWorstFirstBook: m8 ↑, m-lock ↓, m-locked hours ↓, m72 ↑, onset ↑.
    expect(MEMO).toContain(
      'Tied events are ordered worst first by the longer ≤ 1% lock inside the window, then more hours under 1% of the book in 72 h, then the lower 72 h minimum, then the earlier onset.',
    )
    expect(MEMO).toContain(`(rank ${typical.rank}) is the ${typical.onset.slice(0, 10)} event`)
    expect(MEMO).toContain(`(rank ${bad.rank}) the earlier ${bad.onset.slice(0, 10)} one`)
  })

  it('lists exactly the levels whose book exceeds the venue', () => {
    const flagged = EXIT_CAPACITY_BOOK_ROWS.filter((r) => r.bookExceedsVenue)
    expect(MEMO).toContain(
      `That is ${flagged.length} of the ${EXIT_CAPACITY_BOOK_ROWS.length} cash-vs-book levels`,
    )
    expect(new Set(flagged.map((r) => r.book))).toEqual(new Set(['250m']))
  })
})

describe('the floor is never called the worst case without its condition', () => {
  // Review 2026-10-07: "everyone exits is the worst case" was false for 9 $250M levels whose
  // book exceeds the venue's whole supply. The claim holds on the same event for any book the
  // venue could hold, and must say so wherever it is made.
  const FILES = [
    'docs/research/SET-AND-FORGET-LTV.md',
    'components/RiskFrontier/FinePrint.tsx',
    'components/RiskFrontier/Loadout.tsx',
    'components/RiskFrontier/viewModel.ts',
    'lib/position-sim/venueStressAnalogs.ts',
    'lib/position-sim/stressGrid.ts',
    'lib/position-sim/exitCapacityAnalogs.ts',
    'scripts/position-sim/set-and-forget-sim.ts',
  ]
  it.each(FILES)('%s', (rel) => {
    const lines = read(rel).split('\n')
    lines.forEach((line, i) => {
      if (!/worst case/i.test(line)) return
      expect(`${line} ${lines[i + 1] ?? ''}`, `${rel}:${i + 1}`).toMatch(/could hold/)
    })
  })
})
