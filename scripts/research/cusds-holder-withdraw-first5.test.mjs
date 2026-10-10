import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  CALL_GAS,
  EIP1967_IMPLEMENTATION_SLOT,
  assertCanonicalSavedPosts,
  classify,
  isExplicitCashRevert,
  isRevertError,
  probeStage,
} from './cusds-holder-withdraw-first5.mjs'
import { BASE, COMET, Q } from './cusds-holder-feasibility-first5.mjs'

const ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function isWithdrawPaused() view returns (bool)',
  'function withdraw(address asset, uint256 amount)',
])
const blockHash = `0x${'a'.repeat(64)}`
const holder = `0x${'b'.repeat(40)}`
const impl = `0x${'c'.repeat(40)}`
const zeroSlot = `0x${'0'.repeat(64)}`
const code = {
  comet: { hash: `0x${'1'.repeat(64)}`, bytes: 1 },
  base: { hash: `0x${'2'.repeat(64)}`, bytes: 1 },
  cometImplementation: { address: impl, hash: `0x${'3'.repeat(64)}`, bytes: 1 },
  baseImplementation: null,
}
const ok = {
  status: 'success',
  balanceRaw: Q.toString(),
  cashRaw: Q.toString(),
  paused: false,
  code,
}

test('classification requires an eligible B-1 success and preserves attrition/preexisting/provider paths', () => {
  assert.equal(classify(null, null), 'pending')
  assert.equal(classify(ok, ok), 'success')
  assert.equal(classify({ ...ok, status: 'revert' }, ok), 'preexisting-revert')
  assert.equal(classify(ok, { ...ok, status: 'attrition', balanceRaw: '0' }), 'holder-attrition')
  assert.equal(classify(ok, { ...ok, status: 'provider-error' }), 'provider-error')
})

test('low cash alone never labels a revert as cash shortage', () => {
  const low = { ...ok, status: 'revert', cashRaw: '0', error: { message: 'execution reverted' } }
  assert.equal(classify(ok, low), 'other-revert')
  assert.equal(classify(ok, { ...low, paused: true }), 'pause')
  assert.equal(
    classify(ok, { ...low, error: { message: 'ERC20InsufficientBalance' } }),
    'insufficient-cash',
  )
  assert.equal(
    classify(ok, { ...low, cashRaw: Q.toString(), error: { message: 'ERC20InsufficientBalance' } }),
    'other-revert',
  )
  assert.equal(isExplicitCashRevert({ message: 'transfer amount exceeds balance' }), true)
})

test('implementation or runtime changes are a separate interpretation guard', () => {
  const changedImpl = {
    ...ok,
    code: {
      ...code,
      cometImplementation: { ...code.cometImplementation, hash: `0x${'4'.repeat(64)}` },
    },
  }
  assert.equal(classify(ok, changedImpl), 'code-change')
  const changedBase = { ...ok, code: { ...code, base: { hash: `0x${'5'.repeat(64)}`, bytes: 1 } } }
  assert.equal(classify(ok, changedBase), 'code-change')
  assert.equal(
    classify(ok, {
      ...changedImpl,
      status: 'revert',
      cashRaw: '0',
      error: { message: 'ERC20InsufficientBalance' },
    }),
    'code-change',
  )
})

test('revert detection separates provider failure from EVM revert', () => {
  assert.equal(isRevertError({ message: 'execution reverted' }), true)
  assert.equal(isRevertError({ message: 'timeout fetching archive state', code: '-32000' }), false)
  assert.equal(isRevertError({ message: 'call failed', code: '3', data: '0x1234' }), true)
})

function mockClient({
  balance = Q,
  cash = Q,
  paused = false,
  withdrawError = null,
  emptyCometCode = false,
} = {}) {
  const calls = []
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_getCode') {
        assert.deepEqual(params[1], { blockHash, requireCanonical: true })
        return params[0] === COMET && emptyCometCode ? '0x' : '0x6000'
      }
      if (method === 'eth_getStorageAt') {
        assert.equal(params[1], EIP1967_IMPLEMENTATION_SLOT)
        assert.deepEqual(params[2], { blockHash, requireCanonical: true })
        return params[0] === COMET ? `0x${'0'.repeat(24)}${impl.slice(2)}` : zeroSlot
      }
      assert.equal(method, 'eth_call')
      assert.deepEqual(params[1], { blockHash, requireCanonical: true })
      const tx = params[0]
      const decoded = decodeFunctionData({ abi: ABI, data: tx.data })
      if (decoded.functionName === 'withdraw') {
        assert.equal(tx.from, holder)
        assert.equal(tx.to, COMET)
        assert.equal(decoded.args[0].toLowerCase(), BASE)
        assert.equal(decoded.args[1], Q)
        assert.equal(tx.gas, `0x${CALL_GAS.toString(16)}`)
        if (withdrawError) throw withdrawError
        return '0x'
      }
      if (decoded.functionName === 'isWithdrawPaused')
        return encodeFunctionResult({ abi: ABI, functionName: 'isWithdrawPaused', result: paused })
      assert.equal(decoded.functionName, 'balanceOf')
      return encodeFunctionResult({
        abi: ABI,
        functionName: 'balanceOf',
        result: tx.to === COMET ? balance : cash,
      })
    },
  }
}

test('probe uses EIP-1898 on every state call and simulates same holder/q only when funded', async () => {
  const client = mockClient()
  const result = await probeStage(client, { block: 23_253_205, blockHash, holder })
  assert.equal(result.status, 'success')
  assert.equal(client.calls.length, 9)
  assert.equal(result.code.cometImplementation.address, impl)
  assert.equal(result.code.cometImplementation.bytes, 2)
  assert.equal(result.code.baseImplementation, null)
  const unfunded = mockClient({ balance: Q - 1n })
  const attrition = await probeStage(unfunded, { block: 23_253_206, blockHash, holder })
  assert.equal(attrition.status, 'attrition')
  assert.equal(unfunded.calls.length, 8)
  await assert.rejects(
    probeStage(mockClient({ emptyCometCode: true }), { block: 23_253_206, blockHash, holder }),
    /Missing or invalid pinned runtime code/,
  )
})

test('withdraw EVM revert retains raw error; provider timeout remains a different stage', async () => {
  const reverted = await probeStage(
    mockClient({ withdrawError: new Error('execution reverted: transfer amount exceeds balance') }),
    { block: 23_253_206, blockHash, holder },
  )
  assert.equal(reverted.status, 'revert')
  assert.match(reverted.error.message, /transfer amount/)
  const failed = await probeStage(mockClient({ withdrawError: new Error('network timeout') }), {
    block: 23_253_206,
    blockHash,
    holder,
  })
  assert.equal(failed.status, 'provider-error')
  const outer = new Error('Contract call failed')
  outer.shortMessage = 'The contract function failed'
  outer.cause = { code: -32000, details: 'execution reverted: insufficient token balance' }
  const nested = await probeStage(mockClient({ withdrawError: outer }), {
    block: 23_253_206,
    blockHash,
    holder,
  })
  assert.equal(nested.status, 'revert')
  assert.match(nested.error.message, /insufficient token balance/)
  const leaked = new Error('RPC Request failed.\n\nURL: https://archive.example/private-token')
  leaked.shortMessage = 'RPC Request failed.'
  leaked.cause = { code: 3, details: 'execution reverted: Usds/insufficient-balance' }
  const sanitized = await probeStage(mockClient({ withdrawError: leaked }), {
    block: 23_253_206,
    blockHash,
    holder,
  })
  assert.equal(sanitized.status, 'revert')
  assert.match(sanitized.error.message, /Usds\/insufficient-balance/)
  assert.doesNotMatch(sanitized.error.message, /private-token|URL:/)
})

test('saved B hashes are rechecked against current canonical headers on resume', async () => {
  const saved = { results: [{ onset: 23_253_206, post: { blockHash } }] }
  await assertCanonicalSavedPosts(
    { getBlock: async () => ({ number: 23_253_206n, hash: blockHash }) },
    saved,
  )
  await assert.rejects(
    assertCanonicalSavedPosts(
      { getBlock: async () => ({ number: 23_253_206n, hash: `0x${'d'.repeat(64)}` }) },
      saved,
    ),
    /Saved B hash differs/,
  )
})
