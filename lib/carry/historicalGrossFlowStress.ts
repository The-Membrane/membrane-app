import {
  projectHistoricalFlowDuration,
  type HistoricalFlowDuration,
  type HistoricalFlowDurationPath,
} from './historicalFlowDuration'

export type RawDistribution = {
  lower: string
  median: string
  upper: string
  minimum: string
  maximum: string
}

/** A complete exact historical window, reusable across venue adapters. */
export type PairedFlowWindow = {
  originBlock: number
  targetBlock: number
  sourceCashRaw: string
  targetCashRaw: string
  grossReserveInRaw: string
  grossReserveOutRaw: string
  endpointCashDeltaRaw: string
  troughCashRaw: string
  troughCashDeltaRaw: string
  troughBlock: number
  durationPath?: HistoricalFlowDurationPath
}

export type TranslatedPairedFlowWindow = PairedFlowWindow & {
  endpointCashRaw: string
  endpointMarginAfterQRaw: string
  endpointDeficitAfterQRaw: string
  troughCashRawReplayed: string
  troughMarginAfterQRaw: string
  troughDeficitAfterQRaw: string
  rank: number
  sampleCount: number
  duration?: HistoricalFlowDuration
}

export type HistoricalGrossFlowSummary = {
  study: string
  identity: {
    chainId: number
    marketKey: string
    routeKey: string
    destination: string
    asset: string
    decimals: number
  }
  source: {
    fromBlock: number
    toBlock: number
    joinContentSha256: string
  }
  horizonBlocks: number
  exactHorizonWindows: number
  nonoverlappingWindowCount: number
  schema: 'carry_historical_paired_flow_summary_v1'
  pairedWindows: PairedFlowWindow[]
  pairedWindowsSha256: string
  nonoverlappingDistributions: {
    grossReserveInRaw: RawDistribution
    grossReserveOutRaw: RawDistribution
    endpointCashDeltaRaw: RawDistribution
    troughCashDeltaRaw: RawDistribution
  }
  exactWindowExtrema: {
    maxGrossReserveInRaw: string
    maxGrossReserveOutRaw: string
    minEndpointCashDeltaRaw: string
    minTroughCashDeltaRaw: string
  }
}

const RAW = /^(0|[1-9][0-9]*)$/
const SIGNED = /^-?(0|[1-9][0-9]*)$/
const SHA256 = /^[0-9a-f]{64}$/
const clamp = (value: bigint) => (value < 0n ? 0n : value)

export function isFreshHistoricalCashBlock(blockTimestamp: string, nowMs: number) {
  const ageMs = nowMs - Date.parse(blockTimestamp)
  return Number.isFinite(ageMs) && ageMs >= -120_000 && ageMs <= 30 * 60_000
}

function amount(value: string, signed = false) {
  if (!(signed ? SIGNED : RAW).test(value)) throw new Error('historical_flow_invalid_raw')
  return BigInt(value)
}

function distribution(values: RawDistribution, transform: (value: bigint) => bigint) {
  return {
    lower: transform(amount(values.lower, true)).toString(),
    median: transform(amount(values.median, true)).toString(),
    upper: transform(amount(values.upper, true)).toString(),
    minimum: transform(amount(values.minimum, true)).toString(),
    maximum: transform(amount(values.maximum, true)).toString(),
  }
}

export function projectPairedWindowDuration(
  window: PairedFlowWindow,
  currentCashRaw: string,
  requestedRaw: string,
  joinContentSha256: string | undefined,
) {
  const path = window.durationPath
  if (!path) return null
  if (
    !joinContentSha256 ||
    path.sourceJoinSha256 !== joinContentSha256 ||
    path.originBlock !== window.originBlock ||
    path.targetBlock !== window.targetBlock ||
    path.points[0]?.cashAfterRaw !== window.sourceCashRaw ||
    path.points.at(-1)?.cashAfterRaw !== window.targetCashRaw ||
    !path.points.some(
      (point) =>
        point.blockNumber === window.troughBlock && point.cashAfterRaw === window.troughCashRaw,
    ) ||
    path.points.some((point) => amount(point.cashAfterRaw) < amount(window.troughCashRaw))
  )
    throw new Error('historical_duration_window_mismatch')
  return projectHistoricalFlowDuration(path, currentCashRaw, requestedRaw)
}

/** Recompute at the browser boundary so duration cannot be reused after C2/Q/source changes. */
export function matchesPairedWindowDuration(
  window: TranslatedPairedFlowWindow,
  currentCashRaw: string,
  requestedRaw: string,
  joinContentSha256: string | undefined,
) {
  try {
    const duration = projectPairedWindowDuration(
      window,
      currentCashRaw,
      requestedRaw,
      joinContentSha256,
    )
    return duration === null
      ? window.duration === undefined
      : JSON.stringify(duration) === JSON.stringify(window.duration)
  } catch {
    return false
  }
}

/** Conditional replay of paired historical cash deltas; never a holder exit forecast. */
export function projectHistoricalGrossFlowStress(
  summary: HistoricalGrossFlowSummary,
  currentCashRaw: string,
  requestedRaw: string,
) {
  const currentCash = amount(currentCashRaw)
  const requested = amount(requestedRaw)
  if (
    requested === 0n ||
    !Number.isSafeInteger(summary.horizonBlocks) ||
    summary.horizonBlocks < 1 ||
    !Number.isSafeInteger(summary.exactHorizonWindows) ||
    summary.exactHorizonWindows < 1 ||
    !Number.isSafeInteger(summary.nonoverlappingWindowCount) ||
    summary.nonoverlappingWindowCount < 1 ||
    summary.nonoverlappingWindowCount > summary.exactHorizonWindows ||
    summary.schema !== 'carry_historical_paired_flow_summary_v1' ||
    !Array.isArray(summary.pairedWindows) ||
    summary.pairedWindows.length !== summary.nonoverlappingWindowCount ||
    !SHA256.test(summary.pairedWindowsSha256) ||
    !Number.isSafeInteger(summary.source.fromBlock) ||
    !Number.isSafeInteger(summary.source.toBlock) ||
    summary.source.toBlock <= summary.source.fromBlock ||
    !SHA256.test(summary.source.joinContentSha256)
  )
    throw new Error('historical_flow_invalid_summary')
  let previousTargetBlock = -1
  const translatedWindows = summary.pairedWindows.map((window) => {
    if (
      !Number.isSafeInteger(window.originBlock) ||
      !Number.isSafeInteger(window.targetBlock) ||
      window.targetBlock - window.originBlock !== summary.horizonBlocks ||
      window.originBlock < previousTargetBlock ||
      window.originBlock < summary.source.fromBlock ||
      window.targetBlock > summary.source.toBlock ||
      !Number.isSafeInteger(window.troughBlock) ||
      window.troughBlock < window.originBlock ||
      window.troughBlock > window.targetBlock
    )
      throw new Error('historical_flow_invalid_paired_window')
    previousTargetBlock = window.targetBlock
    const source = amount(window.sourceCashRaw)
    const target = amount(window.targetCashRaw)
    const grossIn = amount(window.grossReserveInRaw)
    const grossOut = amount(window.grossReserveOutRaw)
    const endpointDelta = amount(window.endpointCashDeltaRaw, true)
    const trough = amount(window.troughCashRaw)
    const troughDelta = amount(window.troughCashDeltaRaw, true)
    if (
      source + grossIn - grossOut !== target ||
      target - source !== endpointDelta ||
      trough > source ||
      trough > target ||
      trough - source !== troughDelta
    )
      throw new Error('historical_flow_invalid_paired_window')
    const endpointCash = clamp(currentCash + endpointDelta)
    const troughCash = clamp(currentCash + troughDelta)
    const duration = projectPairedWindowDuration(
      window,
      currentCashRaw,
      requestedRaw,
      summary.source.joinContentSha256,
    )
    return {
      ...window,
      ...(duration ? { duration } : {}),
      endpointMarginAfterQRaw: (endpointCash - requested).toString(),
      endpointCashRaw: endpointCash.toString(),
      troughMarginAfterQRaw: (troughCash - requested).toString(),
      troughCashRawReplayed: troughCash.toString(),
      endpointDeficitAfterQRaw: (endpointCash < requested
        ? requested - endpointCash
        : 0n
      ).toString(),
      troughDeficitAfterQRaw: (troughCash < requested ? requested - troughCash : 0n).toString(),
    }
  })
  const rankedTrough = [...translatedWindows].sort((left, right) => {
    // Rank the observed historical drawdown itself. Replayed cash is floored
    // at zero, so ranking translated margins would collapse distinct source
    // windows whenever current cash is low and change which pair is selected.
    const drawdown = amount(left.troughCashDeltaRaw, true) - amount(right.troughCashDeltaRaw, true)
    return drawdown < 0n ? -1 : drawdown > 0n ? 1 : left.originBlock - right.originBlock
  })
  const p10Index = Math.floor((rankedTrough.length - 1) * 0.1)
  const rankedOutflow = [...translatedWindows].sort((left, right) => {
    const difference = amount(right.grossReserveOutRaw) - amount(left.grossReserveOutRaw)
    return difference < 0n ? -1 : difference > 0n ? 1 : left.originBlock - right.originBlock
  })
  const highestOutflow = rankedOutflow[0]
  const scenario = (window: (typeof translatedWindows)[number], rank: number) => ({
    ...window,
    rank,
    sampleCount: translatedWindows.length,
  })
  if (translatedWindows[0].originBlock !== summary.source.fromBlock)
    throw new Error('historical_flow_invalid_paired_window')
  const cashMargin = (delta: bigint) => {
    const translated = currentCash + delta
    return (translated < 0n ? 0n : translated) - requested
  }
  const troughMinimumDelta = amount(summary.exactWindowExtrema.minTroughCashDeltaRaw, true)
  const troughTranslated = currentCash + troughMinimumDelta
  return {
    study: summary.study,
    source: summary.source,
    horizonBlocks: summary.horizonBlocks,
    exactHorizonWindows: summary.exactHorizonWindows,
    nonoverlappingWindowCount: summary.nonoverlappingWindowCount,
    distributionScope: 'nonoverlapping_exact_windows' as const,
    pairedWindowSha256: summary.pairedWindowsSha256,
    historicalScenarios: {
      selection: 'retrospective_observed_rank_not_forecast_probability' as const,
      horizonBlocks: summary.horizonBlocks,
      sampleCount: translatedWindows.length,
      p10Trough: scenario(rankedTrough[p10Index], p10Index + 1),
      worstTrough: scenario(rankedTrough[0], 1),
      highestGrossOutflow: scenario(highestOutflow, 1),
    },
    currentCashMarginToRequestedRaw: (currentCash - requested).toString(),
    grossReserveInRaw: summary.nonoverlappingDistributions.grossReserveInRaw,
    grossReserveOutRaw: summary.nonoverlappingDistributions.grossReserveOutRaw,
    endpointMarginToRequestedRaw: distribution(
      summary.nonoverlappingDistributions.endpointCashDeltaRaw,
      cashMargin,
    ),
    troughMarginToRequestedRaw: distribution(
      summary.nonoverlappingDistributions.troughCashDeltaRaw,
      cashMargin,
    ),
    exactWindowExtrema: {
      maxGrossReserveInRaw: amount(summary.exactWindowExtrema.maxGrossReserveInRaw).toString(),
      maxGrossReserveOutRaw: amount(summary.exactWindowExtrema.maxGrossReserveOutRaw).toString(),
      minEndpointMarginToRequestedRaw: cashMargin(
        amount(summary.exactWindowExtrema.minEndpointCashDeltaRaw, true),
      ).toString(),
      minTroughMarginToRequestedRaw: cashMargin(troughMinimumDelta).toString(),
      maxTroughReplayDeficitRaw: (troughTranslated < 0n ? -troughTranslated : 0n).toString(),
    },
    interpretation: 'retrospective_unscaled_historical_replay' as const,
    validation: 'not_validated' as const,
    holderExecutableExit: false as const,
    withinHorizonDurationEstimated: false as const,
    withinHorizonDuration: null,
    flowMeasure: 'gross_reserve_in_and_out_including_supplier_and_other_flows' as const,
  }
}
