import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { normalizeRow, study, readRows } from './carry-cash-backfill-study.mjs'

const manifest = await buildSubjectManifest()
const vault = manifest.subjects.find((subject) => subject.source_kind === 'vault')
const twyne = manifest.subjects.find(
  (subject) => subject.destination === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
)
const start = Date.parse('2026-09-20T00:00:00.000Z')
const HOUR = 3_600_000
const HASH = `0x${'a'.repeat(64)}`

function row(subject, hour, options = {}) {
  const anchor = new Date(start + hour * HOUR).toISOString()
  const observed = options.state === undefined || options.state === 'observed'
  const state = options.state ?? 'observed'
  const cashRaw = observed ? (options.cashRaw ?? '1000') : null
  const blockAt = new Date(start + hour * HOUR - 12_000 + (options.clockShiftMs ?? 0)).toISOString()
  const result = {
    anchor_at: anchor,
    route_key: subject.route_key,
    subject_kind: subject.source_kind === 'market' ? 'direct' : 'vault',
    venue_kind: subject.source_kind === 'market' ? subject.venue_kind : 'erc4626',
    destination: subject.destination,
    capture_kind: 'backfilled',
    chain_id: 1,
    block: String(1000 + hour),
    block_hash: HASH,
    block_at: blockAt,
    asset: observed ? subject.asset : null,
    share_decimals: observed ? (subject.source_kind === 'market' ? 6 : 18) : null,
    asset_decimals: observed ? (subject.source_kind === 'market' ? 6 : 18) : null,
    cash_raw: cashRaw,
    state,
    reason: observed ? null : `${state}_reason`,
    cohort_id: subject.cohort_id,
    subject_manifest_sha256: manifest.sha256,
    seed_source_sha256: subject.seed_source_sha256,
    seed_sha256: subject.seed_sha256,
    board_sha256: subject.board_sha256,
    displayed_routes_sha256: subject.displayed_routes_sha256,
  }
  result.payload_bytes = JSON.stringify({
    captureKind: result.capture_kind,
    routeKey: result.route_key,
    subjectKind: result.subject_kind,
    venueKind: result.venue_kind,
    destination: result.destination,
    anchorAt: result.anchor_at,
    chainId: result.chain_id,
    block: result.block,
    blockHash: result.block_hash,
    blockAt: result.block_at,
    asset: result.asset,
    shareDecimals: result.share_decimals,
    assetDecimals: result.asset_decimals,
    cashRaw: result.cash_raw,
    state: result.state,
    reason: result.reason,
    cohortId: result.cohort_id,
    subjectManifestSha256: result.subject_manifest_sha256,
    seedSourceSha256: result.seed_source_sha256,
    seedSha256: result.seed_sha256,
    boardSha256: result.board_sha256,
    displayedRoutesSha256: result.displayed_routes_sha256,
  })
  return result
}

function subjectResult(rows, subject = vault) {
  return study(rows, manifest).subjects.find(
    (item) => item.routeKey === subject.route_key && item.destination === subject.destination,
  )
}

test('historical cash changes stay in exact raw units, with H1 and H24 nonoverlapping pairs', () => {
  const base = (1n << 255n) + 9000n
  const rows = Array.from({ length: 25 }, (_, hour) =>
    row(vault, hour, { cashRaw: (base - BigInt(hour * 100)).toString() }),
  )
  const result = subjectResult(rows)
  const h1 = result.horizons[0]
  const h24 = result.horizons[1]
  assert.equal(h1.counts.eligibleRollingPairs, 24)
  assert.equal(h1.counts.independentPairs, 12)
  assert.equal(h1.independent.worstObservedDeclineRaw, '100')
  assert.equal(h1.independent.cashChangeRawQuantiles.p50, '-100')
  assert.equal(h1.rollingWorstObservedDeclineRaw, '100')
  assert.equal(h1.independent.persistenceAbsoluteErrorRawQuantiles.p95, '100')
  assert.equal(h24.counts.eligibleRollingPairs, 1)
  assert.equal(h24.counts.independentPairs, 1)
  assert.equal(h24.independent.worstObservedDeclineRaw, '2400')
  assert.equal(h24.independent.persistenceAbsoluteErrorRawQuantiles.p50, '2400')
  assert.equal(h24.counts.pendingBeyondArchive, 24)
  assert.equal(study(rows, manifest).prospectiveValidated, false)
  assert.equal(study(rows, manifest).missingSubjectAnchorRows, 66 * 25)
  assert.equal(h1.pairs, undefined)
  const training = study(rows, manifest, { includePairs: true }).subjects.find(
    (item) => item.routeKey === vault.route_key && item.destination === vault.destination,
  )
  assert.deepEqual(training.horizons[0].pairs[0], {
    subjectKey: `${vault.route_key}\0${vault.destination}`,
    sourceAt: rows[0].block_at,
    targetAt: rows[1].block_at,
    sourceCashRaw: base.toString(),
    targetCashRaw: (base - 100n).toString(),
  })
  assert.equal(training.horizons[0].pairs.length, 12)
})

test('rejects asset decimal drift across observed archive anchors', () => {
  const first = row(vault, 0)
  const second = row(vault, 1)
  second.asset_decimals = second.asset_decimals === 18 ? 6 : 18
  second.payload_bytes = JSON.stringify({
    ...JSON.parse(second.payload_bytes),
    assetDecimals: second.asset_decimals,
  })
  assert.throws(() => study([first, second], manifest), /backfill_subject_decimals_changed/)
})

test('missing hourly path and unassessed Twyne cash censor pairs without treating null as zero', () => {
  const withoutMiddle = Array.from({ length: 25 }, (_, hour) =>
    hour === 12 ? null : row(vault, hour),
  ).filter(Boolean)
  const result = subjectResult(withoutMiddle)
  assert.equal(result.horizons[1].counts.eligibleRollingPairs, 0)
  assert.equal(result.horizons[1].counts.censoredGap, 1)
  assert.equal(result.horizons[0].counts.censoredTarget, 1)
  assert.equal(result.horizons[0].counts.censoredGap, 0)
  assert.ok(twyne)
  const twyneRows = [row(twyne, 0, { state: 'unassessed' }), row(twyne, 1, { state: 'unassessed' })]
  const twyneResult = subjectResult(twyneRows, twyne)
  assert.equal(twyneResult.observedAnchors, 0)
  assert.equal(twyneResult.horizons[0].counts.censoredSource, 2)
  assert.equal(twyneResult.horizons[0].independent.worstObservedDeclineRaw, null)
})

test('a wholly absent UTC hour remains in the coverage denominator', () => {
  const output = study([row(vault, 0), row(vault, 2)], manifest)
  const result = output.subjects.find(
    (item) => item.routeKey === vault.route_key && item.destination === vault.destination,
  )
  assert.equal(output.archiveAnchorCount, 2)
  assert.equal(output.expectedHourlyAnchorCount, 3)
  assert.equal(output.whollyMissingArchiveAnchors, 1)
  assert.equal(output.missingSubjectAnchorRows, 3 * 67 - 2)
  assert.equal(result.missingSubjectAnchors, 1)
  assert.equal(result.horizons[0].counts.censoredTarget, 1)
})

test('independent pairs are selected separately for each subject and horizon', () => {
  const other = manifest.subjects.find((subject) => subject.destination !== vault.destination)
  const output = study([row(vault, 0), row(other, 0), row(vault, 1), row(other, 1)], manifest)
  const first = output.subjects.find(
    (item) => item.destination === vault.destination && item.routeKey === vault.route_key,
  )
  const second = output.subjects.find(
    (item) => item.destination === other.destination && item.routeKey === other.route_key,
  )
  assert.equal(first.horizons[0].counts.independentPairs, 1)
  assert.equal(second.horizons[0].counts.independentPairs, 1)
  assert.equal(first.horizons[1].counts.independentPairs, 0)
})

test('physical time outside the tight H1 window is censored despite nominal hourly anchors', () => {
  const result = subjectResult([row(vault, 0), row(vault, 1, { clockShiftMs: -20 * 60_000 })])
  assert.equal(result.horizons[0].counts.censoredPhysicalTime, 1)
  assert.equal(result.horizons[0].counts.eligibleRollingPairs, 0)
})

test('duplicate anchors, wrong asset, changed provenance, and payload drift fail closed', () => {
  const original = row(vault, 0)
  assert.throws(() => study([original, original], manifest), /duplicate_backfill_subject_anchor/)
  assert.throws(
    () => normalizeRow({ ...original, asset: `0x${'1'.repeat(40)}` }, vault, manifest.sha256),
    /invalid_backfill_observation/,
  )
  assert.throws(
    () => normalizeRow({ ...original, seed_sha256: 'b'.repeat(64) }, vault, manifest.sha256),
    /backfill_subject_provenance_mismatch/,
  )
  assert.throws(
    () => normalizeRow({ ...original, cash_raw: '1001' }, vault, manifest.sha256),
    /backfill_payload_mismatch/,
  )
  assert.throws(
    () => normalizeRow({ ...original, asset_decimals: null }, vault, manifest.sha256),
    /invalid_backfill_decimals/,
  )
  assert.throws(
    () =>
      normalizeRow({ ...original, cash_raw: Number.MAX_SAFE_INTEGER + 2 }, vault, manifest.sha256),
    /invalid_backfill_observation|backfill_payload_mismatch/,
  )
  const other = manifest.subjects.find((subject) => subject.route_key !== vault.route_key)
  const missingTerminal = subjectResult([original, row(other, 2)])
  assert.equal(missingTerminal.horizons[0].counts.censoredTarget, 1)
  assert.equal(missingTerminal.horizons[0].counts.pendingBeyondArchive, 0)
  assert.throws(
    () => study([original, row(other, 0, { clockShiftMs: -1000 })], manifest),
    /backfill_anchor_block_mismatch/,
  )
})

test('semantically impossible Twyne and direct-market observations fail closed', () => {
  assert.ok(twyne)
  assert.throws(() => study([row(twyne, 0)], manifest), /twyne_cash_must_be_unassessed/)
  const direct = manifest.subjects.find((subject) => subject.source_kind === 'market')
  assert.ok(direct)
  const valid = row(direct, 0)
  assert.doesNotThrow(() => study([valid], manifest))
  assert.throws(
    () => study([{ ...valid, asset_decimals: 18 }], manifest),
    /direct_market_decimals_mismatch/,
  )
  assert.throws(
    () => study([{ ...valid, share_decimals: 18 }], manifest),
    /direct_market_decimals_mismatch/,
  )
})

test('the database adapter issues only a bounded read', async () => {
  let query = ''
  const sql = (parts) => {
    query = parts.join('?')
    return Promise.resolve([row(vault, 0)])
  }
  assert.equal((await readRows(sql)).length, 1)
  assert.match(query, /SELECT anchor_at/)
  assert.match(query, /WHERE capture_kind = 'backfilled'/)
  assert.match(query, /LIMIT 100001/)
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE/)
})
