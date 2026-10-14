/**
 * Morpho Blue → wavefront position spec, from the on-chain pull's records
 * (scripts/oct10-coverage/morphoEvents.ts writes them; the live engine feeds live reads of the
 * same shape). Pure: no I/O, no globals.
 *
 * A Morpho position is one market: one collateral token, one loan token, the market's LLTV.
 * It is valued in LOAN-TOKEN UNITS, the unit Morpho's own health check uses:
 *
 *   collateral value(m) = collateral × price(m) / 1e36        (oracle price, raw → normalised)
 *   borrowed            = borrow shares → assets ROUNDED UP, interest accrued to ts(N)
 *                         (`borrowedNAccrued`, exactly what Morpho's liquidation check reads)
 *   LTV(m)              = borrowed / collateral value(m)
 *   line                = LLTV
 *
 * Composition is the FIRST event's N-1 position; t0 is that event's block N and price(N); a
 * position Morpho could not liquidate at N (LTV_N <= LLTV) is not walked. Interest accrued
 * after t0 is not added (the window is two days; the walk holds the debt in loan units).
 *
 * DELAY CLASS: collateralClass.ts `delayClassOf([collateral symbol], LLTV)`.
 *
 * USD: the position's unit is converted with `loanUsd(minute)` — the shared stable definition
 * ($1.00 for a dollar stable held at one), else the AaveOracle price of the same token on the
 * same chain from the minute path (EURC, WETH, cbBTC, LBTC …), else unpriced (null). An
 * unpriced loan token leaves LTV and every Membrane decision unchanged; only its USD is
 * missing, and the liqDebtMinimum floor (a USD figure) is not applied to it.
 */

import { delayClassOf } from '../position-sim/collateralClass'
import { minuteOf, type HalfSpec, type PositionSpec, type SpecLeg } from './aave'

export const MORPHO_PRICE_SCALE = 10n ** 36n

/** One Liquidate, re-read on chain (morpho-events.jsonl.gz). */
export interface MorphoEventRecord {
  chain: string
  block_number: number
  log_index: number
  tx_hash: string
  borrower: string
  market_id: string
  ts: number
  oracle: string
  loanToken: string
  collateralToken: string
  loanDecimals: number
  collateralDecimals: number
  /** LLTV, 1e18 scale. */
  lltv: string
  positionNm1: { borrowShares: string; collateral: string }
  /** oracle price() at N, 1e36 × 10^(loanDec - collDec) scale. */
  priceN: string | null
  /** Borrowed assets at ts(N): shares → assets rounded up, interest accrued. */
  borrowedNAccrued: string | null
  ltvN: number | null
  liquidatableN: boolean
}

/** a × b / 10^36 as a double, without losing the fraction. */
export function mulPrice(amountRaw: bigint, priceRaw: bigint): number {
  return Number((amountRaw * priceRaw * 10n ** 18n) / MORPHO_PRICE_SCALE) / 1e18
}

export interface MorphoSpecOptions {
  startTs: number
  stepSeconds: number
  /** liqDebtMinimum, USD; converted to loan units at t0 when the loan token is priced. */
  debtMinimumUsd: number
  collateralSymbol: string
  loanSymbol: string
  /** USD per loan token at a minute, or null when the token is unpriced. */
  loanUsd: (minute: number) => number | null
}

export function morphoPositionSpec(
  events: readonly MorphoEventRecord[],
  opts: MorphoSpecOptions,
): PositionSpec {
  if (!events.length) throw new Error('morphoPositionSpec: no events')
  const evs = [...events].sort(
    (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
  )
  const first = evs[0]
  const pid = `morpho-blue:${first.chain}:${first.market_id}:${first.borrower}`
  const locIdx = evs.findIndex((e) => e.liquidatableN)
  const anchor = locIdx >= 0 ? evs[locIdx] : first
  const minute = minuteOf(anchor.ts, opts.startTs, opts.stepSeconds)
  const usd0 = opts.loanUsd(minute)
  const loanScale = 10 ** anchor.loanDecimals
  const collRaw = BigInt(anchor.positionNm1.collateral)
  const priceN = anchor.priceN != null ? BigInt(anchor.priceN) : 0n
  const collUnits = priceN > 0n ? mulPrice(collRaw, priceN) / loanScale : null
  const debtUnits =
    anchor.borrowedNAccrued != null ? Number(BigInt(anchor.borrowedNAccrued)) / loanScale : null
  const line = Number(BigInt(anchor.lltv)) / 1e18
  const toUsd = (u: number | null) => (u == null || usd0 == null ? null : u * usd0)
  const collateral: SpecLeg[] = [
    {
      key: anchor.oracle,
      p0: Number(priceN),
      symbol: opts.collateralSymbol,
      amount: Number(collRaw) / 10 ** anchor.collateralDecimals,
      price0:
        priceN > 0n && usd0 != null
          ? (Number(priceN) / 1e36) * 10 ** (anchor.collateralDecimals - anchor.loanDecimals) * usd0
          : null,
      value0: collUnits ?? 0,
      usd: toUsd(collUnits),
      lt: line,
    },
  ]
  // The loan leg never moves in loan units: key '' reads ratio 1 at every minute.
  const debt: SpecLeg[] = [
    {
      key: '',
      p0: 1,
      symbol: opts.loanSymbol,
      amount: debtUnits ?? 0,
      price0: usd0,
      value0: debtUnits ?? 0,
      usd: toUsd(debtUnits),
    },
  ]
  const notes: string[] = []
  const delayClass = delayClassOf([opts.collateralSymbol], line)
  const spec: PositionSpec = {
    pid,
    protocol: 'morpho-blue',
    chain: first.chain,
    owner: first.borrower,
    market: first.market_id,
    first: { block: first.block_number, ts: first.ts },
    located: locIdx >= 0,
    collateral,
    debt,
    collUsd: toUsd(collUnits),
    debtUsd: toUsd(debtUnits),
    line,
    ltv0: collUnits != null && debtUnits != null && collUnits > 0 ? debtUnits / collUnits : null,
    delayClass,
    halves: [],
    debtMinimum: usd0 != null && usd0 > 0 ? opts.debtMinimumUsd / usd0 : 0,
    unit: opts.loanSymbol,
    notes,
  }
  if (usd0 == null)
    notes.push(
      `loan token ${opts.loanSymbol} has no USD price: USD figures are null and the liqDebtMinimum floor is not applied`,
    )
  if (locIdx < 0) {
    spec.reason = `not liquidatable at block N: LTV_N <= LLTV on every event (${evs.length})`
    return spec
  }
  if (collUnits == null || debtUnits == null || !(collUnits > 0) || !(debtUnits > 0)) {
    spec.located = false
    spec.reason = 'no collateral value or no debt at the anchor event'
    return spec
  }
  spec.t0 = {
    block: anchor.block_number,
    ts: anchor.ts,
    minute,
    eventIndex: locIdx,
    shifted: locIdx > 0,
  }
  if (locIdx > 0) notes.push(`t0 shifted to event ${locIdx + 1} of ${evs.length}`)
  const half: HalfSpec = {
    collateral,
    share: 1,
    line,
    delayClass: delayClass === 'mixed' ? 'delayed' : delayClass,
  }
  spec.halves = [half]
  return spec
}

// ------------------------------------------------------------------ real side

/** The CSV row fields the real side reads (morpho_liquidations.csv). */
export interface MorphoCsvRow {
  chain: string
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  market_id: string
  borrower: string
  repaid_assets_normalized: string
  seized_assets: string
  bad_debt_assets_normalized: string
  collateral_symbol: string
  loan_symbol: string
}

/**
 * One real Morpho liquidation in USD: repaid assets × loan USD; seized collateral at the
 * event's own oracle price(N) (in loan units) × loan USD; realised bad debt × loan USD,
 * reported separately (it is not repaid — it is socialised to the market's suppliers).
 */
export function morphoRealUsd(
  row: MorphoCsvRow,
  ev: MorphoEventRecord | undefined,
  loanUsdAtEvent: number | null,
): { repaidUsd: number | null; seizedUsd: number | null; badDebtUsd: number | null } {
  if (loanUsdAtEvent == null) return { repaidUsd: null, seizedUsd: null, badDebtUsd: null }
  const repaid = Number(row.repaid_assets_normalized) * loanUsdAtEvent
  const bad = Number(row.bad_debt_assets_normalized || 0) * loanUsdAtEvent
  let seized: number | null = null
  if (ev && ev.priceN != null && BigInt(ev.priceN) > 0n) {
    const units = mulPrice(BigInt(row.seized_assets), BigInt(ev.priceN)) / 10 ** ev.loanDecimals
    seized = units * loanUsdAtEvent
  }
  return { repaidUsd: repaid, seizedUsd: seized, badDebtUsd: bad }
}
