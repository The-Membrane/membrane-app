import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  sha256,
  stringToHex,
} from 'viem'
import type { MorphoV2ProtocolPoint } from './morphoV2HolderTimeProcess'
import {
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
} from './morphoV2ReviewedProtocolHistories'
import {
  isAppOwnedMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from './morphoV2TrustedProfiles'

const ABI = parseAbi(['function previewRedeem(uint256) view returns (uint256)'])
const MAX_UINT = (1n << 256n) - 1n
const MAX_BYTES = 64 * 1024
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const MAX_SPAN_MS = 120_000
export const MORPHO_V2_HISTORICAL_HOLDER_EA_MAX_CALLS = 8
export const MORPHO_V2_HISTORICAL_HOLDER_EA_DEADLINE_MS = 12_000
type HistoricalSource = MorphoV2ProtocolPoint['source']
export type MorphoV2HistoricalHolderEaCurrentSource = {
  chainId: 1
  blockNumber: number
  blockHash: `0x${string}`
  blockTime: string
  finalized: true
}
export type MorphoV2HistoricalHolderEaTrace = {
  source: HistoricalSource
  key: 'previewRedeem'
  method: 'eth_call'
  params: [
    { to: `0x${string}`; data: `0x${string}` },
    { blockHash: `0x${string}`; requireCanonical: true },
  ]
  result: `0x${string}`
  startedAtUtc: string
  completedAtUtc: string
}
/** Hypothetical historical redemption of today's full S; never past ownership. */
export type MorphoV2HistoricalHolderEaOriginObservation = {
  schemaVersion: 1
  kind: 'morpho_v2_historical_holder_ea_origin_v1'
  profileId: string
  routeKey: string
  destination: `0x${string}`
  asset: `0x${string}`
  assetDecimals: number
  shareDecimals: number
  currentSource: MorphoV2HistoricalHolderEaCurrentSource
  sharesRaw: string
  startedAtUtc: string
  readAtUtc: string
  deadlineMs: number
  traces: MorphoV2HistoricalHolderEaTrace[]
}
export type MorphoV2HistoricalHolderEaObservation = MorphoV2HistoricalHolderEaOriginObservation
export type MorphoV2HistoricalHolderEaEvidencePair = {
  schemaVersion: 1
  kind: 'morpho_v2_historical_holder_ea_pair_v1'
  origins: [
    { host: string; observation: MorphoV2HistoricalHolderEaOriginObservation },
    { host: string; observation: MorphoV2HistoricalHolderEaOriginObservation },
  ]
}
export type MorphoV2HistoricalHolderEaExpectation = {
  profile: MorphoV2TrustedProfile
  currentSource: MorphoV2HistoricalHolderEaCurrentSource
  sharesRaw: string
  originHosts: [string, string]
  asOfMs: number
}
export type ApprovedMorphoV2HistoricalHolderEaEvidence = Readonly<{
  status: 'conditional_native_historical_holder_ea'
  profileId: string
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  shareDecimals: number
  currentSource: Readonly<MorphoV2HistoricalHolderEaCurrentSource>
  sharesRaw: string
  points: readonly Readonly<{ source: Readonly<HistoricalSource>; assetsRaw: string }>[]
  knowledgeCutoffUtc: string
  originHosts: readonly [string, string]
  olderPastOwnerProven: false
  executionProven: false
  forecastValidated: false
}>
const approvals = new WeakMap<
  object,
  { expected: MorphoV2HistoricalHolderEaExpectation; started: number; read: number }
>()
const invalid = (): never => {
  throw new Error('morpho_historical_holder_ea_evidence_invalid')
}
const validDecimals = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 36
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid()
  const own = Reflect.ownKeys(value)
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid()
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
  }
}
function array(value: unknown, length: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    invalid()
  const own = Reflect.ownKeys(value)
  if (
    own.length !== length + 1 ||
    own.some(
      (key) =>
        key !== 'length' && !Array.from({ length }, (_, i) => String(i)).includes(String(key)),
    )
  )
    invalid()
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
  }
}
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    invalid()
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || ms < 0 || new Date(ms).toISOString() !== value) invalid()
  return ms
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) invalid()
  const result = BigInt(value)
  if (result > MAX_UINT) invalid()
  return result
}
function address(value: unknown): void {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value)) invalid()
}
function host(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(value)
  )
    invalid()
}
function source(
  value: unknown,
  current: boolean,
): asserts value is HistoricalSource | MorphoV2HistoricalHolderEaCurrentSource {
  exact(
    value,
    current
      ? ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']
      : ['chainId', 'blockNumber', 'blockHash', 'blockTime'],
  )
  if (
    value.chainId !== 1 ||
    typeof value.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.blockHash) ||
    utc(value.blockTime) % 1000 !== 0
  )
    invalid()
  if (current) {
    if (
      value.finalized !== true ||
      !Number.isSafeInteger(value.blockNumber) ||
      (value.blockNumber as number) < 0
    )
      invalid()
  } else if (
    typeof value.blockNumber !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.blockNumber) ||
    !Number.isSafeInteger(Number(value.blockNumber))
  )
    invalid()
}
function sameSource(
  a: HistoricalSource | MorphoV2HistoricalHolderEaCurrentSource,
  b: HistoricalSource | MorphoV2HistoricalHolderEaCurrentSource,
): boolean {
  return (
    a.chainId === b.chainId &&
    a.blockNumber === b.blockNumber &&
    a.blockHash === b.blockHash &&
    a.blockTime === b.blockTime
  )
}
/** Only app-selected reviewed points can select RPC anchors. Payloads never select them. */
export function selectMorphoV2HistoricalHolderEaAnchors(
  profile: MorphoV2TrustedProfile,
  currentSource: MorphoV2HistoricalHolderEaCurrentSource,
): MorphoV2ProtocolPoint[] {
  if (!isAppOwnedMorphoV2TrustedProfile(profile)) invalid()
  source(currentSource, true)
  const history = reviewedMorphoV2ProtocolHistory(profile)
  if (
    !history ||
    !approveReviewedMorphoV2ProtocolHistory(profile, history, (text) =>
      sha256(stringToHex(text)).slice(2),
    ) ||
    !validDecimals(profile.subject.assetDecimals) ||
    !validDecimals(profile.subject.shareDecimals)
  )
    invalid()
  address(profile.subject.asset)
  address(profile.subject.destination)
  // The app-owned history also retains research metadata such as role. Only
  // native header fields belong to the strict wire source; payloads stay exact.
  const selected = history.history.points
    .map((point) => ({
      ...point,
      source: {
        chainId: point.source.chainId,
        blockNumber: point.source.blockNumber,
        blockHash: point.source.blockHash,
        blockTime: point.source.blockTime,
      },
    }))
    .filter((point) => {
      source(point.source, false)
      return (
        Number(point.source.blockNumber) < currentSource.blockNumber &&
        utc(point.source.blockTime) < utc(currentSource.blockTime)
      )
    })
    .sort((a, b) => Number(a.source.blockNumber) - Number(b.source.blockNumber))
    .slice(-MORPHO_V2_HISTORICAL_HOLDER_EA_MAX_CALLS)
  if (!selected.length) invalid()
  const hashes = new Set<string>()
  let lastNumber = -1,
    lastTime = -1
  for (const point of selected) {
    const number = Number(point.source.blockNumber),
      time = utc(point.source.blockTime)
    if (hashes.has(point.source.blockHash) || number <= lastNumber || time <= lastTime) invalid()
    hashes.add(point.source.blockHash)
    lastNumber = number
    lastTime = time
  }
  return structuredClone(selected)
}
export function morphoV2HistoricalHolderEaCalldata(sharesRaw: string): `0x${string}` {
  return encodeFunctionData({ abi: ABI, functionName: 'previewRedeem', args: [amount(sharesRaw)] })
}
export function decodeMorphoV2HistoricalHolderEaUint(result: unknown): bigint {
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/.test(result)) invalid()
  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: 'previewRedeem',
    data: result as `0x${string}`,
  })
  if (encodeFunctionResult({ abi: ABI, functionName: 'previewRedeem', result: decoded }) !== result)
    invalid()
  return decoded
}
function observation(value: unknown): asserts value is MorphoV2HistoricalHolderEaOriginObservation {
  exact(value, [
    'schemaVersion',
    'kind',
    'profileId',
    'routeKey',
    'destination',
    'asset',
    'assetDecimals',
    'shareDecimals',
    'currentSource',
    'sharesRaw',
    'startedAtUtc',
    'readAtUtc',
    'deadlineMs',
    'traces',
  ])
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'morpho_v2_historical_holder_ea_origin_v1' ||
    typeof value.profileId !== 'string' ||
    !value.profileId ||
    value.profileId.length > 160 ||
    typeof value.routeKey !== 'string' ||
    !value.routeKey ||
    value.routeKey.length > 160 ||
    !validDecimals(value.assetDecimals) ||
    !validDecimals(value.shareDecimals)
  )
    invalid()
  address(value.destination)
  address(value.asset)
  source(value.currentSource, true)
  amount(value.sharesRaw)
  const start = utc(value.startedAtUtc),
    read = utc(value.readAtUtc)
  if (
    !Number.isSafeInteger(value.deadlineMs) ||
    (value.deadlineMs as number) < 1 ||
    (value.deadlineMs as number) > MORPHO_V2_HISTORICAL_HOLDER_EA_DEADLINE_MS ||
    read < start ||
    read - start > (value.deadlineMs as number)
  )
    invalid()
  if (
    !Array.isArray(value.traces) ||
    value.traces.length < 1 ||
    value.traces.length > MORPHO_V2_HISTORICAL_HOLDER_EA_MAX_CALLS
  )
    invalid()
  array(value.traces, value.traces.length)
  let previous = start
  for (const trace of value.traces) {
    exact(trace, ['source', 'key', 'method', 'params', 'result', 'startedAtUtc', 'completedAtUtc'])
    source(trace.source, false)
    if (trace.key !== 'previewRedeem' || trace.method !== 'eth_call') invalid()
    array(trace.params, 2)
    const [call, pin] = trace.params
    exact(call, ['to', 'data'])
    exact(pin, ['blockHash', 'requireCanonical'])
    if (
      call.to !== value.destination ||
      call.data !== morphoV2HistoricalHolderEaCalldata(value.sharesRaw as string) ||
      pin.blockHash !== trace.source.blockHash ||
      pin.requireCanonical !== true
    )
      invalid()
    const begin = utc(trace.startedAtUtc),
      end = utc(trace.completedAtUtc)
    if (begin < previous || end < begin || end > read) invalid()
    previous = end
    decodeMorphoV2HistoricalHolderEaUint(trace.result)
  }
}
function pair(value: unknown): asserts value is MorphoV2HistoricalHolderEaEvidencePair {
  exact(value, ['schemaVersion', 'kind', 'origins'])
  if (value.schemaVersion !== 1 || value.kind !== 'morpho_v2_historical_holder_ea_pair_v1')
    invalid()
  array(value.origins, 2)
  for (const origin of value.origins) {
    exact(origin, ['host', 'observation'])
    host(origin.host)
    observation(origin.observation)
  }
  const origins = value.origins as MorphoV2HistoricalHolderEaEvidencePair['origins']
  if (
    origins[0].host === origins[1].host ||
    Math.max(...origins.map((o) => utc(o.observation.readAtUtc))) -
      Math.min(...origins.map((o) => utc(o.observation.startedAtUtc))) >
      MAX_SPAN_MS
  )
    invalid()
}
function expectation(value: unknown): asserts value is MorphoV2HistoricalHolderEaExpectation {
  exact(value, ['profile', 'currentSource', 'sharesRaw', 'originHosts', 'asOfMs'])
  if (!isAppOwnedMorphoV2TrustedProfile(value.profile)) invalid()
  source(value.currentSource, true)
  amount(value.sharesRaw)
  array(value.originHosts, 2)
  value.originHosts.forEach(host)
  if (
    value.originHosts[0] === value.originHosts[1] ||
    !Number.isSafeInteger(value.asOfMs) ||
    (value.asOfMs as number) < 0
  )
    invalid()
}
function fresh(
  currentSource: MorphoV2HistoricalHolderEaCurrentSource,
  start: number,
  read: number,
  asOf: number,
): void {
  const time = utc(currentSource.blockTime)
  if (
    start < time - MAX_SPAN_MS ||
    asOf < time - MAX_SPAN_MS ||
    asOf - time > MAX_AGE_MS ||
    read > asOf ||
    asOf - read > MAX_AGE_MS
  )
    invalid()
}
function binding(value: MorphoV2HistoricalHolderEaExpectation): string {
  return JSON.stringify([
    value.profile.id,
    value.currentSource,
    value.sharesRaw,
    [...value.originHosts].sort(),
  ])
}
export function approveMorphoV2HistoricalHolderEaEvidence(
  raw: unknown,
  expected: MorphoV2HistoricalHolderEaExpectation,
): ApprovedMorphoV2HistoricalHolderEaEvidence {
  pair(raw)
  expectation(expected)
  const anchors = selectMorphoV2HistoricalHolderEaAnchors(expected.profile, expected.currentSource)
  const subject = expected.profile.subject
  for (const origin of raw.origins) {
    const o = origin.observation
    if (
      !expected.originHosts.includes(origin.host) ||
      o.profileId !== expected.profile.id ||
      o.routeKey !== subject.routeKey ||
      o.destination !== subject.destination ||
      o.asset !== subject.asset ||
      o.assetDecimals !== subject.assetDecimals ||
      o.shareDecimals !== subject.shareDecimals ||
      o.sharesRaw !== expected.sharesRaw ||
      !sameSource(o.currentSource, expected.currentSource) ||
      o.traces.length !== anchors.length
    )
      invalid()
    fresh(expected.currentSource, utc(o.startedAtUtc), utc(o.readAtUtc), expected.asOfMs)
    for (let i = 0; i < anchors.length; i++) {
      if (
        !sameSource(o.traces[i].source, anchors[i].source) ||
        o.traces[i].result !== raw.origins[0].observation.traces[i].result
      )
        invalid()
    }
  }
  const start = Math.min(...raw.origins.map((o) => utc(o.observation.startedAtUtc)))
  const read = Math.max(...raw.origins.map((o) => utc(o.observation.readAtUtc)))
  const approved: ApprovedMorphoV2HistoricalHolderEaEvidence = Object.freeze({
    status: 'conditional_native_historical_holder_ea',
    profileId: expected.profile.id,
    ...subject,
    currentSource: Object.freeze({ ...expected.currentSource }),
    sharesRaw: expected.sharesRaw,
    points: Object.freeze(
      anchors.map((point, i) =>
        Object.freeze({
          source: Object.freeze({ ...point.source }),
          assetsRaw: decodeMorphoV2HistoricalHolderEaUint(
            raw.origins[0].observation.traces[i].result,
          ).toString(),
        }),
      ),
    ),
    knowledgeCutoffUtc: new Date(read).toISOString(),
    originHosts: Object.freeze([...expected.originHosts]) as readonly [string, string],
    olderPastOwnerProven: false,
    executionProven: false,
    forecastValidated: false,
  })
  approvals.set(approved, {
    expected: {
      ...expected,
      profile: expected.profile,
      currentSource: { ...expected.currentSource },
      originHosts: [...expected.originHosts],
    },
    started: start,
    read,
  })
  return approved
}
export function selectedMorphoV2HistoricalHolderEaEvidence(
  value: unknown,
  expected: MorphoV2HistoricalHolderEaExpectation,
): ApprovedMorphoV2HistoricalHolderEaEvidence | null {
  if (!value || typeof value !== 'object') return null
  const bound = approvals.get(value)
  if (!bound) return null
  try {
    expectation(expected)
    if (
      expected.profile !== bound.expected.profile ||
      expected.asOfMs < bound.expected.asOfMs ||
      binding(expected) !== binding(bound.expected)
    )
      return null
    fresh(expected.currentSource, bound.started, bound.read, expected.asOfMs)
    return value as ApprovedMorphoV2HistoricalHolderEaEvidence
  } catch {
    return null
  }
}
// Scan decoded keys before JSON.parse discards duplicates. Bounds include arrays
// of eight traces and the two origins, but reject arbitrary recursion/payloads.
function parseEnvelope(text: string): unknown {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) invalid()
  let at = 0,
    nodes = 0
  const white = () => {
    while (at < text.length && /\s/.test(text[at])) at++
  }
  const string = (): string => {
    const begin = at++
    while (at < text.length) {
      if (text[at] === '\\') {
        at += 2
        continue
      }
      if (text[at++] === '"') return JSON.parse(text.slice(begin, at)) as string
    }
    return invalid()
  }
  const value = (depth: number): void => {
    if (depth > 12 || ++nodes > 2048) invalid()
    white()
    if (text[at] === '{') {
      at++
      white()
      const seen = new Set<string>()
      if (text[at] === '}') {
        at++
        return
      }
      while (true) {
        white()
        if (text[at] !== '"') invalid()
        const key = string()
        if (seen.has(key)) invalid()
        seen.add(key)
        white()
        if (text[at++] !== ':') invalid()
        value(depth + 1)
        white()
        const end = text[at++]
        if (end === '}') return
        if (end !== ',') invalid()
      }
    }
    if (text[at] === '[') {
      at++
      white()
      let count = 0
      if (text[at] === ']') {
        at++
        return
      }
      while (true) {
        if (++count > 8) invalid()
        value(depth + 1)
        white()
        const end = text[at++]
        if (end === ']') return
        if (end !== ',') invalid()
      }
    }
    if (text[at] === '"') {
      string()
      return
    }
    const begin = at
    while (at < text.length && !/[\s,\]}]/.test(text[at])) at++
    if (at === begin) invalid()
    JSON.parse(text.slice(begin, at))
  }
  value(0)
  white()
  if (at !== text.length) invalid()
  return JSON.parse(text)
}
export function decodeMorphoV2HistoricalHolderEaEvidencePair(
  text: string,
): MorphoV2HistoricalHolderEaEvidencePair | null {
  try {
    if (typeof text !== 'string') invalid()
    const decoded = parseEnvelope(text)
    pair(decoded)
    return decoded
  } catch {
    return null
  }
}
export function encodeMorphoV2HistoricalHolderEaEvidencePair(
  raw: unknown,
  expected: MorphoV2HistoricalHolderEaExpectation,
): string | null {
  try {
    approveMorphoV2HistoricalHolderEaEvidence(raw, expected)
    const text = JSON.stringify(raw)
    return decodeMorphoV2HistoricalHolderEaEvidencePair(text) ? text : null
  } catch {
    return null
  }
}
