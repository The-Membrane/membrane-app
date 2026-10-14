/**
 * Postgres I/O for user threshold alerts. Every function takes a neon-style tagged
 * `sql` (rows array back), so the Next routes, the operator tick and the tests share
 * one implementation. DDL: scripts/apply-alert-thresholds-ddl.mjs (mirrored in
 * db/schema.ts).
 *
 * PRIVACY: nothing here lists thresholds by address, by subject or in aggregate.
 * Every read is keyed by an owner id that only a feed-token lookup yields.
 */

import type { Direction, Metric, OwnerKind } from './metrics'
import { FEED_TOKEN_RE } from './metrics'

export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString())
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export type OwnerRow = { id: string; kind: OwnerKind; key: string }

export type ThresholdRow = {
  id: string
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
  createdAt: string
  crossedAt: string | null
  lastValue: number | null
  lastEvaluatedAt: string | null
}

export type EventRow = {
  id: string
  thresholdId: string
  kind: 'crossed' | 'cleared'
  value: number
  at: string
  asOf: string
  source: string
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
}

export type NewThreshold = {
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
  optedInAt: string
}

/** The three tables the web path needs answer a zero-row read. */
export async function storageReady(sql: Sql): Promise<boolean> {
  try {
    await sql`SELECT 1 FROM user_alert_owners, user_alert_thresholds, user_alert_events LIMIT 0`
    return true
  } catch {
    return false
  }
}

/** The ONE way to reach an owner: its feed token (unique index lookup). */
export async function ownerByToken(sql: Sql, token: string): Promise<OwnerRow | null> {
  if (!FEED_TOKEN_RE.test(token)) return null
  const [r] = await sql`
    SELECT id, owner_kind AS kind, owner_key AS key
    FROM user_alert_owners WHERE feed_token = ${token} LIMIT 1`
  return r ? { id: String(r.id), kind: r.kind as OwnerKind, key: String(r.key) } : null
}

/** A new owner (feed) and its first threshold, in one statement. Returns the threshold id. */
export async function createOwnerWithThreshold(
  sql: Sql,
  owner: { kind: OwnerKind; key: string; token: string },
  t: NewThreshold,
): Promise<string> {
  const [r] = await sql`
    WITH o AS (
      INSERT INTO user_alert_owners (owner_kind, owner_key, feed_token, created_at)
      VALUES (${owner.kind}, ${owner.key}, ${owner.token}, ${t.optedInAt}::timestamptz)
      RETURNING id
    )
    INSERT INTO user_alert_thresholds (owner_id, metric, subject, direction, threshold, opted_in_at)
    SELECT o.id, ${t.metric}, ${t.subject}, ${t.direction}, ${String(t.threshold)}::numeric, ${t.optedInAt}::timestamptz
    FROM o
    RETURNING id`
  return String(r.id)
}

/**
 * Add a threshold to an existing owner unless it already has `cap` active ones.
 * Returns the new id, or null when the cap is reached. A soft cap: two concurrent
 * inserts at cap − 1 can both land (the per-IP rate limit bounds that).
 */
export async function addThreshold(sql: Sql, ownerId: string, t: NewThreshold, cap: number): Promise<string | null> {
  const rows = await sql`
    INSERT INTO user_alert_thresholds (owner_id, metric, subject, direction, threshold, opted_in_at)
    SELECT ${ownerId}::uuid, ${t.metric}, ${t.subject}, ${t.direction}, ${String(t.threshold)}::numeric, ${t.optedInAt}::timestamptz
    WHERE (
      SELECT count(*) FROM user_alert_thresholds WHERE owner_id = ${ownerId}::uuid AND stopped_at IS NULL
    ) < ${cap}
    RETURNING id`
  return rows[0] ? String(rows[0].id) : null
}

export async function activeThresholds(sql: Sql, ownerId: string): Promise<ThresholdRow[]> {
  const rows = await sql`
    SELECT id, metric, subject, direction, threshold, created_at AS "createdAt", crossed_at AS "crossedAt",
           last_value AS "lastValue", last_evaluated_at AS "lastEvaluatedAt"
    FROM user_alert_thresholds
    WHERE owner_id = ${ownerId}::uuid AND stopped_at IS NULL
    ORDER BY created_at ASC`
  return rows.map((r) => ({
    id: String(r.id),
    metric: r.metric as Metric,
    subject: String(r.subject),
    direction: r.direction as Direction,
    threshold: Number(r.threshold),
    createdAt: iso(r.createdAt) as string,
    crossedAt: iso(r.crossedAt),
    lastValue: num(r.lastValue),
    lastEvaluatedAt: iso(r.lastEvaluatedAt),
  }))
}

export type Observation = { value: number; at: string; asOf: string; source: string }

/**
 * not crossed → crossed. Compare-and-set: only the read that flips crossed_at from
 * NULL writes the event; the unique (threshold_id, kind, crossing_at) key backs it.
 * Returns true when this call recorded the event.
 */
export async function recordCrossing(sql: Sql, thresholdId: string, o: Observation): Promise<boolean> {
  const rows = await sql`
    WITH upd AS (
      UPDATE user_alert_thresholds
      SET crossed_at = ${o.at}::timestamptz, last_value = ${String(o.value)}::numeric, last_evaluated_at = ${o.at}::timestamptz
      WHERE id = ${thresholdId}::uuid AND crossed_at IS NULL AND stopped_at IS NULL
      RETURNING id, crossed_at
    )
    INSERT INTO user_alert_events (threshold_id, kind, value, at, as_of, source, crossing_at)
    SELECT id, 'crossed', ${String(o.value)}::numeric, ${o.at}::timestamptz, ${o.asOf}::timestamptz, ${o.source}, crossed_at
    FROM upd
    ON CONFLICT (threshold_id, kind, crossing_at) DO NOTHING
    RETURNING id`
  return rows.length > 0
}

/**
 * crossed → cleared. The row lock (FOR UPDATE) makes a concurrent clear re-check
 * crossed_at and find it NULL, so one crossing gets one clear.
 */
export async function recordClearing(sql: Sql, thresholdId: string, o: Observation): Promise<boolean> {
  const rows = await sql`
    WITH prev AS (
      SELECT id, crossed_at FROM user_alert_thresholds
      WHERE id = ${thresholdId}::uuid AND crossed_at IS NOT NULL AND stopped_at IS NULL
      FOR UPDATE
    ), upd AS (
      UPDATE user_alert_thresholds t
      SET crossed_at = NULL, last_value = ${String(o.value)}::numeric, last_evaluated_at = ${o.at}::timestamptz
      FROM prev WHERE t.id = prev.id
      RETURNING t.id, prev.crossed_at AS crossing_at
    )
    INSERT INTO user_alert_events (threshold_id, kind, value, at, as_of, source, crossing_at)
    SELECT id, 'cleared', ${String(o.value)}::numeric, ${o.at}::timestamptz, ${o.asOf}::timestamptz, ${o.source}, crossing_at
    FROM upd
    ON CONFLICT (threshold_id, kind, crossing_at) DO NOTHING
    RETURNING id`
  return rows.length > 0
}

/** No transition: remember the value and when it was checked. */
export async function recordReading(sql: Sql, thresholdId: string, o: Pick<Observation, 'value' | 'at'>): Promise<void> {
  await sql`
    UPDATE user_alert_thresholds
    SET last_value = ${String(o.value)}::numeric, last_evaluated_at = ${o.at}::timestamptz
    WHERE id = ${thresholdId}::uuid AND stopped_at IS NULL`
}

/** This owner's events, newest first (stopped thresholds' history included). */
export async function ownerEvents(sql: Sql, ownerId: string, limit = 50): Promise<EventRow[]> {
  const rows = await sql`
    SELECT e.id, e.threshold_id AS "thresholdId", e.kind, e.value, e.at, e.as_of AS "asOf", e.source,
           t.metric, t.subject, t.direction, t.threshold
    FROM user_alert_events e
    JOIN user_alert_thresholds t ON t.id = e.threshold_id
    WHERE t.owner_id = ${ownerId}::uuid
    ORDER BY e.at DESC
    LIMIT ${limit}`
  return rows.map(toEvent)
}

export const toEvent = (r: any): EventRow => ({
  id: String(r.id),
  thresholdId: String(r.thresholdId),
  kind: r.kind === 'cleared' ? 'cleared' : 'crossed',
  value: Number(r.value),
  at: iso(r.at) as string,
  asOf: iso(r.asOf) as string,
  source: String(r.source),
  metric: r.metric as Metric,
  subject: String(r.subject),
  direction: r.direction as Direction,
  threshold: Number(r.threshold),
})

/** Stop one of this owner's thresholds. False when it is not theirs or already stopped. */
export async function stopThreshold(sql: Sql, ownerId: string, thresholdId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE user_alert_thresholds SET stopped_at = now()
    WHERE id = ${thresholdId}::uuid AND owner_id = ${ownerId}::uuid AND stopped_at IS NULL
    RETURNING id`
  return rows.length > 0
}
