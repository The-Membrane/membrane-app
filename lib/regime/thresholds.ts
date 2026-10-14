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
