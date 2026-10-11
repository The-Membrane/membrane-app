export type ConditionalTimeChannel = {
  key: string
  assetAddress: string
  decimals: number
  unit: string
  negativeHandling?: 'clamp_zero' | 'reject_scenario'
}
export type ConditionalTimeObservation = {
  sourceAtUtc: string
  availableAtUtc: string
  regime: string
  channels: ConditionalTimeChannel[]
  valuesByChannel: Record<string, string>
  provenanceRef: string
}
export type ConditionalTimeProcessInput = {
  channels: ConditionalTimeChannel[]
  observations: ConditionalTimeObservation[]
  outputAsset: { assetAddress: string; decimals: number }
  measurementRule: string
  current: {
    sourceAtUtc: string
    readAtUtc: string
    regime: string
    valuesByChannel: Record<string, string>
    provenanceRef: string
    fullEntitlementRaw?: string
  }
  issueAtUtc: string
  requestedRaw: string
  horizonHours: number
  maxHistoricalGapSeconds: number
}
export type ConditionalTimeQualifier = (privateInput: ConditionalTimeProcessInput) => boolean
export type ConditionalTimeMeasurement = (
  privateState: Record<string, string>,
  elapsedFromSourceMs: number,
) => { availableRaw: string; entitlementRaw: string | null }
const MAX = (1n << 256n) - 1n
const LIMITS = { observations: 256, intervals: 128, gridPoints: 128 } as const
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const boundedText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    )
  return Object.is(a, b)
}
function checked(v: bigint): bigint {
  if (v < -MAX || v > MAX) throw Error('native_intermediate_overflow')
  return v
}
function floor(n: bigint, d: bigint): bigint {
  const q = n / d
  return n < 0n && n % d !== 0n ? q - 1n : q
}
function validValues(v: unknown, keys: string[]): v is Record<string, string> {
  return (
    record(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k) && raw(v[k]))
  )
}
function grid(source: number, issue: number, target: number, cadence: number) {
  const slots = LIMITS.gridPoints - 1 - (source < issue ? 1 : 0)
  const stride = Math.max(1, Math.ceil(Math.ceil((target - issue) / cadence) / slots))
  const step = cadence * stride
  if (!Number.isSafeInteger(step) || step <= 0) return null
  const times = source < issue ? [source, issue] : [issue]
  for (let t = issue + step; t < target; t += step) times.push(t)
  times.push(target)
  return {
    times,
    historicalCadenceSeconds: cadence / 1000,
    gridStepSeconds: step / 1000,
    donorCadenceStride: stride,
    coarsenedForBoundedGrid: stride > 1,
    maximumPoints: LIMITS.gridPoints,
  }
}
function runs(points: { atUtc: string; headroomRaw: string }[]) {
  const episodes: {
    onset: { after: string | null; by: string }
    recovery: { after: string; by: string } | null
    leftCensored: boolean
    rightCensored: boolean
  }[] = []
  let onset: (typeof episodes)[number] | null = null
  points.forEach((p, i) => {
    if (BigInt(p.headroomRaw) < 0n && !onset)
      onset = {
        onset: { after: i ? points[i - 1].atUtc : null, by: p.atUtc },
        recovery: null,
        leftCensored: i === 0,
        rightCensored: true,
      }
    if (BigInt(p.headroomRaw) >= 0n && onset) {
      onset.recovery = { after: points[i - 1].atUtc, by: p.atUtc }
      onset.rightCensored = false
      episodes.push(onset)
      onset = null
    }
  })
  if (onset) episodes.push(onset)
  return episodes
}
function quantile(values: bigint[], numerator: number) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return String(sorted[Math.floor(((sorted.length - 1) * numerator) / 100)])
}
/** New issue-time paths under a declared constant historical NET-flow-rate assumption.
 * Qualification must bind actual current/history authority externally; this math authenticates neither.
 * Mechanical measurement must use current constants only, without adding historical index deltas twice. */
export function buildConditionalTimeProcess(
  supplied: ConditionalTimeProcessInput,
  qualify: ConditionalTimeQualifier,
  measure?: ConditionalTimeMeasurement,
) {
  try {
    const input = structuredClone(supplied)
    if (
      !record(input) ||
      !Array.isArray(input.channels) ||
      input.channels.length < 1 ||
      input.channels.length > 16 ||
      !Array.isArray(input.observations) ||
      input.observations.length < 2 ||
      input.observations.length > LIMITS.observations ||
      !record(input.current)
    )
      return null
    if (
      !record(input.outputAsset) ||
      typeof input.outputAsset.assetAddress !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(input.outputAsset.assetAddress) ||
      !Number.isSafeInteger(input.outputAsset.decimals) ||
      input.outputAsset.decimals < 0 ||
      input.outputAsset.decimals > 77 ||
      !boundedText(input.measurementRule)
    )
      return null
    const keys = input.channels.map((c) => c.key)
    if (
      new Set(keys).size !== keys.length ||
      input.channels.some(
        (c) =>
          !record(c) ||
          !boundedText(c.key) ||
          typeof c.assetAddress !== 'string' ||
          !/^0x[0-9a-f]{40}$/.test(c.assetAddress) ||
          !Number.isSafeInteger(c.decimals) ||
          c.decimals < 0 ||
          c.decimals > 77 ||
          !boundedText(c.unit) ||
          (c.negativeHandling !== undefined &&
            !['clamp_zero', 'reject_scenario'].includes(c.negativeHandling)),
      )
    )
      return null
    if (
      !utc(input.issueAtUtc) ||
      !utc(input.current.sourceAtUtc) ||
      !utc(input.current.readAtUtc) ||
      !boundedText(input.current.regime) ||
      !boundedText(input.current.provenanceRef) ||
      !validValues(input.current.valuesByChannel, keys) ||
      !raw(input.requestedRaw) ||
      input.requestedRaw === '0' ||
      typeof input.horizonHours !== 'number' ||
      !Number.isFinite(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760 ||
      !Number.isSafeInteger(input.horizonHours * 3600000) ||
      !Number.isSafeInteger(input.maxHistoricalGapSeconds) ||
      !Number.isSafeInteger(input.maxHistoricalGapSeconds * 1000) ||
      (input.current.fullEntitlementRaw !== undefined && !raw(input.current.fullEntitlementRaw)) ||
      input.maxHistoricalGapSeconds <= 0
    )
      return null
    const source = Date.parse(input.current.sourceAtUtc),
      read = Date.parse(input.current.readAtUtc),
      issue = Date.parse(input.issueAtUtc),
      target = issue + input.horizonHours * 3600000
    if (
      !Number.isSafeInteger(target) ||
      target > 8640000000000000 ||
      source > read ||
      read > issue ||
      issue - source > 1800000
    )
      return null
    for (let i = 0; i < input.observations.length; i++) {
      const o = input.observations[i]
      if (
        !record(o) ||
        !utc(o.sourceAtUtc) ||
        !utc(o.availableAtUtc) ||
        Date.parse(o.availableAtUtc) < Date.parse(o.sourceAtUtc) ||
        !boundedText(o.regime) ||
        !boundedText(o.provenanceRef) ||
        !Array.isArray(o.channels) ||
        !validValues(o.valuesByChannel, keys) ||
        (i > 0 && Date.parse(o.sourceAtUtc) <= Date.parse(input.observations[i - 1].sourceAtUtc))
      )
        return null
    }
    if (qualify(structuredClone(input)) !== true) return null
    if (
      !measure &&
      (keys.length !== 1 ||
        input.channels[0].negativeHandling !== 'clamp_zero' ||
        input.channels[0].assetAddress !== input.outputAsset.assetAddress ||
        input.channels[0].decimals !== input.outputAsset.decimals ||
        !raw(input.current.fullEntitlementRaw) ||
        input.measurementRule !== 'cash_clipped_by_qualified_full_entitlement_held_constant')
    )
      return null
    const excludedIntervals: { fromIndex: number; reason: string }[] = []
    const candidates: { fromIndex: number; dt: number; deltas: Record<string, string> }[] = []
    for (let i = 0; i < input.observations.length - 1; i++) {
      const a = input.observations[i],
        b = input.observations[i + 1],
        dt = Date.parse(b.sourceAtUtc) - Date.parse(a.sourceAtUtc)
      const reason =
        !Number.isSafeInteger(dt) || dt <= 0
          ? 'historical_clock_range'
          : Date.parse(b.sourceAtUtc) >= source
            ? 'not_strictly_before_current_source'
            : Date.parse(a.availableAtUtc) > issue || Date.parse(b.availableAtUtc) > issue
              ? 'not_available_at_issue'
              : a.regime !== input.current.regime || b.regime !== input.current.regime
                ? 'regime_mismatch'
                : !equal(a.channels, input.channels) || !equal(b.channels, input.channels)
                  ? 'channel_identity_mismatch'
                  : dt > input.maxHistoricalGapSeconds * 1000
                    ? 'historical_gap'
                    : null
      if (reason) {
        excludedIntervals.push({ fromIndex: i, reason })
        continue
      }
      candidates.push({
        fromIndex: i,
        dt,
        deltas: Object.fromEntries(
          keys.map((k) => [k, String(BigInt(b.valuesByChannel[k]) - BigInt(a.valuesByChannel[k]))]),
        ),
      })
    }
    if (!candidates.length || candidates.length > LIMITS.intervals) return null
    const scenarios = candidates.map((c) => {
      const a = input.observations[c.fromIndex],
        b = input.observations[c.fromIndex + 1],
        sampling = grid(source, issue, target, c.dt)
      const donor = {
        startAtUtc: a.sourceAtUtc,
        endAtUtc: b.sourceAtUtc,
        durationSeconds: c.dt / 1000,
        availableAtUtc: [a.availableAtUtc, b.availableAtUtc],
        provenanceRefs: [a.provenanceRef, b.provenanceRef],
        jointDeltaRaw: c.deltas,
        ratesByChannel: Object.fromEntries(
          keys.map((k) => [k, { numeratorRaw: c.deltas[k], denominatorMs: String(c.dt) }]),
        ),
      }
      const points: {
        atUtc: string
        elapsedFromSourceSeconds: number
        valuesByChannel: Record<string, string>
        availableRaw: string
        entitlementRaw: string | null
        capacityRaw: string
        headroomRaw: string
        clampedChannels: string[]
      }[] = []
      let reason: string | null = sampling ? null : 'grid_limit',
        censoredAtUtc: string | null = sampling ? null : input.issueAtUtc
      if (sampling)
        for (const t of sampling.times) {
          try {
            const state: Record<string, string> = {},
              clampedChannels: string[] = []
            for (const channel of input.channels) {
              const delta = BigInt(c.deltas[channel.key]),
                shift = floor(checked(delta * BigInt(t - source)), BigInt(c.dt))
              let v = checked(BigInt(input.current.valuesByChannel[channel.key]) + shift)
              if (v < 0n) {
                if (channel.negativeHandling === 'clamp_zero') {
                  v = 0n
                  clampedChannels.push(channel.key)
                } else throw Error('negative_joint_prong')
              }
              state[channel.key] = String(v)
            }
            const measured = measure
              ? structuredClone(measure(structuredClone(state), t - source))
              : { availableRaw: state[keys[0]], entitlementRaw: input.current.fullEntitlementRaw! }
            if (
              !record(measured) ||
              !raw(measured.availableRaw) ||
              (measured.entitlementRaw !== null && !raw(measured.entitlementRaw))
            )
              throw Error('measurement_invalid')
            const available = BigInt(measured.availableRaw),
              E = measured.entitlementRaw === null ? null : BigInt(measured.entitlementRaw),
              capacity = E === null || available < E ? available : E
            points.push({
              atUtc: new Date(t).toISOString(),
              elapsedFromSourceSeconds: (t - source) / 1000,
              valuesByChannel: state,
              availableRaw: measured.availableRaw,
              entitlementRaw: measured.entitlementRaw,
              capacityRaw: String(capacity),
              headroomRaw: String(capacity - BigInt(input.requestedRaw)),
              clampedChannels,
            })
          } catch (error) {
            reason =
              error instanceof Error &&
              [
                'native_intermediate_overflow',
                'negative_joint_prong',
                'measurement_invalid',
              ].includes(error.message)
                ? error.message
                : 'measurement_unavailable'
            censoredAtUtc = new Date(t).toISOString()
            break
          }
        }
      const valid = reason === null,
        heads = points.map((p) => BigInt(p.headroomRaw)),
        trough = heads.length ? heads.reduce((a, b) => (a < b ? a : b)) : null
      return {
        donor,
        sampling: sampling
          ? {
              historicalCadenceSeconds: sampling.historicalCadenceSeconds,
              gridStepSeconds: sampling.gridStepSeconds,
              donorCadenceStride: sampling.donorCadenceStride,
              coarsenedForBoundedGrid: sampling.coarsenedForBoundedGrid,
              maximumPoints: sampling.maximumPoints,
            }
          : null,
        status: valid ? ('conditional_path' as const) : ('censored_path' as const),
        reason,
        censoredAtUtc,
        points,
        targetHeadroomRaw: valid ? points.at(-1)!.headroomRaw : null,
        sampledTroughHeadroomRaw: trough === null ? null : String(trough),
        sampledShortfalls: runs(points),
        continuousPathKnown: false as const,
      }
    })
    const complete = scenarios.every((s) => s.status === 'conditional_path'),
      targetHeads = complete ? scenarios.map((s) => BigInt(s.targetHeadroomRaw!)) : []
    return {
      status: 'conditional_constant_net_flow_rate_process' as const,
      input,
      sourceAtUtc: input.current.sourceAtUtc,
      issueAtUtc: input.issueAtUtc,
      targetAtUtc: new Date(target).toISOString(),
      sourceProofValidUntil: new Date(source + 1800000).toISOString(),
      requestedRaw: input.requestedRaw,
      horizonHours: input.horizonHours,
      minimumHistoricalResolutionSeconds: Math.min(...candidates.map((c) => c.dt)) / 1000,
      horizonFinerThanHistory:
        input.horizonHours * 3600000 < Math.min(...candidates.map((c) => c.dt)),
      scenarios,
      excludedIntervals,
      targetSummary: complete
        ? {
            empiricalP10HeadroomRaw: quantile(targetHeads, 10),
            empiricalP90HeadroomRaw: quantile(targetHeads, 90),
            minimumHeadroomRaw: String(targetHeads.reduce((a, b) => (a < b ? a : b))),
            maximumHeadroomRaw: String(targetHeads.reduce((a, b) => (a > b ? a : b))),
            scenarioCount: scenarios.length,
          }
        : null,
      assumptions: {
        constantHistoricalNetFlowRate: true,
        interpolatedAndExtrapolatedFromActualDonorDuration: true,
        totalElapsedIncludesSourceAge: true,
        mechanicalMeasurementUsesCurrentParametersOnly: true,
        defaultFullEntitlementHeldConstant: !measure,
        measurementElapsedUnit: 'milliseconds',
        eligibilityAndRegimeUnchanged: true,
      },
      continuousPathKnown: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      holderExecutableExit: false as const,
      minedPayout: false as const,
      calibratedProbability: false as const,
      confidenceInterval: false as const,
    }
  } catch {
    return null
  }
}
export function selectedConditionalTimeProcess(
  value: unknown,
  expected: { input: ConditionalTimeProcessInput; asOfMs: number },
  qualify: ConditionalTimeQualifier,
  measure?: ConditionalTimeMeasurement,
) {
  try {
    const v = structuredClone(value),
      e = structuredClone(expected)
    if (
      !record(e) ||
      !record(e.input) ||
      !Number.isSafeInteger(e.asOfMs) ||
      !utc(e.input.issueAtUtc) ||
      !utc(e.input.current?.sourceAtUtc) ||
      e.asOfMs < Date.parse(e.input.issueAtUtc) ||
      e.asOfMs - Date.parse(e.input.current.sourceAtUtc) > 1800000 ||
      e.asOfMs >= Date.parse(e.input.issueAtUtc) + e.input.horizonHours * 3600000
    )
      return null
    const rebuilt = buildConditionalTimeProcess(e.input, qualify, measure)
    return rebuilt && equal(v, rebuilt) ? rebuilt : null
  } catch {
    return null
  }
}
