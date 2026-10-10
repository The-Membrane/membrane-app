import { keccak256, stringToHex } from 'viem'
import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'

export const FLUID_USDT_BRIDGE = '0x273da948aca9261043fbdb2a857bc255ecc29012' as const
export const FLUID_USDT_INPUT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
export const FLUID_USDT_OUTPUT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as const
export const FLUID_USDT_POOL = '0x3416cf6c708da44db2624d63ea0aaef7113527c6' as const
export const FLUID_USDT_FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984' as const
export const FLUID_USDT_QUOTER = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e' as const
export const FLUID_USDT_PRONGS = [
  'bridgeFunding',
  'bankCash',
  'bankSupply',
  'bankWithdrawableUntilLimit',
  'bankResolverWithdrawable',
] as const
export const FLUID_USDT_RUNTIME_ADDRESSES = [
  FLUID_USDT_BRIDGE,
  '0xe16ccc91a8134d428e7b6240177f9e2b227b9743',
  '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
  '0x52aa899454998be5b000ad077a46bbe360f4e497',
  '0xca13a15de31235a37134b4717021c35a3cf25c60',
  FLUID_USDT_INPUT,
  FLUID_USDT_OUTPUT,
  FLUID_USDT_POOL,
  FLUID_USDT_FACTORY,
  FLUID_USDT_QUOTER,
] as const
export type FluidUsdtBridgeJointSource = {
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
}
export type FluidUsdtBridgeJointFrame = {
  source: FluidUsdtBridgeJointSource
  acquiredAtUtc: string
  availableAtUtc: string
  provenanceRef: string
  profileId: string
  holderSharesRaw: string
  shareDecimals: 18
  fullHolderNetUsdcRaw: string
  nativeProngs: Record<(typeof FLUID_USDT_PRONGS)[number], string>
  withdrawalFeeBps: number
  paused: boolean
  runtimeCodeHashes: Record<string, string>
  sourceClass: 'captured_identical_runtimes_only'
  owner: string | null
  historicalOwnership: false
  provenanceKind: 'native_hypothetical_shares' | 'native_current_full_position'
  conversion: {
    factory: typeof FLUID_USDT_FACTORY
    quoter: typeof FLUID_USDT_QUOTER
    pool: typeof FLUID_USDT_POOL
    fee: 100
    method: 'quoteExactOutputSingle'
    inputAsset: typeof FLUID_USDT_INPUT
    inputDecimals: 6
    outputAsset: typeof FLUID_USDT_OUTPUT
    outputDecimals: 6
    fixedFinalUsdtOutputRaw: string
    requiredNetUsdcRaw: string
  }
}
export type FluidUsdtBridgeJointLiveTimeInput = {
  routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]'
  destination: typeof FLUID_USDT_BRIDGE
  inputAsset: typeof FLUID_USDT_INPUT
  inputDecimals: 6
  outputAsset: typeof FLUID_USDT_OUTPUT
  outputDecimals: 6
  owner: string | null
  requestedFinalUsdtRaw: string
  profileId: string
  issueAtUtc: string
  knowledgeCutoffUtc: string
  horizonHours: number
  maxHistoricalGapSeconds: 91800
  current: FluidUsdtBridgeJointFrame & { readAtUtc: string }
  history: FluidUsdtBridgeJointFrame[]
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && v !== '0x' + '0'.repeat(40)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function copyPlain(value: unknown) {
  let nodes = 0,
    bytes = 0
  const ancestors = new Set<object>()
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 24) throw Error('input_bound')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw Error('number')
      return v
    }
    if (typeof v === 'string') {
      bytes += v.length * 2
      if (bytes > 524288) throw Error('bytes')
      return v
    }
    if (!v || typeof v !== 'object' || ancestors.has(v) || Object.getOwnPropertySymbols(v).length)
      throw Error('plain')
    const ds = Object.getOwnPropertyDescriptors(v),
      array = Array.isArray(v),
      proto = Object.getPrototypeOf(v)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw Error('prototype')
    ancestors.add(v)
    try {
      if (array) {
        if (v.length > 512 || Object.keys(ds).length !== v.length + 1) throw Error('dense')
        return Array.from({ length: v.length }, (_, n) => {
          const d = ds[String(n)]
          if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('accessor')
          return copy(d.value, depth + 1)
        })
      }
      const out: Record<string, unknown> = {}
      if (Object.keys(ds).length > 64) throw Error('keys')
      for (const [k, d] of Object.entries(ds)) {
        bytes += k.length * 2
        if (
          k.length > 256 ||
          bytes > 524288 ||
          !d.enumerable ||
          !Object.hasOwn(d, 'value') ||
          ['__proto__', 'constructor', 'prototype'].includes(k)
        )
          throw Error('accessor')
        out[k] = copy(d.value, depth + 1)
      }
      return out
    } finally {
      ancestors.delete(v)
    }
  }
  return copy(value, 0)
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function frame(f: FluidUsdtBridgeJointFrame) {
  const s = f?.source,
    c = f?.conversion
  return (
    !!s &&
    s.chainId === 1 &&
    raw(s.blockNumber) &&
    s.blockNumber !== '0' &&
    hash(s.blockHash) &&
    utc(s.blockTime) &&
    Date.parse(s.blockTime) % 1000 === 0 &&
    utc(f.acquiredAtUtc) &&
    utc(f.availableAtUtc) &&
    Date.parse(s.blockTime) <= Date.parse(f.acquiredAtUtc) &&
    Date.parse(f.acquiredAtUtc) <= Date.parse(f.availableAtUtc) &&
    text(f.profileId) &&
    text(f.provenanceRef) &&
    raw(f.holderSharesRaw) &&
    f.holderSharesRaw !== '0' &&
    f.shareDecimals === 18 &&
    raw(f.fullHolderNetUsdcRaw) &&
    Number.isSafeInteger(f.withdrawalFeeBps) &&
    f.withdrawalFeeBps >= 0 &&
    f.withdrawalFeeBps < 10000 &&
    typeof f.paused === 'boolean' &&
    f.sourceClass === 'captured_identical_runtimes_only' &&
    f.historicalOwnership === false &&
    (f.owner === null || address(f.owner)) &&
    ['native_hypothetical_shares', 'native_current_full_position'].includes(f.provenanceKind) &&
    !Object.hasOwn(f, 'originalIssue') &&
    record(f.nativeProngs) &&
    Object.keys(f.nativeProngs).length === 5 &&
    FLUID_USDT_PRONGS.every((k) => raw(f.nativeProngs[k])) &&
    record(f.runtimeCodeHashes) &&
    Object.keys(f.runtimeCodeHashes).length === 10 &&
    FLUID_USDT_RUNTIME_ADDRESSES.every((a) => hash(f.runtimeCodeHashes[a])) &&
    c?.factory === FLUID_USDT_FACTORY &&
    c.quoter === FLUID_USDT_QUOTER &&
    c.pool === FLUID_USDT_POOL &&
    c.fee === 100 &&
    c.method === 'quoteExactOutputSingle' &&
    c.inputAsset === FLUID_USDT_INPUT &&
    c.inputDecimals === 6 &&
    c.outputAsset === FLUID_USDT_OUTPUT &&
    c.outputDecimals === 6 &&
    raw(c.fixedFinalUsdtOutputRaw) &&
    c.fixedFinalUsdtOutputRaw !== '0' &&
    raw(c.requiredNetUsdcRaw) &&
    c.requiredNetUsdcRaw !== '0'
  )
}
function regime(f: FluidUsdtBridgeJointFrame) {
  return keccak256(
    stringToHex(
      JSON.stringify([
        f.profileId,
        f.paused,
        f.withdrawalFeeBps,
        f.shareDecimals,
        Object.entries(f.runtimeCodeHashes).sort(([a], [b]) => a.localeCompare(b)),
        f.conversion.factory,
        f.conversion.quoter,
        f.conversion.pool,
        f.conversion.fee,
        f.conversion.method,
        f.conversion.inputAsset,
        f.conversion.inputDecimals,
        f.conversion.outputAsset,
        f.conversion.outputDecimals,
      ]),
    ),
  )
}
function values(f: FluidUsdtBridgeJointFrame) {
  return {
    ...f.nativeProngs,
    fullEa: f.fullHolderNetUsdcRaw,
    requiredUsdc: f.conversion.requiredNetUsdcRaw,
  }
}
const channels = [...FLUID_USDT_PRONGS, 'fullEa', 'requiredUsdc'].map((key) => ({
  key,
  assetAddress: FLUID_USDT_INPUT,
  decimals: 6,
  unit:
    key === 'fullEa'
      ? 'net_native_USDC'
      : key === 'requiredUsdc'
        ? 'native_USDC_cost_for_fixed_USDT_Q'
        : 'gross_native_USDC',
  negativeHandling: 'reject_scenario' as const,
}))
function measure(state: Record<string, string>, fee: number) {
  const gross = FLUID_USDT_PRONGS.map((k) => BigInt(state[k])).reduce((a, b) => (a < b ? a : b))
  const product = gross * BigInt(10000 - fee)
  if (product > MAX) throw Error('fee_intermediate_overflow')
  const funding = product / 10000n,
    E = BigInt(state.fullEa),
    R = BigInt(state.requiredUsdc)
  if (R <= 0n) throw Error('nonpositive_conversion_cost')
  const C = funding < E ? funding : E
  return {
    fundingNetUsdcRaw: String(funding),
    fullNetUsdcEaRaw: String(E),
    clippedNetUsdcRaw: String(C),
    requiredNetUsdcRaw: String(R),
    marginUsdcRaw: String(C - R),
  }
}
export type FluidUsdtBridgeJointMarginPoint = ReturnType<typeof measure> & {
  atUtc: string
  elapsedFromIssueSeconds: number
  elapsedFromSourceSeconds: number
  valuesByChannel: Record<string, string>
}
type Bracket = {
  after: string | null
  by: string
  afterIssueSeconds: number | null
  byIssueSeconds: number
}
function shortfalls(points: FluidUsdtBridgeJointMarginPoint[], issue: number) {
  const episodes: {
    onset: Bracket
    recovery: Bracket | null
    leftCensored: boolean
    rightCensored: boolean
  }[] = []
  let active: (typeof episodes)[number] | null = null
  const bracket = (after: string | null, by: string): Bracket => ({
    after,
    by,
    afterIssueSeconds: after === null ? null : (Date.parse(after) - issue) / 1000,
    byIssueSeconds: (Date.parse(by) - issue) / 1000,
  })
  points.forEach((p, n) => {
    if (BigInt(p.marginUsdcRaw) < 0n && !active)
      active = {
        onset: bracket(n ? points[n - 1].atUtc : null, p.atUtc),
        recovery: null,
        leftCensored: n === 0,
        rightCensored: true,
      }
    if (BigInt(p.marginUsdcRaw) >= 0n && active) {
      active.recovery = bracket(points[n - 1].atUtc, p.atUtc)
      active.rightCensored = false
      episodes.push(active)
      active = null
    }
  })
  if (active) episodes.push(active)
  return episodes
}
function band(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    p10Raw: String(sorted[Math.floor((sorted.length - 1) * 0.1)]),
    p90Raw: String(sorted[Math.ceil((sorted.length - 1) * 0.9)]),
    minimumRaw: String(sorted[0]),
    maximumRaw: String(sorted.at(-1)!),
    scenarioCount: sorted.length,
    method: 'empirical_lower_floor_upper_ceil_order_statistics_uncalibrated' as const,
  }
}
/** Structural research math only. This function never grants native/original/private authority. */
export function buildFluidUsdtBridgeJointLiveTimeProcess(
  supplied: FluidUsdtBridgeJointLiveTimeInput,
) {
  try {
    const i = copyPlain(supplied) as FluidUsdtBridgeJointLiveTimeInput,
      c = i.current
    if (
      i.routeKey !== 'USDT → FluidBridgeAggregatorProxy [USDC]' ||
      i.destination !== FLUID_USDT_BRIDGE ||
      i.inputAsset !== FLUID_USDT_INPUT ||
      i.inputDecimals !== 6 ||
      i.outputAsset !== FLUID_USDT_OUTPUT ||
      i.outputDecimals !== 6 ||
      (i.owner !== null && !address(i.owner)) ||
      !text(i.profileId) ||
      !raw(i.requestedFinalUsdtRaw) ||
      i.requestedFinalUsdtRaw === '0' ||
      !utc(i.issueAtUtc) ||
      !utc(i.knowledgeCutoffUtc) ||
      !Number.isSafeInteger(i.horizonHours) ||
      i.horizonHours < 1 ||
      i.horizonHours > 8760 ||
      i.maxHistoricalGapSeconds !== 91800 ||
      !Array.isArray(i.history) ||
      i.history.length < 2 ||
      i.history.length > 129 ||
      !frame(c) ||
      c.paused ||
      c.owner !== i.owner ||
      c.profileId !== i.profileId ||
      c.conversion.fixedFinalUsdtOutputRaw !== i.requestedFinalUsdtRaw ||
      !utc(c.readAtUtc) ||
      Date.parse(c.readAtUtc) > Date.parse(c.acquiredAtUtc) ||
      i.history.some(
        (p, n) =>
          !frame(p) ||
          p.owner !== null ||
          p.provenanceKind !== 'native_hypothetical_shares' ||
          (n > 0 &&
            (BigInt(p.source.blockNumber) <= BigInt(i.history[n - 1].source.blockNumber) ||
              Date.parse(p.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime) ||
              p.source.blockHash === i.history[n - 1].source.blockHash)),
      )
    )
      return null
    const source = Date.parse(c.source.blockTime),
      issue = Date.parse(i.issueAtUtc),
      read = Date.parse(c.readAtUtc)
    const cutoff = Math.max(
      Date.parse(c.availableAtUtc),
      ...i.history.map((p) => Date.parse(p.availableAtUtc)),
    )
    if (
      source > read ||
      read > issue ||
      issue - source > 1800000 ||
      cutoff > issue ||
      Date.parse(i.knowledgeCutoffUtc) !== cutoff
    )
      return null
    const sourceMeasurement = measure(values(c), c.withdrawalFeeBps),
      currentRegime = regime(c)
    const excludedIntervals: {
      fromIndex: number
      reason: string
      donorSources: FluidUsdtBridgeJointSource[]
    }[] = []
    type Engine = NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
    const scenarios: {
      fromIndex: number
      donorSources: FluidUsdtBridgeJointSource[]
      donor: Engine['scenarios'][number]['donor']
      sampling: Engine['scenarios'][number]['sampling']
      status: 'conditional_path' | 'censored_path'
      reason: string | null
      censoredAtUtc: string | null
      points: FluidUsdtBridgeJointMarginPoint[]
      issueMarginUsdcRaw: string | null
      targetMarginUsdcRaw: string | null
      targetMinusIssueMarginUsdcRaw: string | null
      sampledTroughMarginUsdcRaw: string | null
      sampledShortfalls: ReturnType<typeof shortfalls> | null
      firstLoss: Bracket | null
      firstRecovery: Bracket | null
      continuousPathKnown: false
    }[] = []
    for (let n = 0; n < i.history.length - 1; n++) {
      const a = i.history[n],
        b = i.history[n + 1],
        donorSources = [a.source, b.source]
      const exclusionReason =
        a.holderSharesRaw !== c.holderSharesRaw || b.holderSharesRaw !== c.holderSharesRaw
          ? 'same_full_share_position_mismatch'
          : a.conversion.fixedFinalUsdtOutputRaw !== i.requestedFinalUsdtRaw ||
              b.conversion.fixedFinalUsdtOutputRaw !== i.requestedFinalUsdtRaw
            ? 'fixed_final_USDT_question_mismatch'
            : regime(a) !== currentRegime || regime(b) !== currentRegime
              ? 'native_runtime_pool_fee_units_or_profile_mismatch'
              : BigInt(b.source.blockNumber) >= BigInt(c.source.blockNumber) ||
                  Date.parse(b.source.blockTime) >= source
                ? 'not_strictly_prior'
                : Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime) > 91800000
                  ? 'historical_gap'
                  : null
      if (exclusionReason) {
        excludedIntervals.push({ fromIndex: n, reason: exclusionReason, donorSources })
        continue
      }
      const engine = buildConditionalTimeProcess(
        {
          channels,
          observations: [a, b].map((p) => ({
            sourceAtUtc: p.source.blockTime,
            availableAtUtc: p.availableAtUtc,
            regime: currentRegime,
            channels,
            valuesByChannel: values(p),
            provenanceRef: p.provenanceRef,
          })),
          outputAsset: { assetAddress: FLUID_USDT_INPUT, decimals: 6 },
          measurementRule: 'internal_correlated_state_projection_only_not_fixed_cost_headroom',
          current: {
            sourceAtUtc: c.source.blockTime,
            readAtUtc: c.readAtUtc,
            regime: currentRegime,
            valuesByChannel: values(c),
            provenanceRef: c.provenanceRef,
          },
          issueAtUtc: i.issueAtUtc,
          requestedRaw: c.conversion.requiredNetUsdcRaw,
          horizonHours: i.horizonHours,
          maxHistoricalGapSeconds: 91800,
        },
        () => true,
        (state) => {
          const m = measure(state, c.withdrawalFeeBps)
          return { availableRaw: m.fundingNetUsdcRaw, entitlementRaw: m.fullNetUsdcEaRaw }
        },
      )
      if (!engine || engine.scenarios.length !== 1) {
        excludedIntervals.push({
          fromIndex: n,
          reason: 'joint_state_projection_unavailable',
          donorSources,
        })
        continue
      }
      const s = engine.scenarios[0]
      // Discard every generic fixed-request headroom/shortfall/target result.
      const points = s.points
        .filter((p) => Date.parse(p.atUtc) >= issue)
        .map((p) => ({
          ...measure(p.valuesByChannel, c.withdrawalFeeBps),
          atUtc: p.atUtc,
          elapsedFromIssueSeconds: (Date.parse(p.atUtc) - issue) / 1000,
          elapsedFromSourceSeconds: p.elapsedFromSourceSeconds,
          valuesByChannel: p.valuesByChannel,
        }))
      let valid = s.status === 'conditional_path' && points.length > 0
      let reason = s.reason,
        censoredAtUtc = s.censoredAtUtc,
        change: string | null = null
      if (valid) {
        const delta = BigInt(points.at(-1)!.marginUsdcRaw) - BigInt(points[0].marginUsdcRaw)
        if (delta < -MAX || delta > MAX) {
          valid = false
          reason = 'margin_change_overflow'
          censoredAtUtc = points.at(-1)!.atUtc
        } else change = String(delta)
      }
      const episodes = valid ? shortfalls(points, issue) : null
      const issueMargin = valid ? points[0].marginUsdcRaw : null,
        targetMargin = valid ? points.at(-1)!.marginUsdcRaw : null
      scenarios.push({
        fromIndex: n,
        donorSources,
        donor: s.donor,
        sampling: s.sampling,
        status: valid ? 'conditional_path' : 'censored_path',
        reason,
        censoredAtUtc,
        points,
        issueMarginUsdcRaw: issueMargin,
        targetMarginUsdcRaw: targetMargin,
        targetMinusIssueMarginUsdcRaw: change,
        sampledTroughMarginUsdcRaw: valid
          ? String(points.map((p) => BigInt(p.marginUsdcRaw)).reduce((a, b) => (a < b ? a : b)))
          : null,
        sampledShortfalls: episodes,
        firstLoss: episodes?.[0]?.onset ?? null,
        firstRecovery: episodes?.find((e) => e.recovery !== null)?.recovery ?? null,
        continuousPathKnown: false,
      })
    }
    const usable = scenarios.filter((s) => s.status === 'conditional_path'),
      censored = scenarios.length - usable.length
    const complete = usable.length > 0 && censored === 0 && excludedIntervals.length === 0
    const process = {
      input: i,
      channels,
      scenarios,
      excludedIntervals,
      complete,
      targetSummary: complete
        ? {
            unit: 'USDC_margin_supporting_fixed_USDT_Q' as const,
            asset: FLUID_USDT_INPUT,
            decimals: 6 as const,
            marginBand: band(usable.map((s) => BigInt(s.targetMarginUsdcRaw!))),
            targetMinusIssueMarginBand: band(
              usable.map((s) => BigInt(s.targetMinusIssueMarginUsdcRaw!)),
            ),
          }
        : null,
      modeledIssueMarginBand: complete
        ? band(usable.map((s) => BigInt(s.issueMarginUsdcRaw!)))
        : null,
    }
    return freeze({
      status: 'conditional_same_pool_quote_funding_USDC_margin_process' as const,
      process,
      issueAtUtc: i.issueAtUtc,
      sourceAtUtc: c.source.blockTime,
      readAtUtc: c.readAtUtc,
      knowledgeCutoffUtc: i.knowledgeCutoffUtc,
      targetAtUtc: new Date(issue + i.horizonHours * 3600000).toISOString(),
      sourceProofValidUntil: new Date(source + 1800000).toISOString(),
      sourceAgeMs: issue - source,
      requestedFinalUsdtRaw: i.requestedFinalUsdtRaw,
      requestedAsset: FLUID_USDT_OUTPUT,
      requestedDecimals: 6,
      marginAsset: FLUID_USDT_INPUT,
      marginDecimals: 6,
      sharesRaw: c.holderSharesRaw,
      sourceMeasurement,
      counts: {
        attempted: i.history.length - 1,
        usable: usable.length,
        censored,
        excluded: excludedIntervals.length,
      },
      assumptions: {
        historicalNETIncludesCompetingUsersOnce: true,
        correlatedSevenChannelNET: true,
        constantHistoricalNetRate: true,
        sourceAgeAppliedOnce: true,
        mechanicalWithdrawalFeeAppliedOnce: true,
        fixedUSDTQBoundThroughNativeExactOutputCost: true,
        unchangedRuntimePoolFeePolicy: true,
        sampledIssueRelativeBracketsOnly: true,
        noUSDTCapacityAmountGrid: true,
        finalSwapExecution: 'unassessed' as const,
        combinedBridgeUSDTExecutionRoute: 'unassessed' as const,
        exactInputOfRequiredCostRoundingWitness: false,
      },
      MRaw: null,
      originalAuthority: false,
      authenticated: false,
      historicalOwnershipProven: false,
      executionProven: false,
      calibratedProbability: false,
      forecastValidated: false,
      coveragePromotion: false,
      continuousPathKnown: false,
    })
  } catch {
    return null
  }
}
export type FluidUsdtBridgeJointLiveTimeProcess = NonNullable<
  ReturnType<typeof buildFluidUsdtBridgeJointLiveTimeProcess>
>
