import assert from 'node:assert/strict'
import test from 'node:test'
import { issueFirstBreach, scoreFirstBreach } from './aave-usde-first-breach.mjs'
import { buildFirstBreachSchedule, physicalSha256 } from './aave-usde-first-breach-schedule.mjs'
import {
  buildHourlyCoverageManifest,
  physicalSha256 as coverSha,
} from './aave-usde-first-breach-coverage.mjs'
import {
  auditAaveUsdeV2Ledger,
  classifyRequestedIssueCompleteness,
  projectSnapshot,
} from './aave-usde-v2-ledger-audit.mjs'

const base = Date.parse('2026-09-28T00:00:00.000Z')
const hour = 3_600_000
const at = (h, ms = 0) => new Date(base + h * hour + ms).toISOString()
const aToken = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const underlying = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: aToken,
  underlying,
  decimals: 18,
}
const sample = (i) => ({
  id: `sample-${i}`,
  venue: 'aave-v3-usde',
  chain: 'ethereum',
  source: 'observed',
  recorder_atomic_v1: true,
  block: String(100 + i),
  observed_at: at(4 * i),
  created_at: at(4 * i),
  instant_usd: 20_000_000,
  params: {
    kind: 'atoken-liquidity',
    read_block_finalized: true,
    read_block_pinned: true,
    read_block_number: String(100 + i),
    read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
    read_block_time: (base + 4 * i * hour) / 1000 - 600,
    aToken,
    underlying,
    underlyingOnchain: underlying,
    underlyingIdentity: 'match',
    decimalsIdentity: 'match',
    decimals: 18,
    underlyingDecimalsOnchain: 18,
    reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
    underlyingBalance: (20_000_000n * 10n ** 18n).toString(),
    priceAssumptionUsd: 1,
  },
})
const issue = issueFirstBreach(
  Array.from({ length: 7 }, (_, i) => sample(i)),
  { config, anchorId: 'sample-6', issuedAt: at(24), amountUsd: 10_000_000, horizonSeconds: 28_800 },
)
const scheduleBytes = buildFirstBreachSchedule({
  plannedAt: at(23),
  startAt: at(24),
  endExclusiveAt: at(25),
})
const scheduleSha256 = physicalSha256(scheduleBytes)
const manifestBytes = buildHourlyCoverageManifest({
  venue: 'aave-v3-usde',
  startAt: at(24),
  endExclusiveAt: at(41),
  declaredAt: at(23),
  issueSchedulePhysicalSha256: scheduleSha256,
})
const manifestSha256 = coverSha(manifestBytes)
const scheduleJson = JSON.parse(scheduleBytes)
const manifestJson = JSON.parse(manifestBytes)
const dates = {
  planned_at: at(23),
  declared_at: at(23),
  start_at: at(24),
  end_at: at(25),
  persisted_at: at(23, 1000),
  confirmed_at: at(23, 2000),
  publisher_xid: '1',
  confirmer_xid: '2',
}
const fixture = () => ({
  schedule: { ...dates, sha256: scheduleSha256, payload: scheduleBytes },
  coverage: {
    ...dates,
    sha256: manifestSha256,
    schedule_sha256: scheduleSha256,
    payload: manifestBytes,
    end_at: at(41),
  },
  starts: [
    {
      schedule_sha256: scheduleSha256,
      slot_id: scheduleJson.slots[0].slotId,
      amount_usd: '10000000',
      horizon_seconds: 28800,
      started_at: at(24, 1000),
      starter_xid: '3',
    },
  ],
  terminals: [
    {
      schedule_sha256: scheduleSha256,
      slot_id: scheduleJson.slots[0].slotId,
      amount_usd: '10000000',
      horizon_seconds: 28800,
      status: 'issued',
      reason: null,
      anchor_id: issue.anchor.id,
      issue_sha256: issue.sha256,
      payload: JSON.stringify(issue),
      physical_sha256: physicalSha256(JSON.stringify(issue)),
      recorded_at: at(24, 2000),
      terminal_xid: '4',
      timely: true,
    },
  ],
  collisions: [],
  scores: [],
  slots: manifestJson.slots.map((s) => ({
    manifest_sha256: manifestSha256,
    slot_id: s.id,
    slot_at: s.at,
  })),
  recorderStarts: [],
  recorderTerminals: [],
  successSnapshots: [],
  allSnapshots: [sample(6)],
})
const makePool = (data) => {
  const calls = []
  let released = false
  let inTransaction = false
  const query = async (sql) => {
    calls.push(sql)
    if (sql.startsWith('BEGIN')) {
      assert.equal(inTransaction, false)
      inTransaction = true
      return { rows: [] }
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      inTransaction = false
      return { rows: [] }
    }
    assert.equal(inTransaction, true)
    if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ as_of: at(50) }] }
    const k = sql.includes('issue_schedules s')
      ? 'schedule'
      : sql.includes('coverage_manifests m')
        ? 'coverage'
        : sql.includes('issue_starts')
          ? 'starts'
          : sql.includes('issue_terminals WHERE')
            ? 'terminals'
            : sql.includes('issue_collisions')
              ? 'collisions'
              : sql.includes('score_receipts')
                ? 'scores'
                : sql.includes('coverage_slots WHERE')
                  ? 'slots'
                  : sql.includes('recorder_starts st')
                    ? 'recorderStarts'
                    : sql.includes('recorder_terminals t JOIN') && sql.includes('SELECT t.*')
                      ? 'recorderTerminals'
                      : sql.includes('venue_snapshots s JOIN')
                        ? 'successSnapshots'
                        : sql.includes('venue_snapshots s WHERE')
                          ? 'allSnapshots'
                          : null
    assert.ok(k, `Unexpected query: ${sql}`)
    return { rows: ['schedule', 'coverage'].includes(k) ? [data[k]] : data[k] }
  }
  return {
    calls,
    get released() {
      return released
    },
    connect: async () => ({
      query,
      release: () => {
        released = true
      },
    }),
  }
}
const run = (pool) =>
  auditAaveUsdeV2Ledger({ pool, scheduleSha256, manifestSha256, issueSha256: issue.sha256 })

test('one unpaginated repeatable-read session; missing receipts remain visible and unpromoted', async () => {
  const pool = makePool(fixture())
  const result = await run(pool)
  assert.equal(pool.calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(pool.calls.at(-1), 'COMMIT')
  assert.equal(pool.calls.length, 14)
  assert.ok(
    !pool.calls
      .find((sql) => sql.includes('venue_snapshots s WHERE'))
      .includes('s.recorder_atomic_v1 IS TRUE'),
  )
  assert.ok(
    !pool.calls
      .find((sql) => sql.includes('venue_snapshots s WHERE'))
      .includes("s.source='observed'"),
  )
  assert.ok(
    pool.calls
      .find((sql) => sql.includes('venue_snapshots s WHERE'))
      .includes("interval '10 minutes'"),
  )
  assert.equal(pool.released, true)
  assert.equal(result.inventory.plannedCells, 9)
  assert.equal(result.inventory.terminals, 1)
  assert.equal(result.scheduleAudit.counts.missing, 8)
  assert.ok(result.coverageAudit.counts.missing > 0)
  assert.equal(result.prospectiveEligible, false)
  assert.equal(result.sourceCompleteness, 'unverified')
})

test('tampered schedule bytes fail closed after complete read', async () => {
  const data = fixture()
  data.schedule.payload += ' '
  const pool = makePool(data)
  await assert.rejects(run(pool), /physical SHA mismatch/)
  assert.equal(pool.calls.at(-1), 'COMMIT')
  assert.equal(pool.released, true)
})

test('missing confirmation and late terminal remain anomalies, not prospective evidence', async () => {
  const data = fixture()
  data.schedule.confirmed_at = null
  data.schedule.confirmer_xid = null
  data.terminals[0].recorded_at = at(25, 1000)
  data.terminals[0].timely = false
  const result = await run(makePool(data))
  assert.ok(result.anomalies.includes('schedule_confirmation_clock'))
  assert.equal(result.inventory.lateTerminals, 1)
  assert.equal(result.scheduleAudit, null)
  assert.equal(result.coverageAudit, null)
  assert.equal(result.prospectiveEligible, false)
})

test('missing query rows roll back and malformed snapshot projection fails', async () => {
  const data = fixture()
  data.allSnapshots = undefined
  const pool = makePool(data)
  await assert.rejects(run(pool), /Incomplete database query result/)
  assert.equal(pool.calls.at(-1), 'ROLLBACK')
  assert.equal(pool.released, true)
  assert.throws(() => projectSnapshot({ id: 'x', params: null }), /Malformed snapshot/)
})

test('unassigned marked atomic observations are exposed independently of receipt membership', async () => {
  const data = fixture()
  data.allSnapshots.push(sample(7))
  const result = await run(makePool(data))
  assert.deepEqual(result.inventory.unassignedSnapshotIds, ['sample-6', 'sample-7'])
  assert.deepEqual(result.coverageAudit.unattachedSnapshotIds, ['sample-6', 'sample-7'])
  assert.equal(result.requestedIssueCompleteness, 'incomplete_or_anomalous')
  assert.equal(result.prospectiveEligible, false)
})

test('legacy observed rows remain visible to source replay and inventory', async () => {
  const data = fixture()
  data.allSnapshots.push({ ...sample(7), recorder_atomic_v1: false })
  const result = await run(makePool(data))
  assert.equal(result.inventory.observedSnapshotsInWindow, 2)
  assert.equal(result.inventory.atomicSnapshotsInWindow, 1)
  assert.deepEqual(result.inventory.unmarkedSnapshotIds, ['sample-7'])
  assert.deepEqual(result.inventory.unassignedSnapshotIds, ['sample-6', 'sample-7'])
  assert.equal(result.requestedIssueCompleteness, 'incomplete_or_anomalous')
})

test('hourly success uses terminal completion after the inserted snapshot', async () => {
  const data = fixture()
  const slotId = manifestJson.slots[0].id
  const row = {
    ...sample(7),
    observed_at: at(24, 2000),
    created_at: at(24, 2000),
    params: {
      ...sample(7).params,
      read_block_time: (base + 24 * hour + 2000) / 1000 - 599,
    },
  }
  data.recorderStarts = [{ slot_id: slotId, started_at: at(24, 1000), starter_xid: '5' }]
  data.recorderTerminals = [
    {
      slot_id: slotId,
      status: 'success',
      snapshot_id: row.id,
      completed_at: at(24, 3000),
      terminal_xid: '6',
    },
  ]
  data.successSnapshots = [row]
  data.allSnapshots.push(row)
  const result = await run(makePool(data))
  assert.equal(result.coverageAudit.counts.success, 1)
  assert.equal(result.coverageAudit.slots[0].state, 'success')
})

test('requested issue physical mismatch suppresses nested coverage classification', async () => {
  const data = fixture()
  data.terminals[0].physical_sha256 = '0'.repeat(64)
  const result = await run(makePool(data))
  assert.ok(result.anomalies.some((a) => a.startsWith('issue_physical_sha:')))
  assert.equal(result.coverageAudit, null)
  assert.equal(result.prospectiveEligible, false)
})

test('requested anchor must match the referenced marked database snapshot', async () => {
  const data = fixture()
  data.allSnapshots[0] = {
    ...data.allSnapshots[0],
    params: { ...data.allSnapshots[0].params, underlyingBalance: '1' },
  }
  const result = await run(makePool(data))
  assert.ok(result.anomalies.includes('requested_anchor_snapshot_mismatch'))
  assert.equal(result.coverageAudit, null)
  assert.equal(result.requestedScoreReplay, null)
})

test('same-time competing observed row disqualifies the requested issue anchor', async () => {
  const data = fixture()
  data.allSnapshots.push({ ...sample(6), id: 'same-time-6' })
  const result = await run(makePool(data))
  assert.ok(result.anomalies.includes('requested_anchor_not_latest'))
  assert.equal(result.coverageAudit, null)
  assert.equal(result.requestedIssueCompleteness, 'incomplete_or_anomalous')
})

test('selected score is replayed from observed rows and a self-sealed false outcome is anomalous', async () => {
  const data = fixture()
  data.allSnapshots.push(sample(7), sample(8), sample(9), sample(10))
  const score = scoreFirstBreach(issue, data.allSnapshots, {
    scoredAt: at(40, 120_000),
    existingScore: null,
  })
  const payload = JSON.stringify(score)
  data.scores = [
    {
      issue_sha256: issue.sha256,
      status: score.status,
      payload,
      score_sha256: score.sha256,
      physical_sha256: physicalSha256(payload),
      source_as_of: score.sourceAsOf,
      scored_at: score.scoredAt,
      persisted_at: at(40, 180_000),
      scorer_xid: '7',
    },
  ]
  const matched = await run(makePool(data))
  assert.equal(matched.requestedScoreReplay.classification, 'match')
  data.scores[0].persisted_at = at(25)
  const prematurePersistence = await run(makePool(data))
  assert.ok(prematurePersistence.anomalies.includes(`score_order:${issue.sha256}`))
  assert.equal(prematurePersistence.requestedScoreReplay, null)
  data.scores[0].persisted_at = at(40, 180_000)
  data.allSnapshots.unshift({
    ...sample(7),
    id: 'backfilled-7',
    source: 'backfilled',
    observed_at: at(27),
    created_at: at(27),
  })
  const omittedSource = await run(makePool(data))
  assert.deepEqual(omittedSource.inventory.otherSourceSnapshotIds, ['backfilled-7'])
  assert.equal(omittedSource.requestedScoreReplay.classification, 'mismatch')
  data.allSnapshots.shift()
  const { sha256: oldSha, ...forgedBody } = score
  void oldSha
  forgedBody.breachedByH = !score.breachedByH
  const forged = { ...forgedBody, sha256: physicalSha256(JSON.stringify(forgedBody)) }
  data.scores[0].payload = JSON.stringify(forged)
  data.scores[0].score_sha256 = forged.sha256
  data.scores[0].physical_sha256 = physicalSha256(data.scores[0].payload)
  const mismatched = await run(makePool(data))
  assert.equal(mismatched.requestedScoreReplay.classification, 'mismatch')
  assert.ok(mismatched.anomalies.includes(`score_replay_mismatch:${issue.sha256}`))
  assert.equal(mismatched.requestedIssueCompleteness, 'incomplete_or_anomalous')
})

test('database completeness waits for source cutoff and every score, with no collisions', () => {
  const complete = {
    scheduleAudit: { counts: { scheduled: 0, missing: 0 } },
    coverageAudit: {
      counts: { pending: 0, missing: 0, censored: 0 },
      hourlyCoverageFromCallerReceipts: true,
    },
    requestedScoreReplay: { classification: 'match', replayedStatus: 'observed' },
    plannedCells: 9,
    issueStarts: 9,
    issueTerminals: 9,
    issuedTerminals: 2,
    scores: 2,
    expectedCoverageSlots: 17,
    recorderStarts: 17,
    recorderTerminals: 17,
    collisions: 0,
    anomalies: [],
  }
  assert.equal(
    classifyRequestedIssueCompleteness(complete),
    'requested_issue_complete_in_database_only',
  )
  for (const incomplete of [
    { scheduleAudit: { counts: { scheduled: 1, missing: 0 } } },
    {
      coverageAudit: { ...complete.coverageAudit, counts: { pending: 1, missing: 0, censored: 0 } },
    },
    { coverageAudit: { ...complete.coverageAudit, hourlyCoverageFromCallerReceipts: false } },
    { scores: 1 },
    { requestedScoreReplay: { classification: 'ambiguous' } },
    { requestedScoreReplay: { classification: 'match', replayedStatus: 'censored' } },
    { collisions: 1 },
  ])
    assert.equal(
      classifyRequestedIssueCompleteness({ ...complete, ...incomplete }),
      'incomplete_or_anomalous',
    )
})
