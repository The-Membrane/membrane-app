import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readDirectSupplierFlowDocuments,
  readLocalDirectSupplierFlowSummary,
  readLocalDirectSupplierSupplySummary,
  summarizeVerifiedDirectSupplierFlow,
  summarizeVerifiedDirectSupplierSupply,
} from './carry-direct-supplier-flow-summary.mjs'

const DAY = 86_400_000
const MARKET = 'aaveV3Usdc'
const route = {
  routeKey: 'USDC → supply on Aave V3',
  venueKind: 'aave_v3_atoken',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const ADDRESS = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const TX = (n) => `0x${n.toString(16).padStart(64, '0')}`

function event(timestampMs, amountRaw, id, receiver = ADDRESS) {
  return {
    marketKey: MARKET,
    timestampMs,
    blockHash: TX(999),
    transactionHash: TX(id),
    logIndex: id,
    reconciliation: {
      status: 'reconciled_supplier_withdrawal',
      reason: 'exact_receipt_payout',
      ...route,
      transactionHash: TX(id),
      evidence: {
        holder: ADDRESS,
        receiver,
        amountRaw,
        withdrawLogIndex: id,
        payoutLogIndex: 0,
        burnLogIndex: null,
        burnedSharesRaw: null,
      },
    },
  }
}

function verified(endMs, withdrawals) {
  return {
    coverage: {
      marketKey: MARKET,
      startMs: 0,
      endMs,
      intervals: [
        { startMs: 0, endMs, finalized: true, receiptsComplete: true, ambiguousReceipts: 0 },
      ],
    },
    withdrawals,
    unclassifiedWithdrawals: [],
  }
}

test('summary distinguishes same-address payouts from all gross withdrawals', () => {
  const summary = summarizeVerifiedDirectSupplierFlow(
    MARKET,
    verified(2 * DAY, [event(0, '12', 1), event(1, '34', 2, OTHER), event(DAY, '7', 3)]),
  )
  assert.equal(summary.payoutCount, 3)
  assert.equal(summary.sameAddressSettledCount, 2)
  assert.equal(summary.largestSameAddressSinglePayoutRaw, '12')
  assert.deepEqual(summary.max24hGrossWithdrawal, {
    status: 'observed',
    amountRaw: '46',
    startMs: 0,
    endMs: DAY,
    payoutCount: 2,
  })
  assert.equal(summary.calibratedForecast, false)
  assert.equal(JSON.stringify(summary).includes(ADDRESS), false)
  assert.equal(JSON.stringify(summary).includes(OTHER), false)
})

test('less than one complete day does not report a zero or partial-window maximum', () => {
  const summary = summarizeVerifiedDirectSupplierFlow(
    MARKET,
    verified(DAY - 1, [event(0, '20', 1)]),
  )
  assert.equal(summary.payoutCount, 1)
  assert.deepEqual(summary.max24hGrossWithdrawal, {
    status: 'unavailable',
    reason: 'coverage_under_24h',
  })
})

test('a complete quiet day has an observed zero maximum', () => {
  const summary = summarizeVerifiedDirectSupplierFlow(MARKET, verified(DAY, []))
  assert.equal(summary.max24hGrossWithdrawal.status, 'observed')
  assert.equal(summary.max24hGrossWithdrawal.amountRaw, '0')
})

test('an unclassified Comet withdrawal withholds a complete gross-withdrawal maximum', () => {
  const partial = verified(2 * DAY, [])
  partial.coverage.marketKey = 'compoundV3Usdc'
  partial.coverage.intervals[0].receiptsComplete = false
  partial.coverage.intervals[0].ambiguousReceipts = 1
  partial.unclassifiedWithdrawals = [
    {
      marketKey: 'compoundV3Usdc',
      reason: 'mixed_or_multiple_market_flows',
      eventAmountRaw: '42',
      blockHash: TX(999),
      transactionHash: TX(44),
      logIndex: 1,
      timestampMs: 0,
    },
  ]
  const summary = summarizeVerifiedDirectSupplierFlow('compoundV3Usdc', partial)
  assert.equal(summary.coverage.receiptsComplete, false)
  assert.equal(summary.unclassifiedWithdrawalCount, 1)
  assert.equal(summary.payoutCount, 0)
  assert.deepEqual(summary.grossCometWithdrawEvents, { eventCount: 1, amountRaw: '42' })
  assert.deepEqual(summary.max24hGrossCometWithdrawEvents, {
    status: 'observed',
    amountRaw: '42',
    eventCount: 1,
    startMs: 0,
    endMs: DAY,
  })
  assert.deepEqual(summary.max24hGrossWithdrawal, {
    status: 'unavailable',
    reason: 'unclassified_withdrawals',
  })
})

test('local reader reports no sealed segments and rejects malformed files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-flow-summary-'))
  try {
    assert.equal(readLocalDirectSupplierFlowSummary(MARKET, directory).reason, 'no_sealed_segments')
    writeFileSync(join(directory, `${MARKET}-1-1.json`), '{')
    assert.throws(
      () => readDirectSupplierFlowDocuments(MARKET, directory),
      /invalid_direct_segment_json/,
    )
    rmSync(join(directory, `${MARKET}-1-1.json`))
    writeFileSync(
      join(directory, `${MARKET}-1-1.json`),
      JSON.stringify({
        marketKey: MARKET,
        study: 'carry-direct-supplier-flow-receipts-v1',
        range: { fromBlock: 2, toBlock: 2 },
      }),
    )
    assert.throws(
      () => readLocalDirectSupplierFlowSummary(MARKET, directory),
      /direct_segment_filename_mismatch/,
    )
    rmSync(join(directory, `${MARKET}-1-1.json`))
    writeFileSync(join(directory, 'target'), '{}')
    symlinkSync(join(directory, 'target'), join(directory, `${MARKET}-1-1.json`))
    assert.throws(
      () => readDirectSupplierFlowDocuments(MARKET, directory),
      /invalid_direct_segment_file/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unsupported market keys cannot select a filesystem prefix', () => {
  assert.throws(() => readLocalDirectSupplierFlowSummary('../other'), /unsupported_direct_market/)
})

test('reader rolls to a recent bounded suffix instead of failing as segments accumulate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-flow-rolling-'))
  try {
    for (let block = 1; block <= 1_001; block++) {
      writeFileSync(
        join(directory, `${MARKET}-${block}-${block}.json`),
        JSON.stringify({
          marketKey: MARKET,
          study:
            block % 2 === 0
              ? 'carry-direct-supplier-flow-receipts-v1'
              : 'carry-direct-supplier-flow-receipts-v2',
          range: { fromBlock: block, toBlock: block },
        }),
      )
    }
    const selected = readDirectSupplierFlowDocuments(MARKET, directory)
    assert.equal(selected.length, 1_000)
    assert.equal(selected[0].range.fromBlock, 2)
    assert.equal(selected.at(-1).range.toBlock, 1_001)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('supply summary abstains from a 24h maximum until a complete day is sealed', () => {
  const row = {
    marketKey: MARKET,
    timestampMs: 1,
    blockHash: TX(999),
    transactionHash: TX(1),
    logIndex: 1,
    reconciliation: {
      status: 'reconciled_supplier_supply',
      reason: null,
      marketKey: MARKET,
      routeKey: route.routeKey,
      destination: route.destination,
      underlying: route.underlying,
      transactionHash: TX(1),
      evidence: {
        supplier: ADDRESS,
        beneficiary: OTHER,
        amountRaw: '9007199254740993',
        supplyLogIndex: 1,
        transferLogIndex: 0,
      },
    },
  }
  const source = {
    flowKind: 'supply',
    coverage: verified(DAY - 1, []).coverage,
    supplies: [row],
  }
  const short = summarizeVerifiedDirectSupplierSupply(MARKET, source)
  assert.equal(short.grossUnderlyingInflowRaw, '9007199254740993')
  assert.deepEqual(short.max24hGrossUnderlyingInflow, {
    status: 'unavailable',
    reason: 'coverage_under_24h',
  })
  assert.equal(short.calibratedForecast, false)
  source.coverage = verified(DAY, []).coverage
  const complete = summarizeVerifiedDirectSupplierSupply(MARKET, source)
  assert.equal(complete.max24hGrossUnderlyingInflow.amountRaw, '9007199254740993')
  source.coverage.intervals[0].ambiguousReceipts = 1
  assert.throws(
    () => summarizeVerifiedDirectSupplierSupply(MARKET, source),
    /invalid_direct_supply_coverage/,
  )
})

test('supply reader keeps only the newest contiguous suffix and exact study', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-supply-summary-'))
  const write = (fromBlock, toBlock, study = 'carry-direct-supplier-supply-flow-receipts-v1') =>
    writeFileSync(
      join(directory, `supply-${MARKET}-${fromBlock}-${toBlock}.json`),
      JSON.stringify({ marketKey: MARKET, study, range: { fromBlock, toBlock } }),
    )
  try {
    assert.equal(
      readLocalDirectSupplierSupplySummary(MARKET, directory).reason,
      'no_sealed_segments',
    )
    write(1, 2)
    write(4, 5)
    write(6, 7, 'carry-direct-supplier-supply-flow-receipts-v2')
    assert.deepEqual(
      readDirectSupplierFlowDocuments(MARKET, directory, 'supply').map((doc) => doc.range),
      [
        { fromBlock: 4, toBlock: 5 },
        { fromBlock: 6, toBlock: 7 },
      ],
    )
    write(8, 9, 'carry-direct-supplier-flow-receipts-v1')
    assert.throws(
      () => readDirectSupplierFlowDocuments(MARKET, directory, 'supply'),
      /direct_segment_filename_mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
