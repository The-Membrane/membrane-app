// Historical changes to an aggregate route inventory, never a holder exit quote
// or an estimate of gross competing withdrawals.
export type HistoricalInventoryPoint = { at: number; inventoryUsd: number }

export type HistoricalInventoryScenario = {
  status: 'historical_scenario'
  venue: 'sUSDe' | 'aave-v3-usde' | 'sGHO' | 'sUSDS' | 'scrvUSD'
  metric: 'instantUsd' | 'depthUsd'
  horizonHours: 24
  windowEndpointToleranceMinutes: 90
  sampleCount: number
  sourceRowCount: number
  sourceFirstAt: string
  sourceLastAt: string
  sourceKind: 'sha_artifact' | 'local_replay_chain'
  sourceSha256: string
  sourceLabel: string
  valuationAssumption: '$1_per_output_token'
  artifactSha256: string | null
  netInventoryChangeUsd: { p10: number; p90: number }
  worstObservedNetContractionUsd: number
  meaning: 'historical_aggregate_inventory_scenario_not_gross_flow_or_holder_exit'
}

export type HistoricalInventoryCoverage = {
  status: 'insufficient_history'
  venue: HistoricalInventoryScenario['venue']
  metric: HistoricalInventoryScenario['metric']
  horizonHours: 24
  windowEndpointToleranceMinutes: 90
  sampleCount: number
  requiredSampleCount: number
  sourceRowCount: number
  sourceFirstAt: string
  sourceLastAt: string
  sourceKind: 'local_replay_chain'
  sourceSha256: string
  sourceLabel: string
  valuationAssumption: '$1_per_output_token'
  meaning: 'historical_aggregate_inventory_only_no_scenario_until_minimum_coverage'
}

export type HistoricalInventoryEvidence = HistoricalInventoryScenario | HistoricalInventoryCoverage

export type HistoricalResidualBand = {
  lowUsd: number
  highUsd: number
  relation: 'below' | 'above' | 'uncertain'
}

export function historicalScenarioMatchesCapacity(
  scenario: HistoricalInventoryScenario | null | undefined,
  venue: string,
  metric: string | null | undefined,
): boolean {
  return scenario?.venue === venue && scenario.metric === metric
}

const H24_SECONDS = 24 * 60 * 60
const TARGET_TOLERANCE_SECONDS = 90 * 60
const MAX_GRID_GAP_SECONDS = 4 * 60 * 60
export const MIN_DISJOINT_H24_WINDOWS = 100

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction
  const low = Math.floor(position)
  const weight = position - low
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * weight
}

export function disjointH24InventoryChanges(points: HistoricalInventoryPoint[]): number[] {
  if (points.length < 2) return []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (
      !Number.isSafeInteger(point.at) ||
      !Number.isFinite(point.inventoryUsd) ||
      point.inventoryUsd < 0 ||
      (i > 0 &&
        (point.at <= points[i - 1].at || point.at - points[i - 1].at > MAX_GRID_GAP_SECONDS))
    )
      return []
  }

  const changes: number[] = []
  let start = 0
  while (start < points.length - 1) {
    const targetAt = points[start].at + H24_SECONDS
    let end = start + 1
    while (end < points.length && points[end].at < targetAt - TARGET_TOLERANCE_SECONDS) end++
    const candidates = [end - 1, end].filter((index) => index > start && index < points.length)
    const nearest = candidates.sort(
      (a, b) => Math.abs(points[a].at - targetAt) - Math.abs(points[b].at - targetAt),
    )[0]
    if (
      nearest === undefined ||
      Math.abs(points[nearest].at - targetAt) > TARGET_TOLERANCE_SECONDS
    ) {
      start++
      continue
    }
    changes.push(points[nearest].inventoryUsd - points[start].inventoryUsd)
    // Keep both endpoints out of the next window so no observation is reused.
    start = nearest + 1
  }
  return changes
}

export function summarizeHistoricalInventoryChanges(
  changes: number[],
  minimum = MIN_DISJOINT_H24_WINDOWS,
): {
  p10: number
  p90: number
  worstObservedNetContractionUsd: number
  sampleCount: number
} | null {
  if (
    changes.length < minimum ||
    !changes.every(Number.isFinite) ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1
  )
    return null
  const sorted = [...changes].sort((a, b) => a - b)
  return {
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    worstObservedNetContractionUsd: Math.max(0, -sorted[0]),
    sampleCount: sorted.length,
  }
}

export function historicalResidualAfterAmount(
  scenario: HistoricalInventoryScenario | null | undefined,
  currentInventoryUsd: number | null,
  amountUsd: number | null,
  horizonHours: number | null,
): HistoricalResidualBand | null {
  if (
    scenario?.status !== 'historical_scenario' ||
    horizonHours !== scenario.horizonHours ||
    currentInventoryUsd == null ||
    amountUsd == null ||
    !Number.isFinite(currentInventoryUsd) ||
    currentInventoryUsd < 0 ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    scenario.sampleCount < MIN_DISJOINT_H24_WINDOWS ||
    !Number.isFinite(scenario.netInventoryChangeUsd.p10) ||
    !Number.isFinite(scenario.netInventoryChangeUsd.p90) ||
    scenario.netInventoryChangeUsd.p10 > scenario.netInventoryChangeUsd.p90
  )
    return null
  const lowUsd = currentInventoryUsd + scenario.netInventoryChangeUsd.p10 - amountUsd
  const highUsd = currentInventoryUsd + scenario.netInventoryChangeUsd.p90 - amountUsd
  return {
    lowUsd,
    highUsd,
    relation: highUsd < 0 ? 'below' : lowUsd >= 0 ? 'above' : 'uncertain',
  }
}
