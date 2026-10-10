import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceIdentity as quoteIdentity } from './curve-prospective-quote.mjs'
import { sourceIdentity as flowIdentity } from './curve-vault-flow-ledger.mjs'
import { computeFlowFeatures } from './curve-vault-flow-features.mjs'

const DAY = 86_400
const T0 = 1_790_000_000
const ISSUE = '2026-09-28T00:00:00.000Z'
const source = flowIdentity()
const qSource = quoteIdentity()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const at = (day) => T0 + day * DAY
const event = (kind, day, amount, blockNumber = day + 100) => ({
  kind,
  blockNumber,
  blockTimestamp: at(day),
  logIndex: 0,
  assetsRaw: String(amount),
})
const checkpointRow = (day) => ({
  checkpoint: {
    source: qSource,
    block: { number: day + 100, hash: hash(day + 100), timestamp: at(day) },
    captureEndUtc: '2026-09-27T20:00:00.000Z',
  },
})
const receipt = (fromDay, toDay, events = [], prior = null, seal = 'a') => ({
  source,
  range: {
    from: { number: fromDay + 100, hash: hash(fromDay + 100), timestamp: at(fromDay) },
    to: { number: toDay + 100, hash: hash(toDay + 100), timestamp: at(toDay) },
  },
  captureEndUtc: '2026-09-27T21:00:00.000Z',
  previousReceiptSha256: prior,
  sha256: seal,
  events,
})
const compute = (day, receipts, other = {}) =>
  computeFlowFeatures({
    checkpointRow: checkpointRow(day),
    receipts,
    source,
    asOfUtc: ISSUE,
    ...other,
  })

test('complete quiet windows give observed zero, while a short quiet prefix stays unavailable', () => {
  const complete = compute(7, [receipt(0, 7)])
  assert.equal(complete.status, 'observed')
  for (const horizon of ['24h', '7d']) {
    assert.equal(complete.trailingCompleteWindow[horizon].grossWithdrawalsRaw, '0')
    assert.equal(complete.maximumObservedCompleteWindow[horizon].maximumNetDepletionRaw, '0')
  }
  const short = compute(0, [receipt(0, 0)])
  assert.equal(short.status, 'observed')
  assert.equal(short.trailingCompleteWindow['24h'].status, 'unavailable')
  assert.equal(short.maximumObservedCompleteWindow['7d'].status, 'unavailable')
})

test('trailing interval is [T-W+1,T+1): excludes left boundary and includes T', () => {
  const rows = [event('withdraw', 6, 11n), event('withdraw', 7, 17n), event('deposit', 7, 5n, 107)]
  const result = compute(7, [receipt(0, 7, rows)])
  assert.equal(result.trailingCompleteWindow['24h'].grossWithdrawalsRaw, '17')
  assert.equal(result.trailingCompleteWindow['24h'].grossDepositsRaw, '5')
  assert.equal(result.trailingCompleteWindow['24h'].netDepletionRaw, '12')
  assert.equal(result.trailingCompleteWindow['7d'].grossWithdrawalsRaw, '28')
})

test('maximum signed net depletion considers a deposit leaving a window', () => {
  const rows = [event('deposit', 0, 100n), event('withdraw', 1, 40n)]
  const result = compute(7, [receipt(0, 7, rows)])
  const max = result.maximumObservedCompleteWindow['24h']
  assert.equal(max.maximumGrossWithdrawalsRaw, '40')
  assert.equal(max.maximumNetDepletionRaw, '40')
  assert.equal(max.netWindowStartUtc, new Date((at(0) + 1) * 1000).toISOString())
})

test('maximum signed net depletion may be negative when every complete window has deposits', () => {
  const rows = [event('deposit', 0, 100n), event('deposit', 1, 30n)]
  const result = compute(1, [receipt(0, 1, rows)])
  assert.equal(result.maximumObservedCompleteWindow['24h'].maximumGrossWithdrawalsRaw, '0')
  assert.equal(result.maximumObservedCompleteWindow['24h'].maximumNetDepletionRaw, '-30')
})

test('a verified prefix must end at the exact checkpoint number, hash, and timestamp', () => {
  assert.equal(compute(7, [receipt(0, 6)]).reason, 'checkpoint_not_exact_covered_tip')
  const wrongHash = receipt(0, 7)
  wrongHash.range.to.hash = hash(999)
  assert.equal(compute(7, [wrongHash]).reason, 'checkpoint_not_exact_covered_tip')
  const wrongTime = receipt(0, 7)
  wrongTime.range.to.timestamp++
  assert.equal(compute(7, [wrongTime]).reason, 'future_receipt_in_prefix')
})

test('rejects mismatched chain/asset, unbridged gap, and late receipt capture', () => {
  const mismatch = receipt(0, 7)
  mismatch.source = { ...source, chainId: 10 }
  assert.equal(compute(7, [mismatch]).reason, 'invalid_or_mismatched_receipt_prefix')
  const wrongQuote = checkpointRow(7)
  wrongQuote.checkpoint.source = { ...qSource, crvUsd: hash(2).slice(0, 42) }
  assert.equal(
    compute(7, [receipt(0, 7)], { checkpointRow: wrongQuote }).reason,
    'chain_vault_or_asset_mismatch',
  )
  assert.equal(
    compute(7, [receipt(0, 2), receipt(4, 7, [], 'a', 'b')]).reason,
    'unbridged_coverage_gap',
  )
  const late = receipt(0, 7)
  late.captureEndUtc = '2026-09-29T00:00:00.000Z'
  assert.equal(compute(7, [late]).reason, 'receipt_captured_after_asof')
})

test('future receipts and events never enter the as-of feature', () => {
  assert.equal(compute(7, [receipt(0, 8)]).reason, 'future_receipt_in_prefix')
  const future = event('withdraw', 8, 999n, 107)
  assert.equal(compute(7, [receipt(0, 7, [future])]).reason, 'invalid_or_future_event')
})
