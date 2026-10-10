import test from 'node:test'
import assert from 'node:assert/strict'

import { TWYNE_PT_RESERVE } from '../record-twyne-pt-reserve.mjs'
import { studyTwynePtReserve } from './twyne-pt-reserve-study.mjs'

const START = Date.parse('2026-09-15T04:00:00.000Z')
const HOUR = 3_600_000
const HASH = `0x${'a'.repeat(64)}`

function fixture() {
  const rows = Array.from({ length: 120 }, (_, i) => {
    const anchorAt = new Date(START + i * HOUR).toISOString()
    const observedAt = new Date(START + i * HOUR - 12_000).toISOString()
    const row = {
      anchor_at: anchorAt,
      capture_kind: 'backfilled',
      chain_id: 1,
      wrapper: TWYNE_PT_RESERVE.wrapper,
      pt: TWYNE_PT_RESERVE.pt,
      atoken: TWYNE_PT_RESERVE.aToken,
      pool: TWYNE_PT_RESERVE.pool,
      block: String(1000 + i),
      block_hash: HASH,
      observed_at: observedAt,
      pt_decimals: 18,
      aave_pt_reserve_cash_raw: String(1000 + i),
    }
    row.payload_bytes = JSON.stringify({
      anchorAt,
      captureKind: 'backfilled',
      chainId: 1,
      wrapper: row.wrapper,
      pt: row.pt,
      aToken: row.atoken,
      pool: row.pool,
      block: row.block,
      blockHash: row.block_hash,
      observedAt,
      ptDecimals: 18,
      aavePtReserveCashRaw: row.aave_pt_reserve_cash_raw,
    })
    return row
  })
  const current = {
    wrapper: TWYNE_PT_RESERVE.wrapper,
    pt: TWYNE_PT_RESERVE.pt,
    atoken: TWYNE_PT_RESERVE.aToken,
    pool: TWYNE_PT_RESERVE.pool,
    block: '2000',
    block_hash: HASH,
    observed_at: new Date(START + 120 * HOUR).toISOString(),
    first_local_receipt_at: new Date(START + 120 * HOUR + 1000).toISOString(),
    pt_decimals: 18,
    aave_pt_reserve_cash_raw: '1120',
  }
  return { rows, current }
}

test('uses 60 disjoint physical H1 pairs for the separately named market cash metric', () => {
  const { rows, current } = fixture()
  const result = studyTwynePtReserve(rows, current)
  assert.equal(result.metric, 'aave_pt_reserve_cash_raw')
  assert.equal(result.pairs.length, 60)
  assert.equal(result.pairs[0].sourceCashRaw, '1000')
  assert.equal(result.pairs[0].targetCashRaw, '1001')
  assert.equal(result.pairs[1].sourceCashRaw, '1002')
  assert.equal(result.assetDecimals, 18)
  assert.equal(result.projection.prospectiveValidated, false)
})

test('rejects archive gaps, decimal drift, payload drift and current identity drift', () => {
  const { rows, current } = fixture()
  assert.throws(() => studyTwynePtReserve(rows.slice(1), current), /incomplete_archive/)
  const gap = [...rows]
  gap[1] = { ...gap[1], anchor_at: new Date(START + 2 * HOUR).toISOString() }
  assert.throws(() => studyTwynePtReserve(gap, current), /archive_gap_or_decimals|payload_mismatch/)
  const decimal = [...rows]
  decimal[1] = { ...decimal[1], pt_decimals: 6 }
  assert.throws(() => studyTwynePtReserve(decimal, current), /identity_or_payload_mismatch/)
  const payload = [...rows]
  payload[1] = { ...payload[1], aave_pt_reserve_cash_raw: '9999' }
  assert.throws(() => studyTwynePtReserve(payload, current), /identity_or_payload_mismatch/)
  assert.throws(
    () => studyTwynePtReserve(rows, { ...current, pt: rows[0].wrapper }),
    /current_identity_or_clock/,
  )
})
