/**
 * FINALIST STABILITY, from DeFiLlama's per-pool chart (`yields.llama.fi/chart/{pool}`).
 *
 *   σ90     population standard deviation of the daily APY over the last 90 days, in
 *           percentage points. Fails above 1.0pp (3 of 28 large pools fail on 2026-10-10).
 *   spike   current APY ÷ the 90-day median. Fails above 1.5 (bUSD0: 5.93 vs 3.35).
 *
 * The chart is called for finalists only, paced at ≤ 20 calls a minute with backoff on 429
 * (a burst of 80 calls gave 52 × 429; GitHub runners share IPs).
 */

import { THRESHOLDS, type ChartPoint, type Stability } from './types'

const DAY_MS = 86_400_000

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** `currentApyPct` is the pool's headline `apy` in percent, as DeFiLlama publishes it. */
export function stabilityFromChart(
  points: readonly ChartPoint[],
  currentApyPct: number,
): Stability {
  const dated = points
    .map((p) => ({ t: Date.parse(p.timestamp), apy: p.apy }))
    .filter(
      (p): p is { t: number; apy: number } =>
        Number.isFinite(p.t) && typeof p.apy === 'number' && Number.isFinite(p.apy),
    )
    .sort((a, b) => a.t - b.t)
  if (!dated.length)
    return {
      sigma90Pp: null,
      median90: null,
      spikeRatio: null,
      points: 0,
      ok: false,
      reason: 'no chart history',
    }
  const last = dated[dated.length - 1].t
  const window = dated.filter((p) => p.t > last - 90 * DAY_MS).map((p) => p.apy)
  if (window.length < THRESHOLDS.minCount) {
    return {
      sigma90Pp: null,
      median90: null,
      spikeRatio: null,
      points: window.length,
      ok: false,
      reason: `only ${window.length} chart points in 90 days`,
    }
  }
  const mean = window.reduce((s, x) => s + x, 0) / window.length
  const sigma = Math.sqrt(window.reduce((s, x) => s + (x - mean) ** 2, 0) / window.length)
  const med = median(window)
  const spike = med !== null && med > 0 ? currentApyPct / med : null
  const reasons: string[] = []
  if (sigma > THRESHOLDS.maxSigma90Pp)
    reasons.push(`90-day σ ${sigma.toFixed(2)}pp > ${THRESHOLDS.maxSigma90Pp}pp`)
  if (spike === null) reasons.push('90-day median APY is not positive')
  else if (spike > THRESHOLDS.maxSpikeRatio)
    reasons.push(`current APY is ${spike.toFixed(2)}× the 90-day median`)
  return {
    sigma90Pp: sigma,
    median90: med === null ? null : med / 100,
    spikeRatio: spike,
    points: window.length,
    ok: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : undefined,
  }
}
