// Read-only health gate for future H1 cash ranges across the exact tracked
// Carry cohort. Twyne has a separate Aave PT reserve proxy, not wrapper cash.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { assertModelGuards } from './apply-carry-cash-model-ddl.mjs'
import { readEnv } from './lib/venue-reads.mjs'
import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { TWYNE_PT_RESERVE } from './record-twyne-pt-reserve.mjs'

const key = (routeKey, destination) => `${routeKey}\0${destination}`
const identity = (row) => `${row.route_key} @ ${row.destination}`

export function evaluateCoverage(manifest, genericRows, twyneRows) {
  if (
    !Array.isArray(manifest?.subjects) ||
    !Array.isArray(genericRows) ||
    !Array.isArray(twyneRows)
  )
    throw new Error('coverage_inputs_invalid')
  const routes = new Set(manifest.subjects.map((row) => row.route_key))
  const subjectKeys = new Set(manifest.subjects.map((row) => key(row.route_key, row.destination)))
  const twyneSubjects = manifest.subjects.filter(
    (row) => row.route_key === TWYNE_PT_RESERVE.routeKey,
  )
  if (
    manifest.subjects.length !== 67 ||
    subjectKeys.size !== 67 ||
    routes.size !== 25 ||
    twyneSubjects.length !== 1 ||
    twyneSubjects[0].destination !== TWYNE_PT_RESERVE.wrapper
  )
    throw new Error('coverage_manifest_not_exact_25_route_67_subject_cohort')

  const expectedGeneric = manifest.subjects.filter(
    (row) => row.route_key !== TWYNE_PT_RESERVE.routeKey,
  )
  if (expectedGeneric.length !== 66) throw new Error('coverage_generic_subject_count_invalid')
  if (genericRows.length !== expectedGeneric.length)
    throw new Error('coverage_generic_issue_count_invalid')
  const expectedGenericKeys = new Set(
    expectedGeneric.map((row) => key(row.route_key, row.destination)),
  )
  const byKey = new Map()
  for (const row of genericRows) {
    const rowKey = key(row.route_key, row.destination)
    if (!expectedGenericKeys.has(rowKey))
      throw new Error(`coverage_unknown_generic_issue:${identity(row)}`)
    if (byKey.has(rowKey)) throw new Error(`coverage_duplicate_generic_issue:${identity(row)}`)
    byKey.set(rowKey, row)
  }
  const missing = expectedGeneric.filter((subject) => {
    const row = byKey.get(key(subject.route_key, subject.destination))
    return (
      !row ||
      row.asset !== subject.asset ||
      row.source_kind !== subject.source_kind ||
      row.source_venue_kind !== subject.venue_kind ||
      Number(row.horizon_hours) !== 1 ||
      row.artifact_route_key !== subject.route_key ||
      row.artifact_destination !== subject.destination ||
      row.artifact_asset !== subject.asset ||
      Number(row.artifact_horizon_hours) !== 1
    )
  })
  if (twyneRows.length > 1) throw new Error('coverage_duplicate_twyne_pt_issue')
  const twyne = twyneRows[0]
  if (
    !twyne ||
    twyne.route_key !== TWYNE_PT_RESERVE.routeKey ||
    twyne.wrapper !== TWYNE_PT_RESERVE.wrapper ||
    twyne.metric !== 'aave_pt_reserve_cash_raw' ||
    Number(twyne.horizon_hours) !== 1 ||
    twyne.artifact_route_key !== TWYNE_PT_RESERVE.routeKey ||
    twyne.artifact_wrapper !== TWYNE_PT_RESERVE.wrapper ||
    twyne.artifact_pt !== TWYNE_PT_RESERVE.pt ||
    twyne.artifact_atoken !== TWYNE_PT_RESERVE.aToken ||
    twyne.artifact_pool !== TWYNE_PT_RESERVE.pool ||
    Number(twyne.artifact_horizon_hours) !== 1
  )
    missing.push(twyneSubjects[0])

  return {
    valid: missing.length === 0,
    routeGroups: routes.size,
    exactSubjects: manifest.subjects.length,
    genericFutureH1:
      expectedGeneric.length - missing.filter((row) => row !== twyneSubjects[0]).length,
    twynePtFutureH1: missing.includes(twyneSubjects[0]) ? 0 : 1,
    missing: missing.map(identity),
  }
}

export async function auditCoverage(sql) {
  await assertModelGuards(sql)
  const manifest = await buildSubjectManifest()
  const [genericRows, twyneRows] = await Promise.all([
    sql`WITH latest_slot AS (
        SELECT slot_at, subject_manifest_sha256
        FROM carry_cash_issue_slots
        WHERE subject_manifest_sha256 = ${manifest.sha256}
          AND slot_at >= date_bin('15 minutes',
            clock_timestamp() - interval '10 minutes',
            '1970-01-01 00:00:00+00'::timestamptz)
        ORDER BY started_at DESC LIMIT 1
      ) SELECT
      m.route_key, m.destination, m.horizon_hours,
      b.asset, b.source_kind, b.source_venue_kind,
      a.route_key AS artifact_route_key, a.destination AS artifact_destination,
      a.asset AS artifact_asset, a.horizon_hours AS artifact_horizon_hours
      FROM carry_cash_model_attempts m
      JOIN latest_slot s USING (slot_at)
      JOIN carry_cash_issue_attempts b USING (slot_at, route_key, destination, horizon_hours)
      JOIN carry_cash_model_artifacts a ON a.sha256 = m.model_artifact_sha256
      CROSS JOIN carry_cash_model_v4_epoch e
      WHERE m.status = 'issued' AND b.status = 'issued' AND m.horizon_hours = 1
        AND b.target_at > clock_timestamp()
        AND b.target_at = b.source_observed_at + interval '1 hour'
        AND b.issued_at - b.source_observed_at <= interval '30 minutes'
        AND m.issued_at >= a.registered_at
        AND (((a.model_version LIKE 'hdelta4-%' OR a.model_version LIKE 'hband4-%')
            AND a.registered_at >= e.activated_at AND m.issued_at >= e.activated_at)
          OR ((a.model_version LIKE 'hdelta3-%' OR a.model_version LIKE 'hband3-%')
            AND a.registered_at < e.activated_at AND m.issued_at < e.activated_at))
      ORDER BY m.route_key, m.destination`,
    sql`WITH latest_twyne_issue AS MATERIALIZED (
      SELECT *
      FROM twyne_pt_model_issues
      WHERE slot_at >= date_bin('15 minutes',
        clock_timestamp() - interval '10 minutes',
        '1970-01-01 00:00:00+00'::timestamptz)
      ORDER BY slot_at DESC, issued_at DESC
      LIMIT 1
    ) SELECT i.route_key, i.wrapper, i.metric, i.horizon_hours,
      a.route_key AS artifact_route_key, a.wrapper AS artifact_wrapper,
      a.pt AS artifact_pt, a.atoken AS artifact_atoken, a.pool AS artifact_pool,
      a.horizon_hours AS artifact_horizon_hours
      FROM latest_twyne_issue i
      JOIN twyne_pt_model_artifacts a ON a.sha256 = i.artifact_sha256
      WHERE i.status = 'issued' AND i.target_at > clock_timestamp()
        AND i.issued_at >= a.registered_at
        AND a.model_version LIKE 'hband1-%'
      ORDER BY i.issued_at DESC`,
  ])
  return evaluateCoverage(manifest, genericRows, twyneRows)
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('coverage_database_url_required')
  const result = await auditCoverage(neon(url))
  if (!result.valid) {
    process.stderr.write(
      `carry-forecast-coverage: missing future H1: ${result.missing.join('; ')}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`carry-forecast-coverage: ${error.message}\n`)
    process.exitCode = 1
  })
}
