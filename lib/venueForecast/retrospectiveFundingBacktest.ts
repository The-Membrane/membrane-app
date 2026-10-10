/** Offline reconstruction only. Acquisition clocks never become historical live issue clocks. */
export type FundingHistoryPoint = {
  anchor: number
  sourceAtUtc: string
  availableAtUtc: string
  provenanceRef: string
  valuesByChannel: Record<string, string>
}
export type RetrospectiveFundingInput = {
  analysisAtUtc: string
  simulatedIssueAtUtc: string
  horizonHours: number
  outcomeToleranceSeconds: number
  maxGapSeconds: number
  channels: { key: string; assetAddress: string; decimals: number }[]
  history: FundingHistoryPoint[]
  sourceIndex: number
  outcomeIndex: number
  /** Diagnostic native thresholds; these are NOT authenticated holder Q. */
  thresholdsByChannel?: Record<string, string[]>
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const checked = (v: bigint) => {
  if (v < -MAX || v > MAX) throw Error('native_intermediate_overflow')
  return v
}
const floor = (n: bigint, d: bigint) => n / d - (n < 0n && n % d !== 0n ? 1n : 0n)
const quantile = (xs: bigint[], p: number) => {
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(((sorted.length - 1) * p) / 100)]
}
/** Authentication is supplied by the offline adapter against immutable external byte/body pins.
 * Actual outcomes are read only after donor predictions have been constructed. */
export function retrospectiveFundingFold(
  supplied: RetrospectiveFundingInput,
  authenticateHistory: (input: RetrospectiveFundingInput) => boolean,
) {
  const input = structuredClone(supplied)
  const base = {
    label: 'retrospective_reconstructed_analysis' as const,
    scope: 'funding_only' as const,
    holderFacts: 'holder_facts_unavailable' as const,
    prospectiveValidated: false,
    calibratedProbability: false,
    probability: null,
    analysisAtUtc: input.analysisAtUtc,
    simulatedIssueAtUtc: input.simulatedIssueAtUtc,
  }
  const censor = (reason: string) => ({ ...base, status: 'censored' as const, reason })
  if (
    !utc(input.analysisAtUtc) ||
    !utc(input.simulatedIssueAtUtc) ||
    !Number.isFinite(input.horizonHours) ||
    input.horizonHours <= 0 ||
    !Number.isSafeInteger(input.horizonHours * 3600000) ||
    !Number.isSafeInteger(input.outcomeToleranceSeconds) ||
    input.outcomeToleranceSeconds < 0 ||
    !Number.isSafeInteger(input.maxGapSeconds) ||
    input.maxGapSeconds <= 0 ||
    input.maxGapSeconds > 604800 ||
    input.outcomeToleranceSeconds * 2 >= input.horizonHours * 3600 ||
    !Array.isArray(input.channels) ||
    input.channels.length < 1 ||
    input.channels.length > 16 ||
    !Array.isArray(input.history) ||
    input.history.length < 3 ||
    input.history.length > 256 ||
    !Number.isInteger(input.sourceIndex) ||
    !Number.isInteger(input.outcomeIndex) ||
    input.sourceIndex < 2 ||
    input.outcomeIndex <= input.sourceIndex ||
    input.outcomeIndex >= input.history.length
  )
    return censor('invalid_input')
  const keys = input.channels.map((c) => c.key)
  if (
    new Set(keys).size !== keys.length ||
    input.channels.some(
      (c) =>
        !/^[a-zA-Z0-9_]{1,64}$/.test(c.key) ||
        !/^0x[0-9a-f]{40}$/.test(c.assetAddress) ||
        !Number.isInteger(c.decimals) ||
        c.decimals < 0 ||
        c.decimals > 36,
    )
  )
    return censor('invalid_channels')
  const analysis = Date.parse(input.analysisAtUtc),
    issue = Date.parse(input.simulatedIssueAtUtc)
  const target = issue + input.horizonHours * 3600000
  if (!Number.isSafeInteger(target) || issue > analysis || target > analysis)
    return censor('analysis_before_outcome')
  for (const [i, p] of input.history.entries()) {
    if (
      !Number.isSafeInteger(p.anchor) ||
      p.anchor < 0 ||
      !utc(p.sourceAtUtc) ||
      !utc(p.availableAtUtc) ||
      typeof p.provenanceRef !== 'string' ||
      !p.provenanceRef ||
      p.provenanceRef.length > 256 ||
      !p.valuesByChannel ||
      Object.keys(p.valuesByChannel).length !== keys.length ||
      keys.some((k) => !raw(p.valuesByChannel[k])) ||
      Date.parse(p.sourceAtUtc) > Date.parse(p.availableAtUtc)
    )
      return censor('invalid_history')
    if (Date.parse(p.availableAtUtc) > analysis) return censor('history_not_acquired_at_analysis')
    if (
      i &&
      (p.anchor <= input.history[i - 1].anchor ||
        Date.parse(p.sourceAtUtc) <= Date.parse(input.history[i - 1].sourceAtUtc))
    )
      return censor('chronological_leak_or_order')
  }
  if (
    input.thresholdsByChannel &&
    (Object.keys(input.thresholdsByChannel).some((k) => !keys.includes(k)) ||
      Object.values(input.thresholdsByChannel).some(
        (xs) => !Array.isArray(xs) || xs.length > 32 || xs.some((x) => !raw(x)),
      ))
  )
    return censor('invalid_thresholds')
  // Do not grant the adapter permission to mutate the snapshot used for scoring.
  if (!authenticateHistory(structuredClone(input))) return censor('history_authentication_failed')
  const source = input.history[input.sourceIndex],
    outcome = input.history[input.outcomeIndex]
  const sourceAt = Date.parse(source.sourceAtUtc),
    outcomeAt = Date.parse(outcome.sourceAtUtc)
  if (sourceAt > issue) return censor('source_after_simulated_issue')
  if (
    input.history[input.sourceIndex + 1] &&
    Date.parse(input.history[input.sourceIndex + 1].sourceAtUtc) <= issue
  )
    return censor('source_not_latest_at_issue')
  if (Math.abs(outcomeAt - target) > input.outcomeToleranceSeconds * 1000 || outcomeAt <= issue)
    return censor('outcome_outside_tolerance')
  for (let i = input.sourceIndex + 1; i <= input.outcomeIndex; i++) {
    const a = input.history[i - 1],
      b = input.history[i]
    if (
      b.anchor !== a.anchor + 1 ||
      Date.parse(b.sourceAtUtc) - Date.parse(a.sourceAtUtc) > input.maxGapSeconds * 1000
    )
      return censor('outcome_gap')
  }
  const elapsed = target - sourceAt // source age appears exactly once
  const scenarios: {
    donorStartAnchor: number
    donorEndAnchor: number
    donorEndAtUtc: string
    predictionByChannel: Record<string, string>
  }[] = []
  for (let end = 1; end < input.sourceIndex; end++) {
    const a = input.history[end - 1],
      b = input.history[end]
    const duration = Date.parse(b.sourceAtUtc) - Date.parse(a.sourceAtUtc)
    if (Date.parse(b.sourceAtUtc) >= issue) return censor('donor_not_strictly_before_issue')
    if (b.anchor !== a.anchor + 1 || duration > input.maxGapSeconds * 1000)
      return censor('donor_gap')
    const predictionByChannel: Record<string, string> = {}
    try {
      for (const key of keys) {
        const delta = BigInt(b.valuesByChannel[key]) - BigInt(a.valuesByChannel[key])
        const translated = checked(
          BigInt(source.valuesByChannel[key]) +
            floor(checked(delta * BigInt(elapsed)), BigInt(duration)),
        )
        predictionByChannel[key] = String(translated < 0n ? 0n : translated)
      }
    } catch {
      return censor('native_intermediate_overflow')
    }
    scenarios.push({
      donorStartAnchor: a.anchor,
      donorEndAnchor: b.anchor,
      donorEndAtUtc: b.sourceAtUtc,
      predictionByChannel,
    })
  }
  const comparisonByChannel = Object.fromEntries(
    keys.map((key) => {
      const xs = scenarios.map((s) => BigInt(s.predictionByChannel[key]))
      const actual = BigInt(outcome.valuesByChannel[key]),
        persistence = BigInt(source.valuesByChannel[key])
      const p10 = quantile(xs, 10),
        median = quantile(xs, 50),
        p90 = quantile(xs, 90)
      const error = median - actual,
        persistenceError = persistence - actual
      return [
        key,
        {
          prediction: { p10Raw: String(p10), medianRaw: String(median), p90Raw: String(p90) },
          actualRaw: String(actual),
          persistenceRaw: String(persistence),
          signedErrorRaw: String(error),
          absoluteErrorRaw: String(error < 0n ? -error : error),
          persistenceSignedErrorRaw: String(persistenceError),
          persistenceAbsoluteErrorRaw: String(
            persistenceError < 0n ? -persistenceError : persistenceError,
          ),
          empiricalBandContainsActual: actual >= p10 && actual <= p90,
          thresholdCoverage: (input.thresholdsByChannel?.[key] ?? []).map((q) => ({
            diagnosticThresholdRaw: q,
            holderQ: false,
            actualCovers: actual >= BigInt(q),
            scenarioCoverage: {
              numerator: xs.filter((x) => x >= BigInt(q)).length,
              denominator: xs.length,
            },
          })),
        },
      ]
    }),
  )
  return {
    ...base,
    status: 'scored' as const,
    horizonHours: input.horizonHours,
    targetAtUtc: new Date(target).toISOString(),
    outcomeAtUtc: outcome.sourceAtUtc,
    outcomeOffsetSeconds: (outcomeAt - target) / 1000,
    sourceAtUtc: source.sourceAtUtc,
    sourceAgeSeconds: (issue - sourceAt) / 1000,
    acquisitionClocks: input.history.map((p) => ({
      anchor: p.anchor,
      availableAtUtc: p.availableAtUtc,
      provenanceRef: p.provenanceRef,
    })),
    scenarioCount: scenarios.length,
    scenarios,
    comparisonByChannel,
  }
}
