// A separate, short-lived observer process for committed v2 issue batches.
// It does not share the issuer's SQL call or transaction. A successful DB
// stamp is only admitted after a second HTTP SQL request can read it before H1.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'

const MAX_BATCHES = 64
const DB_TIMEOUT_MS = 15_000

function validBatchId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value))
    throw Error('witness_batch_id_invalid')
  if (BigInt(value) > 9_223_372_036_854_775_807n) throw Error('witness_batch_id_invalid')
  return value
}

/** One bounded scan; newest batches take precedence over irrecoverably late ones. */
export async function readUnwitnessedBatches(sql, limit = MAX_BATCHES + 1) {
  return sql`SELECT b.id::text AS batch_id, b.route_key,
      clock_timestamp() < b.issued_at + interval '1 hour' AS before_h1,
      jsonb_array_length(b.plan_doc->'cases')::int AS expected_cases,
      (SELECT count(*)::int FROM carry_exit_v2_cases c
        WHERE c.batch_id = b.id) AS actual_cases,
      (SELECT count(*)::int FROM carry_exit_v2_plans p
        JOIN carry_exit_v2_cases c ON c.id = p.case_id
        WHERE c.batch_id = b.id) AS actual_plans
    FROM carry_exit_v2_batches b
      LEFT JOIN carry_exit_v2_issue_witness w ON w.batch_id = b.id
    WHERE w.batch_id IS NULL
    ORDER BY b.issued_at DESC, b.id DESC
    LIMIT ${limit}`
}

/** One HTTP SQL statement, hence one autocommit operation. */
export async function writeCommittedWitness(sql, batchId) {
  const rows = await sql`SELECT carry_exit_v2_witness_committed_issue(
    ${validBatchId(batchId)}::bigint) AS observed_at`
  return rows?.[0]?.observed_at ?? null
}

/** The separate verifier request must see the committed witness before H1. */
export async function readCommittedWitness(sql, batchId) {
  const rows = await sql`SELECT w.batch_id::text AS batch_id,
      w.plan_sha256 = b.plan_sha256 AS plan_matches,
      w.observed_case_count = jsonb_array_length(b.plan_doc->'cases')
        AS cases_match,
      w.observed_plan_count = 5 * jsonb_array_length(b.plan_doc->'cases')
        AS plans_match,
      w.observed_at < b.issued_at + interval '1 hour' AS witnessed_before_h1,
      clock_timestamp() < b.issued_at + interval '1 hour' AS read_before_h1,
      (SELECT count(*)::int FROM carry_exit_v2_cases c
        WHERE c.batch_id = b.id) = w.observed_case_count AS persisted_cases_match,
      (SELECT count(*)::int FROM carry_exit_v2_plans p
        JOIN carry_exit_v2_cases c ON c.id = p.case_id
        WHERE c.batch_id = b.id) = w.observed_plan_count AS persisted_plans_match
    FROM carry_exit_v2_issue_witness w
      JOIN carry_exit_v2_batches b ON b.id = w.batch_id
    WHERE w.batch_id = ${validBatchId(batchId)}::bigint
    LIMIT 1`
  return rows?.[0] ?? null
}

export function committedWitnessStatus(row, batchId) {
  if (!row) return 'witness_absent'
  if (String(row.batch_id) !== batchId) return 'witness_mismatch'
  if (
    row.plan_matches !== true ||
    row.cases_match !== true ||
    row.plans_match !== true ||
    row.persisted_cases_match !== true ||
    row.persisted_plans_match !== true
  )
    return 'witness_mismatch'
  if (row.witnessed_before_h1 !== true) return 'witness_late'
  if (row.read_before_h1 !== true) return 'witness_read_late'
  return 'witnessed'
}

/** Bounded pass. An uncertain write always gets an independent readback. */
export async function observeCommittedIssues({
  readPending,
  writeWitness,
  readWitness,
  maxBatches = MAX_BATCHES,
}) {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_BATCHES)
    throw Error('witness_limit_invalid')
  const pending = await readPending(maxBatches + 1)
  if (!Array.isArray(pending) || pending.length > maxBatches + 1)
    throw Error('witness_scan_invalid')
  const results = []
  for (const batch of pending.slice(0, maxBatches)) {
    const batchId = validBatchId(batch.batch_id)
    const routeKey = String(batch.route_key ?? '')
    let status
    if (batch.before_h1 !== true) status = 'issue_late_unwitnessed'
    else if (
      !Number.isInteger(batch.expected_cases) ||
      batch.expected_cases < 1 ||
      batch.expected_cases > 6 ||
      batch.actual_cases !== batch.expected_cases ||
      batch.actual_plans !== 5 * batch.expected_cases
    )
      status = 'issue_incomplete'
    else {
      let writeFailed = false
      try {
        await writeWitness(batchId)
      } catch {
        // A timed-out HTTP response may have committed. Read back regardless.
        writeFailed = true
      }
      try {
        status = committedWitnessStatus(await readWitness(batchId), batchId)
        if (writeFailed && status === 'witness_absent') status = 'witness_write_uncertain'
      } catch {
        status = 'witness_read_uncertain'
      }
    }
    results.push({ routeKey, status })
  }
  const counts = {}
  for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1
  return {
    scanned: results.length,
    truncated: pending.length > maxBatches,
    counts,
    routes: results,
    prospectivelyValidated: false,
    futureExitForecast: false,
  }
}

async function main() {
  if (process.argv.length !== 2) throw Error('usage: no arguments')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!db) throw Error('witness_database_missing')
  // Neon HTTP creates a separate autocommit request for every tagged query.
  // Distinct clients make the observer's read/write/read boundary explicit.
  // Each request gets a fresh timeout signal. Never reuse a signal that may
  // have expired while an earlier batch was being observed.
  const makeClient = () =>
    neon(db, { fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) } })
  return observeCommittedIssues({
    readPending: (limit) => readUnwitnessedBatches(makeClient(), limit),
    writeWitness: (batchId) => writeCommittedWitness(makeClient(), batchId),
    readWitness: (batchId) => readCommittedWitness(makeClient(), batchId),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('carry_exit_v2_issue_witness_failed\n')
      process.exitCode = 1
    })
}
