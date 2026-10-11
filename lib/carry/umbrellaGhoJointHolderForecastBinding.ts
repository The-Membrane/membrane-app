import type { MorphoV2HolderForecastQuestion } from './morphoV2HolderForecastBinding'
import { ORIGINAL_GHO, UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from './umbrellaGhoExit'
import {
  selectedUmbrellaGhoNativeCapacityFact,
  type UmbrellaGhoNativeSource,
} from './umbrellaGhoNativeCapacity'
import {
  replayUmbrellaGhoJointNativeHistoryPoint,
  type UmbrellaGhoJointNativeHistoryBinding,
  type UmbrellaGhoJointNativeHistoryWire,
} from './umbrellaGhoJointNativeHistory'
import {
  buildUmbrellaGhoJointStockProjection,
  type UmbrellaGhoJointStockProjection,
} from './umbrellaGhoJointStockProjection'

export type UmbrellaGhoJointHolderForecastQuestion = MorphoV2HolderForecastQuestion
type CanonicalQuestion = {
  routeKey: typeof UMBRELLA_GHO_ROUTE
  destination: typeof UMBRELLA_STKGHO
  requestedHolderAddress: string
  requestedRaw: string
  requestedAssetAddress: typeof ORIGINAL_GHO
  requestedAssetDecimals: 18
  horizonHours: number
  asOfMs: number
  independentSource?: MorphoV2HolderForecastQuestion['independentSource']
}
export type UmbrellaGhoJointHolderForecastIssue = Readonly<{
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  sharesRaw: string
  fullEaRaw: string
  cooldownSharesRaw: string
  cooldownSnapshotEaRaw: string
  profileId: string
  asset: typeof ORIGINAL_GHO
  assetDecimals: 18
  shareDecimals: 18
  source: UmbrellaGhoNativeSource
  independentSource?: MorphoV2HolderForecastQuestion['independentSource']
}>
export type UmbrellaGhoJointHolderForecast = Readonly<{
  process: UmbrellaGhoJointStockProjection
  source: UmbrellaGhoNativeSource
  profileId: string
  issueAtUtc: string
  targetAtUtc: string
  sourceProofValidUntil: string
  asset: typeof ORIGINAL_GHO
  assetDecimals: 18
  shareDecimals: 18
  MRaw: null
  originalAuthority: false
  authenticated: false
  historicalOwnership: false
  executionQualified: false
  calibrated: false
}>
const TTL = 30 * 60000
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
// or oversized trees reach native replay. Nothing here grants native authority.
// Eight reviewed native anchors have a separate bounded history snapshot budget.
// This allowance is private and used only for history and its response envelope.
const HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES = 20000
function snapshot(input: unknown, cap = 4 * 1024 * 1024, maxNodes = 10000): unknown {
  const seen = new WeakSet<object>()
  let nodes = 0,
    size = 0
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 24) throw Error('umbrella_binding_tree')
    if (typeof v === 'string') {
      size += v.length * 3
      if (size > cap) throw Error('umbrella_binding_bytes')
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
      throw Error('umbrella_binding_plain_data')
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    if (Object.values(ds).some((d) => !Object.hasOwn(d, 'value')))
      throw Error('umbrella_binding_accessor')
    let result: unknown
    if (Array.isArray(v)) {
      if (v.length > 2000 || Object.getOwnPropertyNames(v).length !== v.length + 1)
        throw Error('umbrella_binding_array')
      result = Array.from({ length: v.length }, (_, n) => {
        if (!ds[n]?.enumerable) throw Error('umbrella_binding_sparse')
        return copy(ds[n].value, depth + 1)
      })
    } else {
      const out: Record<string, unknown> = {}
      for (const [key, d] of Object.entries(ds)) {
        size += key.length * 3
        if (!d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key) || size > cap)
          throw Error('umbrella_binding_key')
        out[key] = copy(d.value, depth + 1)
      }
      result = out
    }
    seen.delete(v)
    return result
  }
  return copy(input, 0)
}

function question(input: UmbrellaGhoJointHolderForecastQuestion): CanonicalQuestion | null {
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
    q.routeKey !== UMBRELLA_GHO_ROUTE ||
    typeof q.destination !== 'string' ||
    q.destination.toLowerCase() !== UMBRELLA_STKGHO ||
    typeof q.requestedAssetAddress !== 'string' ||
    q.requestedAssetAddress.toLowerCase() !== ORIGINAL_GHO ||
    q.requestedAssetDecimals !== 18 ||
    !/^0x[0-9a-f]{40}$/.test(owner) ||
    owner === '0x' + '0'.repeat(40) ||
    !raw(q.requestedRaw) ||
    q.requestedRaw === '0' ||
    !Number.isSafeInteger(q.horizonHours) ||
    (q.horizonHours as number) < 1 ||
    (q.horizonHours as number) > 720 ||
    !Number.isSafeInteger(q.asOfMs) ||
    (q.asOfMs as number) < 0 ||
    !Number.isSafeInteger((q.asOfMs as number) + (q.horizonHours as number) * 3600000) ||
    (q.asOfMs as number) + (q.horizonHours as number) * 3600000 > 8640000000000000
  )
    return null
  return {
    routeKey: UMBRELLA_GHO_ROUTE,
    destination: UMBRELLA_STKGHO,
    requestedHolderAddress: owner,
    requestedRaw: q.requestedRaw,
    requestedAssetAddress: ORIGINAL_GHO,
    requestedAssetDecimals: 18,
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
  { question: CanonicalQuestion; issue: UmbrellaGhoJointHolderForecastIssue }
>()
const receipts = new WeakMap<object, UmbrellaGhoJointHolderForecast>()
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  Date.parse(v) >= 0 &&
  new Date(Date.parse(v)).toISOString() === v
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).length === allowed.length && Object.keys(v).every((k) => allowed.includes(k))

function sameIndependentSource(value: unknown, source: UmbrellaGhoNativeSource): boolean {
  if (!record(value)) return false
  const identity = ['blockNumber', 'blockHash', 'blockTime']
  const full = [...identity, 'chainId', 'finalized']
  if (
    !(
      keys(value, identity) ||
      (keys(value, full) && value.chainId === 1 && value.finalized === true)
    ) ||
    !Number.isSafeInteger(value.blockNumber) ||
    (value.blockNumber as number) < 0 ||
    typeof value.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.blockHash) ||
    !utc(value.blockTime)
  )
    return false
  return (
    value.blockNumber === source.blockNumber &&
    value.blockHash === source.blockHash &&
    value.blockTime === source.blockTime
  )
}

/** Canonical unsigned native replay. Private model identity is local provenance;
 * serialized data never authenticates a native acquisition or grants execution. */
export function issuedUmbrellaGhoJointHolderForecast(
  suppliedCurrent: unknown,
  suppliedHistory: unknown,
  suppliedQuestion: UmbrellaGhoJointHolderForecastQuestion,
): UmbrellaGhoJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion)
    const currentInput = snapshot(suppliedCurrent)
    const historyInput = snapshot(
      suppliedHistory,
      4 * 1024 * 1024,
      HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES,
    )
    if (!q || !record(currentInput) || !record(historyInput)) return null
    const binding = {
      routeKey: q.routeKey,
      destination: q.destination,
      owner: q.requestedHolderAddress,
      asset: q.requestedAssetAddress,
      assetDecimals: 18 as const,
      shareDecimals: 18 as const,
      source: currentInput.source as UmbrellaGhoNativeSource,
      asOfMs: q.asOfMs,
    }
    const current = selectedUmbrellaGhoNativeCapacityFact(currentInput, binding)
    if (
      !current ||
      (Object.hasOwn(q, 'independentSource') &&
        !sameIndependentSource(q.independentSource, current.source))
    )
      return null
    if (
      !keys(historyInput, [
        'schema',
        'subject',
        'points',
        'acquiredAtUtc',
        'originalAuthority',
        'authenticated',
        'historicalOwnership',
        'executionQualified',
        'forecastIssued',
      ]) ||
      historyInput.schema !== 'umbrella_gho_joint_native_history_evidence_v1' ||
      !record(historyInput.subject) ||
      !keys(historyInput.subject, [
        'fullSharesRaw',
        'cooldownSharesRaw',
        'owner',
        'historicalOwnership',
      ]) ||
      historyInput.subject.fullSharesRaw !== current.fullSharesRaw ||
      historyInput.subject.cooldownSharesRaw !== current.cooldownSharesRaw ||
      historyInput.subject.owner !== null ||
      historyInput.subject.historicalOwnership !== false ||
      ![
        'originalAuthority',
        'authenticated',
        'historicalOwnership',
        'executionQualified',
        'forecastIssued',
      ].every((k) => historyInput[k] === false) ||
      !utc(historyInput.acquiredAtUtc) ||
      Date.parse(historyInput.acquiredAtUtc) > q.asOfMs ||
      !Array.isArray(historyInput.points) ||
      historyInput.points.length !== 8
    )
      return null
    const history = historyInput.points.map((item, index) => {
      if (
        !record(item) ||
        !keys(item, ['binding', 'wire']) ||
        !record(item.binding) ||
        item.binding.cashIndex !== 112 + index ||
        !same(item.binding.currentSource, current.source) ||
        item.binding.fullSharesRaw !== current.fullSharesRaw ||
        item.binding.cooldownSharesRaw !== current.cooldownSharesRaw
      )
        throw Error('umbrella_history_binding')
      const point = replayUmbrellaGhoJointNativeHistoryPoint(
        item.wire as UmbrellaGhoJointNativeHistoryWire,
        item.binding as UmbrellaGhoJointNativeHistoryBinding,
      )
      if (!point || Date.parse(point.acquiredAtUtc) > q.asOfMs)
        throw Error('umbrella_history_replay')
      return point
    })
    if (
      Math.max(...history.map((p) => Date.parse(p.acquiredAtUtc))) !==
      Date.parse(historyInput.acquiredAtUtc)
    )
      return null
    const issueAtUtc = new Date(q.asOfMs).toISOString()
    const process = buildUmbrellaGhoJointStockProjection({
      current,
      history,
      issuedAtUtc: issueAtUtc,
      horizonMs: q.horizonHours * 3600000,
      requestedRaw: q.requestedRaw,
      includeSampledDuration: true,
    })
    if (!process) return null
    // Censored scenarios retain their diagnostic process and private identity.
    const model = freeze<UmbrellaGhoJointHolderForecast>({
      process,
      source: current.source,
      profileId: current.profileId,
      issueAtUtc,
      targetAtUtc: new Date(q.asOfMs + q.horizonHours * 3600000).toISOString(),
      sourceProofValidUntil: new Date(Date.parse(current.source.blockTime) + TTL).toISOString(),
      asset: ORIGINAL_GHO,
      assetDecimals: 18,
      shareDecimals: 18,
      MRaw: null,
      originalAuthority: false,
      authenticated: false,
      historicalOwnership: false,
      executionQualified: false,
      calibrated: false,
    })
    const issue = freeze<UmbrellaGhoJointHolderForecastIssue>({
      issuedAtMs: q.asOfMs,
      horizonHours: q.horizonHours,
      owner: current.owner,
      requestedRaw: q.requestedRaw,
      sharesRaw: current.fullSharesRaw,
      fullEaRaw: current.fullEaRaw,
      cooldownSharesRaw: current.cooldownSharesRaw,
      cooldownSnapshotEaRaw: current.cooldownSnapshotEaRaw,
      profileId: current.profileId,
      asset: ORIGINAL_GHO,
      assetDecimals: 18,
      shareDecimals: 18,
      source: current.source,
      ...(Object.hasOwn(q, 'independentSource') ? { independentSource: q.independentSource } : {}),
    })
    models.set(model, { question: freeze(q), issue })
    receipts.set(issue, model)
    return model
  } catch {
    return null
  }
}
export function umbrellaGhoJointHolderForecastRenderWindow(
  value: unknown,
  renderAsOfMs: number,
): boolean {
  if (!record(value)) return false
  const original = models.get(value)
  return (
    !!original &&
    Number.isSafeInteger(renderAsOfMs) &&
    renderAsOfMs >= original.question.asOfMs &&
    renderAsOfMs -
      Date.parse((value as unknown as UmbrellaGhoJointHolderForecast).source.blockTime) <=
      TTL
  )
}
export function selectedUmbrellaGhoJointHolderForecast(
  value: unknown,
  suppliedQuestion: UmbrellaGhoJointHolderForecastQuestion,
  renderAsOfMs?: number,
): UmbrellaGhoJointHolderForecast | null {
  try {
    const q = question(suppliedQuestion)
    return record(value) &&
      q &&
      same(models.get(value)?.question, q) &&
      umbrellaGhoJointHolderForecastRenderWindow(value, renderAsOfMs ?? q.asOfMs)
      ? (value as unknown as UmbrellaGhoJointHolderForecast)
      : null
  } catch {
    return null
  }
}
export function umbrellaGhoJointHolderForecastIssue(
  value: unknown,
): UmbrellaGhoJointHolderForecastIssue | null {
  return record(value) ? (models.get(value)?.issue ?? null) : null
}
export function selectedUmbrellaGhoJointHolderForecastFromIssue(
  value: unknown,
  q: UmbrellaGhoJointHolderForecastQuestion,
  renderAsOfMs?: number,
): UmbrellaGhoJointHolderForecast | null {
  return record(value)
    ? selectedUmbrellaGhoJointHolderForecast(receipts.get(value), q, renderAsOfMs)
    : null
}
export function selectedUmbrellaGhoJointHolderForecastIssue(
  value: unknown,
  q: UmbrellaGhoJointHolderForecastQuestion,
  renderAsOfMs?: number,
): UmbrellaGhoJointHolderForecastIssue | null {
  return selectedUmbrellaGhoJointHolderForecastFromIssue(value, q, renderAsOfMs)
    ? (value as UmbrellaGhoJointHolderForecastIssue)
    : null
}
export function umbrellaGhoJointHolderForecastFromResponse(
  value: unknown,
  status: number,
  q: UmbrellaGhoJointHolderForecastQuestion,
  receivedAtMs: number,
): UmbrellaGhoJointHolderForecast | null {
  try {
    const response = snapshot(value, 12 * 1024 * 1024, HISTORICAL_NATIVE_SNAPSHOT_MAX_NODES)
    const canonical = question(q)
    if (
      !record(response) ||
      !canonical ||
      !Number.isSafeInteger(receivedAtMs) ||
      receivedAtMs < canonical.asOfMs ||
      (status !== 200 &&
        !(status === 503 && response.error === 'holder_exit_assessment_unavailable')) ||
      !utc(response.umbrellaGhoJointIssuedAtUtc) ||
      Date.parse(response.umbrellaGhoJointIssuedAtUtc) !== canonical.asOfMs ||
      receivedAtMs -
        Date.parse(
          (record(response.umbrellaGhoNativeCapacity) &&
          record(response.umbrellaGhoNativeCapacity.source)
            ? response.umbrellaGhoNativeCapacity.source.blockTime
            : '') as string,
        ) >
        TTL
    )
      return null
    return issuedUmbrellaGhoJointHolderForecast(
      response.umbrellaGhoNativeCapacity,
      response.umbrellaGhoJointHistoricalEvidence,
      canonical,
    )
  } catch {
    return null
  }
}
export function umbrellaGhoJointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  q: UmbrellaGhoJointHolderForecastQuestion,
  receivedAtMs: number,
): UmbrellaGhoJointHolderForecastIssue | null {
  return umbrellaGhoJointHolderForecastIssue(
    umbrellaGhoJointHolderForecastFromResponse(value, status, q, receivedAtMs),
  )
}
