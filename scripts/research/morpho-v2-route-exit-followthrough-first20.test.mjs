import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { keccak256 } from 'viem'
import {
  BASELINE_SHA, HEADERS_SHA, classifyCallError, probeAtB, safeSelector,
  seal, selectEligible, validateOutput,
} from './morpho-v2-route-exit-followthrough-first20.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = (name, expected) => {
  const bytes = readFileSync(resolve(`data/research/venue-signals/${name}`))
  assert.equal(sha(bytes), expected)
  return JSON.parse(bytes)
}

test('frozen 20 route baseline retains five and only five successful B-1 rows', () => {
  const baseline = fixture('morpho-v2-route-exit-baseline-first20.json', BASELINE_SHA)
  const headers = fixture('morpho-v2-route-address-headers.json', HEADERS_SHA)
  const eligible = selectEligible(baseline, headers)
  assert.deepEqual(eligible.map((x) => x.index), [8, 14, 15, 16, 18])
  assert.equal(eligible.length, 5)
  assert.throws(() => selectEligible({ ...baseline, frozenDenominator: 5 }, headers))
  assert.throws(() => selectEligible({ ...baseline, results: baseline.results.slice(0, 19) }, headers))
  assert.throws(() => selectEligible(baseline, { ...headers, status: 'partial' }))
})

const eligible = { index: 8, vault: '0x1111111111111111111111111111111111111111',
  block: 100, blockHash: `0x${'a'.repeat(64)}`,
  holder: '0x2222222222222222222222222222222222222222',
  qAssets: '100', asset: '0x3333333333333333333333333333333333333333',
  expectedAdapter: '0x4444444444444444444444444444444444444444',
  runtimeCodeHash: keccak256('0x6000') }
function client(overrides = {}) {
  const calls = []
  const stub = {
    calls,
    getBlock: async ({ blockNumber }) => {
      calls.push(['getBlock', Number(blockNumber)])
      return { number: 100n, hash: eligible.blockHash }
    },
    getCode: async ({ blockNumber }) => {
      calls.push(['getCode', Number(blockNumber)])
      return '0x6000'
    },
    readContract: async ({ functionName, blockNumber }) => {
      calls.push([functionName, Number(blockNumber)])
      return { asset: eligible.asset, liquidityAdapter: eligible.expectedAdapter,
        balanceOf: 1000n, previewRedeem: 500n }[functionName]
    },
    request: async ({ method, params }) => {
      calls.push([method, Number(BigInt(params[1])), params[0].from, params[0].gas])
      return `0x${'0'.repeat(63)}a`
    },
    ...overrides,
  }
  return stub
}

test('B replay uses only block B, 20M gas and same holder origin; censors attrition', async () => {
  const ok = client()
  const result = await probeAtB(ok, eligible)
  assert.equal(result.status, 'b-success')
  assert.equal(result.withdrawShares, '10')
  assert.ok(ok.calls.every((x) => x[1] === 100))
  assert.deepEqual(ok.calls.at(-1), ['eth_call', 100, eligible.holder, '0x1312d00'])
  const depleted = client({ readContract: async ({ functionName }) =>
    functionName === 'previewRedeem' ? 99n :
      { asset: eligible.asset, liquidityAdapter: eligible.expectedAdapter,
        balanceOf: 1000n }[functionName] })
  assert.equal((await probeAtB(depleted, eligible)).status, 'b-holder-attrition')
  assert.equal(depleted.calls.filter((x) => x[0] === 'eth_call').length, 0)
})

test('header, code and route changes are ambiguous rather than exit failures', async () => {
  const wrongHeader = client({ getBlock: async () => ({ number: 100n, hash: `0x${'b'.repeat(64)}` }) })
  assert.equal((await probeAtB(wrongHeader, eligible)).status, 'b-ambiguous-header')
  const wrongCode = client({ getCode: async () => '0x6001' })
  assert.equal((await probeAtB(wrongCode, eligible)).status, 'b-ambiguous-code')
  const wrongRoute = client({ readContract: async ({ functionName }) =>
    functionName === 'liquidityAdapter' ? '0x5555555555555555555555555555555555555555' :
      eligible.asset })
  assert.equal((await probeAtB(wrongRoute, eligible)).status, 'b-ambiguous-route')
})

test('revert selector is bounded and RPC failures cannot inherit EVM label', async () => {
  assert.equal(safeSelector({ data: '0xe450d38c' + 'a'.repeat(64) }), '0xe450d38c')
  assert.deepEqual(classifyCallError({ name: 'RpcRequestError', message: 'timeout' }),
    { status: 'b-rpc-error', errorSelector: null })
  const reverting = client({ request: async () => { throw { name: 'ContractFunctionRevertedError',
    data: '0xe450d38c' + 'a'.repeat(64) } } })
  assert.deepEqual({ ...(await probeAtB(reverting, eligible)), status: undefined }.errorSelector,
    '0xe450d38c')
  assert.equal((await probeAtB(reverting, eligible)).status, 'b-evm-revert')
})

test('resume checkpoint validates exact result prefix and seal', () => {
  const one = { ...eligible, index: 8 }
  const two = { ...eligible, index: 14, vault: '0x5555555555555555555555555555555555555555' }
  const selected = [one, two]
  const expected = { study: 'morpho-v2-route-exit-followthrough-first20-v1', chainId: 1,
    baselineSha256: BASELINE_SHA, headersSha256: HEADERS_SHA,
    frozenDenominator: 20, baselineSuccessDenominator: 5, eligible: selected }
  const partial = seal({ ...expected, status: 'partial', results: [{ index: 8,
    vault: one.vault, block: one.block, blockHash: one.blockHash,
    holder: one.holder, qAssets: one.qAssets, status: 'b-success' }] })
  assert.equal(validateOutput(partial, selected), partial)
  assert.throws(() => validateOutput({ ...partial, results: [] }, selected))
  assert.throws(() => validateOutput(seal({ ...partial, results: [{ ...partial.results[0], index: 14 }] }), selected))
  assert.throws(() => validateOutput(seal({ ...partial, frozenDenominator: 5 }), selected))
})
