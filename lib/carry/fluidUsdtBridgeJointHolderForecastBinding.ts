import {
  buildFluidUsdtBridgeJointLiveTimeProcess,
  FLUID_USDT_BRIDGE,
  FLUID_USDT_INPUT,
  FLUID_USDT_OUTPUT,
  FLUID_USDT_FACTORY,
  FLUID_USDT_QUOTER,
  FLUID_USDT_POOL,
  type FluidUsdtBridgeJointFrame,
} from './fluidUsdtBridgeJointLiveTimeProcess'
import { parseFluidUsdtNativeQuoteJson } from './fluidUsdtBridgeNativeQuoteEvidenceCodec'
import { resolveFluidUsdcBridgeJointTrustedProfile } from './fluidUsdcBridgeJointTrustedProfile'
import type { MorphoV2HolderForecastQuestion } from './morphoV2HolderForecastBinding'

export const FLUID_USDT_BRIDGE_JOINT_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]' as const
export const FLUID_USDT_BRIDGE_JOINT_VAULT = FLUID_USDT_BRIDGE
export const FLUID_USDT_BRIDGE_JOINT_ASSET = FLUID_USDT_OUTPUT
export type FluidUsdtBridgeJointHolderForecastQuestion = MorphoV2HolderForecastQuestion
export type FluidUsdtBridgeJointHolderForecastSource = Readonly<{
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}>
export type FluidUsdtBridgeJointCurrentEvidence = Readonly<{
  schema: 'fluid_usdt_bridge_joint_current_evidence_v1'
  source: FluidUsdtBridgeJointHolderForecastSource
  current: FluidUsdtBridgeJointFrame & { readAtUtc: string }
  roundtripUsdtRaw: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
  sourceImplementationEquivalence: false
  noUSDTCapacityAmountBand: true
  noLinearScaling: true
  combinedBridgeUSDTExecutionRoute: 'unassessed'
  MRaw: null
}>
export type FluidUsdtBridgeJointHistoricalEvidence = Readonly<{
  schema: 'fluid_usdt_bridge_joint_historical_evidence_v1'
  points: readonly FluidUsdtBridgeJointFrame[]
  sharesRaw: string
  requestedFinalUsdtRaw: string
  acquiredAtUtc: string
  availableAtUtc: string
  owner: null
  historicalOwnership: false
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
  sourceImplementationEquivalence: false
  noUSDTCapacityAmountBand: true
  noLinearScaling: true
  combinedBridgeUSDTExecutionRoute: 'unassessed'
  MRaw: null
}>
export type FluidUsdtBridgeJointHolderForecastIssue = Readonly<{
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  fullEaRaw: string
  sharesRaw: string
  requiredNetUsdcRaw: string
  profileId: string
  asset: typeof FLUID_USDT_OUTPUT
  assetDecimals: 6
  marginAsset: typeof FLUID_USDT_INPUT
  marginDecimals: 6
  shareDecimals: 18
  source: FluidUsdtBridgeJointHolderForecastSource
  independentSource?: MorphoV2HolderForecastQuestion['independentSource']
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
}>
type LiveModel = NonNullable<ReturnType<typeof buildFluidUsdtBridgeJointLiveTimeProcess>>
export type FluidUsdtBridgeJointHolderForecast = LiveModel &
  Readonly<{
    profileId: string
    source: FluidUsdtBridgeJointHolderForecastSource
    asset: typeof FLUID_USDT_OUTPUT
    assetDecimals: 6
    marginAsset: typeof FLUID_USDT_INPUT
    marginDecimals: 6
    shareDecimals: 18
  }>
export const FLUID_USDT_BRIDGE_JOINT_BINDING_LIMITS = Object.freeze({
  transportBytes: 8 * 1024 * 1024,
  snapshotUtf16Bytes: 8 * 1024 * 1024,
  nodes: 100000,
  sourceMs: 1800000,
  receiptMs: 1800000,
  horizonHours: 8760,
})
const nativeNow = Date.now,
  NativeDate = Date,
  MAX = (1n << 256n) - 1n,
  utf8 = new TextEncoder()
const PROFILE = 'fluid-usdt-bridge-same-pool-quote-funding-v1'
const USDC_PROFILE = resolveFluidUsdcBridgeJointTrustedProfile(
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  FLUID_USDT_BRIDGE,
  FLUID_USDT_INPUT,
)!
const RUNTIMES: Readonly<Record<string, string>> = Object.freeze({
  ...USDC_PROFILE.runtimeCodeHashes,
  [FLUID_USDT_FACTORY]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
  [FLUID_USDT_QUOTER]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
  [FLUID_USDT_POOL]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
  [FLUID_USDT_OUTPUT]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
})
const ANCHORS = USDC_PROFILE.anchors.filter((a) => a.cashIndex >= 111 && a.cashIndex <= 118)
const models = new WeakMap<
  object,
  {
    question: FluidUsdtBridgeJointHolderForecastQuestion
    issue: FluidUsdtBridgeJointHolderForecastIssue
  }
>()
const receipts = new WeakMap<object, FluidUsdtBridgeJointHolderForecast>()
function check(v: unknown): asserts v {
  if (!v) throw Error('fluid_usdt_joint_binding_rejected')
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && v !== '0x' + '0'.repeat(40)
function utc(v: unknown): number {
  check(
    typeof v === 'string' &&
      v.length <= 32 &&
      Number.isSafeInteger(Date.parse(v)) &&
      new NativeDate(v).toISOString() === v,
  )
  return Date.parse(v)
}
function actualClock(): number {
  check(Date.now === nativeNow && Date === NativeDate)
  return nativeNow()
}
function keys(v: any, expected: string[]) {
  check(record(v) && Object.keys(v).sort().join('|') === [...expected].sort().join('|'))
}
function same(a: any, b: any): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, n) => same(v, b[n]))
    )
  return (
    record(a) &&
    record(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  )
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function snapshot(
  input: unknown,
  cap = FLUID_USDT_BRIDGE_JOINT_BINDING_LIMITS.snapshotUtf16Bytes,
): any {
  let nodes = 0,
    bytes = 0
  const ancestry = new Set<object>()
  const copy = (v: any, depth: number): any => {
    check(++nodes <= FLUID_USDT_BRIDGE_JOINT_BINDING_LIMITS.nodes && depth <= 24)
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(bytes <= cap)
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    check(
      v &&
        typeof v === 'object' &&
        !ancestry.has(v) &&
        !Object.getOwnPropertySymbols(v).length &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
    )
    ancestry.add(v)
    try {
      const ds = Object.getOwnPropertyDescriptors(v)
      if (Array.isArray(v)) {
        check(v.length <= 2048 && Object.getOwnPropertyNames(v).length === v.length + 1)
        return Array.from({ length: v.length }, (_, n) => {
          const d = ds[n]
          check(d && d.enumerable && Object.hasOwn(d, 'value'))
          return copy(d.value, depth + 1)
        })
      }
      const out: Record<string, unknown> = {}
      for (const [k, d] of Object.entries(ds)) {
        bytes += k.length * 2
        check(
          k.length <= 256 &&
            bytes <= cap &&
            d.enumerable &&
            Object.hasOwn(d, 'value') &&
            !['__proto__', 'constructor', 'prototype'].includes(k),
        )
        out[k] = copy(d.value, depth + 1)
      }
      return out
    } finally {
      ancestry.delete(v)
    }
  }
  return copy(input, 0)
}
function source(v: any): FluidUsdtBridgeJointHolderForecastSource {
  keys(v, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(
    v.chainId === 1 &&
      v.finalized === true &&
      Number.isSafeInteger(v.blockNumber) &&
      v.blockNumber > 0 &&
      typeof v.blockHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(v.blockHash) &&
      utc(v.blockTime) % 1000 === 0,
  )
  return v
}
function question(
  input: FluidUsdtBridgeJointHolderForecastQuestion,
): FluidUsdtBridgeJointHolderForecastQuestion {
  const q = snapshot(input, 8192)
  check(
    record(q) &&
      Object.keys(q).every((k) =>
        [
          'routeKey',
          'destination',
          'requestedHolderAddress',
          'requestedRaw',
          'requestedAssetAddress',
          'requestedAssetDecimals',
          'horizonHours',
          'asOfMs',
          'independentSource',
        ].includes(k),
      ),
  )
  const owner =
    typeof q.requestedHolderAddress === 'string' ? q.requestedHolderAddress.toLowerCase() : ''
  check(
    q.routeKey === FLUID_USDT_BRIDGE_JOINT_ROUTE &&
      typeof q.destination === 'string' &&
      q.destination.toLowerCase() === FLUID_USDT_BRIDGE_JOINT_VAULT &&
      address(owner) &&
      raw(q.requestedRaw) &&
      q.requestedRaw !== '0' &&
      typeof q.requestedAssetAddress === 'string' &&
      q.requestedAssetAddress.toLowerCase() === FLUID_USDT_OUTPUT &&
      q.requestedAssetDecimals === 6 &&
      Number.isSafeInteger(q.horizonHours) &&
      q.horizonHours >= 1 &&
      q.horizonHours <= 8760 &&
      Number.isSafeInteger(q.asOfMs) &&
      q.asOfMs >= 0 &&
      Number.isSafeInteger(q.asOfMs + q.horizonHours * 3600000) &&
      q.asOfMs + q.horizonHours * 3600000 <= 8640000000000000,
  )
  if (Object.hasOwn(q, 'independentSource')) source(q.independentSource)
  return freeze({
    ...q,
    destination: FLUID_USDT_BRIDGE_JOINT_VAULT,
    requestedHolderAddress: owner,
    requestedAssetAddress: FLUID_USDT_OUTPUT,
  })
}
const FLAGS = [
  'originalAuthority',
  'authenticated',
  'executionQualified',
  'calibrated',
  'sourceImplementationEquivalence',
  'noUSDTCapacityAmountBand',
  'noLinearScaling',
  'combinedBridgeUSDTExecutionRoute',
  'MRaw',
]
function flags(v: any) {
  check(
    v.originalAuthority === false &&
      v.authenticated === false &&
      v.executionQualified === false &&
      v.calibrated === false &&
      v.sourceImplementationEquivalence === false &&
      v.noUSDTCapacityAmountBand === true &&
      v.noLinearScaling === true &&
      v.combinedBridgeUSDTExecutionRoute === 'unassessed' &&
      v.MRaw === null,
  )
}
const FRAME_KEYS = [
  'source',
  'acquiredAtUtc',
  'availableAtUtc',
  'provenanceRef',
  'profileId',
  'holderSharesRaw',
  'shareDecimals',
  'fullHolderNetUsdcRaw',
  'nativeProngs',
  'withdrawalFeeBps',
  'paused',
  'runtimeCodeHashes',
  'sourceClass',
  'owner',
  'historicalOwnership',
  'provenanceKind',
  'conversion',
]
function frame(f: any, current: boolean, q: FluidUsdtBridgeJointHolderForecastQuestion) {
  keys(f, current ? [...FRAME_KEYS, 'readAtUtc'] : FRAME_KEYS)
  keys(f.source, ['chainId', 'blockNumber', 'blockHash', 'blockTime'])
  check(
    f.source.chainId === 1 &&
      raw(f.source.blockNumber) &&
      f.source.blockNumber !== '0' &&
      typeof f.source.blockHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(f.source.blockHash) &&
      utc(f.source.blockTime) % 1000 === 0 &&
      utc(f.acquiredAtUtc) >= utc(f.source.blockTime) &&
      utc(f.availableAtUtc) >= utc(f.acquiredAtUtc) &&
      typeof f.provenanceRef === 'string' &&
      f.provenanceRef.length > 0 &&
      f.provenanceRef.length <= 256 &&
      f.profileId === PROFILE &&
      raw(f.holderSharesRaw) &&
      f.holderSharesRaw !== '0' &&
      f.shareDecimals === 18 &&
      raw(f.fullHolderNetUsdcRaw) &&
      f.withdrawalFeeBps === 5 &&
      f.paused === false &&
      same(f.runtimeCodeHashes, RUNTIMES) &&
      f.sourceClass === 'captured_identical_runtimes_only' &&
      f.historicalOwnership === false &&
      f.owner === (current ? q.requestedHolderAddress : null) &&
      f.provenanceKind ===
        (current ? 'native_current_full_position' : 'native_hypothetical_shares'),
  )
  keys(f.nativeProngs, [
    'bridgeFunding',
    'bankCash',
    'bankSupply',
    'bankWithdrawableUntilLimit',
    'bankResolverWithdrawable',
  ])
  check(Object.values(f.nativeProngs).every(raw))
  keys(f.conversion, [
    'factory',
    'quoter',
    'pool',
    'fee',
    'method',
    'inputAsset',
    'inputDecimals',
    'outputAsset',
    'outputDecimals',
    'fixedFinalUsdtOutputRaw',
    'requiredNetUsdcRaw',
  ])
  const c = f.conversion
  check(
    c.factory === FLUID_USDT_FACTORY &&
      c.quoter === FLUID_USDT_QUOTER &&
      c.pool === FLUID_USDT_POOL &&
      c.fee === 100 &&
      c.method === 'quoteExactOutputSingle' &&
      c.inputAsset === FLUID_USDT_INPUT &&
      c.inputDecimals === 6 &&
      c.outputAsset === FLUID_USDT_OUTPUT &&
      c.outputDecimals === 6 &&
      c.fixedFinalUsdtOutputRaw === q.requestedRaw &&
      raw(c.requiredNetUsdcRaw) &&
      c.requiredNetUsdcRaw !== '0',
  )
  if (current)
    check(utc(f.readAtUtc) >= utc(f.source.blockTime) && utc(f.readAtUtc) <= utc(f.acquiredAtUtc))
}
/** Clean transport reconstruction creates only a local unsigned model/receipt.
 * Native producer capabilities, implementation approval and execution are never inferred. */
export function issuedFluidUsdtBridgeJointHolderForecast(
  currentEvidence: unknown,
  historicalEvidence: unknown,
  suppliedQuestion: FluidUsdtBridgeJointHolderForecastQuestion,
): FluidUsdtBridgeJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion),
      now = actualClock(),
      c = snapshot(currentEvidence),
      h = snapshot(historicalEvidence)
    check(
      utf8.encode(JSON.stringify([c, h])).length <=
        FLUID_USDT_BRIDGE_JOINT_BINDING_LIMITS.transportBytes,
    )
    check(q.asOfMs <= now && now - q.asOfMs <= 1800000)
    keys(c, ['schema', 'source', 'current', 'roundtripUsdtRaw', ...FLAGS])
    flags(c)
    check(c.schema === 'fluid_usdt_bridge_joint_current_evidence_v1')
    const s = source(c.source)
    frame(c.current, true, q)
    check(
      same(c.current.source, {
        chainId: 1,
        blockNumber: String(s.blockNumber),
        blockHash: s.blockHash,
        blockTime: s.blockTime,
      }) &&
        raw(c.roundtripUsdtRaw) &&
        BigInt(c.roundtripUsdtRaw) >= BigInt(q.requestedRaw!) &&
        utc(s.blockTime) <= q.asOfMs &&
        now - utc(s.blockTime) <= 1800000,
    )
    if (Object.hasOwn(q, 'independentSource')) check(same(q.independentSource, s))
    keys(h, [
      'schema',
      'points',
      'sharesRaw',
      'requestedFinalUsdtRaw',
      'acquiredAtUtc',
      'availableAtUtc',
      'owner',
      'historicalOwnership',
      ...FLAGS,
    ])
    flags(h)
    check(
      h.schema === 'fluid_usdt_bridge_joint_historical_evidence_v1' &&
        Array.isArray(h.points) &&
        h.points.length === 8 &&
        h.sharesRaw === c.current.holderSharesRaw &&
        h.requestedFinalUsdtRaw === q.requestedRaw &&
        h.owner === null &&
        h.historicalOwnership === false,
    )
    for (let n = 0; n < 8; n++) {
      const p = h.points[n],
        a = ANCHORS[n].source
      frame(p, false, q)
      check(
        p.holderSharesRaw === c.current.holderSharesRaw &&
          same(p.source, {
            chainId: 1,
            blockNumber: String(a.blockNumber),
            blockHash: a.blockHash,
            blockTime: a.blockTime,
          }) &&
          a.blockNumber < s.blockNumber &&
          utc(a.blockTime) < utc(s.blockTime),
      )
    }
    check(
      utc(h.acquiredAtUtc) === Math.max(...h.points.map((p: any) => utc(p.acquiredAtUtc))) &&
        utc(h.availableAtUtc) === Math.max(...h.points.map((p: any) => utc(p.availableAtUtc))),
    )
    const cutoff = Math.max(utc(c.current.availableAtUtc), utc(h.availableAtUtc))
    check(cutoff <= q.asOfMs)
    const math = buildFluidUsdtBridgeJointLiveTimeProcess({
      routeKey: FLUID_USDT_BRIDGE_JOINT_ROUTE,
      destination: FLUID_USDT_BRIDGE,
      inputAsset: FLUID_USDT_INPUT,
      inputDecimals: 6,
      outputAsset: FLUID_USDT_OUTPUT,
      outputDecimals: 6,
      owner: q.requestedHolderAddress!,
      requestedFinalUsdtRaw: q.requestedRaw!,
      profileId: PROFILE,
      issueAtUtc: new NativeDate(q.asOfMs).toISOString(),
      knowledgeCutoffUtc: new NativeDate(cutoff).toISOString(),
      horizonHours: q.horizonHours,
      maxHistoricalGapSeconds: 91800,
      current: c.current,
      history: h.points,
    })
    check(math)
    const model: FluidUsdtBridgeJointHolderForecast = freeze({
      ...math,
      profileId: PROFILE,
      source: { ...s },
      asset: FLUID_USDT_OUTPUT,
      assetDecimals: 6,
      marginAsset: FLUID_USDT_INPUT,
      marginDecimals: 6,
      shareDecimals: 18,
    })
    const issue: FluidUsdtBridgeJointHolderForecastIssue = freeze({
      issuedAtMs: q.asOfMs,
      horizonHours: q.horizonHours,
      owner: q.requestedHolderAddress!,
      requestedRaw: q.requestedRaw!,
      fullEaRaw: c.current.fullHolderNetUsdcRaw,
      sharesRaw: c.current.holderSharesRaw,
      requiredNetUsdcRaw: c.current.conversion.requiredNetUsdcRaw,
      profileId: PROFILE,
      asset: FLUID_USDT_OUTPUT,
      assetDecimals: 6,
      marginAsset: FLUID_USDT_INPUT,
      marginDecimals: 6,
      shareDecimals: 18,
      source: { ...s },
      ...(Object.hasOwn(q, 'independentSource') ? { independentSource: q.independentSource } : {}),
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
    })
    models.set(model, { question: q, issue })
    receipts.set(issue, model)
    return model
  } catch {
    return null
  }
}
export function fluidUsdtBridgeJointHolderForecastRenderWindow(
  value: unknown,
  renderAsOfMs?: number,
): boolean {
  try {
    const bound = record(value) ? models.get(value) : undefined,
      now = actualClock()
    if (!bound) return false
    const render = renderAsOfMs ?? now
    return (
      Number.isSafeInteger(render) &&
      render >= bound.question.asOfMs &&
      render <= now &&
      now >= bound.question.asOfMs &&
      now - bound.question.asOfMs <= 1800000 &&
      now - utc(bound.issue.source.blockTime) <= 1800000
    )
  } catch {
    return false
  }
}
export function selectedFluidUsdtBridgeJointHolderForecast(
  value: unknown,
  suppliedQuestion: FluidUsdtBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdtBridgeJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion)
    return record(value) &&
      same(models.get(value)?.question, q) &&
      fluidUsdtBridgeJointHolderForecastRenderWindow(value, renderAsOfMs)
      ? (value as FluidUsdtBridgeJointHolderForecast)
      : null
  } catch {
    return null
  }
}
export function fluidUsdtBridgeJointHolderForecastIssue(
  value: unknown,
): FluidUsdtBridgeJointHolderForecastIssue | null {
  return record(value) ? (models.get(value)?.issue ?? null) : null
}
export function selectedFluidUsdtBridgeJointHolderForecastFromIssue(
  value: unknown,
  q: FluidUsdtBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdtBridgeJointHolderForecast | null {
  return record(value)
    ? selectedFluidUsdtBridgeJointHolderForecast(receipts.get(value), q, renderAsOfMs)
    : null
}
export function selectedFluidUsdtBridgeJointHolderForecastIssue(
  value: unknown,
  q: FluidUsdtBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdtBridgeJointHolderForecastIssue | null {
  return selectedFluidUsdtBridgeJointHolderForecastFromIssue(value, q, renderAsOfMs)
    ? (value as FluidUsdtBridgeJointHolderForecastIssue)
    : null
}
export function fluidUsdtBridgeJointHolderForecastFromResponse(
  value: unknown,
  status: number,
  suppliedQuestion: FluidUsdtBridgeJointHolderForecastQuestion,
  receivedAtMs: number,
): FluidUsdtBridgeJointHolderForecast | null {
  try {
    const response = snapshot(
        typeof value === 'string' ? parseFluidUsdtNativeQuoteJson(value) : value,
      ),
      q = question(suppliedQuestion),
      now = actualClock()
    check(
      utf8.encode(JSON.stringify(response)).length <=
        FLUID_USDT_BRIDGE_JOINT_BINDING_LIMITS.transportBytes,
    )
    check(
      record(response) &&
        (status === 200 ||
          (status === 503 && response.error === 'holder_exit_assessment_unavailable')) &&
        Number.isSafeInteger(receivedAtMs) &&
        receivedAtMs >= q.asOfMs &&
        receivedAtMs <= now &&
        utc(response.fluidUsdtBridgeJointIssuedAtUtc) === q.asOfMs,
    )
    const model = issuedFluidUsdtBridgeJointHolderForecast(
      response.fluidUsdtBridgeJointCurrentEvidence,
      response.fluidUsdtBridgeJointHistoricalEvidence,
      q,
    )
    return selectedFluidUsdtBridgeJointHolderForecast(model, q, receivedAtMs)
  } catch {
    return null
  }
}
export function fluidUsdtBridgeJointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  q: FluidUsdtBridgeJointHolderForecastQuestion,
  receivedAtMs: number,
): FluidUsdtBridgeJointHolderForecastIssue | null {
  return fluidUsdtBridgeJointHolderForecastIssue(
    fluidUsdtBridgeJointHolderForecastFromResponse(value, status, q, receivedAtMs),
  )
}
