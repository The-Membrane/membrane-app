import type { NextApiRequest, NextApiResponse } from 'next'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LOCAL_VENUE_SNAPSHOT_ROOT,
  verifyLocalVenueSnapshots,
} from '@/scripts/lib/localVenueSnapshotStore.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

// A local, observed point comparison. This is an aggregate route liquidity
// proxy, never a holder's executable withdrawal or a future exit forecast.
const VENUE_METRIC = {
  sUSDe: 'depthUsd',
  'aave-v3-usde': 'instantUsd',
  sGHO: 'instantUsd',
  sUSDS: 'depthUsd',
  scrvUSD: 'depthUsd',
} as const
type Venue = keyof typeof VENUE_METRIC
type Metric = (typeof VENUE_METRIC)[Venue]
export const MATERIAL_DECLINE_PERCENT = 1
export const MATERIAL_DECLINE_USD = 100_000
export const MAX_SOURCE_AGE_MS = 3 * 60 * 60 * 1_000
export const MAX_COMPARISON_GAP_MS = 3 * 60 * 60 * 1_000
const FUTURE_SKEW_MS = 5 * 60 * 1_000

type Snapshot = {
  venue: string
  sequence: number
  sha256: string
  previousSha256: string | null
  chain: string
  source: { block: string; hash: string; timestamp: number; finalized: true; pinned: true }
  observedAtUtc: string
  firstLocalReceiptAtUtc: string
  measurement: { instantUsd: number | null; depthUsd: number | null; params: Record<string, any> }
  comparison: {
    status: string
    previousSequence: number | null
    previousBlock: string | null
    elapsedSourceSeconds: number | null
    flowStatus: string
    continuity: string
    deltas: Record<
      Metric,
      { previous: number; current: number; absolute: number; percent: number | null } | null
    > | null
  }
}

const unavailable = (venue: Venue, reason: string) => ({
  venue,
  metric: VENUE_METRIC[venue],
  signal: { status: 'unavailable' as const, reason },
})

const sameAddress = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

const UINT256_MAX = (1n << 256n) - 1n
const PSM_MAX_OPEN_FEE = 10n ** 18n

function validPsmBuyGemState(
  market: Record<string, any>,
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

function matchingRoute(record: Snapshot, venue: Venue) {
  const configured = recorderConfig.venues.find((item) => item.enabled && item.name === venue)
  if (!configured) return false
  const params = record.measurement.params
  if (VENUE_METRIC[venue] === 'instantUsd') {
    return (
      params.kind === configured.kind &&
      params.underlyingIdentity === 'match' &&
      params.decimalsIdentity === 'match' &&
      sameAddress(params.underlyingOnchain, configured.underlying) &&
      Number(params.underlyingDecimalsOnchain) === configured.decimals &&
      (venue === 'aave-v3-usde'
        ? sameAddress(params.aToken, configured.address) && params.reads?.underlyingBalance === true
        : sameAddress(params.vault, configured.address) &&
          typeof params.withdrawalsPaused === 'boolean')
    )
  }
  const expected = configured.depthMarkets?.filter((market) => market.enabled) ?? []
  const recorded = params.depthMarkets
  if (
    params.depth_complete !== true ||
    !Array.isArray(recorded) ||
    recorded.length !== expected.length
  )
    return false
  const observed = new Map(
    recorded.map((market: any) => [String(market.address).toLowerCase(), market]),
  )
  if (observed.size !== expected.length) return false
  return expected.every((market) => {
    const point = observed.get(String(market.address).toLowerCase())
    return (
      point &&
      point.kind === market.kind &&
      sameAddress(point.exitFrom, market.exitFrom) &&
      (market.token0 === undefined || sameAddress(point.token0, market.token0)) &&
      (market.token1 === undefined || sameAddress(point.token1, market.token1)) &&
      (market.kind !== 'curve-stableswap' ||
        (point.coinsIdentity === 'match' &&
          sameAddress(point.coin0Onchain, market.token0) &&
          sameAddress(point.coin1Onchain, market.token1))) &&
      (market.kind !== 'psm-buffer' ||
        (sameAddress(market.exitFrom, configured.underlying) &&
          sameAddress(point.buffer, market.buffer) &&
          sameAddress(point.bufferToken, market.bufferToken) &&
          sameAddress(point.wrapper, market.wrapper) &&
          point.wrapperIdentity === 'match' &&
          sameAddress(point.wrapperPsmOnchain, market.address) &&
          sameAddress(point.wrapperPocketOnchain, market.buffer) &&
          sameAddress(point.wrapperUsdsOnchain, configured.underlying) &&
          validPsmBuyGemState(point, params.depth_usd, expected.length) &&
          point.exitIdentity === 'match' &&
          point.pocketIdentity === 'match' &&
          point.gemIdentity === 'match' &&
          sameAddress(point.pocketOnchain, market.buffer) &&
          sameAddress(point.gemOnchain, market.bufferToken)))
    )
  })
}

export function buildObservedCapacityChange(
  venue: Venue,
  previous: Snapshot | null,
  current: Snapshot | null,
  nowMs = Date.now(),
) {
  if (!current || !previous) return unavailable(venue, 'fewer_than_two_verified_points')
  if (
    current.venue !== venue ||
    previous.venue !== venue ||
    current.chain !== 'ethereum' ||
    previous.chain !== current.chain ||
    current.sequence !== previous.sequence + 1 ||
    current.previousSha256 !== previous.sha256 ||
    current.source.finalized !== true ||
    current.source.pinned !== true ||
    previous.source.finalized !== true ||
    previous.source.pinned !== true ||
    current.comparison.status !== 'two_observed_points' ||
    current.comparison.previousSequence !== previous.sequence ||
    current.comparison.previousBlock !== previous.source.block ||
    current.comparison.flowStatus !== 'not_measured' ||
    current.comparison.continuity !== 'not_established' ||
    !matchingRoute(previous, venue) ||
    !matchingRoute(current, venue)
  )
    return unavailable(venue, 'noncomparable_local_points')
  const age = nowMs - current.source.timestamp * 1_000
  if (age > MAX_SOURCE_AGE_MS || age < -FUTURE_SKEW_MS)
    return unavailable(venue, 'latest_point_stale_or_future')
  const elapsedMs = (current.source.timestamp - previous.source.timestamp) * 1_000
  if (
    elapsedMs <= 0 ||
    elapsedMs > MAX_COMPARISON_GAP_MS ||
    current.comparison.elapsedSourceSeconds * 1_000 !== elapsedMs
  )
    return unavailable(venue, 'comparison_gap_unbounded')
  const metric = VENUE_METRIC[venue]
  const delta = current.comparison.deltas?.[metric]
  if (
    !delta ||
    !Number.isFinite(delta.previous) ||
    !Number.isFinite(delta.current) ||
    delta.previous <= 0 ||
    delta.current < 0 ||
    delta.previous !== previous.measurement[metric] ||
    delta.current !== current.measurement[metric]
  )
    return unavailable(venue, 'metric_not_measured_at_both_points')

  const declineUsd = delta.previous - delta.current
  const declinePercent = (declineUsd / delta.previous) * 100
  const status =
    declineUsd >= MATERIAL_DECLINE_USD && declinePercent >= MATERIAL_DECLINE_PERCENT
      ? 'observed_shrinking'
      : 'none'
  return {
    venue,
    metric,
    signal: {
      status,
      kind: 'observed_aggregate_capacity_change',
      threshold: {
        minimumDeclineUsd: MATERIAL_DECLINE_USD,
        minimumDeclinePercent: MATERIAL_DECLINE_PERCENT,
      },
      before: {
        usd: delta.previous,
        block: previous.source.block,
        blockHash: previous.source.hash,
        blockTime: new Date(previous.source.timestamp * 1_000).toISOString(),
        observedAt: previous.observedAtUtc,
        firstLocalReceiptAt: previous.firstLocalReceiptAtUtc,
        localRecordSha256: previous.sha256,
      },
      after: {
        usd: delta.current,
        block: current.source.block,
        blockHash: current.source.hash,
        blockTime: new Date(current.source.timestamp * 1_000).toISOString(),
        observedAt: current.observedAtUtc,
        firstLocalReceiptAt: current.firstLocalReceiptAtUtc,
        localRecordSha256: current.sha256,
      },
      declineUsd: Math.max(0, declineUsd),
      declinePercent: Math.max(0, declinePercent),
      elapsedSourceSeconds: current.comparison.elapsedSourceSeconds,
      flowStatus: 'not_measured',
      continuity: 'not_established',
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
      forecast: { status: 'unavailable', futureExitProbability: null, likelyDurationSeconds: null },
    },
  }
}

export function readObservedCapacityChange(
  venue: Venue,
  { root = LOCAL_VENUE_SNAPSHOT_ROOT, nowMs = Date.now() } = {},
) {
  const { count, last } = verifyLocalVenueSnapshots(venue, root)
  if (count < 2 || !last) return unavailable(venue, 'fewer_than_two_verified_points')
  const path = join(root, venue, `${String(count - 1).padStart(12, '0')}.json`)
  const bytes = readFileSync(path, 'utf8')
  const previous = JSON.parse(bytes) as Snapshot
  // The full chain was replayed above; do not serve a swapped predecessor.
  const { sha256, ...body } = previous
  if (
    bytes !== `${JSON.stringify(previous)}\n` ||
    sha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex') ||
    previous.sha256 !== last.previousSha256
  )
    return unavailable(venue, 'local_snapshot_changed_during_read')
  return buildObservedCapacityChange(venue, previous, last as Snapshot, nowMs)
}

const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (!isLocalDevelopment(req)) return res.status(503).json({ error: 'local_signal_unavailable' })
  const venueParam = req.query.venue
  if (
    venueParam !== undefined &&
    (typeof venueParam !== 'string' || !Object.hasOwn(VENUE_METRIC, venueParam))
  )
    return res.status(400).json({ error: 'invalid_venue' })
  const venues = venueParam ? [venueParam as Venue] : (Object.keys(VENUE_METRIC) as Venue[])
  const items = venues.map((venue) => {
    try {
      return readObservedCapacityChange(venue)
    } catch {
      return unavailable(venue, 'local_snapshot_unverified_or_unavailable')
    }
  })
  return res.status(200).json({
    items,
    provenance: {
      storage: 'local_mac_recorder',
      basis: 'two_adjacent_locally_replayed_finalized_reads',
      sourceVerification: 'single_provider_at_capture_not_independently_rechecked',
      materiality: 'fixed_display_filter_not_calibrated',
      flowStatus: 'not_measured',
      futureExitForecast: 'unavailable',
    },
  })
}
