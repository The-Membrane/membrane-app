import { forecastSampledCapacity, type CapacitySnapshot } from '../venueForecast/sampledCapacity'
import type { FixedEntitlementCashInput } from './fixedEntitlementCashOutlook'

/** Qualified caller only: historical NET cash already includes competitors; M is additional. */
export function fixedEntitlementHistoricalRecovery(input: FixedEntitlementCashInput) {
  const question = { identity: input.history.identity, currentSource: input.currentSource,
    requestedRaw: input.requestedRaw, fullEntitlementRaw: input.fullEntitlementRaw,
    additionalCompetitionRaw: input.additionalCompetitionRaw, horizonHours: input.horizonHours,
    issuedAtUtc: input.issuedAtUtc, owner: undefined as string | undefined }
  const base = { schema: 'fixed_entitlement_historical_recovery_v1' as const, question,
    normalization: 'exact_raw_threshold_and_deficit_bands_checked_Q_relative' as const,
    calibratedProbability: false as const, holderExecutableExit: false as const,
    forecastValidated: false as const }
  const unavailable = (reason: string) => ({ ...base, result: null, unavailableReason: reason })
  const q = BigInt(input.requestedRaw), ea = BigInt(input.fullEntitlementRaw), m = BigInt(input.additionalCompetitionRaw)
  if (q === 0n) return unavailable('zero_requested_amount')
  if (ea < q) return unavailable('fixed_entitlement_below_requested')
  if (input.horizonHours < 1 || input.horizonHours > 720) return unavailable('historical_recovery_horizon_out_of_scope')
  const snapshots: CapacitySnapshot[] = []
  const issue = Date.parse(input.issuedAtUtc)
  const add = (cashRaw: string, observedAt: string, firstAvailableAt: string, sourceId: string) => {
    // Future availability never becomes an invalid present sample or an analogue donor.
    if (Date.parse(observedAt) > issue || Date.parse(firstAvailableAt) > issue) return true
    const cash = BigInt(cashRaw), afterM = cash > m ? cash - m : 0n
    const capacity = afterM < ea ? afterM : ea
    const value = Number(capacity) / Number(q)
    if (!Number.isFinite(value) || (capacity < q) !== (value < 1)) return false
    if (capacity < q) {
      const d = q - capacity
      const exact = d * 10n < q ? 0 : d * 4n < q ? 1 : d * 2n < q ? 2 : 3
      const deficit = 1 - value
      const approximate = deficit < 0.1 ? 0 : deficit < 0.25 ? 1 : deficit < 0.5 ? 2 : 3
      if (exact !== approximate) return false
    }
    snapshots.push({ observedAt, firstAvailableAt, capacityUsd: value, sourceId, coverage: 'complete' })
    return true
  }
  for (const p of input.history.points) {
    if (!add(p[4], p[3], input.history.witness.availableAt,
      `${p[1]}:${p[2]}:${input.history.identity.destination}:${input.history.identity.asset}`))
      return unavailable('raw_threshold_or_deficit_band_not_representable')
  }
  const s = input.currentSource
  if (!add(s.cashRaw, s.blockTime, s.readAt, `${s.block}:${s.blockHash}:${s.destination}:${s.asset}`))
    return unavailable('raw_threshold_or_deficit_band_not_representable')
  // No retrospective scenario clock: both current source and donors must be available at issue.
  // Regime is assumed unchanged, not claimed verified by a same-asset identity.
  const capacity = forecastSampledCapacity({ routeKey: s.routeKey + ':' + s.destination,
    metric: 'cash_units', amountUsd: 1, horizonHours: input.horizonHours, asOf: input.issuedAtUtc,
    maxGapHours: 25.5, maxObservationAgeHours: 0.5, snapshots })
  const result = capacity.duration.historicalRecovery ?? null
  return { ...base, result, unavailableReason: result ? null : capacity.reason ?? 'historical_recovery_missing' }
}
