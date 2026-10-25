/**
 * SIZE-SKEW GHOST LINES (framework: "ghost lines at 10x / 100x size").
 *
 * The skew is exit depth: a bigger position sells into the same pool, so each dollar
 * exits for less. That is only drawable where a MEASURED depth for the scenario exists.
 * In the Oct 10 2025 dataset that is exactly one asset: USDe, from the Curve USDe/USDC
 * pool (public/data/oct10-2025/protocols.json `usdeExitLiquidity`):
 *   - a 1 USDe clip quoted at best `min_price_1_usde` at the worst minute,
 *   - a 1,000,000 USDe clip realised `min_avg_price_1m_clip` at that same minute,
 *   - the pool's USDC side bottomed at `min_usdc_reserve`.
 *
 * Two measured points, no curve. So:
 *   - inside the measured clip (exit ≤ 1,000,000 USDe) the exit cost is interpolated
 *     linearly between the two points and labelled modelled;
 *   - past the clip but under the pool's USDC low, nothing was measured: no line;
 *   - past the pool's USDC low, the exit is larger than the pool itself: no line, and
 *     the reader is told so (that IS the skew at that size).
 * Assets with no depth series get no line and are named. Nothing is extrapolated.
 *
 * The ghost line is drawn PER 1× OF SIZE (equity ÷ k), so it shares the chart's axis
 * and the gap between it and the 1× line is the exit cost alone. The cost is priced at
 * the worst measured minute for the whole replay — a bound, and labelled as one.
 */

import type { Comparison, ProtocolPosition } from '@/lib/position-sim'

export interface UsdeExitLiquidity {
  min_price_1_usde: { price: number; minute_ts: number }
  min_avg_price_1m_clip: { price: number; minute_ts: number }
  min_usdc_reserve: number
}

/** The exit-depth registry for a scenario. Keyed by collateral symbol. */
export interface ExitDepth {
  symbol: string
  /** Marginal price for a tiny clip at the worst minute. */
  marginalPrice: number
  /** Measured clip size, in tokens, and its realised average price. */
  clipTokens: number
  clipAvgPrice: number
  /** The pool's quote-side low. An exit bigger than this has no pool to exit into. */
  poolQuoteLowUsd: number
  worstMinuteTs: number
  source: string
}

/** The measured 1,000,000-USDe clip (scripts/build-oct10-dataset.ts, manifest caveat). */
export const USDE_CLIP_TOKENS = 1_000_000

export function depthRegistry(usde: UsdeExitLiquidity | null | undefined): Record<string, ExitDepth> {
  if (!usde?.min_price_1_usde || !usde.min_avg_price_1m_clip || !Number.isFinite(usde.min_usdc_reserve)) return {}
  return {
    USDe: {
      symbol: 'USDe',
      marginalPrice: usde.min_price_1_usde.price,
      clipTokens: USDE_CLIP_TOKENS,
      clipAvgPrice: usde.min_avg_price_1m_clip.price,
      poolQuoteLowUsd: usde.min_usdc_reserve,
      worstMinuteTs: usde.min_avg_price_1m_clip.minute_ts,
      source: 'Curve USDe/USDC pool, 10 Oct 2025 (protocols.json usdeExitLiquidity)',
    },
  }
}

/** Exit cost as a share of value for `tokens` at the worst minute, or null if unmeasured. */
export function exitCostShare(d: ExitDepth, tokens: number): number | null {
  if (tokens <= 0) return 0
  if (tokens > d.clipTokens) return null
  const clipCost = 1 - d.clipAvgPrice / d.marginalPrice
  return Math.max(0, clipCost * (tokens / d.clipTokens))
}

export type SkewStatus = 'drawn' | 'beyond-clip' | 'beyond-pool'

export interface SkewLeg {
  symbol: string
  status: SkewStatus | 'no-depth'
  /** Tokens this leg would exit at k× size. */
  tokens: number
  exitUsd: number
  costShare: number | null
}

export interface SkewLine {
  multiple: number
  /** True when every collateral leg with value has a drawable cost. */
  drawable: boolean
  legs: SkewLeg[]
  /** Per-1× equity series, venue and Membrane, net of the exit cost. Empty if not drawable. */
  venue: (number | null)[]
  membrane: (number | null)[]
  /** End gap, per 1×, between this line and the 1× line, on the Membrane run. */
  endCostPer1xUsd: number | null
}

export const SKEW_MULTIPLES = [10, 100] as const

export function skewLines(
  cmp: Comparison,
  registry: Record<string, ExitDepth>,
  multiples: readonly number[] = SKEW_MULTIPLES,
): SkewLine[] {
  return multiples.map((k) => skewLine(cmp, registry, k))
}

function skewLine(cmp: Comparison, registry: Record<string, ExitDepth>, k: number): SkewLine {
  const pos: ProtocolPosition = cmp.position
  const legs: SkewLeg[] = pos.collateral
    .filter((c) => c.valueUsd > 0)
    .map((c) => {
      const d = registry[c.symbol]
      const tokens = c.amount * k
      const exitUsd = c.valueUsd * k
      if (!d) return { symbol: c.symbol, status: 'no-depth', tokens, exitUsd, costShare: null }
      if (exitUsd > d.poolQuoteLowUsd) return { symbol: c.symbol, status: 'beyond-pool', tokens, exitUsd, costShare: null }
      const share = exitCostShare(d, tokens)
      if (share === null) return { symbol: c.symbol, status: 'beyond-clip', tokens, exitUsd, costShare: null }
      return { symbol: c.symbol, status: 'drawn', tokens, exitUsd, costShare: share }
    })
  const drawable = legs.length > 0 && legs.every((l) => l.status === 'drawn')
  if (!drawable) return { multiple: k, drawable, legs, venue: [], membrane: [], endCostPer1xUsd: null }

  // Cost per 1× = Σ share_leg × the leg's share of collateral value × collateral now.
  // Collateral now is backed out of the run: equity + debt; the share of each leg is
  // held at its start weight (single-asset positions, the only drawable case today,
  // make that exact).
  const total = pos.collateral.reduce((a, c) => a + c.valueUsd, 0)
  const weightedShare = legs.reduce((a, l) => {
    const leg = pos.collateral.find((c) => c.symbol === l.symbol)
    return a + (l.costShare ?? 0) * ((leg?.valueUsd ?? 0) / (total || 1))
  }, 0)
  // Collateral value per minute is backed out of the run: equity = c + deployed − d and
  // ltv = d / c, so c = (equity − deployed) / (1 − ltv). Exact with no deployment (every
  // drawable case today); with one, Membrane's deployed balance is taken at its end
  // value, which can only overstate the cost.
  const net = (run: typeof cmp.source) =>
    run.equitySeries.map((v, i) => {
      const ltv = run.ltvSeries[i]
      if (v === null || ltv === null || ltv === undefined || ltv >= 1) return null
      const coll = (v - run.endDeployedUsd) / (1 - ltv)
      return v - weightedShare * Math.max(0, coll)
    })
  return {
    multiple: k,
    drawable,
    legs,
    venue: net(cmp.source),
    membrane: net(cmp.membrane),
    endCostPer1xUsd: weightedShare * cmp.membrane.endCollateralUsd,
  }
}

/** One line per multiple saying what was and was not drawn, and why. */
export function skewNote(line: SkewLine, registry: Record<string, ExitDepth>): string {
  const k = `${line.multiple}×`
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  if (line.drawable) {
    return `${k} line drawn: exit cost from the measured ${registry[line.legs[0].symbol]?.source ?? 'depth'}, priced at the worst minute (modelled bound).`
  }
  const parts = line.legs.map((l) => {
    const d = registry[l.symbol]
    if (l.status === 'no-depth') return `no exit-depth series for ${l.symbol} in this scenario`
    if (l.status === 'beyond-pool' && d)
      return `${usd(l.exitUsd)} of ${l.symbol} is more than the ${usd(d.poolQuoteLowUsd)} the pool held at its low`
    if (l.status === 'beyond-clip' && d)
      return `${Math.round(l.tokens).toLocaleString('en-US')} ${l.symbol} is past the measured ${d.clipTokens.toLocaleString('en-US')} clip`
    return `${l.symbol} drawable`
  })
  return `${k}: no line — ${parts.join('; ')}.`
}
