import assert from 'node:assert/strict'
import test from 'node:test'

import { TRANSFER_DIGEST_SCHEMA, digestTransferUnion } from './susde-silo-transfer-digest.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const silo = '0x7fc7c91d556b400afa565013e3f32055a0713425'
const source = '0x0000000000000000000000000000000000000001'
const holder = '0x0000000000000000000000000000000000000002'
const base = [
  {
    blockNumber: 104,
    transactionHash: hash(0xabc),
    logIndex: 0,
    from: source,
    to: silo,
    valueRaw: '50',
  },
  {
    blockNumber: 111,
    transactionHash: hash(1111),
    logIndex: 1,
    from: silo,
    to: silo,
    valueRaw: '3',
  },
  {
    blockNumber: 117,
    transactionHash: hash(1117),
    logIndex: 2,
    from: silo,
    to: holder,
    valueRaw: '20',
  },
]

test('canonical digest ignores input order and address/hash casing', () => {
  const left = digestTransferUnion(base)
  const right = digestTransferUnion(
    [...base].reverse().map((row) => ({
      ...row,
      transactionHash: row.transactionHash.toUpperCase().replace('0X', '0x'),
      from: row.from.toUpperCase().replace('0X', '0x'),
      to: row.to.toUpperCase().replace('0X', '0x'),
      ignoredIndexOnlyField: 'not part of digest',
    })),
  )
  assert.deepEqual(left, right)
  assert.equal(left.schema, TRANSFER_DIGEST_SCHEMA)
  assert.equal(left.rowCount, 3)
  assert.match(left.sha256, /^[0-9a-f]{64}$/)
})

test('an offsetting receipt and send change digest despite identical endpoint net', () => {
  const offsetting = [
    {
      blockNumber: 108,
      transactionHash: hash(1108),
      logIndex: 3,
      from: source,
      to: silo,
      valueRaw: '7',
    },
    {
      blockNumber: 115,
      transactionHash: hash(1115),
      logIndex: 4,
      from: silo,
      to: holder,
      valueRaw: '7',
    },
  ]
  const net = (rows) =>
    rows.reduce(
      (total, row) =>
        total +
        (row.to === silo ? BigInt(row.valueRaw) : 0n) -
        (row.from === silo ? BigInt(row.valueRaw) : 0n),
      0n,
    )
  assert.equal(net(base), net([...base, ...offsetting]))
  assert.notEqual(
    digestTransferUnion(base).sha256,
    digestTransferUnion([...base, ...offsetting]).sha256,
  )
})

test('duplicate, malformed, or noncanonical rows cannot be digested', () => {
  assert.throws(() => digestTransferUnion([...base, base[0]]), /digest_duplicate/)
  assert.throws(() => digestTransferUnion([{ ...base[0], valueRaw: '050' }]), /digest_row_invalid/)
  assert.throws(() => digestTransferUnion([{ ...base[0], logIndex: -1 }]), /digest_row_invalid/)
})
