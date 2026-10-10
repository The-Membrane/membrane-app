import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { encodeFunctionResult, keccak256, parseAbi } from 'viem'
import {
  loadPlan,
  readState,
  verifySnapshot,
  STUDY,
  TREATED_SHA,
  CONTROLS_SHA,
} from './morpho-v2-first-anchor-outcome-v2.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

const root = resolve('data/research/venue-signals')
const paths = {
  treatedPath: resolve(root, 'morpho-v2-signer-baseline-v2.json'),
  controlsPath: resolve(root, 'morpho-v2-first-anchor-controls-v2.json'),
  stage1Path: resolve(root, `${STAGE1_SHA}.json`),
}
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const hash = (value) => `0x${value.toString(16).padStart(64, '0')}`
function snapshot(plan) {
  return {
    study: STUDY,
    version: 2,
    status: 'partial',
    sourceSha256: { treated: TREATED_SHA, controls: CONTROLS_SHA, stage1: STAGE1_SHA },
    denominator: plan.denominator,
    anchorBlock: plan.anchorBlock,
    anchorTimestamp: plan.anchorTimestamp,
    executableAt: plan.executableAt,
    coInterventionTimes: plan.coInterventionTimes,
    estimand:
      'fixed 11024 raw asset-unit, code-empty holder eth_call; plumbing only, signer control unproven',
    prospective: false,
    selectionCaveat:
      'treated selects first largest code-empty holder before withdraw; controls may try successive holders after revert',
    rows: plan.rows.map((r) => ({ ...r, baseline: null, outcomes: {} })),
  }
}
function seal(s) {
  const { checkpointSha256: _, ...body } = s
  return {
    ...body,
    checkpointSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }
}

test('dry source plan pins corrected first anchor and unchanged fixed q/order', () => {
  const plan = loadPlan(paths)
  assert.equal(plan.denominator, 304)
  assert.equal(plan.anchorBlock, 24335711)
  assert.equal(plan.executableAt, 1769891051)
  assert.deepEqual(
    plan.rows.map((r) => r.qAssets),
    ['11024', '11024', '11024'],
  )
  assert.deepEqual(
    plan.rows.map((r) => r.vault),
    [
      '0xd8a6511979d9c5d387c819e9f8ed9f3a5c6c5379',
      '0xbeef00b5d83c1188f07a5184230a805639c39f04',
      '0xb576765fb15505433af24fee2c0325895c559fb2',
    ],
  )
})

test('offline verifier refuses changed denominator, holder and target timing even after resealing', () => {
  const plan = loadPlan(paths)
  const original = seal(snapshot(plan))
  assert.equal(verifySnapshot(original, plan).status, 'partial')
  assert.throws(() => verifySnapshot({ ...original, denominator: 2 }, plan), /checksum/)
  const altered = structuredClone(original)
  altered.rows[0].holder = plan.rows[1].holder
  assert.throws(() => verifySnapshot(seal(altered), plan), /frozen holder/)
  const wrongBaseline = structuredClone(original)
  wrongBaseline.rows[0].baseline = {
    block: plan.rows[0].preBlock,
    hash: plan.rows[0].preBlockHash,
    status: 'baseline-observed',
    runtimeCodeHash: plan.rows[0].baselineRuntimeCodeHash,
    holderClaimAssets: '11025',
    censoring: [],
  }
  assert.throws(() => verifySnapshot(seal(wrongBaseline), plan), /Baseline claim mismatch/)
  const timed = structuredClone(original)
  timed.rows[0].outcomes.plus24h = {
    status: 'success',
    block: 24340000,
    hash: hash(3),
    timestamp: plan.executableAt + 86400,
    targetTimestamp: plan.executableAt + 86401,
    realLeadSeconds: 86400,
  }
  assert.throws(() => verifySnapshot(seal(timed), plan), /Target timestamp/)
  const forged = structuredClone(original)
  forged.rows[0].baseline = {
    block: plan.rows[0].preBlock,
    hash: plan.rows[0].preBlockHash,
    timestamp: plan.anchorTimestamp - 12,
    gasLimit: '36000000',
    censoring: [],
    status: 'baseline-observed',
    runtimeCodeHash: plan.rows[0].baselineRuntimeCodeHash,
    holderCodeHash: null,
    proxyImplementation: null,
    asset: plan.rows[1].baselineAsset,
    adapter: plan.rows[1].baselineAdapter,
    holderShares: '20000',
    holderClaimAssets: plan.rows[0].baselineClaimAssets,
  }
  const target = plan.executableAt + 86400
  forged.rows[0].outcomes.plus24h = {
    status: 'success',
    call: 'success',
    block: plan.anchorBlock + 2,
    hash: hash(3),
    timestamp: target,
    gasLimit: '36000000',
    targetTimestamp: target,
    scheduledLeadSeconds: target - plan.anchorTimestamp,
    previousHeader: { block: plan.anchorBlock + 1, timestamp: target - 12 },
    finalizedHead: { block: plan.anchorBlock + 3, hash: hash(4) },
    censoring: [],
  }
  assert.throws(
    () => verifySnapshot(seal(forged), plan),
    /Missing successful output|Missing vault-code error/,
  )
  forged.rows[0].outcomes.plus24h.previousHeader.timestamp = target + 1
  assert.throws(() => verifySnapshot(seal(forged), plan), /First finalized target block evidence/)
})

test('hash-pinned 30m withdrawal preserves success with changed adapter censor', async () => {
  const code = '0x60006000'
  const vault = '0x1111111111111111111111111111111111111111'
  const holder = '0x2222222222222222222222222222222222222222'
  const asset = '0x3333333333333333333333333333333333333333'
  const oldAdapter = '0x4444444444444444444444444444444444444444'
  const newAdapter = '0x5555555555555555555555555555555555555555'
  const h = { block: 100, hash: hash(100), timestamp: 1000, gasLimit: '36000000' }
  const row = {
    vault,
    holder,
    qAssets: '11024',
    baselineRuntimeCodeHash: keccak256(code),
    baselineClaimAssets: '20000',
    baseline: { asset, adapter: oldAdapter, proxyImplementation: null },
  }
  let withdrawRequest
  const request = async (method, params) => {
    if (method === 'eth_getCode') {
      assert.deepEqual(params[1], { blockHash: h.hash, requireCanonical: true })
      return params[0] === vault ? code : '0x'
    }
    if (method === 'eth_getStorageAt') return hash(0)
    assert.equal(method, 'eth_call')
    assert.deepEqual(params[1], { blockHash: h.hash, requireCanonical: true })
    if (params[0].data.startsWith('0xb460af94')) {
      withdrawRequest = params[0]
      return encodeFunctionResult({ abi: ABI, functionName: 'withdraw', result: 10n })
    }
    const selector = params[0].data.slice(0, 10)
    const answers = {
      '0x38d52e0f': ['asset', asset],
      '0x70a08231': ['balanceOf', 20000n],
      '0x4cdad506': ['previewRedeem', 20000n],
      '0xad468d11': ['liquidityAdapter', newAdapter],
    }
    const [functionName, result] = answers[selector] || []
    assert.ok(functionName, `unknown selector ${selector}`)
    return encodeFunctionResult({ abi: ABI, functionName, result })
  }
  const outcome = await readState(request, row, h, false)
  assert.equal(outcome.call, 'success')
  assert.equal(outcome.status, 'censored')
  assert.deepEqual(outcome.censoring, ['adapter-changed'])
  assert.equal(withdrawRequest.gas, '0x1c9c380')
  assert.equal(withdrawRequest.from, holder)
})

test('reverting fixed-q call stays a revert, not a successful exit', async () => {
  const code = '0x6000'
  const vault = '0x1111111111111111111111111111111111111111'
  const holder = '0x2222222222222222222222222222222222222222'
  const asset = '0x3333333333333333333333333333333333333333'
  const adapter = '0x4444444444444444444444444444444444444444'
  const h = { block: 100, hash: hash(100), timestamp: 1000, gasLimit: '36000000' }
  const row = {
    vault,
    holder,
    qAssets: '11024',
    baselineRuntimeCodeHash: keccak256(code),
    baselineClaimAssets: '20000',
    baseline: { asset, adapter, proxyImplementation: null },
  }
  const request = async (method, params) => {
    if (method === 'eth_getCode') return params[0] === vault ? code : '0x'
    if (method === 'eth_getStorageAt') return hash(0)
    const selector = params[0].data.slice(0, 10)
    if (selector === '0xb460af94') throw new Error('execution reverted')
    const answers = {
      '0x38d52e0f': ['asset', asset],
      '0x70a08231': ['balanceOf', 20000n],
      '0x4cdad506': ['previewRedeem', 20000n],
      '0xad468d11': ['liquidityAdapter', adapter],
    }
    const [functionName, result] = answers[selector] || []
    assert.ok(functionName)
    return encodeFunctionResult({ abi: ABI, functionName, result })
  }
  const outcome = await readState(request, row, h, false)
  assert.equal(outcome.status, 'evm-revert')
  assert.equal(outcome.call, 'evm-revert')
  assert.deepEqual(outcome.censoring, [])
  const transportRequest = async (method, params) => {
    if (method === 'eth_call' && params[0].data.slice(0, 10) === '0xb460af94')
      throw new Error('provider unavailable')
    return request(method, params)
  }
  const unresolved = await readState(transportRequest, row, h, false)
  assert.equal(unresolved.call, 'rpc-or-archive-error')
  assert.equal(unresolved.status, 'censored')
  assert.ok(unresolved.censoring.includes('call-unresolved'))
})
