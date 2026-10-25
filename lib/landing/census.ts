/**
 * THE MEASURED SIDE (refuting review D1). When an address has a row in the Oct 10 census
 * (public/data/oct10-2025/evidence.json), Aave's side is what Aave ACTUALLY closed on it,
 * not the page's model of Aave at the median repay size. The Membrane side is the
 * census's own walk of the same row (lib/position-sim/curePath.ts cureWalk).
 *
 * The census records each row's total closed and its first event minute, not a
 * per-event split, so the chart shows the measured total as one mark at the first event
 * and says how many events it sums.
 */

import { priceAt, stamp, type Comparison, type PricePath, type ProtocolPosition, type SimRun } from '@/lib/position-sim'

/** The slice of a census row the landing uses. */
export interface CensusRow {
  user: string
  events: number
  t0Index: number
  aaveClosedUsd: number
  membraneClosedUsd: number
  outcome: string
  collSymbol: string
  debtSymbol: string
}

interface RawRow {
  user: string
  chain?: string
  excluded?: boolean
  priced?: boolean
  events: number
  t0Index: number
  aaveClosedUsd: number
  membraneClosedUsd: number
  outcome: string
  collSymbol: string
  debtSymbol: string
  debtUsd: number
}

/**
 * The included, priced mainnet row for an address (largest debt when it has several),
 * or null. Only priced rows were walked minute by minute, so only they carry a
 * Membrane figure the page can quote.
 */
export function censusRowFor(cohort: RawRow[], address: string): CensusRow | null {
  const a = address.toLowerCase()
  const rows = cohort
    .filter((r) => r.user.toLowerCase() === a && (r.chain ?? 'mainnet') === 'mainnet' && !r.excluded && r.priced !== false)
    .sort((x, y) => y.debtUsd - x.debtUsd)
  const r = rows[0]
  if (!r) return null
  return {
    user: r.user,
    events: r.events,
    t0Index: r.t0Index,
    aaveClosedUsd: r.aaveClosedUsd,
    membraneClosedUsd: r.membraneClosedUsd,
    outcome: r.outcome,
    collSymbol: r.collSymbol,
    debtSymbol: r.debtSymbol,
  }
}

/** Collateral-weighted liquidation bonus the position's legs expose (null legs excluded). */
function weightedBonus(p: ProtocolPosition): number {
  const priced = p.collateral.filter((c) => c.liquidationBonus !== null)
  const v = priced.reduce((a, c) => a + c.valueUsd, 0)
  return v > 0 ? priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / v : 0
}

/**
 * Aave's run rebuilt from the measured close: the census total is repaid at the first
 * event minute and the collateral the liquidator took (repaid × (1 + the venue's own
 * bonus)) leaves with it. Everything else is the same price path as the modelled run.
 */
export function measuredSourceRun(position: ProtocolPosition, path: PricePath, row: CensusRow): SimRun {
  const bonus = weightedBonus(position)
  const coll = position.collateral.map((c) => ({ symbol: c.symbol, amount: c.amount, fallback: c.priceUsd }))
  const debt = position.debt.map((d) => ({ symbol: d.symbol, amount: d.amount, fallback: d.priceUsd }))
  const value = (legs: typeof coll, i: number) =>
    legs.reduce((a, l) => a + l.amount * (priceAt(path, l.symbol, i) ?? l.fallback), 0)
  const t0 = Math.max(0, Math.min(path.count - 1, row.t0Index))
  const equitySeries: (number | null)[] = []
  const ltvSeries: (number | null)[] = []
  let startEquity = 0
  let peakLtv = 0
  let seized = 0
  let repaid = 0
  for (let i = 0; i < path.count; i++) {
    if (i === t0) {
      const c = value(coll, i)
      const d = value(debt, i)
      repaid = Math.min(d, row.aaveClosedUsd)
      seized = Math.min(c, repaid * (1 + bonus))
      for (const l of coll) l.amount *= c > 0 ? 1 - seized / c : 1
      for (const l of debt) l.amount *= d > 0 ? 1 - repaid / d : 1
    }
    const c = value(coll, i)
    const d = value(debt, i)
    if (i === 0) startEquity = c - d
    const ltv = c > 0 ? d / c : null
    if (ltv !== null) peakLtv = Math.max(peakLtv, ltv)
    equitySeries.push(c - d)
    ltvSeries.push(ltv)
  }
  const endC = value(coll, path.count - 1)
  const endD = value(debt, path.count - 1)
  return {
    engine: 'source',
    label: position.label,
    events: [
      {
        minute: t0,
        ts: path.startTs + t0 * path.stepSeconds,
        kind: 'liquidation',
        ltv: ltvSeries[t0] ?? 0,
        line: position.liquidationLtv,
        repaidUsd: repaid,
        seizedUsd: seized,
        recalledUsd: 0,
        penaltyUsd: seized - repaid,
        why: `Measured: ${row.events} Aave liquidation${row.events === 1 ? '' : 's'} closed $${Math.round(row.aaveClosedUsd).toLocaleString('en-US')} of this loan (public/data/oct10-2025/evidence.json), shown at the first one.`,
      },
    ],
    endCollateralUsd: endC,
    endDebtUsd: endD,
    endDeployedUsd: 0,
    startEquityUsd: startEquity,
    endEquityUsd: endC - endD,
    penaltyPaidUsd: seized - repaid,
    peakLtv,
    wiped: endC <= 0.01 * Math.max(1, position.totalCollateralUsd),
    equitySeries,
    ltvSeries,
    provenance: stamp('dataset', `${position.label} · measured Oct 10 liquidations`, 'Total closed and first-event minute from the census row; collateral taken at the venue’s own bonus.'),
    caveats: [`The census records ${row.events} event${row.events === 1 ? '' : 's'} and their total, not a per-event split; the chart applies the total at the first event.`],
  }
}

/** The comparison with Aave's side replaced by the measured close. */
export function withMeasuredSource(cmp: Comparison, path: PricePath, row: CensusRow): Comparison {
  const source = measuredSourceRun(cmp.position, path, row)
  return { ...cmp, source, equityDeltaUsd: cmp.membrane.endEquityUsd - source.endEquityUsd }
}
