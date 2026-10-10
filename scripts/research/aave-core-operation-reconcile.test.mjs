import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcileAaveCoreCash } from './aave-core-operation-reconcile.mjs'
import { MARKETS, POOL as CORE_POOL } from './aave-core-forward-panel.mjs'

const POOL = CORE_POOL
const UNDERLYING = MARKETS[1].base
const ATOKEN = MARKETS[1].aToken
const USER = `0x${'44'.repeat(20)}`
const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const TX_1 = `0x${'01'.repeat(32)}`
const TX_2 = `0x${'02'.repeat(32)}`
const RECEIPT_SHA = 'de'.repeat(32)

function fixture() {
  return {
    chainId: 1,
    pool: POOL,
    underlying: UNDERLYING,
    aToken: ATOKEN,
    from: { blockNumber: 100, blockHash: HASH_A, cashRaw: '1000' },
    to: { blockNumber: 102, blockHash: HASH_B, cashRaw: '1070' },
    coverage: {
      poolOperations: [
        {
          fromBlock: 101,
          toBlock: 102,
          complete: true,
          source: 'synthetic-pinned-log-read',
          receiptSha256: RECEIPT_SHA,
        },
      ],
      underlyingTransfers: [
        {
          fromBlock: 101,
          toBlock: 102,
          complete: true,
          source: 'synthetic-pinned-log-read',
          receiptSha256: RECEIPT_SHA,
        },
      ],
    },
    operations: [
      operation({ kind: 'Supply', amountRaw: '100', logIndex: 0 }),
      operation({ kind: 'Borrow', amountRaw: '30', logIndex: 2 }),
    ],
    transfers: [
      transfer({ from: USER, to: ATOKEN, amountRaw: '100', logIndex: 1 }),
      transfer({ from: ATOKEN, to: USER, amountRaw: '30', logIndex: 3 }),
    ],
  }
}

function operation(overrides = {}) {
  return {
    emitter: POOL,
    reserve: UNDERLYING,
    kind: 'Supply',
    amountRaw: '1',
    blockNumber: 102,
    blockHash: HASH_B,
    transactionHash: TX_1,
    transactionIndex: 0,
    logIndex: 0,
    ...overrides,
  }
}

function transfer(overrides = {}) {
  return {
    token: UNDERLYING,
    from: USER,
    to: ATOKEN,
    amountRaw: '1',
    blockNumber: 102,
    blockHash: HASH_B,
    transactionHash: TX_1,
    transactionIndex: 0,
    logIndex: 1,
    ...overrides,
  }
}

test('matches gross directions in a mixed transaction and exact raw-unit endpoints', () => {
  const result = reconcileAaveCoreCash(fixture())
  assert.equal(result.coverage.status, 'caller-asserted-not-chain-verified')
  assert.equal(result.transactions[0].status, 'gross-matched-mixed')
  assert.deepEqual(result.transactions[0].operationKinds, ['Supply', 'Borrow'])
  assert.deepEqual(
    result.transactions[0].operations.map((row) => row.amountRaw),
    ['100', '30'],
  )
  assert.equal(result.transactions[0].operationMinusTransferNetRaw, '0')
  assert.equal(result.totals.endpointMinusTransfersRaw, '0')
  assert.equal(result.totals.endpointMinusOperationsRaw, '0')
  assert.equal(result.endpointReconciled, true)
  assert.equal(result.operationGrossReconciled, true)
})

test('preserves transfer-only transactions and does not call them Pool withdrawals', () => {
  const input = fixture()
  input.to.cashRaw = '1065'
  input.transfers.push(
    transfer({
      from: ATOKEN,
      to: USER,
      amountRaw: '5',
      transactionHash: TX_2,
      transactionIndex: 1,
      logIndex: 4,
    }),
  )
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.transactions[1].status, 'transfer-only')
  assert.equal(result.transactions[1].operationKinds.length, 0)
  assert.equal(result.counts.transferOnly, 1)
  assert.equal(result.totals.endpointMinusTransfersRaw, '0')
  assert.equal(result.totals.endpointMinusOperationsRaw, '-5')
  assert.equal(result.operationGrossReconciled, false)
})

test('preserves operation-only transactions as unexplained cash claims', () => {
  const input = fixture()
  input.operations.push(
    operation({
      kind: 'Withdraw',
      amountRaw: '7',
      transactionHash: TX_2,
      transactionIndex: 1,
      logIndex: 4,
    }),
  )
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.transactions[1].status, 'operation-only')
  assert.equal(result.transactions[1].operations[0].kind, 'Withdraw')
  assert.equal(result.totals.endpointMinusOperationsRaw, '7')
  assert.equal(result.totals.endpointMinusTransfersRaw, '0')
})

test('preserves equal net but unequal gross as mismatch', () => {
  const input = fixture()
  input.transfers = [transfer({ amountRaw: '70', logIndex: 1 })]
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.transactions[0].operationMinusTransferNetRaw, '0')
  assert.equal(result.transactions[0].operationMinusTransferInRaw, '30')
  assert.equal(result.transactions[0].operationMinusTransferOutRaw, '30')
  assert.equal(result.transactions[0].status, 'gross-mismatch')
  assert.equal(result.operationGrossReconciled, false)
})

test('keeps endpoint residual even when operations and transfers agree with each other', () => {
  const input = fixture()
  input.to.cashRaw = '1071'
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.operationGrossReconciled, true)
  assert.equal(result.endpointReconciled, false)
  assert.equal(result.totals.endpointMinusTransfersRaw, '1')
})

test('accepts explicitly complete quiet ranges and refuses to infer quiet from missing logs', () => {
  const input = fixture()
  input.operations = []
  input.transfers = []
  input.to.cashRaw = '1000'
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.emptyRange, true)
  assert.equal(result.transactions.length, 0)
  assert.equal(result.endpointReconciled, true)
  assert.equal(result.operationGrossReconciled, true)
  delete input.coverage.poolOperations
  assert.throws(() => reconcileAaveCoreCash(input), /explicit complete-range assertion/)
})

test('rejects missing or overlapping declared block coverage', () => {
  const input = fixture()
  input.coverage.poolOperations = [
    { fromBlock: 102, toBlock: 102, complete: true, source: 'test', receiptSha256: RECEIPT_SHA },
  ]
  assert.throws(() => reconcileAaveCoreCash(input), /coverage gap/)
  input.coverage.poolOperations = [
    { fromBlock: 101, toBlock: 101, complete: true, source: 'test', receiptSha256: RECEIPT_SHA },
    { fromBlock: 101, toBlock: 102, complete: true, source: 'test', receiptSha256: RECEIPT_SHA },
  ]
  assert.throws(() => reconcileAaveCoreCash(input), /coverage gap/)
  input.coverage.poolOperations[1].fromBlock = 102
  assert.equal(reconcileAaveCoreCash(input).coverage.poolOperations.length, 2)
  delete input.coverage.poolOperations[0].receiptSha256
  assert.throws(() => reconcileAaveCoreCash(input), /source receipt SHA-256 required/)
})

test('rejects duplicate coordinates across operation and Transfer logs', () => {
  const input = fixture()
  input.transfers[0].logIndex = 0
  assert.throws(() => reconcileAaveCoreCash(input), /duplicate log coordinates/)
})

test('rejects bad log identity and wrong reserve', () => {
  const input = fixture()
  input.operations[0].reserve = USER
  assert.throws(() => reconcileAaveCoreCash(input), /reserve mismatch/)
  input.operations[0].reserve = UNDERLYING
  input.transfers[0].token = USER
  assert.throws(() => reconcileAaveCoreCash(input), /underlying token mismatch/)
  input.transfers[0].token = UNDERLYING
  input.transfers[0].to = USER
  assert.throws(() => reconcileAaveCoreCash(input), /does not touch aToken/)
})

test('rejects arbitrary chain, Pool, or reserve identity before Core attribution', () => {
  const input = fixture()
  input.chainId = 10
  assert.throws(() => reconcileAaveCoreCash(input), /configured Ethereum Aave Core/)
  input.chainId = 1
  input.pool = USER
  assert.throws(() => reconcileAaveCoreCash(input), /configured Ethereum Aave Core/)
  input.pool = POOL
  input.aToken = USER
  assert.throws(() => reconcileAaveCoreCash(input), /configured Ethereum Aave Core/)
})

test('rejects wrong B hash, transaction-coordinate conflict, and out-of-window logs', () => {
  const input = fixture()
  input.transfers[0].blockHash = HASH_A
  assert.throws(() => reconcileAaveCoreCash(input), /conflicting block hash/)
  input.transfers[0].blockHash = HASH_B
  input.transfers[0].transactionIndex = 1
  assert.throws(() => reconcileAaveCoreCash(input), /inconsistent transaction coordinates/)
  input.transfers[0].transactionIndex = 0
  input.transfers[0].blockNumber = 100
  assert.throws(() => reconcileAaveCoreCash(input), /outside \(A,B\]/)
})

test('rejects different transaction hashes claiming the same block and transaction index', () => {
  const input = fixture()
  input.transfers[0].transactionHash = TX_2
  assert.throws(() => reconcileAaveCoreCash(input), /conflicting transaction hash at block\/index/)
})

test('rejects negative, fractional, or noncanonical raw amounts', () => {
  for (const amountRaw of ['-1', '1.5', '01', 1]) {
    const input = fixture()
    input.operations[0].amountRaw = amountRaw
    assert.throws(() => reconcileAaveCoreCash(input), /unsigned decimal raw-unit string/)
  }
})

test('retains self-transfer without counting it as a cash inflow or outflow', () => {
  const input = fixture()
  input.transfers.push(transfer({ from: ATOKEN, to: ATOKEN, amountRaw: '9', logIndex: 4 }))
  const result = reconcileAaveCoreCash(input)
  assert.equal(result.transactions[0].selfTransferRaw, '9')
  assert.equal(result.transactions[0].status, 'gross-matched-mixed')
  assert.equal(result.totals.transferNetRaw, '70')
})
