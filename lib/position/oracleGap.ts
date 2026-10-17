/**
 * ORACLE HEALTH for a Morpho market a lender supplies: the market's oracle against the
 * market price, daily for 30 days and now. The same definition, and the same public source,
 * the curator-feed oracle-gap collector (feat/q27-oracle-gap, lib/curatorFeed/oracleGap.ts)
 * uses; its stored series lives in that collector's live store, which this page cannot
 * reach, so the page reads the source itself:
 *
 *   gap = oracle / market − 1
 *     oracle  the market oracle's price() at the block, loan token per whole collateral
 *             token, × DefiLlama's USD price of the loan token
 *     market  DefiLlama's USD price of the collateral token
 *
 * A point is UNOBSERVED (not 0, not dropped silently) when price() has no answer at that
 * block (D9), when either DefiLlama price is more than 6 hours from the block's time (D7),
 * or when DefiLlama rates its confidence under 0.9 (the collector's MIN_PRICE_CONFIDENCE).
 *
 * Past blocks are found by interpolating between the head and one anchor block 30 days of
 * slots back (both timestamps read), so a daily point's time is within a few minutes of
 * its block's. Past reads need an archive RPC; a failed one is an unobserved point.
 *
 * Pure: no I/O. components/PositionV0/useOracleGap.ts reads the chain and DefiLlama.
 */

/** DefiLlama's historical price chart: one request for both tokens, daily. */
export const LLAMA_COINS_CHART_URL = 'https://coins.llama.fi/chart/'
/** D7: a market price more than this far from the block's time leaves the point unobserved. */
export const MARKET_HOLD_SECONDS = 6 * 3600
/** The collector's cut: a DefiLlama price under this confidence is not a measurement. */
export const MIN_PRICE_CONFIDENCE = 0.9
/** Daily points, today included. */
export const GAP_DAYS = 30
/** Post-merge slot time: the anchor's first guess, corrected by its read timestamp. */
export const SLOT_SECONDS = 12

/** Whole loan tokens per whole collateral token from a Morpho oracle's 1e36-scaled price. */
export function oraclePriceOf(priceRaw: bigint, collateralDecimals: number, loanDecimals: number): number {
  const exp = 36 + loanDecimals - collateralDecimals
  // Split the scale so a 1e36 price keeps its precision as a float.
  const whole = priceRaw / 10n ** BigInt(Math.max(0, exp - 12))
  return Number(whole) / 10 ** Math.min(exp, 12)
}

export interface BlockAt {
  number: bigint
  ts: number
}

/**
 * The blocks for each day back from the head, 0 … days, by linear interpolation between the
 * head and an anchor (both with their real timestamps). Pure.
 */
export function dailyBlocks(head: BlockAt, anchor: BlockAt, days = GAP_DAYS): { day: number; ts: number; block: bigint }[] {
  const span = head.ts - anchor.ts
  const blocks = Number(head.number - anchor.number)
  const perSec = span > 0 ? blocks / span : 1 / SLOT_SECONDS
  return Array.from({ length: days + 1 }, (_, d) => {
    const ts = head.ts - d * 86_400
    const back = Math.round((head.ts - ts) * perSec)
    return { day: d, ts, block: head.number - BigInt(back) }
  }).reverse()
}

export interface LlamaPrice {
  timestamp: number
  price: number
}

/** DefiLlama's coins chart body → prices per lowercased address, with the coin's confidence. */
export function parseCoinsChart(body: unknown): Record<string, { confidence: number | null; prices: LlamaPrice[] }> {
  const b = body as { coins?: Record<string, { confidence?: number; prices?: { timestamp?: number; price?: number }[] }> }
  if (!b || typeof b.coins !== 'object' || b.coins === null) throw new Error('DefiLlama: no coins in the response')
  const out: Record<string, { confidence: number | null; prices: LlamaPrice[] }> = {}
  for (const [key, coin] of Object.entries(b.coins)) {
    const addr = key.split(':')[1]?.toLowerCase()
    if (!addr) continue
    out[addr] = {
      confidence: typeof coin.confidence === 'number' ? coin.confidence : null,
      prices: (coin.prices ?? [])
        .filter((p): p is LlamaPrice => typeof p.timestamp === 'number' && typeof p.price === 'number' && p.price > 0)
        .sort((a, c) => a.timestamp - c.timestamp),
    }
  }
  return out
}

/** The price nearest `ts`, or null when none is within MARKET_HOLD_SECONDS. */
export function priceNear(prices: LlamaPrice[], ts: number): number | null {
  let best: LlamaPrice | null = null
  for (const p of prices) if (!best || Math.abs(p.timestamp - ts) < Math.abs(best.timestamp - ts)) best = p
  return best && Math.abs(best.timestamp - ts) <= MARKET_HOLD_SECONDS ? best.price : null
}

export interface GapPoint {
  ts: number
  block: bigint
  /** oracle / market − 1; null = unobserved. */
  gap: number | null
  oracleUsd: number | null
  marketUsd: number | null
  /** Why a point is unobserved. */
  why?: 'no oracle answer' | 'no market price' | 'low confidence'
}

/** One point from its reads. Pure. */
export function gapPoint(input: {
  ts: number
  block: bigint
  /** Whole loan per whole collateral; null when price() had no answer. */
  oraclePrice: number | null
  loan: { confidence: number | null; prices: LlamaPrice[] } | undefined
  collateral: { confidence: number | null; prices: LlamaPrice[] } | undefined
}): GapPoint {
  const { ts, block } = input
  if (input.oraclePrice === null || !(input.oraclePrice > 0)) return { ts, block, gap: null, oracleUsd: null, marketUsd: null, why: 'no oracle answer' }
  const loanUsd = input.loan ? priceNear(input.loan.prices, ts) : null
  const marketUsd = input.collateral ? priceNear(input.collateral.prices, ts) : null
  if (loanUsd === null || marketUsd === null) return { ts, block, gap: null, oracleUsd: null, marketUsd, why: 'no market price' }
  const oracleUsd = input.oraclePrice * loanUsd
  const conf = Math.min(input.loan?.confidence ?? 1, input.collateral?.confidence ?? 1)
  if (conf < MIN_PRICE_CONFIDENCE) return { ts, block, gap: null, oracleUsd, marketUsd, why: 'low confidence' }
  return { ts, block, gap: oracleUsd / marketUsd - 1, oracleUsd, marketUsd }
}

/** "+0.12%" / "−3.4%": a signed gap, mono-friendly. */
export function fmtGap(g: number): string {
  const v = g * 100
  const a = Math.abs(v)
  const s = a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)
  return `${v >= 0 ? '+' : '−'}${s}%`
}

/** Observed points' range, for the line under the chart: "−0.08% to +0.21% over 29 of 31 days". */
export function gapSummary(points: GapPoint[]): string | null {
  const obs = points.filter((p) => p.gap !== null) as (GapPoint & { gap: number })[]
  if (obs.length === 0) return null
  const lo = Math.min(...obs.map((p) => p.gap))
  const hi = Math.max(...obs.map((p) => p.gap))
  return `${fmtGap(lo)} to ${fmtGap(hi)} over ${obs.length} of ${points.length} days observed`
}

/** Why points went unobserved, in words: "31 of 31 unobserved: 31 no market price". Null when all observed. */
export function unobservedLine(points: GapPoint[]): string | null {
  const un = points.filter((p) => p.gap === null)
  if (un.length === 0) return null
  const by = new Map<string, number>()
  for (const p of un) by.set(p.why ?? 'unobserved', (by.get(p.why ?? 'unobserved') ?? 0) + 1)
  return `${un.length} of ${points.length} days unobserved: ${[...by.entries()].map(([w, n]) => `${n} ${w}`).join(', ')}`
}
