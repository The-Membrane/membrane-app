import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSubjectManifest,
  issueCurrentSlot,
  scoreDueIssues,
} from './record-carry-cash-issues.mjs'
import { apply } from './apply-carry-cash-issue-ddl.mjs'

test('pinned Carry manifest has 64 vault route subjects and three exact direct markets', async () => {
  const manifest = await buildSubjectManifest()
  assert.equal(manifest.subjects.length, 67)
  assert.equal(manifest.subjects.filter((row) => row.source_kind === 'vault').length, 64)
  assert.equal(manifest.subjects.filter((row) => row.source_kind === 'market').length, 3)
  assert.equal(
    new Set(manifest.subjects.map((row) => `${row.route_key}\0${row.destination}`)).size,
    67,
  )
  assert.equal(
    manifest.subjects.filter(
      (row) => row.destination === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    ).length,
    1,
  )
  assert.ok(manifest.subjects.every((row) => row.asset?.startsWith('0x')))
  assert.ok(
    manifest.subjects
      .filter((row) => row.source_kind === 'vault')
      .every((row) => row.seed_sha256 && row.board_sha256 && row.displayed_routes_sha256),
  )
  assert.equal(
    manifest.subjects.some((row) => row.route_key === 'USDe → supply on Aave V3'),
    false,
  )
  assert.equal(manifest.sha256.length, 64)
})

test('new Aave USDe supply is tracked with its own exact identity outside the frozen issue cohort', async () => {
  const manifest = await buildSubjectManifest()
  assert.deepEqual(manifest.supplementalSubjects, [
    {
      market_key: 'aaveV3Usde',
      route_key: 'USDe → supply on Aave V3',
      destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
      asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      asset_decimals: 18,
      venue_kind: 'aave_v3_atoken',
      source_kind: 'market',
      cohort_id: 'supplemental-aave-v3-usde-2026-09',
    },
  ])
  assert.equal(manifest.subjects.length, 67)
  assert.equal(
    new Set(
      [...manifest.subjects, ...manifest.supplementalSubjects].map(
        (row) => `${row.route_key}\0${row.destination}`,
      ),
    ).size,
    68,
  )
})

test('issue writes a fixed grid with DB clock, exact receipt provenance and replay check', async () => {
  const manifest = await buildSubjectManifest()
  const queries = []
  const slotAt = new Date('2026-09-29T06:00:00.000Z')
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    queries.push({ query, values })
    if (query.includes('WITH clock AS MATERIALIZED'))
      return [{ slot_at: slotAt, inserted_count: 134 }]
    return [
      {
        subject_manifest_sha256: manifest.sha256,
        exact_manifest: true,
        attempt_count: 134,
        issued_count: 132,
        unassessed_count: 2,
        unavailable_count: 0,
        invalid_count: 0,
      },
    ]
  }
  const result = await issueCurrentSlot(sql, manifest)
  assert.deepEqual(result, {
    slotAt,
    newlyInserted: 134,
    issued: 132,
    unassessed: 2,
    sourceUnavailable: 0,
    sourceInvalid: 0,
  })
  assert.equal(queries.length, 2)
  assert.match(queries[0].query, /clock_timestamp\(\)/)
  assert.match(queries[0].query, /date_bin\('15 minutes', c\.at/)
  assert.match(queries[0].query, /COALESCE\(\(SELECT slot_at FROM slot\)/)
  assert.match(queries[0].query, /VALUES \(1\), \(24\)/)
  assert.match(queries[0].query, /first_local_receipt_at <= slot\.started_at/)
  assert.match(queries[0].query, /slot\.started_at - x\.observed_at > interval '30 minutes'/)
  assert.match(queries[0].query, /v\.seed_sha256 IS DISTINCT FROM s\.seed_sha256/)
  assert.match(queries[0].query, /THEN 'unassessed'/)
  assert.ok(
    queries[0].query.indexOf("WHEN x.block IS NULL THEN 'source_unavailable'") <
      queries[0].query.indexOf("THEN 'unassessed'"),
  )
  assert.match(queries[0].query, /CASE WHEN q\.status = 'issued' THEN x\.cash_raw ELSE NULL END/)
  assert.doesNotMatch(queries[0].query, /Number\(x\.cash_raw\)/)
  assert.equal(queries[1].values[0], manifest.payload)
  assert.equal(queries[1].values[1], slotAt)
})

test('a missing Twyne source is counted as unavailable, not covered by an unassessed value', async () => {
  const manifest = await buildSubjectManifest()
  const sql = async (strings) =>
    strings.join('?').includes('WITH clock AS MATERIALIZED')
      ? [{ slot_at: new Date('2026-09-29T06:00:00.000Z'), inserted_count: 134 }]
      : [
          {
            subject_manifest_sha256: manifest.sha256,
            exact_manifest: true,
            attempt_count: 134,
            issued_count: 132,
            unassessed_count: 0,
            unavailable_count: 2,
            invalid_count: 0,
          },
        ]
  const result = await issueCurrentSlot(sql, manifest)
  assert.equal(result.unassessed, 0)
  assert.equal(result.sourceUnavailable, 2)
})

test('issue replay rejects a changed or partial manifest', async () => {
  const manifest = await buildSubjectManifest()
  const sql = async (strings) =>
    strings.join('?').includes('WITH clock AS MATERIALIZED')
      ? [{ slot_at: new Date('2026-09-29T06:00:00.000Z'), inserted_count: 0 }]
      : [
          {
            subject_manifest_sha256: manifest.sha256,
            exact_manifest: false,
            attempt_count: 134,
            unassessed_count: 2,
          },
        ]
  await assert.rejects(issueCurrentSlot(sql, manifest), /replay_or_integrity_mismatch/)
  await assert.rejects(
    issueCurrentSlot(sql, { ...manifest, sha256: '0'.repeat(64) }),
    /invalid_manifest/,
  )
})

test('scoring seals only due issued rows and accepts later exact receipts before grace close', async () => {
  let query = ''
  const sql = async (strings) => {
    query = strings.join('?')
    return [{ sealed: 3, observed: 2, censored_missing: 1 }]
  }
  assert.deepEqual(await scoreDueIssues(sql), { sealed: 3, observed: 2, censoredMissing: 1 })
  assert.match(query, /i\.status = 'issued' AND i\.score_after_at <= c\.at/)
  assert.match(query, /o\.first_local_receipt_at > i\.issued_at/)
  assert.match(query, /o\.first_local_receipt_at <= i\.score_after_at/)
  assert.match(query, /o\.observed_at BETWEEN i\.target_low_at AND i\.target_high_at/)
  assert.match(query, /'censored_missing'/)
  assert.match(query, /abs\(x\.cash_raw - i\.forecast_cash_raw\)/)
  assert.match(query, /ON CONFLICT \(slot_at, route_key, destination, horizon_hours\) DO NOTHING/)
})

test('DDL defines append-only slots, attempts, scores, exact windows and sealed outcome shape', async () => {
  const statements = []
  const sql = Object.assign(
    async (strings) => {
      statements.push(strings.join('?'))
    },
    {
      query: async (query) => {
        statements.push(query)
      },
    },
  )
  await apply(sql)
  const text = statements.join('\n')
  assert.match(text, /subject_count = 67/)
  assert.match(text, /attempt_count = 134/)
  assert.match(text, /horizon_hours IN \(1, 24\)/)
  assert.match(text, /interval '15 minutes'/)
  assert.match(text, /interval '1 hour'/)
  assert.match(text, /numeric\(78,0\)/)
  assert.match(text, /forecast_cash_raw = source_cash_raw/)
  assert.match(text, /date_bin\('15 minutes', started_at/)
  assert.match(text, /started_at < '2026-09-29 10:00:00\+00'/)
  assert.match(text, /BEFORE UPDATE OR DELETE ON carry_cash_issue_scores/)
  assert.match(text, /BEFORE TRUNCATE ON carry_cash_issue_scores/)
  assert.equal(statements.filter((statement) => statement.includes('CREATE TRIGGER')).length, 6)
})
