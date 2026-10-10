import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFunctionResult, parseAbi } from 'viem'

import { assay } from './carry-public-apyusd-exit-common.mjs'

const holder = `0x${'a'.repeat(40)}`
const hash = `0x${'b'.repeat(64)}`
const abi = parseAbi([
  'function withdrawForReceipt(uint256,address,address) returns (uint256,uint256)',
])

test('receipt initiation success records a simulated token id but no payout', async () => {
  const response = encodeFunctionResult({
    abi,
    functionName: 'withdrawForReceipt',
    result: [4n, 9n],
  })
  const result = await assay({ send: async () => ({ result: response }) }, holder, '100', hash)
  assert.deepEqual(result, {
    status: 'initiation_success',
    sharesRaw: '4',
    simulatedReceiptId: '9',
  })
})

test('only explicit execution revert is a measured failure', async () => {
  const reverted = await assay(
    { send: async () => ({ error: { code: 3, message: 'execution reverted' } }) },
    holder,
    '100',
    hash,
  )
  assert.equal(reverted.status, 'evm_revert')
  await assert.rejects(
    assay(
      { send: async () => ({ error: { code: -32000, message: 'public rpc error' } }) },
      holder,
      '100',
      hash,
    ),
    /apyusd_assay_rpc_retry/,
  )
})

test('invalid amount cannot enter an initiation assay', async () => {
  await assert.rejects(
    assay({ send: async () => ({ result: '0x' }) }, holder, '0', hash),
    /apyusd_assay_input_invalid/,
  )
})
