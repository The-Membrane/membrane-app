import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalLocalCarryExitV2Json,
  createLocalCarryExitV2NoNeonPersistence,
  hashLocalCarryExitV2Json,
  localCarryExitV2EpisodeId,
  localCarryExitV2IssueId,
  localCarryExitV2NativeSlotAt,
  localCarryExitV2PlanSealId,
  resumeLocalCarryExitV2SealedEpisode,
  resumeLocalCarryExitV2UnfinishedSealedEpisodes,
} from './localCarryExitV2NoNeonIssuer.mjs'
import {
  appendLocalCarryExitV2Record,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const holder = `0x${'3'.repeat(40)}`
const baselineHash = `0x${'4'.repeat(64)}`
const candidateEvidenceDoc = { schema: 'candidate_v1', nested: { b: 2, a: 1 } }
const callEvidenceDoc = { schema: 'call_v1', result: '0x01' }

function rootFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'carry-exit-v2-no-neon-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'ledger')
}

function fixturePlan(overrides = {}) {
  return {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: 'USDe → supply on Aave V3',
    slotAt: '2026-10-07T12:10:00.000Z',
    destination,
    asset,
    assetDecimals: 18,
    holder,
    baselineBlock: '24000000',
    baselineHash,
    baselineBlockAt: '2026-10-07T12:10:10.000Z',
    baselineObservedAt: '2026-10-07T12:10:20.000Z',
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256: hashLocalCarryExitV2Json(candidateEvidenceDoc),
    candidateEvidenceDoc,
    canonicalityEvidenceDoc: { finalized: true, blockHash: baselineHash },
    omittedLadder: [],
    cases: [
      {
        assetsRaw: '1000000000000000000',
        baselineStatus: 'success',
        coverageKind: 'assets',
        holderCoverageRaw: '2000000000000000000',
        requiredCoverageRaw: '1000000000000000000',
        actualConsumedRaw: null,
        simulationStatus: 'success',
        callEvidenceSha256: hashLocalCarryExitV2Json(callEvidenceDoc),
        callEvidenceDoc,
        entitlementEvidenceSha256: null,
        entitlementEvidenceDoc: null,
        inconclusiveReason: null,
        unavailableReason: null,
      },
      {
        assetsRaw: '2000000000000000000',
        baselineStatus: 'unavailable',
        coverageKind: null,
        holderCoverageRaw: null,
        requiredCoverageRaw: null,
        actualConsumedRaw: null,
        simulationStatus: null,
        callEvidenceSha256: null,
        callEvidenceDoc: null,
        entitlementEvidenceSha256: null,
        entitlementEvidenceDoc: null,
        inconclusiveReason: null,
        unavailableReason: 'quote_unavailable',
      },
    ],
    ...overrides,
  }
}

function changedSameSlotPlan() {
  const plan = fixturePlan()
  const changedCandidateEvidenceDoc = {
    schema: 'candidate_v1',
    nested: { b: 3, a: 1 },
  }
  const changedCallEvidenceDoc = { schema: 'call_v1', result: '0x02' }
  return {
    ...plan,
    baselineObservedAt: '2026-10-07T12:10:40.000Z',
    candidateEvidenceDoc: changedCandidateEvidenceDoc,
    candidateEvidenceSha256: hashLocalCarryExitV2Json(changedCandidateEvidenceDoc),
    canonicalityEvidenceDoc: {
      finalized: true,
      blockHash: baselineHash,
      observation: 'changed_retry',
    },
    cases: [
      {
        ...plan.cases[0],
        callEvidenceDoc: changedCallEvidenceDoc,
        callEvidenceSha256: hashLocalCarryExitV2Json(changedCallEvidenceDoc),
      },
      plan.cases[1],
    ],
  }
}

function planForNativeSlot(slot, index = 0) {
  const slotAt = localCarryExitV2NativeSlotAt(slot)
  const slotMs = Date.parse(slotAt)
  return fixturePlan({
    routeKey: `fixture route ${index}`,
    slotAt,
    baselineBlock: String(24_000_000 + index),
    baselineBlockAt: new Date(slotMs + 10_000).toISOString(),
    baselineObservedAt: new Date(slotMs + 20_000).toISOString(),
  })
}

test('canonical local JSON and stable non-SQL IDs ignore object key order', () => {
  assert.equal(canonicalLocalCarryExitV2Json({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(hashLocalCarryExitV2Json({ b: 2, a: 1 }), hashLocalCarryExitV2Json({ a: 1, b: 2 }))
  const left = fixturePlan()
  const right = {
    ...fixturePlan(),
    candidateEvidenceDoc: { nested: { a: 1, b: 2 }, schema: 'candidate_v1' },
  }
  assert.equal(
    localCarryExitV2EpisodeId('direct', left),
    localCarryExitV2EpisodeId('direct', right),
  )
  assert.match(localCarryExitV2EpisodeId('direct', left), /^local:direct:[0-9a-f]{48}$/)
  assert.match(localCarryExitV2IssueId('direct', left, left.cases[0].assetsRaw), /:q:[0-9a-f]{16}$/)
  assert.match(localCarryExitV2PlanSealId('direct', left), /^local-plan-seal:direct:[0-9a-f]{48}$/)
  const changedProof = fixturePlan({
    canonicalityEvidenceDoc: { finalized: true, blockHash: `0x${'5'.repeat(64)}` },
  })
  assert.notEqual(
    localCarryExitV2EpisodeId('direct', left),
    localCarryExitV2EpisodeId('direct', changedProof),
  )
  assert.equal(
    localCarryExitV2PlanSealId('direct', left),
    localCarryExitV2PlanSealId('direct', changedProof),
  )
})

test('local persistence is idempotent and the post-persist mirror only verifies', async (t) => {
  const root = rootFor(t)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
  })
  const plan = fixturePlan()
  const episodeId = await persistence.persist(persistence.sql, plan)
  const mirror = await persistence.recordLocalIssues({
    source: 'direct',
    batchId: episodeId,
    plan,
    recordedAt: new Date(current),
  })
  current += 60_000
  assert.equal(await persistence.persist(persistence.sql, plan), episodeId)
  assert.deepEqual(mirror, {
    status: 'already_persisted_local',
    localEpisodeId: episodeId,
    appended: 0,
  })

  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.issues.size, 2)
  assert.equal(state.attempts.size, 1)
  assert.equal(state.records.length, 3)
  for (const row of state.issues.values()) {
    assert.equal(row.payload.issueEnvelope.authoritativeStore, 'local_carry_exit_v2')
    assert.equal(row.payload.issueEnvelope.episodeId, episodeId)
    assert.equal(row.payload.issueEnvelope.authority.clock, 'local_operator_clock')
    assert.equal(row.payload.issueEnvelope.authority.databaseUsed, false)
    assert.equal(row.payload.issueEnvelope.authority.databaseTimestamp, null)
    assert.equal(row.payload.issueEnvelope.authority.sqlBatchId, null)
    assert.equal(row.payload.issueEnvelope.authority.independentTimestamp, false)
    assert.equal(row.payload.issueEnvelope.authority.rollbackProof, false)
    assert.equal(row.payload.issuedAtUtc, '2026-10-07T12:11:00.000Z')
  }
})

test('a changed baseline observation and proof reuse the first sealed source plan', async (t) => {
  const root = rootFor(t)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
  })
  const original = fixturePlan()
  const changed = changedSameSlotPlan()
  const episodeId = await persistence.persist(persistence.sql, original)
  current += 5 * 60_000

  assert.equal(await persistence.persist(persistence.sql, changed), episodeId)
  assert.equal(await persistence.recoverIssuedBatch(persistence.sql, changed), episodeId)

  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.attempts.size, 1)
  assert.equal(state.issues.size, 2)
  assert.equal(state.records.length, 3)
  assert.ok(
    [...state.issues.values()].every(
      (row) =>
        row.payload.issueEnvelope.sourcePlan.baselineObservedAtUtc ===
          original.baselineObservedAt &&
        row.payload.proofEnvelope.candidateEvidenceSha256 === original.candidateEvidenceSha256,
    ),
  )
})

test('a crash after the plan seal resumes from that seal instead of a fresh plan', async (t) => {
  const root = rootFor(t)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  let failOnce = true
  const append = (kind, payload, options) => {
    if (kind === 'issue' && failOnce) {
      failOnce = false
      throw Error('simulated_after_seal_crash')
    }
    return appendLocalCarryExitV2Record(kind, payload, options)
  }
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
    append,
  })
  const original = fixturePlan()
  await assert.rejects(
    () => persistence.persist(persistence.sql, original),
    /simulated_after_seal_crash/,
  )
  const sealed = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(sealed.attempts.size, 1)
  assert.equal(sealed.issues.size, 0)
  assert.equal(sealed.records.length, 1)

  current += 5 * 60_000
  const episodeId = await persistence.persist(persistence.sql, changedSameSlotPlan())
  const recovered = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(episodeId, localCarryExitV2EpisodeId('direct', original))
  assert.equal(recovered.attempts.size, 1)
  assert.equal(recovered.issues.size, 2)
  assert.ok(
    [...recovered.issues.values()].every(
      (row) =>
        row.payload.issueEnvelope.episodeId === episodeId &&
        row.payload.issueEnvelope.sourcePlan.baselineObservedAtUtc ===
          original.baselineObservedAt &&
        row.payload.proofEnvelope.callEvidenceSha256 !==
          hashLocalCarryExitV2Json({ schema: 'call_v1', result: '0x02' }),
    ),
  )
})

test('source, route, and native-slot resume needs no fresh plan', async (t) => {
  const root = rootFor(t)
  const plan = fixturePlan()
  const slot = (Date.parse(plan.slotAt) - 10 * 60_000) / (15 * 60_000)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  let failOnce = true
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
    append(kind, payload, options) {
      if (kind === 'issue' && failOnce) {
        failOnce = false
        throw Error('simulated_after_seal_crash')
      }
      return appendLocalCarryExitV2Record(kind, payload, options)
    },
  })
  await assert.rejects(
    () => persistence.persist(persistence.sql, plan),
    /simulated_after_seal_crash/,
  )
  current += 30 * 60_000
  const resume = () =>
    resumeLocalCarryExitV2SealedEpisode({
      source: 'direct',
      route: plan,
      slot,
      root,
      now: () => new Date(current),
      minFreeBytes: 0,
    })
  const resumed = await resume()
  assert.equal(resumed.status, 'resumed')
  assert.equal(resumed.appended, 2)
  assert.equal(resumed.episodeId, localCarryExitV2EpisodeId('direct', plan))
  const repeated = await resume()
  assert.equal(repeated.status, 'already_complete')
  assert.equal(repeated.appended, 0)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, 2)
})

test('partial issue append resumes the sealed plan despite a changed fresh retry', async (t) => {
  const root = rootFor(t)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  let issueCalls = 0
  let failOnce = true
  const append = (kind, payload, options) => {
    if (kind === 'issue' && ++issueCalls === 2 && failOnce) {
      failOnce = false
      throw Error('simulated_partial_crash')
    }
    return appendLocalCarryExitV2Record(kind, payload, options)
  }
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
    append,
  })
  const plan = fixturePlan()
  await assert.rejects(() => persistence.persist(persistence.sql, plan), /simulated_partial_crash/)
  const partial = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(partial.attempts.size, 1)
  assert.equal(partial.issues.size, 1)
  const firstId = [...partial.issues.keys()][0]
  const firstClock = [...partial.issues.values()][0].payload.issuedAtUtc

  current += 5 * 60_000
  const changed = changedSameSlotPlan()
  const episodeId = await persistence.persist(persistence.sql, changed)
  const recovered = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(recovered.attempts.size, 1)
  assert.equal(recovered.issues.size, 2)
  assert.ok(recovered.issues.has(firstId))
  assert.equal(episodeId, localCarryExitV2EpisodeId('direct', plan))
  assert.ok([...recovered.issues.values()].every((row) => row.payload.issuedAtUtc === firstClock))
  assert.ok(
    [...recovered.issues.values()].every(
      (row) =>
        row.payload.issueEnvelope.sourcePlan.baselineObservedAtUtc === plan.baselineObservedAt,
    ),
  )
  assert.equal(await persistence.recoverIssuedBatch(persistence.sql, changed), episodeId)
})

test('duplicate seals for one exact native slot fail closed', async (t) => {
  const root = rootFor(t)
  let current = Date.parse('2026-10-07T12:11:00.000Z')
  let failOnce = true
  const append = (kind, payload, options) => {
    if (kind === 'issue' && failOnce) {
      failOnce = false
      throw Error('simulated_after_seal_crash')
    }
    return appendLocalCarryExitV2Record(kind, payload, options)
  }
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date(current),
    minFreeBytes: 0,
    append,
  })
  const plan = fixturePlan()
  await assert.rejects(
    () => persistence.persist(persistence.sql, plan),
    /simulated_after_seal_crash/,
  )
  const state = verifyLocalCarryExitV2Ledger({ root })
  const seal = state.attempts.get(localCarryExitV2PlanSealId('direct', plan))
  assert.ok(seal)
  current += 60_000
  appendLocalCarryExitV2Record(
    'attempt',
    {
      ...seal.payload,
      attemptId: `${seal.payload.attemptId}:conflict`,
    },
    { root, now: current, minFreeBytes: 0 },
  )

  await assert.rejects(
    () => persistence.persist(persistence.sql, changedSameSlotPlan()),
    /plan_seal_conflict/,
  )
  const conflicted = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(conflicted.attempts.size, 2)
  assert.equal(conflicted.issues.size, 0)
})

test('unfinished seal sweep is bounded and resumes oldest episodes first', async (t) => {
  const root = rootFor(t)
  const baseSlot = (Date.parse('2026-10-07T12:10:00.000Z') - 10 * 60_000) / (15 * 60_000)
  const plans = []
  for (let index = 0; index < 4; index++) {
    const slot = baseSlot + index
    const plan = planForNativeSlot(slot, index)
    plans.push(plan)
    const sealAt = new Date(Date.parse(plan.slotAt) + 60_000)
    const persistence = createLocalCarryExitV2NoNeonPersistence({
      source: 'direct',
      root,
      now: () => sealAt,
      minFreeBytes: 0,
      append(kind, payload, options) {
        if (kind === 'issue') throw Error('leave_seal_unfinished')
        return appendLocalCarryExitV2Record(kind, payload, options)
      },
    })
    await assert.rejects(() => persistence.persist(persistence.sql, plan), /leave_seal_unfinished/)
  }

  const sweepAt = () => new Date(Date.parse(plans.at(-1).slotAt) + 5 * 60_000)
  const first = await resumeLocalCarryExitV2UnfinishedSealedEpisodes({
    root,
    now: sweepAt,
    minFreeBytes: 0,
    limit: 3,
  })
  assert.equal(first.unfinishedBefore, 4)
  assert.equal(first.resumedEpisodes, 3)
  assert.equal(first.appendedIssues, 6)
  assert.equal(first.remaining, 1)
  assert.deepEqual(
    first.episodes.map((episode) => episode.slotAtUtc),
    plans.slice(0, 3).map((plan) => plan.slotAt),
  )
  const second = await resumeLocalCarryExitV2UnfinishedSealedEpisodes({
    root,
    now: sweepAt,
    minFreeBytes: 0,
    limit: 3,
  })
  assert.equal(second.unfinishedBefore, 1)
  assert.equal(second.resumedEpisodes, 1)
  assert.equal(second.appendedIssues, 2)
  assert.equal(second.remaining, 0)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, 8)
})

test('attempt records replace the borrowed batch field with a local episode identity', async (t) => {
  const root = rootFor(t)
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date('2026-10-07T12:11:00.000Z'),
    minFreeBytes: 0,
  })
  const plan = fixturePlan()
  const episodeId = await persistence.persist(persistence.sql, plan)
  await persistence.appendAttempt({
    schema: 'borrowed_direct_attempt_v1',
    slot: 1,
    routeKey: plan.routeKey,
    destination: plan.destination,
    asset: plan.asset,
    at: '2026-10-07T12:11:00.000Z',
    status: 'issued',
    reason: null,
    batchId: episodeId,
  })
  const attempt = [...verifyLocalCarryExitV2Ledger({ root }).attempts.values()].find(
    (row) => row.payload.stage === 'direct_issue',
  ).payload
  assert.equal(attempt.attemptEnvelope.localEpisodeId, episodeId)
  assert.equal(attempt.attemptEnvelope.sqlBatchId, null)
  assert.equal(attempt.attemptEnvelope.databaseUsed, false)
  assert.equal(Object.hasOwn(attempt.attemptEnvelope.issuerAttempt, 'batchId'), false)
  await assert.rejects(
    () =>
      persistence.appendAttempt({
        schema: 'borrowed_direct_attempt_v1',
        at: '2026-10-07T12:12:00.000Z',
        status: 'issued',
        batchId: '42',
      }),
    /attempt_episode_id_invalid/,
  )
})

test('a local issue cannot predate the baseline observation', async (t) => {
  const root = rootFor(t)
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => new Date('2026-10-07T12:11:00.000Z'),
    minFreeBytes: 0,
  })
  await assert.rejects(
    () =>
      persistence.persist(
        persistence.sql,
        fixturePlan({ baselineObservedAt: '2026-10-07T12:11:01.000Z' }),
      ),
    /issue_before_baseline/,
  )
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).records.length, 0)
})

test('the injected SQL seam always fails before database access', (t) => {
  const root = rootFor(t)
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    minFreeBytes: 0,
  })
  assert.throws(() => persistence.sql(), /database_access_forbidden/)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).records.length, 0)
})
