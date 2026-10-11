import { projectHistoricalFlowDuration, type DurationBracket } from './historicalFlowDuration'
import type { HistoricalGrossFlowSummary, PairedFlowWindow } from './historicalGrossFlowStress'

export const AAVE_COMPETING_FLOW_IDENTITY = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
} as const
export const AAVE_FLOW_DURATION_ARTIFACT_SHA256 =
  '234e6875376ff9978d2d7f019b83e93250455959b5a95ef1fcfcbbe588a86f62'
const JOIN_SHA = 'c1d95334840d5b503eba8228edfcdad0d3d5ad84fd898c9f525c702738572157'
const COMPACT_SHA = 'df96a86bb497717375776c987ea3c44ceac81dab211f2c5ef8ba08ebe8671c9e'
type Hash = (serialized: string) => string
type Window = Omit<PairedFlowWindow, 'durationPath'> & { durationSeconds: DurationBracket | null }
type Fraction = { numeratorRaw: string; denominator: number }
type Direction = { totalRaw: string; mean: Fraction; p10Raw: string; p90Raw: string }
export type HistoricalCompetingFlowEstimate = {
  status: 'historical_context'
  claim: 'aggregate_reserve_gross_flow_only'
  identity: typeof AAVE_COMPETING_FLOW_IDENTITY
  horizonBlocks: 256
  windowCount: 78
  selectedHorizonForecast: false
  prospectiveValidated: false
  forecastValidated: false
  holderExecutableExit: false
  accounting: 'context_only_already_included_in_net_cash'
  source: { artifactSha256: string; joinContentSha256: string; compactWindowsSha256: string }
  windows: Window[]
  grossReplenishment: Direction
  grossDepletion: Direction
  timeCoverage: {
    boundedWindows: number
    exactWindows: number
    durationSeconds: DurationBracket | null
  }
  chronologicalBacktest: {
    method: 'expanding_prior_mean_native_integer_floor'
    evaluatedWindows: 77
    replenishment: { meanAbsoluteError: Fraction; persistenceAbsoluteError: Fraction }
    depletion: { meanAbsoluteError: Fraction; persistenceAbsoluteError: Fraction }
    lastWindow: {
      originBlock: number
      trainingWindows: 77
      replenishment: Direction
      depletion: Direction
    }
  }
}
export type ExpectedCompetingFlow =
  | HistoricalCompetingFlowEstimate
  | {
      status: 'unavailable'
      reason: 'already_embedded_in_net_cash_endpoints' | 'verified_gross_flow_history_unavailable'
    }
const fail = (valid: unknown) => {
  if (!valid) throw Error('historical_competing_flow_invalid')
}
const raw = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n
const signed = (value: unknown): value is string =>
  typeof value === 'string' && /^-?(0|[1-9][0-9]{0,77})$/.test(value) && !value.startsWith('-0')
const absolute = (v: bigint) => (v < 0n ? -v : v)
function direction(values: bigint[]): Direction {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const total = values.reduce((a, b) => a + b, 0n)
  return {
    totalRaw: total.toString(),
    mean: { numeratorRaw: total.toString(), denominator: values.length },
    p10Raw: sorted[Math.floor((values.length - 1) * 0.1)].toString(),
    p90Raw: sorted[Math.floor((values.length - 1) * 0.9)].toString(),
  }
}
function backtest(values: bigint[]) {
  let prefix = values[0],
    meanError = 0n,
    persistenceError = 0n
  for (let i = 1; i < values.length; i++) {
    meanError += absolute(prefix / BigInt(i) - values[i])
    persistenceError += absolute(values[i - 1] - values[i])
    prefix += values[i]
  }
  return {
    meanAbsoluteError: { numeratorRaw: meanError.toString(), denominator: values.length - 1 },
    persistenceAbsoluteError: {
      numeratorRaw: persistenceError.toString(),
      denominator: values.length - 1,
    },
  }
}
function derive(windows: Window[], hash: Hash): HistoricalCompetingFlowEstimate {
  fail(Array.isArray(windows) && windows.length === 78)
  let previous = -1
  for (const w of windows) {
    fail(w !== null && typeof w === 'object' && !Array.isArray(w))
    fail(
      Number.isSafeInteger(w.originBlock) &&
        Number.isSafeInteger(w.targetBlock) &&
        w.originBlock >= 26079860 &&
        w.targetBlock <= 26100345 &&
        w.originBlock >= previous &&
        w.targetBlock - w.originBlock === 256 &&
        Number.isSafeInteger(w.troughBlock) &&
        w.troughBlock >= w.originBlock &&
        w.troughBlock <= w.targetBlock,
    )
    previous = w.targetBlock
    fail(
      [
        w.sourceCashRaw,
        w.targetCashRaw,
        w.grossReserveInRaw,
        w.grossReserveOutRaw,
        w.troughCashRaw,
      ].every(raw),
    )
    fail(signed(w.endpointCashDeltaRaw) && signed(w.troughCashDeltaRaw))
    const source = BigInt(w.sourceCashRaw),
      target = BigInt(w.targetCashRaw),
      trough = BigInt(w.troughCashRaw)
    fail(
      source + BigInt(w.grossReserveInRaw) - BigInt(w.grossReserveOutRaw) === target &&
        target - source === BigInt(w.endpointCashDeltaRaw) &&
        trough - source === BigInt(w.troughCashDeltaRaw) &&
        trough <= source &&
        trough <= target,
    )
    if (w.durationSeconds !== null)
      fail(
        typeof w.durationSeconds === 'object' &&
          !Array.isArray(w.durationSeconds) &&
          Number.isSafeInteger(w.durationSeconds.lowerSeconds) &&
          w.durationSeconds.lowerSeconds >= 0 &&
          Number.isSafeInteger(w.durationSeconds.upperSeconds) &&
          w.durationSeconds.upperSeconds >= w.durationSeconds.lowerSeconds,
      )
  }
  const digest = hash(JSON.stringify(windows))
  fail(digest === COMPACT_SHA)
  const inflow = windows.map((w) => BigInt(w.grossReserveInRaw))
  const outflow = windows.map((w) => BigInt(w.grossReserveOutRaw))
  const times = windows.flatMap((w) => (w.durationSeconds ? [w.durationSeconds] : []))
  return {
    status: 'historical_context',
    claim: 'aggregate_reserve_gross_flow_only',
    identity: { ...AAVE_COMPETING_FLOW_IDENTITY },
    horizonBlocks: 256,
    windowCount: 78,
    selectedHorizonForecast: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    accounting: 'context_only_already_included_in_net_cash',
    source: {
      artifactSha256: AAVE_FLOW_DURATION_ARTIFACT_SHA256,
      joinContentSha256: JOIN_SHA,
      compactWindowsSha256: digest,
    },
    windows: windows.map((w) => ({
      ...w,
      durationSeconds: w.durationSeconds ? { ...w.durationSeconds } : null,
    })),
    grossReplenishment: direction(inflow),
    grossDepletion: direction(outflow),
    timeCoverage: {
      boundedWindows: times.length,
      exactWindows: times.filter((t) => t.lowerSeconds === t.upperSeconds).length,
      durationSeconds:
        times.length === 78
          ? {
              lowerSeconds: Math.min(...times.map((t) => t.lowerSeconds)),
              upperSeconds: Math.max(...times.map((t) => t.upperSeconds)),
            }
          : null,
    },
    chronologicalBacktest: {
      method: 'expanding_prior_mean_native_integer_floor',
      evaluatedWindows: 77,
      replenishment: backtest(inflow),
      depletion: backtest(outflow),
      lastWindow: {
        originBlock: windows[77].originBlock,
        trainingWindows: 77,
        replenishment: direction(inflow.slice(0, -1)),
        depletion: direction(outflow.slice(0, -1)),
      },
    },
  }
}

/** Physical artifact pin follows the existing full sealed-replay loader; hashes are not self-attested. */
export function buildHistoricalCompetingFlowEstimate(
  summary: HistoricalGrossFlowSummary,
  hash: Hash,
): ExpectedCompetingFlow {
  try {
    const s = summary as HistoricalGrossFlowSummary & {
      sourceVerification: string
      distributionScope: string
    }
    fail(
      hash(`${JSON.stringify(s)}\n`) === AAVE_FLOW_DURATION_ARTIFACT_SHA256 &&
        s.schema === 'carry_historical_paired_flow_summary_v1' &&
        s.study === 'aave-usdc-historical-flow-summary-v1' &&
        s.sourceVerification === 'full_sealed_replay' &&
        s.distributionScope === 'nonoverlapping_exact_windows' &&
        s.identity.chainId === 1 &&
        s.identity.marketKey === 'aaveV3Usdc' &&
        s.identity.routeKey === AAVE_COMPETING_FLOW_IDENTITY.routeKey &&
        s.identity.destination.toLowerCase() === AAVE_COMPETING_FLOW_IDENTITY.destination &&
        s.identity.asset.toLowerCase() === AAVE_COMPETING_FLOW_IDENTITY.asset &&
        s.identity.decimals === 6 &&
        s.horizonBlocks === 256 &&
        s.nonoverlappingWindowCount === 78 &&
        s.source.joinContentSha256 === JOIN_SHA,
    )
    const windows = s.pairedWindows.map((w) => {
      const { durationPath, ...paired } = w
      fail(
        durationPath &&
          durationPath.sourceJoinSha256 === JOIN_SHA &&
          durationPath.originBlock === w.originBlock &&
          durationPath.targetBlock === w.targetBlock &&
          durationPath.points[0].cashAfterRaw === w.sourceCashRaw &&
          durationPath.points.at(-1)?.cashAfterRaw === w.targetCashRaw,
      )
      return {
        ...paired,
        durationSeconds: projectHistoricalFlowDuration(durationPath!, '0', '1').horizonDuration,
      }
    })
    return derive(windows, hash)
  } catch {
    return { status: 'unavailable', reason: 'verified_gross_flow_history_unavailable' }
  }
}

/** Browser boundary recomputes all means, errors and brackets from pinned compact evidence. */
export function selectedHistoricalCompetingFlowEstimate(
  value: unknown,
  identity:
    | typeof AAVE_COMPETING_FLOW_IDENTITY
    | { routeKey: string; destination: string; asset: string; assetDecimals: number },
  hash: Hash,
): HistoricalCompetingFlowEstimate | null {
  try {
    if (
      identity.routeKey !== AAVE_COMPETING_FLOW_IDENTITY.routeKey ||
      identity.destination.toLowerCase() !== AAVE_COMPETING_FLOW_IDENTITY.destination ||
      identity.asset.toLowerCase() !== AAVE_COMPETING_FLOW_IDENTITY.asset ||
      identity.assetDecimals !== 6 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return null
    const expected = derive((value as HistoricalCompetingFlowEstimate).windows, hash)
    const canonical = (v: unknown): unknown =>
      Array.isArray(v)
        ? ['array', v.map(canonical)]
        : v !== null && typeof v === 'object'
          ? [
              'object',
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, canonical(x)]),
            ]
          : [v === null ? 'null' : typeof v, v]
    return JSON.stringify(canonical(value)) === JSON.stringify(canonical(expected))
      ? expected
      : null
  } catch {
    return null
  }
}
