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

import { describe, expect, it } from 'vitest'

import file from '@/public/data/oct10-2025/evidence-census.json'
import headline from '@/public/data/oct10-2025/evidence-census-headline.json'
import { decodeEvidence, type EvidenceFile } from '@/components/Evidence/types'
import {
  OCT10_SCALE_LINE,
  OCT10_SPLIT_LINE,
  OCT10_STAKES_LINE,
  OCT10_TOTALS,
} from '@/lib/position-sim/oct10Totals'

const doc = decodeEvidence(file as unknown as EvidenceFile)
const rows = doc.cohort
const sum = (
  xs: { realRepaidUsd: number; memRepaidUsd: number }[],
  k: 'realRepaidUsd' | 'memRepaidUsd',
) => xs.reduce((a, r) => a + r[k], 0)
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.02)

describe('OCT10_TOTALS', () => {
  it('counts every position of the census', () => {
    expect(OCT10_TOTALS.positions).toBe(rows.length)
    expect(OCT10_TOTALS.positions).toBe(doc.meta.positions)
  })

  it('counts every liquidation event', () => {
    expect(OCT10_TOTALS.events).toBe(doc.meta.events)
    expect(OCT10_TOTALS.events).toBe(rows.reduce((a, r) => a + r.events, 0))
  })

  it('recomputes both closed totals from the rows, to the cent', () => {
    near(OCT10_TOTALS.realClosedUsd, sum(rows, 'realRepaidUsd'))
    near(OCT10_TOTALS.membraneClosedUsd, sum(rows, 'memRepaidUsd'))
    near(OCT10_TOTALS.keptUsd, sum(rows, 'realRepaidUsd') - sum(rows, 'memRepaidUsd'))
  })

  it('recomputes the per-protocol split from the rows', () => {
    for (const [k, p] of [
      ['aave', 'aave-v3'],
      ['morpho', 'morpho-blue'],
    ] as const) {
      const rs = rows.filter((r) => r.protocol === k)
      const t = OCT10_TOTALS.byProtocol[k]
      expect(t.positions).toBe(rs.length)
      near(t.realClosedUsd, sum(rs, 'realRepaidUsd'))
      near(t.membraneClosedUsd, sum(rs, 'memRepaidUsd'))
      near(t.realClosedUsd, doc.debt.byProtocol[p].realRepaidUsd)
    }
  })

  it('recomputes the collateral at risk from the priced rows', () => {
    near(
      OCT10_TOTALS.collateralAtRiskUsd,
      rows.filter((r) => r.priced).reduce((a, r) => a + (r.collUsd ?? 0), 0),
    )
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
      expect(h.memRepaidUsd).toBe(s.memRepaidUsd)
      expect(h.gapUsd).toBe(s.gapUsd)
      expect(h.gapPct).toBe(s.gapPct)
    }
    expect([headline.less, headline.more, headline.equal]).toEqual([
      doc.debt.all.less,
      doc.debt.all.more,
      doc.debt.all.equal,
    ])
    expect(headline.gridEnd).toEqual({
      positions: doc.meta.gridEnd.positions,
      memRepaidUsd: doc.meta.gridEnd.memRepaidUsd,
    })
    expect(headline.neverSold).toEqual(doc.time.neverSold)
    expect(headline.unpricedPositions).toBe(doc.meta.unpriced.positions)
    expect(headline.sensitivity.band).toEqual(
      doc.time.bandSensitivity.map((b) => ({ band: b.band, memRepaidUsd: b.memRepaidUsd })),
    )
  })
})

describe('OCT10_STAKES_LINE', () => {
  it('states the size, the window, the count, both protocols, and nothing else', () => {
    expect(OCT10_STAKES_LINE).toBe(
      '$188M of loans force-closed on Aave and Morpho · 10–11 Oct 2025 · 3,197 positions',
    )
  })
})

describe('OCT10 kept figure', () => {
  // UPDATED 2026-10-16 (review): the figure is NET — Membrane closes less on some positions
  // and more on others — and it is a separate measure from the multi-year corpus line, with
  // its own scope. So it says "net", never "protected", and never "alone".
  it('is the NET census gap, marked modelled, with its scope, the split and the gross', () => {
    expect(OCT10_SCALE_LINE.line).toBe(
      '4% sounds small. $31M less debt force-closed, net†, across every Aave and Morpho liquidation of 10–11 Oct 2025.',
    )
    expect(OCT10_SCALE_LINE.result).toBe('$31M less debt force-closed, net†')
    expect(OCT10_SCALE_LINE.scope).toBe(
      'debt closed on every Aave V3 and Morpho Blue liquidation of 10–11 Oct 2025, Ethereum, Arbitrum, Optimism and Base',
    )
    expect(OCT10_SPLIT_LINE).toBe('Aave $8.6M · Morpho $22.4M')
    expect(OCT10_SCALE_LINE.split).toBe(OCT10_SPLIT_LINE)
    expect(OCT10_SCALE_LINE.gross).toBe(
      `less on ${doc.debt.all.less.toLocaleString('en-US')} positions ($95.1M†), more on ${doc.debt.all.more.toLocaleString('en-US')} ($64.0M†)`,
    )
    for (const v of Object.values(OCT10_SCALE_LINE)) {
      expect(v).not.toMatch(/protected|\balone\b/i)
    }
  })

  it('the gross less minus the gross more is the net, from the rows', () => {
    const less = rows.filter(
      (r) => r.priced && Math.round(r.memRepaidUsd * 100) < Math.round(r.realRepaidUsd * 100),
    )
    const more = rows.filter(
      (r) => r.priced && Math.round(r.memRepaidUsd * 100) > Math.round(r.realRepaidUsd * 100),
    )
    const lessUsd = less.reduce((a, r) => a + r.realRepaidUsd - r.memRepaidUsd, 0)
    const moreUsd = more.reduce((a, r) => a + r.memRepaidUsd - r.realRepaidUsd, 0)
    expect([less.length, more.length]).toEqual([headline.less, headline.more])
    near(lessUsd, headline.lessUsd)
    near(moreUsd, headline.moreUsd)
    near(lessUsd - moreUsd, OCT10_TOTALS.keptUsd)
  })
})
