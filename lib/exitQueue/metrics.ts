import {
  label,
  type BlockAnchor,
  type Label,
  type ParamChange,
  type QueueRequest,
  type QueueSnapshot,
  type VenueKey,
  type VenueLedger,
} from './types'
import { cooldownSeconds, type VenueDef } from './venues'

/**
 * Derived exit-queue metrics per venue at one block anchor.
 *
 * Durations use the Kaplan–Meier estimator so still-open requests count as
 * "waited at least this long" instead of being dropped. Dropping them is the usual
 * mistake: while a queue builds, the completed requests are the fast ones, and a
 * completed-only median says the queue is quicker exactly when it is slowest.
 *
 * Windows are request cohorts: requests made in the trailing window, followed to
 * the anchor. Every duration here is MEASURED HISTORY, NOT A FORECAST.
 */

export const WINDOWS_DAYS = [7, 30, 90] as const

export interface DurationStats {
  /** Requests in the cohort. */
  n: number
  /** Cohort members whose outcome was observed by the anchor. */
  completed: number
  /** Still open at the anchor (or cancelled): their wait is a lower bound. */
  censored: number
  p50S: number | null
  p90S: number | null
  /**
   * When p90 is not reached: the longest wait among unresolved requests (the oldest open
   * one). The unreached quantile is at least this (Kaplan–Meier: no event after it).
   */
  atLeastS: number | null
}

export interface WindowMetrics {
  windowDays: number
  /** complete = ledger covers the whole window; partial = window truncated to the ledger's start. */
  coverage: 'complete' | 'partial' | 'none'
  requestToFinalize: DurationStats
  finalizeToClaim: DurationStats
  requestToClaim: DurationStats
  label: Label
}

export interface VenueExitMetrics {
  venue: VenueKey
  label: string
  unit: { symbol: string; decimals: number }
  mechanism: string
  anchor: BlockAnchor | null
  queueNow: {
    amount: string | null
    amountUnits: number | null
    count: number | null
    source: 'onchain' | 'ledger' | 'beacon_api' | null
    /** The ledger sum misses requests older than its coverage: show it as "at least". */
    amountIsLowerBound: boolean
    /**
     * Ledger open requests vs the contract's own pending count, where it has one.
     * `ledger_short`: requests older than the ledger (or missed logs);
     * `ledger_over`: finalizations the ledger missed. Either way, check the recorder.
     */
    reconciliation: {
      ledgerOpen: number
      onchain: number
      status: 'match' | 'ledger_short' | 'ledger_over'
    } | null
    label: Label
  }
  /** Ledger requests not yet claimable at the anchor. */
  open: { count: number; oldestAgeS: number | null }
  windows: WindowMetrics[]
  /** Beacon only: seconds from the anchor to the last scheduled exit epoch. */
  scheduleWaitS: number | null
  advertisedCooldownS: number | null
  /** The cooldown is the wait (sUSDe), not just a floor (Kelp). See VenueDef.cooldown. */
  advertisedCooldownSetsWait: boolean
  lastChange: ParamChange | null
  changes: ParamChange[]
  ledgerHealth: {
    requests: number
    unmatchedClaims: number
    undecodedLogs: number
    /** Historical reads that failed or came back out of order. */
    readAnomalies: number
    /** Request ids missing from a sequential-id venue (logs a relay did not return). */
    idGaps: number
    /** Finalization times known only as an upper bound (`bracket`). */
    bracketedFinalizations: number
    coverageFromTs: number | null
  }
  /** Recall Coverage Dataset `venue_state` columns this layer owns. */
  venueState: {
    venue_id: VenueKey
    block: number
    ts: number
    queue_depth: number | null
    queue_depth_count: number | null
    cooldown_s: number | null
    proxy: 'none'
  } | null
}

export type Sample = { t: number; observed: boolean }

/**
 * Kaplan–Meier quantiles. All samples at one time are grouped, so events at a tied
 * time count before the censorings there (the usual convention).
 */
export function kmQuantiles(samples: Sample[], qs: number[]): Array<number | null> {
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  let atRisk = sorted.length
  let survival = 1
  const out: Array<number | null> = qs.map(() => null)
  let i = 0
  while (i < sorted.length) {
    const t = sorted[i].t
    let events = 0
    let total = 0
    while (i < sorted.length && sorted[i].t === t) {
      if (sorted[i].observed) events += 1
      total += 1
      i += 1
    }
    if (events > 0) {
      survival *= 1 - events / atRisk
      qs.forEach((q, k) => {
        if (out[k] == null && survival <= 1 - q + 1e-12) out[k] = t
      })
    }
    atRisk -= total
  }
  return out
}

export function durationStats(samples: Sample[]): DurationStats {
  const [p50S, p90S] = kmQuantiles(samples, [0.5, 0.9])
  const completed = samples.filter((s) => s.observed).length
  const open = samples.filter((s) => !s.observed)
  return {
    n: samples.length,
    completed,
    censored: open.length,
    p50S,
    p90S,
    atLeastS: p90S == null && open.length ? Math.max(...open.map((s) => s.t)) : null,
  }
}

const reached = (ts: number | null | undefined, anchor: BlockAnchor) =>
  ts != null && ts <= anchor.ts

function requestSample(r: QueueRequest, end: 'finalize' | 'claim', anchor: BlockAnchor): Sample {
  const done = end === 'finalize' ? r.finalizedTs : r.claimedTs
  if (reached(done, anchor)) return { t: done! - r.requestedTs, observed: true }
  if (reached(r.cancelledTs, anchor)) return { t: r.cancelledTs! - r.requestedTs, observed: false }
  return { t: anchor.ts - r.requestedTs, observed: false }
}

export function windowMetrics(
  ledger: VenueLedger,
  anchor: BlockAnchor,
  windowDays: number,
): WindowMetrics {
  const measured = label('measured_history')
  const empty = durationStats([])
  if (!ledger.coverage || ledger.coverage.fromTs >= anchor.ts)
    return {
      windowDays,
      coverage: 'none',
      requestToFinalize: empty,
      finalizeToClaim: empty,
      requestToClaim: empty,
      label: measured,
    }
  const start = anchor.ts - windowDays * 86_400
  const coverage = ledger.coverage.fromTs <= start ? 'complete' : 'partial'
  const from = Math.max(start, ledger.coverage.fromTs)
  const requests = Object.values(ledger.requests).filter((r) => r.requestedBlock <= anchor.block)
  const cohort = requests.filter((r) => r.requestedTs >= from && r.requestedTs <= anchor.ts)
  const finalizedCohort = requests.filter(
    (r) => !r.manual && reached(r.finalizedTs, anchor) && r.finalizedTs! >= from,
  )
  return {
    windowDays,
    coverage,
    requestToFinalize: durationStats(cohort.map((r) => requestSample(r, 'finalize', anchor))),
    finalizeToClaim: durationStats(
      finalizedCohort.map((r): Sample => {
        if (reached(r.claimedTs, anchor))
          return { t: r.claimedTs! - r.finalizedTs!, observed: true }
        if (reached(r.cancelledTs, anchor))
          return { t: r.cancelledTs! - r.finalizedTs!, observed: false }
        return { t: anchor.ts - r.finalizedTs!, observed: false }
      }),
    ),
    requestToClaim: durationStats(
      cohort.filter((r) => !r.manual).map((r) => requestSample(r, 'claim', anchor)),
    ),
    label: measured,
  }
}

/** Plain quantile (nearest-rank) for the beacon's schedule readings. */
export function nearestRank(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/**
 * Beacon windows: the distribution of schedule-wait readings taken in the window. That is
 * history (measured_history); only the reading at the anchor is chain_schedule.
 */
function beaconWindow(ledger: VenueLedger, anchor: BlockAnchor, windowDays: number): WindowMetrics {
  const start = anchor.ts - windowDays * 86_400
  const readings = ledger.snapshots
    .filter((s) => s.ts > start && s.ts <= anchor.ts && s.scheduleWaitS != null)
    .map((s) => s.scheduleWaitS as number)
  const first = ledger.snapshots[0]
  const stats: DurationStats = {
    n: readings.length,
    completed: readings.length,
    censored: 0,
    p50S: nearestRank(readings, 0.5),
    p90S: nearestRank(readings, 0.9),
    atLeastS: null,
  }
  const empty = durationStats([])
  return {
    windowDays,
    coverage: !first ? 'none' : first.ts <= start ? 'complete' : 'partial',
    requestToFinalize: stats,
    finalizeToClaim: empty,
    requestToClaim: empty,
    label: label('measured_history'),
  }
}

function reconcile(
  snapshot: QueueSnapshot | undefined,
): VenueExitMetrics['queueNow']['reconciliation'] {
  const ledgerOpen = snapshot?.extra?.ledgerOpen
  const onchain = snapshot?.depthCount
  if (
    snapshot?.extra?.countSource !== 'onchain' ||
    typeof ledgerOpen !== 'number' ||
    onchain == null
  )
    return null
  return {
    ledgerOpen,
    onchain,
    status:
      ledgerOpen === onchain ? 'match' : ledgerOpen < onchain ? 'ledger_short' : 'ledger_over',
  }
}

/** Raw integer string → float in display units, without losing precision first. */
export function toUnits(raw: string | null, decimals: number): number | null {
  if (raw == null) return null
  const v = BigInt(raw)
  const keep = Math.min(decimals, 6)
  const scaled = v / 10n ** BigInt(decimals - keep)
  return Number(scaled) / 10 ** keep
}

export function venueMetrics(
  def: VenueDef,
  ledger: VenueLedger,
  anchorIn?: BlockAnchor,
): VenueExitMetrics {
  const snapshot = anchorIn
    ? [...ledger.snapshots].reverse().find((s) => s.block <= anchorIn.block)
    : ledger.snapshots[ledger.snapshots.length - 1]
  const anchor: BlockAnchor | null =
    anchorIn ??
    (snapshot
      ? { block: snapshot.block, ts: snapshot.ts }
      : ledger.coverage
        ? { block: ledger.coverage.throughBlock, ts: ledger.coverage.throughTs }
        : null)

  const openRequests = anchor
    ? Object.values(ledger.requests).filter(
        (r) =>
          r.requestedBlock <= anchor.block &&
          !reached(r.finalizedTs, anchor) &&
          !reached(r.cancelledTs, anchor),
      )
    : []
  const ledgerDepth = openRequests.reduce((s, r) => s + BigInt(r.amount), 0n)

  const queueAmount = snapshot?.depthAmount ?? (openRequests.length ? ledgerDepth.toString() : null)
  const queueCount = snapshot?.depthCount ?? (ledger.coverage ? openRequests.length : null)
  const source = snapshot ? snapshot.depthSource : ledger.coverage ? 'ledger' : null

  const sample = anchor
    ? [...ledger.params].reverse().find((p) => p.block <= anchor.block)
    : ledger.params[ledger.params.length - 1]
  const advertisedCooldownS = def.cooldown
    ? cooldownSeconds(def, sample?.values[def.cooldown.param])
    : null

  const seeded = (def.seededChanges ?? []).filter(
    (c) => !ledger.changes.some((x) => x.txHash === c.txHash && x.param === c.param),
  )
  const changes = [...ledger.changes, ...seeded]
    .filter((c) => !anchor || c.block <= anchor.block)
    .sort((a, b) => b.block - a.block)

  const windows = anchor
    ? WINDOWS_DAYS.map((w) =>
        def.kind === 'beacon' ? beaconWindow(ledger, anchor, w) : windowMetrics(ledger, anchor, w),
      )
    : []

  const amountUnits = toUnits(queueAmount, def.unit.decimals)
  return {
    venue: def.key,
    label: def.label,
    unit: def.unit,
    mechanism: def.mechanism,
    anchor,
    queueNow: {
      amount: queueAmount,
      amountUnits,
      count: queueCount,
      source,
      amountIsLowerBound: snapshot
        ? snapshot.extra?.amountIsLowerBound === true
        : source === 'ledger',
      reconciliation: reconcile(snapshot),
      label: label('onchain_state'),
    },
    open: {
      count: openRequests.length,
      oldestAgeS:
        anchor && openRequests.length
          ? anchor.ts - Math.min(...openRequests.map((r) => r.requestedTs))
          : null,
    },
    windows,
    scheduleWaitS: snapshot?.scheduleWaitS ?? null,
    advertisedCooldownS,
    advertisedCooldownSetsWait: def.cooldown?.setsWait === true,
    lastChange: changes[0] ?? null,
    changes: changes.slice(0, 10),
    ledgerHealth: {
      requests: Object.keys(ledger.requests).length,
      unmatchedClaims: ledger.unmatchedClaims,
      undecodedLogs: ledger.undecodedLogs,
      readAnomalies: ledger.readAnomalies ?? 0,
      idGaps: ledger.idGaps ?? 0,
      bracketedFinalizations: Object.values(ledger.requests).filter(
        // ERC-7540 has no fulfilment signal: there the claim IS the measured event.
        (r) =>
          r.finalizedVia === 'bracket' || (r.finalizedVia === 'claim' && def.kind !== 'erc7540'),
      ).length,
      coverageFromTs: ledger.coverage?.fromTs ?? null,
    },
    venueState: anchor
      ? {
          venue_id: def.key,
          block: anchor.block,
          ts: anchor.ts,
          queue_depth: amountUnits,
          queue_depth_count: queueCount,
          cooldown_s: advertisedCooldownS,
          proxy: 'none',
        }
      : null,
  }
}
