import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'

export type FluidUsdtQuoteSource = {
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
}
export type FluidUsdtQuotePoint = {
  source: FluidUsdtQuoteSource
  pool: string | null
  identityVerified: boolean
  runtimeCodeHashes: { factory: string; quoter: string; pool: string } | null
  status: 'conditional_quote' | 'incomplete'
  usdtQuotedRaw: string | null
  protocolQuote: {
    inputRaw: string
    usdtQuotedRaw: string | null
    status: 'conditional_quote' | 'incomplete'
    scope: string
  }
  missingLegs: string[]
}
/** Collector replay is authoritative only when independently approved against its raw external pin. */
export type FluidUsdtBridgeQuoteEvidence = {
  status: 'replayed_fluid_usdt_exact_size_quotes'
  knowledgeCutoff: string
  captureReceiptSha256: string
  input: { asset: string; decimals: 6; amountRaw: string }
  output: { asset: string; decimals: 6 }
  protocolInput: {
    asset: string
    decimals: 6
    amountRaw: string
    holderBound: false
    originalUsdtRequestedRaw: null
  }
  history: { points: FluidUsdtQuotePoint[]; elapsedSeconds: number[] }
  current: FluidUsdtQuotePoint | null
  originalUsdtRequestedRaw: null
  execution: 'unassessed'
  minedPayout: false
  holderCapacity: false
  sourceImplementationEquivalence: false
}
export type FluidUsdtNativeDeliveryPath = {
  owner: string
  inputAsset: string
  inputDecimals: 6
  inputRaw: string
  currentSource: FluidUsdtQuoteSource
  issueAtUtc: string
  targetAtUtc: string
  provenanceRef: string
  readAtUtc: string
  knowledgeCutoff: string
  fullEntitlementMethod: 'preview_redeem_full_position'
  scenarios: {
    donorSources: [FluidUsdtQuoteSource, FluidUsdtQuoteSource]
    quoteDonorProvenanceRefs: [string, string]
    nativeDonorProvenanceRef: string
    nativeDonorAvailableAtUtc: [string, string]
    points: {
      atUtc: string
      availableUsdcRaw: string | null
      fullEntitlementUsdcRaw: string | null
    }[]
  }[]
}
export type FluidUsdtBridgeTimeInput = {
  mode: 'current_conditional' | 'dated_captured_projection'
  routeKey: string
  destination: string
  usdcInputRaw: string
  requestedUsdtRaw: string
  horizonHours: number
  issueAtUtc: string
  evidence: FluidUsdtBridgeQuoteEvidence
  owner?: string
  nativeDelivery?: FluidUsdtNativeDeliveryPath
}
export type FluidUsdtBridgeEvidenceAcceptor = (
  kind: 'history' | 'current' | 'native_delivery',
  snapshot: FluidUsdtBridgeQuoteEvidence | FluidUsdtNativeDeliveryPath,
) => boolean
const ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
const VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const POOL = '0x3416cf6c708da44db2624d63ea0aaef7113527c6'
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const ref = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (object(a) || object(b))
    return (
      object(a) &&
      object(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
function source(v: FluidUsdtQuoteSource) {
  return (
    v?.chainId === 1 &&
    typeof v.blockNumber === 'string' &&
    /^[1-9][0-9]*$/.test(v.blockNumber) &&
    Number.isSafeInteger(Number(v.blockNumber)) &&
    hash(v.blockHash) &&
    utc(v.blockTime) &&
    Date.parse(v.blockTime) % 1000 === 0
  )
}
function point(p: FluidUsdtQuotePoint) {
  return (
    p &&
    source(p.source) &&
    p.pool === POOL &&
    p.identityVerified === true &&
    object(p.runtimeCodeHashes) &&
    exact(Object.keys(p.runtimeCodeHashes).sort(), ['factory', 'pool', 'quoter']) &&
    Object.values(p.runtimeCodeHashes).every(hash) &&
    Array.isArray(p.missingLegs) &&
    p.missingLegs.length <= 8 &&
    p.missingLegs.every(ref)
  )
}
function quote(p: FluidUsdtQuotePoint, input: string) {
  const q = input === '10145' ? p.usdtQuotedRaw : p.protocolQuote?.usdtQuotedRaw
  const status = input === '10145' ? p.status : p.protocolQuote?.status
  return status === 'conditional_quote' &&
    (input === '10145' ||
      (p.protocolQuote?.inputRaw === input &&
        p.protocolQuote.scope === 'independent_public_quote_not_holder_entitlement')) &&
    raw(q)
    ? q
    : null
}
function coverageRuns(points: { atUtc: string; coverage: string }[]) {
  const runs: {
    onset: { after: string | null; by: string }
    recovery: { after: string; by: string } | null
    leftCensored: boolean
    rightCensored: boolean
    unknownAfter: string | null
  }[] = []
  let active: (typeof runs)[number] | null = null
  points.forEach((p, i) => {
    if (p.coverage === 'unknown') {
      if (active) {
        active.unknownAfter = p.atUtc
        runs.push(active)
        active = null
      }
      return
    }
    if (p.coverage !== 'conditional_covered' && !active)
      active = {
        onset: { after: i ? points[i - 1].atUtc : null, by: p.atUtc },
        recovery: null,
        leftCensored: i === 0 || points[i - 1].coverage === 'unknown',
        rightCensored: true,
        unknownAfter: null,
      }
    if (p.coverage === 'conditional_covered' && active) {
      active.recovery = { after: points[i - 1].atUtc, by: p.atUtc }
      active.rightCensored = false
      runs.push(active)
      active = null
    }
  })
  if (active) runs.push(active)
  return runs
}
type QuoteProcess = NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
type JointCoveragePoint = {
  atUtc: string
  availableUsdcRaw: string | null
  fullEntitlementUsdcRaw: string | null
  requiredUsdcInputRaw: string
  quotedUsdtRaw: string
  finalHeadroomUsdtRaw: string | null
  coverage: 'unknown' | 'native_input_shortfall' | 'quoted_output_shortfall' | 'conditional_covered'
}
type HolderJoin = {
  scope: 'independently_qualified_exact_input_and_conversion_quote_coverage'
  owner: string
  provenanceRef: string
  paths: {
    donor: QuoteProcess['scenarios'][number]['donor']
    nativeDonorProvenanceRef: string
    points: JointCoveragePoint[]
    targetHeadroomUsdtRaw: string | null
    sampledCoverageRuns: ReturnType<typeof coverageRuns>
    continuousPathKnown: false
  }[]
  allTargetAmountsKnown: boolean
  releaseAndCombinedExecution: 'unverified'
}
/** Public fixed-input quote coverage first; full holder composition requires a separately approved exact-size delivery path. */
export function buildFluidUsdtBridgeHolderTimeProcess(
  supplied: FluidUsdtBridgeTimeInput,
  accept: FluidUsdtBridgeEvidenceAcceptor,
) {
  try {
    const input = structuredClone(supplied),
      e = input.evidence,
      c = e.current
    if (
      typeof accept !== 'function' ||
      input.routeKey !== ROUTE ||
      input.destination !== VAULT ||
      (input.owner !== undefined && !address(input.owner)) ||
      !['10145', '10000000000'].includes(input.usdcInputRaw) ||
      !raw(input.requestedUsdtRaw) ||
      input.requestedUsdtRaw === '0' ||
      !utc(input.issueAtUtc) ||
      !['current_conditional', 'dated_captured_projection'].includes(input.mode) ||
      e.status !== 'replayed_fluid_usdt_exact_size_quotes' ||
      typeof e.captureReceiptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(e.captureReceiptSha256) ||
      !utc(e.knowledgeCutoff) ||
      Date.parse(e.knowledgeCutoff) > Date.parse(input.issueAtUtc) ||
      (input.mode === 'dated_captured_projection' && input.issueAtUtc !== e.knowledgeCutoff) ||
      !exact(e.input, { asset: USDC, decimals: 6, amountRaw: '10145' }) ||
      !exact(e.output, { asset: USDT, decimals: 6 }) ||
      !exact(e.protocolInput, {
        asset: USDC,
        decimals: 6,
        amountRaw: '10000000000',
        holderBound: false,
        originalUsdtRequestedRaw: null,
      }) ||
      e.originalUsdtRequestedRaw !== null ||
      e.execution !== 'unassessed' ||
      e.minedPayout !== false ||
      e.holderCapacity !== false ||
      e.sourceImplementationEquivalence !== false ||
      !c ||
      !point(c) ||
      !Array.isArray(e.history.points) ||
      e.history.points.length !== 2 ||
      !e.history.points.every(point) ||
      !exact(e.history.elapsedSeconds, [0, 3072])
    )
      return null
    const [a, b] = e.history.points
    if (
      Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime) !== 3072000 ||
      BigInt(a.source.blockNumber) >= BigInt(b.source.blockNumber) ||
      BigInt(b.source.blockNumber) >= BigInt(c.source.blockNumber) ||
      Date.parse(b.source.blockTime) >= Date.parse(c.source.blockTime) ||
      !exact(a.runtimeCodeHashes, b.runtimeCodeHashes) ||
      !exact(a.runtimeCodeHashes, c.runtimeCodeHashes)
    )
      return null
    const amounts = [a, b, c].map((p) => quote(p, input.usdcInputRaw))
    if (
      amounts.some((q) => q === null) ||
      accept('history', structuredClone(e)) !== true ||
      accept('current', structuredClone(e)) !== true
    )
      return null
    const provenance = (p: FluidUsdtQuotePoint) => `${e.captureReceiptSha256}:${p.source.blockHash}`
    const channel = {
      key: 'fixed_input_usdt_quote',
      assetAddress: USDT,
      decimals: 6,
      unit: 'USDT_quote_for_exact_USDC_input',
      negativeHandling: 'clamp_zero' as const,
    }
    const process = buildConditionalTimeProcess(
      {
        channels: [channel],
        observations: [a, b].map((p, i) => ({
          sourceAtUtc: p.source.blockTime,
          availableAtUtc: e.knowledgeCutoff,
          regime: JSON.stringify(c.runtimeCodeHashes),
          channels: [channel],
          valuesByChannel: { fixed_input_usdt_quote: amounts[i]! },
          provenanceRef: provenance(p),
        })),
        outputAsset: { assetAddress: USDT, decimals: 6 },
        measurementRule: 'constant_observed_net_quote_change_for_unchanged_exact_input',
        current: {
          sourceAtUtc: c.source.blockTime,
          readAtUtc: e.knowledgeCutoff,
          regime: JSON.stringify(c.runtimeCodeHashes),
          valuesByChannel: { fixed_input_usdt_quote: amounts[2]! },
          provenanceRef: provenance(c),
        },
        issueAtUtc: input.issueAtUtc,
        requestedRaw: input.requestedUsdtRaw,
        horizonHours: input.horizonHours,
        maxHistoricalGapSeconds: 3072,
      },
      () => true,
      (state) => ({ availableRaw: state.fixed_input_usdt_quote, entitlementRaw: null }),
    )
    if (!process) return null
    let holderExit: HolderJoin | null = null
    const n = input.nativeDelivery
    try {
      if (
        n &&
        address(input.owner) &&
        n.owner === input.owner &&
        n.inputAsset === USDC &&
        n.inputDecimals === 6 &&
        n.inputRaw === input.usdcInputRaw &&
        exact(n.currentSource, c.source) &&
        n.issueAtUtc === process.issueAtUtc &&
        n.targetAtUtc === process.targetAtUtc &&
        ref(n.provenanceRef) &&
        n.fullEntitlementMethod === 'preview_redeem_full_position' &&
        utc(n.readAtUtc) &&
        utc(n.knowledgeCutoff) &&
        Date.parse(n.readAtUtc) >= Date.parse(c.source.blockTime) &&
        Date.parse(n.readAtUtc) <= Date.parse(n.knowledgeCutoff) &&
        Date.parse(n.knowledgeCutoff) <= Date.parse(process.issueAtUtc) &&
        Array.isArray(n.scenarios) &&
        n.scenarios.length === process.scenarios.length &&
        accept('native_delivery', structuredClone(n)) === true
      ) {
        const paths = process.scenarios.map((s, i) => {
          const native = n.scenarios[i]
          if (
            !exact(native.donorSources, [a.source, b.source]) ||
            !exact(native.quoteDonorProvenanceRefs, s.donor.provenanceRefs) ||
            !ref(native.nativeDonorProvenanceRef) ||
            !Array.isArray(native.nativeDonorAvailableAtUtc) ||
            native.nativeDonorAvailableAtUtc.length !== 2 ||
            !native.nativeDonorAvailableAtUtc.every(
              (at, j) =>
                utc(at) &&
                Date.parse(at) >= Date.parse(e.history.points[j].source.blockTime) &&
                Date.parse(at) <= Date.parse(process.issueAtUtc),
            ) ||
            !Array.isArray(native.points) ||
            native.points.length !== s.points.length
          )
            throw Error('native_path_binding')
          const points = s.points.map((p, j) => {
            const np = native.points[j]
            if (
              np.atUtc !== p.atUtc ||
              (np.availableUsdcRaw !== null && !raw(np.availableUsdcRaw)) ||
              (np.fullEntitlementUsdcRaw !== null && !raw(np.fullEntitlementUsdcRaw))
            )
              throw Error('native_point_binding')
            const known = np.availableUsdcRaw !== null && np.fullEntitlementUsdcRaw !== null
            const sufficient =
              known &&
              BigInt(np.availableUsdcRaw!) >= BigInt(input.usdcInputRaw) &&
              BigInt(np.fullEntitlementUsdcRaw!) >= BigInt(input.usdcInputRaw)
            const coverage: JointCoveragePoint['coverage'] = !known
              ? 'unknown'
              : !sufficient
                ? 'native_input_shortfall'
                : BigInt(p.headroomRaw) < 0n
                  ? 'quoted_output_shortfall'
                  : 'conditional_covered'
            return {
              atUtc: p.atUtc,
              availableUsdcRaw: np.availableUsdcRaw,
              fullEntitlementUsdcRaw: np.fullEntitlementUsdcRaw,
              requiredUsdcInputRaw: input.usdcInputRaw,
              quotedUsdtRaw: p.availableRaw,
              finalHeadroomUsdtRaw: sufficient ? p.headroomRaw : null,
              coverage,
            }
          })
          return {
            donor: s.donor,
            nativeDonorProvenanceRef: native.nativeDonorProvenanceRef,
            points,
            targetHeadroomUsdtRaw:
              s.status === 'conditional_path'
                ? (points.at(-1)?.finalHeadroomUsdtRaw ?? null)
                : null,
            sampledCoverageRuns: coverageRuns(points),
            continuousPathKnown: false as const,
          }
        })
        holderExit = {
          scope: 'independently_qualified_exact_input_and_conversion_quote_coverage' as const,
          owner: input.owner,
          provenanceRef: n.provenanceRef,
          paths,
          allTargetAmountsKnown: paths.every((p) => p.targetHeadroomUsdtRaw !== null),
          releaseAndCombinedExecution: 'unverified' as const,
        }
      }
    } catch {
      holderExit = null
    }
    return {
      durationScope: 'sampled_quote_coverage_only_not_holder_exit_duration' as const,
      status: 'fluid_usdt_exact_size_conversion_time_process' as const,
      input,
      scope: 'public_fixed_input_conversion_quote_coverage' as const,
      process,
      holderExit,
      assumptions: {
        quoteChange: 'constant_historical_net_quote_change_rate_for_exact_input' as const,
        nativeInputAmountUnchanged: true as const,
        poolPriceConstant: false as const,
        quoteChangesAreCompetingFlows: false as const,
        combinedWithdrawalSwapExecutionUnverified: true as const,
        sourceImplementationEquivalence: false as const,
      },
      holderExecutableExit: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      minedPayout: false as const,
      probability: null,
    }
  } catch {
    return null
  }
}
export function selectedFluidUsdtBridgeHolderTimeProcess(
  value: unknown,
  expected: { input: FluidUsdtBridgeTimeInput; asOfMs: number },
  accept: FluidUsdtBridgeEvidenceAcceptor,
) {
  try {
    const candidate = structuredClone(value),
      binding = structuredClone(expected)
    if (
      !Number.isSafeInteger(binding.asOfMs) ||
      binding.asOfMs < Date.parse(binding.input.issueAtUtc)
    )
      return null
    const rebuilt = buildFluidUsdtBridgeHolderTimeProcess(binding.input, accept)
    return rebuilt &&
      binding.asOfMs <= Date.parse(rebuilt.process.sourceProofValidUntil) &&
      binding.asOfMs < Date.parse(rebuilt.process.targetAtUtc) &&
      exact(candidate, rebuilt)
      ? rebuilt
      : null
  } catch {
    return null
  }
}
