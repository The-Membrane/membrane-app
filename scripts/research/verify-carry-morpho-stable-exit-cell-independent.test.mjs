import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeFunctionResult, parseAbi } from 'viem'

import { classifyProbe, lossIntervals, qLadder } from './carry-morpho-exit-history-grid.mjs'
import {
  DESIGN,
  freezeFullPlan,
  stableSubjects,
  validateCellResult,
} from './carry-morpho-stable-exit-history.mjs'
import { verifyIndependentCell } from './verify-carry-morpho-stable-exit-cell-independent.mjs'

const subjects = stableSubjects()
const first = subjects[0]
const owner = `0x${'4'.repeat(40)}`
const hash = (n) => `0x${Number(n).toString(16).padStart(64, '0')}`
const amount = 50_000_000n * 1_000_000n
const ABI = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const output = encodeFunctionResult({ abi: ABI, functionName: 'withdraw', result: 100n })
const rpcRevert = () => {
  const rpc = Object.assign(new Error('RPC Request failed'), {
    name: 'RpcRequestError',
    code: 3,
    data: '0x08c379a0',
  })
  return Object.assign(new Error('Execution reverted'), {
    name: 'CallExecutionError',
    cause: rpc,
  })
}

function rpc(shape = {}) {
  const read = {
    missing: false,
    revertAt: null,
    attritionAt: null,
    burnedAt: null,
    wrongAsset: false,
    wrongAssetAt: null,
    wrongBlock: false,
    wrongPriorAt: null,
    ambiguousAt: null,
    calls: 0,
    ...shape,
  }
  const rpcClient = {
    async getChainId() {
      return 1
    },
    async getBlock({ blockTag, blockNumber }) {
      const number = blockTag === 'finalized' ? 30_000_000 : Number(blockNumber)
      return {
        number: BigInt(number),
        hash: hash(number + (read.wrongBlock ? 1 : 0)),
        parentHash: hash(number - 1),
        timestamp: BigInt(number * 12 + (read.wrongPriorAt === number ? 1 : 0)),
      }
    },
    async getCode({ address }) {
      return address === owner ? '0x' : '0x1234'
    },
    async readContract({ address, functionName, blockHash }) {
      if (functionName === 'asset')
        return read.wrongAsset || read.wrongAssetAt === blockHash
          ? `0x${'0'.repeat(40)}`
          : subjects.find((x) => x.vault === address).asset
      if (functionName === 'decimals') return subjects.some((x) => x.vault === address) ? 18 : 6
      if (functionName === 'totalAssets') return amount
      if (functionName === 'balanceOf') return read.attritionAt === blockHash ? 50n : 1000n
      if (functionName === 'previewRedeem') return 10_000n * 1_000_000n
      if (functionName === 'previewWithdraw') return 100n
      throw Error('unexpected_read')
    },
    async call({ blockHash }) {
      read.calls++
      if (read.missing && blockHash === read.missing) throw Error('provider refused archive call')
      if (blockHash === read.ambiguousAt) throw Error('HTTP 502: execution reverted upstream')
      if (blockHash === read.revertAt || blockHash === read.attritionAt) throw rpcRevert()
      if (blockHash === read.burnedAt)
        return { data: encodeFunctionResult({ abi: ABI, functionName: 'withdraw', result: 101n }) }
      return { data: output }
    },
  }
  return { rpcClient, read }
}

const seal = (body) => ({
  ...body,
  cellSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})

async function fixture(scenario = {}) {
  const { rpcClient, read } = rpc(scenario)
  const plan = await freezeFullPlan(rpcClient)
  const anchor = plan.schedule.anchors[0]
  const frozen = plan.cells[0]
  const candidate = {
    owner,
    status: 'eligible_holder',
    receiptVerified: true,
    discoveryBlock: frozen.anchorBlock - 1,
    sharesRaw: '1000',
    claimRaw: '10000000000',
  }
  const sizes = qLadder(amount, 10_000n * 1_000_000n, 6, DESIGN).map((size) => ({
    ...size,
    baseline: null,
    horizons: [],
  }))
  for (const size of sizes) {
    if (!size.eligible) continue
    const checkpoints = [
      { hours: 0, hash: anchor.anchor.hash },
      ...anchor.horizons.map((h) => ({ hours: h.hours, hash: h.hash })),
    ]
    for (const point of checkpoints) {
      const changed = read.wrongAssetAt === point.hash
      const shares = read.attritionAt === point.hash ? '50' : '1000'
      const state = changed
        ? { status: 'not_read_identity' }
        : { status: 'measured', eoa: true, sharesRaw: shares, previewSharesRaw: '100' }
      const call = changed
        ? { status: 'not_read_identity' }
        : point.hash === read.revertAt || point.hash === read.attritionAt
          ? { status: 'evm_revert' }
          : { status: 'success', sharesBurnedRaw: '100' }
      const identity = changed
        ? {
            status: 'identity_changed',
            observedAsset: `0x${'0'.repeat(40)}`,
            shareDecimals: 18,
            assetDecimals: 6,
          }
        : { status: 'confirmed', shareDecimals: 18, assetDecimals: 6 }
      const classification = classifyProbe(identity, state, call)
      if (point.hours === 0) size.baseline = { state, call, class: classification }
      else
        size.horizons.push({
          hours: point.hours,
          identity,
          state,
          call,
          class: classification,
        })
    }
    size.exitInterval = lossIntervals(size)
  }
  const row = {
    vault: first.vault,
    asset: first.asset,
    anchorBlock: frozen.anchorBlock,
    status: 'measured',
    baselineIdentity: { status: 'confirmed', shareDecimals: 18, assetDecimals: 6 },
    totalAssetsRaw: amount.toString(),
    candidateWindow: {
      fromBlock: frozen.anchorBlock - DESIGN.candidateLookbackBlocks,
      throughBlock: frozen.anchorBlock - 1,
      transferLogs: 1,
      distinctRecipients: 1,
      screened: 1,
    },
    screenedCandidates: [candidate],
    holder: owner,
    holderDiscovery: candidate,
    anchorSharesRaw: '1000',
    anchorClaimRaw: '10000000000',
    sizes,
  }
  const cell = seal({
    planSha256: plan.planSha256,
    anchorBlock: frozen.anchorBlock,
    vault: first.vault,
    routeKey: first.routeKey,
    status: 'measured',
    row,
  })
  assert.equal(validateCellResult(plan, cell), true)
  return { plan, cell, rpcClient, read, anchor }
}

test('exact saved holder/Q replay agrees without querying transfer logs', async () => {
  const f = await fixture()
  const result = await verifyIndependentCell(f.rpcClient, f.plan, f.cell)
  assert.equal(result.status, 'agreement')
  assert.equal(result.checkedProbes, 6)
  assert.equal(result.checkedIntervals, 1)
  assert.equal(result.discovery, 'saved_selection_not_independently_replayed')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(owner, 'i'))
})

test('provider missing at a covered horizon is explicit unavailable, not saved agreement', async () => {
  const f = await fixture()
  f.read.missing = f.anchor.horizons[0].hash
  const result = await verifyIndependentCell(f.rpcClient, f.plan, f.cell)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.stages.q1_h1, 'rpc_unavailable')
})

test('independent covered revert and consumed shares disagreements are mismatches', async () => {
  const f = await fixture()
  f.read.revertAt = f.anchor.horizons[0].hash
  assert.equal((await verifyIndependentCell(f.rpcClient, f.plan, f.cell)).status, 'mismatch')
  f.read.revertAt = null
  f.read.burnedAt = f.anchor.horizons[0].hash
  assert.equal((await verifyIndependentCell(f.rpcClient, f.plan, f.cell)).status, 'mismatch')
})

test('transport message mentioning revert cannot confirm saved loss', async () => {
  const lossHash = hash(25_400_300)
  const f = await fixture({ revertAt: lossHash })
  f.read.revertAt = null
  f.read.ambiguousAt = lossHash
  const result = await verifyIndependentCell(f.rpcClient, f.plan, f.cell)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.stages.q1_h1, 'rpc_unavailable')
})

test('target predecessor disagreement cannot confirm first block or interval', async () => {
  const f = await fixture()
  f.read.wrongPriorAt = f.anchor.horizons[0].number - 1
  const result = await verifyIndependentCell(f.rpcClient, f.plan, f.cell)
  assert.equal(result.status, 'mismatch')
  assert.equal(result.stages.h1_header, 'first_target_block_disagreement')
})

test('attrition censors later recovery while covered loss and recovery intervals agree', async () => {
  const lossHash = hash(25_400_300)
  const recovered = await fixture({ revertAt: lossHash })
  const agreement = await verifyIndependentCell(recovered.rpcClient, recovered.plan, recovered.cell)
  assert.equal(agreement.status, 'agreement')
  assert.deepEqual(recovered.cell.row.sizes[0].exitInterval.firstLoss, {
    afterHours: 0,
    throughHours: 1,
    class: 'evm_revert',
  })
  assert.deepEqual(recovered.cell.row.sizes[0].exitInterval.recovery, {
    afterHours: 1,
    throughHours: 4,
  })
  const attrited = await fixture({ attritionAt: lossHash })
  assert.equal(
    (await verifyIndependentCell(attrited.rpcClient, attrited.plan, attrited.cell)).status,
    'agreement',
  )
  assert.equal(attrited.cell.row.sizes[0].exitInterval.censoring.class, 'holder_attrition')
  assert.equal(attrited.cell.row.sizes[0].exitInterval.recovery, null)
})

test('saved horizon identity change is independently classified and censored', async () => {
  const f = await fixture({ wrongAssetAt: hash(25_400_300) })
  const result = await verifyIndependentCell(f.rpcClient, f.plan, f.cell)
  assert.equal(result.status, 'agreement')
  assert.equal(f.cell.row.sizes[0].exitInterval.censoring.class, 'identity_changed')
})

test('route identity and canonical header mismatch fail closed before holder calls', async () => {
  const f = await fixture()
  f.read.wrongAsset = true
  assert.equal(
    (await verifyIndependentCell(f.rpcClient, f.plan, f.cell)).stages.anchor_identity,
    'route_or_decimals_changed',
  )
  f.read.wrongAsset = false
  f.read.wrongBlock = true
  assert.equal(
    (await verifyIndependentCell(f.rpcClient, f.plan, f.cell)).stages.anchor_header,
    'block_header_changed',
  )
})
