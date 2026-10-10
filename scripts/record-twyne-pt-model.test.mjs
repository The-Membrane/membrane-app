import test from 'node:test'
import assert from 'node:assert/strict'

import { TWYNE_PT_RESERVE } from './record-twyne-pt-reserve.mjs'
import {
  buildTwynePtModelArtifact,
  planTwynePtIssue,
  issueTwynePtModelSlot,
  scoreDueTwynePtModelIssues,
} from './record-twyne-pt-model.mjs'

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
      observedAt,
      captureKind: 'backfilled',
      chainId: 1,
      wrapper: row.wrapper,
      pt: row.pt,
      aToken: row.atoken,
      pool: row.pool,
      block: row.block,
      blockHash: row.block_hash,
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

test('qualified artifact binds historical anchors/pairs but excludes changing current cash', () => {
  const { rows, current } = fixture()
  const artifact = buildTwynePtModelArtifact(rows, current)
  const changed = buildTwynePtModelArtifact(rows, {
    ...current,
    aave_pt_reserve_cash_raw: '2000',
  })
  assert.equal(artifact.sha256, changed.sha256)
  assert.equal(artifact.modelVersion, changed.modelVersion)
  assert.equal(artifact.metric, 'aave_pt_reserve_cash_raw')
  assert.equal(artifact.horizonHours, 1)
  assert.equal(artifact.archiveAnchors, 120)
  assert.equal(artifact.holdoutPairs, 20)
  const payload = JSON.parse(artifact.payloadBytes)
  assert.equal(payload.kind, 'historical_aave_pt_reserve_persistence_band_v1')
  assert.equal(payload.anchors.length, 120)
  assert.equal(payload.pairs.length, 60)
  assert.equal(payload.holderExecutableExit, false)
  assert.equal(payload.prospectiveValidated, false)
  assert.equal('pointRaw' in payload.baselineBand, false)
  const altered = structuredClone(rows)
  altered[0].aave_pt_reserve_cash_raw = '999'
  assert.throws(() => buildTwynePtModelArtifact(altered, current), /payload_mismatch/)
})

test('issue arithmetic uses raw BigInt and clips its band at zero', () => {
  const row = { aave_pt_reserve_cash_raw: '4' }
  const artifact = { calibration_change_p05_raw: '-10', calibration_change_p95_raw: '8' }
  assert.deepEqual(planTwynePtIssue(row, artifact), {
    sourceCashRaw: '4',
    forecastPointRaw: '4',
    forecastLowRaw: '0',
    forecastHighRaw: '12',
  })
  assert.throws(
    () =>
      planTwynePtIssue(row, {
        calibration_change_p05_raw: '9',
        calibration_change_p95_raw: '8',
      }),
    /arithmetic_invalid/,
  )
})

test('15-minute issuer uses DB slot, recent prospective source, and artifact', async () => {
  const slot = new Date('2026-09-29T07:00:00.000Z')
  const now = new Date('2026-09-29T07:10:00.000Z')
  const source = {
    block: '26081234',
    block_hash: HASH,
    observed_at: new Date('2026-09-29T06:55:00.000Z'),
    first_local_receipt_at: new Date('2026-09-29T07:09:00.000Z'),
    pt_decimals: 18,
    aave_pt_reserve_cash_raw: '100',
  }
  const artifact = {
    sha256: 'b'.repeat(64),
    asset_decimals: 18,
    calibration_change_p05_raw: '-10',
    calibration_change_p95_raw: '20',
  }
  const queries = []
  const sql = (parts, ...params) => {
    const query = parts.join('?')
    queries.push({ query, params })
    if (query.includes('SELECT clock_timestamp() AS now')) return [{ now, slot_at: slot }]
    if (query.includes('SELECT status FROM twyne_pt_model_issues')) return []
    if (query.includes('FROM twyne_pt_model_artifacts ORDER')) return [artifact]
    if (query.includes('FROM twyne_pt_reserve_observations')) return [source]
    if (query.includes('INSERT INTO twyne_pt_model_issues'))
      return [
        {
          status: 'issued',
          slot_at: slot,
          issued_at: now,
          target_at: new Date(source.observed_at.getTime() + HOUR),
          target_low_at: new Date(source.observed_at.getTime() + HOUR - 900_000),
          target_high_at: new Date(source.observed_at.getTime() + HOUR + 900_000),
          score_after_at: new Date(source.observed_at.getTime() + 2 * HOUR),
        },
      ]
    throw new Error('unexpected query')
  }
  const result = await issueTwynePtModelSlot(sql)
  assert.equal(result.status, 'issued')
  assert.equal(result.targetAt, '2026-09-29T07:55:00.000Z')
  assert.match(queries[0].query, /date_bin\('15 minutes'/)
  const insert = queries.find((q) => q.query.includes('INSERT INTO twyne_pt_model_issues'))
  assert.ok(insert.params.includes('90'))
  assert.ok(insert.params.includes('120'))
  assert.equal(insert.params[10], null)
  assert.match(insert.query, /ON CONFLICT \(slot_at\) DO NOTHING/)
})

test('a missing source seals only its 15-minute slot', async () => {
  const calls = []
  const sql = (parts) => {
    const query = parts.join('?')
    calls.push(query)
    if (query.includes('SELECT clock_timestamp() AS now'))
      return [
        {
          now: new Date('2026-09-29T09:10:00.000Z'),
          slot_at: new Date('2026-09-29T09:00:00.000Z'),
        },
      ]
    if (query.includes('SELECT status FROM twyne_pt_model_issues')) return []
    if (query.includes('FROM twyne_pt_model_artifacts ORDER')) return [{ sha256: 'b'.repeat(64) }]
    if (query.includes('FROM twyne_pt_reserve_observations')) return []
    if (query.includes('INSERT INTO twyne_pt_model_issues'))
      return [
        {
          status: 'source_missing',
          slot_at: new Date('2026-09-29T09:00:00.000Z'),
          issued_at: new Date('2026-09-29T09:10:00.000Z'),
          target_at: new Date('2026-09-29T10:10:00.000Z'),
          target_low_at: new Date('2026-09-29T09:55:00.000Z'),
          target_high_at: new Date('2026-09-29T10:25:00.000Z'),
          score_after_at: new Date('2026-09-29T11:10:00.000Z'),
        },
      ]
    throw new Error('unexpected query')
  }
  assert.deepEqual(await issueTwynePtModelSlot(sql), {
    status: 'source_missing',
    slotAt: '2026-09-29T09:00:00.000Z',
    issuedAt: '2026-09-29T09:10:00.000Z',
    targetAt: '2026-09-29T10:10:00.000Z',
    targetLowAt: '2026-09-29T09:55:00.000Z',
    targetHighAt: '2026-09-29T10:25:00.000Z',
    scoreAfterAt: '2026-09-29T11:10:00.000Z',
  })
  assert.equal(
    calls.some((query) => query.includes('INSERT INTO twyne_pt_model_issues')),
    true,
  )
})

test('scorer query waits until target plus one hour and freezes deterministic candidate order', async () => {
  let query = ''
  const sql = (parts) => {
    query = parts.join('?')
    return [{ sealed: 2, observed: 1, censored_missing: 1 }]
  }
  assert.deepEqual(await scoreDueTwynePtModelIssues(sql), {
    sealed: 2,
    observed: 1,
    censoredMissing: 1,
  })
  assert.match(query, /score_after_at <= clock_timestamp\(\)/)
  assert.match(query, /first_local_receipt_at <= d.score_after_at/)
  assert.match(query, /abs\(extract\(epoch FROM \(o.observed_at - d.target_at\)\)\)/)
  assert.match(query, /o.observed_at, o.block LIMIT 1/)
  assert.match(query, /pt_decimals = d.source_asset_decimals/)
})
