/**
 * LIQUIDITY-CAPPED SALES (owner ruling 2026-10-18).
 *
 * The census used to assume that every Membrane sale clears at the oracle price, instantly, in
 * any size. It cannot: a position holding 284k AAVE on Aave mainnet would have to sell ~190k AAVE
 * at once, while every liquidator on mainnet together moved 96.9k AAVE in the busiest 10 minutes
 * of 10-11 Oct. This module caps what the market can absorb.
 *
 * CAPACITY, per (chain, collateral token): the most tokens that left liquidated borrowers in any
 * rolling 10-minute window of 10-11 Oct, over every liquidation of the census on that chain —
 * Aave V3 and Morpho Blue together, every market. "Left the borrower" is the event's collateral:
 * Aave's liquidatedCollateralAmount PLUS the liquidation protocol fee sent to the treasury (both
 * leave the borrower's balance; aave-protocol-fee.jsonl.gz collateralSeizedTotalRaw), Morpho's
 * seized assets (no fee). The window runs on the census minute grid: minute buckets m-9 .. m, the
 * same grid every Membrane sale is booked on. Raw token amounts are summed as integers, so the
 * table is exact and deterministic. The liquidator-only figure (no fee) is reported beside it.
 *
 * A RATE, NOT A RESERVOIR. Capacity is tokens per rolling 10 minutes, available at ANY minute of
 * the window, not only in the crash minutes it was measured in.
 *
 * MULTIPLIER. The headline allows CAPACITY_MULTIPLIER = 0.98 x capacity (MULTIPLIER_BASIS); before
 * the third ruling it was 1.1 x: the 8-hour delay lets some
 * of the market's liquidity recover. It is a MODELLED assumption (†), named in the method, and
 * the census publishes 0.5x, 1.0x, 2.0x and unlimited beside it.
 *
 * SHARED LIMIT. Every Membrane sale of a token on a chain draws on ONE book, across positions, in
 * a deterministic order: minute, then pid (then the half's sub). A sale's fill is limited by what
 * is left in the trailing window: cap x multiplier minus everything already filled in minutes
 * m-9 .. m (this minute's earlier fills included). What a sale cannot fill stays pending in the
 * kernel (lib/wavefront/kernel.ts, PENDING ORDERS) and is offered again at later minutes.
 *
 * NO CAPACITY. A token with no observed liquidation on its chain has capacity 0: nothing is
 * invented for it. The census reports positions that would have to sell one apart and leaves them
 * out of the headline (scripts/oct10-coverage/census.ts).
 *
 * Only COLLATERAL sales are limited. Buying back the debt token (a stablecoin, mostly) is not.
 */

import { BTC_SYMBOLS, ETH_SYMBOLS } from './cluster'

/** The rolling window capacity is measured over and every fill is booked against. */
export const CAPACITY_WINDOW_MINUTES = 10
/**
 * The headline multiplier on measured capacity (modelled †, owner ruling 2026-10-18, third
 * round): UNIFORM 0.98x, the mean of the three measured class medians of depth recovery 8h
 * after five crashes (membrane-datasets q28/liquidity-recovery REPORT.md: ETH/LSTs 0.77, BTC
 * wrappers 0.99, the long tail 1.17; (0.77 + 0.99 + 1.17) / 3 = 0.9767, rounded to 0.98).
 * The previous headline, 1.1x, is a published sensitivity.
 */
export const CAPACITY_MULTIPLIER = 0.98
/** The first-round headline, kept as a sensitivity row. */
export const PREVIOUS_CAPACITY_MULTIPLIER = 1.1

/**
 * THE RESEARCH CLASS TABLE (membrane-datasets q28/liquidity-recovery REPORT.md), one map for
 * every per-class run: `recommended` is the research's recommended share of the measured
 * 10-minute capacity (0.70 / 0.55 / 0.75; the owner rejected it as too low for the headline),
 * `median` the measured median depth recovery at +8h (0.77 / 0.99 / 1.17). Both are
 * SENSITIVITIES. The class lists are lib/wavefront/cluster.ts's ETH and BTC groups, so the
 * census clusters and this table cannot disagree. Every other symbol is 'other'.
 */
export const RESEARCH_LIQUIDITY_CLASSES: readonly {
  cls: 'eth' | 'btc' | 'other'
  label: string
  recommended: number
  median: number
  /** null: every symbol not in another class. */
  symbols: readonly string[] | null
}[] = [
  {
    cls: 'eth',
    label: 'ETH and its LSTs / LRTs',
    recommended: 0.7,
    median: 0.77,
    symbols: ETH_SYMBOLS,
  },
  { cls: 'btc', label: 'BTC wrappers', recommended: 0.55, median: 0.99, symbols: BTC_SYMBOLS },
  { cls: 'other', label: 'every other collateral', recommended: 0.75, median: 1.17, symbols: null },
]
/** The research "flow reading": the literal absorbed-flow share, the same for every class. */
export const RESEARCH_FLOW_READING_MULTIPLIER = 0.2

/** The research class of a collateral symbol. */
export function researchClassOf(symbol: string) {
  for (const c of RESEARCH_LIQUIDITY_CLASSES) if (c.symbols?.includes(symbol)) return c
  return RESEARCH_LIQUIDITY_CLASSES.find((c) => c.symbols === null)!
}

/** The research's RECOMMENDED class multiplier of a collateral symbol. */
export function researchClassMultiplier(symbol: string): number {
  return researchClassOf(symbol).recommended
}

/** The research's measured MEDIAN (+8h) class multiplier of a collateral symbol. */
export function researchMedianMultiplier(symbol: string): number {
  return researchClassOf(symbol).median
}

/** The headline multiplier's basis, as every surface states it (†). */
export const MULTIPLIER_BASIS =
  'modelled: the average measured depth recovery 8h after five crashes (membrane-datasets liquidity-recovery/REPORT.md)'

/** A multiplier for every book key, or one number for all of them. */
export type CapacityMultiplier = number | ((key: string) => number)

/** The book key of a collateral token: `${chain}:${token address, lower case}`. */
export const liqKeyOf = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`

/** One liquidation's collateral, as the capacity table reads it. */
export interface CapacityEvent {
  chain: string
  token: string
  symbol: string
  decimals: number
  /** Grid minute of the event. */
  minute: number
  /** Tokens the liquidator received (raw). Aave: liquidatedCollateralAmount; Morpho: seized. */
  liquidatorRaw: bigint
  /** Tokens that left the borrower (raw). Aave: + the protocol fee; Morpho: == liquidatorRaw. */
  borrowerRaw: bigint
  /** USD of borrowerRaw at the event's own block prices; null when unpriced. */
  usd: number | null
}

export interface CapacityEntry {
  key: string
  chain: string
  token: string
  symbol: string
  decimals: number
  events: number
  /** Every token that left borrowers over the whole window. */
  totalTokens: number
  /** THE CAPACITY: the most tokens that left borrowers in any rolling 10 minutes. */
  capacityTokens: number
  /** The liquidators' part of the same peak window (the protocol fee left out). */
  liquidatorTokensAtPeak: number
  /** The most tokens liquidators alone received in any rolling 10 minutes (no fee). */
  liquidatorCapacityTokens: number
  /** Last minute of the peak window (the earliest peak on a tie). */
  peakEndMinute: number
  /** USD of the events in the peak window at their own prices; null if any is unpriced. */
  peakUsd: number | null
}

const toUnits = (raw: bigint, decimals: number) => {
  const s = 10n ** BigInt(decimals)
  return Number(raw / s) + Number(raw % s) / 10 ** decimals
}

/** The capacity table: one entry per (chain, token) with any liquidation, sorted by key. */
export function computeCapacity(
  events: readonly CapacityEvent[],
  minutes: number,
): CapacityEntry[] {
  interface Acc {
    chain: string
    token: string
    symbol: string
    decimals: number
    events: number
    borrower: bigint[]
    liquidator: bigint[]
    usd: (number | null)[]
  }
  const by = new Map<string, Acc>()
  for (const e of events) {
    if (!(e.minute >= 0 && e.minute < minutes)) {
      throw new Error(
        `capacity: ${e.chain} ${e.symbol} event at minute ${e.minute}, outside the grid`,
      )
    }
    const key = liqKeyOf(e.chain, e.token)
    let a = by.get(key)
    if (!a) {
      a = {
        chain: e.chain,
        token: e.token.toLowerCase(),
        symbol: e.symbol,
        decimals: e.decimals,
        events: 0,
        borrower: new Array<bigint>(minutes).fill(0n),
        liquidator: new Array<bigint>(minutes).fill(0n),
        usd: new Array<number | null>(minutes).fill(0),
      }
      by.set(key, a)
    }
    if (a.decimals !== e.decimals) throw new Error(`capacity: ${key} has two decimals`)
    a.events++
    a.borrower[e.minute] += e.borrowerRaw
    a.liquidator[e.minute] += e.liquidatorRaw
    const u = a.usd[e.minute]
    a.usd[e.minute] = u == null || e.usd == null ? null : u + e.usd
  }
  const W = CAPACITY_WINDOW_MINUTES
  const rollMax = (xs: bigint[]): { max: bigint; end: number } => {
    let s = 0n
    let max = 0n
    let end = 0
    for (let i = 0; i < xs.length; i++) {
      s += xs[i]
      if (i >= W) s -= xs[i - W]
      if (s > max) {
        max = s
        end = i
      }
    }
    return { max, end }
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, a]) => {
      const peak = rollMax(a.borrower)
      const from = Math.max(0, peak.end - W + 1)
      let liqAtPeak = 0n
      let usd: number | null = 0
      for (let i = from; i <= peak.end; i++) {
        liqAtPeak += a.liquidator[i]
        const u = a.usd[i]
        usd = usd == null || u == null ? null : usd + u
      }
      return {
        key,
        chain: a.chain,
        token: a.token,
        symbol: a.symbol,
        decimals: a.decimals,
        events: a.events,
        totalTokens: toUnits(
          a.borrower.reduce((x, y) => x + y, 0n),
          a.decimals,
        ),
        capacityTokens: toUnits(peak.max, a.decimals),
        liquidatorTokensAtPeak: toUnits(liqAtPeak, a.decimals),
        liquidatorCapacityTokens: toUnits(rollMax(a.liquidator).max, a.decimals),
        peakEndMinute: peak.end,
        peakUsd: usd == null ? null : Math.round(usd * 100) / 100,
      }
    })
}

/** What the kernel asks the market for: tokens of each collateral leg at a minute. */
export interface KernelLiquidity {
  /**
   * Offer `legs[k].tokens` of each leg at `minute`; returns the tokens filled per leg
   * (0 <= filled <= offered) and books them. Called in the census's deterministic order.
   */
  take(minute: number, legs: readonly { liqKey: string; tokens: number }[]): number[]
}

/**
 * The shared book: one trailing 10-minute window per (chain, token), cap x multiplier tokens
 * each. `multiplier` Infinity is the unlimited run: every offer fills (nothing is booked), and a
 * token with capacity 0 is still reported by `hasCapacity`, so the unlimited run is walked on the
 * same positions as the capped ones.
 */
export class LiquidityBook implements KernelLiquidity {
  private readonly fills = new Map<string, Float64Array>()
  /** Every offer that did not fill completely (count), per key. */
  readonly shortOffers = new Map<string, number>()
  /** Tokens filled per key over the run. */
  readonly filled = new Map<string, number>()

  constructor(
    private readonly capacity: ReadonlyMap<string, number>,
    readonly multiplier: CapacityMultiplier,
    private readonly minutes: number,
  ) {
    if (typeof multiplier === 'number' && !(multiplier > 0)) {
      throw new Error(`LiquidityBook: multiplier ${multiplier}`)
    }
  }

  private multOf(key: string): number {
    const m = typeof this.multiplier === 'number' ? this.multiplier : this.multiplier(key)
    if (!(m > 0)) throw new Error(`LiquidityBook: multiplier ${m} for ${key}`)
    return m
  }

  hasCapacity(key: string): boolean {
    return (this.capacity.get(key) ?? 0) > 0
  }

  /** Tokens per rolling window this run allows for `key` (Infinity when unlimited). */
  limitOf(key: string): number {
    const c = this.capacity.get(key) ?? 0
    if (!(c > 0)) return 0
    const m = this.multOf(key)
    return m === Infinity ? Infinity : c * m
  }

  /** What is left for `key` in the window ending at `minute`. */
  available(key: string, minute: number): number {
    const lim = this.limitOf(key)
    if (lim === Infinity || lim === 0) return lim
    const f = this.fills.get(key)
    if (!f) return lim
    let used = 0
    for (let i = Math.max(0, minute - CAPACITY_WINDOW_MINUTES + 1); i <= minute; i++) used += f[i]
    return Math.max(0, lim - used)
  }

  /** The most tokens filled for `key` in any rolling window of the run (0 when unlimited). */
  peakWindow(key: string): number {
    const f = this.fills.get(key)
    if (!f) return 0
    let s = 0
    let max = 0
    for (let i = 0; i < f.length; i++) {
      s += f[i]
      if (i >= CAPACITY_WINDOW_MINUTES) s -= f[i - CAPACITY_WINDOW_MINUTES]
      if (s > max) max = s
    }
    return max
  }

  take(minute: number, legs: readonly { liqKey: string; tokens: number }[]): number[] {
    if (!(minute >= 0 && minute < this.minutes)) {
      throw new Error(`LiquidityBook: minute ${minute} outside the grid`)
    }
    return legs.map(({ liqKey, tokens }) => {
      if (!(tokens > 0)) return 0
      const avail = this.available(liqKey, minute)
      const got = avail >= tokens ? tokens : avail
      if (got < tokens) this.shortOffers.set(liqKey, (this.shortOffers.get(liqKey) ?? 0) + 1)
      if (got > 0) {
        this.filled.set(liqKey, (this.filled.get(liqKey) ?? 0) + got)
        if (this.limitOf(liqKey) !== Infinity) {
          let f = this.fills.get(liqKey)
          if (!f) {
            f = new Float64Array(this.minutes)
            this.fills.set(liqKey, f)
          }
          f[minute] += got
        }
      }
      return got
    })
  }
}
