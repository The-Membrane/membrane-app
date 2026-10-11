import {
  forecastSampledCapacity,
  type CapacityForecastReason,
  type CapacitySnapshot,
} from '@/lib/venueForecast/sampledCapacity'

export type RouteCashSample = Omit<CapacitySnapshot, 'capacityUsd'> & {
  cashUnits: number | null
}

export type RouteCashForecastInput = {
  routeKey: string
  destination: string
  asset: string
  assetSymbol: string
  amountUnits: number
  horizonHours: number
  asOf: string
  snapshots: readonly RouteCashSample[]
  cashKind: 'vault_cash' | 'market_cash' | 'direct_buffer_only' | 'unassessed'
}

/** Unit-safe adapter: the shared chronological engine's arithmetic is dimensionless. */
export function forecastRouteCash(input: RouteCashForecastInput) {
  const firstReceiptMs = input.snapshots.reduce((first, row) => {
    const receipt = Date.parse(row.firstAvailableAt ?? '')
    return Number.isFinite(receipt) ? Math.min(first, receipt) : first
  }, Infinity)
  // Freeze the development/holdout boundary from enrollment, not from the
  // latest row. One independent training question occupies a full horizon.
  const splitAt = Number.isFinite(firstReceiptMs)
    ? new Date(firstReceiptMs + 100 * input.horizonHours * 3_600_000).toISOString()
    : undefined
  const result = forecastSampledCapacity({
    routeKey: `${input.routeKey}:${input.destination.toLowerCase()}`,
    metric: 'cash_units',
    // The engine predates unit-denominated routes; this adapter keeps its USD
    // field names out of the public API and never converts LINK or PT to $1.
    amountUsd: input.amountUnits,
    horizonHours: input.horizonHours,
    asOf: input.asOf,
    splitAt,
    // launchd's hourly starts drift a few minutes; an exact 60-minute path
    // cap would censor otherwise valid one-hour issue/target pairs.
    maxGapHours: input.horizonHours === 1 ? 1.25 : undefined,
    maxObservationAgeHours: 2,
    snapshots: input.snapshots.map((row) => ({
      ...row,
      capacityUsd: row.cashUnits,
    })),
  })

  return {
    status: result.status,
    reason: result.reason as CapacityForecastReason | null,
    claim: 'aggregate_cash_proxy_only' as const,
    holderExecutable: false as const,
    predictiveAlertEligible: false as const,
    routeKey: input.routeKey,
    destination: input.destination.toLowerCase(),
    asset: input.asset.toLowerCase(),
    assetSymbol: input.assetSymbol,
    cashKind: input.cashKind,
    amountUnits: input.amountUnits,
    horizonHours: input.horizonHours,
    asOf: input.asOf,
    current: result.current
      ? {
          cashUnits: result.current.capacityUsd,
          observedAt: result.current.observedAt,
          firstAvailableAt: result.current.firstAvailableAt,
          sourceId: result.current.sourceId,
        }
      : null,
    projection: result.projection
      ? {
          targetAt: result.projection.targetAt,
          method: result.projection.method,
          cashUnits: result.projection.capacityUsd,
          bandLowUnits: result.projection.bandLowUsd,
          bandHighUnits: result.projection.bandHighUsd,
          bandLevel: result.projection.bandLevel,
          relativeToAmount: result.projection.relativeToAmount,
        }
      : null,
    sourceSpan: result.sourceSpan,
    backtest: {
      splitAt: result.backtest.splitAt,
      embargoHours: result.backtest.embargoHours,
      fit: result.backtest.fit,
      calibration: result.backtest.calibration,
      holdout: {
        eligible: result.backtest.holdout.eligible,
        censored: result.backtest.holdout.censored,
        firstIssuedAt: result.backtest.holdout.firstIssuedAt,
        lastIssuedAt: result.backtest.holdout.lastIssuedAt,
        bandCoverage: result.backtest.holdout.bandCoverage,
        modelMaeUnits: result.backtest.holdout.modelMaeUsd,
        persistenceMaeUnits: result.backtest.holdout.persistenceMaeUsd,
        belowAmountEvents: result.backtest.holdout.belowAmountEvents,
        atOrAboveAmountControls: result.backtest.holdout.atOrAboveAmountControls,
      },
    },
    duration: result.duration,
  }
}
