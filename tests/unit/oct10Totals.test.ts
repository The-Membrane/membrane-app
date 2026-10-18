// THE ANTI-DRIFT GATE for the Oct 10-11 stakes line.
//
// OCT10_TOTALS is imported from public/data/oct10-2025/evidence-census-headline.json so the
// hero never waits on the 1 MB census fetch. That is only safe if the headline file cannot
// silently diverge from the census it claims to summarise — so every field is re-derived here
// from the ROWS of evidence-census.json, to the cent, and against the census's own totals.
//
// UPDATED 2026-10-16, deliberately (owner decision: the landing reads the full on-chain
// census). The figures moved from the old Aave-only evidence.json (2,347 accounts, $144M
// closed, $67M kept) to every Aave and Morpho liquidation of 10-11 Oct 2025 on four chains
// (3,197 positions, $188.1M closed by the protocols, $157.1M by Membrane, $31.1M kept), and
// the lines now say Aave and Morpho and carry the per-protocol split and the †.
//
// UPDATED 2026-10-18, deliberately (owner rulings): Membrane is walked at its OWN line with
// liquidity-capped sales, on the COMPARED set (2,280 of 3,197: the rest have no Membrane line or
// would sell a token with no observed liquidity). Debt repaid only. At those lines Membrane
// closes MORE debt, net ($164.1M by the protocols, $193.0M by Membrane), so every line is
// direction-aware. The stakes line is the size of the DAY (real side, all 3,197) and did not move.
//
// UPDATED 2026-10-18 again, deliberately (owner rulings, round 2 and 3): each Membrane position's
// debt is sized to Membrane's line (debt0 x memLine / protocolLine), the walk is capped at a
// uniform 0.98x capacity†, any position with a collateral leg lacking a Membrane line is
// excluded, and the comparison is the SHARE of each side's own t0 debt closed, debt-weighted.
// No Membrane dollar is set beside a real one. Real dollars stay only as the size of the day.

import { describe, expect, it } from 'vitest'

import file from '@/public/data/oct10-2025/evidence-census.json'
import headline from '@/public/data/oct10-2025/evidence-census-headline.json'
import {
  compareRow,
  decodeEvidence,
  type CohortRow,
  type EvidenceFile,
} from '@/components/Evidence/types'
import {
  OCT10_DAY,
  OCT10_SCALE_LINE,
  OCT10_SPLIT_LINE,
  OCT10_STAKES_LINE,
  OCT10_TOTALS,
} from '@/lib/position-sim/oct10Totals'

const doc = decodeEvidence(file as unknown as EvidenceFile)
const rows = doc.cohort
const near = (a: number, b: number, tol = 0.02) => expect(Math.abs(a - b)).toBeLessThan(tol)
const sumOf = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)

/** The rows both shares are taken over: priced (two dust loans serve as $0.00 and weigh 0). */
const pricedRows = (xs: readonly CohortRow[]) =>
  xs.filter((r) => r.priced && r.realFrac != null && r.memFrac != null)

/** Debt-weighted shares, recomputed from the rows (memFrac is served at 1e-5). */
function sharesOf(xs: readonly CohortRow[]) {
  const p = pricedRows(xs)
  const rd = sumOf(p, (r) => r.debtUsd ?? 0)
  const md = sumOf(p, (r) => r.memDebtUsd ?? 0)
  return {
    priced: p.length,
    realShare: sumOf(p, (r) => r.realRepaidUsd) / rd,
    memShare: sumOf(p, (r) => r.memFrac! * (r.memDebtUsd ?? 0)) / md,
  }
}

describe('OCT10_TOTALS', () => {
  it('counts every compared position, and the census it is a part of', () => {
    expect(OCT10_TOTALS.positions).toBe(rows.length)
    expect(OCT10_TOTALS.positions).toBe(doc.meta.positions)
    expect(OCT10_TOTALS.censusPositions).toBe(doc.meta.censusPositions)
    expect(
      OCT10_TOTALS.positions +
        OCT10_TOTALS.excluded.noMembraneLine.positions +
        OCT10_TOTALS.excluded.partialMembraneLine.positions +
        OCT10_TOTALS.excluded.noCapacity.positions,
    ).toBe(OCT10_TOTALS.censusPositions)
  })

  it('the day is every position, the real side only: compared + excluded', () => {
    expect(OCT10_DAY.positions).toBe(doc.meta.censusPositions)
    near(
      OCT10_DAY.realClosedUsd,
      sumOf(rows, (r) => r.realRepaidUsd) +
        doc.meta.exclusions.noMembraneLine.realRepaidUsd +
        doc.meta.exclusions.partialMembraneLine.realRepaidUsd +
        doc.meta.exclusions.noCapacity.realRepaidUsd,
    )
  })

  it('counts every liquidation event', () => {
    expect(OCT10_TOTALS.events).toBe(doc.meta.events)
    expect(OCT10_TOTALS.events).toBe(rows.reduce((a, r) => a + r.events, 0))
  })

  it('recomputes both shares from the rows, debt-weighted, and the real dollars to the cent', () => {
    near(
      OCT10_TOTALS.realClosedUsd,
      sumOf(rows, (r) => r.realRepaidUsd),
    )
    const s = sharesOf(rows)
    expect(s.priced).toBe(doc.debt.all.pricedPositions)
    near(s.realShare, OCT10_TOTALS.realShare, 2e-5)
    near(s.memShare, OCT10_TOTALS.membraneShare, 2e-5)
    near(OCT10_TOTALS.gapPp, (OCT10_TOTALS.realShare - OCT10_TOTALS.membraneShare) * 100, 1e-3)
  })

  it('recomputes the per-protocol split from the rows', () => {
    for (const [k, p] of [
      ['aave', 'aave-v3'],
      ['morpho', 'morpho-blue'],
    ] as const) {
      const rs = rows.filter((r) => r.protocol === k)
      const t = OCT10_TOTALS.byProtocol[k]
      expect(t.positions).toBe(rs.length)
      const s = sharesOf(rs)
      near(s.realShare, t.realShare, 2e-5)
      near(s.memShare, t.membraneShare, 2e-5)
      expect(t.realShare).toBe(doc.debt.byProtocol[p].realShare)
      expect(t.membraneShare).toBe(doc.debt.byProtocol[p].memShare)
    }
  })

  it('lists exactly the chains the census spans', () => {
    const seen = Array.from(new Set(rows.map((r) => r.chain)))
    expect([...OCT10_TOTALS.chains].sort()).toEqual(seen.sort())
  })

  it('names the file it was summed from, and that file is the same census', () => {
    expect(OCT10_TOTALS.source).toContain('public/data/oct10-2025/evidence-census.json')
    expect(headline.censusSha256).toBe(doc.meta.source.sha256)
  })
})

describe('the headline file the landing imports', () => {
  it('agrees with evidence-census.json on every figure it carries', () => {
    expect(headline.positions).toBe(doc.meta.positions)
    expect(headline.window).toBe(doc.meta.window.label)
    for (const [k, s] of [
      ['all', doc.debt.all],
      ['aave', doc.debt.byProtocol['aave-v3']],
      ['morpho', doc.debt.byProtocol['morpho-blue']],
    ] as const) {
      const h = headline[k]
      expect(h.positions).toBe(s.positions)
      expect(h.realRepaidUsd).toBe(s.realRepaidUsd)
      expect(h.realShare).toBe(s.realShare)
      expect(h.memShare).toBe(s.memShare)
      expect(h.gapPp).toBe(s.gapPp)
      expect([h.less, h.more, h.equal]).toEqual([s.less, s.more, s.equal])
    }
    expect(headline.gridEnd).toEqual({
      positions: doc.meta.gridEnd.positions,
      memShare: doc.meta.gridEnd.memShare,
    })
    expect(headline.neverSold).toEqual(doc.time.neverSold)
    expect(headline.unpricedPositions).toBe(doc.meta.unpriced.positions)
    expect(headline.capacityMultiplier).toBe(0.98)
    const row = headline.sensitivity.table.find((t) => t.headline)!
    expect(row.key).toBe('capacity-0.98')
    expect(row.memShare).toBe(headline.all.memShare)
    expect(row.gapPp).toBe(headline.all.gapPp)
  })

  it('carries no Membrane dollar figure', () => {
    expect(JSON.stringify(headline)).not.toMatch(/"mem(?!DebtUsd)[A-Za-z]*Usd"/)
  })
})

describe('OCT10_STAKES_LINE', () => {
  it('states the size of the day, the window, the count, both protocols, and nothing else', () => {
    expect(OCT10_STAKES_LINE).toBe(
      '$188M of loans force-closed on Aave and Morpho · 10–11 Oct 2025 · 3,197 positions',
    )
  })
})

describe('OCT10 share line', () => {
  // The figure is NET, in percentage points of each side's own debt: Membrane closes a smaller
  // share on some positions and a larger one on others. It says "net", never "protected", never
  // "alone", and its word comes from its sign.
  it('is the NET share gap, direction-aware, marked modelled, with its set, split and gross', () => {
    expect(OCT10_SCALE_LINE.direction).toBe(OCT10_TOTALS.gapPp >= 0 ? 'less' : 'more')
    expect(OCT10_SCALE_LINE.line).toBe(
      '4% sounds small. The protocols force-closed 31.2% of the debt; at Membrane’s own lines a borrower would have lost 13.3%† of theirs — 17.9 pp less, net†, across 1,545 of the 3,197 Aave and Morpho liquidations of 10–11 Oct 2025.',
    )
    expect(OCT10_SCALE_LINE.result).toBe(
      '17.9 pp less of the debt force-closed, net† (31.2% → 13.3%†)',
    )
    expect(OCT10_SCALE_LINE.scope).toBe(
      'share of debt closed on 1,545 of the 3,197 Aave V3 and Morpho Blue liquidations of 10–11 Oct 2025, Ethereum, Arbitrum, Optimism and Base, at Membrane’s own lines with the debt sized to them and liquidity-capped sales†',
    )
    expect(OCT10_SPLIT_LINE).toBe('Aave 13.9 pp less · Morpho 50.3 pp less')
    expect(OCT10_SCALE_LINE.split).toBe(OCT10_SPLIT_LINE)
    expect(OCT10_SCALE_LINE.gross).toBe(
      'a smaller share on 1,018 positions (32.2% vs 7.1%†), a larger one on 383 (25.8% vs 44.8%†)',
    )
    for (const v of Object.values(OCT10_SCALE_LINE)) {
      expect(v).not.toMatch(/protected|\balone\b/i)
    }
  })

  it('the per-position less/more/equal counts and the gross shares come from the rows', () => {
    const cmp = rows.map((r) => [r, compareRow(r)] as const)
    const less = cmp.filter(([, c]) => c === 'less').map(([r]) => r)
    const more = cmp.filter(([, c]) => c === 'more').map(([r]) => r)
    const equal = cmp.filter(([, c]) => c === 'equal')
    expect([less.length, more.length, equal.length]).toEqual([
      headline.all.less,
      headline.all.more,
      headline.all.equal,
    ])
    near(sharesOf(less).realShare, headline.all.lessSet.realShare, 2e-5)
    near(sharesOf(less).memShare, headline.all.lessSet.memShare, 2e-5)
    near(sharesOf(more).realShare, headline.all.moreSet.realShare, 2e-5)
    near(sharesOf(more).memShare, headline.all.moreSet.memShare, 2e-5)
  })
})
