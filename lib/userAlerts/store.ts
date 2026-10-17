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
  /** As-of of the reading the state last moved on (the out-of-order guard). */
  lastAsOf: string | null
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
           last_value AS "lastValue", last_evaluated_at AS "lastEvaluatedAt", last_as_of AS "lastAsOf"
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
    lastAsOf: iso(r.lastAsOf),
  }))
}

export type Observation = { value: number; at: string; asOf: string; source: string }

/**
 * Every write below also requires the reading to be no older than the one the state
 * last moved on (`last_as_of IS NULL OR last_as_of <= as_of`), so an instance with
 * an older cached reading can never undo a newer instance's transition.
 *
 * not crossed → crossed. Compare-and-set: only the read that flips crossed_at from
 * NULL writes the event; the unique (threshold_id, kind, crossing_at) key backs it.
 * Returns true when this call recorded the event.
 */
export async function recordCrossing(sql: Sql, thresholdId: string, o: Observation): Promise<boolean> {
  const rows = await sql`
    WITH upd AS (
      UPDATE user_alert_thresholds
      SET crossed_at = ${o.at}::timestamptz, last_value = ${String(o.value)}::numeric,
          last_evaluated_at = ${o.at}::timestamptz, last_as_of = ${o.asOf}::timestamptz
      WHERE id = ${thresholdId}::uuid AND crossed_at IS NULL AND stopped_at IS NULL
        AND (last_as_of IS NULL OR last_as_of <= ${o.asOf}::timestamptz)
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
        AND (last_as_of IS NULL OR last_as_of <= ${o.asOf}::timestamptz)
      FOR UPDATE
    ), upd AS (
      UPDATE user_alert_thresholds t
      SET crossed_at = NULL, last_value = ${String(o.value)}::numeric,
          last_evaluated_at = ${o.at}::timestamptz, last_as_of = ${o.asOf}::timestamptz
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

/** A no-transition reading is written at most this often per threshold. */
export const READING_WRITE_MIN_INTERVAL_S = 60

/**
 * No transition: remember the value, its as-of and when it was checked — but ONLY
 * when the value changed, the reading is not older than the stored one, and the
 * last write is at least a minute old. A feed polled every few seconds therefore
 * writes at most once a minute per threshold, and only when the source moved.
 * (Advancing last_as_of keeps the out-of-order guard current.)
 */
export async function recordReading(sql: Sql, thresholdId: string, o: Pick<Observation, 'value' | 'at' | 'asOf'>): Promise<void> {
  await sql`
    UPDATE user_alert_thresholds
    SET last_value = ${String(o.value)}::numeric, last_evaluated_at = ${o.at}::timestamptz, last_as_of = ${o.asOf}::timestamptz
    WHERE id = ${thresholdId}::uuid AND stopped_at IS NULL
      AND last_value IS DISTINCT FROM ${String(o.value)}::numeric
      AND (last_as_of IS NULL OR last_as_of <= ${o.asOf}::timestamptz)
      AND (last_evaluated_at IS NULL OR last_evaluated_at <= ${o.at}::timestamptz - make_interval(secs => ${READING_WRITE_MIN_INTERVAL_S}))`
}

/** The JS-side mirror of recordReading's guard: skip the round trip when it would no-op. */
export const readingWorthWriting = (t: Pick<ThresholdRow, 'lastValue' | 'lastEvaluatedAt' | 'lastAsOf'>, o: Pick<Observation, 'value' | 'at' | 'asOf'>): boolean => {
  if (t.lastValue !== null && t.lastValue === o.value) return false
  if (t.lastAsOf && Date.parse(t.lastAsOf) > Date.parse(o.asOf)) return false
  if (t.lastEvaluatedAt && Date.parse(o.at) - Date.parse(t.lastEvaluatedAt) < READING_WRITE_MIN_INTERVAL_S * 1000) return false
  return true
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

export type ThresholdEdit = { direction: Direction; threshold: number; editedAt: string }

/**
 * EDIT one of this owner's active thresholds: its line (threshold) and/or direction.
 * Metric and subject never change. An edit is a REPLACEMENT, in ONE statement:
 *
 *  - the old row is stopped (stopped_at = editedAt), exactly as Stop does, and keeps
 *    its events — so the history still names the line each event fired at;
 *  - a new row holds the new line, opted in at editedAt (the Save press). It starts
 *    NOT crossed (crossed_at NULL): the next reading can fire it, as on a new alert.
 *    It keeps the old row's created_at, so it holds its place on the alerts page
 *    (activeThresholds orders by created_at) — and every row of one alert's edit
 *    chain shares (owner_id, metric, subject, created_at), which the Telegram tick
 *    uses to keep delivering a replaced row's events (scripts/lib/telegramBot.mjs).
 *    It carries over the READING guard — last_value, last_evaluated_at, last_as_of —
 *    so a reading older than one the old row already moved on is still never
 *    evaluated (the out-of-order guard), and the once-a-minute write throttle holds;
 *  - no event is written here: an edit never back-fills a crossing;
 *  - a new id means new events can never collide with the old ones on the UNIQUE
 *    (threshold_id, kind, crossing_at) key;
 *  - an evaluation that read the old row before the edit committed writes nothing:
 *    every transition write requires stopped_at IS NULL;
 *  - the active count is unchanged (one stopped, one added), so an edit works on a
 *    full feed and can never take one past the cap.
 *
 * Returns {id: new id, changed: true}; {id: same id, changed: false} when the row
 * already has these values (no write — a repeated Save is a no-op); null when the id
 * is not an ACTIVE threshold of this owner (unknown, someone else's, stopped, or
 * already replaced by an earlier edit). Two racing edits: the row lock lets one
 * replace it; the other then finds it stopped and gets null.
 */
export async function editThreshold(
  sql: Sql,
  ownerId: string,
  thresholdId: string,
  e: ThresholdEdit,
): Promise<{ id: string; changed: boolean } | null> {
  const rows = await sql`
    WITH old AS (
      UPDATE user_alert_thresholds
      SET stopped_at = ${e.editedAt}::timestamptz
      WHERE id = ${thresholdId}::uuid AND owner_id = ${ownerId}::uuid AND stopped_at IS NULL
        AND (direction, threshold) IS DISTINCT FROM (${e.direction}::text, ${String(e.threshold)}::numeric)
      RETURNING owner_id, metric, subject, created_at, last_value, last_evaluated_at, last_as_of
    )
    INSERT INTO user_alert_thresholds
      (owner_id, metric, subject, direction, threshold, opted_in_at, created_at, last_value, last_evaluated_at, last_as_of)
    SELECT owner_id, metric, subject, ${e.direction}, ${String(e.threshold)}::numeric, ${e.editedAt}::timestamptz,
           created_at, last_value, last_evaluated_at, last_as_of
    FROM old
    RETURNING id`
  if (rows[0]) return { id: String(rows[0].id), changed: true }
  const same = await sql`
    SELECT id FROM user_alert_thresholds
    WHERE id = ${thresholdId}::uuid AND owner_id = ${ownerId}::uuid AND stopped_at IS NULL
      AND direction = ${e.direction} AND threshold = ${String(e.threshold)}::numeric`
  return same[0] ? { id: String(same[0].id), changed: false } : null
}

/** Stop one of this owner's thresholds. False when it is not theirs or already stopped. */
export async function stopThreshold(sql: Sql, ownerId: string, thresholdId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE user_alert_thresholds SET stopped_at = now()
    WHERE id = ${thresholdId}::uuid AND owner_id = ${ownerId}::uuid AND stopped_at IS NULL
    RETURNING id`
  return rows.length > 0
}
