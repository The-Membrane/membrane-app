import assert from 'node:assert/strict'
import test from 'node:test'

import { HORIZON_SECONDS, maximumWindows, summarize } from './aave-usdc-24h-flow-pilot.mjs'

const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const HASH_E = `0x${'ee'.repeat(32)}`
const POOL = '0x0000000000000000000000000000000000000011'
const USDC = '0x0000000000000000000000000000000000000022'
const ATOKEN = '0x0000000000000000000000000000000000000033'
const USER = '0x0000000000000000000000000000000000000044'

test('gross and signed net maxima use distinct exact 24h event-time windows', () => {
  const events = [
    { timestamp: 100, blockNumber: 1, logIndex: 0, direction: 'out', amountRaw: '100' },
    { timestamp: 200, blockNumber: 2, logIndex: 0, direction: 'in', amountRaw: '90' },
    {
      timestamp: HORIZON_SECONDS + 100,
      blockNumber: 3,
      logIndex: 0,
      direction: 'out',
      amountRaw: '50',
    },
  ]
  const result = maximumWindows(events, 1, HORIZON_SECONDS + 3601)
  assert.equal(result.maximumGrossCashOut.grossCashOutRaw, '100')
  assert.equal(result.maximumGrossCashOut.netCashOutRaw, '10')
  assert.equal(result.maximumSignedNetCashOut.grossCashOutRaw, '50')
  assert.equal(result.maximumSignedNetCashOut.netCashOutRaw, '50')
  assert.equal(result.maximumSignedNetCashOut.startUtc, new Date(201_000).toISOString())
  assert.ok(result.evaluatedNetCandidateCount > result.evaluatedGrossCandidateCount)
})

test('complete quiet and all-inflow windows retain zero or negative signed flow', () => {
  const quiet = maximumWindows([], 1, HORIZON_SECONDS + 1)
  assert.equal(quiet.maximumGrossCashOut.grossCashOutRaw, '0')
  assert.equal(quiet.maximumSignedNetCashOut.netCashOutRaw, '0')
  const inbound = maximumWindows(
    [{ timestamp: 50, blockNumber: 1, logIndex: 0, direction: 'in', amountRaw: '25' }],
    1,
    HORIZON_SECONDS + 1,
  )
  assert.equal(inbound.maximumSignedNetCashOut.netCashOutRaw, '-25')
  assert.throws(() => maximumWindows([], 1, HORIZON_SECONDS), /less_than_one_complete/)
})

test('summary binds USDC transfers to endpoint cash delta and exact header timestamps', () => {
  const fromTimestamp = 100_000
  const toTimestamp = fromTimestamp + 90_000
  const plan = {
    from: { number: 100, hash: HASH_A, timestamp: fromTimestamp },
    to: { number: 102, hash: HASH_B, timestamp: toTimestamp },
  }
  const operation = {
    kind: 'Borrow',
    amountRaw: '120',
    blockNumber: 101,
    blockHash: HASH_E,
  }
  const transfer = {
    from: ATOKEN,
    to: USER,
    amountRaw: '120',
    blockNumber: 101,
    blockHash: HASH_E,
    logIndex: 5,
  }
  const receipts = [
    {
      sha256: 'a'.repeat(64),
      pool: POOL,
      underlying: USDC,
      aToken: ATOKEN,
      from: { blockNumber: 100, blockHash: HASH_A, cashRaw: '1000' },
      to: { blockNumber: 102, blockHash: HASH_B, cashRaw: '880' },
      operations: [operation],
      transfers: [transfer],
      chunks: { poolOperations: [{}], underlyingTransfers: [{}] },
      reconciliation: { counts: { grossMismatch: 0, transferOnly: 0 } },
    },
  ]
  const headers = {
    blocks: [
      { number: 100, hash: HASH_A, timestamp: fromTimestamp },
      { number: 101, hash: HASH_E, timestamp: fromTimestamp + 100 },
      { number: 102, hash: HASH_B, timestamp: toTimestamp },
    ],
    sha256: 'b'.repeat(64),
  }
  const summary = summarize(plan, receipts, headers)
  assert.equal(summary.coverage.seconds, 90_000)
  assert.equal(summary.counts.poolByKind.Borrow, 1)
  assert.equal(summary.totals.signedNetCashOutRaw, '120')
  assert.equal(summary.observed24h.maximumGrossCashOut.grossCashOutRaw, '120')
  assert.throws(
    () => summarize(plan, [{ ...receipts[0], to: { ...receipts[0].to, cashRaw: '879' } }], headers),
    /endpoint_cash_reconciliation_failed/,
  )
  assert.throws(
    () => summarize(plan, receipts, { ...headers, blocks: headers.blocks.slice(0, 2) }),
    /plan_endpoint_header_mismatch/,
  )
})
