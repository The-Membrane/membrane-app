import assert from 'node:assert/strict'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { ASSET, VAULT } from './carry-public-apyusd-exit-common.mjs'
import { RECEIPT } from './apyusd-receipt-cohort-source.mjs'
import { readHolderPayout, readOne } from './apyusd-receipt-cohort-payouts.mjs'

const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const topic = keccak256(stringToHex('Transfer(address,address,uint256)'))
const holder = '0x0000000000000000000000000000000000000011'
const other = '0x0000000000000000000000000000000000000022'
const sender = `0x${RECEIPT.slice(2).padStart(64, '0')}`

function transfer(to, amount, logIndex) {
  return {
    address: ASSET,
    logIndex: `0x${logIndex.toString(16)}`,
    topics: [topic, sender, `0x${to.slice(2).padStart(64, '0')}`],
    data: word(amount),
  }
}

test('holder payout excludes a same-transaction transfer to a third party', () => {
  const receipt = { logs: [transfer(holder, 100, 1), transfer(other, 7, 2)] }
  assert.equal(readHolderPayout(receipt, holder), '100')
})

test('holder payout requires exactly one positive holder transfer', () => {
  assert.throws(() => readHolderPayout({ logs: [transfer(other, 7, 1)] }, holder))
  assert.throws(() => readHolderPayout({ logs: [transfer(holder, 0, 1)] }, holder))
  assert.throws(() =>
    readHolderPayout({ logs: [transfer(holder, 1, 1), transfer(holder, 2, 2)] }, holder),
  )
})

test('postcutoff payout requires exactly one receipt burn in the mined transaction', async () => {
  const mint = {
    blockNumber: 100,
    blockHash: word(100),
    transactionHash: word(101),
    logIndex: 1,
    topics: [topic, word(0), `0x${holder.slice(2).padStart(64, '0')}`, word(881)],
    data: '0x',
  }
  const burn = {
    blockNumber: 200,
    blockHash: word(200),
    transactionHash: word(201),
    logIndex: 2,
    topics: [topic, mint.topics[2], word(0), word(881)],
    data: '0x',
  }
  const log = (event) => ({
    ...event,
    address: RECEIPT,
    logIndex: `0x${event.logIndex.toString(16)}`,
  })
  const request = {
    status: '0x1',
    transactionHash: mint.transactionHash,
    blockHash: mint.blockHash,
    blockNumber: '0x64',
    logs: [
      log(mint),
      {
        address: VAULT,
        logIndex: '0x2',
        topics: [keccak256(stringToHex('Withdraw(address,address,address,uint256,uint256)'))],
        data: `0x${1000n.toString(16).padStart(64, '0')}${'0'.repeat(64)}`,
      },
    ],
  }
  const payout = {
    status: '0x1',
    transactionHash: burn.transactionHash,
    blockHash: burn.blockHash,
    blockNumber: '0xc8',
    logs: [log(burn), transfer(holder, 900, 3)],
  }
  const origin = {
    request: async (method, params) => {
      if (method === 'eth_getTransactionReceipt')
        return params[0] === mint.transactionHash ? request : payout
      if (method === 'eth_getBlockByHash')
        return {
          hash: params[0],
          number: params[0] === mint.blockHash ? '0x64' : '0xc8',
          timestamp: params[0] === mint.blockHash ? '0x3e8' : '0x7d0',
        }
      if (method === 'eth_getBlockByNumber')
        return { hash: burn.blockHash, number: '0xc8', timestamp: '0x7d0' }
      throw Error('unexpected_request')
    },
  }
  const strict = { requireUniqueBurn: true, includePayoutWitness: true, requireCanonicalBurn: true }
  const proof = await readOne(origin, mint, burn, strict)
  assert.equal(proof.payout.paidAssetRaw, '900')
  assert.equal(proof.payout.payoutTransferWitness.logIndex, 3)
  payout.logs.push(log({ ...burn, logIndex: 4, topics: [topic, word(22), word(0), word(882)] }))
  await assert.rejects(
    readOne(origin, mint, burn, strict),
    /apyusd_cohort_ambiguous_burn_transaction/,
  )
  payout.logs.pop()
  const staleOrigin = {
    request: async (method, params) =>
      method === 'eth_getBlockByNumber'
        ? { hash: word(999), number: '0xc8', timestamp: '0x7d0' }
        : origin.request(method, params),
  }
  await assert.rejects(
    readOne(staleOrigin, mint, burn, strict),
    /apyusd_cohort_payout_header_invalid/,
  )
})
