import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileSkyLitePsmPocket } from './sky-litepsm-capacity-reconcile.mjs'

const psm = '0xf6e72Db5454dd049d0788e411b06CfAF16853042'
const pocket = '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341'
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const owner = '0x1111111111111111111111111111111111111111'
const counterparty = '0x2222222222222222222222222222222222222222'
const h = (digit) => `0x${digit.repeat(64)}`
const empty = () => ({
  chainId: 1,
  psm,
  pocket,
  usdc,
  from: {
    blockNumber: 100,
    blockHash: h('a'),
    pocketUsdcRaw: '1000',
    psmPocket: pocket,
    psmGem: usdc,
    psmCodeSha256: '1'.repeat(64),
    usdcCodeSha256: '2'.repeat(64),
  },
  to: {
    blockNumber: 102,
    blockHash: h('b'),
    pocketUsdcRaw: '1000',
    psmPocket: pocket,
    psmGem: usdc,
    psmCodeSha256: '1'.repeat(64),
    usdcCodeSha256: '2'.repeat(64),
  },
  coverage: Object.fromEntries(
    ['buyGem', 'sellGem', 'fileUint', 'usdcTransfersOut', 'usdcTransfersIn'].map((key) => [
      key,
      [
        {
          fromBlock: 101,
          toBlock: 102,
          complete: true,
          source: `mock-${key}`,
          receiptSha256: 'c'.repeat(64),
        },
      ],
    ]),
  ),
  logs: { buyGem: [], sellGem: [], fileUint: [], usdcTransfersOut: [], usdcTransfersIn: [] },
})
const coord = (blockNumber, txDigit, transactionIndex, logIndex) => ({
  blockNumber,
  blockHash: blockNumber === 102 ? h('b') : h('d'),
  transactionHash: h(txDigit),
  transactionIndex,
  logIndex,
})
const buy = (c, value) => ({ ...c, emitter: psm, owner, valueRaw: value, feeRaw: '0' })
const sell = (c, value) => ({ ...c, emitter: psm, owner, valueRaw: value, feeRaw: '1' })
const transfer = (c, from, to, value) => ({ ...c, token: usdc, from, to, amountRaw: value })

test('complete quiet streams reconcile an unchanged endpoint without implying exit capacity', () => {
  const report = reconcileSkyLitePsmPocket(empty())
  assert.equal(report.status, 'caller_logs_balance_reconciled')
  assert.equal(report.endpointMinusTransfersRaw, '0')
  assert.equal(report.executableExit, false)
  assert.deepEqual(report.transactions, [])
  assert.equal(report.coverage.buyGem[0].complete, true)
})

test('BuyGem equality is per transaction and SellGem/direct transfers remain visible', () => {
  const input = empty()
  input.to.pocketUsdcRaw = '1015'
  input.logs.buyGem.push(buy(coord(101, '1', 0, 1), '40'))
  input.logs.usdcTransfersOut.push(transfer(coord(101, '1', 0, 2), pocket, owner, '40'))
  input.logs.sellGem.push(sell(coord(101, '2', 1, 3), '30'))
  input.logs.usdcTransfersIn.push(transfer(coord(101, '2', 1, 4), owner, pocket, '30'))
  input.logs.usdcTransfersIn.push(transfer(coord(102, '3', 0, 0), counterparty, pocket, '25'))
  const report = reconcileSkyLitePsmPocket(input)
  assert.equal(report.endpointMinusTransfersRaw, '0')
  assert.equal(report.transactions.length, 3)
  assert.equal(report.transactions[0].buyOutRelation, 'equal_in_this_transaction')
  assert.equal(report.transactions[1].sellGemRaw, '30')
  assert.equal(report.transactions[2].pocketInRaw, '25')
  assert.equal(report.transactions[2].buyOutRelation, 'no_buy_gem')
})

test('mixed BuyGem/SellGem and unmatched outflow are retained without universal equality', () => {
  const input = empty()
  input.to.pocketUsdcRaw = '995'
  input.logs.buyGem.push(buy(coord(102, '4', 1, 1), '10'))
  input.logs.sellGem.push(sell(coord(102, '4', 1, 2), '5'))
  input.logs.usdcTransfersOut.push(transfer(coord(102, '4', 1, 3), pocket, owner, '20'))
  input.logs.usdcTransfersIn.push(transfer(coord(102, '4', 1, 4), owner, pocket, '15'))
  const report = reconcileSkyLitePsmPocket(input)
  assert.equal(report.transactions[0].buyOutRelation, 'mixed_no_simple_equality')
  assert.equal(report.transactions[0].pocketOutMinusBuyGemRaw, '10')
  assert.equal(report.transactions[0].pocketNetRaw, '-5')
  assert.equal(report.endpointMinusTransfersRaw, '0')
})

test('File is retained; a nonzero endpoint residual cannot be called reconciled', () => {
  const input = empty()
  input.to.pocketUsdcRaw = '999'
  input.logs.fileUint.push({
    ...coord(102, '5', 0, 0),
    emitter: psm,
    what: h('f'),
    dataRaw: '123',
  })
  const report = reconcileSkyLitePsmPocket(input)
  assert.equal(report.status, 'endpoint_residual_nonzero')
  assert.equal(report.endpointMinusTransfersRaw, '-1')
  assert.equal(report.transactions[0].events[0].stream, 'fileUint')
})

test('self-transfer is represented once with zero net change', () => {
  const input = empty()
  const log = transfer(coord(102, '6', 0, 0), pocket, pocket, '7')
  input.logs.usdcTransfersOut.push(log)
  input.logs.usdcTransfersIn.push({ ...log })
  const report = reconcileSkyLitePsmPocket(input)
  assert.equal(report.transactions[0].pocketSelfRaw, '7')
  assert.equal(report.pocketNetTransfersRaw, '0')
  const unmatched = empty()
  unmatched.logs.usdcTransfersOut.push(log)
  assert.throws(() => reconcileSkyLitePsmPocket(unmatched), /missing matching in-stream/)
})

test('fail closed on identity, bad range, absent stream, and malformed raw amount', () => {
  const wrong = empty()
  wrong.pocket = owner
  assert.throws(() => reconcileSkyLitePsmPocket(wrong), /configured Sky LitePSM/)
  const wrongGem = empty()
  wrongGem.to.psmGem = owner
  assert.throws(() => reconcileSkyLitePsmPocket(wrongGem), /PSM identity mismatch/)
  const gap = empty()
  gap.coverage.buyGem[0].fromBlock = 102
  assert.throws(() => reconcileSkyLitePsmPocket(gap), /gap, overlap/)
  const missing = empty()
  delete missing.logs.fileUint
  assert.throws(() => reconcileSkyLitePsmPocket(missing), /array required/)
  const badRaw = empty()
  badRaw.logs.buyGem.push(buy(coord(101, '7', 0, 0), '1.0'))
  assert.throws(() => reconcileSkyLitePsmPocket(badRaw), /raw-unit/)
})

test('fail closed on duplicate logs and inconsistent chain coordinates', () => {
  const duplicate = empty()
  duplicate.logs.buyGem.push(buy(coord(101, '1', 0, 0), '1'))
  duplicate.logs.sellGem.push(sell(coord(101, '2', 1, 0), '1'))
  assert.throws(() => reconcileSkyLitePsmPocket(duplicate), /duplicate log coordinates/)
  const inconsistent = empty()
  inconsistent.logs.buyGem.push(buy(coord(101, '1', 0, 0), '1'))
  inconsistent.logs.sellGem.push(sell(coord(101, '1', 1, 1), '1'))
  assert.throws(
    () => reconcileSkyLitePsmPocket(inconsistent),
    /inconsistent transaction coordinates/,
  )
  const wrongHash = empty()
  wrongHash.logs.buyGem.push(buy({ ...coord(102, '1', 0, 0), blockHash: h('e') }, '1'))
  assert.throws(() => reconcileSkyLitePsmPocket(wrongHash), /conflicting block hash/)
})
