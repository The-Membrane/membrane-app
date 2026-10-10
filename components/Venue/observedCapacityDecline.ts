import type { Entry } from '@/components/Carry/venueLogLogic'

export type CapacityMetric = 'instant_usd' | 'depth_usd'

export type ObservedCapacityDecline = {
  status: 'available'
  metric: CapacityMetric
  beforeUsd: number
  afterUsd: number
  since: string
  at: string
  snapshotAt: string
  snapshotBlock: number
}

export type DeclineReadout =
  | ObservedCapacityDecline
  | {
      status: 'unavailable'
      reason:
        | 'source_unavailable'
        | 'snapshot_unavailable'
        | 'snapshot_stale'
        | 'feed_limited_or_no_move'
        | 'latest_move_stale'
        | 'latest_move_invalid'
        | 'latest_move_not_decline'
        | 'snapshot_mismatch'
    }

type Snapshot = {
  block: number
  observedAt: string
  instantUsd: number | null
  params: { depthUsd: number | null }
}

const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000
const CLOCK_SLACK_MS = 5 * 60 * 1000

const finiteNonnegative = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

const hasMetric = (entry: Entry, metric: CapacityMetric): boolean =>
  entry.provenance === 'observed' &&
  ((entry.kind === 'instant_liquidity_shift' && metric === 'instant_usd') ||
    (entry.kind === 'param_changed' && metric in (entry.next ?? {})))

/** A 50-event venue feed gives a witnessed move, never a complete movement history. */
export function observedCapacityDecline(
  entries: Entry[] | null | undefined,
  venue: string,
  snapshot: Snapshot | null | undefined,
  nowMs = Date.now(),
): DeclineReadout {
  if (!entries) return { status: 'unavailable', reason: 'source_unavailable' }
  if (!snapshot || !Number.isSafeInteger(snapshot.block) || snapshot.block < 0)
    return { status: 'unavailable', reason: 'snapshot_unavailable' }

  const snapshotAtMs = Date.parse(snapshot.observedAt)
  if (!Number.isFinite(snapshotAtMs) || !Number.isFinite(nowMs))
    return { status: 'unavailable', reason: 'snapshot_unavailable' }
  if (snapshotAtMs > nowMs + CLOCK_SLACK_MS || nowMs - snapshotAtMs > MAX_SNAPSHOT_AGE_MS)
    return { status: 'unavailable', reason: 'snapshot_stale' }

  const metric: CapacityMetric = snapshot.instantUsd != null ? 'instant_usd' : 'depth_usd'
  const currentUsd = finiteNonnegative(
    metric === 'instant_usd' ? snapshot.instantUsd : snapshot.params.depthUsd,
  )
  if (currentUsd == null) return { status: 'unavailable', reason: 'snapshot_unavailable' }

  const relevant = entries
    .filter((entry) => entry.venue === venue && hasMetric(entry, metric))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const latest = relevant[0]
  if (!latest) return { status: 'unavailable', reason: 'feed_limited_or_no_move' }

  const sinceMs = latest.since ? Date.parse(latest.since) : NaN
  const atMs = Date.parse(latest.at)
  const beforeUsd = finiteNonnegative(latest.prev?.[metric])
  const afterUsd = finiteNonnegative(latest.next?.[metric])
  if (
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(atMs) ||
    sinceMs >= atMs ||
    atMs > nowMs + CLOCK_SLACK_MS ||
    beforeUsd == null ||
    afterUsd == null ||
    beforeUsd === afterUsd
  )
    return { status: 'unavailable', reason: 'latest_move_invalid' }
  if (nowMs - atMs > MAX_SNAPSHOT_AGE_MS)
    return { status: 'unavailable', reason: 'latest_move_stale' }
  if (afterUsd > beforeUsd) return { status: 'unavailable', reason: 'latest_move_not_decline' }

  // The recorder writes the event seconds after the snapshot it describes.
  // A later current snapshot is acceptable only while its value still agrees.
  const toleranceUsd = Math.max(0.01, Math.abs(afterUsd) * 1e-6)
  if (snapshotAtMs + CLOCK_SLACK_MS < atMs || Math.abs(currentUsd - afterUsd) > toleranceUsd)
    return { status: 'unavailable', reason: 'snapshot_mismatch' }

  return {
    status: 'available',
    metric,
    beforeUsd,
    afterUsd,
    since: latest.since!,
    at: latest.at,
    snapshotAt: snapshot.observedAt,
    snapshotBlock: snapshot.block,
  }
}
