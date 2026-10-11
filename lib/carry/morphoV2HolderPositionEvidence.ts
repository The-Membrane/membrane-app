import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const MAX_UINT = (1n << 256n) - 1n
const MAX_BYTES = 32 * 1024
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const MAX_SPAN_MS = 120_000

export type MorphoHolderPositionSource = {
  chainId: 1
  blockNumber: number
  blockHash: `0x${string}`
  blockTime: string
  finalized: true
}
export type MorphoHolderPositionTrace = {
  key: 'balanceOf' | 'previewRedeem'
  method: 'eth_call'
  params: [
    { to: `0x${string}`; data: `0x${string}` },
    { blockHash: `0x${string}`; requireCanonical: true },
  ]
  result: `0x${string}`
  startedAtUtc: string
  completedAtUtc: string
}
/** Raw observations are retained claims, never an authenticated owner proof. */
export type MorphoHolderPositionObservation = {
  schemaVersion: 1
  kind: 'morpho_v2_holder_position_origin_v1'
  routeKey: string
  destination: `0x${string}`
  asset: `0x${string}`
  assetDecimals: number
  shareDecimals: number
  source: MorphoHolderPositionSource
  startedAtUtc: string
  readAtUtc: string
  deadlineMs: number
  traces: [MorphoHolderPositionTrace, MorphoHolderPositionTrace]
}
export type MorphoV2HolderPositionEvidence = {
  schemaVersion: 1
  kind: 'morpho_v2_holder_position_pair_v1'
  origins: [
    { host: string; observation: MorphoHolderPositionObservation },
    { host: string; observation: MorphoHolderPositionObservation },
  ]
}
/** Supplied by the independent quote/protocol-source boundary; Q is intentionally absent. */
export type MorphoV2HolderPositionExpectation = {
  routeKey: string
  destination: `0x${string}`
  owner: `0x${string}`
  asset: `0x${string}`
  assetDecimals: number
  shareDecimals: number
  source: MorphoHolderPositionSource
  sharesRaw: string
  fullEaRaw: string
  originHosts: [string, string]
  asOfMs: number
}
export type ApprovedMorphoV2HolderPositionEvidence = Readonly<{
  status: 'conditional_native_holder_position'
  routeKey: string
  destination: `0x${string}`
  source: Readonly<MorphoHolderPositionSource>
  sharesRaw: string
  fullEaRaw: string
  asset: `0x${string}`
  assetDecimals: number
  shareDecimals: number
  originHosts: readonly [string, string]
  authenticated: false
  executionProven: false
  forecastValidated: false
}>
const approvals = new WeakMap<object, MorphoV2HolderPositionExpectation>()
const invalid = (): never => {
  throw new Error('morpho_holder_position_evidence_invalid')
}

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
  for (let i = 0; i < length; i++)
    if (!('value' in (Object.getOwnPropertyDescriptor(value, String(i)) ?? {}))) invalid()
}
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    invalid()
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || ms < 0 || new Date(ms).toISOString() !== value) invalid()
  return ms
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !UINT.test(value)) invalid()
  const n = BigInt(value)
  if (n > MAX_UINT) invalid()
  return n
}
function address(value: unknown): void {
  if (typeof value !== 'string' || !ADDRESS.test(value)) invalid()
}
function units(value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 36) invalid()
}
function host(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(value)
  )
    invalid()
}
function source(value: unknown): asserts value is MorphoHolderPositionSource {
  exact(value, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  if (
    value.chainId !== 1 ||
    value.finalized !== true ||
    !Number.isSafeInteger(value.blockNumber) ||
    (value.blockNumber as number) < 0 ||
    typeof value.blockHash !== 'string' ||
    !HEX32.test(value.blockHash)
  )
    invalid()
  if (utc(value.blockTime) % 1000 !== 0) invalid()
}
export function decodeMorphoHolderPositionUint(
  key: 'balanceOf' | 'previewRedeem',
  result: unknown,
): bigint {
  if (typeof result !== 'string' || !HEX32.test(result)) invalid()
  const decoded = decodeFunctionResult({
    abi: ABI,
    functionName: key,
    data: result as `0x${string}`,
  })
  if (encodeFunctionResult({ abi: ABI, functionName: key, result: decoded }) !== result) invalid()
  return decoded
}
function observation(value: unknown): asserts value is MorphoHolderPositionObservation {
  exact(value, [
    'schemaVersion',
    'kind',
    'routeKey',
    'destination',
    'asset',
    'assetDecimals',
    'shareDecimals',
    'source',
    'startedAtUtc',
    'readAtUtc',
    'deadlineMs',
    'traces',
  ])
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'morpho_v2_holder_position_origin_v1' ||
    typeof value.routeKey !== 'string' ||
    !value.routeKey ||
    value.routeKey.length > 160
  )
    invalid()
  address(value.destination)
  address(value.asset)
  units(value.assetDecimals)
  units(value.shareDecimals)
  source(value.source)
  const started = utc(value.startedAtUtc),
    read = utc(value.readAtUtc)
  if (
    !Number.isSafeInteger(value.deadlineMs) ||
    (value.deadlineMs as number) <= 0 ||
    (value.deadlineMs as number) > MAX_SPAN_MS ||
    read < started ||
    read - started > (value.deadlineMs as number)
  )
    invalid()
  array(value.traces, 2)
  let previous = started
  for (let i = 0; i < 2; i++) {
    const trace = value.traces[i]
    exact(trace, ['key', 'method', 'params', 'result', 'startedAtUtc', 'completedAtUtc'])
    if (trace.key !== (i === 0 ? 'balanceOf' : 'previewRedeem') || trace.method !== 'eth_call')
      invalid()
    array(trace.params, 2)
    const [call, pin] = trace.params
    exact(call, ['to', 'data'])
    exact(pin, ['blockHash', 'requireCanonical'])
    if (
      call.to !== value.destination ||
      typeof call.data !== 'string' ||
      !/^0x[0-9a-f]{72}$/.test(call.data) ||
      pin.blockHash !== value.source.blockHash ||
      pin.requireCanonical !== true
    )
      invalid()
    const begin = utc(trace.startedAtUtc),
      end = utc(trace.completedAtUtc)
    if (begin < previous || end < begin || end > read) invalid()
    previous = end
    decodeMorphoHolderPositionUint(trace.key, trace.result)
  }
}
function pair(value: unknown): asserts value is MorphoV2HolderPositionEvidence {
  exact(value, ['schemaVersion', 'kind', 'origins'])
  if (value.schemaVersion !== 1 || value.kind !== 'morpho_v2_holder_position_pair_v1') invalid()
  array(value.origins, 2)
  for (const origin of value.origins) {
    exact(origin, ['host', 'observation'])
    host(origin.host)
    observation(origin.observation)
  }
  const origins = value.origins as MorphoV2HolderPositionEvidence['origins']
  if (origins[0].host === origins[1].host) invalid()
  const started = Math.min(...origins.map(({ observation: o }) => utc(o.startedAtUtc)))
  const read = Math.max(...origins.map(({ observation: o }) => utc(o.readAtUtc)))
  if (read - started > MAX_SPAN_MS) invalid()
}
function expectation(value: unknown): asserts value is MorphoV2HolderPositionExpectation {
  exact(value, [
    'routeKey',
    'destination',
    'owner',
    'asset',
    'assetDecimals',
    'shareDecimals',
    'source',
    'sharesRaw',
    'fullEaRaw',
    'originHosts',
    'asOfMs',
  ])
  if (typeof value.routeKey !== 'string' || !value.routeKey || value.routeKey.length > 160)
    invalid()
  address(value.destination)
  address(value.owner)
  address(value.asset)
  units(value.assetDecimals)
  units(value.shareDecimals)
  source(value.source)
  amount(value.sharesRaw)
  amount(value.fullEaRaw)
  array(value.originHosts, 2)
  value.originHosts.forEach(host)
  if (
    value.originHosts[0] === value.originHosts[1] ||
    !Number.isSafeInteger(value.asOfMs) ||
    (value.asOfMs as number) < 0
  )
    invalid()
}
function fresh(sourceTime: number, started: number, read: number, asOf: number): void {
  if (
    started - sourceTime < -MAX_SPAN_MS ||
    asOf - sourceTime < -MAX_SPAN_MS ||
    asOf - sourceTime > MAX_AGE_MS ||
    read > asOf ||
    asOf - read > MAX_AGE_MS
  )
    invalid()
}
function sameSource(a: MorphoHolderPositionSource, b: MorphoHolderPositionSource): boolean {
  return (
    a.chainId === b.chainId &&
    a.blockNumber === b.blockNumber &&
    a.blockHash === b.blockHash &&
    a.blockTime === b.blockTime &&
    a.finalized === b.finalized
  )
}
function binding(value: MorphoV2HolderPositionExpectation): string {
  return JSON.stringify([
    value.routeKey,
    value.destination,
    value.owner,
    value.asset,
    value.assetDecimals,
    value.shareDecimals,
    value.source.chainId,
    value.source.blockNumber,
    value.source.blockHash,
    value.source.blockTime,
    value.source.finalized,
    value.sharesRaw,
    value.fullEaRaw,
    value.originHosts,
  ])
}

export function approveMorphoV2HolderPositionEvidence(
  raw: unknown,
  expected: MorphoV2HolderPositionExpectation,
): ApprovedMorphoV2HolderPositionEvidence {
  pair(raw)
  expectation(expected)
  for (const origin of raw.origins) {
    const o = origin.observation
    if (
      !expected.originHosts.includes(origin.host) ||
      o.routeKey !== expected.routeKey ||
      o.destination !== expected.destination ||
      o.asset !== expected.asset ||
      o.assetDecimals !== expected.assetDecimals ||
      o.shareDecimals !== expected.shareDecimals ||
      !sameSource(o.source, expected.source)
    )
      invalid()
    fresh(utc(o.source.blockTime), utc(o.startedAtUtc), utc(o.readAtUtc), expected.asOfMs)
    const shares = decodeMorphoHolderPositionUint('balanceOf', o.traces[0].result)
    const ea = decodeMorphoHolderPositionUint('previewRedeem', o.traces[1].result)
    if (shares !== amount(expected.sharesRaw) || ea !== amount(expected.fullEaRaw)) invalid()
    const balanceData = encodeFunctionData({
      abi: ABI,
      functionName: 'balanceOf',
      args: [expected.owner],
    })
    const previewData = encodeFunctionData({
      abi: ABI,
      functionName: 'previewRedeem',
      args: [shares],
    })
    if (o.traces[0].params[0].data !== balanceData || o.traces[1].params[0].data !== previewData)
      invalid()
  }
  const snapshot = JSON.parse(JSON.stringify(expected)) as MorphoV2HolderPositionExpectation
  const approved: ApprovedMorphoV2HolderPositionEvidence = Object.freeze({
    status: 'conditional_native_holder_position',
    routeKey: snapshot.routeKey,
    destination: snapshot.destination,
    source: Object.freeze({ ...snapshot.source }),
    sharesRaw: snapshot.sharesRaw,
    fullEaRaw: snapshot.fullEaRaw,
    asset: snapshot.asset,
    assetDecimals: snapshot.assetDecimals,
    shareDecimals: snapshot.shareDecimals,
    originHosts: Object.freeze([...snapshot.originHosts]) as readonly [string, string],
    authenticated: false,
    executionProven: false,
    forecastValidated: false,
  })
  approvals.set(approved, snapshot)
  return approved
}
/** Selection rechecks the trusted binding and clock; JSON copies have no approval. */
export function selectedMorphoV2HolderPositionEvidence(
  value: unknown,
  expected: MorphoV2HolderPositionExpectation,
): ApprovedMorphoV2HolderPositionEvidence | null {
  if (!value || typeof value !== 'object') return null
  const bound = approvals.get(value)
  if (!bound) return null
  try {
    expectation(expected)
    const before = bound.asOfMs,
      after = expected.asOfMs
    if (after < before || binding(bound) !== binding(expected)) return null
    fresh(utc(bound.source.blockTime), before, before, after)
    return value as ApprovedMorphoV2HolderPositionEvidence
  } catch {
    return null
  }
}

// A bounded scanner detects duplicate decoded keys before JSON.parse discards them.
function parseEnvelope(text: string): unknown {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) invalid()
  let at = 0,
    nodes = 0
  const white = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++
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
    if (depth > 12 || ++nodes > 512) invalid()
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
        if (++count > 2) invalid()
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
export function decodeMorphoV2HolderPositionEvidence(text: string): MorphoV2HolderPositionEvidence {
  if (typeof text !== 'string') invalid()
  const value = parseEnvelope(text)
  pair(value)
  return value
}
export function encodeMorphoV2HolderPositionEvidence(
  value: MorphoV2HolderPositionEvidence,
): string {
  pair(value)
  const text = JSON.stringify(value)
  decodeMorphoV2HolderPositionEvidence(text)
  return text
}
