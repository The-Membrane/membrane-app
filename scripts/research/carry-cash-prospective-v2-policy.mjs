// Frozen, two-subject H24 aggregate cash policy. Development histories set
// parameters once; they never contribute a prospective validation outcome.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { inspectArtifact } from './local-artifacts.mjs'
import {
  manifestFromConfig,
  readHistoricalThreeVenueInventory,
} from '../lib/historicalThreeVenueInventory.mjs'

export const HOUR_MS = 3_600_000
export const MAX_RAW = (1n << 256n) - 1n
export const CASH_V2_POLICY = Object.freeze({
  study: 'carry-cash-prospective-h24-v2',
  claimClass: 'aggregate_cash_proxy_only',
  horizonHours: 24,
  targetWindowHours: 1,
  targetSelectionRule: 'nearest_to_h24_then_earliest_block_time_then_sequence',
  receiptGraceHours: 2,
  scheduleHours: 1,
  onTimeTickMinutes: 30,
  maximumSourceAgeHours: 2,
  sourceAvailabilityMinimumPercent: 80,
  scheduleCurrentWithinHours: 2,
  minimumIndependentObserved: 20,
  minimumDevelopmentPairs: 60,
  minimumPercent: 80,
  pointRule: 'current_cash_plus_development_lower_median_raw_delta',
  bandRule: 'current_cash_plus_development_nearest_rank_p10_p90_raw_delta',
  conversionRule: 'decimal_string_to_18_decimals_round_half_up',
  noRefit: true,
  holderExecutableExit: false,
  subjects: Object.freeze([
    Object.freeze({
      id: 'aave_usde',
      cohort: 'supplemental',
      routeKey: 'USDe → supply on Aave V3',
      destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
      asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      decimals: 18,
    }),
    Object.freeze({
      id: 'sgho',
      cohort: 'frozen',
      routeKey: 'GHO → sGho [GHO]',
      destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      decimals: 18,
    }),
  ]),
})

export const POLICY_SHA256 = sha256(JSON.stringify(CASH_V2_POLICY))
const AAVE_SHA = '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681'
const SGHO_PREFIX_LAST_SHA = '1d47e7d1d39d970457b0b6ff13df932b76a73fed626a2489453cd73786bea509'
const RAW = /^(0|[1-9][0-9]*)$/

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw Error('cash_v2_time_invalid')
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value)
    throw Error('cash_v2_time_invalid')
  return ms
}

export function cashRaw(value) {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78 || BigInt(value) > MAX_RAW)
    throw Error('cash_v2_raw_invalid')
  return BigInt(value)
}

export function clampRaw(value) {
  return value < 0n ? 0n : value > MAX_RAW ? MAX_RAW : value
}

/** Convert the saved JSON Number's shortest decimal representation, never a float multiply. */
export function decimalCashToRaw(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw Error('cash_v2_development_number_invalid')
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i)
  if (!match) throw Error('cash_v2_development_number_invalid')
  const digits = `${match[1]}${match[2] ?? ''}`
  const shift = 18 + Number(match[3] ?? 0) - (match[2]?.length ?? 0)
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100)
    throw Error('cash_v2_development_number_invalid')
  const n = BigInt(digits)
  const result =
    shift >= 0
      ? n * 10n ** BigInt(shift)
      : (n + 5n * 10n ** BigInt(-shift - 1)) / 10n ** BigInt(-shift)
  if (result > MAX_RAW) throw Error('cash_v2_development_number_invalid')
  return result.toString()
}

export function disjointH24Deltas(points) {
  if (!Array.isArray(points) || !points.length) throw Error('cash_v2_development_empty')
  const rows = points.map((row) => ({
    at: canonicalUtc(row.at),
    cash: cashRaw(row.cashRaw),
    atUtc: row.at,
  }))
  for (let index = 1; index < rows.length; index++)
    if (rows[index].at <= rows[index - 1].at) throw Error('cash_v2_development_order')
  const pairs = []
  const horizonMs = CASH_V2_POLICY.horizonHours * HOUR_MS
  const windowMs = CASH_V2_POLICY.targetWindowHours * HOUR_MS
  for (let source = 0; source < rows.length; ) {
    let best = -1
    let distance = Infinity
    for (let target = source + 1; target < rows.length; target++) {
      const delta = rows[target].at - rows[source].at
      if (delta > horizonMs + windowMs) break
      if (delta >= horizonMs - windowMs && Math.abs(delta - horizonMs) < distance) {
        best = target
        distance = Math.abs(delta - horizonMs)
      }
    }
    if (best < 0) {
      source++
      continue
    }
    pairs.push({
      sourceAtUtc: rows[source].atUtc,
      targetAtUtc: rows[best].atUtc,
      delta: rows[best].cash - rows[source].cash,
    })
    source = best + 1
  }
  if (pairs.length < CASH_V2_POLICY.minimumDevelopmentPairs)
    throw Error('cash_v2_development_pair_floor')
  return pairs
}

export function freezeCashV2Parameters(points) {
  const pairs = disjointH24Deltas(points)
  const sorted = pairs.map((row) => row.delta).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const median = sorted[Math.floor((sorted.length - 1) / 2)]
  const rank = (percent) => sorted[Math.max(0, Math.ceil((percent * sorted.length) / 100) - 1)]
  return {
    pairCount: pairs.length,
    firstPairSourceAtUtc: pairs[0].sourceAtUtc,
    lastPairTargetAtUtc: pairs.at(-1).targetAtUtc,
    medianDeltaRaw: median.toString(),
    p10DeltaRaw: rank(10).toString(),
    p90DeltaRaw: rank(90).toString(),
  }
}

export function projectCashV2(sourceCashRaw, parameters) {
  const source = cashRaw(sourceCashRaw)
  const delta = BigInt(parameters.medianDeltaRaw)
  const lowDelta = BigInt(parameters.p10DeltaRaw)
  const highDelta = BigInt(parameters.p90DeltaRaw)
  if (lowDelta > highDelta) throw Error('cash_v2_parameter_order')
  return {
    pointRaw: clampRaw(source + delta).toString(),
    lowRaw: clampRaw(source + lowDelta).toString(),
    highRaw: clampRaw(source + highDelta).toString(),
    persistenceRaw: source.toString(),
  }
}

export function readPinnedDevelopmentSources({
  artifactRoot = resolve('data/research/venue-signals'),
  inventoryRoot,
} = {}) {
  const catalog = JSON.parse(readFileSync(resolve(artifactRoot, 'manifest.json'), 'utf8'))
  const listed = catalog?.artifacts?.['aave-usde-cash-full-grid-400d']
  if (listed?.sha256 !== AAVE_SHA || listed.file !== `${AAVE_SHA}.json` || listed.count !== 3137)
    throw Error('cash_v2_aave_catalog_identity')
  const bytes = readFileSync(resolve(artifactRoot, listed.file))
  if (sha256(bytes) !== AAVE_SHA || bytes.length !== listed.bytes)
    throw Error('cash_v2_aave_physical_digest')
  const inspected = inspectArtifact(bytes)
  if (inspected.kind !== 'aave-usde-full-cash-grid' || inspected.count !== 3137)
    throw Error('cash_v2_aave_completeness')
  const aave = JSON.parse(bytes.toString('utf8'))
  if (
    aave.underlying?.toLowerCase() !== CASH_V2_POLICY.subjects[0].asset ||
    aave.aToken?.toLowerCase() !== CASH_V2_POLICY.subjects[0].destination
  )
    throw Error('cash_v2_aave_subject_identity')
  const aavePoints = aave.rows.map((row) => ({
    at: new Date(row.at * 1000).toISOString(),
    cashRaw: decimalCashToRaw(row.cash),
  }))
  const inventory = readHistoricalThreeVenueInventory(inventoryRoot, manifestFromConfig())
  if (
    inventory.count < 1183 ||
    inventory.rows[0]?.sequence !== 1 ||
    inventory.rows[1182]?.sha256 !== SGHO_PREFIX_LAST_SHA
  )
    throw Error('cash_v2_sgho_prefix_identity')
  const prefix = inventory.rows.slice(0, 1183)
  const sghoPoints = prefix.toReversed().map((row) => ({
    at: new Date(row.source.timestamp * 1000).toISOString(),
    cashRaw: row.inventory.sGHO.raw,
  }))
  const sources = [
    {
      subjectId: 'aave_usde',
      kind: 'pinned_aave_full_grid',
      physicalSha256: AAVE_SHA,
      contentSha256: sha256(JSON.stringify(aavePoints)),
      count: aavePoints.length,
      throughUtc: aavePoints.at(-1).at,
      points: aavePoints,
    },
    {
      subjectId: 'sgho',
      kind: 'verified_sgho_prefix',
      physicalSha256: sha256(prefix.map((row) => `${JSON.stringify(row)}\n`).join('')),
      contentSha256: sha256(JSON.stringify(sghoPoints)),
      count: sghoPoints.length,
      throughUtc: sghoPoints.at(-1).at,
      points: sghoPoints,
    },
  ]
  return sources.map(({ points, ...source }) => ({
    ...source,
    parameters: freezeCashV2Parameters(points),
  }))
}
