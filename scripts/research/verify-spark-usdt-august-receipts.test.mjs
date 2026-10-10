import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import {
  validateManifest,
  verifiedReceipt,
  verifySparkReceipts,
  verifyRowEvidence,
  verifySourceRows,
} from './verify-spark-usdt-august-receipts.mjs'

const manifest = JSON.parse(readFileSync('lib/carry/spark-usdt-august-receipts.json', 'utf8'))
const [qualified, usdcException, borrowException] = [
  manifest.entries.find((row) => row.classification === 'spark_lend_usdt_supply_receipt'),
  manifest.entries.find((row) => row.classification === 'usdc_supply_then_usdt_borrow'),
  manifest.entries.find((row) => row.classification === 'spark_lend_usdt_borrow_receipt'),
]
const { pool, usdt, usdtAToken } = manifest.sparkLend
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const usdcAToken = '0x377c3bd93f2a2984e1e7be6a5c22c525ed4a4815'
const zero = '0x0000000000000000000000000000000000000000'
const ABI = {
  supply: parseAbiItem(
    'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  ),
  borrow: parseAbiItem(
    'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
  ),
  withdraw: parseAbiItem(
    'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  ),
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
  mint: parseAbiItem(
    'event Mint(address indexed caller,address indexed onBehalfOf,uint256 value,uint256 balanceIncrease,uint256 index)',
  ),
}
function log(kind, address, args) {
  const event = ABI[kind]
  return {
    address,
    topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
    data: encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      event.inputs.filter((input) => !input.indexed).map((input) => args[input.name]),
    ),
  }
}
const receipt = (...logs) => ({ logs })
function supplyProof(row, token = usdt, aToken = usdtAToken, amount = BigInt(row.usdtTransferRaw)) {
  const borrower = row.borrower
  const interest = 7n
  return receipt(
    log('transfer', token, { from: borrower, to: aToken, value: amount }),
    log('transfer', aToken, { from: zero, to: borrower, value: amount + interest }),
    log('mint', aToken, {
      caller: borrower,
      onBehalfOf: borrower,
      value: amount + interest,
      balanceIncrease: interest,
      index: 1n,
    }),
    log('supply', pool, {
      reserve: token,
      user: borrower,
      onBehalfOf: borrower,
      amount,
      referralCode: 128,
    }),
  )
}
function borrowProof(row, amount = BigInt(row.usdtTransferRaw || 3410000000)) {
  const borrower = row.borrower
  return receipt(
    log('transfer', usdt, { from: usdtAToken, to: borrower, value: amount }),
    log('borrow', pool, {
      reserve: usdt,
      user: borrower,
      onBehalfOf: borrower,
      amount,
      interestRateMode: 2,
      borrowRate: 1n,
      referralCode: 0,
    }),
  )
}

test('manifest fixes both exceptions as Borrow and enforces exact 13/1/1 cohort', () => {
  assert.equal(validateManifest(manifest).entries.length, 15)
  assert.equal(usdcException.laterBorrowTx.length, 66)
  assert.equal(borrowException.proofTx, borrowException.sourceBorrowTx)
  assert.throws(
    () => validateManifest({ ...manifest, entries: manifest.entries.slice(1) }),
    /manifest_metadata_invalid/,
  )
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        entries: manifest.entries.map((row) =>
          row === borrowException
            ? { ...row, classification: 'opposite_usdt_withdraw_receipt' }
            : row,
        ),
      }),
    /manifest_classification_invalid/,
  )
})

test('13 qualified proofs require Pool Supply, USDT direction and interest-adjusted aToken mint', () => {
  const good = supplyProof(qualified)
  assert.doesNotThrow(() => verifyRowEvidence(qualified, good))
  assert.throws(
    () => verifyRowEvidence(qualified, receipt(...good.logs.slice(1))),
    /usdt_supply_proof_invalid/,
  )
  assert.throws(
    () =>
      verifyRowEvidence(
        qualified,
        receipt(
          ...good.logs.map((entry, i) =>
            i === 0
              ? log('transfer', usdt, {
                  from: usdtAToken,
                  to: qualified.borrower,
                  value: BigInt(qualified.usdtTransferRaw),
                })
              : entry,
          ),
        ),
      ),
    /usdt_supply_proof_invalid/,
  )
  assert.throws(
    () =>
      verifyRowEvidence(
        qualified,
        receipt(
          ...good.logs.map((entry, i) =>
            i === 2
              ? log('mint', usdtAToken, {
                  caller: qualified.borrower,
                  onBehalfOf: qualified.borrower,
                  value: BigInt(qualified.usdtTransferRaw) + 8n,
                  balanceIncrease: 7n,
                  index: 1n,
                })
              : entry,
          ),
        ),
      ),
    /usdt_supply_proof_invalid/,
  )
})

test('contrary rows prove USDC Supply then USDT Borrow, and direct USDT Borrow', () => {
  const usdcSupply = supplyProof(
    { ...usdcException, usdtTransferRaw: '3410000000' },
    usdc,
    usdcAToken,
  )
  const laterBorrow = borrowProof(usdcException, 3410000000n)
  assert.doesNotThrow(() => verifyRowEvidence(usdcException, usdcSupply, laterBorrow))
  assert.throws(
    () => verifyRowEvidence(usdcException, usdcSupply, null),
    /later_usdt_borrow_missing/,
  )
  const wrongLater = receipt(
    ...laterBorrow.logs.map((entry, i) =>
      i === 1
        ? log('withdraw', pool, {
            reserve: usdt,
            user: usdcException.borrower,
            to: usdcException.borrower,
            amount: 3410000000n,
          })
        : entry,
    ),
  )
  assert.throws(
    () => verifyRowEvidence(usdcException, usdcSupply, wrongLater),
    /later_usdt_borrow_proof_invalid/,
  )
  assert.doesNotThrow(() => verifyRowEvidence(borrowException, borrowProof(borrowException)))
  assert.throws(
    () => verifyRowEvidence(borrowException, supplyProof(borrowException)),
    /usdt_borrow_proof_invalid/,
  )
})

test('canonical receipt requires matching successful tx and block hash', async () => {
  const tx = `0x${'a'.repeat(64)}`,
    hash = `0x${'b'.repeat(64)}`
  const client = {
    getTransactionReceipt: async () => ({
      status: 'success',
      transactionHash: tx,
      blockNumber: 10n,
      blockHash: hash,
      logs: [],
    }),
    getBlock: async () => ({ number: 10n, hash }),
  }
  assert.equal((await verifiedReceipt(client, tx, 10, 20, new Map(), new Map())).status, 'success')
  await assert.rejects(
    verifiedReceipt(client, tx, 10, 9, new Map(), new Map()),
    /receipt_not_finalized/,
  )
  await assert.rejects(
    verifiedReceipt(
      { ...client, getBlock: async () => ({ number: 10n, hash: `0x${'c'.repeat(64)}` }) },
      tx,
      10,
      20,
      new Map(),
      new Map(),
    ),
    /receipt_coordinate_invalid/,
  )
})

test('source membership is mandatory and rejects wrong artifact bytes', async () => {
  assert.throws(() => verifySourceRows(manifest, Buffer.from('[]')), /source_hash_mismatch/)
  await assert.rejects(verifySparkReceipts({ client: {}, manifest }), /source_missing/)
})
