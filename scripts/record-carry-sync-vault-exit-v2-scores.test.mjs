import assert from 'node:assert/strict'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  classifySyncVaultScore,
  readDueSyncVaultScores,
  readSyncVaultPendingScoreAudit,
  scoreSyncVaultDue,
} from './record-carry-sync-vault-exit-v2-scores.mjs'

const routes = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) =>
  ['susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(route.kind),
)
const holder = `0x${'a'.repeat(40)}`
const blockHash = `0x${'b'.repeat(64)}`
const baselineHash = `0x${'d'.repeat(64)}`
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

function sample(
  route = routes[0],
  { held = 20n, required = 12n, consumed = 12n, q = 100n, revert = false } = {},
) {
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
    `0x${word(held)}`,
  )
  holderCoverageRpc.decodedRaw = String(held)
  const requiredCoverageRpc = rpc(
    route.destination,
    `0x0a28a477${word(q)}`,
    2,
    `0x${word(required)}`,
  )
  requiredCoverageRpc.decodedRaw = String(required)
  const withdrawRpc = rpc(
    route.destination,
    `0xb460af94${word(q)}${addressWord(holder)}${addressWord(holder)}`,
    3,
    `0x${word(consumed)}`,
  )
  if (revert) {
    delete withdrawRpc.response.result
    withdrawRpc.response.error = { code: 3, message: 'execution reverted: liquidity' }
  }
  withdrawRpc.decodedAssetsRaw = String(q)
  withdrawRpc.decodedConsumedRaw = revert ? null : String(consumed)
  const callEvidenceDoc = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    ...row,
    caller: holder,
    blockNumber: '400',
    blockHash,
    coverageKind: 'shares',
    holderCoverageRaw: String(held),
    requiredCoverageRaw: String(required),
    actualConsumedRaw: revert ? null : String(consumed),
    simulationStatus: revert ? 'evm_revert' : 'success',
    holderCoverageRpc,
    requiredCoverageRpc,
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
    },
    target: {
      targetBlock: '400',
      targetHash: blockHash,
      targetBlockAt: '2026-09-30T01:00:12.000Z',
      targetParentBlock: '399',
      targetParentHash: `0x${'c'.repeat(64)}`,
      parentHeaderHash: `0x${'c'.repeat(64)}`,
      targetParentBlockAt: '2026-09-30T01:00:00.000Z',
      targetObservedAt: '2026-09-30T01:00:20.000Z',
      canonicalityEvidenceDoc: { schema: 'fixture' },
    },
    capturedAt: '2026-09-30T01:00:30.000Z',
    row,
    verified: { status: 'verified', callEvidenceDoc },
  }
}

function due(route = routes[0], overrides = {}) {
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
    baselineHash,
    baselineBlockAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  }
}

test('all eight frozen synchronous vault routes score only verified original-asset withdrawal', () => {
  assert.equal(routes.length, 8)
  for (const route of routes) {
    const score = classifySyncVaultScore(sample(route))
    assert.equal(score.status, 'success', route.routeKey)
    assert.equal(score.coverageKind, 'shares')
    assert.equal(score.requiredCoverageRaw, '12')
    assert.equal(score.actualConsumedRaw, '12')
    assert.equal(score.callEvidenceDoc.asset, route.asset)
  }
})

test('covered revert requires shares held at least previewWithdraw(Q)', () => {
  const covered = classifySyncVaultScore(sample(routes[0], { revert: true }))
  assert.equal(covered.status, 'covered_revert')
  const gap = classifySyncVaultScore(sample(routes[0], { held: 5n, revert: true }))
  assert.equal(gap.status, 'inconclusive')
  assert.equal(gap.inconclusiveReason, 'preview_gap')
  assert.equal(gap.entitlementMethod, null)
  assert.equal(gap.holderCoverageRaw, '5')
})

test('zero shares prove attrition; nonzero preview gap does not', () => {
  const score = classifySyncVaultScore(sample(routes[0], { held: 0n, revert: true }))
  assert.equal(score.status, 'holder_attrition')
  assert.equal(score.entitlementMethod, 'zero_shares')
  assert.equal(score.callEvidenceDoc, null)
})

test('rejects unverified replay, mutated Q, and consumption beyond held shares', () => {
  const input = sample()
  assert.throws(() => classifySyncVaultScore({ ...input, verified: { status: 'unavailable' } }))
  assert.throws(() => classifySyncVaultScore({ ...input, row: { ...input.row, assetsRaw: '101' } }))
  assert.throws(() => classifySyncVaultScore(sample(routes[0], { held: 10n, consumed: 11n })))
})

test('SQL scans only eight vault routes and retains pending coverage counts', async () => {
  const queries = []
  const sql = (parts) => {
    queries.push(parts.join(''))
    return []
  }
  await readDueSyncVaultScores(sql)
  await readSyncVaultPendingScoreAudit(sql)
  for (const route of routes) {
    assert.ok(queries[0].includes(route.routeKey))
    assert.ok(queries[1].includes(route.routeKey))
  }
  assert.match(queries[1], /status = 'pending'/)
  assert.match(queries[0], /predecessor_h/)
})

test('eligible expired outcome stays pending without a recorded missing receipt', async () => {
  const result = await scoreSyncVaultDue({
    readDue: async () => [due()],
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('must not choose after deadline')
    },
    measure: async () => null,
    writeScore: async () => {
      throw Error('must remain pending')
    },
    auditPending: async () => ({ expiredEligiblePending: 1 }),
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  })
  assert.equal(result.counts.missing_receipt_required, 1)
  assert.equal(result.pending.expiredEligiblePending, 1)
  assert.equal(result.forecastValidated, false)
})

test('recorded missing receipt and ineligible baseline produce distinct control rows', async () => {
  const written = []
  const common = {
    readPrior: async () => [],
    chooseTarget: async () => {
      throw Error('not needed')
    },
    measure: async () => null,
    writeScore: async (row) => {
      written.push(row)
      return true
    },
    now: () => new Date('2026-09-30T03:01:00.000Z'),
  }
  await scoreSyncVaultDue({
    ...common,
    readDue: async () => [due()],
    readMissing: async () => ({ id: '8', missingReason: 'rpc_unavailable' }),
  })
  await scoreSyncVaultDue({
    ...common,
    readDue: async () => [due(routes[0], { baselineStatus: 'ineligible' })],
  })
  assert.deepEqual(
    written.map((row) => row.status),
    ['missing', 'not_eligible'],
  )
  assert.equal(written[0].missingReceiptId, '8')
  assert.equal(written[1].targetBlock, null)
})

test('a zero-share predecessor censors the next predeclared horizon', async () => {
  const written = []
  const result = await scoreSyncVaultDue({
    readDue: async () => [
      due(routes[0], {
        horizonH: 4,
        predecessorH: 1,
        targetAt: '2026-09-30T04:00:00.000001Z',
        deadlineAt: '2026-09-30T06:00:00.000001Z',
      }),
    ],
    readPrior: async () => [
      {
        id: '12',
        caseId: '3',
        horizonH: 1,
        status: 'holder_attrition',
        targetBlock: '400',
        targetHash: blockHash,
        targetBlockAt: '2026-09-30T01:00:12.000Z',
      },
    ],
    chooseTarget: async () => {
      throw Error('censored horizon must not measure')
    },
    measure: async () => null,
    writeScore: async (row) => {
      written.push(row)
      return true
    },
    now: () => new Date('2026-09-30T06:01:00.000Z'),
  })
  assert.equal(result.counts.episode_censored, 1)
  assert.equal(written[0].predecessorScoreId, '12')
  assert.equal(written[0].targetBlock, null)
})

test('within-window verified score uses frozen Q and exact first-finalized target', async () => {
  const input = sample()
  const written = []
  const result = await scoreSyncVaultDue({
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
  assert.equal(written[0].actualConsumedRaw, '12')
})
