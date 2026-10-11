import {
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  selectedHolderExitCapacity,
  type HolderExitCapacityAgreement,
} from './holderExitCapacity'
import type { MorphoV2HolderForecastQuestion } from './morphoV2HolderForecastBinding'
import { decodeFluidUsdcBridgeJointNativeHistoryEvidence } from './fluidUsdcBridgeJointNativeEvidenceCodec'
import { resolveFluidUsdcBridgeJointTrustedProfile } from './fluidUsdcBridgeJointTrustedProfile'
import { replayFluidUsdcBridgeNativeCapacityFact } from './fluidUsdcBridgeNativeCapacity'
import {
  buildFluidUsdcBridgeJointLiveTimeProcess,
  type FluidUsdcBridgeJointLiveTimeInput,
} from './fluidUsdcBridgeJointLiveTimeProcess'

export const FLUID_USDC_BRIDGE_JOINT_ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
export const FLUID_USDC_BRIDGE_JOINT_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
export const FLUID_USDC_BRIDGE_JOINT_ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export type FluidUsdcBridgeJointHolderForecastQuestion = MorphoV2HolderForecastQuestion
type Source = HolderExitCapacityAgreement['quote']['source']
type CanonicalQuestion = {
  routeKey: typeof FLUID_USDC_BRIDGE_JOINT_ROUTE
  destination: typeof FLUID_USDC_BRIDGE_JOINT_VAULT
  requestedHolderAddress: string
  requestedRaw: string
  requestedAssetAddress: typeof FLUID_USDC_BRIDGE_JOINT_ASSET
  requestedAssetDecimals: 6
  horizonHours: number
  asOfMs: number
  independentSource?: MorphoV2HolderForecastQuestion['independentSource']
}
export type FluidUsdcBridgeJointHolderForecastIssue = {
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  fullEaRaw: string
  sharesRaw: string
  profileId: string
  asset: typeof FLUID_USDC_BRIDGE_JOINT_ASSET
  assetDecimals: 6
  shareDecimals: 18
  source: Source
  independentSource?: unknown
}
type LiveModel = NonNullable<ReturnType<typeof buildFluidUsdcBridgeJointLiveTimeProcess>>
export type FluidUsdcBridgeJointHolderForecast = LiveModel & {
  process: NonNullable<LiveModel['process']>
  profileId: string
  source: Source
  asset: typeof FLUID_USDC_BRIDGE_JOINT_ASSET
  assetDecimals: 6
  shareDecimals: 18
  originalAuthority: false
  authenticated: false
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

// Snapshot before reading caller data: no getters, prototypes, callbacks, aliases
// or oversized trees reach capacity reconstruction. Nothing here grants native authority.
// Three bounded four-anchor native captures require more nodes than current facts.
// This allowance is private and used only for history and its response envelope.
const HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES = 20000
function snapshot(input: unknown, cap = 4 * 1024 * 1024, maxNodes = 10000): unknown {
  const seen = new WeakSet<object>()
  let nodes = 0,
    size = 0
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 24) throw Error('fluid_bridge_binding_tree')
    if (typeof v === 'string') {
      size += v.length * 3
      if (size > cap) throw Error('fluid_bridge_binding_bytes')
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    if (
      !v ||
      typeof v !== 'object' ||
      seen.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)
    )
      throw Error('fluid_bridge_binding_plain_data')
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    if (Object.values(ds).some((d) => !Object.hasOwn(d, 'value')))
      throw Error('fluid_bridge_binding_accessor')
    let result: unknown
    if (Array.isArray(v)) {
      if (v.length > 2000 || Object.getOwnPropertyNames(v).length !== v.length + 1)
        throw Error('fluid_bridge_binding_array')
      result = Array.from({ length: v.length }, (_, n) => {
        if (!ds[n]?.enumerable) throw Error('fluid_bridge_binding_sparse')
        return copy(ds[n].value, depth + 1)
      })
    } else {
      const out: Record<string, unknown> = {}
      for (const [key, d] of Object.entries(ds)) {
        size += key.length * 3
        if (!d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key) || size > cap)
          throw Error('fluid_bridge_binding_key')
        out[key] = copy(d.value, depth + 1)
      }
      result = out
    }
    seen.delete(v)
    return result
  }
  return copy(input, 0)
}

function question(input: FluidUsdcBridgeJointHolderForecastQuestion): CanonicalQuestion | null {
  const q = snapshot(input, 4096)
  if (
    !record(q) ||
    Object.keys(q).some(
      (k) =>
        ![
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
    )
  )
    return null
  const owner =
    typeof q.requestedHolderAddress === 'string' ? q.requestedHolderAddress.toLowerCase() : ''
  if (
    q.routeKey !== FLUID_USDC_BRIDGE_JOINT_ROUTE ||
    typeof q.destination !== 'string' ||
    q.destination.toLowerCase() !== FLUID_USDC_BRIDGE_JOINT_VAULT ||
    typeof q.requestedAssetAddress !== 'string' ||
    q.requestedAssetAddress.toLowerCase() !== FLUID_USDC_BRIDGE_JOINT_ASSET ||
    q.requestedAssetDecimals !== 6 ||
    !/^0x[0-9a-f]{40}$/.test(owner) ||
    owner === '0x' + '0'.repeat(40) ||
    !raw(q.requestedRaw) ||
    q.requestedRaw === '0' ||
    ![1, 24, 48, 168].includes(q.horizonHours as number) ||
    !Number.isSafeInteger(q.asOfMs) ||
    (q.asOfMs as number) < 0 ||
    !Number.isSafeInteger((q.asOfMs as number) + (q.horizonHours as number) * 3600000) ||
    (q.asOfMs as number) + (q.horizonHours as number) * 3600000 > 8640000000000000
  )
    return null
  return {
    routeKey: FLUID_USDC_BRIDGE_JOINT_ROUTE,
    destination: FLUID_USDC_BRIDGE_JOINT_VAULT,
    requestedHolderAddress: owner,
    requestedRaw: q.requestedRaw,
    requestedAssetAddress: FLUID_USDC_BRIDGE_JOINT_ASSET,
    requestedAssetDecimals: 6,
    horizonHours: q.horizonHours as number,
    asOfMs: q.asOfMs as number,
    ...(Object.hasOwn(q, 'independentSource')
      ? {
          independentSource:
            q.independentSource as MorphoV2HolderForecastQuestion['independentSource'],
        }
      : {}),
  }
}
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, n) => same(v, b[n]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  return Object.is(a, b)
}
const models = new WeakMap<
  object,
  { question: CanonicalQuestion; issue: FluidUsdcBridgeJointHolderForecastIssue }
>()
const receipts = new WeakMap<object, FluidUsdcBridgeJointHolderForecast>()

/** Unsigned canonical native replay, not authentication or original acquisition authority. */
export function issuedFluidUsdcBridgeJointHolderForecast(
  capacityAgreement: unknown,
  compactHistoricalEvidence: unknown,
  suppliedQuestion: FluidUsdcBridgeJointHolderForecastQuestion,
  executionAgreement?: unknown,
): FluidUsdcBridgeJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion),
      capacity = snapshot(capacityAgreement)
    const evidence = snapshot(
      compactHistoricalEvidence,
      8 * 1024 * 1024,
      HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES,
    )
    if (!q || !record(capacity) || !record(capacity.quote)) return null
    const profile = resolveFluidUsdcBridgeJointTrustedProfile(
      q.routeKey,
      q.destination,
      q.requestedAssetAddress,
    )
    if (!profile) return null
    const agreement = selectedHolderExitCapacity(capacity, {
      routeKey: q.routeKey,
      destination: q.destination,
      owner: q.requestedHolderAddress,
      requestedRaw: q.requestedRaw,
      asset: q.requestedAssetAddress,
      assetDecimals: 6,
      currentSource: capacity.quote.source as Source,
      asOfMs: q.asOfMs,
      ...(executionAgreement === undefined
        ? {}
        : { executionAgreement: snapshot(executionAgreement) }),
    })
    if (
      !agreement ||
      agreement.quote.successfulRequestedRawLowerBound !== null ||
      !raw(agreement.quote.entitlementRaw) ||
      agreement.quote.entitlementMethod !== 'preview_redeem_full_position'
    )
      return null
    const source = agreement.quote.source,
      position = agreement.quote.sourceHolderPosition
    if (Object.hasOwn(q, 'independentSource') && !same(q.independentSource, source)) return null
    if (
      !position ||
      position.method !== 'balance_of_owner_at_source' ||
      position.shareDecimals !== 18 ||
      !raw(position.sharesRaw) ||
      position.sharesRaw === '0'
    )
      return null
    const origins = agreement.origins
    if (
      !same(origins.map((o) => o.host).sort(), ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].sort())
    )
      return null
    const native = origins.map((o) =>
      replayFluidUsdcBridgeNativeCapacityFact(
        o.quote.fluidUsdcBridgeNativeCapacity,
        q.requestedHolderAddress,
        source,
        q.asOfMs,
      ),
    )
    if (!native[0] || !native[1]) return null
    const a = native[0],
      b = native[1]
    if (
      [a, b].some(
        (f) =>
          f.sharesRaw !== position.sharesRaw ||
          f.fullNetEaRaw !== agreement.quote.entitlementRaw ||
          f.paused !== false ||
          f.feeBps !== profile.feeBps ||
          !same(f.runtimeCodeHashes, profile.runtimeCodeHashes),
      ) ||
      !same(a.nativeProngs, b.nativeProngs)
    )
      return null
    const readAtMs = Math.max(Date.parse(a.readAtUtc), Date.parse(b.readAtUtc)),
      readAtUtc = new Date(readAtMs).toISOString()
    if (
      agreement.quote.fluidUsdcBridgeNativeCapacity?.readAtUtc !== readAtUtc ||
      readAtMs > q.asOfMs
    )
      return null
    const decoded = decodeFluidUsdcBridgeJointNativeHistoryEvidence(evidence)
    if (
      !decoded ||
      decoded.profileId !== profile.profileId ||
      decoded.originalAuthority !== false ||
      decoded.authenticated !== false ||
      !Number.isSafeInteger(Date.parse(decoded.acquiredAtUtc)) ||
      new Date(Date.parse(decoded.acquiredAtUtc)).toISOString() !== decoded.acquiredAtUtc ||
      Date.parse(decoded.acquiredAtUtc) > q.asOfMs ||
      decoded.frames.length < 2 ||
      decoded.frames.length > 129 ||
      decoded.frames.some(
        (f) =>
          f.holderSharesRaw !== position.sharesRaw ||
          f.shareDecimals !== 18 ||
          f.asset !== q.requestedAssetAddress ||
          f.assetDecimals !== 6 ||
          f.withdrawalFeeBps !== profile.feeBps ||
          f.paused !== false ||
          !same(f.runtimeCodeHashes, profile.runtimeCodeHashes) ||
          f.owner !== null ||
          f.historicalOwnership !== false ||
          f.provenanceKind !== 'native_hypothetical_shares' ||
          Date.parse(f.acquiredAtUtc) > q.asOfMs,
      )
    )
      return null
    const cutoff = Math.max(
      readAtMs,
      Date.parse(decoded.acquiredAtUtc),
      ...decoded.frames.map((f) => Date.parse(f.acquiredAtUtc)),
    )
    const input: FluidUsdcBridgeJointLiveTimeInput = {
      routeKey: q.routeKey,
      destination: q.destination,
      asset: q.requestedAssetAddress,
      assetDecimals: 6,
      owner: q.requestedHolderAddress,
      requestedRaw: q.requestedRaw,
      issueAtUtc: new Date(q.asOfMs).toISOString(),
      knowledgeCutoffUtc: new Date(cutoff).toISOString(),
      horizonHours: q.horizonHours as FluidUsdcBridgeJointLiveTimeInput['horizonHours'],
      maxHistoricalGapSeconds: 91800,
      history: decoded.frames.map((f) => ({ ...f, regime: profile.profileId })),
      current: {
        source: {
          chainId: 1,
          blockNumber: String(source.blockNumber),
          blockHash: source.blockHash,
          blockTime: source.blockTime,
        },
        owner: q.requestedHolderAddress,
        readAtUtc,
        acquiredAtUtc: readAtUtc,
        availableAtUtc: readAtUtc,
        provenanceRef: 'fluid_bridge_current:' + source.blockHash,
        holderSharesRaw: position.sharesRaw,
        shareDecimals: 18,
        asset: q.requestedAssetAddress,
        assetDecimals: 6,
        fundingUnit: 'gross_native_USDC',
        entitlementUnit: 'net_native_USDC',
        runtimeCodeHashes: a.runtimeCodeHashes,
        regime: profile.profileId,
        paused: false,
        withdrawalFeeBps: profile.feeBps,
        fullHolderNetUsdcRaw: a.fullNetEaRaw,
        nativeProngs: a.nativeProngs,
      },
    }
    // Exact, already privately snapshotted replay input. No external approval callback.
    const math = buildFluidUsdcBridgeJointLiveTimeProcess(input, (privateInput) =>
      same(privateInput, input),
    )
    if (!math?.process) return null
    const model: FluidUsdcBridgeJointHolderForecast = freeze({
      ...math,
      process: math.process,
      profileId: profile.profileId,
      source: { ...source },
      asset: q.requestedAssetAddress,
      assetDecimals: 6,
      shareDecimals: 18,
      originalAuthority: false,
      authenticated: false,
    })
    const issue: FluidUsdcBridgeJointHolderForecastIssue = freeze({
      issuedAtMs: q.asOfMs,
      horizonHours: q.horizonHours,
      owner: q.requestedHolderAddress,
      requestedRaw: q.requestedRaw,
      sharesRaw: position.sharesRaw,
      fullEaRaw: a.fullNetEaRaw,
      profileId: profile.profileId,
      asset: q.requestedAssetAddress,
      assetDecimals: 6,
      shareDecimals: 18,
      source: { ...source },
      ...(Object.hasOwn(q, 'independentSource') ? { independentSource: q.independentSource } : {}),
    })
    models.set(model, { question: freeze(q), issue })
    receipts.set(issue, model)
    return model
  } catch {
    return null
  }
}

export function fluidUsdcBridgeJointHolderForecastRenderWindow(
  value: unknown,
  renderAsOfMs: number,
) {
  if (!record(value) || !models.has(value)) return false
  const { question: q } = models.get(value)!,
    model = value as FluidUsdcBridgeJointHolderForecast
  return (
    Number.isSafeInteger(renderAsOfMs) &&
    renderAsOfMs >= q.asOfMs &&
    renderAsOfMs - Date.parse(model.source.blockTime) <= HOLDER_CAPACITY_SOURCE_MAX_AGE_MS
  )
}
export function selectedFluidUsdcBridgeJointHolderForecast(
  value: unknown,
  suppliedQuestion: FluidUsdcBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdcBridgeJointHolderForecast | null {
  try {
    if (!record(value)) return null
    const original = models.get(value),
      q = question(suppliedQuestion)
    return original &&
      q &&
      same(original.question, q) &&
      fluidUsdcBridgeJointHolderForecastRenderWindow(value, renderAsOfMs ?? q.asOfMs)
      ? (value as FluidUsdcBridgeJointHolderForecast)
      : null
  } catch {
    return null
  }
}
export function fluidUsdcBridgeJointHolderForecastIssue(
  value: unknown,
): FluidUsdcBridgeJointHolderForecastIssue | null {
  return record(value) ? (models.get(value)?.issue ?? null) : null
}
export function selectedFluidUsdcBridgeJointHolderForecastFromIssue(
  value: unknown,
  q: FluidUsdcBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdcBridgeJointHolderForecast | null {
  if (!record(value)) return null
  return selectedFluidUsdcBridgeJointHolderForecast(receipts.get(value), q, renderAsOfMs)
}
export function selectedFluidUsdcBridgeJointHolderForecastIssue(
  value: unknown,
  q: FluidUsdcBridgeJointHolderForecastQuestion,
  renderAsOfMs?: number,
): FluidUsdcBridgeJointHolderForecastIssue | null {
  return selectedFluidUsdcBridgeJointHolderForecastFromIssue(value, q, renderAsOfMs)
    ? (value as FluidUsdcBridgeJointHolderForecastIssue)
    : null
}
export function fluidUsdcBridgeJointHolderForecastFromResponse(
  value: unknown,
  status: number,
  suppliedQuestion: FluidUsdcBridgeJointHolderForecastQuestion,
): FluidUsdcBridgeJointHolderForecast | null {
  try {
    const response = snapshot(value, 12 * 1024 * 1024, HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES)
    const q = question(suppliedQuestion)
    if (
      !q ||
      !record(response) ||
      (status !== 200 &&
        !(status === 503 && response.error === 'holder_exit_assessment_unavailable')) ||
      typeof response.fluidUsdcBridgeJointIssuedAtUtc !== 'string' ||
      Date.parse(response.fluidUsdcBridgeJointIssuedAtUtc) !== q.asOfMs ||
      new Date(q.asOfMs).toISOString() !== response.fluidUsdcBridgeJointIssuedAtUtc
    )
      return null
    return issuedFluidUsdcBridgeJointHolderForecast(
      response.capacityAgreement,
      response.fluidUsdcBridgeJointHistoricalEvidence,
      q,
      response.executionAgreement,
    )
  } catch {
    return null
  }
}
export function fluidUsdcBridgeJointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  q: FluidUsdcBridgeJointHolderForecastQuestion,
): FluidUsdcBridgeJointHolderForecastIssue | null {
  return fluidUsdcBridgeJointHolderForecastIssue(
    fluidUsdcBridgeJointHolderForecastFromResponse(value, status, q),
  )
}
