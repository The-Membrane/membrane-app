/**
 * Oracle-change events, as the oracle-change rule consumes them.
 *
 * Two producers:
 *  - fromRegistryChange adapts one change of the oracle registry (feat/oracle-registry,
 *    lib/oracleRegistry/changes.ts ChangeEvent, plus the 'access' / 'upgrade' governance-log
 *    kinds of its ChangeItem). The shape is copied structurally, not imported: that branch is
 *    not on this base. Severity is direction-aware — a change that can LOWER the collateral's
 *    oracle price (a raised PT discount, a lowered CAPO cap) or loosen its freshness is worse
 *    than its opposite, and a pure tightening is not a message at all.
 *  - detectPriceFreeze reads an oracle path against the market and reports a 'price_frozen'
 *    event when the oracle stops moving while the market does (E2: sdeUSD, Nov 2025).
 *
 * A source that is not wired reports `covered: false`, and the rule then lists itself as
 * uncovered — a quiet oracle rule must never read as "no oracle changes".
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
 * Default severity of each kind for a borrower holding the asset, when the adapter cannot
 * tell the direction. A replaced feed or a frozen price can move or stall the liquidation
 * line with no market move at all.
 */
export const ORACLE_CHANGE_SEVERITY: Record<OracleChangeKind, Severity> = {
  heartbeat_changed: 'watch',
  deviation_changed: 'watch',
  twap_changed: 'watch',
  cap_changed: 'watch',
  discount_changed: 'watch',
  quorum_changed: 'watch',
  feed_replaced: 'warn',
  source_changed: 'warn',
  upgrade: 'warn',
  paused: 'critical',
  price_frozen: 'critical',
}

// ------------------------------------------------------------------ registry adapter

/** The registry's change kinds (lib/oracleRegistry/changes.ts ChangeKind and ChangeItem.kind). */
export type RegistryChangeKind =
  | 'aggregator'
  | 'heartbeat'
  | 'deviation_threshold'
  | 'twap_window'
  | 'cap'
  | 'discount'
  | 'market_source'
  | 'wiring'
  | 'quorum'
  | 'update_model'
  | 'entry_added'
  | 'entry_removed'
  | 'other'
  | 'access'
  | 'upgrade'

type RegistryValue = string | number | boolean | null | undefined

/** One registry change, structurally: a ChangeEvent (diff) or a governance-log ChangeItem. */
export interface RegistryChangeLike {
  kind: RegistryChangeKind
  /** Registry entry id, e.g. 'pt-srusde-22oct2026.aave.linear-discount'. */
  entryId: string
  param?: string
  from?: RegistryValue
  to?: RegistryValue
  /** When the change is known to have happened (ChangeEvent.toTs, ChangeItem.ts). */
  ts: number
}

const num = (v: RegistryValue): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** +1 when the value rose, −1 when it fell, 0 when equal, null when not comparable. */
function direction(from: RegistryValue, to: RegistryValue): -1 | 0 | 1 | null {
  const a = num(from)
  const b = num(to)
  if (a === null || b === null) return null
  return b > a ? 1 : b < a ? -1 : 0
}

/** Kind and severity of one registry change for a borrower; null = not worth a message. */
export function classifyRegistryChange(
  c: Pick<RegistryChangeLike, 'kind' | 'from' | 'to'>,
): { kind: OracleChangeKind; severity: Severity } | null {
  const d = direction(c.from, c.to)
  switch (c.kind) {
    case 'aggregator':
      return { kind: 'feed_replaced', severity: 'warn' }
    case 'market_source':
    case 'wiring':
    case 'update_model':
    case 'entry_removed':
      return { kind: 'source_changed', severity: 'warn' }
    case 'entry_added':
      return { kind: 'source_changed', severity: 'watch' }
    case 'heartbeat':
      // A longer heartbeat lets the price go staler; a shorter one only helps.
      return d === -1 ? null : { kind: 'heartbeat_changed', severity: 'watch' }
    case 'deviation_threshold':
      return d === -1 ? null : { kind: 'deviation_changed', severity: 'watch' }
    case 'twap_window':
      // Longer lags the market, shorter is easier to push: both are worth knowing.
      return { kind: 'twap_changed', severity: 'watch' }
    case 'cap':
      // A lower cap can pin the oracle below the market and lower health factor at once.
      return { kind: 'cap_changed', severity: d === -1 ? 'warn' : 'watch' }
    case 'discount':
      // A higher PT discount marks the collateral down at once.
      return { kind: 'discount_changed', severity: d === 1 ? 'warn' : 'watch' }
    case 'quorum':
      // Fewer signers needed is weaker; more is stronger.
      return d === 1 ? null : { kind: 'quorum_changed', severity: d === -1 ? 'warn' : 'watch' }
    case 'upgrade':
      return { kind: 'upgrade', severity: 'warn' }
    case 'access':
      // Read access granted or revoked (e.g. Chronicle toll): no effect on the price.
      return null
    case 'other':
      return { kind: 'source_changed', severity: 'watch' }
  }
}

/** One registry change as an alert event for `asset`, or null when it is not worth one. */
export function fromRegistryChange(
  c: RegistryChangeLike,
  asset: string,
  source = 'oracle-registry',
): OracleChangeEvent | null {
  const k = classifyRegistryChange(c)
  if (!k) return null
  const what = c.param ? `${c.param}: ${String(c.from ?? '—')} → ${String(c.to ?? '—')}` : c.kind
  return {
    asset,
    oracle: c.entryId,
    kind: k.kind,
    ts: c.ts,
    detail: `${c.entryId} ${what}`,
    source,
    severity: k.severity,
  }
}

// ------------------------------------------------------------------ frozen price

export interface FreezeOptions {
  /** The oracle must not move for at least this long… */
  minFrozenS: number
  /** …while the market moves at least this far from the frozen value (bps). */
  minMarketMoveBps: number
}

export const DEFAULT_FREEZE: FreezeOptions = { minFrozenS: 6 * 3600, minMarketMoveBps: 200 }

/**
 * 'price_frozen' events from an oracle path read against the market: one event at the first
 * sample where the oracle has held one value for minFrozenS and the market sits at least
 * minMarketMoveBps away from it. A new event needs the oracle to move again first.
 */
export function detectPriceFreeze(
  path: ReadonlyArray<{ ts: number; oraclePx: number | null; marketPx: number | null }>,
  asset: string,
  oracle: string,
  opts: FreezeOptions = DEFAULT_FREEZE,
): OracleChangeEvent[] {
  const out: OracleChangeEvent[] = []
  let since: number | null = null
  let value: number | null = null
  let reported = false
  for (const p of path) {
    if (p.oraclePx === null || !Number.isFinite(p.oraclePx)) continue
    if (value === null || Math.abs(p.oraclePx - value) > Math.abs(value) * 1e-9) {
      value = p.oraclePx
      since = p.ts
      reported = false
      continue
    }
    if (reported || since === null || p.marketPx === null || !(value > 0)) continue
    const moveBps = Math.abs(1 - p.marketPx / value) * 1e4
    if (p.ts - since >= opts.minFrozenS && moveBps >= opts.minMarketMoveBps) {
      out.push({
        asset,
        oracle,
        kind: 'price_frozen',
        ts: p.ts,
        detail: `oracle held ${value} for ${((p.ts - since) / 3600).toFixed(1)}h while the market moved ${moveBps.toFixed(0)} bps`,
        source: 'freeze-detector',
      })
      reported = true
    }
  }
  return out
}
