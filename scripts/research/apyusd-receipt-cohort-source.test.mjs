import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import {
  FROM,
  RECEIPT,
  TO,
  normalizeMint,
  validateSource,
} from './apyusd-receipt-cohort-source.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`

function fixture() {
  const topic = keccak256(stringToHex('Transfer(address,address,uint256)'))
  const mints = Array.from({ length: 96 }, (_, i) =>
    normalizeMint(
      {
        address: RECEIPT,
        blockNumber: `0x${FROM.toString(16)}`,
        blockHash: word(1),
        transactionHash: word(i + 1),
        logIndex: `0x${i.toString(16)}`,
        topics: [topic, word(0), word(2), word(i + 1)],
        data: '0x',
      },
      FROM,
      TO,
    ),
  )
  const windows = []
  for (let low = FROM; low <= TO; low += 10_000) {
    const high = Math.min(TO, low + 9_999)
    const slice = mints.filter((mint) => mint.blockNumber >= low && mint.blockNumber <= high)
    windows.push({ fromBlock: low, toBlock: high, mints: slice.length, sha256: hash(slice) })
  }
  const body = {
    study: 'apyusd_receipt_mint_cohort_v1',
    receipt: RECEIPT,
    fromBlock: FROM,
    toBlock: TO,
    origins: ['rpc.ankr.com', 'mainnet.infura.io'],
    windows,
    mints,
    mintsSha256: hash(mints),
  }
  return { ...body, sha256: hash(body) }
}

test('frozen cohort source validates every mint and contiguous window', () => {
  const row = fixture()
  assert.equal(validateSource(row), row)
})

test('source rejects a changed token even when the aggregate count stays 96', () => {
  const row = fixture()
  row.mints[0].topics[3] = word(999)
  assert.throws(() => validateSource(row), /apyusd_cohort_source_invalid/)
})

test('mint normalization rejects a nonmint transfer', () => {
  const row = fixture()
  assert.throws(
    () =>
      normalizeMint(
        {
          ...row.mints[0],
          address: RECEIPT,
          blockNumber: `0x${FROM.toString(16)}`,
          logIndex: '0x0',
          topics: [row.mints[0].topics[0], word(4), word(2), word(1)],
        },
        FROM,
        TO,
      ),
    /apyusd_cohort_mint_log_invalid/,
  )
})
