/**
 * The M0 thresholds, as the builder wrote them (scripts/regime/build-m0-thresholds.mjs).
 *
 * Aggregate results over membrane-datasets price-history/eth-usd-1h.json (board rule N18
 * lets a public repo keep these; the prices stay private). Client-safe: a static JSON import.
 */

import generated from './m0Thresholds.generated.json'

export interface M0ThresholdsFile {
  move24hP95: number
  gapP99: number
  gapP999: number
  /** The quantile each rule reads, as a label ("p95"). The page's "1 in N" derives from it. */
  move24hQuantile: 'p95'
  gapQuantile: 'p99.9'
  n: { move24h: number; gap: number }
  period: {
    from: string
    to: string
    move24h: { from: string; to: string }
    gap: { from: string; to: string }
  }
  method: { quantile: string; move24h: string; gap: string; timestamps: string }
  source: { repo: string; commit: string; path: string; sha256: string }
  generatedAt: string
  generatedBy: string
}

export const M0_THRESHOLDS_FILE = generated as M0ThresholdsFile

/** What the rule reads. (B) uses the p99.9 band; p99 is on file for the owner's choice. */
export interface M0Thresholds {
  /** (A) |24h move| at or above this is a trigger. */
  move24hP95: number
  /** (B) |Chainlink / Coinbase − 1| at or above this is a trigger. */
  gapBand: number
}

export const M0_THRESHOLDS: M0Thresholds = {
  move24hP95: M0_THRESHOLDS_FILE.move24hP95,
  gapBand: M0_THRESHOLDS_FILE.gapP999,
}

/** "p95" → 0.95, "p99.9" → 0.999. */
export function quantileLevel(label: string): number {
  const m = /^p(\d+(?:\.\d+)?)$/.exec(label)
  const p = m ? Number(m[1]) / 100 : NaN
  if (!(p > 0 && p < 1)) throw new Error(`not a quantile label: ${label}`)
  return p
}

/**
 * The quantile as plain words' "1 in N": the share of readings at or past it. "p95" → 20
 * (1 in 20 readings), "p99.9" → 1,000. Readers never see the label itself.
 */
export function oneIn(label: string): number {
  return Math.round(1 / (1 - quantileLevel(label)))
}

export interface M0OneIn {
  /** (A) 1 in this many hourly 24h moves reached the threshold. */
  move24h: number
  /** (B) 1 in this many hourly readings had the gap. */
  gap: number
}

/** Each rule's "1 in N", from the generated file. */
export function m0OneIn(t: M0ThresholdsFile = M0_THRESHOLDS_FILE): M0OneIn {
  return { move24h: oneIn(t.move24hQuantile), gap: oneIn(t.gapQuantile) }
}
