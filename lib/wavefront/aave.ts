/**
 * Aave V3 → wavefront position spec, from the on-chain pull's records
 * (scripts/oct10-coverage/aaveEvents.ts writes them; the live engine feeds live reads of the
 * same shape). Pure: no I/O, no globals.
 *
 * COMPOSITION is read at the t0 event's block N-1 (the pull re-reads every reserve):
 *   collateral  reserves with aToken balance > 0, the user's collateral flag on, and a
 *               liquidation threshold > 0 under the user's e-mode (`ltUsed`)
 *   debt        reserves with variable (+ stable) debt > 0
 * and VALUED AT BLOCK-N PRICES (`priceN`, AaveOracle in the liquidating block) with Aave's own
 * rounding (GenericLogic, v3.5: collateral floor(amount × price / 10^dec), debt ceil), so
 *
 *   line = Σ coll_i · LT_i / Σ coll_i      (Aave's weighted liquidation threshold at N)
 *   LTV0 = debt_N / coll_N
 *
 * and LTV0 > line exactly when the pull's HF_N < 1 (it is the same inequality, S < debt·1e4).
 *
 * t0 is the FIRST event whose HF at N is below 1 (`atN.liquidatable`): normally the first
 * event; when the first is not located and a later one is, the first located one, flagged
 * `t0.shifted`. An account located on no event is not walked.
 *
 * DELAY CLASS: collateralClass.ts `delayClassOf(<every collateral symbol>, line)`. A MIXED
 * position cannot exist on Membrane (Cdp.sol:1650-1651), so it is walked as the two positions
 * Membrane would hold — exactly as compare.ts `splitByDelayClass` splits one: the no-delay legs
 * (sub 0) and the delayed legs (sub 1); the debt goes pro rata to collateral value at t0, so
 * both halves open at the position's own LTV; each half's line is ITS OWN LT-weighted line
 * (Aave's LTs, not a modelled Membrane LTV); each half's class is delayClassOf(its symbols,
 * its line). A half can open under its own line; it then just walks.
 */

import { delayClassOf, isNoDelayCollateral } from '../position-sim/collateralClass'
import type { KernelLeg } from './kernel'
import type { DelayClass, StreamLeg } from './stream'

// ------------------------------------------------------------------ pull record shapes

/** One reserve of the user's position at N-1, as the pull writes it. */
export interface AaveReserveRead {
  asset: string
  symbol: string
  decimals: number
  aTokenBalance: string
  variableDebt: string
  stableDebt: string
  collateralFlag: boolean
  /** The LT in force for this user (e-mode LT when the reserve is in the user's category), bps. */
  ltUsed: number | null
  /** AaveOracle price at N-1 / N, base unit 1e8 USD. */
  priceNm1: string | null
  priceN: string | null
}

/** One LiquidationCall, re-read on chain (aave-events.jsonl.gz). */
export interface AaveEventRecord {
  chain: string
  block_number: number
  log_index: number
  tx_hash: string
  user: string
  ts: number
  collateral_asset: string
  debt_asset: string
  eMode: number
  position: AaveReserveRead[]
  atN: { hf: number; liquidatable: boolean; healthFactor?: string }
  hfNm1?: number
}

// ------------------------------------------------------------------ spec

export const AAVE_PRICE_UNIT = 1e8

export interface SpecLeg {
  /**
   * The minute-path column this leg moves with (Aave: the reserve address; Morpho collateral:
   * the market oracle), or '' for a leg that never moves in the position's unit (a Morpho
   * loan leg, valued in loan units).
   */
  key: string
  /** The path's own value at t0 (same raw units as the column), the ratio's denominator. */
  p0: number
  symbol: string
  /** Token amount, normalised by decimals. */
  amount: number
  /** Price at t0 (block N), USD; null when unpriced. */
  price0: number | null
  /** Value at t0 in the position's unit (USD for Aave, loan units for Morpho). */
  value0: number
  /** Value at t0 in USD, null when unpriced. */
  usd: number | null
  /** Liquidation threshold (fraction), collateral legs only. */
  lt?: number
}

export interface HalfSpec {
  /** 0 = no-delay legs, 1 = delayed legs; undefined for an unsplit position. */
  sub?: number
  collateral: SpecLeg[]
  /** Share of the debt (== share of the collateral value at t0). 1 when unsplit. */
  share: number
  line: number
  delayClass: Exclude<DelayClass, 'mixed'>
}

export interface PositionSpec {
  pid: string
  protocol: 'aave-v3' | 'morpho-blue'
  chain: string
  /** User (Aave) or borrower (Morpho). */
  owner: string
  market?: string
  /** The position's first liquidation event. */
  first: { block: number; ts: number }
  located: boolean
  /** The walk anchor. Present iff located. */
  t0?: { block: number; ts: number; minute: number; eventIndex: number; shifted: boolean }
  /** Why it is not walked. */
  reason?: string
  collateral: SpecLeg[]
  debt: SpecLeg[]
  collUsd: number | null
  debtUsd: number | null
  line: number | null
  ltv0: number | null
  delayClass: DelayClass
  /** One half (unsplit) or two (a mixed position split by delay class). */
  halves: HalfSpec[]
  /** liqDebtMinimum in the position's unit (USD 2000 for Aave). 0 = floor not applied. */
  debtMinimum: number
  /** The unit legs are valued in: 'USD' (Aave) or the Morpho loan token's symbol. */
  unit: string
  notes: string[]
}

const pow10 = (n: number) => 10n ** BigInt(n)
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** Grid minute of a timestamp. */
export const minuteOf = (ts: number, startTs: number, stepSeconds: number) =>
  Math.floor((ts - startTs) / stepSeconds)

/**
 * Collateral and debt legs of one event's N-1 position, valued at that event's block-N
 * prices with Aave's rounding.
 */
export function aaveLegsAtN(ev: AaveEventRecord): {
  collateral: SpecLeg[]
  debt: SpecLeg[]
  /** Collateral reserves held whose value at N floors to 0 base units: dropped (Aave counts 0). */
  zeroValueCollateral: string[]
} {
  const collateral: SpecLeg[] = []
  const debt: SpecLeg[] = []
  const zeroValueCollateral: string[] = []
  for (const p of ev.position) {
    const a = BigInt(p.aTokenBalance)
    const d = BigInt(p.variableDebt) + BigInt(p.stableDebt)
    const priced = p.priceN != null && BigInt(p.priceN) > 0n
    const price = priced ? BigInt(p.priceN!) : 0n
    const price0 = priced ? Number(price) / AAVE_PRICE_UNIT : null
    if (a > 0n && p.collateralFlag && (p.ltUsed ?? 0) > 0) {
      const usd = priced ? Number((a * price) / pow10(p.decimals)) / AAVE_PRICE_UNIT : null
      if (usd === 0) zeroValueCollateral.push(p.symbol)
      else {
        collateral.push({
          key: p.asset,
          p0: Number(price),
          symbol: p.symbol,
          amount: Number(a) / 10 ** p.decimals,
          price0,
          value0: usd ?? 0,
          usd,
          lt: (p.ltUsed as number) / 1e4,
        })
      }
    }
    if (d > 0n) {
      const usd = priced ? Number(ceilDiv(d * price, pow10(p.decimals))) / AAVE_PRICE_UNIT : null
      debt.push({
        key: p.asset,
        p0: Number(price),
        symbol: p.symbol,
        amount: Number(d) / 10 ** p.decimals,
        price0,
        value0: usd ?? 0,
        usd,
      })
    }
  }
  return { collateral, debt, zeroValueCollateral }
}

export const sumUsd = (legs: readonly SpecLeg[]) =>
  legs.some((l) => l.usd == null) ? null : legs.reduce((a, l) => a + (l.usd as number), 0)
export const sumValue = (legs: readonly SpecLeg[]) => legs.reduce((a, l) => a + l.value0, 0)

/** LT-weighted line of a set of collateral legs, at their t0 values. */
export function weightedLine(legs: readonly SpecLeg[]): number | null {
  const c = sumValue(legs)
  if (!(c > 0)) return null
  return legs.reduce((a, l) => a + l.value0 * (l.lt ?? 0), 0) / c
}

/**
 * Split by delay class exactly like compare.ts `splitByDelayClass`: sub 0 = no-delay legs,
 * sub 1 = delayed legs, debt pro rata to collateral value, each half at its own line and class.
 */
export function splitHalves(collateral: readonly SpecLeg[], line: number): HalfSpec[] {
  const cls = delayClassOf(
    collateral.map((l) => l.symbol),
    line,
  )
  if (cls !== 'mixed') return [{ collateral: [...collateral], share: 1, line, delayClass: cls }]
  const parts = [
    collateral.filter((l) => isNoDelayCollateral(l.symbol)),
    collateral.filter((l) => !isNoDelayCollateral(l.symbol)),
  ]
  const total = sumValue(collateral)
  return parts.map((legs, k) => {
    const v = sumValue(legs)
    const own = weightedLine(legs) as number
    const c = delayClassOf(
      legs.map((l) => l.symbol),
      own,
    )
    return {
      sub: k,
      collateral: legs,
      share: total > 0 ? v / total : 0.5,
      line: own,
      delayClass: c === 'mixed' ? 'delayed' : c,
    }
  })
}

export interface AaveSpecOptions {
  startTs: number
  stepSeconds: number
  /** liqDebtMinimum, USD. */
  debtMinimumUsd: number
}

/**
 * The spec of one Aave account from ALL its events in the window (any order). Not walked when
 * no event is located, or when the anchor position has no priced collateral or no debt.
 */
export function aavePositionSpec(
  events: readonly AaveEventRecord[],
  opts: AaveSpecOptions,
): PositionSpec {
  if (!events.length) throw new Error('aavePositionSpec: no events')
  const evs = [...events].sort(
    (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
  )
  const first = evs[0]
  const pid = `aave-v3:${first.chain}:${first.user}`
  const locIdx = evs.findIndex((e) => e.atN.liquidatable)
  const anchor = locIdx >= 0 ? evs[locIdx] : first
  const { collateral, debt, zeroValueCollateral } = aaveLegsAtN(anchor)
  const collUsd = sumUsd(collateral)
  const debtUsd = sumUsd(debt)
  const line = weightedLine(collateral)
  const ltv0 = collUsd != null && debtUsd != null && collUsd > 0 ? debtUsd / collUsd : null
  const notes: string[] = []
  const spec: PositionSpec = {
    pid,
    protocol: 'aave-v3',
    chain: first.chain,
    owner: first.user,
    first: { block: first.block_number, ts: first.ts },
    located: locIdx >= 0,
    collateral,
    debt,
    collUsd,
    debtUsd,
    line,
    ltv0,
    delayClass:
      line == null
        ? 'delayed'
        : delayClassOf(
            collateral.map((l) => l.symbol),
            line,
          ),
    halves: [],
    debtMinimum: opts.debtMinimumUsd,
    unit: 'USD',
    notes,
  }
  if (zeroValueCollateral.length) {
    notes.push(
      `collateral worth 0 base units at block N dropped (Aave counts it as 0): ${zeroValueCollateral.join(', ')}`,
    )
  }
  if (locIdx < 0) {
    spec.reason = `not located: HF at block N >= 1 on every event (${evs.length})`
    return spec
  }
  if (collUsd == null || debtUsd == null || line == null || !(collUsd > 0) || !(debtUsd > 0)) {
    spec.located = false
    spec.reason = 'no priced collateral or no debt at the anchor event'
    return spec
  }
  spec.t0 = {
    block: anchor.block_number,
    ts: anchor.ts,
    minute: minuteOf(anchor.ts, opts.startTs, opts.stepSeconds),
    eventIndex: locIdx,
    shifted: locIdx > 0,
  }
  if (locIdx > 0) {
    notes.push(
      `t0 shifted to event ${locIdx + 1} of ${evs.length}: the first event's HF at block N was >= 1`,
    )
  }
  spec.halves = splitHalves(collateral, line)
  return spec
}

/**
 * Kernel legs of one half, in the position's unit: its own collateral, and every debt leg
 * scaled by the half's share. Kernel leg keys are the spec legs' path keys.
 */
export function kernelLegs(
  spec: PositionSpec,
  half: HalfSpec,
): { collateral: KernelLeg[]; debt: KernelLeg[] } {
  return {
    collateral: half.collateral.map((l) => ({ key: l.key, symbol: l.symbol, value0: l.value0 })),
    debt: spec.debt.map((l) => ({ key: l.key, symbol: l.symbol, value0: l.value0 * half.share })),
  }
}

/** p0 of every path key a spec reads (collateral and debt legs agree on a shared reserve). */
export function pathAnchors(spec: PositionSpec): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of [...spec.collateral, ...spec.debt]) if (l.key) m.set(l.key, l.p0)
  return m
}

export const streamLegs = (legs: readonly SpecLeg[]): StreamLeg[] =>
  legs.map((l) => ({ symbol: l.symbol, usd: l.usd }))

// ------------------------------------------------------------------ real side

/** The CSV row fields the real side reads (aave_liquidations_enriched.csv). */
export interface AaveCsvRow {
  chain: string
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  user: string
  collateral_asset: string
  debt_asset: string
  debt_to_cover_normalized: string
  liquidated_collateral_normalized: string
}

export type PriceSource = 'event-N' | 'minute-path' | 'none'

/**
 * One real liquidation in USD: debt_to_cover × the debt reserve's AaveOracle price at block N,
 * liquidated collateral × the collateral reserve's. The block-N price comes from the event's
 * own re-read (`priceN` of that reserve); a reserve the re-read does not carry falls back to
 * `fallbackPrice` (the minute path at the event's minute).
 */
export function aaveRealUsd(
  row: AaveCsvRow,
  ev: AaveEventRecord | undefined,
  fallbackPrice: (asset: string) => number | null,
): {
  repaidUsd: number | null
  seizedUsd: number | null
  debtPriceSource: PriceSource
  collPriceSource: PriceSource
} {
  const priceOf = (asset: string): { p: number | null; src: PriceSource } => {
    const r = ev?.position.find((x) => x.asset === asset)
    if (r && r.priceN != null && BigInt(r.priceN) > 0n) {
      return { p: Number(r.priceN) / AAVE_PRICE_UNIT, src: 'event-N' }
    }
    const f = fallbackPrice(asset)
    return f != null && f > 0 ? { p: f, src: 'minute-path' } : { p: null, src: 'none' }
  }
  const d = priceOf(row.debt_asset)
  const c = priceOf(row.collateral_asset)
  return {
    repaidUsd: d.p == null ? null : Number(row.debt_to_cover_normalized) * d.p,
    seizedUsd: c.p == null ? null : Number(row.liquidated_collateral_normalized) * c.p,
    debtPriceSource: d.src,
    collPriceSource: c.src,
  }
}
