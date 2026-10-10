export type SaturnConversionSource = {
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
  finalized: true
}
export type SaturnOwnedTicket = {
  owner: string
  ticketId: string
  sharesRaw18: string
  usdatOwedRaw6: string
  requestedAtUnix: string
  minSharePriceRaw: string
  status: number
  vaultPaused: boolean | null
  queuePaused: boolean | null
}
export type SaturnConversionPoint = {
  source: SaturnConversionSource
  usdcQuotedRaw: string | null
  ausdQuotedRaw: string | null
  status: 'conditional_quote' | 'incomplete'
  runtimeCodeHashes: { curve: string; pool: string; quoter: string; vault: string | null; queue: string | null }
  identityVerified: boolean
  ticket: SaturnOwnedTicket | null
  missingLegs: string[]
}
export type SaturnConversionHistory = {
  status: 'verified_two_origin_saturn_conversion_history'
  knowledgeCutoff: string
  captureReceiptSha256: string
  input: { usdatInputRaw: string; assetUSDat: string; assetDecimals: 6 }
  points: SaturnConversionPoint[]
  elapsedSeconds: number[]
}
export type SaturnConversionCurrent = {
  captureReceiptSha256: string
  readAtUtc: string
  input: SaturnConversionHistory['input']
  point: SaturnConversionPoint
  entitlementMethod: 'recorded_usdat_owed' | 'claim_return'
  physicalPullableUsdatRaw: string | null
  claimSimulation: 'success' | 'evm_revert' | 'unassessed'
  claimReturnUsdatRaw: string | null
}
export type SaturnHistoricalConversionInput = {
  mode: 'current_conditional' | 'historical_backtest'
  routeKey: string
  destination: string
  owner: string
  ticketId: string
  sharesRaw18: string
  requestedAusdRaw: string
  payoutAsset: string
  payoutDecimals: 6
  horizonHours: number
  current: SaturnConversionCurrent
  history: SaturnConversionHistory
  asOfMs: number
}
export type SaturnConversionEvidenceAcceptor = (
  kind: 'current' | 'history',
  receiptSha256: string,
  normalizedEvidence: SaturnConversionCurrent | SaturnConversionHistory,
) => boolean
const ROUTE = 'AUSD → Staked USDat [USDat]',
  VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
  USDAT = '0x23238f20b894f29041f48d88ee91131c395aaa71',
  AUSD = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const positive = (v: unknown): v is string => raw(v) && v !== '0'
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const codeHash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
function source(s: SaturnConversionSource) {
  return (
    record(s) &&
    s.chainId === 1 &&
    s.finalized === true &&
    positive(s.blockNumber) &&
    Number.isSafeInteger(Number(s.blockNumber)) &&
    codeHash(s.blockHash) &&
    utc(s.blockTime)
  )
}
function ticket(t: SaturnOwnedTicket | null) {
  return (
    record(t) &&
    address(t.owner) &&
    positive(t.ticketId) &&
    positive(t.sharesRaw18) &&
    positive(t.usdatOwedRaw6) &&
    positive(t.requestedAtUnix) &&
    raw(t.minSharePriceRaw) &&
    Number.isSafeInteger(t.status) &&
    t.status >= 0 &&
    t.status <= 255 &&
    [null, true, false].includes(t.vaultPaused) &&
    [null, true, false].includes(t.queuePaused)
  )
}
function point(p: SaturnConversionPoint) {
  return (
    record(p) &&
    source(p.source) &&
    record(p.runtimeCodeHashes) &&
    Object.keys(p.runtimeCodeHashes).length === 5 &&
    ['curve', 'pool', 'quoter'].every((k) =>
      codeHash(p.runtimeCodeHashes[k as keyof typeof p.runtimeCodeHashes]),
    ) &&
    ['vault', 'queue'].every((k) => {
      const v = p.runtimeCodeHashes[k as 'vault' | 'queue']
      return v === null || codeHash(v)
    }) &&
    typeof p.identityVerified === 'boolean' &&
    ['conditional_quote', 'incomplete'].includes(p.status) &&
    Array.isArray(p.missingLegs) &&
    p.missingLegs.every((x) => typeof x === 'string') &&
    (p.ticket === null ||
      (ticket(p.ticket) &&
        BigInt(p.ticket!.requestedAtUnix) * 1000n <= BigInt(Date.parse(p.source.blockTime)))) &&
    (p.status === 'conditional_quote'
      ? p.identityVerified &&
        positive(p.usdcQuotedRaw) &&
        positive(p.ausdQuotedRaw) &&
        p.missingLegs.length === 0
      : (p.usdcQuotedRaw === null || raw(p.usdcQuotedRaw)) &&
        (p.ausdQuotedRaw === null || raw(p.ausdQuotedRaw)))
  )
}
function conversionRuntime(a: SaturnConversionPoint, b: SaturnConversionPoint) {
  return (['curve', 'pool', 'quoter'] as const).every(
    (key) => a.runtimeCodeHashes[key] === b.runtimeCodeHashes[key],
  )
}
function nativeInput(i: SaturnConversionHistory['input']) {
  return record(i) && i.assetUSDat === USDAT && i.assetDecimals === 6 && positive(i.usdatInputRaw)
}
export function buildSaturnHistoricalConversionProjection(
  input: SaturnHistoricalConversionInput,
  accept: SaturnConversionEvidenceAcceptor,
) {
  try {
    const c = input.current,
      h = input.history,
      p = c.point,
      t = p.ticket
    if (
      !record(input) ||
      !['current_conditional', 'historical_backtest'].includes(input.mode) ||
      input.routeKey !== ROUTE ||
      input.destination !== VAULT ||
      !address(input.owner) ||
      !positive(input.ticketId) ||
      !positive(input.sharesRaw18) ||
      !positive(input.requestedAusdRaw) ||
      input.payoutAsset !== AUSD ||
      input.payoutDecimals !== 6 ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760 ||
      !Number.isSafeInteger(input.asOfMs) ||
      !record(c) ||
      !record(h) ||
      !hash(c.captureReceiptSha256) ||
      !hash(h.captureReceiptSha256) ||
      !utc(c.readAtUtc) ||
      !utc(h.knowledgeCutoff) ||
      Date.parse(c.readAtUtc) > input.asOfMs ||
      Date.parse(h.knowledgeCutoff) > input.asOfMs ||
      !nativeInput(c.input) ||
      !exact(c.input, h.input) ||
      !point(p) ||
      p.status !== 'conditional_quote' ||
      !codeHash(p.runtimeCodeHashes.vault) ||
      !codeHash(p.runtimeCodeHashes.queue) ||
      !ticket(t) ||
      t!.owner !== input.owner ||
      t!.ticketId !== input.ticketId ||
      t!.sharesRaw18 !== input.sharesRaw18 ||
      BigInt(t!.requestedAtUnix) * 1000n > BigInt(Date.parse(p.source.blockTime)) ||
      !['recorded_usdat_owed', 'claim_return'].includes(c.entitlementMethod) ||
      (c.entitlementMethod === 'claim_return' && c.claimSimulation !== 'success') ||
      !['success', 'evm_revert', 'unassessed'].includes(c.claimSimulation) ||
      (c.claimSimulation === 'success'
        ? !positive(c.claimReturnUsdatRaw) ||
          (c.entitlementMethod === 'recorded_usdat_owed' &&
            c.claimReturnUsdatRaw !== t!.usdatOwedRaw6)
        : c.claimReturnUsdatRaw !== null) ||
      (c.physicalPullableUsdatRaw !== null && !raw(c.physicalPullableUsdatRaw)) ||
      h.status !== 'verified_two_origin_saturn_conversion_history' ||
      !Array.isArray(h.points) ||
      h.points.length < 2 ||
      h.points.length > 6 ||
      !Array.isArray(h.elapsedSeconds) ||
      h.elapsedSeconds.length !== h.points.length ||
      !accept('current', c.captureReceiptSha256, c) ||
      !accept('history', h.captureReceiptSha256, h)
    )
      return null
    const conversionAmount =
        c.entitlementMethod === 'claim_return' ? c.claimReturnUsdatRaw! : t!.usdatOwedRaw6,
      entitled = BigInt(t!.usdatOwedRaw6),
      physical = c.physicalPullableUsdatRaw === null ? null : BigInt(c.physicalPullableUsdatRaw)
    if (
      conversionAmount !== c.input.usdatInputRaw ||
      Date.parse(p.source.blockTime) > Date.parse(c.readAtUtc)
    )
      return null
    const base = h.points[0],
      baseAt = Date.parse(base.source.blockTime),
      currentAt = Date.parse(p.source.blockTime)
    if (
      !point(base) ||
      base.status !== 'conditional_quote' ||
      h.elapsedSeconds[0] !== 0 ||
      !conversionRuntime(base, p)
    )
      return null
    if (
      input.mode === 'current_conditional' &&
      (input.asOfMs < currentAt || input.asOfMs - currentAt > 1800000)
    )
      return null
    if (input.mode === 'historical_backtest' && !exact(base.source, p.source)) return null
    const horizonMs = input.horizonHours * 3600000,
      sourceAgeMs = input.mode === 'current_conditional' ? input.asOfMs - currentAt : 0,
      projectionElapsedMs = sourceAgeMs + horizonMs,
      targetAt = new Date(currentAt + projectionElapsedMs).toISOString()
    // Public quote deltas are time-scaled at the same exact USDat input size;
    // historical ticket ownership supplies no current entitlement or funding.
    let broken = false
    const scenarios = h.points.slice(1).map((donor, i) => {
      const prior = h.points[i],
        elapsed = h.elapsedSeconds[i + 1]
      if (
        !point(donor) ||
        !Number.isSafeInteger(elapsed) ||
        elapsed <= h.elapsedSeconds[i] ||
        Date.parse(donor.source.blockTime) - baseAt !== elapsed * 1000 ||
        BigInt(donor.source.blockNumber) <= BigInt(prior.source.blockNumber) ||
        Date.parse(donor.source.blockTime) > Date.parse(h.knowledgeCutoff)
      )
        throw Error('invalid_donor')
      if (input.mode === 'current_conditional' && Date.parse(targetAt) <= input.asOfMs)
        throw Error('past_target')
      const compatible = conversionRuntime(donor, base)
      if (donor.status !== 'conditional_quote' || !compatible) broken = true
      if (broken)
        return {
          observation: i + 1,
          elapsedSeconds: elapsed,
          targetAt,
          status: 'gap_censored' as const,
          quotedFinalAusdRaw: null,
          requestedHeadroomAusdRaw: null,
          runtimeCompatible: compatible,
        }
      const numerator =
          (BigInt(donor.ausdQuotedRaw!) - BigInt(base.ausdQuotedRaw!)) * BigInt(projectionElapsedMs),
        denominator = BigInt(elapsed) * 1000n,
        // BigInt division truncates toward zero: floor falling quotes conservatively.
        delta = numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n),
        translated = BigInt(p.ausdQuotedRaw!) + delta,
        amount = translated < 0n ? 0n : translated
      if (amount >= 1n << 256n) throw Error('quote_overflow')
      return {
        observation: i + 1,
        elapsedSeconds: elapsed,
        targetAt,
        status: 'conditional_quote' as const,
        quotedFinalAusdRaw: amount.toString(),
        requestedHeadroomAusdRaw: (amount - BigInt(input.requestedAusdRaw)).toString(),
        runtimeCompatible: compatible,
      }
    })
    return {
      status: 'conditional_saturn_historical_conversion_projection' as const,
      input: structuredClone(input),
      issuedAt: new Date(input.asOfMs).toISOString(),
      targetAt,
      sourceAgeMs,
      horizonMs,
      projectionElapsedMs,
      historicalOwnershipRequired: false as const,
      scope: 'if_delivered_exact_current_owned_ticket_conversion_amount_quote' as const,
      method: 'same_usdat_size_historical_ausd_quote_delta_rate_at_issue_time_plus_h_floor_zero_then_q_once' as const,
      recordedOwnedUsdatOwedRaw: t!.usdatOwedRaw6,
      amountBasis:
        c.claimSimulation === 'success'
          ? ('claim_simulated_net_amount' as const)
          : ('recorded_owed_amount_if_delivered' as const),
      recordedStatusInterpretation: 'unverified' as const,
      claimFeeDeduction:
        c.claimSimulation === 'success'
          ? ('included_in_simulated_return' as const)
          : ('unknown' as const),
      conversionInputUsdatRaw: c.input.usdatInputRaw,
      physicalFunding:
        physical === null
          ? ('unknown' as const)
          : physical >= entitled
            ? ('sufficient_for_recorded_amount' as const)
            : ('insufficient_for_recorded_amount' as const),
      observedPauseFacts: { vaultPaused: t!.vaultPaused, queuePaused: t!.queuePaused },
      currentClaimability:
        c.claimSimulation === 'success'
          ? ('simulated_current_claim_only' as const)
          : t!.vaultPaused === true || t!.queuePaused === true
            ? ('pause_observed_claim_unassessed_or_reverted' as const)
            : ('unassessed_or_reverted' as const),
      futureQueueRelease: 'unknown_censored' as const,
      queueMinimumPriceEligibility: 'unverified_recorded_restriction' as const,
      assumption:
        'if_released_and_funded_extrapolate_constant_exact_size_historical_final_quote_change_rate_over_source_age_plus_h_even_beyond_observed_period' as const,
      evaluationScope: input.mode === 'historical_backtest'
        ? ('retrospective_replay_with_later_knowledge_cutoff' as const)
        : ('conditional_future_exact_size_quote_rate_extrapolation' as const),
      retrospectiveReplay: input.mode === 'historical_backtest',
      chronologicalBacktestValidated: false as const,
      futurePoolInventoryBounded: false as const,
      futureMarketPriceBounded: false as const,
      predictivePlausibilityEstablished: false as const,
      sourceEquivalence: 'unverified' as const,
      runtimeRegime: scenarios.every((s) => s.runtimeCompatible)
        ? ('same_observed_runtime_hashes' as const)
        : ('changed_runtime_gap' as const),
      sourceProofValidUntil:
        input.mode === 'current_conditional' ? new Date(currentAt + 1800000).toISOString() : null,
      scenarios,
      gapCensored: scenarios.some((s) => s.status === 'gap_censored'),
      holderCapacity: false,
      holderExecutableExit: false,
      integratedClaimSwapExecution: false,
      minedFinalPayout: false,
      forwardProbability: false,
      calibrated: false,
      grossFlowAdded: false,
    }
  } catch {
    return null
  }
}
export type SaturnHistoricalConversionProjection = NonNullable<
  ReturnType<typeof buildSaturnHistoricalConversionProjection>
>
export function selectedSaturnHistoricalConversionProjection(
  value: unknown,
  expected: SaturnHistoricalConversionInput,
  accept: SaturnConversionEvidenceAcceptor,
): SaturnHistoricalConversionProjection | null {
  try {
    if (!record(value) || !utc(value.issuedAt) || Date.parse(value.issuedAt) > expected.asOfMs)
      return null
    if (!buildSaturnHistoricalConversionProjection(expected, accept)) return null
    const issued = buildSaturnHistoricalConversionProjection(
      { ...expected, asOfMs: Date.parse(value.issuedAt) },
      accept,
    )
    return issued && exact(value, issued) ? issued : null
  } catch {
    return null
  }
}
