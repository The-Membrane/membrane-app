import assert from 'node:assert/strict'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { FROM, RECEIPT } from './apyusd-receipt-cohort-source.mjs'
import { classifyCohort, normalizeTransfer } from './apyusd-receipt-cohort-transfers.mjs'

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const topic = keccak256(stringToHex('Transfer(address,address,uint256)'))

function event(token, from, to, block, index) {
  return normalizeTransfer(
    {
      address: RECEIPT,
      blockNumber: `0x${block.toString(16)}`,
      blockHash: word(block),
      transactionHash: word(block * 100 + index),
      logIndex: `0x${index.toString(16)}`,
      topics: [topic, word(from), word(to), word(token)],
      data: '0x',
    },
    FROM,
    FROM + 100,
  )
}

test('cohort transfer classification keeps unburned receipts in the denominator', () => {
  const mints = [event(1, 0, 11, FROM, 0), event(2, 0, 12, FROM, 1)]
  const burn = event(1, 11, 0, FROM + 10, 0)
  assert.deepEqual(classifyCohort({ mints }, [...mints, burn]), {
    minted: 2,
    burned: 1,
    intermediate: 0,
    openIds: ['2'],
  })
})

test('cohort transfer classification rejects a missing frozen mint', () => {
  const mints = [event(1, 0, 11, FROM, 0), event(2, 0, 12, FROM, 1)]
  assert.throws(
    () => classifyCohort({ mints }, [mints[0]]),
    /apyusd_cohort_transfer_mints_disagree/,
  )
})
