import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNowSchedule } from './scrvusd-now-schedule.mjs'
import { buildAttemptStartV1 } from './scrvusd-exit-forecast-issue.mjs'
import { HOLDER, Q_ASSETS_RAW, ROUTE } from './scrvusd-now-schedule.mjs'
import {
  createPgNowAttemptStore,
  createPgNowAsOfStore,
  createPgNowScheduleStore,
  verifyManifestVisibility,
  verifyPersistedNowSchedule,
} from './scrvusd-now-schedule-db.mjs'

const clock = '2030-01-01T00:00:00.000Z'
const startAtUtc = '2030-01-01T03:00:00.000Z'
const endAtUtc = '2030-01-01T05:00:00.000Z'
const manifest = createNowSchedule({ plannedAtUtc: clock, startAtUtc, endAtUtc })
const audit = Object.fromEntries(
  [
    'direct_login_role',
    'ordinary_role',
    'no_create',
    'schema_usage',
    'no_direct_write',
    'can_read',
    'no_table_owner_membership',
    'no_function_owner_membership',
    'common_protected_owner',
    'restricted_inbound_role_membership',
    'exclusive_function_acl',
    'can_publish',
    'can_confirm',
    'can_witness_manifest',
  ].map((name) => [name, true]),
)
const persisted = {
  manifest_sha256: manifest.sha256,
  payload: JSON.stringify(manifest),
  planned_at: clock,
  start_at: startAtUtc,
  end_at: endAtUtc,
  persisted_at: '2030-01-01T00:00:01.000Z',
  publisher_xid: '101',
  confirmed_at: '2030-01-01T00:00:02.000Z',
  confirmer_xid: '102',
  manifest_visible_at: '2030-01-01T00:00:03.000Z',
  witness_xid: '103',
}

const attemptAuditForAsOf = Object.fromEntries(
  [
    'direct_attempt_login_role',
    'ordinary_attempt_role',
    'no_attempt_create',
    'no_attempt_direct_write',
    'can_read_attempts',
    'no_attempt_owner_membership',
    'no_attempt_function_owner_membership',
    'common_attempt_protected_owner',
    'restricted_attempt_inbound_membership',
    'exclusive_attempt_function_acl',
    'can_start',
    'can_confirm_starts',
    'can_mark_floor',
    'can_result',
    'can_confirm_run',
  ].map((name) => [name, true]),
)
const asofAudit = Object.fromEntries(
  [
    'direct_asof_login_role',
    'ordinary_asof_role',
    'no_asof_create',
    'no_asof_direct_write',
    'can_read_asof',
    'no_asof_table_owner_membership',
    'no_asof_function_owner_membership',
    'common_asof_protected_owner',
    'restricted_asof_inbound_membership',
    'exclusive_asof_function_acl',
    'can_start_source',
    'can_witness_run',
    'can_record_score',
    'can_witness_score',
  ].map((name) => [name, true]),
)

function witnessedCohortFixture() {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const seal = (body) => ({ ...body, sha256: digest(JSON.stringify(body)) })
  const slotId = manifest.slots[0].slotId
  const issuedAtUtc = '2030-01-01T03:05:00.000Z'
  const targetUtc = '2030-01-01T04:05:00.000Z'
  const deadlineUtc = '2030-01-01T05:35:00.000Z'
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scheduleBinding: {
      manifestSha256: manifest.sha256,
      slotId,
      attemptStart: { logicalSha256: 'b'.repeat(64) },
    },
    horizonSeconds: 3600,
    holder: HOLDER,
    qAssetsRaw: Q_ASSETS_RAW,
    route: ROUTE,
    issuedAtUtc,
    targetUtc,
    outcomeProtocol: { targetUtc, checkpointSelection: { captureDeadlineUtc: deadlineUtc } },
    anchorBlock: { number: 123, hash: `0x${'c'.repeat(64)}` },
  })
  const issuePayload = JSON.stringify(issue)
  const issueFilename = `${String(123).padStart(12, '0')}-${'c'.repeat(64)}-3600s-${'b'.repeat(64)}-${issue.sha256}.json`
  const score = seal({
    study: 'scrvusd-now-origin-exit-forecast-score-v2',
    issue: {
      filename: issueFilename,
      logicalSha256: issue.sha256,
      physicalSha256: digest(`${issuePayload}\n`),
    },
    horizonSeconds: 3600,
    targetUtc,
    evidenceCutoffUtc: deadlineUtc,
    scoredAtUtc: '2030-01-01T05:40:00.000Z',
    pointOutcome: { holder: HOLDER, qAssetsRaw: Q_ASSETS_RAW, route: ROUTE, status: 'revert' },
  })
  const scorePayload = JSON.stringify(score)
  const run = {
    manifest_sha256: manifest.sha256,
    slot_id: slotId,
    run_visible_at: '2030-01-01T03:10:00.000Z',
    witness_xid: '209',
    confirmed_at: '2030-01-01T03:09:00.000Z',
    confirmer_xid: '208',
    source_start_at: '2030-01-01T03:01:00.000Z',
    source_start_xid: '207',
    nonce_sha256: 'd'.repeat(64),
    manifest_payload: JSON.stringify(manifest),
  }
  const arms = [3600, 7200, 86400, 604800].map((horizon, index) => ({
    manifest_sha256: manifest.sha256,
    slot_id: slotId,
    horizon_seconds: horizon,
    status: ['issued', 'abstained', 'failed', 'unknown'][index],
    reason: ['issued', 'source_unavailable', 'process_failure', 'other'][index],
    issue_logical_sha256: index === 0 ? issue.sha256 : null,
    issue_physical_sha256: index === 0 ? digest(`${issuePayload}\n`) : null,
    issue_payload: index === 0 ? issuePayload : null,
    local_issued_at: index === 0 ? issuedAtUtc : null,
    result_at: `2030-01-01T03:0${5 + index}:00.000Z`,
    result_xid: String(301 + index),
  }))
  const scored = {
    manifest_sha256: manifest.sha256,
    slot_id: slotId,
    horizon_seconds: 3600,
    issue_logical_sha256: issue.sha256,
    issue_physical_sha256: digest(`${issuePayload}\n`),
    score_filename: issueFilename,
    score_logical_sha256: score.sha256,
    score_physical_sha256: digest(`${scorePayload}\n`),
    score_payload: scorePayload,
    score_recorded_at: '2030-01-01T05:40:00.000Z',
    score_xid: '401',
    score_visible_at: '2030-01-01T05:41:00.000Z',
    witness_xid: '402',
  }
  return { run, arms, scored, issue, score }
}

function cohortPool({ runs, arms, scores }) {
  const calls = []
  const pool = {
    calls,
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args })
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS direct_attempt_login_role')) return { rows: [attemptAuditForAsOf] }
          if (sql.includes('AS direct_asof_login_role')) return { rows: [asofAudit] }
          if (sql.includes('m.payload AS manifest_payload'))
            return {
              rows: runs.filter((row) => Date.parse(row.run_visible_at) <= Date.parse(args[0])),
            }
          if (sql.includes('JOIN public.scrvusd_now_arm_results r'))
            return {
              rows: arms.filter((arm) =>
                runs.some(
                  (run) =>
                    run.manifest_sha256 === arm.manifest_sha256 &&
                    run.slot_id === arm.slot_id &&
                    Date.parse(run.run_visible_at) <= Date.parse(args[0]),
                ),
              ),
            }
          if (sql.includes('JOIN public.scrvusd_now_score_visibility w'))
            return {
              rows: scores.filter((row) => Date.parse(row.score_visible_at) <= Date.parse(args[0])),
            }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  return pool
}

function censusRow(index, overrides = {}) {
  const slot = manifest.slots[index]
  return {
    ...persisted,
    slot_id: slot.slotId,
    scheduled_at_utc: slot.scheduledAtUtc,
    closes_at_utc: slot.closesAtUtc,
    started_count: '0',
    result_count: '0',
    starts_confirmed_at: null,
    capture_floor_at: null,
    source_start_at: null,
    run_confirmed_at: null,
    run_visible_at: null,
    manifest_visible_at: persisted.manifest_visible_at,
    manifest_witness_xid: persisted.witness_xid,
    ...overrides,
  }
}

function censusPool(rows) {
  const calls = []
  return {
    calls,
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args })
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS direct_attempt_login_role')) return { rows: [attemptAuditForAsOf] }
          if (sql.includes('AS direct_asof_login_role')) return { rows: [asofAudit] }
          if (sql.includes('AS started_count'))
            return {
              rows: rows
                .filter(
                  (row) =>
                    Date.parse(row.persisted_at) <= Date.parse(args[0]) &&
                    Date.parse(row.scheduled_at_utc) <= Date.parse(args[0]),
                )
                .map((row) =>
                  row.manifest_visible_at != null &&
                  Date.parse(row.manifest_visible_at) > Date.parse(args[0])
                    ? { ...row, manifest_visible_at: null, manifest_witness_xid: null }
                    : row,
                ),
            }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
}

test('readback accepts only exact canonical manifest and distinct timely confirmation', () => {
  const verified = verifyPersistedNowSchedule(persisted, manifest.sha256)
  assert.equal(verified.prospectiveScheduleConfirmed, true)
  assert.equal(verified.runCoverageConfirmed, false)
  assert.equal(verified.calibratedForecastEligible, false)
  assert.equal(verified.publisherXid, '101')
  assert.throws(() =>
    verifyPersistedNowSchedule({ ...persisted, confirmer_xid: '101' }, manifest.sha256),
  )
  assert.throws(() =>
    verifyPersistedNowSchedule(
      {
        ...persisted,
        confirmed_at: '2030-01-01T01:00:01.000Z',
      },
      manifest.sha256,
    ),
  )
  const { sha256: _oldSha, ...unsigned } = manifest
  const offsetUnsigned = { ...unsigned, plannedAtUtc: '2029-12-31T19:00:00.000-05:00' }
  const offsetManifest = {
    ...offsetUnsigned,
    sha256: createHash('sha256').update(JSON.stringify(offsetUnsigned)).digest('hex'),
  }
  assert.throws(() =>
    verifyPersistedNowSchedule(
      {
        ...persisted,
        manifest_sha256: offsetManifest.sha256,
        payload: JSON.stringify(offsetManifest),
      },
      offsetManifest.sha256,
    ),
  )
  assert.throws(() =>
    verifyPersistedNowSchedule(
      {
        ...persisted,
        payload: JSON.stringify({ ...manifest, scope: { ...manifest.scope, holder: 'wrong' } }),
      },
      manifest.sha256,
    ),
  )
  assert.throws(() =>
    verifyPersistedNowSchedule(
      {
        ...persisted,
        payload: JSON.stringify({ sha256: manifest.sha256, ...manifest }),
      },
      manifest.sha256,
    ),
  )
  assert.throws(() => verifyPersistedNowSchedule(persisted, '0'.repeat(64)))
})

test('manifest visibility requires a separate timely post-confirmation transaction', () => {
  const verified = verifyManifestVisibility(persisted, manifest.sha256)
  assert.equal(verified.manifestVisibleAtUtc, persisted.manifest_visible_at)
  assert.equal(verified.historicalPublicationAvailabilityCertified, true)
  for (const row of [
    { ...persisted, witness_xid: persisted.publisher_xid },
    { ...persisted, witness_xid: persisted.confirmer_xid },
    { ...persisted, manifest_visible_at: '2030-01-01T01:00:01.000Z' },
    { ...persisted, manifest_visible_at: '2030-01-01T00:00:01.000Z' },
  ])
    assert.throws(() => verifyManifestVisibility(row, manifest.sha256))
})

test('publish commits before distinct confirmation transaction and verifies readback', async () => {
  const calls = []
  let committedManifest = false
  let committedConfirmation = false
  let committedWitness = false
  let writeCommits = 0
  const pool = {
    async connect() {
      let transaction = ''
      return {
        async query(sql, args) {
          calls.push({ sql, args })
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.startsWith('BEGIN')) {
            transaction = sql
            return { rows: [] }
          }
          if (sql === 'COMMIT') {
            if (transaction.includes('SERIALIZABLE')) {
              writeCommits++
              if (writeCommits === 1) committedManifest = true
              if (writeCommits === 2) committedConfirmation = true
              if (writeCommits === 3) committedWitness = true
            }
            transaction = ''
            return { rows: [] }
          }
          if (sql === 'ROLLBACK') return { rows: [] }
          if (sql.includes('clock_timestamp() AS now')) return { rows: [{ now: clock }] }
          if (sql.includes('publish_scrvusd_now_manifest')) {
            assert.equal(args[0], persisted.payload)
            const { sha256: _sha, ...body } = manifest
            assert.equal(args[1], JSON.stringify(body))
            return {
              rows: [
                {
                  manifest_sha256: manifest.sha256,
                  inserted: true,
                  persisted_at: persisted.persisted_at,
                },
              ],
            }
          }
          if (sql.includes('confirm_scrvusd_now_manifest')) {
            assert.equal(committedManifest, true)
            assert.equal(committedConfirmation, false)
            return {
              rows: [
                {
                  manifest_sha256: manifest.sha256,
                  inserted: true,
                  confirmed_at: persisted.confirmed_at,
                },
              ],
            }
          }
          if (sql.includes('witness_scrvusd_now_manifest')) {
            assert.equal(committedConfirmation, true)
            assert.equal(committedWitness, false)
            return {
              rows: [
                {
                  manifest_visible_at: persisted.manifest_visible_at,
                  witness_xid: persisted.witness_xid,
                },
              ],
            }
          }
          if (sql.includes('FROM public.scrvusd_now_manifest_visibility v')) {
            assert.equal(committedWitness, true)
            return { rows: [persisted] }
          }
          if (sql.includes('FROM public.scrvusd_now_manifests m')) {
            assert.equal(committedConfirmation, true)
            return { rows: [persisted] }
          }
          throw new Error('Unexpected SQL')
        },
        release() {},
      }
    },
  }
  const output = await createPgNowScheduleStore(pool).publishFuture({ startAtUtc, endAtUtc })
  assert.equal(output.manifestSha256, manifest.sha256)
  assert.equal(output.confirmedAtUtc, persisted.confirmed_at)
  assert.equal(output.manifestVisibleAtUtc, persisted.manifest_visible_at)
  assert.equal(output.historicalPublicationAvailabilityCertified, true)
  assert.equal(calls.filter((call) => call.sql === 'COMMIT').length, 5)
  assert.equal(calls.filter((call) => call.sql === 'ROLLBACK').length, 0)
})

test('publisher role audit fails closed before a write', async () => {
  let writes = 0
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('AS direct_login_role'))
            return { rows: [{ ...audit, can_confirm: false }] }
          writes += 1
          throw new Error('write should not run')
        },
        release() {},
      }
    },
  }
  await assert.rejects(
    createPgNowScheduleStore(pool).publishFuture({ startAtUtc, endAtUtc }),
    /role audit failed/,
  )
  assert.equal(writes, 0)
})

test('exact manifest reconciliation seals a committed publish and replays its witness', async () => {
  let confirmed = false
  let witnessed = false
  let confirmations = 0
  let witnessCalls = 0
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
          if (
            sql.includes('FROM public.scrvusd_now_manifest_confirmations c') &&
            sql.includes('JOIN public.scrvusd_now_manifests m')
          )
            return { rows: witnessed ? [persisted] : [] }
          if (sql.includes('FROM public.scrvusd_now_manifest_visibility v'))
            return { rows: witnessed ? [persisted] : [] }
          if (sql.includes('FROM public.scrvusd_now_manifests m'))
            return { rows: confirmed ? [persisted] : [] }
          if (sql.includes('confirm_scrvusd_now_manifest')) {
            assert.deepEqual(args, [manifest.sha256])
            confirmations++
            confirmed = true
            return {
              rows: [
                {
                  manifest_sha256: manifest.sha256,
                  confirmed_at: persisted.confirmed_at,
                  inserted: true,
                },
              ],
            }
          }
          if (sql.includes('witness_scrvusd_now_manifest')) {
            assert.equal(confirmed, true)
            witnessCalls++
            witnessed = true
            return {
              rows: [
                {
                  manifest_visible_at: persisted.manifest_visible_at,
                  witness_xid: persisted.witness_xid,
                },
              ],
            }
          }
          throw new Error('Unexpected SQL')
        },
        release() {},
      }
    },
  }
  const store = createPgNowScheduleStore(pool)
  const first = await store.reconcileFuture(manifest.sha256)
  const second = await store.reconcileFuture(manifest.sha256)
  assert.equal(first.manifestVisibleAtUtc, second.manifestVisibleAtUtc)
  assert.equal(first.witnessXid, second.witnessXid)
  assert.equal(confirmations, 1)
  assert.equal(witnessCalls, 2)
})

test('attempt start binds exact local bytes and commits before confirming four starts', async () => {
  const slot = manifest.slots[0]
  const startReceipt = buildAttemptStartV1({
    manifest,
    slotId: slot.slotId,
    horizonSeconds: 3600,
    recordedAtUtc: '2030-01-01T03:00:01.000Z',
  })
  const physicalSha256 = createHash('sha256')
    .update(`${JSON.stringify(startReceipt)}\n`)
    .digest('hex')
  const attemptAudit = Object.fromEntries(
    [
      'no_attempt_direct_write',
      'can_read_attempts',
      'no_attempt_owner_membership',
      'no_attempt_function_owner_membership',
      'direct_attempt_login_role',
      'ordinary_attempt_role',
      'no_attempt_create',
      'common_attempt_protected_owner',
      'restricted_attempt_inbound_membership',
      'exclusive_attempt_function_acl',
      'can_start',
      'can_confirm_starts',
      'can_mark_floor',
      'can_result',
      'can_confirm_run',
    ].map((key) => [key, true]),
  )
  const calls = []
  let commits = 0
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push(sql)
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS no_attempt_direct_write')) return { rows: [attemptAudit] }
          if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] }
          if (sql === 'COMMIT') {
            commits += 1
            return { rows: [] }
          }
          if (sql.includes('start_scrvusd_now_arm')) {
            assert.equal(args[3], startReceipt.sha256)
            assert.equal(args[4], physicalSha256)
            assert.equal(args[6], JSON.stringify(startReceipt))
            return { rows: [{ started_at: '2030-01-01T03:00:02.000Z', start_xid: '201' }] }
          }
          if (sql.includes('confirm_scrvusd_now_starts')) {
            assert.equal(commits, 1)
            return { rows: [{ confirmed_at: '2030-01-01T03:00:03.000Z', confirmer_xid: '202' }] }
          }
          if (sql.includes('mark_scrvusd_now_capture_floor')) {
            assert.equal(commits, 2)
            return { rows: [{ visible_at: '2030-01-01T03:00:04.000Z', visibility_xid: '203' }] }
          }
          if (sql.includes('FROM public.scrvusd_now_arm_starts a')) return { rows: [] }
          if (sql.includes('FROM public.scrvusd_now_manifests m')) {
            assert.equal(commits, 3)
            return {
              rows: [
                {
                  payload: JSON.stringify(manifest),
                  start_confirmed_at: '2030-01-01T03:00:03.000Z',
                  capture_floor_at: '2030-01-01T03:00:04.000Z',
                  run_confirmed_at: null,
                },
              ],
            }
          }
          throw new Error(`Unexpected SQL: ${sql}`)
        },
        release() {},
      }
    },
  }
  const store = createPgNowAttemptStore(pool)
  await assert.rejects(
    store.startArm({
      manifest,
      slotId: slot.slotId,
      horizonSeconds: 3600,
      startReceipt,
      physicalSha256: '0'.repeat(64),
    }),
    /Exact canonical/,
  )
  assert.equal(calls.length, 0)
  const started = await store.startArm({
    manifest,
    slotId: slot.slotId,
    horizonSeconds: 3600,
    startReceipt,
    physicalSha256,
  })
  assert.equal(started.status, 'start_committed_result_missing')
  const confirmed = await store.confirmStarts({
    manifestSha256: manifest.sha256,
    slotId: slot.slotId,
  })
  assert.equal(confirmed.sourceCaptureFloorUtc, '2030-01-01T03:00:04.000Z')
  assert.equal(confirmed.runCoverageConfirmed, false)
  assert.equal(commits, 4)
})

test('readback keeps missing starts, missing results, and unconfirmed run distinct', async () => {
  const slot = manifest.slots[0]
  const first = buildAttemptStartV1({
    manifest,
    slotId: slot.slotId,
    horizonSeconds: 3600,
    recordedAtUtc: '2030-01-01T03:00:01.000Z',
  })
  const second = buildAttemptStartV1({
    manifest,
    slotId: slot.slotId,
    horizonSeconds: 7200,
    recordedAtUtc: '2030-01-01T03:00:01.000Z',
  })
  const row = (receipt, status) => ({
    horizon_seconds: receipt.horizonSeconds,
    start_payload: JSON.stringify(receipt),
    start_logical_sha256: receipt.sha256,
    start_physical_sha256: createHash('sha256')
      .update(`${JSON.stringify(receipt)}\n`)
      .digest('hex'),
    started_at: '2030-01-01T03:00:02.000Z',
    start_xid: '301',
    status,
    result_at: status ? '2030-01-01T03:00:06.000Z' : null,
    result_xid: status ? '304' : null,
    issue_payload: null,
  })
  const attemptAudit = Object.fromEntries(
    [
      'no_attempt_direct_write',
      'can_read_attempts',
      'no_attempt_owner_membership',
      'no_attempt_function_owner_membership',
      'direct_attempt_login_role',
      'ordinary_attempt_role',
      'no_attempt_create',
      'common_attempt_protected_owner',
      'restricted_attempt_inbound_membership',
      'exclusive_attempt_function_acl',
      'can_start',
      'can_confirm_starts',
      'can_mark_floor',
      'can_result',
      'can_confirm_run',
    ].map((key) => [key, true]),
  )
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS no_attempt_direct_write')) return { rows: [attemptAudit] }
          if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] }
          if (sql.includes('FROM public.scrvusd_now_arm_starts a'))
            return { rows: [row(first, 'abstained'), row(second, null)] }
          if (sql.includes('FROM public.scrvusd_now_manifests m'))
            return {
              rows: [
                {
                  payload: JSON.stringify(manifest),
                  start_confirmed_at: null,
                  start_confirmer_xid: null,
                  capture_floor_at: null,
                  capture_floor_xid: null,
                  run_confirmed_at: null,
                  run_confirmer_xid: null,
                },
              ],
            }
          throw new Error(`Unexpected SQL: ${sql}`)
        },
        release() {},
      }
    },
  }
  const report = await createPgNowAttemptStore(pool).readRun({
    manifestSha256: manifest.sha256,
    slotId: slot.slotId,
  })
  assert.deepEqual(
    report.arms.map((arm) => arm.status),
    ['abstained', 'result_missing', 'start_missing', 'start_missing'],
  )
  assert.equal(report.runCoverageConfirmed, false)
  assert.equal(report.calibratedForecastEligible, false)
  assert.equal(report.arms[0].startXid, '301')
  assert.equal(report.arms[0].resultXid, '304')
  assert.equal(report.arms[0].startPayload, JSON.stringify(first))
  assert.equal(report.arms[0].issuePayload, null)
})

test('as-of source start is read in a distinct transaction before receipt is returned', async () => {
  const calls = []
  const manifestSha256 = 'a'.repeat(64)
  const slotId = 'b'.repeat(64)
  const nonceSha256 = 'c'.repeat(64)
  const startAt = '2030-01-01T03:00:10.000Z'
  const floorAt = '2030-01-01T03:00:05.000Z'
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql)
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS direct_attempt_login_role')) return { rows: [attemptAuditForAsOf] }
          if (sql.includes('AS direct_asof_login_role')) return { rows: [asofAudit] }
          if (sql.includes('FROM public.start_scrvusd_now_source('))
            return { rows: [{ source_start_at: startAt, source_start_xid: '104' }] }
          if (sql.includes('FROM public.scrvusd_now_source_starts s'))
            return {
              rows: [
                {
                  nonce_sha256: nonceSha256,
                  floor_xid: '103',
                  source_start_at: startAt,
                  source_start_xid: '104',
                  capture_floor_at: floorAt,
                  capture_floor_xid: '103',
                },
              ],
            }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const receipt = await createPgNowAsOfStore(pool).startSource({
    manifestSha256,
    slotId,
    nonceSha256,
  })
  assert.equal(receipt.sourceStartAtUtc, startAt)
  assert.equal(receipt.sourceCollectionIndependentlyTimed, false)
  assert.ok(
    calls.indexOf('COMMIT') <
      calls.findIndex((sql) => sql.includes('FROM public.scrvusd_now_source_starts s')),
  )
  assert.equal(calls.filter((sql) => sql.includes('AS direct_asof_login_role')).length, 2)
})

test('as-of score readback rejects changed exact bytes and fails role audit before query', async () => {
  const manifestSha256 = 'a'.repeat(64)
  const slotId = 'b'.repeat(64)
  const badScore = {
    study: 'scrvusd-now-origin-exit-forecast-score-v2',
    issue: {
      filename: 'issue.json',
      logicalSha256: 'c'.repeat(64),
      physicalSha256: 'd'.repeat(64),
    },
    horizonSeconds: 3600,
    sha256: 'e'.repeat(64),
  }
  let scoreQueries = 0
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS direct_attempt_login_role')) return { rows: [attemptAuditForAsOf] }
          if (sql.includes('AS direct_asof_login_role')) return { rows: [asofAudit] }
          if (sql.includes('FROM public.scrvusd_now_scores s')) {
            scoreQueries++
            return {
              rows: [
                {
                  issue_logical_sha256: 'c'.repeat(64),
                  issue_physical_sha256: 'd'.repeat(64),
                  arm_issue_logical_sha256: 'c'.repeat(64),
                  arm_issue_physical_sha256: 'd'.repeat(64),
                  score_filename: 'issue.json',
                  score_logical_sha256: 'e'.repeat(64),
                  score_physical_sha256: 'f'.repeat(64),
                  score_payload: JSON.stringify(badScore),
                  score_recorded_at: clock,
                  score_xid: '105',
                  score_visible_at: null,
                  witness_xid: null,
                },
              ],
            }
          }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const store = createPgNowAsOfStore(pool)
  await assert.rejects(
    store.readScoreWitness({ manifestSha256, slotId, horizonSeconds: 3600 }),
    /Committed score bytes/,
  )
  assert.equal(scoreQueries, 1)
  asofAudit.can_read_asof = false
  await assert.rejects(
    store.readScoreWitness({ manifestSha256, slotId, horizonSeconds: 3600 }),
    /role audit failed/,
  )
  assert.equal(scoreQueries, 1)
  asofAudit.can_read_asof = true
})

test('score recording requires retained canonical issue and score files before database write', async () => {
  let connected = false
  const store = createPgNowAsOfStore({
    async connect() {
      connected = true
      throw new Error('unexpected database access')
    },
  })
  await assert.rejects(
    store.recordScore({
      manifestSha256: 'a'.repeat(64),
      slotId: 'b'.repeat(64),
      horizonSeconds: 3600,
      issueFilename: 'missing.json',
      issueOut: '/private/tmp/no-such-v2-issues',
      scoreOut: '/private/tmp/no-such-v2-scores',
    }),
  )
  assert.equal(connected, false)
})

test('score recording stores exact retained v2 bytes before any visibility witness', async () => {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const seal = (body) => ({ ...body, sha256: digest(JSON.stringify(body)) })
  const root = mkdtempSync(join(tmpdir(), 'scrvusd-asof-score-'))
  const issueOut = join(root, 'issues')
  const scoreOut = join(root, 'scores')
  mkdirSync(issueOut)
  mkdirSync(scoreOut)
  const manifestSha256 = 'a'.repeat(64)
  const slotId = 'b'.repeat(64)
  const issueFilename = 'bound-v2.json'
  const issuedAtUtc = '2026-09-01T00:00:00.000Z'
  const targetUtc = '2026-09-01T01:00:00.000Z'
  const captureDeadlineUtc = '2026-09-01T02:30:00.000Z'
  const holder = '0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e'
  const qAssetsRaw = '1000000000000000000000'
  const route = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scheduleBinding: { manifestSha256, slotId },
    horizonSeconds: 3600,
    issuedAtUtc,
    targetUtc,
    outcomeProtocol: { targetUtc, checkpointSelection: { captureDeadlineUtc } },
    holder,
    qAssetsRaw,
    route,
  })
  const issueBytes = `${JSON.stringify(issue)}\n`
  const score = seal({
    study: 'scrvusd-now-origin-exit-forecast-score-v2',
    issue: {
      filename: issueFilename,
      logicalSha256: issue.sha256,
      physicalSha256: digest(issueBytes),
    },
    horizonSeconds: 3600,
    scoredAtUtc: '2026-09-01T02:59:00.000Z',
    targetUtc,
    evidenceCutoffUtc: captureDeadlineUtc,
    pointOutcome: { status: 'success', holder, qAssetsRaw, route },
  })
  const scorePayload = JSON.stringify(score)
  const scoreBytes = `${scorePayload}\n`
  writeFileSync(join(issueOut, issueFilename), issueBytes)
  writeFileSync(join(scoreOut, issueFilename), scoreBytes)
  const recordAt = '2030-01-01T03:00:00.000Z'
  const calls = []
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args })
          if (sql.includes('AS direct_login_role')) return { rows: [audit] }
          if (sql.includes('AS direct_attempt_login_role')) return { rows: [attemptAuditForAsOf] }
          if (sql.includes('AS direct_asof_login_role')) return { rows: [asofAudit] }
          if (sql.includes('FROM public.record_scrvusd_now_score('))
            return { rows: [{ score_recorded_at: recordAt, score_xid: '108' }] }
          if (sql.includes('FROM public.scrvusd_now_scores s'))
            return {
              rows: [
                {
                  issue_logical_sha256: issue.sha256,
                  issue_physical_sha256: digest(issueBytes),
                  arm_issue_logical_sha256: issue.sha256,
                  arm_issue_physical_sha256: digest(issueBytes),
                  score_filename: issueFilename,
                  score_logical_sha256: score.sha256,
                  score_physical_sha256: digest(scoreBytes),
                  score_payload: scorePayload,
                  score_recorded_at: recordAt,
                  score_xid: '108',
                  score_visible_at: null,
                  witness_xid: null,
                },
              ],
            }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  try {
    const recorded = await createPgNowAsOfStore(pool).recordScore({
      manifestSha256,
      slotId,
      horizonSeconds: 3600,
      issueFilename,
      issueOut,
      scoreOut,
    })
    assert.equal(recorded.scoreLogicalSha256, score.sha256)
    assert.equal(recorded.scoreVisibleAtUtc, null)
    assert.equal(recorded.historicalAvailabilityCertifiedForScore, false)
    const call = calls.find((entry) => entry.sql.includes('FROM public.record_scrvusd_now_score('))
    assert.equal(call.args.at(-1), scorePayload)
    assert.ok(
      calls.findIndex((entry) => entry.sql === 'COMMIT') <
        calls.findIndex((entry) => entry.sql.includes('FROM public.scrvusd_now_scores s')),
    )
    const priorWrites = calls.filter((entry) =>
      entry.sql.includes('FROM public.record_scrvusd_now_score('),
    ).length
    for (const changed of [
      { pointOutcome: { holder: 'wrong', qAssetsRaw, route } },
      { targetUtc: '2026-09-01T02:00:00.000Z' },
      { evidenceCutoffUtc: '2026-09-01T02:00:00.000Z' },
      { scoredAtUtc: '2026-09-01T02:00:00.000Z' },
      { scoredAtUtc: '2026-09-01T02:59:00+00:00' },
      { scoredAtUtc: null },
      { pointOutcome: { status: 'fabricated', holder, qAssetsRaw, route } },
    ]) {
      const malformed = seal({ ...score, ...changed, sha256: undefined })
      writeFileSync(join(scoreOut, issueFilename), `${JSON.stringify(malformed)}\n`)
      await assert.rejects(
        createPgNowAsOfStore(pool).recordScore({
          manifestSha256,
          slotId,
          horizonSeconds: 3600,
          issueFilename,
          issueOut,
          scoreOut,
        }),
        /Exact retained v2 issue\/score bytes required/,
      )
    }
    assert.equal(
      calls.filter((entry) => entry.sql.includes('FROM public.record_scrvusd_now_score(')).length,
      priorWrites,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('historical cohort enumerates all four DB arms and only scores witnessed by cutoff', async () => {
  const { run, arms, scored, issue, score } = witnessedCohortFixture()
  const asOfUtc = '2030-01-01T06:00:00.000Z'
  const pool = cohortPool({ runs: [run], arms, scores: [scored] })
  const result = await createPgNowAsOfStore(pool).listWitnessedCohort({ asOfUtc })
  assert.equal(result.asOfUtc, asOfUtc)
  assert.equal(result.runCount, 1)
  assert.equal(result.armCount, 4)
  assert.equal(result.issuedArmCount, 1)
  assert.equal(result.witnessedScoreCount, 1)
  assert.equal(result.chronologicalBacktestEligible, false)
  assert.deepEqual(
    result.runs[0].arms.map((arm) => arm.status),
    ['issued', 'abstained', 'failed', 'unknown'],
  )
  assert.equal(result.runs[0].arms[0].issue.logicalSha256, issue.sha256)
  assert.equal(result.runs[0].arms[0].score.logicalSha256, score.sha256)
  const beforeScore = await createPgNowAsOfStore(
    cohortPool({ runs: [run], arms, scores: [scored] }),
  ).listWitnessedCohort({ asOfUtc: '2030-01-01T04:00:00.000Z' })
  assert.equal(beforeScore.armCount, 4)
  assert.equal(beforeScore.witnessedScoreCount, 0)
  assert.equal(beforeScore.runs[0].arms[0].score, null)
  const beforeRun = await createPgNowAsOfStore(
    cohortPool({ runs: [run], arms, scores: [scored] }),
  ).listWitnessedCohort({ asOfUtc: '2030-01-01T03:09:59.999Z' })
  assert.equal(beforeRun.runCount, 0)
  assert.equal(beforeRun.armCount, 0)
  assert.equal(pool.calls.filter((call) => call.sql.includes('BEGIN ISOLATION')).length, 1)
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1)
  assert.equal(pool.calls.filter((call) => call.sql.includes('<= $1::timestamptz')).length, 3)
  assert.ok(
    pool.calls.some((call) => call.sql.includes('AND w.score_visible_at <= $1::timestamptz')),
  )
})

test('historical cohort rejects invalid cutoff, incomplete or duplicate arms, and bad score bytes', async () => {
  const { run, arms, scored } = witnessedCohortFixture()
  let connected = false
  await assert.rejects(
    createPgNowAsOfStore({
      async connect() {
        connected = true
        throw new Error('unexpected DB access')
      },
    }).listWitnessedCohort({ asOfUtc: '2030-01-01T01:00:00-05:00' }),
    /Canonical asOfUtc/,
  )
  assert.equal(connected, false)
  for (const rows of [
    arms.slice(1),
    [...arms, arms[0]],
    [{ ...arms[0], status: 'failed' }, ...arms.slice(1)],
  ]) {
    const pool = cohortPool({ runs: [run], arms: rows, scores: [] })
    await assert.rejects(
      createPgNowAsOfStore(pool).listWitnessedCohort({ asOfUtc: '2030-01-01T06:00:00.000Z' }),
    )
    assert.equal(pool.calls.filter((call) => call.sql === 'ROLLBACK').length, 1)
  }
  for (const badScore of [
    { ...scored, score_physical_sha256: '0'.repeat(64) },
    { ...scored, issue_logical_sha256: '0'.repeat(64) },
    { ...scored, witness_xid: scored.score_xid },
  ]) {
    await assert.rejects(
      createPgNowAsOfStore(
        cohortPool({ runs: [run], arms, scores: [badScore] }),
      ).listWitnessedCohort({ asOfUtc: '2030-01-01T06:00:00.000Z' }),
      /Malformed witnessed v2 score/,
    )
  }
})

test('published slot census separates attempted, witnessed, partial and future slots', async () => {
  const rows = [
    censusRow(0, {
      started_count: '4',
      result_count: '4',
      starts_confirmed_at: '2030-01-01T03:01:00.000Z',
      capture_floor_at: '2030-01-01T03:02:00.000Z',
      source_start_at: '2030-01-01T03:03:00.000Z',
      run_confirmed_at: '2030-01-01T03:10:00.000Z',
      run_visible_at: '2030-01-01T03:11:00.000Z',
    }),
    censusRow(1, { started_count: '2', result_count: '0' }),
    censusRow(0, {
      manifest_sha256: '0'.repeat(64),
      persisted_at: '2030-01-01T06:00:00.000Z',
    }),
  ]
  const pool = censusPool(rows)
  const result = await createPgNowAsOfStore(pool).listPublishedSlotCensus({
    asOfUtc: '2030-01-01T04:30:00.000Z',
  })
  assert.equal(result.counts.scheduledByCutoff, 2)
  assert.equal(result.counts.witnessedManifestScheduledByCutoff, 2)
  assert.equal(result.counts.unwitnessedManifestOperationalGaps, 0)
  assert.equal(result.counts.attempted, 2)
  assert.equal(result.counts.witnessed, 1)
  assert.equal(result.counts.partial, 1)
  assert.equal(result.historicalPublicationAvailabilityCertified, false)
  assert.equal(result.certifiedSlots.length, 2)
  assert.equal(result.chronologicalBacktestEligible, false)
  assert.deepEqual(
    result.slots.map((slot) => slot.status),
    ['witnessed', 'partial'],
  )
  const query = pool.calls.find((call) => call.sql.includes('AS started_count'))
  assert.match(query.sql, /WHERE m\.persisted_at <= \$1::timestamptz/)
  assert.match(query.sql, /c\.confirmed_at <= \$1::timestamptz/)
  assert.match(query.sql, /rv\.run_visible_at <= \$1::timestamptz/)
  assert.match(query.sql, /mv\.manifest_visible_at <= \$1::timestamptz/)
  assert.equal(pool.calls.filter((call) => call.sql.includes('BEGIN ISOLATION')).length, 1)
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1)
  const beforeSecond = await createPgNowAsOfStore(censusPool(rows)).listPublishedSlotCensus({
    asOfUtc: '2030-01-01T03:30:00.000Z',
  })
  assert.equal(beforeSecond.counts.scheduledByCutoff, 1)
  const beforeManifestWitness = await createPgNowAsOfStore(
    censusPool([censusRow(0, { manifest_visible_at: '2030-01-01T03:30:00.000Z' })]),
  ).listPublishedSlotCensus({ asOfUtc: '2030-01-01T03:00:00.000Z' })
  assert.equal(beforeManifestWitness.certifiedSlots.length, 0)
  assert.equal(beforeManifestWitness.unwitnessedOperationalGaps.length, 1)
  assert.equal(beforeManifestWitness.slots[0].manifestVisibleAtUtc, null)
})

test('published slot census distinguishes witnessed missed/open slots from unwitnessed publication gaps', async () => {
  const missed = await createPgNowAsOfStore(censusPool([censusRow(0)])).listPublishedSlotCensus({
    asOfUtc: '2030-01-01T04:00:00.000Z',
  })
  assert.equal(missed.slots[0].status, 'missed')
  assert.equal(missed.slots[0].historicalPublicationAvailabilityCertified, true)
  assert.equal(missed.slots[0].operationalStatusHistoricalAvailabilityCertified, false)
  assert.equal(missed.operationalStatusSemantics, 'retrospective_database_timestamps')
  const open = await createPgNowAsOfStore(censusPool([censusRow(0)])).listPublishedSlotCensus({
    asOfUtc: '2030-01-01T03:00:00.000Z',
  })
  assert.equal(open.slots[0].status, 'open_not_attempted')
  const unconfirmed = await createPgNowAsOfStore(
    censusPool([
      censusRow(0, {
        confirmed_at: null,
        confirmer_xid: null,
        manifest_visible_at: null,
        manifest_witness_xid: null,
      }),
    ]),
  ).listPublishedSlotCensus({ asOfUtc: '2030-01-01T04:00:00.000Z' })
  assert.equal(unconfirmed.slots[0].status, 'publication_unconfirmed')
  assert.equal(unconfirmed.slots[0].historicalPublicationAvailabilityCertified, false)
  assert.equal(unconfirmed.certifiedSlots.length, 0)
  assert.equal(unconfirmed.unwitnessedOperationalGaps.length, 1)
  const confirmedOnly = await createPgNowAsOfStore(
    censusPool([censusRow(0, { manifest_visible_at: null, manifest_witness_xid: null })]),
  ).listPublishedSlotCensus({ asOfUtc: '2030-01-01T04:00:00.000Z' })
  assert.equal(confirmedOnly.counts.witnessedManifestScheduledByCutoff, 0)
  assert.equal(confirmedOnly.slots[0].publicationStatus, 'confirmed_timestamp_only')
  await assert.rejects(
    createPgNowAsOfStore(censusPool([censusRow(0), censusRow(0)])).listPublishedSlotCensus({
      asOfUtc: '2030-01-01T04:00:00.000Z',
    }),
    /Malformed or duplicate/,
  )
})
