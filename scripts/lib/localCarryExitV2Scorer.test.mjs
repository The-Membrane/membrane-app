import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  syntheticRoute,
  syntheticVerifiedMeasurementFixture,
} from './carry-exit-v2-verified-measurement-fixture.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'
import { scoreDueLocalCarryExitV2 } from './localCarryExitV2Scorer.mjs'
import {
  appendLocalCarryExitV2Record,
  CARRY_EXIT_V2_HORIZONS,
  CARRY_EXIT_V2_PREDECESSOR,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'
import { recordLocalCarryExitV2Readbacks } from './localCarryExitV2Witness.mjs'

const holder = `0x${'1'.repeat(40)}`
const baselineHash = `0x${'a'.repeat(64)}`
const issuedAt = '2026-09-29T23:00:00.001Z'
const targetAt = '2026-09-30T00:00:00.001Z'
const deadlineAt = '2026-09-30T02:00:00.001Z'

function rootFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'carry-exit-v2-score-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'ledger')
}

function appendIssue(root, { baselineStatus = 'success', issueId = 'local:sync:1:q:0' } = {}) {
  const issuedMs = Date.parse(issuedAt)
  return appendLocalCarryExitV2Record(
    'issue',
    {
      issueId,
      routeKey: syntheticRoute.routeKey,
      destination: syntheticRoute.destination,
      asset: syntheticRoute.asset,
      decimals: 6,
      assetsRaw: '1000000',
      baselineStatus,
      baselineBlock: '300',
      baselineHash,
      baselineBlockAtUtc: '2026-09-29T22:59:00.000Z',
      issuedAtUtc: issuedAt,
      proofEnvelope: { schema: 'fixture' },
      issueEnvelope: {
        schema: 'fixture',
        source: 'sync_vault',
        sourcePlan: { holder },
      },
      plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
        horizonH,
        predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
        conditionalRecovery: false,
        targetAtUtc: new Date(issuedMs + horizonH * 3_600_000).toISOString(),
        deadlineAtUtc: new Date(issuedMs + (horizonH + 2) * 3_600_000).toISOString(),
      })),
    },
    { root, now: issuedMs, minFreeBytes: 0 },
  )
}

function witness(root) {
  return recordLocalCarryExitV2Readbacks({
    root,
    now: () => new Date('2026-09-29T23:05:00.000Z'),
    minFreeBytes: 0,
  })
}

async function verifiedFixture() {
  const fixture = syntheticVerifiedMeasurementFixture()
  const target = structuredClone(fixture.input.target)
  target.canonicalityEvidenceDoc.targetAt = targetAt
  target.canonicalityEvidenceDoc.baselineHeader = {
    number: '300',
    hash: baselineHash,
    parentHash: `0x${'9'.repeat(64)}`,
    timestamp: '2026-09-29T22:59:00.000Z',
  }
  fixture.input.target = target
  return { target, verified: await measureCarryExitV2Verified(fixture.input) }
}

function measuredAdapter(target, verified, mutate = (value) => value) {
  return {
    id: 'fixture_sync_classifier_v1',
    chooseTarget: async () => structuredClone(target),
    measure: async () => mutate(structuredClone(verified)),
    classify: async ({ core, target: chosen, verified: measured, capturedAt }) => ({
      ...core,
      ...chosen,
      capturedAt,
      status: 'success',
      coverageKind: 'shares',
      holderCoverageRaw: measured.callEvidenceDoc.holderCoverageRaw,
      requiredCoverageRaw: measured.callEvidenceDoc.requiredCoverageRaw,
      actualConsumedRaw: measured.callEvidenceDoc.actualConsumedRaw,
      simulationStatus: measured.callEvidenceDoc.simulationStatus,
    }),
  }
}

test('appends a score only after exact issue, holder, Q, target, and replay evidence verify', async (t) => {
  const root = rootFor(t)
  const issue = appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: measuredAdapter(target, verified) },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { success: 1 })
  assert.equal(result.forecastValidated, false)
  assert.equal(result.holderExecutableExit, false)
  const state = verifyLocalCarryExitV2Ledger({ root })
  const score = state.outcomes.get(`${issue.payload.issueId}\u001f1`)
  assert.equal(score.payload.status, 'success')
  assert.equal(score.payload.targetBlock, target.targetBlock)
  assert.equal(score.payload.scoreEnvelope.holder, holder)
  assert.equal(score.payload.scoreEnvelope.assetsRaw, '1000000')
  assert.equal(score.payload.scoreEnvelope.forecastValidated, false)
  assert.equal(score.payload.proofEnvelope.callEvidenceDoc.verificationStatus, 'verified')
})

test('tampered holder evidence cannot enter the local score chain', async (t) => {
  const root = rootFor(t)
  appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  const adapter = measuredAdapter(target, verified, (value) => {
    value.callEvidenceDoc.holder = `0x${'f'.repeat(40)}`
    return value
  })
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: adapter },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { measurement_unavailable: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})

test('a replay summary without origins, headers, responses, or identity replay is rejected', async (t) => {
  const root = rootFor(t)
  appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  const adapter = measuredAdapter(target, verified, (value) => {
    value.callEvidenceDoc.identityEvidence.checks = []
    delete value.callEvidenceDoc.replayEvidenceDoc.origins
    delete value.callEvidenceDoc.replayEvidenceDoc.headers
    delete value.callEvidenceDoc.replayEvidenceDoc.responses
    delete value.callEvidenceDoc.replayEvidenceDoc.identityReplay
    return value
  })
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: adapter },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { measurement_unavailable: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})

test('a classifier verdict that contradicts decoded evidence cannot enter the chain', async (t) => {
  const root = rootFor(t)
  appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  const adapter = measuredAdapter(target, verified)
  const classify = adapter.classify
  adapter.classify = async (input) => ({ ...(await classify(input)), status: 'holder_attrition' })
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: adapter },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { classification_unavailable: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})

test('tampered target identity cannot reach measurement or append', async (t) => {
  const root = rootFor(t)
  appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  target.canonicalityEvidenceDoc.targetAt = '2026-09-30T00:00:00.002Z'
  let measures = 0
  const adapter = measuredAdapter(target, verified)
  adapter.measure = async () => {
    measures += 1
    return verified
  }
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: adapter },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { target_unavailable: 1 })
  assert.equal(measures, 0)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})

test('deadline closure emits missing, unavailable, and censored states from frozen facts', async (t) => {
  const missingRoot = rootFor(t)
  appendIssue(missingRoot)
  witness(missingRoot)
  const missing = await scoreDueLocalCarryExitV2({
    root: missingRoot,
    adapters: {
      sync_vault: {
        id: 'configured',
        chooseTarget: () => {},
        measure: () => {},
        classify: () => {},
      },
    },
    now: () => new Date('2026-09-30T02:00:01.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(missing.counts, { missing: 1 })

  const unavailableRoot = rootFor(t)
  appendIssue(unavailableRoot, { baselineStatus: 'unavailable' })
  witness(unavailableRoot)
  const unavailable = await scoreDueLocalCarryExitV2({
    root: unavailableRoot,
    now: () => new Date('2026-09-30T02:00:01.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(unavailable.counts, { unavailable: 1 })

  const censoredRoot = rootFor(t)
  const issue = appendIssue(censoredRoot)
  witness(censoredRoot)
  appendLocalCarryExitV2Record(
    'score',
    {
      issueId: issue.payload.issueId,
      horizonH: 1,
      targetAtUtc: targetAt,
      deadlineAtUtc: deadlineAt,
      predecessorH: 0,
      predecessorSha256: null,
      status: 'holder_attrition',
      scoredAtUtc: '2026-09-30T00:00:30.000Z',
      targetBlock: '400',
      targetHash: `0x${'c'.repeat(64)}`,
      targetBlockAtUtc: '2026-09-30T00:00:12.000Z',
      observedAtUtc: '2026-09-30T00:00:15.000Z',
      scoreEnvelope: { schema: 'fixture' },
      proofEnvelope: { schema: 'fixture' },
    },
    { root: censoredRoot, now: Date.parse('2026-09-30T00:00:30.000Z'), minFreeBytes: 0 },
  )
  const censored = await scoreDueLocalCarryExitV2({
    root: censoredRoot,
    now: () => new Date('2026-09-30T05:00:01.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(censored.counts, { censored: 1 })
  const state = verifyLocalCarryExitV2Ledger({ root: censoredRoot })
  assert.equal(state.outcomes.get(`${issue.payload.issueId}\u001f4`).payload.status, 'censored')
})

test('baseline control is sealed before deadline without invoking source callbacks', async (t) => {
  const root = rootFor(t)
  const issue = appendIssue(root, { baselineStatus: 'inconclusive' })
  witness(root)
  let calls = 0
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: {
      sync_vault: {
        id: 'unused',
        chooseTarget: () => calls++,
        measure: () => calls++,
        classify: () => calls++,
      },
    },
    now: () => new Date('2026-09-30T00:00:30.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { not_eligible: 1 })
  assert.equal(calls, 0)
  const score = verifyLocalCarryExitV2Ledger({ root }).outcomes.get(
    `${issue.payload.issueId}\u001f1`,
  )
  assert.equal(score.payload.status, 'not_eligible')
  assert.equal(score.payload.targetBlock, null)
})

test('classification that crosses the deadline cannot append with a stale timestamp', async (t) => {
  const root = rootFor(t)
  appendIssue(root)
  witness(root)
  const { target, verified } = await verifiedFixture()
  const before = new Date('2026-09-30T00:00:30.000Z')
  const after = new Date('2026-09-30T02:00:01.000Z')
  let calls = 0
  const result = await scoreDueLocalCarryExitV2({
    root,
    adapters: { sync_vault: measuredAdapter(target, verified) },
    now: () => (++calls <= 4 ? before : after),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { deadline_elapsed_during_classification: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})

test('control scoring rechecks the clock after its final ledger reopen', async (t) => {
  const root = rootFor(t)
  appendIssue(root, { baselineStatus: 'unavailable' })
  witness(root)
  const before = new Date('2026-09-30T00:00:30.000Z')
  const after = new Date('2026-09-30T02:00:01.000Z')
  let calls = 0
  const result = await scoreDueLocalCarryExitV2({
    root,
    now: () => (++calls <= 2 ? before : after),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { deadline_elapsed_before_append: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).outcomes.size, 0)
})
