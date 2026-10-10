import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import {
  RECORDED_COST_LEVELS_PCT,
  selectRecentCompleteCurvePass,
  type CurvePoint,
  type StoredCurvePassRow,
} from '@/lib/venueCapacity/capacityCurve'
import type {
  CapacitySnapshot,
  MeasuredCapacityPersistenceResult,
} from '@/lib/venueForecast/sampledCapacity'
import { depthRouteIdentity } from '@/scripts/lib/depth-identity.mjs'
import {
  LOCAL_VENUE_CURVE_ROOT,
  readLocalVenueCurvePasses,
} from '@/scripts/lib/localVenueCurveStore.mjs'
import {
  readLocalVenueSnapshotAttempt,
  LOCAL_VENUE_SNAPSHOT_ROOT,
  verifyLocalVenueSnapshots,
} from '@/scripts/lib/localVenueSnapshotStore.mjs'

type LocalVenueSnapshotAttempt = {
  status: 'capture_in_progress' | 'capture_failed'
  attemptedAtUtc: string
  token: string
}
import { localVenueFlowStore } from '@/scripts/lib/localVenueFlowStore.mjs'
import {
  requiredStreamIdentities,
  streamsFor,
  validateReceiptChain,
  verifyReceiptEventSet,
} from '@/scripts/record-venue-flows.mjs'

type ConfiguredVenue = {
  name: string
  kind: string
  address: string
  underlying?: string
  decimals?: number
  enabled: boolean
  depthMarkets?: Array<{
    name: string
    enabled?: boolean
    address?: string
    kind?: string
    exitFrom?: string
    token0?: string
    token1?: string
    buffer?: string
    bufferToken?: string
    wrapper?: string
  }>
}

export type ForecastRoute = {
  metric: 'instant_usd' | 'depth_usd'
  kind: 'aave_reserve_cash' | 'vault_cash' | 'secondary_swap_in_inventory'
  label: string
  exitFrom: string
  /** The measured route is a proxy for exit liquidity, not an executable quote. */
  limit: 'reserve_cash' | 'vault_cash' | 'raw_swap_in_inventory'
}

export type ForecastObservedSample = {
  sourceId: string
  source: 'observed'
  block: number
  observedAt: string
  /** DB insertion time. A model may conservatively use this as the first usable time. */
  firstAvailableAt: string | null
  /** Complete means this measured proxy has a sealed finalized source and full route read. */
  coverage: 'complete' | 'partial' | 'unverified'
  capacityUsd: number | null
  cooldownSeconds: number | null
  tvlUsd: number | null
}

export type VenueForecastEvidence = {
  venue: string
  chainId: 1
  storage: 'database' | 'local_mac_recorder'
  route: ForecastRoute
  latest: ForecastObservedSample | null
  /** Newest first; null-capacity rows remain so a failed latest read is visible. */
  samples: ForecastObservedSample[]
  coverage: {
    observedRows: number
    observedSpan: { start: string | null; end: string | null }
    returnedRows: number
    truncated: boolean
    latestAttempt: LocalVenueSnapshotAttempt | null
    flowStatus: 'uncertified' | 'sealed_partial' | 'sealed_24h' | 'invalid'
    flowReason: string
    sealedRanges: number
    sealedBlocks: { start: string | null; end: string | null }
    sealedEvents: number
    maxFlowWindowHours: 24
    maxGrossOutflowUsd: number | null
    maxNetOutflowUsd: number | null
    exitDurationDistribution: null
  }
}

/** Historical measurement source shared with Risk Frontier; never a forecast. */
export type VenueMeasuredPersistenceEvidence = {
  venue: string
  chainId: 1
  storage: 'database' | 'local_mac_recorder'
  routeKey: string
  source: 'recorded_cash' | 'recorded_cost_curve'
  costCapPct: number | null
  costCapSelection: 'not_applicable' | 'default_recorded_level' | 'requested_recorded_level'
  cadenceHours: number
  samples: CapacitySnapshot[]
  coverage: {
    returnedSamples: number
    truncated: boolean
    maxCurvePasses: number | null
    /** Local links only; no independent timestamp, external tamper, or rollback proof. */
    localVerification?: 'from_local_start' | 'bounded_tail_links' | null
    localReadBytes?: number
  }
  unavailableReason:
    | 'cost_cap_not_recorded'
    | 'curve_route_not_configured'
    | 'local_curves_unavailable'
    | 'local_curve_source_invalid'
    | 'curve_source_unavailable'
    | null
}

export type VenueMeasuredPersistenceResult = MeasuredCapacityPersistenceResult & {
  storage?: VenueMeasuredPersistenceEvidence['storage']
  source: VenueMeasuredPersistenceEvidence['source']
  costCapSelection: VenueMeasuredPersistenceEvidence['costCapSelection']
  evidenceCoverage: VenueMeasuredPersistenceEvidence['coverage']
  unavailableReason: VenueMeasuredPersistenceEvidence['unavailableReason']
}

// venue-observations launchd declares 3600s; its tick runs both liquidity and
// depth stages (scripts/venue-observations-tick.py).
export const VENUE_MEASURED_CAPACITY_CADENCE_HOURS = 1
const MAX_MEASURED_CURVE_PASSES = 20

type SnapshotRow = Record<string, unknown>
type FlowRow = Record<string, unknown>

type FlowCoverage = Pick<
  VenueForecastEvidence['coverage'],
  | 'flowStatus'
  | 'flowReason'
  | 'sealedRanges'
  | 'sealedBlocks'
  | 'sealedEvents'
  | 'maxFlowWindowHours'
  | 'maxGrossOutflowUsd'
  | 'maxNetOutflowUsd'
  | 'exitDurationDistribution'
>

type TimedFlow = { at: number; direction: 'in' | 'out'; raw: bigint }
const DAY_MS = 86_400_000

/** Only evaluate windows whose full 24h start is inside the sealed source span. */
export function maxFlowsAfterCoveredDay(events: TimedFlow[], coverageStartMs: number) {
  if (
    !Number.isFinite(coverageStartMs) ||
    events.some((event) => !Number.isFinite(event.at) || event.at < coverageStartMs)
  )
    return null
  const ordered = [...events].sort((a, b) => a.at - b.at)
  if (!ordered.length || ordered.at(-1)!.at < coverageStartMs + DAY_MS) return null
  const endpoints = [coverageStartMs + DAY_MS, ...ordered.map((event) => event.at)]
    .filter((time) => time >= coverageStartMs + DAY_MS)
    .sort((a, b) => a - b)
  let added = 0
  let removed = 0
  let gross = 0n
  let net = 0n
  let maxGross = 0n
  let maxNet = 0n
  for (const end of endpoints) {
    while (added < ordered.length && ordered[added].at <= end) {
      const event = ordered[added++]
      if (event.direction === 'out') {
        gross += event.raw
        net += event.raw
      } else net -= event.raw
    }
    while (removed < added && ordered[removed].at <= end - DAY_MS) {
      const event = ordered[removed++]
      if (event.direction === 'out') {
        gross -= event.raw
        net -= event.raw
      } else net += event.raw
    }
    if (gross > maxGross) maxGross = gross
    if (net > maxNet) maxNet = net
  }
  return { maxGross, maxNet }
}

const unavailableFlow = (status: FlowCoverage['flowStatus'], reason: string): FlowCoverage => ({
  flowStatus: status,
  flowReason: reason,
  sealedRanges: 0,
  sealedBlocks: { start: null, end: null },
  sealedEvents: 0,
  maxFlowWindowHours: 24,
  maxGrossOutflowUsd: null,
  maxNetOutflowUsd: null,
  exitDurationDistribution: null,
})

const iso = (value: unknown): string | null => {
  if (value == null || value === '') return null
  const time = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(time.getTime()) ? time.toISOString() : null
}

const finiteNonnegative = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

const integerNonnegative = (value: unknown): number | null => {
  const number = finiteNonnegative(value)
  return number != null && Number.isSafeInteger(number) ? number : null
}

const config = (): ConfiguredVenue[] => {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as ConfiguredVenue[]).filter((venue) => venue.enabled)
}

export function forecastRoute(venue: ConfiguredVenue): ForecastRoute {
  if (venue.kind === 'erc4626-vault-cash') {
    return {
      metric: 'instant_usd',
      kind: 'vault_cash',
      label: `${venue.name} vault underlying cash`,
      exitFrom: venue.underlying ?? venue.address,
      limit: 'vault_cash',
    }
  }
  if (venue.kind === 'atoken-liquidity') {
    return {
      metric: 'instant_usd',
      kind: 'aave_reserve_cash',
      label: 'Aave USDe reserve cash',
      exitFrom: venue.underlying ?? venue.address,
      limit: 'reserve_cash',
    }
  }
  const markets = venue.depthMarkets?.filter((market) => market.enabled) ?? []
  return {
    metric: 'depth_usd',
    kind: 'secondary_swap_in_inventory',
    label: `Recorded swap-in inventory across ${markets.length} enabled exit market${markets.length === 1 ? '' : 's'}`,
    exitFrom: markets[0]?.exitFrom ?? venue.address,
    limit: 'raw_swap_in_inventory',
  }
}

/** No failed or partial depth read may masquerade as a zero-liquidity sample. */
const sameAddress = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

const UINT256_MAX = (1n << 256n) - 1n
const PSM_MAX_OPEN_FEE = 10n ** 18n

function validPsmBuyGemState(
  market: Record<string, unknown>,
  aggregateDepth: unknown,
  marketCount: number,
) {
  if (
    typeof market.toutRaw !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(market.toutRaw) ||
    market.toutRaw.length > 78
  )
    return false
  const fee = BigInt(market.toutRaw)
  if (market.buyGemState === 'open')
    return (
      fee <= PSM_MAX_OPEN_FEE &&
      typeof market.exitableUsd === 'number' &&
      Number.isFinite(market.exitableUsd) &&
      market.exitableUsd >= 0 &&
      (marketCount !== 1 || aggregateDepth === market.exitableUsd)
    )
  if (market.buyGemState === 'halted')
    return (
      fee === UINT256_MAX && market.exitableUsd === 0 && (marketCount !== 1 || aggregateDepth === 0)
    )
  return false
}

function sameDepthRoute(params: Record<string, unknown>, venue: ConfiguredVenue) {
  const expected = venue.depthMarkets?.filter((market) => market.enabled) ?? []
  const recorded = params.depthMarkets
  if (!Array.isArray(recorded) || recorded.length !== expected.length || expected.length === 0)
    return false
  const byAddress = new Map(
    recorded
      .filter(
        (market): market is Record<string, unknown> =>
          !!market && typeof market === 'object' && !Array.isArray(market),
      )
      .map((market) => [String(market.address).toLowerCase(), market]),
  )
  if (byAddress.size !== expected.length) return false
  return expected.every((market) => {
    const observed = byAddress.get(String(market.address).toLowerCase())
    return (
      observed &&
      observed.kind === market.kind &&
      sameAddress(observed.exitFrom, market.exitFrom) &&
      (market.token0 === undefined || sameAddress(observed.token0, market.token0)) &&
      (market.token1 === undefined || sameAddress(observed.token1, market.token1)) &&
      (market.kind !== 'curve-stableswap' ||
        (observed.coinsIdentity === 'match' &&
          sameAddress(observed.coin0Onchain, market.token0) &&
          sameAddress(observed.coin1Onchain, market.token1))) &&
      (market.kind !== 'psm-buffer' ||
        (sameAddress(market.exitFrom, venue.underlying) &&
          sameAddress(observed.buffer, market.buffer) &&
          sameAddress(observed.bufferToken, market.bufferToken) &&
          sameAddress(observed.wrapper, market.wrapper) &&
          observed.wrapperIdentity === 'match' &&
          sameAddress(observed.wrapperPsmOnchain, market.address) &&
          sameAddress(observed.wrapperPocketOnchain, market.buffer) &&
          sameAddress(observed.wrapperUsdsOnchain, venue.underlying) &&
          validPsmBuyGemState(observed, params.depth_usd, expected.length) &&
          observed.exitIdentity === 'match' &&
          observed.pocketIdentity === 'match' &&
          observed.gemIdentity === 'match' &&
          sameAddress(observed.pocketOnchain, market.buffer) &&
          sameAddress(observed.gemOnchain, market.bufferToken)))
    )
  })
}

export function mapForecastSample(
  row: SnapshotRow,
  route: ForecastRoute,
  venue?: ConfiguredVenue,
): ForecastObservedSample {
  const params =
    row.params && typeof row.params === 'object' && !Array.isArray(row.params)
      ? (row.params as Record<string, unknown>)
      : {}
  const recorderObservedAt = iso(row.observed_at)
  const createdAt = iso(row.created_at)
  const block = integerNonnegative(row.block)
  if (!recorderObservedAt || block == null || typeof row.id !== 'string' || !row.id) {
    throw new Error('Malformed observed venue snapshot provenance')
  }

  let capacityUsd =
    route.metric === 'instant_usd'
      ? finiteNonnegative(row.instant_usd)
      : finiteNonnegative(params.depth_usd)
  if (
    route.kind === 'vault_cash' &&
    (params.underlyingIdentity !== 'match' ||
      params.decimalsIdentity !== 'match' ||
      typeof params.withdrawalsPaused !== 'boolean' ||
      (venue &&
        (params.kind !== 'erc4626-vault-cash' ||
          !sameAddress(params.vault, venue.address) ||
          !sameAddress(params.underlyingOnchain, venue.underlying) ||
          integerNonnegative(params.underlyingDecimalsOnchain) !== venue.decimals)))
  ) {
    capacityUsd = null
  }
  if (
    route.kind === 'aave_reserve_cash' &&
    venue &&
    (params.kind !== 'atoken-liquidity' ||
      params.underlyingIdentity !== 'match' ||
      params.decimalsIdentity !== 'match' ||
      !sameAddress(params.aToken, venue.address) ||
      !sameAddress(params.underlyingOnchain, venue.underlying) ||
      integerNonnegative(params.underlyingDecimalsOnchain) !== venue.decimals ||
      (params.reads as Record<string, unknown> | undefined)?.underlyingBalance !== true)
  )
    capacityUsd = null
  if (route.metric === 'depth_usd') {
    // Forecast training requires an affirmative full-market read. The legacy
    // absence of this flag cannot certify that a multi-market sum was complete.
    if (params.depth_complete !== true || (venue && !sameDepthRoute(params, venue)))
      capacityUsd = null
    // Before the complete-read guard went live, failed pool reads were stored as
    // zero. Those rows cannot train a collapse or a forecast target.
    if (capacityUsd === 0 && recorderObservedAt < '2026-09-25T04:29:56.000Z') capacityUsd = null
  }

  const assets = finiteNonnegative(params.totalAssets)
  const firstAvailableAt = createdAt && createdAt >= recorderObservedAt ? createdAt : null
  const sourceBlock = integerNonnegative(params.read_block_number)
  const sourceTime = integerNonnegative(params.read_block_time)
  const sourceSealed =
    params.read_block_finalized === true &&
    params.read_block_pinned === true &&
    typeof params.read_block_hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(params.read_block_hash) &&
    sourceBlock === block &&
    sourceTime != null &&
    firstAvailableAt != null &&
    // The recorder allows up to 120 seconds of future clock skew at the source.
    sourceTime * 1000 <= Date.parse(recorderObservedAt) + 120_000 &&
    (firstAvailableAt === null || sourceTime * 1000 <= Date.parse(firstAvailableAt))
  const observedAt = sourceSealed ? new Date(sourceTime * 1000).toISOString() : recorderObservedAt
  return {
    sourceId: row.id,
    source: 'observed',
    block,
    observedAt,
    firstAvailableAt,
    coverage: !sourceSealed ? 'unverified' : capacityUsd == null ? 'partial' : 'complete',
    capacityUsd,
    cooldownSeconds: integerNonnegative(params.cooldownDuration),
    // ERC4626 totalAssets is a raw 18-decimal token amount in the recorder.
    // No inferred USD stock for Aave, and no price feed: stable=$1 assumption.
    tvlUsd: route.kind !== 'aave_reserve_cash' && assets != null ? assets / 1e18 : null,
  }
}

/** Verify every sealed range against its exact stored event set before any max. */
async function certifiedFlowFromReceipts(
  venue: ConfiguredVenue,
  receipts: FlowRow[],
  readRows: (from: string, to: string) => Promise<FlowRow[]>,
  emptyReason: string,
  coverageStartMs: number | null = null,
): Promise<FlowCoverage> {
  if (!receipts.length) {
    return unavailableFlow('uncertified', emptyReason)
  }

  const coverage = unavailableFlow('sealed_partial', 'sealed_span_shorter_than_24h')
  coverage.sealedRanges = receipts.length
  coverage.sealedBlocks = {
    start: String(receipts[0].from_block),
    end: String(receipts[receipts.length - 1].to_block),
  }
  const streams = streamsFor(venue)
  if (!streams)
    return { ...coverage, flowStatus: 'invalid', flowReason: 'unsupported_flow_streams' }
  const identities = requiredStreamIdentities(streams)

  try {
    validateReceiptChain(receipts, identities)
    const events: TimedFlow[] = []
    for (const receipt of receipts) {
      const rows = await readRows(String(receipt.from_block), String(receipt.to_block))
      verifyReceiptEventSet(receipt, rows)
      for (const row of rows) {
        const at = Date.parse(String(row.block_time))
        const raw = BigInt(String(row.assets_raw))
        if (
          !Number.isFinite(at) ||
          raw < 0n ||
          (row.direction !== 'in' && row.direction !== 'out')
        ) {
          throw new Error('flow_invalid_stored_row')
        }
        events.push({ at, direction: row.direction, raw })
      }
    }
    coverage.sealedEvents = events.length
    if (coverageStartMs === null) {
      coverage.flowReason = 'source_start_time_missing'
      return coverage
    }
    const maximum = maxFlowsAfterCoveredDay(events, coverageStartMs)
    if (!maximum) return coverage
    const { maxGross, maxNet } = maximum
    const maxGrossUsd = Number(maxGross) / 1e18
    const maxNetUsd = Number(maxNet) / 1e18
    if (!Number.isFinite(maxGrossUsd) || !Number.isFinite(maxNetUsd)) {
      throw new Error('flow_max_unrepresentable')
    }
    return {
      ...coverage,
      flowStatus: 'sealed_24h',
      flowReason: 'verified_contiguous_receipts_and_source_start',
      maxGrossOutflowUsd: maxGrossUsd,
      maxNetOutflowUsd: maxNetUsd,
    }
  } catch {
    return {
      ...coverage,
      flowStatus: 'invalid',
      flowReason: 'flow_receipt_or_event_set_verification_failed',
      maxGrossOutflowUsd: null,
      maxNetOutflowUsd: null,
    }
  }
}

async function readCertifiedFlow(venue: ConfiguredVenue): Promise<FlowCoverage> {
  let receipts: FlowRow[]
  try {
    const result = await db.execute(sql`
      SELECT venue, from_block, to_block, from_hash, to_hash,
             finalized_head_block, finalized_head_hash, streamset_hash,
             streams, event_set_hash, receipt_hash
      FROM venue_flow_range_receipts WHERE venue = ${venue.name}
      ORDER BY from_block ASC`)
    receipts = result.rows as FlowRow[]
  } catch (error) {
    if (/relation .*venue_flow_range_receipts.* does not exist/i.test(String(error))) {
      return unavailableFlow('uncertified', 'flow_receipt_table_unavailable')
    }
    throw error
  }
  return certifiedFlowFromReceipts(
    venue,
    receipts,
    async (from, to) => {
      const flowResult = await db.execute(sql`
        SELECT block,
               to_char(block_time AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS block_time,
               direction, assets_raw, tx_hash, log_index
        FROM venue_flows
        WHERE venue = ${venue.name}
          AND block BETWEEN ${from} AND ${to}
        ORDER BY tx_hash, log_index`)
      return flowResult.rows as FlowRow[]
    },
    'legacy_flow_rows_lack_complete_range_receipts',
  )
}

function readLocalSamples(
  venue: ConfiguredVenue,
  route: ForecastRoute,
  limit: number,
  out: string,
) {
  const { count, last } = verifyLocalVenueSnapshots(venue.name, out)
  if (!count || !last) throw new Error('local_forecast_snapshot_unavailable')
  const start = Math.max(1, count - limit + 1)
  const records: Array<Record<string, unknown>> = []
  const first = JSON.parse(
    readFileSync(join(out, venue.name, '000000000001.json'), 'utf8'),
  ) as Record<string, unknown>
  if (first.chain !== 'ethereum' || first.venue !== venue.name)
    throw new Error('local_forecast_source_identity_mismatch')
  const firstSource = first.source as Record<string, unknown>
  for (let sequence = start; sequence <= count; sequence++) {
    const name = `${String(sequence).padStart(12, '0')}.json`
    records.push(
      JSON.parse(readFileSync(join(out, venue.name, name), 'utf8')) as Record<string, unknown>,
    )
  }
  // Verification is repeated after the read so a concurrent local write or
  // replacement cannot produce a mixed, unverified history in one response.
  const after = verifyLocalVenueSnapshots(venue.name, out)
  if (after.count !== count || after.last?.sha256 !== last.sha256)
    throw new Error('local_forecast_snapshot_changed_during_read')
  const samples = records.reverse().map((record) => {
    if (record.chain !== 'ethereum' || record.venue !== venue.name)
      throw new Error('local_forecast_source_identity_mismatch')
    const source = record.source as Record<string, unknown>
    const measurement = record.measurement as Record<string, unknown>
    return mapForecastSample(
      {
        id: `local:${record.sha256}`,
        block: source.block,
        observed_at: record.observedAtUtc,
        created_at: record.firstLocalReceiptAtUtc,
        instant_usd: measurement.instantUsd,
        params: measurement.params,
      },
      route,
      venue,
    )
  })
  const attempt = readLocalVenueSnapshotAttempt(
    venue.name,
    {
      venue: venue.name,
      chain: 'ethereum',
      kind: venue.kind,
      address: venue.address,
      underlying: venue.underlying,
      decimals: venue.decimals,
    },
    out,
  ) as LocalVenueSnapshotAttempt | null
  const attemptResolvedBySealedSuccess = attempt && last?.localAttemptToken === attempt.token
  const latestAttempt = attempt && !attemptResolvedBySealedSuccess ? attempt : null
  return {
    count,
    firstObservedAt: iso(first.observedAtUtc),
    firstSourceBlock: integerNonnegative(firstSource.block),
    firstSourceTime: integerNonnegative(firstSource.timestamp),
    samples,
    latestAttempt,
  }
}

async function readLocalVenueForecastEvidence(
  venue: ConfiguredVenue,
  route: ForecastRoute,
  limit: number,
  localSnapshotRoot: string,
  localFlowRoot?: string,
): Promise<VenueForecastEvidence> {
  const { count, firstObservedAt, firstSourceBlock, firstSourceTime, samples, latestAttempt } =
    readLocalSamples(venue, route, limit, localSnapshotRoot)
  const store = localVenueFlowStore(localFlowRoot ? { out: localFlowRoot } : undefined)
  const receipts = (await store.readReceipts(venue.name)) as FlowRow[]
  const coverageStartMs =
    receipts.length &&
    firstSourceBlock !== null &&
    firstSourceTime !== null &&
    BigInt(String(receipts[0].from_block)) === BigInt(firstSourceBlock) + 1n
      ? firstSourceTime * 1000
      : null
  const flow = await certifiedFlowFromReceipts(
    venue,
    receipts,
    async (from, to) =>
      (await store.readFlowsInRange(venue.name, BigInt(from), BigInt(to))) as FlowRow[],
    'local_flow_no_sealed_ranges',
    coverageStartMs,
  )
  return {
    venue: venue.name,
    chainId: 1,
    storage: 'local_mac_recorder',
    route,
    latest: latestAttempt ? null : (samples[0] ?? null),
    samples,
    coverage: {
      observedRows: count,
      observedSpan: { start: firstObservedAt, end: samples[0]?.observedAt ?? null },
      returnedRows: samples.length,
      truncated: count > samples.length,
      latestAttempt,
      ...flow,
    },
  }
}

/**
 * Recorded Ethereum-mainnet evidence for one enabled strategy venue. This is a
 * read-only, point-in-time adapter. It never turns legacy venue_flows rows or
 * a short local flow interval into a 24h maximum or exit-duration distribution.
 */
export async function readVenueForecastEvidence(
  name: string,
  options: {
    limit?: number
    allowLocalFallback?: boolean
    /** Test injection; API callers use the sealed recorder defaults. */
    localSnapshotRoot?: string
    localFlowRoot?: string
  } = {},
): Promise<VenueForecastEvidence> {
  const venue = config().find((entry) => entry.name === name)
  if (!venue) throw new Error(`Unknown enabled venue: ${name}`)
  const limit = options.limit ?? 10_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Forecast snapshot limit must be an integer from 1 to 10000')
  }

  const route = forecastRoute(venue)
  const localSnapshotRoot = options.localSnapshotRoot ?? LOCAL_VENUE_SNAPSHOT_ROOT
  const localFallback = () => {
    if (!options.allowLocalFallback) throw new Error('local_forecast_fallback_not_allowed')
    return readLocalVenueForecastEvidence(
      venue,
      route,
      limit,
      localSnapshotRoot,
      options.localFlowRoot,
    )
  }
  // Loopback callers are authorized to use the Mac recorder. Prefer that
  // sealed point-in-time history when present; a valid but stale database row
  // must not mask a fresher local capture. Verification errors are terminal:
  // a corrupt local chain is not equivalent to an absent local store.
  const localSnapshotState = options.allowLocalFallback
    ? verifyLocalVenueSnapshots(name, localSnapshotRoot)
    : null
  const localAttempt = options.allowLocalFallback
    ? readLocalVenueSnapshotAttempt(
        name,
        {
          venue: venue.name,
          chain: 'ethereum',
          kind: venue.kind,
          address: venue.address,
          underlying: venue.underlying,
          decimals: venue.decimals,
        },
        localSnapshotRoot,
      )
    : null
  const localSnapshotCount = localSnapshotState?.count ?? 0
  if (localSnapshotCount > 0) return localFallback()
  if (localAttempt) throw new Error('local_forecast_capture_without_history')
  // Fetch latest separately from bounded history: even a malformed/failed
  // latest observation must stop callers from silently using an older value.
  let latestResult: Awaited<ReturnType<typeof db.execute>>
  let historyResult: Awaited<ReturnType<typeof db.execute>>
  let coverageResult: Awaited<ReturnType<typeof db.execute>>
  try {
    latestResult = await db.execute(sql`
    SELECT id, block, observed_at, created_at, instant_usd, params
    FROM venue_snapshots
    WHERE venue = ${name} AND chain = 'ethereum' AND source = 'observed'
    ORDER BY observed_at DESC, id DESC LIMIT 1`)
    historyResult = await db.execute(sql`
    SELECT id, block, observed_at, created_at, instant_usd, params
    FROM venue_snapshots
    WHERE venue = ${name} AND chain = 'ethereum' AND source = 'observed'
    ORDER BY observed_at DESC, id DESC LIMIT ${limit}`)
    coverageResult = await db.execute(sql`
    SELECT COUNT(*) AS rows, MIN(observed_at) AS span_start, MAX(observed_at) AS span_end
    FROM venue_snapshots
    WHERE venue = ${name} AND chain = 'ethereum' AND source = 'observed'`)
  } catch (error) {
    if (!options.allowLocalFallback || localSnapshotCount === 0) throw error
    return localFallback()
  }
  const latestRow = latestResult.rows[0] as SnapshotRow | undefined
  const samples = (historyResult.rows as SnapshotRow[]).map((row) =>
    mapForecastSample(row, route, venue),
  )
  const latest = latestRow ? mapForecastSample(latestRow, route, venue) : null
  const countRow = (coverageResult.rows[0] ?? {}) as SnapshotRow
  const observedRows = integerNonnegative(countRow.rows) ?? 0
  let flow: FlowCoverage
  try {
    flow = await readCertifiedFlow(venue)
  } catch (error) {
    if (!options.allowLocalFallback || localSnapshotCount === 0) throw error
    return localFallback()
  }
  return {
    venue: name,
    chainId: 1,
    storage: 'database',
    route,
    latest,
    samples,
    coverage: {
      observedRows,
      observedSpan: { start: iso(countRow.span_start), end: iso(countRow.span_end) },
      returnedRows: samples.length,
      truncated: observedRows > samples.length,
      latestAttempt: null,
      ...flow,
    },
  }
}

/**
 * Read exact recorded cost levels. The bounded query and whole-pass validator
 * match capacity-curve.ts; inventory and interpolation never enter this series.
 */
export async function readVenueMeasuredPersistenceEvidence(
  name: string,
  options: {
    costCapPct?: number
    curveLimit?: number
    allowLocalFallback?: boolean
    /** Test/host root only; does not grant local-read authorization. */
    localCurveRoot?: string
    /** Reuse the API's already verified cash history without another read. */
    forecastEvidence?: VenueForecastEvidence
  } = {},
): Promise<VenueMeasuredPersistenceEvidence> {
  const venue = config().find((entry) => entry.name === name)
  if (!venue) throw new Error(`Unknown enabled venue: ${name}`)
  const route = forecastRoute(venue)
  const cash = route.metric === 'instant_usd'
  const markets = venue.depthMarkets?.filter((market) => market.enabled) ?? []
  const identities = Object.fromEntries(
    markets.map((market) => [market.name, depthRouteIdentity(venue, market)]),
  )
  const costCapPct = cash ? null : (options.costCapPct ?? 1)
  const routeKey = cash
    ? `1:${name}:instant_usd:${route.exitFrom.toLowerCase()}`
    : `1:${name}:recorded_cost_curve:${markets
        .map((market) => identities[market.name])
        .sort()
        .join(':')}`
  const result: VenueMeasuredPersistenceEvidence = {
    venue: name,
    chainId: 1,
    storage: options.forecastEvidence?.storage ?? 'database',
    routeKey,
    source: cash ? 'recorded_cash' : 'recorded_cost_curve',
    costCapPct,
    costCapSelection: cash
      ? 'not_applicable'
      : options.costCapPct === undefined
        ? 'default_recorded_level'
        : 'requested_recorded_level',
    cadenceHours: VENUE_MEASURED_CAPACITY_CADENCE_HOURS,
    samples: [],
    coverage: {
      returnedSamples: 0,
      truncated: false,
      maxCurvePasses: cash ? null : MAX_MEASURED_CURVE_PASSES,
    },
    unavailableReason: null,
  }
  if (cash) {
    const evidence =
      options.forecastEvidence ??
      (await readVenueForecastEvidence(name, { allowLocalFallback: options.allowLocalFallback }))
    if (
      evidence.venue !== name ||
      evidence.chainId !== 1 ||
      evidence.route.metric !== 'instant_usd' ||
      evidence.route.exitFrom.toLowerCase() !== route.exitFrom.toLowerCase()
    )
      throw new Error('measured_persistence_cash_identity_mismatch')
    const samples = evidence.latest
      ? [
          evidence.latest,
          ...evidence.samples.filter((row) => row.sourceId !== evidence.latest!.sourceId),
        ]
      : evidence.samples
    return {
      ...result,
      storage: evidence.storage,
      samples,
      coverage: {
        ...result.coverage,
        returnedSamples: samples.length,
        truncated: evidence.coverage.truncated,
      },
    }
  }
  if (!RECORDED_COST_LEVELS_PCT.some((level) => level === costCapPct))
    return { ...result, unavailableReason: 'cost_cap_not_recorded' }
  if (!markets.length) return { ...result, unavailableReason: 'curve_route_not_configured' }
  const limit = options.curveLimit ?? MAX_MEASURED_CURVE_PASSES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEASURED_CURVE_PASSES)
    throw new Error('Measured curve pass limit must be an integer from 1 to 20')
  const maxRows = limit * (markets.length + 1)
  let rows: StoredCurvePassRow[] | undefined
  const localIds = new Map<string, string>()
  const readLocal = (): StoredCurvePassRow[] | null => {
    if (!options.allowLocalFallback) {
      result.unavailableReason = 'local_curves_unavailable'
      return null
    }
    result.storage = 'local_mac_recorder'
    try {
      const local = readLocalVenueCurvePasses(name, {
        root: options.localCurveRoot ?? LOCAL_VENUE_CURVE_ROOT,
        limit,
      })
      result.coverage.truncated = local.truncated
      result.coverage.localReadBytes = local.bytesRead
      result.coverage.localVerification = local.verification ?? null
      if (!local.records.length) {
        result.unavailableReason = 'local_curves_unavailable'
        return null
      }
      return local.records.flatMap((record) => {
        localIds.set(record.pass.block, `local_venue_curve_pass_v1:${record.sha256}`)
        return record.pass.markets.map((market) => ({
          market: market.market,
          block: record.pass.block,
          block_row_count: record.pass.markets.length,
          observed_at: record.firstLocalReceiptAtUtc,
          points: market.points,
          meta: {
            configIdentity: market.configIdentity,
            sourceBlockTime: record.pass.sourceBlockTime,
            sourceBlockHash: record.pass.sourceBlockHash,
          },
        }))
      })
    } catch {
      result.unavailableReason = 'local_curve_source_invalid'
      return null
    }
  }
  if (options.allowLocalFallback || options.forecastEvidence?.storage === 'local_mac_recorder') {
    const local = readLocal()
    if (local) rows = local
    else if (
      result.unavailableReason === 'local_curve_source_invalid' ||
      options.forecastEvidence?.storage === 'local_mac_recorder'
    )
      return result
    else {
      // An absent local mirror may use DB history. Never merge the two sources.
      result.storage = 'database'
      result.unavailableReason = null
      result.coverage.truncated = false
      delete result.coverage.localReadBytes
      delete result.coverage.localVerification
    }
  }
  if (rows === undefined) {
    try {
      const response = await db.execute(sql`
      WITH recent_blocks AS (
        SELECT DISTINCT block FROM venue_depth_curves
        WHERE venue = ${name}
        ORDER BY block DESC LIMIT ${limit}
      ), candidate_rows AS (
        SELECT c.market, c.block, c.observed_at, c.points, c.meta,
          COUNT(*) OVER (PARTITION BY c.block) AS block_row_count
        FROM venue_depth_curves c
        JOIN recent_blocks b ON c.block = b.block
        WHERE c.venue = ${name}
      )
      SELECT market, block, observed_at, points, meta, block_row_count
      FROM candidate_rows ORDER BY block DESC, market LIMIT ${maxRows}`)
      rows = response.rows as StoredCurvePassRow[]
    } catch {
      if (!options.allowLocalFallback)
        return { ...result, unavailableReason: 'curve_source_unavailable' }
      return {
        ...result,
        storage: 'local_mac_recorder',
        unavailableReason: 'local_curves_unavailable',
      }
    }
  }
  const groups = new Map<string, StoredCurvePassRow[]>()
  for (const row of rows) {
    const block = String(row.block)
    const group = groups.get(block) ?? []
    group.push(row)
    groups.set(block, group)
  }
  result.samples = [...groups.values()].map((group): CapacitySnapshot => {
    const selected = selectRecentCompleteCurvePass(
      group,
      markets.map((market) => market.name),
      identities,
    )
    const receiptTimes = group
      .map((row) => iso(row.observed_at))
      .filter((time): time is string => time !== null)
    const firstAvailableAt =
      receiptTimes.length === group.length ? receiptTimes.sort().at(-1)! : null
    const meta = group[0]?.meta as Record<string, unknown> | undefined
    const sourceTime = iso(meta?.sourceBlockTime)
    const observedAt = selected && sourceTime ? sourceTime : (firstAvailableAt ?? '')
    const capacityUsd = selected
      ? selected.rows.reduce((sum, row) => {
          const point = (row.points as CurvePoint[]).find((point) => point.costPct === costCapPct)!
          return sum + point.capacityUsd!
        }, 0)
      : null
    const complete = selected !== null && capacityUsd !== null && Number.isFinite(capacityUsd)
    return {
      block: integerNonnegative(group[0]?.block),
      observedAt,
      firstAvailableAt,
      sourceId:
        localIds.get(String(group[0]?.block)) ??
        `venue_depth_curves:${name}:${String(group[0]?.block)}:${String(meta?.sourceBlockHash ?? 'unverified')}`,
      capacityUsd: complete ? capacityUsd : null,
      coverage: complete ? 'complete' : 'partial',
    }
  })
  result.coverage.returnedSamples = result.samples.length
  if (result.storage === 'database')
    result.coverage.truncated = groups.size >= limit || rows.length >= maxRows
  return result
}
