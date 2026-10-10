import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { STUDY } from './aave-usdc-cash-direct-flow-join.mjs'
import {
  serializeFullReplaySummary,
  serializeDurationReplaySummary,
} from './export-aave-usdc-flow-stress-summary.mjs'

const hash = (block) => `0x${block.toString(16).padStart(64, '0')}`
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture() {
  const joined = {
    study: STUDY,
    forecast: false,
    fromBlock: 100,
    toBlock: 356,
    slices: [
      {
        fromExclusive: 100,
        toInclusive: 356,
        fromHash: hash(100),
        toHash: hash(356),
        cashBeforeRaw: '1000',
        cashAfterRaw: '800',
        grossReserveInRaw: '400',
        grossReserveOutRaw: '600',
        grossSupplierSupplyRaw: '400',
        grossSupplierWithdrawalRaw: '600',
        otherReserveInRaw: '0',
        otherReserveOutRaw: '0',
        minEndOfBlockCashRaw: '500',
        minEndOfBlockCashAtBlock: 200,
        blockFlows: [
          { blockNumber: 200, blockHash: hash(200), cashAfterRaw: '500' },
          { blockNumber: 356, blockHash: hash(356), cashAfterRaw: '800' },
        ],
      },
    ],
  }
  const timed = structuredClone(joined)
  timed.slices[0].verifiedTimeHeaders = [
    { blockNumber: 99, blockHash: hash(99), timestampSec: 990 },
    { blockNumber: 200, blockHash: hash(200), timestampSec: 1500 },
    { blockNumber: 357, blockHash: hash(357), timestampSec: 3000 },
  ]
  return { joined, timed }
}

test('versioned timestamp overlay links to the unchanged legacy cash join and retains neighboring brackets', () => {
  const { joined, timed } = fixture()
  const legacyBytes = serializeFullReplaySummary(joined)
  const legacy = JSON.parse(legacyBytes)
  const overlay = JSON.parse(serializeDurationReplaySummary(joined, timed))
  assert.equal(serializeFullReplaySummary(joined), legacyBytes)
  assert.equal(overlay.source.joinContentSha256, legacy.source.joinContentSha256)
  assert.equal(overlay.source.joinContentSha256, digest(joined))
  assert.equal(overlay.durationOverlay.sourceJoinSha256, digest(joined))
  assert.equal(overlay.durationOverlay.timedJoinSha256, digest(timed))
  const window = overlay.pairedWindows[0]
  assert.equal(window.durationPath.sourceJoinSha256, digest(joined))
  assert.deepEqual(
    window.durationPath.points.map((point) => point.blockNumber),
    [100, 200, 356],
  )
  assert.deepEqual(
    window.durationPath.timeHeaders.map((header) => header.blockNumber),
    [99, 200, 357],
  )
  assert.equal(overlay.durationOverlay.pathsSha256, digest([window.durationPath]))
  assert.equal(overlay.pairedWindowsSha256, digest(overlay.pairedWindows))
  assert.equal(legacy.pairedWindows[0].durationPath, undefined)
})

test('overlay refuses changed cash paths or missing verified header provenance', () => {
  const { joined, timed } = fixture()
  timed.slices[0].blockFlows[0].cashAfterRaw = '499'
  assert.throws(
    () => serializeDurationReplaySummary(joined, timed),
    /flow_duration_cash_overlay_mismatch/,
  )
  const missing = fixture()
  delete missing.timed.slices[0].verifiedTimeHeaders
  assert.throws(
    () => serializeDurationReplaySummary(missing.joined, missing.timed),
    /flow_duration_headers_missing/,
  )
})
