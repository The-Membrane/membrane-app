import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFunctionData, parseAbi } from 'viem'

import { normalizeProof } from './saturn-queue-limit-update-proof.mjs'

const HOLDER = '0x9c80a96a06cb6f7943a462dde7ac215011fa8ace'
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const TX = '0x13adfb612bd15ea93f775b62a708ad683ac31d0f7f7b2eef4b74fa59cf1a63ab'
const TOPIC = '0x0daebb1a3eda9a1d3ed6e3af8e6925fb863500e21f44134bc77261763c8cc3da'
const abi = parseAbi(['function updateMinSharePrice(uint256 tokenId,uint256 newMinSharePrice)'])
const transaction = {
  from: HOLDER,
  to: QUEUE,
  input: encodeFunctionData({ abi, functionName: 'updateMinSharePrice', args: [1659n, 1039822n] }),
}
const receipt = {
  status: 'success',
  transactionHash: TX,
  blockNumber: 26109138n,
  blockHash: `0x${'a'.repeat(64)}`,
  logs: [
    {
      address: QUEUE,
      topics: [TOPIC, `0x${(1659).toString(16).padStart(64, '0')}`],
      data: `0x${(1039822).toString(16).padStart(64, '0')}`,
      logIndex: 2n,
    },
  ],
}

test('successful owner call and matching event prove the observed limit update', () => {
  const row = normalizeProof(transaction, receipt, HOLDER, '1039822', 26109183)
  assert.equal(row.tokenId, '1659')
  assert.equal(row.newMinSharePriceRaw, '1039822')
  assert.equal(row.eventLogIndex, 2)
  assert.throws(
    () => normalizeProof({ ...transaction, from: QUEUE }, receipt, HOLDER, '1039822', 26109183),
    /saturn_limit_update_transaction_invalid/,
  )
  assert.throws(
    () => normalizeProof(transaction, { ...receipt, logs: [] }, HOLDER, '1039822', 26109183),
    /saturn_limit_update_event_invalid/,
  )
})
