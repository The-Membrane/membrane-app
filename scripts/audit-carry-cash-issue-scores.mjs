// Read-only structural audit of prospective aggregate-cash issue scores.
// This cannot certify past commit visibility or turn cash into holder exit ability.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'

export async function auditCashIssueScores(sql) {
  const rows = await sql`
    WITH scored_slots AS MATERIALIZED (
      SELECT DISTINCT slot_at FROM carry_cash_issue_scores
    ),
    slot_counts AS MATERIALIZED (
      SELECT a.slot_at, count(*)::integer AS actual_attempts
      FROM carry_cash_issue_attempts a JOIN scored_slots ss USING (slot_at)
      GROUP BY a.slot_at
    ),
    manifest_subjects AS MATERIALIZED (
      SELECT c.slot_at, d.value->>'route_key' AS route_key,
        d.value->>'destination' AS destination,
        count(*)::integer AS declarations, jsonb_agg(d.value)->0 AS subject
      FROM carry_cash_issue_slots c JOIN scored_slots ss USING (slot_at)
      CROSS JOIN LATERAL jsonb_array_elements(c.subject_manifest) d(value)
      GROUP BY c.slot_at, d.value->>'route_key', d.value->>'destination'
    ),
    checked AS (
      SELECT s.status,
        i.slot_at IS NOT NULL AND i.status = 'issued'
          AND i.route_key = s.route_key AND i.destination = s.destination
          AND i.horizon_hours = s.horizon_hours AS issue_ok,
        c.slot_at IS NOT NULL AND i.issued_at = c.started_at
          AND (c.slot_at = date_bin('15 minutes', c.started_at,
            '1970-01-01 00:00:00+00'::timestamptz)
            OR (c.started_at < '2026-09-29 10:00:00+00'::timestamptz
              AND c.slot_at = date_trunc('hour', c.started_at AT TIME ZONE 'UTC')
                AT TIME ZONE 'UTC'))
          AND c.subject_count = 67 AND c.attempt_count = 134
          AND sc.actual_attempts = 134
          AND c.subject_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(c.subject_manifest) = 'array'
          AND jsonb_array_length(c.subject_manifest) = 67 AS slot_ok,
        ms.declarations = 1 AND ms.subject ?& ARRAY[
          'route_key', 'destination', 'source_kind', 'venue_kind', 'asset',
          'cohort_id', 'seed_source_sha256', 'seed_sha256',
          'board_sha256', 'displayed_routes_sha256']
          AND ms.subject->>'source_kind' = i.source_kind
          AND (ms.subject->>'venue_kind') IS NOT DISTINCT FROM i.source_venue_kind
          AND ms.subject->>'asset' = i.asset
          AND (ms.subject->>'cohort_id') IS NOT DISTINCT FROM i.cohort_id
          AND (ms.subject->>'seed_source_sha256') IS NOT DISTINCT FROM i.seed_source_sha256
          AND (ms.subject->>'seed_sha256') IS NOT DISTINCT FROM i.seed_sha256
          AND (ms.subject->>'board_sha256') IS NOT DISTINCT FROM i.board_sha256
          AND (ms.subject->>'displayed_routes_sha256') IS NOT DISTINCT FROM i.displayed_routes_sha256
          AND (NOT (ms.subject ? 'asset_decimals')
            OR ms.subject->>'asset_decimals' = i.asset_decimals::text) AS manifest_ok,
        i.slot_at IS NOT NULL AND s.scored_at >= i.score_after_at
          AND s.scored_at >= i.issued_at AS score_clock_ok,
        i.slot_at IS NOT NULL AND i.forecast_cash_raw = i.source_cash_raw
          AND i.source_block IS NOT NULL AND i.source_block_hash IS NOT NULL
          AND i.source_observed_at IS NOT NULL AND i.source_first_local_receipt_at IS NOT NULL
          AND i.source_observed_at <= i.source_first_local_receipt_at
          AND i.source_first_local_receipt_at <= i.issued_at
          AND i.issued_at - i.source_observed_at <= interval '2 hours'
          AND (
            (i.source_kind = 'vault' AND iv.block IS NOT NULL
              AND iv.block_hash = i.source_block_hash
              AND iv.observed_at = i.source_observed_at
              AND iv.first_local_receipt_at = i.source_first_local_receipt_at
              AND iv.cash_raw = i.source_cash_raw
              AND iv.asset = i.asset AND iv.asset_decimals = i.asset_decimals
              AND iv.cohort_id = i.cohort_id
              AND iv.seed_source_sha256 = i.seed_source_sha256
              AND iv.seed_sha256 = i.seed_sha256
              AND iv.board_sha256 = i.board_sha256
              AND iv.displayed_routes_sha256 = i.displayed_routes_sha256)
            OR (i.source_kind = 'market' AND im.block IS NOT NULL
              AND im.block_hash = i.source_block_hash
              AND im.observed_at = i.source_observed_at
              AND im.first_local_receipt_at = i.source_first_local_receipt_at
              AND im.cash_raw = i.source_cash_raw
              AND im.underlying = i.asset AND im.underlying_decimals = i.asset_decimals
              AND im.venue_kind = i.source_venue_kind AND im.chain_id = 1)
          ) AS issue_source_ok,
        s.status = 'observed' AND i.slot_at IS NOT NULL
          AND s.outcome_block IS NOT NULL AND s.outcome_block_hash IS NOT NULL
          AND s.outcome_observed_at IS NOT NULL
          AND s.outcome_first_local_receipt_at IS NOT NULL
          AND s.outcome_cash_raw IS NOT NULL AND s.absolute_error_raw IS NOT NULL
          AND s.outcome_block > i.source_block
          AND s.outcome_observed_at BETWEEN i.target_low_at AND i.target_high_at
          AND s.outcome_observed_at <= s.outcome_first_local_receipt_at
          AND s.outcome_first_local_receipt_at > i.issued_at
          AND s.outcome_first_local_receipt_at <= i.score_after_at
          AND s.outcome_first_local_receipt_at <= s.scored_at
          AND s.absolute_error_raw = abs(s.outcome_cash_raw - i.forecast_cash_raw)
          AND (
            (i.source_kind = 'vault' AND ov.block IS NOT NULL
              AND ov.block_hash = s.outcome_block_hash
              AND ov.observed_at = s.outcome_observed_at
              AND ov.first_local_receipt_at = s.outcome_first_local_receipt_at
              AND ov.cash_raw = s.outcome_cash_raw
              AND ov.asset = i.asset AND ov.asset_decimals = i.asset_decimals
              AND ov.cohort_id = i.cohort_id
              AND ov.seed_source_sha256 = i.seed_source_sha256
              AND ov.seed_sha256 = i.seed_sha256
              AND ov.board_sha256 = i.board_sha256
              AND ov.displayed_routes_sha256 = i.displayed_routes_sha256)
            OR (i.source_kind = 'market' AND om.block IS NOT NULL
              AND om.block_hash = s.outcome_block_hash
              AND om.observed_at = s.outcome_observed_at
              AND om.first_local_receipt_at = s.outcome_first_local_receipt_at
              AND om.cash_raw = s.outcome_cash_raw
              AND om.underlying = i.asset AND om.underlying_decimals = i.asset_decimals
              AND om.venue_kind = i.source_venue_kind AND om.chain_id = 1)
          ) AS observed_ok,
        s.status = 'censored_missing'
          AND s.outcome_block IS NULL AND s.outcome_block_hash IS NULL
          AND s.outcome_observed_at IS NULL AND s.outcome_first_local_receipt_at IS NULL
          AND s.outcome_cash_raw IS NULL AND s.absolute_error_raw IS NULL AS censored_shape_ok
      FROM carry_cash_issue_scores s
      LEFT JOIN carry_cash_issue_attempts i
        ON i.slot_at = s.slot_at AND i.route_key = s.route_key
        AND i.destination = s.destination AND i.horizon_hours = s.horizon_hours
      LEFT JOIN carry_cash_issue_slots c ON c.slot_at = s.slot_at
      LEFT JOIN slot_counts sc ON sc.slot_at = s.slot_at
      LEFT JOIN manifest_subjects ms
        ON ms.slot_at = s.slot_at AND ms.route_key = s.route_key
        AND ms.destination = s.destination
      LEFT JOIN carry_route_vault_observations iv
        ON i.source_kind = 'vault' AND iv.route_key = i.route_key
        AND iv.vault = i.destination AND iv.block = i.source_block
      LEFT JOIN carry_direct_supply_observations im
        ON i.source_kind = 'market' AND im.route_key = i.route_key
        AND im.destination = i.destination AND im.block = i.source_block
      LEFT JOIN carry_route_vault_observations ov
        ON s.status = 'observed' AND i.source_kind = 'vault'
        AND ov.route_key = s.route_key AND ov.vault = s.destination
        AND ov.block = s.outcome_block
      LEFT JOIN carry_direct_supply_observations om
        ON s.status = 'observed' AND i.source_kind = 'market'
        AND om.route_key = s.route_key AND om.destination = s.destination
        AND om.block = s.outcome_block
    )
    SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE status = 'observed')::integer AS observed,
      count(*) FILTER (WHERE status = 'censored_missing')::integer AS censored_missing,
      count(*) FILTER (WHERE issue_ok IS NOT TRUE)::integer AS bad_issue_links,
      count(*) FILTER (WHERE slot_ok IS NOT TRUE)::integer AS bad_slots,
      count(*) FILTER (WHERE manifest_ok IS NOT TRUE)::integer AS bad_manifest_memberships,
      count(*) FILTER (WHERE score_clock_ok IS NOT TRUE)::integer AS bad_score_clocks,
      count(*) FILTER (WHERE issue_source_ok IS NOT TRUE)::integer AS bad_issue_sources,
      count(*) FILTER (WHERE status = 'observed' AND observed_ok IS NOT TRUE)::integer AS bad_observed,
      count(*) FILTER (WHERE status = 'censored_missing' AND censored_shape_ok IS NOT TRUE)::integer AS bad_censored_shapes,
      count(*) FILTER (WHERE status NOT IN ('observed', 'censored_missing'))::integer AS bad_statuses
    FROM checked`
  if (rows.length !== 1) throw new Error('cash_score_audit_missing_result')
  const fields = [
    'total',
    'observed',
    'censored_missing',
    'bad_issue_links',
    'bad_slots',
    'bad_manifest_memberships',
    'bad_score_clocks',
    'bad_issue_sources',
    'bad_observed',
    'bad_censored_shapes',
    'bad_statuses',
  ]
  const counts = Object.fromEntries(fields.map((field) => [field, Number(rows[0][field])]))
  if (Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new Error('cash_score_audit_invalid_counts')
  if (counts.observed + counts.censored_missing + counts.bad_statuses !== counts.total)
    throw new Error('cash_score_audit_invalid_totals')
  const valid = fields.slice(3).every((field) => counts[field] === 0)
  return {
    valid,
    ...counts,
    retrospectiveCandidateAbsenceCertified: false,
    selectionOptimalityCertified: false,
    independentPublicationCertified: false,
    manifestHashRecomputed: false,
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new Error('usage: node scripts/audit-carry-cash-issue-scores.mjs')
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('DATABASE_URL_UNPOOLED_or_DATABASE_URL_required')
  const result = await auditCashIssueScores(neon(url))
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.valid) process.exitCode = 1
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Database exceptions can contain credentials or source payloads.
    process.stderr.write('Carry cash score audit failed closed.\n')
    process.exitCode = 1
  })
}
