/**
 * The incremental wavefront kernel IS cureWalk, fed one minute at a time.
 *
 * For EVERY row of public/data/oct10-2025/evidence.json whose collateral has a usable ratio
 * series, the series is rebuilt exactly as scripts/build-evidence.ts builds it (same symbol →
 * column mapping, anchored at the row's own p_liq, minute-start grid from t0 + 1), and both
 * engines are run on the same input. They must close the same dollars (<= 1e-6), first sell at
 * the same index, and report the same outcome, sales, breaches and first-cure minute — under
 * the headline settings and under five variants that exercise the other branches (every row
 * walked delayed; the never-cleared timer; a per-sale repay cap; the line 2% lower, which puts
 * the rows cureWalk would call unlocated over their line so they are compared too; the old
 * stop after a t0 sale past the band, which both engines keep only for the sensitivity).
 * Both engines walk on after a t0 sale past the band by default, as the contract does
 * (LiquidationEngine.sol:1421-1423).
 *
 * The one deliberate difference: a row whose LTV0 is at or under its line (cureWalk's
 * 'sold-immediately-unlocated-line', which the census excludes) is walked by the kernel.
 * Counts (headline): 1,142 rows with a series; 709 compared field for field; 433 unlocated
 * (the 395 rows evidence.json excludes, plus 38 whose published inputs — rounded to cents and
 * the line to 1e-5 — land at or under the line). The 'line x 0.98' variant compares 1,118.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cureWalk, type CureWalkInput } from '@/lib/position-sim/curePath'
import { heldAtOne } from '@/lib/position-sim/collateralClass'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '@/lib/position-sim/membrane'
import { MembraneKernel } from '@/lib/wavefront/kernel'

const DIR = path.join(__dirname, '../../public/data/oct10-2025')
const evidence = JSON.parse(fs.readFileSync(path.join(DIR, 'evidence.json'), 'utf8'))
const px = JSON.parse(fs.readFileSync(path.join(DIR, 'prices-1m.json'), 'utf8'))

const P0: number = px.startTs
const STEP: number = px.stepSeconds
const ETH: number[] = px.columns.ethOracle
const BTC: number[] = px.columns.btcOracle
const WSTETH: number[] = px.columns.wstethOracle
const NP = ETH.length
const FLAT: number[] = new Array(NP).fill(1)
// build-evidence.ts seriesFor (headline, wstETH 'wrap' mode)
const ETH_LIKE = new Set(['WETH', 'ETH', 'weETH', 'rETH', 'cbETH', 'ETHx', 'osETH'])
const BTC_LIKE = new Set(['WBTC', 'BTC', 'cbBTC', 'tBTC', 'LBTC'])
const seriesFor = (s: string): number[] | null =>
  heldAtOne(s)
    ? FLAT
    : s === 'wstETH'
      ? WSTETH
      : ETH_LIKE.has(s)
        ? ETH
        : BTC_LIKE.has(s)
          ? BTC
          : null

/** build-evidence.ts's ratio series for one cohort row. */
function ratiosFor(row: any): (number | null)[] | null {
  const cs = seriesFor(row.collSymbol)
  const ds = seriesFor(row.debtSymbol)
  const i0 = row.t0Index
  const pLiqC = row.pLiqColl
  const pLiqD = row.pLiqDebt
  if (!(cs && ds && pLiqC && NP - i0 > 1)) return null
  const ratios: (number | null)[] = new Array(NP - i0)
  ratios[0] = 1
  for (let i = i0 + 1; i < NP; i++) {
    const cr = pLiqC > 0 ? cs[i] / pLiqC : null
    const dr = pLiqD > 0 ? ds[i] / pLiqD : null
    ratios[i - i0] = cr != null && dr != null && dr > 0 ? cr / dr : null
  }
  return ratios
}

interface Variant {
  name: string
  noDelay: (row: any) => boolean
  noEarlyClear?: boolean
  maxRepay?: number
  /** Scale the line (the engines are compared on more inputs than the census's own). */
  lineScale?: number
  /** The old stop after a t0 sale past the band (the published sensitivity). */
  stop?: boolean
}
const VARIANTS: Variant[] = [
  { name: 'headline', noDelay: (r) => r.delayClass === 'no-delay' },
  { name: 'all delayed', noDelay: () => false },
  { name: 'never cleared early', noDelay: (r) => r.delayClass === 'no-delay', noEarlyClear: true },
  { name: 'per-sale cap $250k', noDelay: (r) => r.delayClass === 'no-delay', maxRepay: 250_000 },
  // Puts the rows cureWalk would call unlocated over their line too, so they are compared.
  { name: 'line x 0.98', noDelay: (r) => r.delayClass === 'no-delay', lineScale: 0.98 },
  {
    name: 'stop after the t0 band sale (sensitivity)',
    noDelay: (r) => r.delayClass === 'no-delay',
    stop: true,
  },
]

function runKernel(row: any, ratios: (number | null)[], input: CureWalkInput) {
  const i0 = row.t0Index
  const k = new MembraneKernel({
    pid: `${row.chain}:${row.user}`,
    collateral: [{ key: 'c', symbol: row.collSymbol, value0: input.collateralUsd }],
    debt: [{ key: 'd', symbol: row.debtSymbol, value0: input.debtUsd }],
    line: input.line,
    noDelay: input.noDelay ?? false,
    band: input.band,
    delaySteps: Math.ceil(input.delaySeconds / input.stepSeconds),
    gap: input.gap,
    debtMinimum: input.debtMinimumUsd ?? 0,
    maxSales: input.maxSales ?? 20,
    t0Minute: i0,
    t0Ts: row.t0Ts,
    startTs: P0,
    stepSeconds: STEP,
    lastMinute: NP - 1,
    noEarlyClear: input.noEarlyClear,
    maxRepayPerSale: input.maxRepayPerSaleUsd,
    stopAfterT0BandSale: input.stopAfterT0BandSale,
  })
  k.start()
  for (let m = i0 + 1; m < NP; m++) k.step(m, (leg) => (leg.key === 'c' ? ratios[m - i0] : 1))
  k.finish()
  return k.result()
}

const rows: any[] = evidence.cohort
const usable = rows
  .map((row) => ({ row, ratios: ratiosFor(row) }))
  .filter((x): x is { row: any; ratios: (number | null)[] } => x.ratios !== null)

describe('wavefront kernel == cureWalk on every evidence.json row with a usable series', () => {
  it('rebuilds the same priced set build-evidence.ts publishes', () => {
    expect(usable.length).toBe(rows.filter((r) => r.priced).length)
    expect(usable.length).toBeGreaterThan(1000)
  })

  it('the rebuilt headline walk reproduces the published per-row figure', () => {
    // Inputs in evidence.json are rounded (USD to cents, the line to 1e-5, p_liq to 1e-6), and
    // a 1e-5 move in the line moves a repay-to-cap by ~1e-4 of the debt, so this is a sanity
    // check on the rebuild (same outcome, dollars within 0.1% of the debt), not the
    // equivalence itself — that is the next four tests, on identical inputs.
    let close = 0
    for (const { row, ratios } of usable) {
      const w = cureWalk({
        debtUsd: row.debtUsd,
        collateralUsd: row.collateralUsd,
        line: row.liqLine,
        band: MAX_THRESHOLD_TO_DELAY,
        delaySeconds: CURE_WINDOW_SECONDS,
        stepSeconds: STEP,
        gap: BORROW_LTV_GAP,
        ratios,
        debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
        maxSales: 20,
        noDelay: row.delayClass === 'no-delay',
      })
      // Below ~$100 the cent rounding of debt and collateral alone moves LTV0 across the line.
      if (row.excluded || row.debtUsd < 100) continue
      if (
        w.outcome === row.outcome &&
        Math.abs(w.closedUsd - row.membraneClosedUsd) <= 0.05 + 1e-3 * row.debtUsd
      ) {
        close++
      }
    }
    const included = usable.filter((x) => !x.row.excluded && x.row.debtUsd >= 100).length
    expect(included).toBeGreaterThan(500)
    expect(close / included).toBeGreaterThan(0.99)
  })

  for (const v of VARIANTS) {
    it(`${v.name}: same dollars, first-sale index, outcome, sales, breaches`, () => {
      let compared = 0
      let unlocated = 0
      let sold = 0
      for (const { row, ratios } of usable) {
        const input: CureWalkInput = {
          debtUsd: row.debtUsd,
          collateralUsd: row.collateralUsd,
          line: row.liqLine * (v.lineScale ?? 1),
          band: MAX_THRESHOLD_TO_DELAY,
          delaySeconds: CURE_WINDOW_SECONDS,
          stepSeconds: STEP,
          gap: BORROW_LTV_GAP,
          ratios,
          debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
          maxSales: 20,
          noDelay: v.noDelay(row),
          noEarlyClear: v.noEarlyClear,
          maxRepayPerSaleUsd: v.maxRepay,
          stopAfterT0BandSale: v.stop,
        }
        const w = cureWalk(input)
        const k = runKernel(row, ratios, input)
        if (w.outcome === 'sold-immediately-unlocated-line') {
          // By design the kernel walks a position that opens under its line.
          expect(k.startUnbreached, `${row.chain}:${row.user}`).toBe(true)
          unlocated++
          continue
        }
        compared++
        if (w.sales > 0) sold++
        const id = `${v.name} ${row.chain}:${row.user}`
        expect(Math.abs(k.closedT0 - w.closedUsd), id).toBeLessThanOrEqual(1e-6)
        expect(k.closedAtIndex, id).toBe(w.closedAtIndex)
        expect(k.outcome, id).toBe(w.outcome)
        expect(k.sales, id).toBe(w.sales)
        expect(k.breaches, id).toBe(w.breaches)
        expect(k.minutesToFirstCure, id).toBe(w.minutesToFirstCure)
      }
      expect(compared + unlocated).toBe(usable.length)
      console.log(`[${v.name}] compared ${compared}, unlocated ${unlocated}, sold ${sold}`)
      expect(sold).toBeGreaterThan(100)
    })
  }
})
