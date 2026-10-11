import {
  APY_USD_JOINT_NATIVE_ANCHORS,
  APY_USD_JOINT_NATIVE_PROFILE_ID,
  APY_USD_JOINT_NATIVE_SUBJECT,
  replayApyUsdJointNativeCurrent,
  replayApyUsdJointNativeHistoryPoint,
  type ApyUsdJointNativeCurrentBinding,
  type ApyUsdJointNativeCurrentWire,
  type ApyUsdJointNativeHistoryBinding,
  type ApyUsdJointNativeHistoryWire,
} from './apyUsdJointNativeEvidence'
import {
  buildApyUsdJointStockProjection,
  type ApyUsdJointSource,
  type ApyUsdJointStockProjection,
  type ApyUsdJointStockProjectionInput,
} from './apyUsdJointStockProjection'
import { parseUsd3JointNativeEvidenceJson } from './usd3JointNativeEvidenceCodec'

export type ApyUsdJointHolderForecastQuestion = {
  routeKey: string
  destination: string
  requestedHolderAddress: string
  requestedRaw: string
  requestedAssetAddress: string
  requestedAssetDecimals: 18
  horizonHours: number
  asOfMs: number
  plannedInitiationOffsetSeconds: number
  fundingBasis: 'native_liquid_cash' | 'cash_plus_vested_assumption'
  independentSource?: ApyUsdJointSource
}
export type ApyUsdJointCurrentEvidence = {
  binding: ApyUsdJointNativeCurrentBinding
  wire: ApyUsdJointNativeCurrentWire
  availableAtUtc: string
}
export type ApyUsdJointHistoricalEvidence = {
  schema: 'apyusd_joint_native_history_evidence_v1'
  points: readonly {
    binding: ApyUsdJointNativeHistoryBinding
    wire: ApyUsdJointNativeHistoryWire
  }[]
  acquiredAtUtc: string
  availableAtUtc: string
  fullSharesRaw: string
  owner: null
  historicalOwnership: false
  originalAuthority: false
  authenticated: false
  executionQualified: false
}
export type ApyUsdJointHolderForecastIssue = Readonly<{
  issuedAtMs: number
  horizonHours: number
  plannedInitiationOffsetSeconds: number
  fundingBasis: ApyUsdJointHolderForecastQuestion['fundingBasis']
  owner: string
  requestedRaw: string
  fullSharesRaw: string
  fullEscrowEaRaw: string
  fullGrossAssetsRaw: string
  fullWithdrawalSharesRaw: string
  candidateReceiptIds: readonly string[]
  ownedReceiptIds: readonly string[]
  receiptInventory: NonNullable<ApyUsdJointStockProjectionInput['current']['receiptInventory']>
  profileId: string
  runtimeRegime: string
  source: ApyUsdJointSource
  currentAvailableAtUtc: string
  historyAvailableAtUtc: string
  asset: string
  assetDecimals: 18
  shareDecimals: 18
}>
export type ApyUsdJointHolderForecast = Readonly<{
  process: ApyUsdJointStockProjection
  input: ApyUsdJointStockProjectionInput
  source: ApyUsdJointSource
  profileId: string
  issueAtUtc: string
  targetAtUtc: string
  sourceProofValidUntil: string
  asset: string
  assetDecimals: 18
  shareDecimals: 18
  MRaw: null
  originalAuthority: false
  authenticated: false
  historicalOwnership: false
  executionQualified: false
  calibrated: false
  sourceImplementationEquivalence: false
}>
export const APY_USD_JOINT_BINDING_LIMITS = Object.freeze({
  transportBytes: 8 * 1024 * 1024,
  nodes: 100000,
  sourceMs: 1800000,
  receiptMs: 1800000,
})
const nativeNow = Date.now,
  NativeDate = Date,
  MAX = (1n << 256n) - 1n,
  utf8 = new TextEncoder()
const models = new WeakMap<
  object,
  { question: ApyUsdJointHolderForecastQuestion; issue: ApyUsdJointHolderForecastIssue }
>()
const receipts = new WeakMap<object, ApyUsdJointHolderForecast>()
function check(v: unknown): asserts v {
  if (!v) throw Error('apy_joint_binding_rejected')
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k))
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
function utc(v: unknown): number {
  check(
    typeof v === 'string' &&
      Number.isSafeInteger(Date.parse(v)) &&
      new NativeDate(v).toISOString() === v,
  )
  return Date.parse(v)
}
function actualClock(): number {
  check(Date.now === nativeNow && Date === NativeDate)
  return nativeNow()
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    )
  return (
    record(a) &&
    record(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  )
}
/** Bounded plain data only. No accessor, prototype, callback or claimed receipt becomes provenance. */
function snapshot(
  input: unknown,
  cap: number = APY_USD_JOINT_BINDING_LIMITS.transportBytes,
  nodeCap: number = APY_USD_JOINT_BINDING_LIMITS.nodes,
): unknown {
  let nodes = 0,
    bytes = 0
  const ancestry = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= nodeCap && depth <= 32)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isFinite(v))
      return v
    }
    if (typeof v === 'string') {
      check(v.length <= cap)
      bytes += utf8.encode(v).length
      check(bytes <= cap)
      return v
    }
    check(
      v &&
        typeof v === 'object' &&
        !ancestry.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
    )
    ancestry.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(Object.values(ds).every((d) => Object.hasOwn(d, 'value')))
    let out: unknown
    if (Array.isArray(v)) {
      check(v.length <= 2000 && Object.getOwnPropertyNames(v).length === v.length + 1)
      out = Array.from({ length: v.length }, (_, i) => {
        check(ds[i]?.enumerable)
        return copy(ds[i].value, depth + 1)
      })
    } else {
      const o: Record<string, unknown> = {}
      for (const [k, d] of Object.entries(ds)) {
        check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k))
        bytes += k.length
        check(bytes <= cap)
        o[k] = copy(d.value, depth + 1)
      }
      out = o
    }
    ancestry.delete(v)
    return out
  }
  const out = copy(input, 0)
  check(utf8.encode(JSON.stringify(out)).length <= cap)
  return out
}
function question(input: ApyUsdJointHolderForecastQuestion): ApyUsdJointHolderForecastQuestion {
  const q = snapshot(input, 4096, 128)
  check(
    record(q) &&
      keys(q, [
        'routeKey',
        'destination',
        'requestedHolderAddress',
        'requestedRaw',
        'requestedAssetAddress',
        'requestedAssetDecimals',
        'horizonHours',
        'asOfMs',
        'plannedInitiationOffsetSeconds',
        'fundingBasis',
        ...(Object.hasOwn(q, 'independentSource') ? ['independentSource'] : []),
      ]),
  )
  const s = APY_USD_JOINT_NATIVE_SUBJECT,
    owner =
      typeof q.requestedHolderAddress === 'string' ? q.requestedHolderAddress.toLowerCase() : ''
  check(
    q.routeKey === s.routeKey &&
      typeof q.destination === 'string' &&
      q.destination.toLowerCase() === s.destination &&
      typeof q.requestedAssetAddress === 'string' &&
      q.requestedAssetAddress.toLowerCase() === s.asset &&
      q.requestedAssetDecimals === 18 &&
      /^0x[0-9a-f]{40}$/.test(owner) &&
      owner !== '0x' + '0'.repeat(40) &&
      uint(q.requestedRaw) &&
      q.requestedRaw !== '0',
  )
  check(
    Number.isSafeInteger(q.horizonHours) &&
      Number(q.horizonHours) >= 1 &&
      Number(q.horizonHours) <= 720 &&
      Number.isSafeInteger(q.asOfMs) &&
      Number(q.asOfMs) >= 0 &&
      Number.isSafeInteger(q.plannedInitiationOffsetSeconds) &&
      Number(q.plannedInitiationOffsetSeconds) >= 0 &&
      Number(q.plannedInitiationOffsetSeconds) <= 30 * 86400 &&
      ['native_liquid_cash', 'cash_plus_vested_assumption'].includes(String(q.fundingBasis)),
  )
  const target = Number(q.asOfMs) + Number(q.horizonHours) * 3600000
  check(Number.isSafeInteger(target) && target <= 8640000000000000)
  if (Object.hasOwn(q, 'independentSource')) {
    const source = q.independentSource
    check(
      record(source) &&
        keys(source, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']) &&
        source.chainId === 1 &&
        source.finalized === true &&
        Number.isSafeInteger(source.blockNumber) &&
        Number(source.blockNumber) > 0 &&
        typeof source.blockHash === 'string' &&
        /^0x[0-9a-f]{64}$/.test(source.blockHash) &&
        utc(source.blockTime) % 1000 === 0,
    )
  }
  return freeze({
    ...q,
    destination: s.destination,
    requestedHolderAddress: owner,
    requestedAssetAddress: s.asset,
  } as ApyUsdJointHolderForecastQuestion)
}
/** Canonical unsigned replay establishes local private model identity, never native acquisition authority. */
export function issuedApyUsdJointHolderForecast(
  suppliedCurrent: unknown,
  suppliedHistory: unknown,
  suppliedQuestion: ApyUsdJointHolderForecastQuestion,
): ApyUsdJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion),
      pair = snapshot({ current: suppliedCurrent, history: suppliedHistory })
    check(record(pair) && record(pair.current) && record(pair.history))
    const currentEvidence = pair.current,
      h = pair.history
    check(
      keys(currentEvidence, ['binding', 'wire', 'availableAtUtc']) &&
        record(currentEvidence.binding),
    )
    const current = replayApyUsdJointNativeCurrent(
      currentEvidence.wire,
      currentEvidence.binding as ApyUsdJointNativeCurrentBinding,
    )
    check(
      current.owner === q.requestedHolderAddress &&
        current.current.profileId === APY_USD_JOINT_NATIVE_PROFILE_ID &&
        current.current.receiptInventory?.complete &&
        (!q.independentSource || same(q.independentSource, current.current.source)),
    )
    const currentAvailable = utc(currentEvidence.availableAtUtc),
      currentAcquired = utc(current.current.readAtUtc)
    check(
      currentAvailable >= currentAcquired &&
        q.asOfMs >= currentAvailable &&
        q.asOfMs <= actualClock(),
    )
    check(
      keys(h, [
        'schema',
        'points',
        'acquiredAtUtc',
        'availableAtUtc',
        'fullSharesRaw',
        'owner',
        'historicalOwnership',
        'originalAuthority',
        'authenticated',
        'executionQualified',
      ]) &&
        h.schema === 'apyusd_joint_native_history_evidence_v1' &&
        h.fullSharesRaw === current.current.fullSharesRaw &&
        h.owner === null &&
        ['historicalOwnership', 'originalAuthority', 'authenticated', 'executionQualified'].every(
          (k) => h[k] === false,
        ) &&
        Array.isArray(h.points) &&
        h.points.length === 8,
    )
    const historyAvailable = utc(h.availableAtUtc),
      historyAcquired = utc(h.acquiredAtUtc)
    check(historyAvailable >= historyAcquired && q.asOfMs >= historyAvailable)
    const history = h.points.map((value, i) => {
      check(record(value) && keys(value, ['binding', 'wire']) && record(value.binding))
      const b = value.binding
      check(
        b.cashIndex === APY_USD_JOINT_NATIVE_ANCHORS[i].cashIndex &&
          record(b.currentSource) &&
          Number(b.currentSource.blockNumber) <= current.current.source.blockNumber &&
          utc(b.currentSource.blockTime) <= utc(current.current.source.blockTime) &&
          (b.currentSource.blockNumber !== current.current.source.blockNumber ||
            same(b.currentSource, current.current.source)) &&
          b.fullSharesRaw === current.current.fullSharesRaw &&
          b.currentRuntimeRegime === current.current.runtimeRegime &&
          b.vestingAddress === current.vestingAddress &&
          b.vaultUnlockingFeeWad === current.current.vaultUnlockingFeeWad,
      )
      const point = replayApyUsdJointNativeHistoryPoint(
        value.wire,
        b as ApyUsdJointNativeHistoryBinding,
      )
      check(
        utc(point.acquiredAtUtc) <= historyAvailable &&
          same(point.runtimeIdentities, current.runtimeIdentities) &&
          same(point.feeCurve, current.current.feeCurve) &&
          point.owner === null &&
          point.historicalOwnership === false,
      )
      return point
    })
    check(Math.max(...history.map((p) => utc(p.acquiredAtUtc))) === historyAcquired)
    const process = buildApyUsdJointStockProjection({
      current: current.current,
      history,
      question: {
        issuedAtUtc: new NativeDate(q.asOfMs).toISOString(),
        horizonHours: q.horizonHours,
        plannedInitiationOffsetSeconds: q.plannedInitiationOffsetSeconds,
        requestedRaw: q.requestedRaw,
      },
      fundingBasis: q.fundingBasis,
    })
    check(process)
    const model = freeze<ApyUsdJointHolderForecast>({
      process,
      input: process.input,
      source: current.current.source,
      profileId: APY_USD_JOINT_NATIVE_PROFILE_ID,
      issueAtUtc: new NativeDate(q.asOfMs).toISOString(),
      targetAtUtc: process.targetAtUtc,
      sourceProofValidUntil: new NativeDate(
        utc(current.current.source.blockTime) + APY_USD_JOINT_BINDING_LIMITS.sourceMs,
      ).toISOString(),
      asset: APY_USD_JOINT_NATIVE_SUBJECT.asset,
      assetDecimals: 18,
      shareDecimals: 18,
      MRaw: null,
      originalAuthority: false,
      authenticated: false,
      historicalOwnership: false,
      executionQualified: false,
      calibrated: false,
      sourceImplementationEquivalence: false,
    })
    const issue = freeze<ApyUsdJointHolderForecastIssue>({
      issuedAtMs: q.asOfMs,
      horizonHours: q.horizonHours,
      plannedInitiationOffsetSeconds: q.plannedInitiationOffsetSeconds,
      fundingBasis: q.fundingBasis,
      owner: current.owner,
      requestedRaw: q.requestedRaw,
      fullSharesRaw: current.current.fullSharesRaw,
      fullEscrowEaRaw: current.current.fullEscrowEaRaw,
      fullGrossAssetsRaw: current.current.fullGrossAssetsRaw,
      fullWithdrawalSharesRaw: current.fullWithdrawalSharesRaw,
      candidateReceiptIds: current.candidateReceiptIds,
      ownedReceiptIds: current.ownedReceiptIds,
      receiptInventory: current.current.receiptInventory!,
      profileId: APY_USD_JOINT_NATIVE_PROFILE_ID,
      runtimeRegime: current.current.runtimeRegime,
      source: current.current.source,
      currentAvailableAtUtc: currentEvidence.availableAtUtc as string,
      historyAvailableAtUtc: h.availableAtUtc as string,
      asset: APY_USD_JOINT_NATIVE_SUBJECT.asset,
      assetDecimals: 18,
      shareDecimals: 18,
    })
    models.set(model, { question: q, issue })
    receipts.set(issue, model)
    return model
  } catch {
    return null
  }
}
export function apyUsdJointHolderForecastRenderWindow(
  value: unknown,
  renderAsOfMs?: number,
): boolean {
  try {
    const bound = record(value) ? models.get(value) : undefined,
      now = actualClock()
    if (!bound) return false
    const render = renderAsOfMs ?? now,
      sourceAt = utc(bound.issue.source.blockTime)
    return (
      Number.isSafeInteger(render) &&
      render >= bound.question.asOfMs &&
      render <= now &&
      now >= bound.question.asOfMs &&
      now - bound.question.asOfMs <= APY_USD_JOINT_BINDING_LIMITS.receiptMs &&
      now - sourceAt <= APY_USD_JOINT_BINDING_LIMITS.sourceMs
    )
  } catch {
    return false
  }
}
export function selectedApyUsdJointHolderForecast(
  value: unknown,
  suppliedQuestion: ApyUsdJointHolderForecastQuestion,
  renderAsOfMs?: number,
): ApyUsdJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion)
    return record(value) &&
      same(models.get(value)?.question, q) &&
      apyUsdJointHolderForecastRenderWindow(value, renderAsOfMs)
      ? (value as unknown as ApyUsdJointHolderForecast)
      : null
  } catch {
    return null
  }
}
export function apyUsdJointHolderForecastIssue(
  value: unknown,
): ApyUsdJointHolderForecastIssue | null {
  return record(value) ? (models.get(value)?.issue ?? null) : null
}
export function selectedApyUsdJointHolderForecastFromIssue(
  value: unknown,
  q: ApyUsdJointHolderForecastQuestion,
  renderAsOfMs?: number,
): ApyUsdJointHolderForecast | null {
  return record(value)
    ? selectedApyUsdJointHolderForecast(receipts.get(value), q, renderAsOfMs)
    : null
}
export function selectedApyUsdJointHolderForecastIssue(
  value: unknown,
  q: ApyUsdJointHolderForecastQuestion,
  renderAsOfMs?: number,
): ApyUsdJointHolderForecastIssue | null {
  return selectedApyUsdJointHolderForecastFromIssue(value, q, renderAsOfMs)
    ? (value as ApyUsdJointHolderForecastIssue)
    : null
}
export function apyUsdJointHolderForecastFromResponse(
  value: unknown,
  status: number,
  suppliedQuestion: ApyUsdJointHolderForecastQuestion,
  receivedAtMs: number,
): ApyUsdJointHolderForecast | null {
  try {
    const response = snapshot(
        typeof value === 'string'
          ? parseUsd3JointNativeEvidenceJson(value, APY_USD_JOINT_BINDING_LIMITS.transportBytes)
          : value,
      ),
      q = question(suppliedQuestion),
      now = actualClock()
    check(
      record(response) &&
        (status === 200 ||
          (status === 503 && response.error === 'holder_exit_assessment_unavailable')) &&
        Number.isSafeInteger(receivedAtMs) &&
        receivedAtMs >= q.asOfMs &&
        receivedAtMs <= now &&
        utc(response.apyUsdJointIssuedAtUtc) === q.asOfMs,
    )
    const model = issuedApyUsdJointHolderForecast(
      response.apyUsdJointNativeCurrentEvidence,
      response.apyUsdJointHistoricalEvidence,
      q,
    )
    return selectedApyUsdJointHolderForecast(model, q, receivedAtMs)
  } catch {
    return null
  }
}
export function apyUsdJointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  q: ApyUsdJointHolderForecastQuestion,
  receivedAtMs: number,
): ApyUsdJointHolderForecastIssue | null {
  return apyUsdJointHolderForecastIssue(
    apyUsdJointHolderForecastFromResponse(value, status, q, receivedAtMs),
  )
}
