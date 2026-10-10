import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  classifyMorphoScore,
  readMorphoPendingScoreAudit,
  scoreMorphoDue,
  scorePayload,
  writeMorphoScore,
} from './record-carry-morpho-exit-v2-scores.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((item) => item.kind === 'morpho')
const holder = `0x${'1'.repeat(40)}`
const blockHash = `0x${'b'.repeat(64)}`
const parentHash = `0x${'a'.repeat(64)}`
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const addressWord = (value) => value.slice(2).padStart(64, '0')
const rpc = (target, data, id, result) => ({
  provider: 'fixture',
  source: 'fixture',
  callTarget: target,
  request: {
    jsonrpc: '2.0',
    id,
    method: 'eth_call',
    params: [
      { from: holder, to: target, data },
      { blockHash, requireCanonical: true },
    ],
  },
  response: { jsonrpc: '2.0', id, result },
})

function sample({ shares = 100n, claim = 200n, q = 150n, revert = false } = {}) {
  const row = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder,
    assetsRaw: String(q),
  }
  const holderCoverageRpc = rpc(
    route.destination,
    `0x70a08231${addressWord(holder)}`,
    1,
    `0x${word(shares)}`,
  )
  holderCoverageRpc.decodedRaw = String(shares)
  const requiredCoverageRpc = rpc(
    route.destination,
    `0x4cdad506${word(shares)}`,
    2,
    `0x${word(claim)}`,
  )
  requiredCoverageRpc.decodedRaw = String(claim)
  const withdrawRpc = rpc(
    route.destination,
    `0xb460af94${word(q)}${addressWord(holder)}${addressWord(holder)}`,
    3,
    `0x${word(40)}`,
  )
  if (revert) {
    delete withdrawRpc.response.result
    withdrawRpc.response.error = { code: 3, message: 'execution reverted: cash' }
  }
  withdrawRpc.decodedAssetsRaw = String(q)
  withdrawRpc.decodedConsumedRaw = revert ? null : '40'
  const callEvidenceDoc = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    ...row,
    caller: holder,
    blockNumber: '400',
    blockHash,
    coverageKind: 'morpho_shares_claim',
    holderCoverageRaw: String(shares),
    requiredCoverageRaw: String(claim),
    actualConsumedRaw: revert ? null : '40',
    simulationStatus: revert ? 'evm_revert' : 'success',
    holderCoverageRpc,
    requiredCoverageRpc,
    withdrawRpc,
    verificationStatus: 'verified',
    replayEvidenceDoc: { schema: 'fixture' },
  }
  const target = {
    targetBlock: '400',
    targetHash: blockHash,
    targetBlockAt: '2026-09-30T01:00:12.000Z',
    targetParentBlock: '399',
    targetParentHash: parentHash,
    parentHeaderHash: parentHash,
    targetParentBlockAt: '2026-09-30T01:00:00.000Z',
    targetObservedAt: '2026-09-30T01:00:20.000Z',
    canonicalityEvidenceDoc: { schema: 'fixture' },
  }
  const core = {
    caseId: '3',
    horizonH: 1,
    targetAt: '2026-09-30T01:00:00.000001Z',
    deadlineAt: '2026-09-30T03:00:00.000001Z',
    predecessorH: 0,
    predecessorScoreId: null,
    predecessorStatus: 'success',
    predecessorBlock: '300',
    predecessorHash: `0x${'c'.repeat(64)}`,
    predecessorBlockAt: '2026-09-30T00:00:00.000Z',
  }
  return {
    core,
    target,
    row,
    capturedAt: '2026-09-30T01:00:30.000Z',
    verified: { status: 'verified', callEvidenceDoc },
  }
}

function due(overrides = {}) {
  return {
    batchId: '2',
    caseId: '3',
    horizonH: 1,
    issuedAt: '2026-09-30T00:00:00.000001Z',
    targetAt: '2026-09-30T01:00:00.000001Z',
    deadlineAt: '2026-09-30T03:00:00.000001Z',
    predecessorH: 0,
    conditionalRecovery: false,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder,
    assetsRaw: '150',
    baselineStatus: 'success',
    baselineBlock: '300',
    baselineHash: `0x${'c'.repeat(64)}`,
    baselineBlockAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  }
}

test('frozen Morpho call evidence classifies success, covered revert and claim gap', () => {
  assert.equal(classifyMorphoScore(sample()).status, 'success')
  const covered = classifyMorphoScore(sample({ revert: true }))
  assert.equal(covered.status, 'covered_revert')
  assert.equal(covered.actualConsumedRaw, null)
  const gap = classifyMorphoScore(sample({ revert: true, claim: 100n }))
  assert.equal(gap.status, 'inconclusive')
  assert.equal(gap.inconclusiveReason, 'preview_gap')
  assert.equal(gap.callEvidenceDoc.inconclusiveReason, 'preview_gap')
  assert.equal(gap.entitlementEvidenceDoc.purpose, 'entitlement')
  assert.equal(gap.entitlementEvidenceDoc.simulationStatus, 'evm_revert')
})

test('zero shares censors episode with balance evidence, not an exit failure', () => {
  const score = classifyMorphoScore(sample({ shares: 0n, claim: 0n, revert: true }))
  assert.equal(score.status, 'holder_attrition')
  assert.equal(score.entitlementMethod, 'zero_shares')
  assert.equal(score.callEvidenceDoc, null)
  assert.equal(score.entitlementEvidenceDoc.holderCoverageRaw, '0')
})

test('measured outcome requires verified replay and frozen identity', () => {
  const input = sample()
  assert.throws(() => classifyMorphoScore({ ...input, verified: { status: 'unavailable' } }))
  assert.throws(() => classifyMorphoScore({ ...input, row: { ...input.row, assetsRaw: '151' } }))
})

test('horizon control waits for deadline; eligible measurement holds when replay is absent', async () => {
  const writes = []
  const control = due({ baselineStatus: 'unavailable' })
  const late = await scoreMorphoDue({
    readDue: async () => [control],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('unexpected')
    },
    measure: async () => null,
    writeScore: async (row) => {
      writes.push(row)
      return true
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(late.counts.not_eligible, 1)
  assert.equal(writes[0].targetBlock, null)
  const early = await scoreMorphoDue({
    readDue: async () => [control],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('unexpected')
    },
    measure: async () => null,
    writeScore: async () => {
      throw Error('unexpected')
    },
    now: () => new Date('2026-09-30T02:01:00.000Z'),
  })
  assert.equal(early.counts.control_wait, 1)
  const absent = await scoreMorphoDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => sample().target,
    measure: async () => ({ status: 'unavailable', reason: 'rpc_unavailable' }),
    writeScore: async () => {
      throw Error('should not claim a measurement')
    },
    now: () => new Date('2026-09-30T01:00:45.000Z'),
  })
  assert.equal(absent.counts.missing_receipt_required, 1)
})

test('expired measurement remains pending for independently verified missing receipt', async () => {
  const result = await scoreMorphoDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('unexpected')
    },
    measure: async () => null,
    writeScore: async () => {
      throw Error('unexpected')
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(result.counts.missing_receipt_required, 1)
})

test('expired eligible case scores missing only from an existing verified receipt', async () => {
  const written = []
  const result = await scoreMorphoDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    readMissing: async () => ({ id: '77', missingReason: 'rpc_unavailable' }),
    chooseTarget: async () => {
      throw Error('expired target should not be queried')
    },
    measure: async () => null,
    writeScore: async (score) => {
      written.push(score)
      return true
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(result.counts.missing, 1)
  assert.equal(written[0].missingReceiptId, '77')
  assert.equal(scorePayload(written[0]).target_block, null)
})

test('unverified outcome can record a real failed capture but cannot score it early', async () => {
  let stored = 0
  const result = await scoreMorphoDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => sample().target,
    measure: async () => ({ status: 'unavailable' }),
    probeMissing: async () => ({ evidenceDoc: { schema: 'actual_probe' } }),
    writeMissing: async () => {
      stored++
      return '77'
    },
    writeScore: async () => {
      throw Error('must not score before deadline')
    },
    now: () => new Date('2026-09-30T01:00:45.000Z'),
  })
  assert.equal(stored, 1)
  assert.equal(result.counts.missing_receipt_required, 1)
})

test('pending audit exposes expired eligible plans in the frozen denominator', async () => {
  let query = ''
  const pending = await readMorphoPendingScoreAudit((strings) => {
    query = strings.join('?')
    return [{ expiredEligiblePending: 2, liveEligiblePending: 5, controlOrCensoredPending: 1 }]
  })
  assert.equal(pending.expiredEligiblePending, 2)
  assert.match(query, /carry_exit_v2_coverage/)
  assert.match(query, /status = 'pending'/)
})

test('database writer derives evidence digests in SQL and propagates failures', async () => {
  const seen = []
  const write = (strings, ...args) => {
    seen.push({ sql: strings.join('?'), payload: JSON.parse(args[0]) })
    return [{ id: '9' }]
  }
  assert.equal(await writeMorphoScore(write, classifyMorphoScore(sample())), true)
  assert.match(seen[0].sql, /sha256\(/)
  assert.match(seen[0].sql, /ON CONFLICT \(case_id,horizon_h\) DO NOTHING/)
  assert.equal(seen[0].payload.status, 'success')
  assert.equal(seen[0].payload.holder_coverage_raw, '100')
  assert.equal(seen[0].payload.canonicality_evidence_doc.schema, 'fixture')
  assert.equal(scorePayload({ status: 'not_eligible' }).call_evidence_doc, null)
  await assert.rejects(
    () =>
      scoreMorphoDue({
        readDue: async () => [due({ baselineStatus: 'unavailable' })],
        readPrior: async () => [],
        chooseTarget: async () => null,
        measure: async () => null,
        writeScore: async () => {
          throw Error('db down')
        },
        now: () => new Date('2026-09-30T03:01:00.000Z'),
      }),
    /score_write_failed/,
  )
})
