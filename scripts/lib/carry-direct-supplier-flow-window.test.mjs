import assert from 'node:assert/strict'
import test from 'node:test'
import {
  maxCometWithdrawEventWindow,
  maxDirectSupplierSupplyWindow,
  maxDirectSupplierWithdrawalWindow,
} from './carry-direct-supplier-flow-window.mjs'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const BLOCK = `0x${'ab'.repeat(32)}`
const TX = (n) => `0x${n.toString(16).padStart(64, '0')}`
const MARKETS = {
  aaveV3Usdc: {
    routeKey: 'USDC → supply on Aave V3',
    venueKind: 'aave_v3_atoken',
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  aaveV3Usde: {
    routeKey: 'USDe → supply on Aave V3',
    venueKind: 'aave_v3_atoken',
    destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    underlying: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  },
  sparkLendUsdt: {
    routeKey: 'USDT → supply on Spark',
    venueKind: 'spark_lend_atoken',
    destination: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  },
  compoundV3Usdc: {
    routeKey: 'USDC → supply on Compound v3',
    venueKind: 'compound_v3_comet',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
}

function coverage(endMs, boundaries = [0, endMs], marketKey = 'aaveV3Usdc') {
  return {
    marketKey,
    startMs: 0,
    endMs,
    intervals: boundaries.slice(1).map((end, i) => ({
      startMs: boundaries[i],
      endMs: end,
      finalized: true,
      receiptsComplete: true,
      ambiguousReceipts: 0,
    })),
  }
}
function withdrawal(marketKey, timestampMs, amountRaw, n, logIndex = n) {
  const market = MARKETS[marketKey]
  const transactionHash = TX(n)
  return {
    marketKey,
    timestampMs,
    blockHash: BLOCK,
    transactionHash,
    logIndex,
    reconciliation: {
      status: 'reconciled_supplier_withdrawal',
      reason: 'exact_receipt_payout',
      ...market,
      transactionHash,
      evidence: {
        holder: '0x1111111111111111111111111111111111111111',
        receiver: '0x2222222222222222222222222222222222222222',
        amountRaw,
        withdrawLogIndex: logIndex,
        payoutLogIndex: 0,
        burnLogIndex: marketKey === 'compoundV3Usdc' ? logIndex + 1 : null,
        burnedSharesRaw: marketKey === 'compoundV3Usdc' ? amountRaw : null,
      },
    },
  }
}
const calculate = (marketKey, span, withdrawals, durationMs = DAY) =>
  maxDirectSupplierWithdrawalWindow({ marketKey, coverage: span, withdrawals, durationMs })

function supply(marketKey, timestampMs, amountRaw, n) {
  const market = MARKETS[marketKey]
  return {
    marketKey,
    timestampMs,
    blockHash: BLOCK,
    transactionHash: TX(n),
    logIndex: n,
    reconciliation: {
      status: 'reconciled_supplier_supply',
      reason: null,
      marketKey,
      routeKey: market.routeKey,
      destination: market.destination,
      underlying: market.underlying,
      transactionHash: TX(n),
      evidence: {
        supplier: '0x1111111111111111111111111111111111111111',
        beneficiary: '0x2222222222222222222222222222222222222222',
        amountRaw,
        supplyLogIndex: n,
        transferLogIndex: 0,
      },
    },
  }
}

test('gross supply maximum uses complete physical windows and BigInt', () => {
  const large = (10n ** 20n).toString()
  const span = coverage(2 * DAY, [0, DAY, 2 * DAY], 'compoundV3Usdc')
  const rows = [
    supply('compoundV3Usdc', 0, large, 1),
    supply('compoundV3Usdc', DAY - 1, '7', 2),
    supply('compoundV3Usdc', DAY, '9', 3),
  ]
  const result = maxDirectSupplierSupplyWindow({
    marketKey: 'compoundV3Usdc',
    coverage: span,
    supplies: rows,
    durationMs: DAY,
  })
  assert.deepEqual(
    [result.amountRaw, result.eventCount, result.startMs, result.endMs],
    [(BigInt(large) + 7n).toString(), 2, 0, DAY],
  )
  assert.equal(result.underlying, MARKETS.compoundV3Usdc.underlying)
  assert.equal(
    maxDirectSupplierSupplyWindow({
      marketKey: 'compoundV3Usdc',
      coverage: span,
      supplies: [...rows, rows[0]],
      durationMs: DAY,
    }).amountRaw,
    result.amountRaw,
  )
  assert.throws(
    () =>
      maxDirectSupplierSupplyWindow({
        marketKey: 'compoundV3Usdc',
        coverage: span,
        supplies: [rows[0], { ...rows[0], timestampMs: 1 }],
        durationMs: DAY,
      }),
    /conflicting_direct_supplier_event_replay/,
  )
})

test('gross supply maximum rejects incomplete or cross-route evidence', () => {
  const span = coverage(DAY)
  const row = supply('aaveV3Usdc', 0, '10', 1)
  const calculateSupply = (candidate, checkedCoverage = span) =>
    maxDirectSupplierSupplyWindow({
      marketKey: 'aaveV3Usdc',
      coverage: checkedCoverage,
      supplies: [candidate],
      durationMs: DAY,
    })
  assert.throws(() => calculateSupply(row, coverage(DAY - 1)), /short_direct_flow_coverage/)
  assert.throws(
    () => calculateSupply(row, coverage(DAY, [0, DAY - 1, DAY + 1])),
    /incomplete_direct_flow_coverage/,
  )
  assert.throws(
    () => calculateSupply({ ...row, reconciliation: { ...row.reconciliation, underlying: '0x0' } }),
    /invalid_direct_supplier_supply/,
  )
  assert.equal(
    maxDirectSupplierSupplyWindow({
      marketKey: 'aaveV3Usdc',
      coverage: span,
      supplies: [],
      durationMs: DAY,
    }).amountRaw,
    '0',
  )
})

test('24h maximum uses exact BigInt raw units and half-open boundaries', () => {
  const large = (10n ** 78n).toString()
  const span = coverage(3 * DAY, [0, DAY, 2 * DAY, 3 * DAY])
  const rows = [
    withdrawal('aaveV3Usdc', 0, large, 1),
    withdrawal('aaveV3Usdc', DAY - 1, '7', 2),
    withdrawal('aaveV3Usdc', DAY, '19', 3),
    withdrawal('aaveV3Usdc', DAY + 1, '23', 4),
  ]
  const result = calculate('aaveV3Usdc', span, rows)
  assert.equal(result.amountRaw, (BigInt(large) + 7n).toString())
  assert.deepEqual([result.startMs, result.endMs, result.eventCount], [0, DAY, 2])
  assert.equal(result.coverageEndMs, 3 * DAY)
  assert.equal('percentOfSupply' in result, false)
})

test('rolling start is physical event time, with deterministic same-time and replay handling', () => {
  const span = coverage(2 * DAY, [0, 2 * DAY], 'sparkLendUsdt')
  const rows = [
    withdrawal('sparkLendUsdt', 1, '2', 1),
    withdrawal('sparkLendUsdt', 2, '3', 2),
    withdrawal('sparkLendUsdt', DAY, '5', 3),
    withdrawal('sparkLendUsdt', DAY, '5', 3),
    withdrawal('sparkLendUsdt', DAY, '7', 4),
  ]
  const first = calculate('sparkLendUsdt', span, rows)
  const reversed = calculate('sparkLendUsdt', span, [...rows].reverse())
  assert.deepEqual(first, reversed)
  assert.deepEqual(
    [first.startMs, first.endMs, first.amountRaw, first.eventCount],
    [1, DAY + 1, '17', 4],
  )
  assert.equal(first.underlying, MARKETS.sparkLendUsdt.underlying)
})

test('USDe maximum rejects a USDC event even though both use the Aave Pool', () => {
  const span = coverage(2 * DAY, [0, 2 * DAY], 'aaveV3Usde')
  const exact = withdrawal('aaveV3Usde', 1, (10n ** 18n).toString(), 1)
  const row = calculate('aaveV3Usde', span, [exact])
  assert.equal(row.amountRaw, (10n ** 18n).toString())
  assert.equal(row.underlying, MARKETS.aaveV3Usde.underlying)
  const wrong = structuredClone(exact)
  wrong.reconciliation.underlying = MARKETS.aaveV3Usdc.underlying
  assert.throws(() => calculate('aaveV3Usde', span, [wrong]), /invalid_direct_supplier_withdrawal/)
})

test('7d maximum examines only complete windows in one pinned Comet market', () => {
  const span = coverage(15 * DAY, [0, 15 * DAY], 'compoundV3Usdc')
  const rows = [
    withdrawal('compoundV3Usdc', 0, '100', 1),
    withdrawal('compoundV3Usdc', WEEK, '101', 2),
    withdrawal('compoundV3Usdc', WEEK + 1, '3', 3),
  ]
  const result = calculate('compoundV3Usdc', span, rows, WEEK)
  assert.deepEqual(
    [result.startMs, result.endMs, result.amountRaw, result.eventCount],
    [WEEK, 2 * WEEK, '104', 2],
  )
  assert.equal(calculate('compoundV3Usdc', span, [], WEEK).amountRaw, '0')
})

test('Comet gross event maximum counts borrowing without calling it a supplier payout', () => {
  const span = coverage(2 * DAY, [0, DAY, 2 * DAY], 'compoundV3Usdc')
  span.intervals[0].receiptsComplete = false
  span.intervals[0].ambiguousReceipts = 1
  const unsettled = {
    marketKey: 'compoundV3Usdc',
    timestampMs: HOUR,
    blockHash: BLOCK,
    transactionHash: TX(2),
    logIndex: 2,
    eventAmountRaw: '200',
    reason: 'mixed_or_multiple_market_flows',
  }
  const result = maxCometWithdrawEventWindow({
    coverage: span,
    withdrawals: [
      withdrawal('compoundV3Usdc', 0, '100', 1),
      withdrawal('compoundV3Usdc', DAY, '300', 3),
    ],
    unclassifiedWithdrawals: [unsettled],
    durationMs: DAY,
  })
  assert.deepEqual(
    [result.startMs, result.amountRaw, result.eventCount, result.includesBorrowing],
    [HOUR, '500', 2, true],
  )
  assert.throws(
    () =>
      maxCometWithdrawEventWindow({
        coverage: span,
        withdrawals: [],
        unclassifiedWithdrawals: [],
        durationMs: DAY,
      }),
    /incomplete_comet_flow_coverage/,
  )
  assert.throws(() => calculate('compoundV3Usdc', span, []), /incomplete_direct_flow_coverage/)
})

test('coverage must certify a full finalized contiguous receipt span', () => {
  const good = coverage(DAY, [0, DAY / 2, DAY])
  const run = (span) => calculate('aaveV3Usdc', span, [])
  assert.equal(run(good).amountRaw, '0')
  assert.throws(() => run(coverage(DAY - 1)), /short_direct_flow_coverage/)
  assert.throws(() => run({ ...good, marketKey: 'sparkLendUsdt' }), /invalid_direct_flow_coverage/)
  assert.throws(
    () => run({ ...good, intervals: good.intervals.slice(0, 1) }),
    /incomplete_direct_flow_coverage/,
  )
  assert.throws(
    () =>
      run({
        ...good,
        intervals: [{ ...good.intervals[0], endMs: DAY / 2 - 1 }, good.intervals[1]],
      }),
    /incomplete_direct_flow_coverage/,
  )
  for (const change of [
    { finalized: false },
    { receiptsComplete: false },
    { ambiguousReceipts: 1 },
    { ambiguousReceipts: undefined },
  ]) {
    assert.throws(
      () => run({ ...good, intervals: [{ ...good.intervals[0], ...change }, good.intervals[1]] }),
      /incomplete_direct_flow_coverage/,
    )
  }
})

test('rejects ambiguous, borrowed, cross-market, out-of-range and conflicting event evidence', () => {
  const span = coverage(DAY)
  const row = withdrawal('aaveV3Usdc', 1, '1', 1)
  const run = (rows) => calculate('aaveV3Usdc', span, rows)
  for (const bad of [
    { ...row, timestampMs: DAY },
    { ...row, marketKey: 'compoundV3Usdc' },
    { ...row, reconciliation: { ...row.reconciliation, status: 'ambiguous' } },
    { ...row, reconciliation: { ...row.reconciliation, status: 'unproven' } },
    { ...row, reconciliation: { ...row.reconciliation, venueKind: 'compound_v3_comet' } },
    { ...row, reconciliation: { ...row.reconciliation, transactionHash: TX(9) } },
    {
      ...row,
      reconciliation: { ...row.reconciliation, evidence: { amountRaw: '1', withdrawLogIndex: 2 } },
    },
    {
      ...row,
      reconciliation: { ...row.reconciliation, evidence: { amountRaw: '0', withdrawLogIndex: 1 } },
    },
  ])
    assert.throws(() => run([bad]), /invalid_direct_supplier_withdrawal/)
  assert.throws(
    () => run([row, { ...row, timestampMs: 2 }]),
    /conflicting_direct_supplier_event_replay/,
  )
  assert.throws(() => calculate('unknown', span, []), /unsupported_direct_market/)
  assert.throws(() => calculate('aaveV3Usdc', span, [], HOUR), /unsupported_direct_flow_duration/)
})
