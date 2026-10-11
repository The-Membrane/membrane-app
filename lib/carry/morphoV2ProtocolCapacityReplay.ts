/** Browser-safe native replay. Authority comes from a private profile and its reviewed history. */
import {
  encodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  decodeAbiParameters,
  parseAbi,
  keccak256,
} from 'viem'
import { morphoV2AdapterCapacityMath } from './morphoV2AdapterCapacityMath'
import {
  morphoV2PinnedProtocolHistory,
  type MorphoV2Sha256Text,
} from './morphoV2ProtocolCapacityHistoryPins'
import {
  reviewedMorphoV2ProtocolHistory,
  approveReviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolCurrent,
} from './morphoV2ReviewedProtocolHistories'
import type { MorphoV2HolderTimeProcessInput } from './morphoV2HolderTimeProcess'
import {
  resolveMorphoV2TrustedProfile,
  isAppOwnedMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from './morphoV2TrustedProfiles'
export type MorphoV2NativeSource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
export type MorphoV2ProtocolTrace = {
  key: string
  method: string
  params: unknown[]
  result: unknown
  startedAtUtc: string
  completedAtUtc: string
}
export type MorphoV2ProtocolOriginObservation = {
  source: MorphoV2NativeSource
  startedAtUtc: string
  readAtUtc: string
  deadlineMs: number
  traces: MorphoV2ProtocolTrace[]
}
export type MorphoV2ProtocolRequestClient = {
  request: (r: { method: string; params: unknown[] }) => Promise<unknown>
}
export type MorphoV2ProtocolCapacityExpected = {
  source: MorphoV2NativeSource
  asOfMs: number
  originHosts: readonly string[]
  /** Independent caller authority; serialized profiles and payload flags cannot select it. */
  profile?: MorphoV2TrustedProfile
}
export type MorphoV2ProtocolReplayExpected = MorphoV2ProtocolCapacityExpected
export type MorphoV2ProtocolCapacityObservation = {
  origins: { host: string; observation: MorphoV2ProtocolOriginObservation }[]
}
const MAX = (1n << 256n) - 1n,
  HEX = /^0x(?:[0-9a-fA-F]{2})*$/,
  HASH = /^0x[0-9a-f]{64}$/
const abi = parseAbi([
  'function asset() view returns(address)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function liquidityAdapter() view returns(address)',
  'function liquidityData() view returns(bytes)',
  'function isAdapter(address) view returns(bool)',
  'function parentVault() view returns(address)',
  'function morpho() view returns(address)',
  'function adaptiveCurveIrm() view returns(address)',
  'function supplyShares(bytes32) view returns(uint256)',
  'function expectedSupplyAssets(bytes32) view returns(uint256)',
  'function idToMarketParams(bytes32) view returns(address,address,address,address,uint256)',
  'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
  'function position(bytes32,address) view returns(uint256,uint128,uint128)',
  'function feeRecipient() view returns(address)',
  'function rateAtTarget(bytes32) view returns(int256)',
  'function allocation(bytes32) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) params,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns(uint256)',
])
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      Object.keys(a).length === a.length &&
      Object.keys(b).length === b.length &&
      Array.from({ length: a.length }, (_, i) => i).every(
        (i) => Object.hasOwn(a, i) && Object.hasOwn(b, i) && exact(a[i], b[i]),
      )
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
function check(v: boolean, why: string): asserts v {
  if (!v) throw Error(why)
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
export function isMorphoV2NativeSourceValid(s: MorphoV2NativeSource, at: number) {
  return (
    record(s) &&
    s.chainId === 1 &&
    s.finalized === true &&
    Number.isSafeInteger(s.blockNumber) &&
    s.blockNumber > 0 &&
    typeof s.blockHash === 'string' &&
    HASH.test(s.blockHash) &&
    utc(s.blockTime) &&
    Date.parse(s.blockTime) % 1000 === 0 &&
    Number.isSafeInteger(at) &&
    Date.parse(s.blockTime) <= at &&
    at - Date.parse(s.blockTime) <= 1800000
  )
}
export type MorphoV2ProtocolReadSpec = {
  key: string
  method: string
  params: unknown[]
  name?: string
}
function plan(
  h: ReviewedMorphoV2ProtocolHistory,
  s: MorphoV2NativeSource,
  market?: readonly bigint[],
): MorphoV2ProtocolReadSpec[] {
  const v = h.subject.destination,
    a = h.subject.asset,
    c = h.configured,
    pin = { blockHash: s.blockHash, requireCanonical: true }
  const call = (key: string, to: string, name: string, args: unknown[] = []) => ({
    key,
    method: 'eth_call',
    params: [{ to, data: encodeFunctionData({ abi, functionName: name, args } as any) }, pin],
    name,
  })
  if (market) {
    const p = decodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      c.liquidityData as `0x${string}`,
    )
    return [
      call('borrowRate', c.irm, 'borrowRateView', [
        { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] },
        Object.fromEntries(
          [
            'totalSupplyAssets',
            'totalSupplyShares',
            'totalBorrowAssets',
            'totalBorrowShares',
            'lastUpdate',
            'fee',
          ].map((k, i) => [k, market[i]]),
        ),
      ]),
    ]
  }
  const code = (key: string, to: string) => ({ key, method: 'eth_getCode', params: [to, pin] })
  const header = (key: string) => ({
    key,
    method: 'eth_getBlockByNumber',
    params: ['0x' + s.blockNumber.toString(16), false],
  })
  return [
    header('header_before'),
    code('code_vault', v),
    code('code_asset', a),
    call('asset', v, 'asset'),
    call('shareDecimals', v, 'decimals'),
    call('assetDecimals', a, 'decimals'),
    call('idleCash', a, 'balanceOf', [v]),
    call('liquidityAdapter', v, 'liquidityAdapter'),
    call('liquidityData', v, 'liquidityData'),
    call('isAdapter', v, 'isAdapter', [c.adapter]),
    code('code_adapter', c.adapter),
    call('adapterParentVault', c.adapter, 'parentVault'),
    call('adapterAsset', c.adapter, 'asset'),
    call('adapterMorpho', c.adapter, 'morpho'),
    call('adapterIrm', c.adapter, 'adaptiveCurveIrm'),
    call('adapterSupplyShares', c.adapter, 'supplyShares', [c.marketId]),
    call('adapterExpectedAssets', c.adapter, 'expectedSupplyAssets', [c.marketId]),
    call('marketParams', c.morpho, 'idToMarketParams', [c.marketId]),
    call('market', c.morpho, 'market', [c.marketId]),
    call('position', c.morpho, 'position', [c.marketId, c.adapter]),
    call('feeRecipient', c.morpho, 'feeRecipient'),
    call('rateAtTarget', c.irm, 'rateAtTarget', [c.marketId]),
    ...c.allocationIds.map((id, i) => call('allocation' + i, v, 'allocation', [id])),
    call('blueCash', a, 'balanceOf', [c.morpho]),
    call('adapterAllowance', a, 'allowance', [c.adapter, v]),
    code('code_blue', c.morpho),
    code('code_irm', c.irm),
    header('header_after'),
  ]
}
export function normalizeMorphoV2ProtocolHeader(v: unknown, s: MorphoV2NativeSource) {
  check(
    record(v) &&
      typeof v.number === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(v.number) &&
      typeof v.hash === 'string' &&
      HASH.test(v.hash) &&
      typeof v.timestamp === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(v.timestamp),
    'header_wire',
  )
  check(
    BigInt(v.number) === BigInt(s.blockNumber) &&
      v.hash === s.blockHash &&
      BigInt(v.timestamp) * 1000n === BigInt(Date.parse(s.blockTime)),
    'header_source',
  )
  return { number: v.number, hash: v.hash, timestamp: v.timestamp }
}
function decoded(spec: MorphoV2ProtocolReadSpec, result: unknown): any {
  check(typeof result === 'string' && HEX.test(result) && result.length <= 131072, 'native_wire')
  const value = decodeFunctionResult({
    abi,
    functionName: spec.name!,
    data: result as `0x${string}`,
  } as any)
  const canonical = encodeFunctionResult({ abi, functionName: spec.name!, result: value } as any)
  check(canonical.toLowerCase() === result.toLowerCase(), 'canonical_abi_result')
  return value
}
/** Preserve the reviewed USDC default; an explicit profile must retain private identity. */
function selectedProfile(profile?: MorphoV2TrustedProfile): MorphoV2TrustedProfile {
  if (profile !== undefined) {
    check(isAppOwnedMorphoV2TrustedProfile(profile), 'trusted_profile')
    return profile
  }
  const legacy = morphoV2PinnedProtocolHistory().subject
  const selected = resolveMorphoV2TrustedProfile(legacy.routeKey, legacy.destination, legacy.asset)
  check(isAppOwnedMorphoV2TrustedProfile(selected), 'trusted_profile')
  return selected!
}
function selectedHistory(profile: MorphoV2TrustedProfile): ReviewedMorphoV2ProtocolHistory {
  const history = reviewedMorphoV2ProtocolHistory(profile)
  check(
    history !== null &&
      exact(history.subject, profile.subject) &&
      exact(history.configured, profile.configured) &&
      exact(history.runtimeIdentities, profile.runtimeIdentities),
    'profile_history',
  )
  return history!
}
/** Thirty fixed specs, or the complete ordered thirty-one with the CURRENT market. */
export function morphoV2ProtocolReadPlan(
  source: MorphoV2NativeSource,
  market?: readonly bigint[],
  profile?: MorphoV2TrustedProfile,
): MorphoV2ProtocolReadSpec[] {
  const s = structuredClone(source),
    h = selectedHistory(selectedProfile(profile))
  check(isMorphoV2NativeSourceValid(s, Date.parse(s.blockTime)), 'source')
  const fixed = plan(h, s)
  if (!market) return structuredClone(fixed)
  check(market.length === 6 && market.every((value) => typeof value === 'bigint'), 'market')
  return structuredClone([...fixed.slice(0, -1), plan(h, s, market)[0], fixed.at(-1)!])
}
/** The dynamic read uses canonical native CURRENT market bytes, never a historical tuple. */
export function morphoV2ProtocolBorrowRateReadSpec(
  source: MorphoV2NativeSource,
  rawMarketResult: unknown,
  profile?: MorphoV2TrustedProfile,
): MorphoV2ProtocolReadSpec {
  const s = structuredClone(source),
    selected = selectedProfile(profile),
    h = selectedHistory(selected),
    fixed = morphoV2ProtocolReadPlan(s, undefined, selected),
    market = decoded(fixed.find((spec) => spec.key === 'market')!, rawMarketResult)
  check(
    Array.isArray(market) &&
      market.length === 6 &&
      market.every((value) => typeof value === 'bigint'),
    'market',
  )
  return structuredClone(plan(h, s, market)[0])
}
/** Shared retained-wire validation also strips headers to the three replayed fields. */
export function normalizeMorphoV2ProtocolReadResult(
  spec: MorphoV2ProtocolReadSpec,
  value: unknown,
  source: MorphoV2NativeSource,
): unknown {
  if (spec.key.startsWith('header_')) return normalizeMorphoV2ProtocolHeader(value, source)
  check(typeof value === 'string' && HEX.test(value) && value.length <= 131072, 'raw_result')
  return value
}
/** Authority is supplied externally by the native finalized/header boundary, not by observation defaults. */
export function replayMorphoV2CurrentProtocolOrigin(
  value: unknown,
  expectedSource: MorphoV2NativeSource,
  asOfMs: number,
  profile?: MorphoV2TrustedProfile,
) {
  try {
    const o = structuredClone(value) as MorphoV2ProtocolOriginObservation,
      s = structuredClone(expectedSource),
      selected = selectedProfile(profile),
      h = selectedHistory(selected)
    check(
      isMorphoV2NativeSourceValid(s, asOfMs) &&
        exact(o.source, s) &&
        utc(o.startedAtUtc) &&
        utc(o.readAtUtc) &&
        Date.parse(o.startedAtUtc) >= Date.parse(s.blockTime) &&
        Date.parse(o.readAtUtc) <= asOfMs &&
        Date.parse(o.readAtUtc) >= Date.parse(o.startedAtUtc) &&
        Number.isSafeInteger(o.deadlineMs) &&
        o.deadlineMs >= 1 &&
        o.deadlineMs <= 8000 &&
        Date.parse(o.readAtUtc) - Date.parse(o.startedAtUtc) <= o.deadlineMs &&
        Array.isArray(o.traces) &&
        o.traces.length === 31,
      'origin_envelope',
    )
    const fixed = plan(h, s),
      by = new Map(o.traces.map((t) => [t.key, t]))
    check(by.size === 31, 'duplicate_key')
    const get = (key: string) => decoded(fixed.find((x) => x.key === key)!, by.get(key)?.result)
    const market = get('market')
    check(
      Array.isArray(market) && market.length === 6 && market.every((x) => typeof x === 'bigint'),
      'market',
    )
    const specs = morphoV2ProtocolReadPlan(s, market, selected)
    let previous = Date.parse(o.startedAtUtc),
      bytes = 0
    o.traces.forEach((t, i) => {
      const spec = specs[i]
      check(
        t.key === spec.key &&
          t.method === spec.method &&
          exact(t.params, spec.params) &&
          utc(t.startedAtUtc) &&
          utc(t.completedAtUtc),
        'trace_plan',
      )
      const a = Date.parse(t.startedAtUtc),
        b = Date.parse(t.completedAtUtc)
      check(a >= previous && b >= a && b <= Date.parse(o.readAtUtc) && b - a <= 8000, 'trace_clock')
      previous = b
      normalizeMorphoV2ProtocolReadResult(spec, t.result, s)
      bytes += JSON.stringify(t.result).length
    })
    check(bytes <= 256 * 1024, 'retained_bytes')
    check(
      get('asset').toLowerCase() === h.subject.asset &&
        get('shareDecimals') === selected.subject.shareDecimals &&
        get('assetDecimals') === selected.subject.assetDecimals &&
        get('liquidityAdapter').toLowerCase() === h.configured.adapter &&
        get('liquidityData') === h.configured.liquidityData &&
        get('isAdapter') === true,
      'native_config',
    )
    check(
      get('adapterParentVault').toLowerCase() === h.subject.destination &&
        get('adapterAsset').toLowerCase() === h.subject.asset &&
        get('adapterMorpho').toLowerCase() === h.configured.morpho &&
        get('adapterIrm').toLowerCase() === h.configured.irm,
      'adapter_class',
    )
    const params = decodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      h.configured.liquidityData as `0x${string}`,
    )
    check(
      exact(
        get('marketParams').map((v: any) => (typeof v === 'string' ? v.toLowerCase() : v)),
        params.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)),
      ),
      'market_identity',
    )
    for (const id of h.runtimeIdentities) {
      const code = by.get('code_' + id.key)!.result
      check(
        typeof code === 'string' &&
          code.length > 2 &&
          keccak256(code as `0x${string}`) === id.codeHash,
        'runtime_class',
      )
    }
    const internal = get('adapterSupplyShares'),
      position = get('position'),
      allowance = get('adapterAllowance'),
      cash = get('idleCash'),
      blue = get('blueCash'),
      rate = decoded(specs.find((x) => x.key === 'borrowRate')!, by.get('borrowRate')!.result),
      allocations = [0, 1, 2].map((i) => get('allocation' + i)),
      feeRecipient = get('feeRecipient').toLowerCase()
    check(
      market[5] === 0n &&
        feeRecipient === '0x0000000000000000000000000000000000000000' &&
        get('rateAtTarget') > 0n,
      'pilot_fee_rate',
    )
    check(
      [internal, position[0], allowance, cash, blue, rate, ...allocations].every(
        (x) => typeof x === 'bigint' && x >= 0n && x <= MAX,
      ),
      'native_prongs',
    )
    const math = morphoV2AdapterCapacityMath({
      market,
      at: BigInt(Date.parse(s.blockTime) / 1000),
      borrowRate: rate,
      internalShares: internal,
      actualShares: position[0],
      blueCash: blue,
      allowance,
      idleCash: cash,
      allocations,
      enrolled: true,
    })
    check(
      get('adapterExpectedAssets').toString() === math.internalPositionAssetsRaw,
      'expected_assets',
    )
    return {
      source: {
        chainId: 1 as const,
        blockNumber: String(s.blockNumber),
        blockHash: s.blockHash,
        blockTime: s.blockTime,
      },
      status: 'single_origin_conditional_configured_adapter_prongs' as const,
      prongs: {
        idleCashRaw: String(cash),
        blueCashRaw: String(blue),
        market: market.map(String),
        internalSharesRaw: String(internal),
        actualSharesRaw: String(position[0]),
        allowanceRaw: String(allowance),
        allocationsRaw: allocations.map(String),
        borrowRateRaw: String(rate),
        feeRecipient,
      },
    }
  } catch {
    return null
  }
}
/** Absent profile retains the pilot-specific type as well as its runtime default. */
export function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: Omit<MorphoV2ProtocolCapacityExpected, 'profile'> & { profile?: undefined },
  sha256Text: MorphoV2Sha256Text,
): MorphoV2HolderTimeProcessInput['current'] | null
export function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
  sha256Text: MorphoV2Sha256Text,
): ReviewedMorphoV2ProtocolCurrent | null
export function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
  sha256Text: MorphoV2Sha256Text,
) {
  try {
    const v = structuredClone(value) as MorphoV2ProtocolCapacityObservation,
      selected = selectedProfile(expected.profile),
      e = structuredClone({
        source: expected.source,
        asOfMs: expected.asOfMs,
        originHosts: expected.originHosts,
      }),
      h = selectedHistory(selected)
    check(approveReviewedMorphoV2ProtocolHistory(selected, h, sha256Text), 'history_frame_pin')
    check(
      isMorphoV2NativeSourceValid(e.source, e.asOfMs) &&
        Array.isArray(e.originHosts) &&
        e.originHosts.length === 2 &&
        new Set(e.originHosts).size === 2 &&
        e.originHosts.every(
          (x) => typeof x === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(x),
        ) &&
        Array.isArray(v.origins) &&
        v.origins.length === 2 &&
        exact(v.origins.map((x) => x.host).sort(), [...e.originHosts].sort()),
      'origins',
    )
    const points = v.origins.map((x) =>
      replayMorphoV2CurrentProtocolOrigin(x.observation, e.source, e.asOfMs, selected),
    )
    check(points[0] !== null && points[1] !== null && exact(points[0], points[1]), 'agreement')
    const readAtUtc = v.origins
      .map((x) => x.observation.readAtUtc)
      .sort()
      .at(-1)!
    const captureReceiptSha256 = sha256Text(JSON.stringify(v))
    check(
      typeof captureReceiptSha256 === 'string' && /^[a-f0-9]{64}$/.test(captureReceiptSha256),
      'receipt_digest',
    )
    const current: ReviewedMorphoV2ProtocolCurrent = {
      subject: h.subject,
      configured: h.configured,
      runtimeIdentities: h.runtimeIdentities,
      captureReceiptSha256,
      knowledgeCutoff: readAtUtc,
      point: { ...points[0], status: 'two_origin_conditional_configured_adapter_prongs' },
      readAtUtc,
      sourceImplementationEquivalence: false,
    }
    return current
  } catch {
    return null
  }
}
type ApprovedProtocolCurrent<T> = {
  current: T
  acceptEvidence: (candidate: unknown) => boolean
  sourceImplementationEquivalence: false
}
export function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: Omit<MorphoV2ProtocolCapacityExpected, 'profile'> & { profile?: undefined },
  sha256Text: MorphoV2Sha256Text,
): ApprovedProtocolCurrent<MorphoV2HolderTimeProcessInput['current']> | null
export function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
  sha256Text: MorphoV2Sha256Text,
): ApprovedProtocolCurrent<ReviewedMorphoV2ProtocolCurrent> | null
export function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
  sha256Text: MorphoV2Sha256Text,
) {
  try {
    const record = freeze(structuredClone(value)),
      profile = selectedProfile(expected.profile),
      e = freeze({
        ...structuredClone({
          source: expected.source,
          asOfMs: expected.asOfMs,
          originHosts: expected.originHosts,
        }),
        profile,
      }),
      current = replayMorphoV2CurrentProtocolCapacityEvidence(record, e, sha256Text)
    if (!current) return null
    const trusted = freeze(structuredClone(current))
    return {
      current: structuredClone(trusted),
      acceptEvidence: (candidate: unknown) => {
        try {
          return exact(structuredClone(candidate), trusted)
        } catch {
          return false
        }
      },
      sourceImplementationEquivalence: false as const,
    }
  } catch {
    return null
  }
}
