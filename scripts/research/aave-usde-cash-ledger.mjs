// Database boundary for the prospective sampled-cash study. Research only:
// this is not an executable exit forecast, an alert, or a scheduled collector.
//
// Required additive PostgreSQL tables (parent integrates DDL separately):
// CREATE TABLE aave_usde_cash_issues (
//   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), study text NOT NULL,
//   anchor_id uuid NOT NULL REFERENCES venue_snapshots(id), amount_usd numeric NOT NULL,
//   horizon_seconds integer NOT NULL, issued_at timestamptz NOT NULL,
//   persisted_at timestamptz NOT NULL, target_at timestamptz NOT NULL,
//   payload text NOT NULL, payload_sha256 text NOT NULL,
//   source_row_ids jsonb NOT NULL, source_row_set_sha256 text NOT NULL,
//   UNIQUE (study, anchor_id, amount_usd, horizon_seconds), UNIQUE (payload_sha256),
//   CHECK (persisted_at >= issued_at AND persisted_at <= issued_at + interval '60 seconds'),
//   CHECK (persisted_at < target_at));
// CREATE TABLE aave_usde_cash_scores (
//   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issue_id uuid NOT NULL UNIQUE
//     REFERENCES aave_usde_cash_issues(id), scored_at timestamptz NOT NULL,
//   persisted_at timestamptz NOT NULL, payload text NOT NULL,
//   payload_sha256 text NOT NULL, source_row_ids jsonb NOT NULL,
//   source_row_set_sha256 text NOT NULL,
//   CHECK (persisted_at >= scored_at AND persisted_at <= scored_at + interval '60 seconds'));
// Both tables are append-only via DDL triggers. Direct INSERT privileges still
// need a narrow production role/function before this can prove issuance.
// Payload is TEXT deliberately: jsonb reorders keys, but the pure receipt SHA
// hashes JSON.stringify insertion order and must survive a database roundtrip.

import { createHash, randomUUID } from 'node:crypto'
import {
  CASH_PUBLISHER_AUDIT_SQL,
  publisherAuditPass,
} from '../apply-aave-usde-cash-publisher-ddl.mjs'
import {
  MAX_ISSUE_LAG_SECONDS,
  SCORE_AMOUNTS_USD,
  SCORE_HORIZONS_SECONDS,
  STUDY,
  issueCashScenario,
  scoreCashScenario,
  verifyIssue,
} from './aave-usde-prospective-cash.mjs'
import { verifyCashSchedule } from './aave-usde-cash-schedule.mjs'

const MAX_PERSIST_LAG_MS = 60_000
const SCORE_BATCH_SIZE = 25
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unsignedJson = (sealed) => {
  const { sha256, ...body } = sealed
  if (sha(body) !== sha256) throw new Error('Invalid outgoing cash receipt seal')
  return JSON.stringify(body)
}
const verifyScoreSeal = (score) => {
  const { sha256, ...payload } = score ?? {}
  if (!sha256 || sha(payload) !== sha256) throw new Error('Persisted score SHA mismatch')
}
const time = (value) => {
  const n = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(n)) throw new Error('Invalid database time')
  return n
}
const iso = (value) => new Date(time(value)).toISOString()
const assertComplete = (result) => {
  if (result?.complete !== true || !Array.isArray(result.rows))
    throw new Error('Complete observed source query required')
  return result.rows
}

// Seal every returned relevant source row, not merely the pair selected by the
// model. The DB adapter performs an unpaginated query in a serializable tx.
export function sourceRowSet(rows) {
  if (!Array.isArray(rows)) throw new Error('Source rows required')
  const sorted = [...rows].sort((a, b) => {
    const t = time(a.observed_at) - time(b.observed_at)
    return t || String(a.id).localeCompare(String(b.id))
  })
  const ids = sorted.map((row) => String(row.id))
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate source row id')
  const entries = sorted.map((row) => ({
    id: String(row.id),
    venue: row.venue,
    chain: row.chain,
    observedAt: iso(row.observed_at),
    createdAt: iso(row.created_at),
    block: String(row.block),
    source: row.source,
    recorderAtomicV1: row.recorder_atomic_v1 === true,
    instantUsd: row.instant_usd === null ? null : String(row.instant_usd),
    params: row.params,
  }))
  return { ids, sha256: sha(entries) }
}

const checkPersisted = (issuedAt, persistedAt, targetAt = null) => {
  const lag = time(persistedAt) - time(issuedAt)
  if (lag < 0 || lag > MAX_PERSIST_LAG_MS || (targetAt && time(persistedAt) >= time(targetAt)))
    throw new Error('Delayed, backdated, or post-target persistence')
}

// Store contract: withTransaction(fn) supplies a transaction with serverNow,
// readObservedThrough, insertIssue, listDueUnscoredIssues, getScore and
// insertScore. No caller can pass an outcome row subset or an existingScore.
export async function issueFixedGrid({ store, config, schedule = null }) {
  let binding = null
  if (schedule !== null) {
    const manifest = verifyCashSchedule(schedule?.manifest)
    const slot = manifest.slots.find((item) => item.slotId === schedule.slotId)
    if (!slot) throw new Error('Issue slot is absent from sealed schedule')
    binding = {
      manifestSha256: manifest.sha256,
      slotId: slot.slotId,
      scheduledAt: slot.scheduledAt,
      closesAt: slot.closesAt,
    }
  }
  const runId = randomUUID()
  // Commit all nine denominator arms before doing any fallible source/model
  // work. A crash leaves scheduled arms with no terminal event, not silence.
  await store.withTransaction((tx) => tx.startIssueRun(runId, binding))
  let result
  try {
    result = await store.withTransaction(async (tx) => {
      const issuedAt = iso(await tx.serverNow())
      if (
        binding &&
        (time(issuedAt) < time(binding.scheduledAt) || time(issuedAt) >= time(binding.closesAt))
      )
        throw new Error('Issue time is outside the sealed schedule slot')
      const rows = assertComplete(
        await tx.readObservedThrough(
          issuedAt,
          new Date(time(issuedAt) - 30 * 3_600_000).toISOString(),
        ),
      )
      const latest = [...rows].sort((a, b) => time(b.observed_at) - time(a.observed_at))[0]
      if (!latest || time(issuedAt) - time(latest.observed_at) > MAX_ISSUE_LAG_SECONDS * 1000) {
        const reason = latest ? 'stale_source' : 'no_observed_source'
        await tx.finishIssueRun(
          runId,
          SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
            SCORE_HORIZONS_SECONDS.map((horizonSeconds) => ({
              amountUsd,
              horizonSeconds,
              status: 'abstained',
              reason,
            })),
          ),
          binding,
        )
        return { runId, status: reason, issuedAt, issues: [] }
      }
      const source = sourceRowSet(rows)
      const issues = []
      const outcomes = []
      for (const amountUsd of SCORE_AMOUNTS_USD) {
        for (const horizonSeconds of SCORE_HORIZONS_SECONDS) {
          const payload = issueCashScenario(rows, {
            config,
            anchorId: latest.id,
            issuedAt,
            amountUsd,
            horizonSeconds,
          })
          const receipt = await tx.insertIssue({
            study: STUDY,
            anchorId: latest.id,
            amountUsd,
            horizonSeconds,
            issuedAt,
            targetAt: payload.targetAt,
            payload,
            payloadSha256: payload.sha256,
            sourceRowIds: source.ids,
            sourceRowSetSha256: source.sha256,
          })
          if (receipt.inserted) {
            checkPersisted(issuedAt, receipt.persistedAt, payload.targetAt)
            issues.push({ ...receipt, payload, source })
          } else issues.push({ ...receipt, payload: null, source: null })
          outcomes.push({
            amountUsd,
            horizonSeconds,
            status: receipt.inserted ? 'issued' : 'duplicate',
            reason: null,
            issueId: receipt.id,
          })
        }
      }
      await tx.finishIssueRun(runId, outcomes, binding)
      return { runId, status: 'processed', issuedAt, issues }
    })
  } catch (error) {
    // The issue transaction rolled back. Persist a coarse failure reason for
    // every precommitted arm, then rethrow so the scheduler sees the failure.
    await store.withTransaction((tx) =>
      tx.finishIssueRun(
        runId,
        SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
          SCORE_HORIZONS_SECONDS.map((horizonSeconds) => ({
            amountUsd,
            horizonSeconds,
            status: 'failed',
            reason: 'issue_grid_transaction_failed',
          })),
        ),
        binding,
      ),
    )
    throw error
  }
  if (!binding) return { ...result, cohortEligible: false }
  // A separate transaction begins only after the issue/result COMMIT. Its
  // confirmation time is an upper bound on when this run became visible.
  // Never rewrite already-committed result rows if confirmation fails.
  const confirmation = await store.withTransaction((tx) => tx.confirmIssueRun(runId, binding))
  if (confirmation?.confirmed !== true || !confirmation.confirmedAt)
    throw new Error('Bound issue run lacks post-commit confirmation')
  return { ...result, cohortEligible: true, confirmedAt: iso(confirmation.confirmedAt) }
}

export async function scoreDueIssues({ store }) {
  const { scanAt, due } = await store.withTransaction(async (tx) => {
    const scanAt = iso(await tx.serverNow())
    const due = await tx.listDueUnscoredIssues(scanAt, SCORE_BATCH_SIZE)
    if (!Array.isArray(due) || due.length > SCORE_BATCH_SIZE)
      throw new Error('Bounded due issue query required')
    return { scanAt, due }
  })
  const results = []
  for (const issueRow of due) {
    try {
      const result = await store.withTransaction(async (tx) => {
        const scoredAt = iso(await tx.serverNow())
        // Parse inside the per-issue protection boundary. A malformed TEXT
        // receipt must yield a durable failed attempt, not abort the batch.
        const issue =
          typeof issueRow.payload === 'string' ? JSON.parse(issueRow.payload) : issueRow.payload
        verifyIssue(issue)
        if (issueRow.payloadSha256 !== issue.sha256) throw new Error('Persisted issue SHA mismatch')
        if (time(issue.targetAt) > time(scoredAt)) throw new Error('Future issue in due query')
        if (time(issueRow.persistedAt) >= time(issue.targetAt))
          throw new Error('Issue was not persisted before outcome target')
        const existingScore = await tx.getScore(issueRow.id)
        if (existingScore) {
          return { issueId: issueRow.id, status: 'already_scored' }
        }
        const rows = assertComplete(
          await tx.readObservedThrough(
            scoredAt,
            new Date(issue.anchor.firstLocalObservedAt * 1000).toISOString(),
          ),
        )
        const relevant = rows.filter(
          (row) => time(row.observed_at) > issue.anchor.firstLocalObservedAt * 1000,
        )
        const source = sourceRowSet(relevant)
        const score = scoreCashScenario(issue, relevant, { scoredAt, existingScore: null })
        if (score.status === 'pending') {
          await tx.recordScoreAttempt(issueRow.id, 'pending', null)
          return { issueId: issueRow.id, status: 'pending' }
        }
        const receipt = await tx.insertScore({
          issueId: issueRow.id,
          scoredAt,
          payload: score,
          payloadSha256: score.sha256,
          sourceRowIds: source.ids,
          sourceRowSetSha256: source.sha256,
        })
        if (receipt.inserted) checkPersisted(scoredAt, receipt.persistedAt)
        await tx.recordScoreAttempt(
          issueRow.id,
          receipt.inserted ? 'scored' : 'already_scored',
          null,
        )
        return {
          ...receipt,
          issueId: issueRow.id,
          status: receipt.inserted ? score.status : 'already_scored',
          source,
        }
      })
      results.push(result)
    } catch {
      // One corrupt issue or serializable conflict must not starve every later
      // due issue. Persist the attempt in a fresh transaction; fairness query
      // then sends unattempted issues ahead of this one on the next scan.
      await store.withTransaction((tx) =>
        tx.recordScoreAttempt(issueRow.id, 'failed', 'score_transaction_failed'),
      )
      results.push({ issueId: issueRow.id, status: 'failed', reason: 'score_transaction_failed' })
    }
  }
  return { scanAt, results }
}

// A session-capable PostgreSQL pool is required (e.g. Neon Pool over WebSocket).
// HTTP neon().transaction cannot branch on query results inside one transaction.
// The unpaginated SELECT is deliberately fixed here: callers cannot replace it
// with an arbitrary subset while claiming source completeness.
export function createPgCashLedgerStore(pool) {
  if (typeof pool?.connect !== 'function')
    throw new Error('Session-capable PostgreSQL pool required')
  return {
    async withTransaction(fn) {
      const client = await pool.connect()
      let began = false
      try {
        // The publisher must be a distinct, audited non-owner role. A generic
        // application DATABASE_URL must never silently publish study receipts.
        const audit = await client.query(CASH_PUBLISHER_AUDIT_SQL)
        if (!publisherAuditPass(audit.rows[0])) throw new Error('Cash publisher role audit failed')
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        began = true
        const tx = {
          async startIssueRun(runId, binding = null) {
            for (const amountUsd of SCORE_AMOUNTS_USD) {
              for (const horizonSeconds of SCORE_HORIZONS_SECONDS) {
                const result = await client.query(
                  binding
                    ? `SELECT public.publish_aave_usde_cash_issue_start($1::uuid, $2::numeric, $3::integer, $4::text, $5::text) AS inserted`
                    : `SELECT public.publish_aave_usde_cash_issue_start($1::uuid, $2::numeric, $3::integer) AS inserted`,
                  binding
                    ? [runId, amountUsd, horizonSeconds, binding.manifestSha256, binding.slotId]
                    : [runId, amountUsd, horizonSeconds],
                )
                if (result.rows[0]?.inserted !== true)
                  throw new Error('Cash issue arm was already scheduled')
              }
            }
          },
          async finishIssueRun(runId, outcomes, binding = null) {
            if (
              !Array.isArray(outcomes) ||
              outcomes.length !== SCORE_AMOUNTS_USD.length * SCORE_HORIZONS_SECONDS.length
            )
              throw new Error('Complete fixed-grid outcomes required')
            const cells = new Set(outcomes.map((row) => `${row.amountUsd}/${row.horizonSeconds}`))
            const expected = SCORE_AMOUNTS_USD.flatMap((q) =>
              SCORE_HORIZONS_SECONDS.map((h) => `${q}/${h}`),
            )
            if (cells.size !== expected.length || expected.some((cell) => !cells.has(cell)))
              throw new Error('Fixed-grid outcomes have missing or duplicate cells')
            for (const outcome of outcomes) {
              const result = await client.query(
                binding
                  ? `SELECT public.publish_aave_usde_cash_issue_result(
                   $1::uuid, $2::numeric, $3::integer, $4::text, $5::text, $6::uuid, $7::text, $8::text
                 ) AS inserted`
                  : `SELECT public.publish_aave_usde_cash_issue_result(
                   $1::uuid, $2::numeric, $3::integer, $4::text, $5::text, $6::uuid
                 ) AS inserted`,
                [
                  runId,
                  outcome.amountUsd,
                  outcome.horizonSeconds,
                  outcome.status,
                  outcome.reason,
                  outcome.issueId ?? null,
                  ...(binding ? [binding.manifestSha256, binding.slotId] : []),
                ],
              )
              if (result.rows[0]?.inserted !== true)
                throw new Error('Cash issue arm result was not inserted')
            }
          },
          async confirmIssueRun(runId, binding) {
            if (!binding?.manifestSha256 || !binding?.slotId)
              throw new Error('Bound issue-run confirmation requires a sealed slot')
            const result = await client.query(
              `SELECT run_id::text, confirmed_at, inserted
                 FROM public.confirm_aave_usde_cash_issue_run($1::uuid, $2::text, $3::text)`,
              [runId, binding.manifestSha256, binding.slotId],
            )
            const receipt = result.rows[0]
            if (
              result.rows.length !== 1 ||
              receipt.run_id !== runId ||
              typeof receipt.inserted !== 'boolean' ||
              !receipt.confirmed_at
            )
              throw new Error('Invalid issue-run confirmation acknowledgment')
            return {
              confirmed: true,
              confirmedAt: receipt.confirmed_at,
              inserted: receipt.inserted,
            }
          },
          async serverNow() {
            const result = await client.query('SELECT clock_timestamp() AS now')
            return result.rows[0].now
          },
          async readObservedThrough(asOf, since) {
            const result = await client.query(
              `SELECT id::text, venue, chain, block::text, observed_at, created_at,
                      instant_usd::text, source, recorder_atomic_v1, params
                 FROM venue_snapshots
                WHERE venue = 'aave-v3-usde' AND source = 'observed'
                  AND observed_at <= $1 AND created_at <= $1
                  AND observed_at >= $2
                ORDER BY observed_at, id`,
              [asOf, since],
            )
            return { complete: true, rows: result.rows }
          },
          async insertIssue(row) {
            const result = await client.query(
              `SELECT receipt_id::text AS id, inserted, persisted_at
                 FROM public.publish_aave_usde_cash_issue($1::jsonb, $2::text, $3::text)`,
              [
                JSON.stringify({
                  study: row.study,
                  anchorId: row.anchorId,
                  amountUsd: row.amountUsd,
                  horizonSeconds: row.horizonSeconds,
                  issuedAt: row.issuedAt,
                  targetAt: row.targetAt,
                  payloadSha256: row.payloadSha256,
                  sourceRowIds: row.sourceRowIds,
                  sourceRowSetSha256: row.sourceRowSetSha256,
                }),
                JSON.stringify(row.payload),
                unsignedJson(row.payload),
              ],
            )
            const receipt = result.rows[0]
            if (result.rows.length !== 1 || typeof receipt.inserted !== 'boolean')
              throw new Error('Invalid issue publication acknowledgment')
            if (receipt.inserted)
              return { inserted: true, id: receipt.id, persistedAt: receipt.persisted_at }
            const existing = await client.query(
              'SELECT payload_sha256 FROM public.aave_usde_cash_issues WHERE id=$1::uuid',
              [receipt.id],
            )
            if (existing.rows.length !== 1) throw new Error('Missing duplicate cash issue')
            return {
              inserted: false,
              id: receipt.id,
              persistedAt: receipt.persisted_at,
              payloadMatchesCandidate: existing.rows[0].payload_sha256 === row.payloadSha256,
            }
          },
          async listDueUnscoredIssues(asOf, limit) {
            const result = await client.query(
              `SELECT i.id::text, i.payload, i.payload_sha256, i.persisted_at
                 FROM aave_usde_cash_issues i
                 LEFT JOIN LATERAL (
                   SELECT max(a.id) AS last_attempt_id
                     FROM aave_usde_cash_score_attempts a WHERE a.issue_id=i.id
                 ) attempt ON TRUE
                WHERE i.study=$1 AND i.target_at <= $2
                  AND NOT EXISTS (SELECT 1 FROM aave_usde_cash_scores s WHERE s.issue_id=i.id)
                ORDER BY attempt.last_attempt_id NULLS FIRST, i.target_at, i.id LIMIT $3`,
              [STUDY, asOf, limit],
            )
            return result.rows.map((row) => ({
              id: row.id,
              payload: row.payload,
              payloadSha256: row.payload_sha256,
              persistedAt: row.persisted_at,
            }))
          },
          async getScore(issueId) {
            const result = await client.query(
              'SELECT id::text, payload, payload_sha256 FROM aave_usde_cash_scores WHERE issue_id=$1',
              [issueId],
            )
            const row = result.rows[0]
            if (!row) return null
            const payload = JSON.parse(row.payload)
            verifyScoreSeal(payload)
            if (payload.sha256 !== row.payload_sha256)
              throw new Error('Persisted score SHA mismatch')
            return { id: row.id, payload }
          },
          async recordScoreAttempt(issueId, status, reason) {
            const result = await client.query(
              `SELECT public.publish_aave_usde_cash_score_attempt(
                 $1::uuid, $2::text, $3::text
               ) AS attempt_id`,
              [issueId, status, reason],
            )
            if (result.rows.length !== 1 || result.rows[0]?.attempt_id == null)
              throw new Error('Invalid cash score attempt acknowledgment')
          },
          async insertScore(row) {
            const result = await client.query(
              `SELECT receipt_id::text AS id, inserted, persisted_at
                 FROM public.publish_aave_usde_cash_score($1::jsonb, $2::text, $3::text)`,
              [
                JSON.stringify({
                  issueId: row.issueId,
                  scoredAt: row.scoredAt,
                  payloadSha256: row.payloadSha256,
                  sourceRowIds: row.sourceRowIds,
                  sourceRowSetSha256: row.sourceRowSetSha256,
                }),
                JSON.stringify(row.payload),
                unsignedJson(row.payload),
              ],
            )
            const receipt = result.rows[0]
            if (result.rows.length !== 1 || typeof receipt.inserted !== 'boolean')
              throw new Error('Invalid score publication acknowledgment')
            if (receipt.inserted)
              return { inserted: true, id: receipt.id, persistedAt: receipt.persisted_at }
            const existing = await client.query(
              'SELECT payload_sha256 FROM public.aave_usde_cash_scores WHERE id=$1::uuid',
              [receipt.id],
            )
            if (existing.rows.length !== 1) throw new Error('Missing duplicate cash score')
            return {
              inserted: false,
              id: receipt.id,
              persistedAt: receipt.persisted_at,
              payloadMatchesCandidate: existing.rows[0].payload_sha256 === row.payloadSha256,
            }
          },
        }
        const value = await fn(tx)
        await client.query('COMMIT')
        return value
      } catch (error) {
        if (began) await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}
