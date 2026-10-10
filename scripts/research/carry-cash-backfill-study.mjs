// Read-only description of reconstructed aggregate cash, never prospective evidence.
// Usage: node --import tsx scripts/research/carry-cash-backfill-study.mjs
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { validateManifest } from '../backfill-carry-cash-archive.mjs'
import { readEnv } from '../lib/venue-reads.mjs'

const HOUR = 3_600_000
const HORIZONS = [
  { hours: 1, toleranceMs: 15 * 60_000 },
  { hours: 24, toleranceMs: HOUR },
]
const RAW = /^(0|[1-9][0-9]*)$/
const HASH = /^0x[0-9a-f]{64}$/
const MAX_U256 = (1n << 256n) - 1n
const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const keyOf = (row) => `${row.route_key}\0${row.destination}`
const iso = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isSafeInteger(ms)) throw new Error('invalid_backfill_time')
  return new Date(ms).toISOString()
}
const numberInRange = (value, max) => {
  if (value == null) throw new Error('invalid_backfill_decimals')
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error('invalid_backfill_decimals')
  return n
}
const nullable = (value) => (value == null ? null : String(value))

/** Keep database numerics as exact decimal strings until BigInt arithmetic. */
export function normalizeRow(row, expected, manifestSha256) {
  if (
    !expected ||
    row.capture_kind !== 'backfilled' ||
    row.chain_id !== 1 ||
    row.route_key !== expected.route_key ||
    row.destination !== expected.destination ||
    row.subject_kind !== (expected.source_kind === 'market' ? 'direct' : 'vault') ||
    row.venue_kind !== (expected.source_kind === 'market' ? expected.venue_kind : 'erc4626') ||
    row.subject_manifest_sha256 !== manifestSha256 ||
    nullable(row.cohort_id) !== expected.cohort_id ||
    nullable(row.seed_source_sha256) !== expected.seed_source_sha256 ||
    nullable(row.seed_sha256) !== expected.seed_sha256 ||
    nullable(row.board_sha256) !== expected.board_sha256 ||
    nullable(row.displayed_routes_sha256) !== expected.displayed_routes_sha256
  )
    throw new Error('backfill_subject_provenance_mismatch')

  const anchorAt = iso(row.anchor_at)
  const blockAt = iso(row.block_at)
  if (
    (typeof row.block !== 'string' && typeof row.block !== 'bigint') ||
    (typeof row.block === 'number' && !Number.isSafeInteger(row.block))
  )
    throw new Error('invalid_backfill_block')
  const block = String(row.block)
  if (
    !/^[1-9][0-9]*$/.test(block) ||
    !HASH.test(row.block_hash) ||
    Date.parse(blockAt) > Date.parse(anchorAt) ||
    Date.parse(anchorAt) % HOUR !== 0
  )
    throw new Error('invalid_backfill_block')

  const state = row.state
  if (
    !['observed', 'no_code', 'read_unavailable', 'identity_mismatch', 'unassessed'].includes(state)
  )
    throw new Error('invalid_backfill_state')
  let asset = null
  let assetDecimals = null
  let shareDecimals = null
  let cashRaw = null
  if (state === 'observed') {
    asset = row.asset
    assetDecimals = numberInRange(row.asset_decimals, 255)
    shareDecimals = numberInRange(row.share_decimals, 255)
    if (typeof row.cash_raw !== 'string' && typeof row.cash_raw !== 'bigint')
      throw new Error('invalid_backfill_observation')
    cashRaw = String(row.cash_raw)
    if (
      asset !== expected.asset ||
      !RAW.test(cashRaw) ||
      BigInt(cashRaw) > MAX_U256 ||
      row.reason != null
    )
      throw new Error('invalid_backfill_observation')
    if (row.destination === TWYNE_WRAPPER) throw new Error('twyne_cash_must_be_unassessed')
    if (expected.source_kind === 'market' && (assetDecimals !== 6 || shareDecimals !== 6))
      throw new Error('direct_market_decimals_mismatch')
  } else if (
    row.asset != null ||
    row.asset_decimals != null ||
    row.share_decimals != null ||
    row.cash_raw != null ||
    typeof row.reason !== 'string' ||
    !row.reason
  ) {
    throw new Error('invalid_backfill_missing_state')
  }

  // The inserted text binds the selected database fields to the original batch.
  let payload
  try {
    payload = JSON.parse(row.payload_bytes)
  } catch {
    throw new Error('invalid_backfill_payload')
  }
  if (
    !payload ||
    payload.captureKind !== 'backfilled' ||
    payload.routeKey !== row.route_key ||
    payload.destination !== row.destination ||
    payload.anchorAt !== anchorAt ||
    payload.block !== block ||
    payload.blockHash !== row.block_hash ||
    payload.blockAt !== blockAt ||
    payload.subjectKind !== row.subject_kind ||
    payload.venueKind !== row.venue_kind ||
    payload.chainId !== row.chain_id ||
    payload.state !== state ||
    payload.asset !== asset ||
    payload.assetDecimals !== assetDecimals ||
    payload.shareDecimals !== shareDecimals ||
    payload.cashRaw !== cashRaw ||
    payload.reason !== row.reason ||
    payload.subjectManifestSha256 !== manifestSha256 ||
    payload.cohortId !== nullable(row.cohort_id) ||
    payload.seedSourceSha256 !== nullable(row.seed_source_sha256) ||
    payload.seedSha256 !== nullable(row.seed_sha256) ||
    payload.boardSha256 !== nullable(row.board_sha256) ||
    payload.displayedRoutesSha256 !== nullable(row.displayed_routes_sha256)
  )
    throw new Error('backfill_payload_mismatch')

  return {
    key: keyOf(row),
    anchorAt,
    anchorMs: Date.parse(anchorAt),
    blockAt,
    blockMs: Date.parse(blockAt),
    block: BigInt(block),
    blockHash: row.block_hash,
    state,
    asset,
    assetDecimals,
    shareDecimals,
    cashRaw: cashRaw == null ? null : BigInt(cashRaw),
    provenance: [
      manifestSha256,
      nullable(row.cohort_id),
      nullable(row.seed_source_sha256),
      nullable(row.seed_sha256),
      nullable(row.board_sha256),
      nullable(row.displayed_routes_sha256),
    ].join('|'),
  }
}

function quantileRaw(sorted, numerator, denominator) {
  if (!sorted.length) return null
  const index = Math.ceil((sorted.length * numerator) / denominator) - 1
  return sorted[Math.max(0, index)].toString()
}

function describePairs(pairs) {
  const changes = pairs.map((pair) => pair.change).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const declines = pairs.map((pair) => pair.decline).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const errors = pairs.map((pair) => pair.error).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const quantiles = (values) => ({
    p50: quantileRaw(values, 1, 2),
    p90: quantileRaw(values, 9, 10),
    p95: quantileRaw(values, 95, 100),
    p99: quantileRaw(values, 99, 100),
  })
  return {
    pairCount: pairs.length,
    cashChangeRawQuantiles: quantiles(changes),
    declineRawQuantiles: quantiles(declines),
    worstObservedDeclineRaw: declines.at(-1)?.toString() ?? null,
    persistenceAbsoluteErrorRawQuantiles: quantiles(errors),
  }
}

function studyHorizon(rows, byAnchor, maxAnchorMs, { hours, toleranceMs }, includePairs = false) {
  const horizonMs = hours * HOUR
  const counts = {
    sourceAnchors: rows.length,
    observedSources: 0,
    horizonInsideArchive: 0,
    eligibleRollingPairs: 0,
    independentPairs: 0,
    pendingBeyondArchive: 0,
    censoredSource: 0,
    censoredTarget: 0,
    censoredGap: 0,
    censoredPhysicalTime: 0,
    censoredProvenance: 0,
  }
  const eligible = []
  for (const source of rows) {
    if (source.state !== 'observed') {
      counts.censoredSource++
      continue
    }
    counts.observedSources++
    const targetAnchor = source.anchorMs + horizonMs
    if (targetAnchor > maxAnchorMs) {
      counts.pendingBeyondArchive++
      continue
    }
    counts.horizonInsideArchive++
    const target = byAnchor.get(targetAnchor)
    if (!target || target.state !== 'observed') {
      counts.censoredTarget++
      continue
    }
    if (
      source.anchorMs - source.blockMs > 15 * 60_000 ||
      target.anchorMs - target.blockMs > 15 * 60_000 ||
      Math.abs(target.blockMs - source.blockMs - horizonMs) > toleranceMs ||
      target.block <= source.block
    ) {
      counts.censoredPhysicalTime++
      continue
    }
    if (
      target.provenance !== source.provenance ||
      target.asset !== source.asset ||
      target.assetDecimals !== source.assetDecimals ||
      target.shareDecimals !== source.shareDecimals
    ) {
      counts.censoredProvenance++
      continue
    }
    let gap = false
    let previous = source
    for (let step = 1; step <= hours; step++) {
      const point = byAnchor.get(source.anchorMs + step * HOUR)
      if (
        !point ||
        point.state !== 'observed' ||
        point.provenance !== source.provenance ||
        point.asset !== source.asset ||
        point.assetDecimals !== source.assetDecimals ||
        point.shareDecimals !== source.shareDecimals ||
        point.block <= previous.block ||
        point.blockMs <= previous.blockMs ||
        point.blockMs - previous.blockMs > 75 * 60_000 ||
        point.anchorMs - point.blockMs > 15 * 60_000
      ) {
        gap = true
        break
      }
      previous = point
    }
    if (gap) {
      counts.censoredGap++
      continue
    }
    const change = target.cashRaw - source.cashRaw
    eligible.push({
      sourceMs: source.blockMs,
      targetMs: target.blockMs,
      sourceAt: source.blockAt,
      targetAt: target.blockAt,
      sourceCashRaw: source.cashRaw,
      targetCashRaw: target.cashRaw,
      subjectKey: source.key,
      change,
      decline: change < 0n ? -change : 0n,
      error: change < 0n ? -change : change,
    })
    counts.eligibleRollingPairs++
  }
  const independent = []
  let lastEnd = -Infinity
  for (const pair of eligible) {
    if (pair.sourceMs <= lastEnd) continue
    independent.push(pair)
    lastEnd = pair.targetMs
  }
  counts.independentPairs = independent.length
  return {
    horizonHours: hours,
    targetToleranceMinutes: toleranceMs / 60_000,
    independentSelection: 'earliest_anchor_greedy_disjoint_endpoints',
    counts,
    rollingWorstObservedDeclineRaw: eligible.length
      ? eligible
          .reduce((worst, pair) => (pair.decline > worst ? pair.decline : worst), 0n)
          .toString()
      : null,
    independent: describePairs(independent),
    ...(includePairs
      ? {
          pairs: independent.map(
            ({ subjectKey, sourceAt, targetAt, sourceCashRaw, targetCashRaw }) => ({
              subjectKey,
              sourceAt,
              targetAt,
              sourceCashRaw: sourceCashRaw.toString(),
              targetCashRaw: targetCashRaw.toString(),
            }),
          ),
        }
      : {}),
  }
}

/** A cohort study: historical reconstructed levels, no model fit or holder-size claim. */
export function study(rows, manifest, { includePairs = false } = {}) {
  const expected = validateManifest(manifest)
  if (!Array.isArray(rows)) throw new Error('backfill_rows_required')
  const series = new Map(manifest.subjects.map((s) => [`${s.route_key}\0${s.destination}`, []]))
  const keys = new Set()
  const anchors = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    const normalized = normalizeRow(row, expected.get(key), manifest.sha256)
    const slotKey = `${normalized.anchorAt}\0${key}`
    if (keys.has(slotKey)) throw new Error('duplicate_backfill_subject_anchor')
    keys.add(slotKey)
    const blockIdentity = `${normalized.block}\0${normalized.blockHash}\0${normalized.blockAt}`
    if (anchors.has(normalized.anchorAt) && anchors.get(normalized.anchorAt) !== blockIdentity)
      throw new Error('backfill_anchor_block_mismatch')
    anchors.set(normalized.anchorAt, blockIdentity)
    series.get(key).push(normalized)
  }
  let minAnchorMs = Infinity
  let maxAnchorMs = -Infinity
  for (const anchorAt of anchors.keys()) {
    const ms = Date.parse(anchorAt)
    minAnchorMs = Math.min(minAnchorMs, ms)
    maxAnchorMs = Math.max(maxAnchorMs, ms)
  }
  const expectedHourlyAnchorCount = anchors.size ? (maxAnchorMs - minAnchorMs) / HOUR + 1 : 0
  if (!Number.isSafeInteger(expectedHourlyAnchorCount))
    throw new Error('invalid_backfill_anchor_span')
  const subjects = manifest.subjects.map((subject) => {
    const key = `${subject.route_key}\0${subject.destination}`
    const points = series.get(key).sort((a, b) => a.anchorMs - b.anchorMs)
    const byAnchor = new Map(points.map((point) => [point.anchorMs, point]))
    const observed = points.filter((point) => point.state === 'observed')
    if (
      new Set(observed.map((point) => point.assetDecimals)).size > 1 ||
      new Set(observed.map((point) => point.shareDecimals)).size > 1
    )
      throw new Error('backfill_subject_decimals_changed')
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      sourceKind: subject.source_kind,
      assetDecimals: observed[0]?.assetDecimals ?? null,
      shareDecimals: observed[0]?.shareDecimals ?? null,
      archiveAnchors: points.length,
      missingSubjectAnchors: expectedHourlyAnchorCount - points.length,
      observedAnchors: observed.length,
      firstAnchorAt: points[0]?.anchorAt ?? null,
      lastAnchorAt: points.at(-1)?.anchorAt ?? null,
      horizons: HORIZONS.map((horizon) =>
        studyHorizon(points, byAnchor, maxAnchorMs, horizon, includePairs),
      ),
    }
  })
  return {
    kind: 'historical_reconstructed_aggregate_cash_study',
    captureKind: 'backfilled',
    prospectiveValidated: false,
    holderExecutableExit: false,
    subjectManifestSha256: manifest.sha256,
    rowCount: rows.length,
    archiveAnchorCount: anchors.size,
    expectedHourlyAnchorCount,
    whollyMissingArchiveAnchors: expectedHourlyAnchorCount - anchors.size,
    missingSubjectAnchorRows: expectedHourlyAnchorCount * manifest.subjects.length - rows.length,
    subjectCount: subjects.length,
    subjects,
  }
}

/** Read-only, bounded corpus query. The explicit ceiling rejects silent truncation. */
export async function readRows(sql) {
  const rows = await sql`SELECT anchor_at, route_key, subject_kind, venue_kind,
      destination, capture_kind, chain_id, block, block_hash, block_at,
      asset, share_decimals, asset_decimals, cash_raw, state, reason,
      cohort_id, subject_manifest_sha256, seed_source_sha256, seed_sha256,
      board_sha256, displayed_routes_sha256, payload_bytes
    FROM carry_cash_backfill WHERE capture_kind = 'backfilled'
    ORDER BY anchor_at, route_key, destination LIMIT 100001`
  if (rows.length > 100000) throw new Error('backfill_study_row_limit')
  return rows
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  const manifest = await buildSubjectManifest()
  const result = study(await readRows(neon(url)), manifest)
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry historical cash study failed closed.\n')
    process.exitCode = 1
  })
}
