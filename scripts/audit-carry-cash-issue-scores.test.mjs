import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { auditCashIssueScores } from './audit-carry-cash-issue-scores.mjs'

const validRow = {
  total: 3,
  observed: 2,
  censored_missing: 1,
  bad_issue_links: 0,
  bad_slots: 0,
  bad_manifest_memberships: 0,
  bad_score_clocks: 0,
  bad_issue_sources: 0,
  bad_observed: 0,
  bad_censored_shapes: 0,
  bad_statuses: 0,
}

function fakeSql(row) {
  let query
  return {
    sql: async (strings, ...values) => {
      assert.equal(values.length, 0)
      query = strings.join('')
      return [row]
    },
    get query() {
      return query
    },
  }
}

test('audit links both issue and outcome to exact vault/direct source PKs', async () => {
  const db = fakeSql(validRow)
  const result = await auditCashIssueScores(db.sql)
  assert.deepEqual(result, {
    valid: true,
    ...validRow,
    retrospectiveCandidateAbsenceCertified: false,
    selectionOptimalityCertified: false,
    independentPublicationCertified: false,
    manifestHashRecomputed: false,
  })
  const query = db.query
  assert.match(query, /LEFT JOIN carry_cash_issue_attempts i/)
  assert.match(query, /LEFT JOIN carry_cash_issue_slots c ON c\.slot_at = s\.slot_at/)
  assert.match(query, /i\.issued_at = c\.started_at/)
  assert.match(query, /c\.slot_at = date_bin\('15 minutes', c\.started_at/)
  assert.match(query, /c\.started_at < '2026-09-29 10:00:00\+00'/)
  assert.match(query, /sc\.actual_attempts = 134/)
  assert.match(query, /c\.subject_manifest_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(query, /jsonb_array_length\(c\.subject_manifest\) = 67/)
  assert.match(query, /CROSS JOIN LATERAL jsonb_array_elements\(c\.subject_manifest\)/)
  assert.match(query, /ms\.declarations = 1/)
  assert.match(query, /ms\.subject->>'source_kind' = i\.source_kind/)
  assert.match(query, /ms\.subject->>'asset' = i\.asset/)
  assert.match(query, /ms\.subject->>'cohort_id'\) IS NOT DISTINCT FROM i\.cohort_id/)
  assert.match(query, /ms\.subject->>'asset_decimals' = i\.asset_decimals::text/)
  assert.match(query, /i\.slot_at = s\.slot_at.*i\.route_key = s\.route_key/s)
  assert.match(query, /iv\.vault = i\.destination AND iv\.block = i\.source_block/)
  assert.match(query, /im\.destination = i\.destination AND im\.block = i\.source_block/)
  assert.match(query, /ov\.block = s\.outcome_block/)
  assert.match(query, /om\.block = s\.outcome_block/)
  for (const field of [
    'block_hash',
    'observed_at',
    'first_local_receipt_at',
    'cash_raw',
    'asset_decimals',
    'cohort_id',
    'seed_source_sha256',
    'seed_sha256',
    'board_sha256',
    'displayed_routes_sha256',
  ])
    assert.match(query, new RegExp(`ov\\.${field}`))
  assert.match(query, /om\.underlying = i\.asset/)
  assert.match(query, /om\.underlying_decimals = i\.asset_decimals/)
  assert.match(query, /om\.venue_kind = i\.source_venue_kind AND om\.chain_id = 1/)
  assert.match(query, /s\.absolute_error_raw = abs\(s\.outcome_cash_raw - i\.forecast_cash_raw\)/)
  assert.match(query, /s\.outcome_block > i\.source_block/)
  assert.match(query, /s\.outcome_observed_at BETWEEN i\.target_low_at AND i\.target_high_at/)
  assert.match(query, /s\.outcome_first_local_receipt_at > i\.issued_at/)
  assert.match(query, /s\.outcome_first_local_receipt_at <= i\.score_after_at/)
  assert.match(query, /s\.scored_at >= i\.score_after_at/)
})

test('censored audit checks terminal null shape without a retrospective candidate search', async () => {
  const db = fakeSql({ ...validRow, total: 1, observed: 0, censored_missing: 1 })
  await auditCashIssueScores(db.sql)
  assert.match(db.query, /s\.status = 'censored_missing'\s+AND s\.outcome_block IS NULL/)
  assert.match(db.query, /s\.absolute_error_raw IS NULL AS censored_shape_ok/)
  assert.doesNotMatch(db.query, /NOT EXISTS|candidate_absent|ORDER BY abs\(extract/i)
})

test('audit fails closed for broken rows, inconsistent totals, and missing output', async () => {
  for (const field of [
    'bad_observed',
    'bad_slots',
    'bad_manifest_memberships',
    'bad_score_clocks',
  ]) {
    const broken = await auditCashIssueScores(fakeSql({ ...validRow, [field]: 1 }).sql)
    assert.equal(broken.valid, false)
    assert.equal(broken[field], 1)
  }
  await assert.rejects(
    auditCashIssueScores(fakeSql({ ...validRow, total: 4 }).sql),
    /invalid_totals/,
  )
  await assert.rejects(
    auditCashIssueScores(fakeSql({ ...validRow, total: 'bad' }).sql),
    /invalid_counts/,
  )
  await assert.rejects(
    auditCashIssueScores(async () => []),
    /missing_result/,
  )
})

test('CLI exits nonzero without leaking exception details', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'audit-carry-cash-issue-scores.mjs')
  const run = spawnSync(process.execPath, [script, '--invalid'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL_UNPOOLED: 'postgres://secret-marker@invalid/db' },
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Carry cash score audit failed closed/)
  assert.doesNotMatch(run.stderr, /secret-marker|usage:|postgres:\/\//)
})
