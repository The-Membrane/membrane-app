/**
 * EVALUATE ON READ: load one owner's active thresholds, read each distinct current
 * value once, run the pure evaluator, persist transitions with compare-and-set, and
 * return the owner's own thresholds + events. Used by GET /api/alerts/feed/[token]
 * (the RSS path) and, only when the Telegram bot is configured, by the operator tick
 * for owners linked to a chat (scripts/check-venue-alarms.mjs).
 *
 * No logging here: an owner's thresholds never reach a log line.
 */

import { evaluate, readingKey, type Reading, type SkipReason } from './evaluate'
import {
  activeThresholds,
  ownerEvents,
  recordClearing,
  recordCrossing,
  readingWorthWriting,
  recordReading,
  type EventRow,
  type Sql,
  type ThresholdRow,
} from './store'

export type ThresholdView = ThresholdRow & {
  /** State after this read. */
  crossed: boolean
  reading: Reading
  /** Why this read did not evaluate it, if it did not. */
  skipped: SkipReason | null
}

export type OwnerFeed = { thresholds: ThresholdView[]; events: EventRow[]; generatedAt: string }

export type EvaluateDeps = {
  readValues: (needs: Array<{ metric: ThresholdRow['metric']; subject: string }>) => Promise<Map<string, Reading>>
  nowMs?: () => number
}

const NO_READING: Reading = { status: 'unavailable', source: 'none', reason: 'not read' }

export async function evaluateOwner(sql: Sql, ownerId: string, deps: EvaluateDeps, eventLimit = 50): Promise<OwnerFeed> {
  const at = new Date((deps.nowMs ?? Date.now)()).toISOString()
  const rows = await activeThresholds(sql, ownerId)
  const readings = rows.length ? await deps.readValues(rows.map((r) => ({ metric: r.metric, subject: r.subject }))) : new Map()
  const thresholds: ThresholdView[] = []
  for (const t of rows) {
    const reading = readings.get(readingKey(t.metric, t.subject)) ?? NO_READING
    const ev = evaluate(t, reading)
    let crossed = t.crossedAt !== null
    if (ev.kind !== 'skipped' && reading.status === 'ok') {
      const o = { value: ev.value, at, asOf: reading.asOf, source: reading.source }
      if (ev.kind === 'crossed') {
        await recordCrossing(sql, t.id, o)
        crossed = true
      } else if (ev.kind === 'cleared') {
        await recordClearing(sql, t.id, o)
        crossed = false
      } else if (readingWorthWriting(t, o)) {
        // No transition: a write only when the value moved, at most once a minute.
        await recordReading(sql, t.id, o)
      }
    }
    thresholds.push({
      ...t,
      crossed,
      crossedAt: crossed ? (t.crossedAt ?? at) : null,
      reading,
      skipped: ev.kind === 'skipped' ? ev.reason : null,
    })
  }
  const events = eventLimit > 0 ? await ownerEvents(sql, ownerId, eventLimit) : []
  return { thresholds, events, generatedAt: at }
}

/** The tick's pass: evaluate each owner; one owner's failure never stops the rest. */
export async function evaluateOwners(sql: Sql, ownerIds: readonly string[], deps: EvaluateDeps): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (const id of ownerIds) {
    try {
      await evaluateOwner(sql, id, deps, 0)
      ok++
    } catch {
      failed++
    }
  }
  return { ok, failed }
}
