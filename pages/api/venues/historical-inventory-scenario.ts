import type { NextApiRequest, NextApiResponse } from 'next'

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import {
  disjointH24InventoryChanges,
  MIN_DISJOINT_H24_WINDOWS,
  summarizeHistoricalInventoryChanges,
  type HistoricalInventoryEvidence,
  type HistoricalInventoryPoint,
  type HistoricalInventoryScenario,
} from '@/components/Venue/historicalInventoryScenarioLogic'
import { readHistoricalThreeVenueInventory } from '@/scripts/lib/historicalThreeVenueInventory.mjs'
import { artifactPath } from '@/scripts/research/local-artifacts.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

type SupportedVenue = HistoricalInventoryScenario['venue']
type ArtifactVenue = 'aave-v3-usde' | 'scrvUSD'
type ReplayVenue = 'sUSDe' | 'sUSDS' | 'sGHO'

const SOURCES = {
  'aave-v3-usde': {
    name: 'aave-usde-cash-full-grid-400d',
    sha256: '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681',
    metric: 'instantUsd',
    sourceLabel: 'Aave USDe reserve cash',
  },
  scrvUSD: {
    name: 'scrvusd-leading-400d',
    sha256: '53dd284bca04c68af8c7a5635cf6f1b3fca1bbe5dd7eb8fd90c78ab147c4a1b2',
    metric: 'depthUsd',
    sourceLabel: 'Curve USDT + USDC output reserves',
  },
} as const
const REPLAY_METRIC = { sUSDe: 'depthUsd', sUSDS: 'depthUsd', sGHO: 'instantUsd' } as const
const REPLAY_SOURCE_LABEL = {
  sUSDe: 'Curve DOLA output reserve',
  sUSDS: 'shared Sky Pocket USDC',
  sGHO: 'sGHO vault GHO cash',
} as const
const SUPPORTED_VENUES = new Set<SupportedVenue>([
  'sUSDe',
  'aave-v3-usde',
  'sGHO',
  'sUSDS',
  'scrvUSD',
])

const sameAddress = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase()

function routeMatchesArtifact(venue: ArtifactVenue, data: any): boolean {
  const route = recorderConfig.venues.find((item) => item.name === venue && item.enabled)
  if (!route) return false
  if (venue === 'aave-v3-usde')
    return (
      route.kind === 'atoken-liquidity' &&
      route.depthCoveredByInstant === true &&
      data.study === 'Aave V3 USDe full 400d pinned cash grid' &&
      data.chainId === 1 &&
      sameAddress(data.pool, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2') &&
      sameAddress(data.underlying, route.underlying) &&
      sameAddress(data.aToken, route.address) &&
      sameAddress(data.variableDebtToken, route.variableDebtToken) &&
      route.decimals === 18
    )
  const markets = route.depthMarkets?.filter((market) => market.enabled) ?? []
  if (
    route.kind !== 'erc4626-cooldown' ||
    !sameAddress(route.underlying, '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E') ||
    data.study !== 'scrvUSD historical direct quotes' ||
    markets.length !== 2
  )
    return false
  const expected = new Map([
    ['0x390f3595bca2df7d23783dfd126427cceb997bf4', '0xdac17f958d2ee523a2206206994597c13d831ec7'],
    ['0x4dece678ceceb27446b35c672dc7d61f30bad69e', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  ])
  return markets.every(
    (market) =>
      market.kind === 'curve-stableswap' &&
      sameAddress(market.token1, route.underlying) &&
      sameAddress(market.exitFrom, route.underlying) &&
      sameAddress(market.token0, expected.get(market.address.toLowerCase())),
  )
}

export function extractHistoricalInventoryPoints(
  venue: ArtifactVenue,
  data: any,
): HistoricalInventoryPoint[] | null {
  if (!routeMatchesArtifact(venue, data) || !Array.isArray(data.rows)) return null
  if (venue === 'aave-v3-usde') {
    if (data.status !== 'complete' || data.rows.length !== 3137) return null
    return data.rows.map((row: any) => ({ at: row.at, inventoryUsd: row.cash }))
  }
  if (data.rows.length !== 3184) return null
  const expected = new Set([
    '0x390f3595bca2df7d23783dfd126427cceb997bf4',
    '0x4dece678ceceb27446b35c672dc7d61f30bad69e',
  ])
  const points: HistoricalInventoryPoint[] = []
  for (const row of data.rows) {
    if (!Array.isArray(row.pools) || row.pools.length !== 2) return null
    const seen = new Set<string>()
    let sum = 0
    for (const pool of row.pools) {
      if (typeof pool.address !== 'string') return null
      const address = pool.address.toLowerCase()
      if (seen.has(address) || !expected.has(address)) return null
      if (!Number.isFinite(pool.reserve0) || pool.reserve0 < 0) return null
      seen.add(address)
      // Both exact configured markets exit crvUSD into the reserve0 stablecoin.
      // The current recorder values that stablecoin at $1, and so does this history.
      sum += pool.reserve0
    }
    points.push({ at: row.at, inventoryUsd: sum })
  }
  return points
}

export function readHistoricalInventoryScenario(
  venue: ArtifactVenue,
): HistoricalInventoryScenario | null {
  const source = SOURCES[venue]
  const path = artifactPath({ name: source.name })
  if (basename(path) !== `${source.sha256}.json`) return null
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const points = extractHistoricalInventoryPoints(venue, data)
  if (!points || points.length < 2) return null
  const summary = summarizeHistoricalInventoryChanges(disjointH24InventoryChanges(points))
  if (!summary) return null
  return {
    status: 'historical_scenario',
    venue,
    metric: source.metric,
    horizonHours: 24,
    windowEndpointToleranceMinutes: 90,
    sampleCount: summary.sampleCount,
    sourceRowCount: points.length,
    sourceFirstAt: new Date(points[0].at * 1_000).toISOString(),
    sourceLastAt: new Date(points.at(-1)!.at * 1_000).toISOString(),
    sourceKind: 'sha_artifact',
    sourceSha256: source.sha256,
    sourceLabel: source.sourceLabel,
    valuationAssumption: '$1_per_output_token',
    artifactSha256: source.sha256,
    netInventoryChangeUsd: { p10: summary.p10, p90: summary.p90 },
    worstObservedNetContractionUsd: summary.worstObservedNetContractionUsd,
    meaning: 'historical_aggregate_inventory_scenario_not_gross_flow_or_holder_exit',
  }
}

function readReplayVenueEvidence(venue: ReplayVenue): HistoricalInventoryEvidence | null {
  // The replay verifies every record, sequence, SHA, pinned source, and the
  // exact historical/current route manifest before exposing any inventory.
  const history = readHistoricalThreeVenueInventory()
  if (
    history.count < 2 ||
    !history.last ||
    !Array.isArray(history.rows) ||
    history.rows.length !== history.count
  )
    return null
  const rows = history.rows
  const configured = recorderConfig.venues.find((item) => item.enabled && item.name === venue)
  if (
    !configured ||
    (venue === 'sGHO'
      ? configured.kind !== 'erc4626-vault-cash'
      : configured.kind !== 'erc4626-cooldown')
  )
    return null
  const points: HistoricalInventoryPoint[] = rows
    .slice()
    .reverse()
    .map((row: any) => ({
      at: row.source.timestamp,
      inventoryUsd: row.inventory[venue].inventoryUsdAssumingPeg,
    }))
  if (
    points.some(
      (point, index) =>
        !Number.isSafeInteger(point.at) ||
        !Number.isFinite(point.inventoryUsd) ||
        point.inventoryUsd < 0 ||
        (index > 0 &&
          (point.at <= points[index - 1].at || point.at - points[index - 1].at > 4 * 3600)),
    )
  )
    return null
  const changes = disjointH24InventoryChanges(points)
  const common = {
    venue,
    metric: REPLAY_METRIC[venue],
    horizonHours: 24,
    windowEndpointToleranceMinutes: 90,
    sourceRowCount: points.length,
    sourceFirstAt: new Date(points[0].at * 1_000).toISOString(),
    sourceLastAt: new Date(points.at(-1)!.at * 1_000).toISOString(),
    sourceKind: 'local_replay_chain',
    sourceSha256: history.last.sha256,
    sourceLabel: REPLAY_SOURCE_LABEL[venue],
    valuationAssumption: '$1_per_output_token',
  } as const
  const summary = summarizeHistoricalInventoryChanges(changes)
  if (!summary)
    return {
      ...common,
      status: 'insufficient_history',
      sampleCount: changes.length,
      requiredSampleCount: MIN_DISJOINT_H24_WINDOWS,
      meaning: 'historical_aggregate_inventory_only_no_scenario_until_minimum_coverage',
    }
  return {
    ...common,
    status: 'historical_scenario',
    sampleCount: summary.sampleCount,
    artifactSha256: null,
    netInventoryChangeUsd: { p10: summary.p10, p90: summary.p90 },
    worstObservedNetContractionUsd: summary.worstObservedNetContractionUsd,
    meaning: 'historical_aggregate_inventory_scenario_not_gross_flow_or_holder_exit',
  }
}

export function readHistoricalInventoryEvidence(
  venue: SupportedVenue,
): HistoricalInventoryEvidence | null {
  return venue === 'aave-v3-usde' || venue === 'scrvUSD'
    ? readHistoricalInventoryScenario(venue)
    : readReplayVenueEvidence(venue)
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
  if (!isLocalDevelopment(req)) return res.status(503).json({ error: 'local_scenario_unavailable' })
  const venue = req.query.venue
  if (typeof venue !== 'string' || !SUPPORTED_VENUES.has(venue as SupportedVenue))
    return res.status(400).json({ error: 'invalid_venue' })
  try {
    const evidence = readHistoricalInventoryEvidence(venue as SupportedVenue)
    if (!evidence) return res.status(503).json({ error: 'historical_coverage_unavailable' })
    return res.status(200).json(evidence)
  } catch {
    return res.status(503).json({ error: 'historical_artifact_unverified_or_unavailable' })
  }
}
