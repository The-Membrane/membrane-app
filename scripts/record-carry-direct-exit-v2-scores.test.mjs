import assert from 'node:assert/strict'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import { classifyDirectScore, scoreDirectDue } from './record-carry-direct-exit-v2-scores.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((item) => item.kind === 'comet')
const holder = `0x${'a'.repeat(40)}`
const blockHash = `0x${'b'.repeat(64)}`
const parentHash = `0x${'c'.repeat(64)}`
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

function sample({ balance = 120n, q = 100n, revert = false } = {}) {
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
    `0x${word(balance)}`,
  )
  holderCoverageRpc.decodedRaw = String(balance)
  const withdrawRpc = rpc(
    route.destination,
    `0xf3fef3a3${addressWord(route.asset)}${word(q)}`,
    2,
    '0x',
  )
  if (revert) {
    delete withdrawRpc.response.result
    withdrawRpc.response.error = { code: 3, message: 'execution reverted: insufficient cash' }
  }
  withdrawRpc.decodedAssetsRaw = String(q)
  withdrawRpc.decodedConsumedRaw = null
  const callEvidenceDoc = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    ...row,
    caller: holder,
    blockNumber: '400',
    blockHash,
    coverageKind: 'assets',
    holderCoverageRaw: String(balance),
    requiredCoverageRaw: String(q),
    actualConsumedRaw: null,
    simulationStatus: revert ? 'evm_revert' : 'success',
    holderCoverageRpc,
    requiredCoverageRpc: null,
    withdrawRpc,
    verificationStatus: 'verified',
    replayEvidenceDoc: { schema: 'fixture' },
  }
  return {
    core: {
      caseId: '3',
      horizonH: 1,
      targetAt: '2026-09-30T01:00:00.000001Z',
      deadlineAt: '2026-09-30T03:00:00.000001Z',
      predecessorH: 0,
      predecessorScoreId: null,
      predecessorStatus: 'success',
      predecessorBlock: '300',
      predecessorHash: `0x${'d'.repeat(64)}`,
      predecessorBlockAt: '2026-09-30T00:00:00.000Z',
    },
    target: {
      targetBlock: '400',
      targetHash: blockHash,
      targetBlockAt: '2026-09-30T01:00:12.000Z',
      targetParentBlock: '399',
      targetParentHash: parentHash,
      parentHeaderHash: parentHash,
      targetParentBlockAt: '2026-09-30T01:00:00.000Z',
      targetObservedAt: '2026-09-30T01:00:20.000Z',
      canonicalityEvidenceDoc: { schema: 'fixture' },
    },
    capturedAt: '2026-09-30T01:00:30.000Z',
    row,
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
    assetsRaw: '100',
    baselineStatus: 'success',
    baselineBlock: '300',
    baselineHash: `0x${'d'.repeat(64)}`,
    baselineBlockAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  }
}

test('Comet success can be a borrow: balance<Q is holder attrition, not exit success', () => {
  const score = classifyDirectScore(sample({ balance: 80n }))
  assert.equal(score.status, 'holder_attrition')
  assert.equal(score.entitlementMethod, 'exact_asset_balance')
  assert.equal(score.callEvidenceDoc, null)
  assert.equal(score.entitlementEvidenceDoc.holderCoverageRaw, '80')
})

test('covered direct success and revert require balance at least Q', () => {
  assert.equal(classifyDirectScore(sample()).status, 'success')
  const revert = classifyDirectScore(sample({ revert: true }))
  assert.equal(revert.status, 'covered_revert')
  assert.equal(revert.requiredCoverageRaw, '100')
})

test('direct scorer rejects unverified replay and mutated frozen Q', () => {
  const input = sample()
  assert.throws(() => classifyDirectScore({ ...input, verified: { status: 'unavailable' } }))
  assert.throws(() => classifyDirectScore({ ...input, row: { ...input.row, assetsRaw: '101' } }))
})

test('expired eligible direct case stays pending without independent missing receipt', async () => {
  const result = await scoreDirectDue({
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

test('expired eligible direct case accepts only a recorded missing receipt', async () => {
  const written = []
  const result = await scoreDirectDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('unexpected')
    },
    measure: async () => null,
    readMissing: async () => ({ id: '8', missingReason: 'rpc_unavailable' }),
    writeScore: async (row) => {
      written.push(row)
      return true
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(result.counts.missing, 1)
  assert.equal(written[0].missingReceiptId, '8')
  assert.equal(written[0].targetBlock, undefined)
})

test('within-window direct measurement writes exact target and supplier-balance status', async () => {
  const input = sample()
  const written = []
  const result = await scoreDirectDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => input.target,
    measure: async (row, target) => {
      assert.equal(row.assetsRaw, '100')
      assert.equal(target.targetHash, blockHash)
      return input.verified
    },
    writeScore: async (row) => {
      written.push(row)
      return true
    },
    now: () => new Date('2026-09-30T01:00:30.000Z'),
  })
  assert.equal(result.counts.success, 1)
  assert.equal(written[0].targetBlock, '400')
  assert.equal(written[0].holderCoverageRaw, '120')
})

test('ineligible baseline creates not_eligible control only after deadline', async () => {
  const written = []
  const result = await scoreDirectDue({
    readDue: async () => [due({ baselineStatus: 'ineligible' })],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('unexpected')
    },
    measure: async () => null,
    writeScore: async (row) => {
      written.push(row)
      return true
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(result.counts.not_eligible, 1)
  assert.equal(written[0].targetBlock, null)
})
