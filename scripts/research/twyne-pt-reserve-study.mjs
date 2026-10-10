// Exact Aave PT reserve cash H1 research pairs. These historical reconstructions
// were not available at their anchor times and are never prospective outcomes.
import projectionModule from '../../lib/carry/historicalCashProjection.ts'
import { TWYNE_PT_RESERVE } from '../record-twyne-pt-reserve.mjs'

const { projectHistoricalCash } = projectionModule
const HOUR = 3_600_000
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n
const iso = (value) => new Date(value).toISOString()

function raw(value) {
  const text = String(value)
  if (!RAW.test(text) || BigInt(text) > MAX_U256) throw new Error('twyne_study_invalid_raw')
  return text
}

export function studyTwynePtReserve(rows, current) {
  if (!Array.isArray(rows) || rows.length < 120 || rows.length > 720)
    throw new Error('twyne_study_incomplete_archive')
  const points = rows.map((row) => {
    const anchorAt = iso(row.anchor_at)
    const observedAt = iso(row.observed_at)
    const assetDecimals = Number(row.pt_decimals)
    const payload = JSON.parse(String(row.payload_bytes))
    if (
      row.capture_kind !== 'backfilled' ||
      Number(row.chain_id) !== 1 ||
      row.wrapper !== TWYNE_PT_RESERVE.wrapper ||
      row.pt !== TWYNE_PT_RESERVE.pt ||
      row.atoken !== TWYNE_PT_RESERVE.aToken ||
      row.pool !== TWYNE_PT_RESERVE.pool ||
      !Number.isInteger(assetDecimals) ||
      assetDecimals < 0 ||
      assetDecimals > 36 ||
      payload.anchorAt !== anchorAt ||
      payload.observedAt !== observedAt ||
      payload.aavePtReserveCashRaw !== raw(row.aave_pt_reserve_cash_raw) ||
      payload.ptDecimals !== assetDecimals
    )
      throw new Error('twyne_study_identity_or_payload_mismatch')
    return {
      anchorAt,
      anchorMs: Date.parse(anchorAt),
      observedAt,
      observedMs: Date.parse(observedAt),
      block: String(row.block),
      blockHash: String(row.block_hash),
      cashRaw: raw(row.aave_pt_reserve_cash_raw),
      assetDecimals,
    }
  })
  const decimals = points[0].assetDecimals
  for (let i = 0; i < points.length; i++) {
    if (
      points[i].assetDecimals !== decimals ||
      (i > 0 && points[i].anchorMs - points[i - 1].anchorMs !== HOUR) ||
      points[i].anchorMs - points[i].observedMs < 0 ||
      points[i].anchorMs - points[i].observedMs > 15 * 60_000
    )
      throw new Error('twyne_study_archive_gap_or_decimals')
  }
  if (
    current?.wrapper !== TWYNE_PT_RESERVE.wrapper ||
    current?.pt !== TWYNE_PT_RESERVE.pt ||
    current?.atoken !== TWYNE_PT_RESERVE.aToken ||
    current?.pool !== TWYNE_PT_RESERVE.pool ||
    Number(current?.pt_decimals) !== decimals ||
    Date.parse(current?.observed_at) <= points.at(-1).observedMs
  )
    throw new Error('twyne_study_current_identity_or_clock')
  const pairs = []
  const subjectKey = `${TWYNE_PT_RESERVE.routeKey}\0${TWYNE_PT_RESERVE.wrapper}`
  for (let i = 0; i + 1 < points.length; i += 2) {
    const source = points[i]
    const target = points[i + 1]
    const elapsed = target.observedMs - source.observedMs
    if (elapsed < 45 * 60_000 || elapsed > 75 * 60_000)
      throw new Error('twyne_study_pair_physical_time')
    pairs.push({
      subjectKey,
      sourceAt: source.observedAt,
      targetAt: target.observedAt,
      sourceCashRaw: source.cashRaw,
      targetCashRaw: target.cashRaw,
    })
  }
  const projection = projectHistoricalCash({
    subjectKey,
    horizonHours: 1,
    currentAt: iso(current.observed_at),
    currentCashRaw: raw(current.aave_pt_reserve_cash_raw),
    pairs,
  })
  return {
    metric: 'aave_pt_reserve_cash_raw',
    routeKey: TWYNE_PT_RESERVE.routeKey,
    wrapper: TWYNE_PT_RESERVE.wrapper,
    pt: TWYNE_PT_RESERVE.pt,
    aToken: TWYNE_PT_RESERVE.aToken,
    pool: TWYNE_PT_RESERVE.pool,
    assetDecimals: decimals,
    firstAnchorAt: points[0].anchorAt,
    lastAnchorAt: points.at(-1).anchorAt,
    archiveAnchors: points.length,
    pairs,
    current: {
      block: String(current.block),
      blockHash: String(current.block_hash),
      observedAt: iso(current.observed_at),
      firstLocalReceiptAt: iso(current.first_local_receipt_at),
      cashRaw: raw(current.aave_pt_reserve_cash_raw),
    },
    projection,
  }
}
