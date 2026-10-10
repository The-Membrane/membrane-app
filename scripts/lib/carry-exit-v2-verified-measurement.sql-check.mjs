// Optional live Neon compatibility check. The synthetic proof, draft DDL, and
// guard SELECT live in one transaction that must abort; no schema is retained.
// Run only with --run-live-rollback and CARRY_EXIT_V2_SQL_TEST_DATABASE_URL.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { DDL } from '../apply-carry-exit-v2-ddl.mjs'
import { syntheticVerifiedMeasurementFixture } from './carry-exit-v2-verified-measurement-fixture.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'

function literal(value) {
  if (value === null) return 'NULL'
  return `'${String(value).replaceAll("'", "''")}'`
}

function guardAndAbort(doc) {
  const args = [
    JSON.stringify(doc),
    'call',
    doc.routeKey,
    doc.destination,
    doc.asset,
    doc.holder,
    doc.assetsRaw,
    doc.blockNumber,
    doc.blockHash,
    doc.coverageKind,
    doc.holderCoverageRaw,
    doc.requiredCoverageRaw,
    doc.actualConsumedRaw,
    doc.simulationStatus,
    null,
    null,
  ]
  const cast = [
    'jsonb',
    'text',
    'text',
    'text',
    'text',
    'text',
    'numeric',
    'bigint',
    'text',
    'text',
    'numeric',
    'numeric',
    'numeric',
    'text',
    'text',
    'text',
  ]
  const parameters = args.map((value, index) => `${literal(value)}::${cast[index]}`).join(', ')
  // A successful guard raises only rollback_sentinel. A false guard raises a
  // different error. Both paths abort every DDL statement in this transaction.
  return `DO $carry_v2_test$ DECLARE v_valid boolean; BEGIN
    SELECT carry_exit_v2_proof_doc_valid(${parameters}) INTO v_valid;
    IF v_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'invalid_doc';
    END IF;
    RAISE EXCEPTION 'rollback_sentinel';
  END $carry_v2_test$`
}

async function tableAbsent(sql) {
  const rows = await sql.query(
    "SELECT to_regclass('public.carry_exit_v2_batches') IS NULL AS absent",
  )
  return rows.length === 1 && rows[0].absent === true
}

export async function checkVerifiedMeasurementSqlRollback(sql) {
  if (!(await tableAbsent(sql))) throw new Error('schema_already_present')
  const fixture = syntheticVerifiedMeasurementFixture()
  const measurement = await measureCarryExitV2Verified(fixture.input)
  if (measurement.status !== 'verified') throw new Error('synthetic_measurement_unavailable')

  let abortedAsExpected = false
  try {
    await sql.transaction([
      ...DDL.map((statement) => sql.query(statement)),
      sql.query(guardAndAbort(measurement.callEvidenceDoc)),
    ])
  } catch (error) {
    const message = String(error?.message ?? '')
    if (message.includes('rollback_sentinel')) abortedAsExpected = true
    else if (message.includes('invalid_doc')) throw new Error('sql_guard_rejected')
    else throw new Error('sql_transaction_failed')
  }
  if (!abortedAsExpected) throw new Error('transaction_committed_unexpectedly')
  if (!(await tableAbsent(sql))) throw new Error('rollback_failed')
  return { status: 'verified_and_rolled_back' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--run-live-rollback')
    throw new Error('Usage: carry-exit-v2-verified-measurement.sql-check.mjs --run-live-rollback')
  const url = process.env.CARRY_EXIT_V2_SQL_TEST_DATABASE_URL
  if (!url) throw new Error('CARRY_EXIT_V2_SQL_TEST_DATABASE_URL required')
  checkVerifiedMeasurementSqlRollback(neon(url))
    .then(() => process.stdout.write('carry_exit_v2_sql_guard_verified_and_rolled_back\n'))
    .catch((error) => {
      // Never print a query, URL, or synthetic holder from a database error.
      const allowed = new Set([
        'schema_already_present',
        'synthetic_measurement_unavailable',
        'sql_guard_rejected',
        'sql_transaction_failed',
        'transaction_committed_unexpectedly',
        'rollback_failed',
      ])
      process.stderr.write(`${allowed.has(error.message) ? error.message : 'sql_check_failed'}\n`)
      process.exitCode = 1
    })
}
