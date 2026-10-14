/**
 * How old each source's value may be before it is STALE — the source's normal
 * cadence × 2. Pure and client-safe: the server reader (values.ts) and the UI
 * (useVenueAlertValues.ts) classify with the SAME constants, so the control never
 * says "fires on the first check" about a value the evaluator would skip.
 */

import { readingFrom, type Reading } from './evaluate'

/** Chainlink ETH/USD and BTC/USD on mainnet: 1h heartbeat (0.5% deviation). */
export const CHAINLINK_HEARTBEAT_S = 3600
export const PRICE_MAX_AGE_S = 2 * CHAINLINK_HEARTBEAT_S

/** The hourly recorder tick writes venue_snapshots. */
export const RECORDER_CADENCE_S = 3600
export const UTILIZATION_MAX_AGE_S = 2 * RECORDER_CADENCE_S

/** The net-APY route's live-read reuse window (pages/api/net-apy LATEST_MAX_AGE_S). */
export const NET_APY_REUSE_S = 120
export const APR_READ_MAX_AGE_S = 2 * NET_APY_REUSE_S
/** The finalized anchor is ~13–19 min old when read (lib/netApy/read.ts resolveAnchor). */
export const APR_ANCHOR_MAX_AGE_S = 2 * 19 * 60

/**
 * A source value before it is judged fresh or stale. Caches hold THIS, and every
 * use re-classifies it against the clock (a cached value ages like any other).
 * `readAtMs`/`readMaxAgeS` add a second age check for a read that is itself cached
 * upstream (the net-APY set).
 */
export type Raw =
  | { status: 'raw'; value: number; asOfMs: number; source: string; maxAgeS: number; readAtMs?: number; readMaxAgeS?: number }
  | { status: 'unavailable'; source: string; reason: string }

export const classify = (raw: Raw, nowMs: number): Reading => {
  if (raw.status === 'unavailable') return raw
  if (raw.readAtMs !== undefined && raw.readMaxAgeS !== undefined && nowMs - raw.readAtMs > raw.readMaxAgeS * 1000) {
    return Number.isFinite(raw.value) && Number.isFinite(raw.asOfMs)
      ? { status: 'stale', value: raw.value, asOf: new Date(raw.asOfMs).toISOString(), source: raw.source, maxAgeS: raw.readMaxAgeS }
      : { status: 'unavailable', source: raw.source, reason: 'no value' }
  }
  return readingFrom({ value: raw.value, asOfMs: raw.asOfMs, nowMs, maxAgeS: raw.maxAgeS, source: raw.source })
}
