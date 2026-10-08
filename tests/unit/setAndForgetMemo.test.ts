/**
 * docs/research/SET-AND-FORGET-LTV.md and the exit-capacity copy trace to the data (review
 * 2026-10-07): a statement the published JSON or the generated analog rows contradict fails
 * here instead of reaching a reader.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EXIT_CAPACITY_ANALOG_ROWS,
  EXIT_CAPACITY_BOOKS,
  EXIT_CAPACITY_BOOK_ROWS,
} from '@/lib/position-sim/exitCapacityAnalogs'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const MEMO = read('docs/research/SET-AND-FORGET-LTV.md')
const SIM = JSON.parse(read('public/data/price-history/set-and-forget-ltv.json')) as {
  paths: { pathId: string; rows: { horizon: string; n: number }[] }[]
  mechanics: {
    exitCapacity: {
      analogs: {
        id: string
        model: string
        venue: string
        level: string
        mult: number
        cashUsd8h: number
        event: string
        fWindow?: number
        bookExceedsVenue?: boolean
      }[]
    }
  }
  claims: Record<
    string,
    {
      horizon: string
      rows: { caseId: string; debtUsd: number; recallDrawnShareOfDebt: { median: number } | null }[]
    }
  >
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

// ------------------------------------------------- claims refuter round 3 (2026-10-07)

/** Prose sentences of the memo (tables carry the book in their own column, so they are skipped). */
function memoSentences(): string[] {
  return MEMO.split('\n')
    .filter((l) => !l.trimStart().startsWith('|') && !l.startsWith('#'))
    .flatMap((l) => l.split(/(?<=[.;])\s+(?=[A-Z*(`"[$×])/))
    .filter((x) => x.trim().length > 0)
}

const ANALOG = (id: string) => SIM.mechanics.exitCapacity.analogs.find((a) => a.id === id)!
const usdM = (x: number) => `$${(x / 1e6).toFixed(1)}M`
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`

describe('every capacity claim in the memo names its book and model (round 3, A)', () => {
  // memo:5 promises that every claim names its book. A result stated by a bare multiple
  // (×1, ×0.9032, ×0.8125, ×0.1806) or by "where the book was covered" did not.
  const BOOK_LABEL = Object.fromEntries(EXIT_CAPACITY_BOOKS.map((b) => [b.id, b.label]))
  /** Each measured multiple → the names that identify a level at it (any venue). */
  const NAMES = new Map<number, Set<string>>()
  const add = (m: number, name: string) =>
    NAMES.set(m, (NAMES.get(m) ?? new Set<string>()).add(name))
  for (const r of EXIT_CAPACITY_ANALOG_ROWS) {
    add(r.mult, r.model === 'cash-vs-book' ? BOOK_LABEL[r.book] : 'floor')
  }
  add(1, 'upper bound')
  add(1, 'optimistic')
  add(0, 'frozen')
  add(0, 'lower bound')

  it('names a book or the floor wherever a measured multiple is quoted', () => {
    const misses: string[] = []
    for (const sentence of memoSentences()) {
      for (const m of sentence.matchAll(/×(\d+(?:\.\d+)?)(?![\d.])/g)) {
        const names = NAMES.get(Number(m[1]))
        if (!names) continue // an edge ratio (×1.029), not a capacity level
        if (![...names].some((n) => sentence.toLowerCase().includes(n.toLowerCase()))) {
          misses.push(`×${m[1]}: ${sentence.slice(0, 160)}`)
        }
      }
    }
    expect(misses).toEqual([])
  })

  it('names the book wherever a result is stated by where the book was covered', () => {
    const COVERED =
      /\b(book (is|was) covered|covered (the|a|all or most of the) (whole )?book|covers the book|covered book|with the book covered)\b/i
    const misses = memoSentences().filter((x) => COVERED.test(x) && !/\$(10|50|250)M\b/.test(x))
    expect(misses).toEqual([])
  })

  it('states the recall draw per level, not one median for every book', () => {
    // At $40,000 of debt the covered books drew a median 17.2% / 30.0%; the $250M bad level
    // (×0.1806) is capped by the venue: 17.2% / 18.1%. memo:301 claimed 17.2% / 30.0% for all.
    const median = (h: string, caseId: string) =>
      Object.values(SIM.claims)
        .find((c) => c.horizon === h)!
        .rows.find((r) => r.caseId === caseId && r.debtUsd === 40_000)!.recallDrawnShareOfDebt!
        .median
    const covered = ['10m-typical', '10m-bad', '50m-typical', '50m-bad', '250m-typical']
    for (const b of covered) {
      expect(
        [pct1(median('90d', `carry:aave-usdc-${b}`)), pct1(median('365d', `carry:aave-usdc-${b}`))],
        b,
      ).toEqual(['17.2%', '30.0%'])
    }
    const bad90 = pct1(median('90d', 'carry:aave-usdc-250m-bad'))
    const bad365 = pct1(median('365d', 'carry:aave-usdc-250m-bad'))
    expect([bad90, bad365]).toEqual(['17.2%', '18.1%'])
    for (const head of ['**Say what it costs.**', '**Unwound carry:**']) {
      const line = MEMO.split('\n').find((l) => l.includes(head))!
      expect(line, head).toContain(`17.2% / 30.0%`)
      expect(line, head).toContain(`${bad90} / ${bad365} at the $250M book bad`)
      expect(line, head).toContain('$250M book typical')
    }
    // Wherever the covered 365d median is quoted as a median, the books are named.
    for (const x of memoSentences()) {
      if (/median[^.;]*30\.0%/.test(x)) expect(x).toMatch(/\$(10|50)M\b/)
    }
  })
})

describe('the memo traces every number to the JSON (round 3, B)', () => {
  it('the JSON analogs carry bookExceedsVenue and the window floor of every cash-vs-book level', () => {
    const analogs = SIM.mechanics.exitCapacity.analogs
    for (const r of EXIT_CAPACITY_BOOK_ROWS) {
      const a = analogs.find((x) => x.id === r.id)!
      expect([a.fWindow, a.bookExceedsVenue], r.id).toEqual([r.fWindow, r.bookExceedsVenue])
    }
    for (const a of analogs.filter((x) => x.model !== 'cash-vs-book')) {
      expect(a.bookExceedsVenue, a.id).toBeUndefined()
    }
    const flagged = analogs.filter((a) => a.bookExceedsVenue)
    const books = analogs.filter((a) => a.model === 'cash-vs-book')
    expect(MEMO).toContain(`That is ${flagged.length} of the ${books.length} cash-vs-book levels`)
    const line = MEMO.split('\n').find((l) => l.includes('**Book exceeds the venue.**'))!
    for (const a of flagged) expect(line, a.id).toContain(a.venue)
    expect(line).toContain('`bookExceedsVenue` in the JSON')
    expect(MEMO.split('\n')[2]).toContain('mechanics.exitCapacity.analogs[].bookExceedsVenue')
  })

  it('states the debt-size condition on every "never sold" / sold-share claim (review r4)', () => {
    const lines = MEMO.split('\n')
    const covered = lines.find((l) => l.includes('covered all or most of the book'))!
    expect(covered).toContain('never sold from $8,000 of debt up.**')
    const bad250 = lines.find((l) => l.includes('**At a $250M book in a bad event**'))!
    expect(bad250).toContain('from $3,999.60 of debt up')
    expect(bad250).toContain('the $50M book in the same bad event')
    expect(MEMO).not.toMatch(/at every hour of the 8 h/)
    expect(MEMO).not.toContain("Aave USDC's typical event covered")
  })

  it('quotes a window cash as the lowest over the window (at least), naming its event', () => {
    // cashUsd8h is the 8 h MINIMUM: "up to $231.1M" had the direction wrong, and the figure is
    // the floor's typical event (ETH −13.3% 2026-06-05), not the $50M book's (2025-02-02).
    const floorTypical = ANALOG('aave-usdc-floor-typical')
    const bookTypical = ANALOG('aave-usdc-50m-typical')
    expect(usdM(floorTypical.cashUsd8h)).toBe('$231.1M')
    expect(usdM(bookTypical.cashUsd8h)).toBe('$802.0M')
    expect(MEMO).not.toMatch(/up to \$\d/)
    for (const x of memoSentences()) {
      if (!x.includes(usdM(floorTypical.cashUsd8h)) || x.includes('÷')) continue
      expect(x).toMatch(/at least|lowest/)
      // review r4: the minimum is on the keeper-retry (held) basis, not every raw hour
      expect(x).toMatch(/retry/)
      expect(x).not.toMatch(/at every hour/)
      expect(x).toContain(floorTypical.event.replace(/-(?=\d+(\.\d+)?%)/, '−'))
    }
    const caveat = MEMO.split('\n').find((l) =>
      l.includes('**The floor is a modelling choice too.**'),
    )!
    expect(caveat).toContain(
      `at least ${usdM(bookTypical.cashUsd8h)} in the $50M book's typical event`,
    )
    expect(caveat).toContain(bookTypical.event.replace('-29', '−29'))
  })
})

describe('parent rulings on the refuter UNSURE items (round 3, D, E, F)', () => {
  it('D: a book larger than the venue is "not an analog", never "could not exist"', () => {
    const files = [
      'docs/research/SET-AND-FORGET-LTV.md',
      'components/RiskFrontier/FinePrint.tsx',
      'lib/position-sim/exitCapacityAnalogs.ts',
      'lib/position-sim/venueStressAnalogs.ts',
      'lib/position-sim/stressGrid.ts',
    ]
    for (const f of files) expect(read(f), f).not.toMatch(/could not exist|deposit is part of/)
    for (const f of files.slice(0, 2)) {
      expect(read(f), f).toMatch(/observed history is not an analog/)
      expect(read(f), f).toMatch(/would have been a different venue/)
    }
    for (const r of EXIT_CAPACITY_BOOK_ROWS.filter((x) => x.bookExceedsVenue)) {
      expect(r.provenance, r.id).toContain('the observed history is not an analog for this book')
    }
  })

  it('E: the A1 copy bullet is "The replay", assumptions first', () => {
    expect(MEMO).not.toContain('**The measurement.**')
    const line = MEMO.split('\n').find((l) => l.includes('**The replay.**'))!
    expect(line.indexOf('four assumptions')).toBeGreaterThan(-1)
    expect(line.indexOf('four assumptions')).toBeLessThan(line.indexOf('was sold in'))
  })

  it('F: wherever assumption (ii) is stated, it says it does not hold for Steakhouse', () => {
    const lines = MEMO.split('\n')
    const ii = lines.find((l) => l.startsWith('2. **The observed cash is first come'))!
    expect(ii).toMatch(/does not hold for the Steakhouse vault.*pro-rata share.*conservative/)
    const assumptions = lines.find((l) =>
      l.startsWith('- **Exit capacity (headline): cash vs book**'),
    )!
    expect(assumptions).toMatch(/not for the Steakhouse vault.*pro-rata share.*conservative/)
    expect(read('components/RiskFrontier/FinePrint.tsx')).toMatch(
      /\(ii\)[^;]*not for the Steakhouse vault: its cash is its pro-rata share[^;]*conservative/,
    )
    for (const r of EXIT_CAPACITY_BOOK_ROWS.filter((x) => x.slug === 'steakhouse-usdc')) {
      expect(r.provenance, r.id).toContain("pro-rata share of each Morpho market's idle cash")
      expect(r.provenance, r.id).toContain('conservative')
    }
  })
})
