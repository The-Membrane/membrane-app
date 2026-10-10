import {
  selectedHolderExitCapacity,
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS,
  type HolderExitCapacityAgreement,
} from './holderExitCapacity'
import type { MorphoV2HolderForecastQuestion } from './morphoV2HolderForecastBinding'
import {
  decodeUsd3JointNativeHistoryEvidence,
  USD3_JOINT_NATIVE_EVIDENCE_LIMITS,
} from './usd3JointNativeEvidenceCodec'
import { resolveUsd3JointTrustedProfile } from './usd3JointTrustedProfile'
import {
  buildUsd3JointLiveTimeProcess,
  type Usd3JointLiveTimeInput,
} from './usd3JointLiveTimeProcess'
import {
  USD3_HISTORICAL_ROUTE,
  USD3_HISTORICAL_USDC,
  USD3_HISTORICAL_VAULT,
} from './usd3JointHistoricalProcess'

export type Usd3JointHolderForecastQuestion = MorphoV2HolderForecastQuestion
type Source = HolderExitCapacityAgreement['quote']['source']
const ZERO = '0x' + '0'.repeat(40),
  MAX = (1n << 256n) - 1n
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const same = (a: unknown, b: unknown): boolean => {
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
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
// Bound cloning happens before consumer code, getters, canonicalization or any callback.
function snapshot(input: unknown, cap: number): unknown {
  const encoder = new TextEncoder(),
    seen = new WeakSet<object>()
  let bytes = 0,
    nodes = 0
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 32) throw Error('usd3_binding_tree_bound')
    if (typeof v === 'string') {
      if (v.length > cap) throw Error('usd3_binding_string_bound')
      bytes += encoder.encode(v).length
      if (bytes > cap) throw Error('usd3_binding_bytes')
      return v
    }
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (
      !v ||
      typeof v !== 'object' ||
      seen.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)
    )
      throw Error('usd3_binding_plain_data')
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    if (Object.values(ds).some((d) => !Object.hasOwn(d, 'value')))
      throw Error('usd3_binding_accessor')
    if (Array.isArray(v)) {
      if (v.length > 20000 || Object.getOwnPropertyNames(v).length !== v.length + 1)
        throw Error('usd3_binding_dense_array')
      const out = Array.from({ length: v.length }, (_, n) => {
        if (!ds[n]?.enumerable) throw Error('usd3_binding_sparse')
        return copy(ds[n].value, depth + 1)
      })
      seen.delete(v)
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(ds)) {
      if (!d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(k))
        throw Error('usd3_binding_hidden_key')
      bytes += k.length
      if (bytes > cap) throw Error('usd3_binding_bytes')
      out[k] = copy(d.value, depth + 1)
    }
    seen.delete(v)
    return out
  }
  const out = copy(input, 0)
  if (encoder.encode(JSON.stringify(out)).length > cap) throw Error('usd3_binding_size')
  return out
}
function canonicalQuestion(input: Usd3JointHolderForecastQuestion) {
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
  const destination = typeof q.destination === 'string' ? q.destination.toLowerCase() : null
  const asset =
    typeof q.requestedAssetAddress === 'string' ? q.requestedAssetAddress.toLowerCase() : null
  const owner =
    typeof q.requestedHolderAddress === 'string' ? q.requestedHolderAddress.toLowerCase() : null
  if (
    !address(destination) ||
    !address(asset) ||
    !address(owner) ||
    owner === ZERO ||
    !uint(q.requestedRaw) ||
    q.requestedRaw === '0' ||
    ![1, 24, 48, 168].includes(q.horizonHours as number) ||
    !Number.isSafeInteger(q.asOfMs) ||
    q.requestedAssetDecimals !== 6 ||
    q.routeKey !== USD3_HISTORICAL_ROUTE
  )
    return null
  const profile = resolveUsd3JointTrustedProfile(q.routeKey, destination, asset)
  if (!profile) return null
  if (Object.hasOwn(q, 'independentSource')) {
    const s = q.independentSource
    if (
      !record(s) ||
      Object.keys(s).length !== 5 ||
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      (s.blockNumber as number) <= 0 ||
      typeof s.blockHash !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(s.blockHash) ||
      !utc(s.blockTime) ||
      Date.parse(s.blockTime) % 1000 !== 0
    )
      return null
  }
  const question = {
    routeKey: q.routeKey,
    destination,
    requestedHolderAddress: owner,
    requestedRaw: q.requestedRaw,
    requestedAssetAddress: asset,
    requestedAssetDecimals: 6 as const,
    horizonHours: q.horizonHours as 1 | 24 | 48 | 168,
    asOfMs: q.asOfMs as number,
    ...(Object.hasOwn(q, 'independentSource')
      ? {
          independentSource:
            q.independentSource as Usd3JointHolderForecastQuestion['independentSource'],
        }
      : {}),
  }
  return { question, profile }
}
function issue(
  capacityInput: unknown,
  historyInput: unknown,
  suppliedQuestion: Usd3JointHolderForecastQuestion,
  executionInput?: unknown,
) {
  const selected = canonicalQuestion(suppliedQuestion)
  if (!selected) return null
  const { question: q, profile } = selected
  const agreementInput = snapshot(capacityInput, 1024 * 1024)
  const historicalInput = snapshot(historyInput, USD3_JOINT_NATIVE_EVIDENCE_LIMITS.transportBytes)
  const executionAgreement =
    executionInput === undefined ? undefined : freeze(snapshot(executionInput, 1024 * 1024))
  if (
    !record(agreementInput) ||
    !record(agreementInput.quote) ||
    !record(agreementInput.quote.source)
  )
    return null
  const source = agreementInput.quote.source as Source
  if (q.independentSource && !same(source, q.independentSource)) return null
  const binding = {
    routeKey: q.routeKey,
    destination: q.destination,
    owner: q.requestedHolderAddress,
    requestedRaw: q.requestedRaw,
    asset: q.requestedAssetAddress,
    assetDecimals: 6,
    currentSource: source,
    asOfMs: q.asOfMs,
    ...(executionAgreement === undefined ? {} : { executionAgreement }),
  }
  const capacity = selectedHolderExitCapacity(agreementInput, binding)
  if (!capacity || capacity.origins.some((o, n) => o.host !== profile.originHosts[n])) return null
  const quote = capacity.quote,
    position = quote.sourceHolderPosition,
    native = quote.usd3NativeCapacity
  const facts = [native, ...capacity.origins.map((o) => o.quote.usd3NativeCapacity)]
  if (
    !position ||
    position.method !== 'balance_of_owner_at_source' ||
    position.shareDecimals !== 6 ||
    !uint(position.sharesRaw) ||
    position.sharesRaw === '0' ||
    quote.entitlementMethod !== 'preview_redeem_full_position' ||
    !uint(quote.entitlementRaw) ||
    quote.fullPositionEntitlementRaw !== quote.entitlementRaw ||
    quote.fullPositionEntitlementMethod !== 'preview_redeem_full_position' ||
    !native ||
    native.resultStatus !== 'quoted' ||
    !uint(native.capacityRaw)
  )
    return null
  if (
    facts.some(
      (f) =>
        !f ||
        !Object.hasOwn(f, 'readAtUtc') ||
        !utc(f.readAtUtc) ||
        Date.parse(f.readAtUtc) < Date.parse(source.blockTime) ||
        Date.parse(f.readAtUtc) > q.asOfMs ||
        !Object.hasOwn(f, 'shutdown') ||
        f.shutdown !== false ||
        f.owner !== q.requestedHolderAddress ||
        !same(f.source, source) ||
        !f.runtimeProfile ||
        f.runtimeProfile.shareDecimals !== 6 ||
        f.runtimeProfile.sourceClass !== 'pinned_usd3_native_runtime' ||
        f.runtimeProfile.contracts.length !== 4 ||
        f.runtimeProfile.contracts.some(
          (c, n) =>
            c.address !== profile.runtimePins[n].address ||
            c.keccak256 !== profile.runtimePins[n].runtimeKeccak256,
        ),
    )
  )
    return null
  const historical = decodeUsd3JointNativeHistoryEvidence(historicalInput)
  if (
    historical.profileId !== profile.id ||
    historical.subject.withdrawalLimitSubject !== q.requestedHolderAddress ||
    historical.subject.sharesRaw !== position.sharesRaw ||
    historical.subject.asset !== q.requestedAssetAddress ||
    historical.subject.assetDecimals !== 6 ||
    historical.subject.shareDecimals !== 6 ||
    Date.parse(historical.acquiredAtUtc) > q.asOfMs
  )
    return null
  const runtimes = native.runtimeProfile!.contracts.map((c) => ({
    address: c.address,
    runtimeKeccak256: c.keccak256,
  }))
  if (
    historical.points.some(
      (p) =>
        p.shutdown !== false ||
        !same(p.runtimeIdentities, runtimes) ||
        Date.parse(p.acquiredAtUtc) > q.asOfMs ||
        Date.parse(p.source.blockTime) >= Date.parse(source.blockTime) ||
        BigInt(p.source.blockNumber) >= BigInt(source.blockNumber),
    )
  )
    return null
  const cutoff = Math.max(
    Date.parse(native.readAtUtc!),
    ...historical.points.map((p) => Date.parse(p.acquiredAtUtc)),
  )
  const input: Usd3JointLiveTimeInput = {
    routeKey: USD3_HISTORICAL_ROUTE,
    destination: USD3_HISTORICAL_VAULT,
    asset: USD3_HISTORICAL_USDC,
    assetDecimals: 6,
    owner: q.requestedHolderAddress,
    issueAtUtc: new Date(q.asOfMs).toISOString(),
    knowledgeCutoffUtc: new Date(cutoff).toISOString(),
    requestedRaw: q.requestedRaw,
    horizonHours: q.horizonHours,
    maxHistoricalGapSeconds: 91800,
    history: historical.points,
    current: {
      source,
      readAtUtc: native.readAtUtc!,
      sharesRaw: position.sharesRaw,
      shareDecimals: 6,
      nativeEaRaw: quote.entitlementRaw,
      availableWithdrawLimitRaw: native.capacityRaw,
      shutdown: false,
      runtimeIdentities: runtimes,
      ownerMaxWithdrawRaw: quote.quotedMaxWithdrawRaw,
    },
  }
  const approved = freeze(structuredClone(input))
  const math = buildUsd3JointLiveTimeProcess(input, (candidate) => same(candidate, approved))
  if (!math?.process) return null
  const model = freeze({
    ...math,
    process: math.process,
    profileId: profile.id,
    source: structuredClone(source),
    fullEaRaw: quote.entitlementRaw,
    asset: q.requestedAssetAddress,
    assetDecimals: 6 as const,
    shareDecimals: 6 as const,
    historicalPastOwnershipProven: false as const,
    authenticated: false as const,
    originalAuthority: false as const,
    authoritativeNativeCapture: false as const,
    historicalEvidenceProvenance: historical.provenance,
  })
  issued.set(model, {
    question: freeze(structuredClone(q)),
    recheck: (at) => selectedHolderExitCapacity(capacity, { ...binding, asOfMs: at }) !== null,
  })
  return model
}
export type Usd3JointHolderForecast = NonNullable<ReturnType<typeof issue>>
const issued = new WeakMap<
  object,
  {
    question: NonNullable<ReturnType<typeof canonicalQuestion>>['question']
    recheck: (at: number) => boolean
  }
>()
const receipts = new WeakMap<object, Usd3JointHolderForecast>()
export function issuedUsd3JointHolderForecast(
  capacityAgreement: unknown,
  compactHistoricalEvidence: unknown,
  question: Usd3JointHolderForecastQuestion,
  executionAgreement?: unknown,
): Usd3JointHolderForecast | null {
  try {
    return issue(capacityAgreement, compactHistoricalEvidence, question, executionAgreement)
  } catch {
    return null
  }
}
export function usd3JointHolderForecastRenderWindow(value: unknown, asOfMs: number): boolean {
  try {
    if (!record(value) || !Number.isSafeInteger(asOfMs)) return false
    const bound = issued.get(value),
      model = value as unknown as Usd3JointHolderForecast
    return (
      !!bound &&
      asOfMs >= bound.question.asOfMs &&
      asOfMs <= Date.parse(model.source.blockTime) + HOLDER_CAPACITY_SOURCE_MAX_AGE_MS &&
      asOfMs <= Date.parse(model.sourceProofValidUntil) &&
      asOfMs < Date.parse(model.targetAtUtc) &&
      bound.recheck(asOfMs)
    )
  } catch {
    return false
  }
}
export function selectedUsd3JointHolderForecast(
  value: unknown,
  question: Usd3JointHolderForecastQuestion,
  renderAsOfMs?: number,
): Usd3JointHolderForecast | null {
  try {
    if (!record(value)) return null
    const bound = issued.get(value),
      selected = canonicalQuestion(question)
    return bound &&
      selected &&
      same(bound.question, selected.question) &&
      usd3JointHolderForecastRenderWindow(value, renderAsOfMs ?? selected.question.asOfMs)
      ? (value as unknown as Usd3JointHolderForecast)
      : null
  } catch {
    return null
  }
}
export type Usd3JointHolderForecastIssue = Readonly<{
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  sharesRaw: string
  fullEaRaw: string
  asset: string
  assetDecimals: number
  shareDecimals: number
  profileId: string
  block: string
  blockHash: string
  source: Source
  independentSource?: Usd3JointHolderForecastQuestion['independentSource']
}>
export function usd3JointHolderForecastIssue(value: unknown): Usd3JointHolderForecastIssue | null {
  if (!record(value) || !issued.has(value)) return null
  const model = value as unknown as Usd3JointHolderForecast,
    question = issued.get(value)!.question
  const receipt = freeze({
    issuedAtMs: question.asOfMs,
    horizonHours: model.horizonHours,
    owner: model.owner,
    requestedRaw: model.requestedRaw,
    sharesRaw: model.sharesRaw,
    fullEaRaw: model.fullEaRaw,
    asset: model.asset,
    assetDecimals: 6,
    shareDecimals: 6,
    profileId: model.profileId,
    block: String(model.source.blockNumber),
    blockHash: model.source.blockHash,
    source: structuredClone(model.source),
    ...(question.independentSource
      ? { independentSource: structuredClone(question.independentSource) }
      : {}),
  })
  receipts.set(receipt, model)
  return receipt
}
export function selectedUsd3JointHolderForecastIssue(
  value: unknown,
  question: Usd3JointHolderForecastQuestion,
  renderAsOfMs?: number,
): Usd3JointHolderForecastIssue | null {
  try {
    if (!record(value)) return null
    const model = receipts.get(value)
    return model && selectedUsd3JointHolderForecast(model, question, renderAsOfMs)
      ? (value as Usd3JointHolderForecastIssue)
      : null
  } catch {
    return null
  }
}
/** Receipt selection retrieves the issued model; retained payload changes never reissue it. */
export function selectedUsd3JointHolderForecastFromIssue(
  value: unknown,
  question: Usd3JointHolderForecastQuestion,
  renderAsOfMs?: number,
): Usd3JointHolderForecast | null {
  try {
    if (!record(value)) return null
    const model = receipts.get(value)
    return model ? selectedUsd3JointHolderForecast(model, question, renderAsOfMs) : null
  } catch {
    return null
  }
}
export function usd3JointHolderForecastFromResponse(
  value: unknown,
  status: number,
  question: Usd3JointHolderForecastQuestion,
): Usd3JointHolderForecast | null {
  try {
    const v = snapshot(value, 2 * 1024 * 1024)
    if (
      !record(v) ||
      ![200, 503].includes(status) ||
      (status === 503 && v.error !== 'holder_exit_assessment_unavailable')
    )
      return null
    return issuedUsd3JointHolderForecast(
      v.capacityAgreement,
      v.usd3JointHistoricalEvidence,
      question,
      v.executionAgreement,
    )
  } catch {
    return null
  }
}
export function usd3JointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  question: Usd3JointHolderForecastQuestion,
): Usd3JointHolderForecastIssue | null {
  const model = usd3JointHolderForecastFromResponse(value, status, question)
  return model ? usd3JointHolderForecastIssue(model) : null
}
