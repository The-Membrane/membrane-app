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
 * Composition is the t0 event's N-1 position; t0 is the first event Morpho's own check finds
 * liquidatable — at the block-N oracle price, or, when N's price does not show it, at the
 * block N-1 price (both with the debt accrued to N; `priceBasis` records which). A position
 * liquidatable at neither is not walked. Interest accrued after t0 is not added (the window is
 * two days; the walk holds the debt in loan units).
 *
 * DELAY CLASS: collateralClass.ts `delayClassOf([collateral symbol], LLTV)`.
 *
 * USD: the position's unit is converted with `loanUsd(minute)` — the shared stable definition
 * ($1.00 for a dollar stable held at one), else the AaveOracle price of the same token on the
 * same chain from the minute path at that minute (the price in force at the minute START, not
 * at block N; EURC, WETH, cbBTC, LBTC …), else unpriced (null). An unpriced loan token has no
 * USD on either side. Its LTV path is unaffected, but one Membrane decision is: the
 * liqDebtMinimum floor is a USD figure and cannot be converted, so it is NOT applied — those
 * positions' repays are sized without the floor and remainder guard.
 */

import { delayClassOf } from '../position-sim/collateralClass'
import {
  minuteOf,
  sortEvents,
  type HalfSpec,
  type PositionSpec,
  type PriceBasis,
  type SpecLeg,
} from './aave'
import { morphoPid } from './pid'

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
  /** oracle price() at N-1 and at N, 1e36 × 10^(loanDec - collDec) scale. */
  priceNm1?: string | null
  priceN: string | null
  /** Borrowed assets at ts(N): shares → assets rounded up, interest accrued. */
  borrowedNAccrued: string | null
  ltvN: number | null
  liquidatableN: boolean
}

/**
 * Liquidatable under `basis`: Morpho's own check, borrowed > collateral × price / 1e36 × LLTV
 * (mulDivDown, then wMulDown), with the debt accrued to ts(N) in both cases and the oracle
 * price at N (`liquidatableN`, as the pull computed it) or at N-1.
 */
export function morphoLocatedAt(ev: MorphoEventRecord, basis: PriceBasis): boolean {
  if (basis === 'N') return ev.liquidatableN
  if (ev.priceNm1 == null || ev.borrowedNAccrued == null) return false
  const collValue = (BigInt(ev.positionNm1.collateral) * BigInt(ev.priceNm1)) / MORPHO_PRICE_SCALE
  const maxBorrow = (collValue * BigInt(ev.lltv)) / 10n ** 18n
  return BigInt(ev.borrowedNAccrued) > maxBorrow
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
  /** See AaveSpecOptions.basisOrder. Default ['N', 'N-1']. */
  basisOrder?: readonly PriceBasis[]
}

export function morphoPositionSpec(
  events: readonly MorphoEventRecord[],
  opts: MorphoSpecOptions,
): PositionSpec {
  if (!events.length) throw new Error('morphoPositionSpec: no events')
  const evs = sortEvents(events)
  const order = opts.basisOrder ?? (['N', 'N-1'] as const)
  for (let i = 0; i < evs.length; i++) {
    for (const b of order) if (morphoLocatedAt(evs[i], b)) return morphoSpecAt(evs, i, b, opts)
  }
  return morphoSpecAt(evs, 0, 'N', opts)
}

/** The spec anchored at event `idx` (of the SORTED events), valued at `basis` oracle price. */
export function morphoSpecAt(
  evs: readonly MorphoEventRecord[],
  idx: number,
  basis: PriceBasis,
  opts: MorphoSpecOptions,
): PositionSpec {
  const first = evs[0]
  const anchor = evs[idx]
  const located = morphoLocatedAt(anchor, basis)
  const minute = minuteOf(anchor.ts, opts.startTs, opts.stepSeconds)
  const usd0 = opts.loanUsd(minute)
  const loanScale = 10 ** anchor.loanDecimals
  const collRaw = BigInt(anchor.positionNm1.collateral)
  const rawPrice = basis === 'N' ? anchor.priceN : anchor.priceNm1
  const price = rawPrice != null ? BigInt(rawPrice) : 0n
  const collUnits = price > 0n ? mulPrice(collRaw, price) / loanScale : null
  const debtUnits =
    anchor.borrowedNAccrued != null ? Number(BigInt(anchor.borrowedNAccrued)) / loanScale : null
  const line = Number(BigInt(anchor.lltv)) / 1e18
  const toUsd = (u: number | null) => (u == null || usd0 == null ? null : u * usd0)
  const collateral: SpecLeg[] = [
    {
      key: anchor.oracle,
      p0: Number(price),
      symbol: opts.collateralSymbol,
      amount: Number(collRaw) / 10 ** anchor.collateralDecimals,
      price0:
        price > 0n && usd0 != null
          ? (Number(price) / 1e36) * 10 ** (anchor.collateralDecimals - anchor.loanDecimals) * usd0
          : null,
      value0: collUnits ?? 0,
      usd: toUsd(collUnits),
      lt: line,
      token: anchor.collateralToken.toLowerCase(),
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
    pid: morphoPid(first.chain, first.market_id, first.borrower),
    protocol: 'morpho-blue',
    chain: first.chain,
    owner: first.borrower,
    market: first.market_id,
    marketLabel: 'blue',
    first: { block: first.block_number, ts: first.ts },
    located,
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
  if (!located) {
    spec.reason =
      `not located: Morpho liquidated it, but with its debt accrued to block N it is at or ` +
      `under its LLTV at both the block N-1 and the block N oracle price on every one of its ` +
      `${evs.length} event${evs.length > 1 ? 's' : ''}, so no breach can be placed in this data`
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
    eventIndex: idx,
    shifted: idx > 0,
    priceBasis: basis,
  }
  if (idx > 0) notes.push(`t0 shifted to event ${idx + 1} of ${evs.length}`)
  if (basis === 'N-1') {
    notes.push(
      'priced at block N-1: at the block-N oracle price it is not liquidatable, at N-1 (debt accrued to N) it is',
    )
  }
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
