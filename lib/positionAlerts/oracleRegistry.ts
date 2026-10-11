/**
 * Oracle-change events, as the oracle-change rule consumes them.
 *
 * STUB. The oracle registry and its change detector (feat/oracle-registry) are not on this
 * base, so this file only fixes the interface. A source that is not wired reports
 * `covered: false`, and the rule then lists itself as uncovered — a quiet oracle rule
 * must never read as "no oracle changes".
 */

import type { OracleChangeEvent, OracleChangeKind, Severity } from './types'

export interface OracleChangeSource {
  covered: boolean
  /** Events with from <= ts <= to that touch any of `assets`. */
  eventsBetween(from: number, to: number, assets: string[]): OracleChangeEvent[]
}

export const UNWIRED_ORACLE_SOURCE: OracleChangeSource = { covered: false, eventsBetween: () => [] }

/** A fixed event list — for tests and replays. */
export function staticOracleSource(events: OracleChangeEvent[]): OracleChangeSource {
  return {
    covered: true,
    eventsBetween: (from, to, assets) => {
      const held = new Set(assets)
      return events.filter((e) => e.ts >= from && e.ts <= to && held.has(e.asset))
    },
  }
}

/**
 * How bad each kind of change is for a borrower holding the asset. A replaced feed or a
 * frozen price can move or stall the liquidation line with no market move at all.
 */
export const ORACLE_CHANGE_SEVERITY: Record<OracleChangeKind, Severity> = {
  heartbeat_changed: 'watch',
  deviation_changed: 'watch',
  cap_changed: 'watch',
  feed_replaced: 'warn',
  source_changed: 'warn',
  paused: 'critical',
  price_frozen: 'critical',
}
