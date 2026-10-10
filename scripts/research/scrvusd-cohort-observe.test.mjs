import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem'
import {
  capture,
  makeIssue,
  validateIssue,
  validateSequence,
  parseArgs,
} from './scrvusd-cohort-observe.mjs'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const holderA = '0x' + 'a'.repeat(40)
const holderB = '0x' + 'b'.repeat(40)
const asset = '0x' + 'c'.repeat(40)
const vault = '0x' + 'd'.repeat(40)
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const seedVaultCodeHash = keccak256('0x6000')
const plan = {
  sha256: 'a'.repeat(64),
  physicalSha256: 'b'.repeat(64),
  createdUtc: new Date(500).toISOString(),
  checkpoint: { block: { number: 100 } },
  source: { chainId: 1, vault, crvUsd: asset },
  strata: [
    { rawCrvUsd: '1000', holders: [holderA, holderB] },
    { rawCrvUsd: '10000', holders: [holderA] },
  ],
}
function row(n, captureEndMs = 1700) {
  return {
    filename: `${n}.json`,
    physicalSha256: 'c'.repeat(64),
    checkpoint: {
      sha256: 'd'.repeat(64),
      block: { number: n, hash: hash(n), timestamp: n === 101 ? 1 : 2 },
      captureEndUtc: new Date(captureEndMs).toISOString(),
    },
  }
}
const goodResult = (holder, rawCrvUsd) => ({
  holder,
  rawCrvUsd,
  status: 'success',
  holderCode: '0x',
  balanceSharesRaw: '100000',
  maxWithdrawAssetsRaw: '100000',
  previewSharesRaw: '1',
  sharesBurnedRaw: '1',
})
const results = () => [
  goodResult(holderA, '1000'),
  goodResult(holderB, '1000'),
  goodResult(holderA, '10000'),
]
function issue(checkpointRow = row(101), overrides = {}) {
  return makeIssue({
    plan,
    checkpointRow,
    seedVaultCodeHash,
    sourceStatus: 'matched',
    observedVaultCodeHash: seedVaultCodeHash,
    observedAsset: asset,
    results: results(),
    captureStartUtc: new Date(2500).toISOString(),
    captureEndUtc: new Date(3000).toISOString(),
    ...overrides,
  })
}
const validate = (i, rows = [row(101)]) =>
  validateIssue(i, { plan, checkpointRows: rows, seedVaultCodeHash, nowMs: 5000 })

test('complete roster, source hash, and strict post-plan timing', () => {
  assert.equal(validate(issue()).results.length, 3)
  assert.throws(() => validate(issue(row(100))), /provenance|timing/)
  const sameSecond = row(101)
  sameSecond.checkpoint.block.timestamp = 1
  const latePlan = { ...plan, createdUtc: new Date(2000).toISOString() }
  assert.throws(
    () =>
      validateIssue(issue(sameSecond), {
        plan: latePlan,
        checkpointRows: [sameSecond],
        seedVaultCodeHash,
        nowMs: 5000,
      }),
    /provenance|timing/,
  )
})
test('partial, duplicate, swapped member, and tampered result are rejected', () => {
  assert.throws(() => validate(issue(row(101), { results: results().slice(1) })), /Partial/)
  const duplicate = results()
  duplicate[1] = duplicate[0]
  assert.throws(() => validate(issue(row(101), { results: duplicate })), /member/)
  const swapped = results()
  ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
  assert.throws(() => validate(issue(row(101), { results: swapped })), /member/)
  const tampered = issue()
  tampered.results[0].status = 'revert'
  assert.throws(() => validate(tampered), /seal/)
})
test('source drift is explicit and cannot carry successful member outcomes', () => {
  const drift = issue(row(101), {
    sourceStatus: 'drift',
    observedVaultCodeHash: keccak256('0x6001'),
    results: results().map((r) => ({
      ...r,
      status: 'source_drift',
      holderCode: null,
      balanceSharesRaw: null,
      maxWithdrawAssetsRaw: null,
      previewSharesRaw: null,
      sharesBurnedRaw: null,
    })),
  })
  assert.equal(validate(drift).sourceStatus, 'drift')
  assert.throws(() => validate(issue(row(101), { sourceStatus: 'drift' })), /source status/)
  assert.throws(
    () => validate(issue(row(101), { observedVaultCodeHash: keccak256('0x6001') })),
    /source status/,
  )
  assert.throws(() => validate(issue(row(101), { sourceStatus: 'unavailable' })), /source status/)
  assert.throws(
    () => validate(issue(row(101), { sourceStatus: 'drift', observedVaultCodeHash: null })),
    /source status/,
  )
})
test('provider ambiguity remains distinct from structured EVM revert', () => {
  const mixed = results()
  mixed[0] = { ...mixed[0], status: 'revert', sharesBurnedRaw: null }
  mixed[1] = { ...mixed[1], status: 'provider_error', sharesBurnedRaw: null }
  assert.deepEqual(
    validate(issue(row(101), { results: mixed })).results.map((x) => x.status),
    ['revert', 'provider_error', 'success'],
  )
  assert.throws(
    () =>
      validate(
        issue(row(101), { results: [{ ...mixed[0], sharesBurnedRaw: '1' }, ...mixed.slice(1)] }),
      ),
    /member/,
  )
  const zeroReturn = results()
  zeroReturn[0].sharesBurnedRaw = '0'
  assert.equal(validate(issue(row(101), { results: zeroReturn })).results[0].sharesBurnedRaw, '0')
})
test('sequence rejects skipped eligible checkpoint and later backfill of that miss', () => {
  const first = row(101),
    second = row(102, 2100)
  assert.throws(() => validateSequence([issue(second)], [first, second], plan), /Skipped/)
  const backfilled = issue(first, {
    captureStartUtc: new Date(3200).toISOString(),
    captureEndUtc: new Date(3500).toISOString(),
  })
  assert.throws(
    () => validateSequence([issue(second), backfilled], [first, second], plan),
    /Skipped/,
  )
  assert.equal(
    validateSequence(
      [
        issue(first),
        issue(second, {
          captureStartUtc: new Date(4000).toISOString(),
          captureEndUtc: new Date(4500).toISOString(),
        }),
      ],
      [first, second],
      plan,
    ).length,
    2,
  )
})
test('same-block capture attempts every enrolled pair and caches holder diagnostics', async () => {
  const calls = [],
    source = row(101)
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return params[0] === 'finalized'
          ? { number: '0x66', hash: hash(102) }
          : { number: '0x65', hash: hash(101) }
      if (method === 'eth_getCode') return params[0].toLowerCase() === vault ? '0x6000' : '0x'
      if (method === 'eth_call') {
        const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data })
        if (functionName === 'withdraw' && args[1].toLowerCase() === holderB)
          throw { code: 3, data: '0x08c379a0' }
        if (functionName === 'withdraw' && args[0] === 10000n) throw { code: -32005 }
        const value =
          functionName === 'asset'
            ? asset
            : functionName === 'balanceOf'
              ? 100000n
              : functionName === 'maxWithdraw'
                ? 100000n
                : 1n
        return encodeFunctionResult({ abi: ABI, functionName, result: value })
      }
      throw new Error('Unknown request')
    },
  }
  const actual = await capture({
    client,
    context: { plan, rows: [source], seedVaultCodeHash },
    row: source,
    now: () => new Date(3000),
  })
  assert.deepEqual(
    actual.results.map((x) => x.status),
    ['success', 'revert', 'provider_error'],
  )
  const callsBy = (name) =>
    calls.filter(
      (x) =>
        x.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: x.params[0].data }).functionName === name,
    )
  assert.equal(callsBy('withdraw').length, 3)
  assert.equal(callsBy('balanceOf').length, 2)
  assert.equal(callsBy('previewWithdraw').length, 2)
  assert.ok(
    callsBy('withdraw').every(
      (x) =>
        x.params[0].from ===
        decodeFunctionData({ abi: ABI, data: x.params[0].data }).args[1].toLowerCase(),
    ),
  )
  assert.ok(callsBy('withdraw').every((x) => x.params[1].blockHash === hash(101)))
})
test('CLI is dry and rejects malformed run options', () => {
  assert.deepEqual(parseArgs([]), { mode: '--verify', rpcIndex: 0 })
  assert.throws(() => parseArgs(['--verify', '--rpc-index', '1']), /Invalid/)
  assert.throws(() => parseArgs(['--run', '--rpc-index', '01']), /Invalid/)
})
