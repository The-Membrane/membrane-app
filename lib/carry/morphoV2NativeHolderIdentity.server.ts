import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi, sha256, stringToHex } from 'viem'
import type { Address } from 'viem'

import type { HolderExitAssessment } from './holderExitAssessment'
import { agreeHolderExitCapacityQuotes, type HolderExitCapacityAgreement } from './holderExitCapacity'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'
import type { MorphoHolderPositionObservation, MorphoHolderPositionSource, MorphoHolderPositionTrace } from './morphoV2HolderPositionEvidence'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
const WORD = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const MAX_SPAN_MS = 120_000
// Shared readers are also imported by the workbench; hash without a browser-incompatible Node import.
const digest = (value: unknown) => sha256(stringToHex(JSON.stringify(value))).slice(2)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const invalid = (): never => { throw new Error('morpho_native_holder_identity_invalid') }
const sameSource = (a: MorphoHolderPositionSource, b: MorphoHolderPositionSource) =>
  a.chainId === b.chainId && a.blockNumber === b.blockNumber &&
  a.blockHash === b.blockHash && a.blockTime === b.blockTime && a.finalized === b.finalized

export type MorphoV2NativeHolderIdentity = Readonly<{
  routeKey: string
  destination: Address
  asset: Address
  assetDecimals: number
  shareDecimals: number
}>
export type MorphoV2NativeHolderRead = Readonly<{
  asset: Address
  assetDecimals: number
  shareDecimals: number
  sharesRaw: string
  fullEaRaw: string
}>
type NativeClient = { request: (args: { method: 'eth_call'; params: MorphoHolderPositionTrace['params'] }) => Promise<unknown> }
type Trace = MorphoHolderPositionTrace | {
  key: 'asset' | 'assetDecimals' | 'shareDecimals'
  method: 'eth_call'
  params: MorphoHolderPositionTrace['params']
  result: `0x${string}`
  startedAtUtc: string
  completedAtUtc: string
}
type NativeFacts = {
  client: object
  identity: MorphoV2NativeHolderIdentity
  owner: Address
  source: MorphoHolderPositionSource
  identityTraces: Trace[]
  holderTraces: MorphoHolderPositionObservation['traces']
  firstStartedAt: number
  lastCompletedAt: number
  sharesRaw: string
  fullEaRaw: string
}
const reads = new WeakMap<object, { facts: NativeFacts; digest: string }>()
const observations = new WeakMap<object, { read: MorphoV2NativeHolderRead; digest: string; assessment?: object }>()
const assessments = new WeakMap<object, { read: MorphoV2NativeHolderRead; observation: object; digest: string }>()
const factDigest = (facts: NativeFacts) => digest({ ...facts, client: undefined })

/** Reads units and full S at the required native source, never from caller configuration. */
export async function readMorphoV2NativeHolderAtSource(
  client: NativeClient,
  input: { routeKey: string; destination: Address; owner: Address; source: MorphoHolderPositionSource },
  now: () => number,
): Promise<MorphoV2NativeHolderRead> {
  if (typeof window !== 'undefined') invalid()
  const routeKey = input.routeKey, destination = input.destination.toLowerCase() as Address,
    owner = input.owner.toLowerCase() as Address,
    source = clone(input.source),
    subject = resolveHolderExitSubject(routeKey, destination)
  if (subject.kind !== 'morpho' || !ADDRESS.test(owner) || source.chainId !== 1 ||
      source.finalized !== true || !Number.isSafeInteger(source.blockNumber) ||
      source.blockNumber <= 0 || !WORD.test(source.blockHash) ||
      new Date(source.blockTime).toISOString() !== source.blockTime) invalid()
  const asset = subject.payoutAsset.toLowerCase() as Address
  const read = async (key: Trace['key'], to: Address, argument?: Address | bigint): Promise<Trace> => {
    const functionName = key === 'assetDecimals' || key === 'shareDecimals' ? 'decimals' : key
    const data = functionName === 'balanceOf'
      ? encodeFunctionData({ abi: ABI, functionName, args: [argument as Address] })
      : functionName === 'previewRedeem'
        ? encodeFunctionData({ abi: ABI, functionName, args: [argument as bigint] })
        : encodeFunctionData({ abi: ABI, functionName })
    const params: MorphoHolderPositionTrace['params'] = [
      { to, data }, { blockHash: source.blockHash, requireCanonical: true },
    ]
    const begin = now(), result = await client.request({ method: 'eth_call', params }), end = now()
    if (params.length !== 2 || Object.keys(params[0]).sort().join(',') !== 'data,to' ||
        Object.keys(params[1]).sort().join(',') !== 'blockHash,requireCanonical' || params[0].to !== to || params[0].data !== data ||
        params[1].blockHash !== source.blockHash || params[1].requireCanonical !== true) invalid()
    if (typeof result !== 'string' || !WORD.test(result) || !Number.isSafeInteger(begin) ||
        !Number.isSafeInteger(end) || begin < 0 || end < begin) invalid()
    return { key, method: 'eth_call', params, result: result as `0x${string}`,
      startedAtUtc: new Date(begin).toISOString(), completedAtUtc: new Date(end).toISOString() }
  }
  const decoded = (trace: Trace) => {
    const functionName = trace.key === 'assetDecimals' || trace.key === 'shareDecimals' ? 'decimals' : trace.key
    const value = decodeFunctionResult({ abi: ABI, functionName, data: trace.result })
    if (encodeFunctionResult({ abi: ABI, functionName, result: value }) !== trace.result) invalid()
    return value
  }
  const [assetRead, shareRead, unitRead, balanceRead] = await Promise.all([
    read('asset', destination), read('shareDecimals', destination),
    read('assetDecimals', asset), read('balanceOf', destination, owner),
  ])
  const nativeAsset = decoded(assetRead), shareDecimals = Number(decoded(shareRead)),
    assetDecimals = Number(decoded(unitRead)), shares = decoded(balanceRead)
  if (typeof nativeAsset !== 'string' || nativeAsset.toLowerCase() !== asset ||
      !Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36 ||
      !Number.isInteger(shareDecimals) || shareDecimals < 0 || shareDecimals > 36 ||
      typeof shares !== 'bigint' || shares < 0n) invalid()
  const previewRead = await read('previewRedeem', destination, shares as bigint), ea = decoded(previewRead)
  if (typeof ea !== 'bigint' || ea < 0n) invalid()
  const result: MorphoV2NativeHolderRead = Object.freeze({ asset, assetDecimals, shareDecimals,
    sharesRaw: (shares as bigint).toString(), fullEaRaw: (ea as bigint).toString() })
  const all = [assetRead, shareRead, unitRead, balanceRead, previewRead]
  const facts: NativeFacts = Object.freeze({ client, ...freeze({ identity: { routeKey, destination,
    asset, assetDecimals, shareDecimals }, owner, source,
    identityTraces: clone([assetRead, shareRead, unitRead]),
    holderTraces: clone([balanceRead, previewRead]) as MorphoHolderPositionObservation['traces'],
    firstStartedAt: Math.min(...all.map((trace) => Date.parse(trace.startedAtUtc))),
    lastCompletedAt: Math.max(...all.map((trace) => Date.parse(trace.completedAtUtc))),
    sharesRaw: result.sharesRaw, fullEaRaw: result.fullEaRaw }) })
  reads.set(result, { facts, digest: factDigest(facts) })
  return result
}

function nativeFacts(value: unknown): NativeFacts | null {
  if (!value || typeof value !== 'object') return null
  const stored = reads.get(value)
  return stored && factDigest(stored.facts) === stored.digest ? stored.facts : null
}

/** Only an original native read can create the existing transport observation shape. */
export function completeMorphoV2NativeHolderObservation(
  read: MorphoV2NativeHolderRead, startedAt: number, completedAt: number,
): MorphoHolderPositionObservation | null {
  if (typeof window !== 'undefined') return null
  const facts = nativeFacts(read)
  if (!facts || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt) ||
      startedAt < 0 || startedAt > facts.firstStartedAt || completedAt < facts.lastCompletedAt ||
      completedAt - startedAt > MAX_SPAN_MS || completedAt - Date.parse(facts.source.blockTime) > MAX_AGE_MS)
    return null
  const observation: MorphoHolderPositionObservation = { schemaVersion: 1,
    kind: 'morpho_v2_holder_position_origin_v1', ...facts.identity, source: clone(facts.source),
    startedAtUtc: new Date(startedAt).toISOString(), readAtUtc: new Date(completedAt).toISOString(),
    deadlineMs: MAX_SPAN_MS, traces: clone(facts.holderTraces) }
  observations.set(observation, { read, digest: digest(observation) })
  return observation
}

const assessmentBinding = (a: HolderExitAssessment) => ({ routeKey: a.routeKey,
  destination: a.destinationAddress.toLowerCase(), owner: a.owner.toLowerCase(),
  requestedRaw: a.request.assetsRaw, asset: a.request.assetAddress.toLowerCase(),
  source: { chainId: a.source.chainId, blockNumber: a.source.blockNumber,
    blockHash: a.source.blockHash.toLowerCase(), blockTime: a.source.blockTime, finalized: true },
  capacityQuote: a.capacityQuote })
function boundToFacts(a: HolderExitAssessment, facts: NativeFacts): boolean {
  const q = a.capacityQuote, p = q?.sourceHolderPosition, bound = assessmentBinding(a)
  return !!q && !!p && bound.routeKey === facts.identity.routeKey &&
    bound.destination === facts.identity.destination && bound.owner === facts.owner &&
    bound.asset === facts.identity.asset && sameSource(bound.source as MorphoHolderPositionSource, facts.source) &&
    q.routeKey === bound.routeKey && q.destination === bound.destination && q.owner === bound.owner &&
    q.requestedRaw === bound.requestedRaw && q.asset === facts.identity.asset &&
    q.assetDecimals === facts.identity.assetDecimals &&
    sameSource(q.source as MorphoHolderPositionSource, facts.source) &&
    p.method === 'balance_of_owner_at_source' && p.sharesRaw === facts.sharesRaw &&
    p.shareDecimals === facts.identity.shareDecimals && q.entitlementRaw === facts.fullEaRaw &&
    q.entitlementMethod === 'preview_redeem_full_position'
}
/** Private association with the exact required assessment and original raw native reads. */
export function bindMorphoV2NativeHolderAssessment<T extends HolderExitAssessment>(a: T): T {
  // An occupied reference keeps its original binding, including after mutation.
  if (typeof window !== 'undefined' || assessments.has(a)) return a
  try {
    const o = a.morphoHolderPositionObservation, stored = o && observations.get(o),
      facts = stored && nativeFacts(stored.read)
    if (o && stored && facts && (!stored.assessment || stored.assessment === a) &&
        digest(o) === stored.digest && boundToFacts(a, facts)) {
      stored.assessment = a
      assessments.set(a, { read: stored.read, observation: o, digest: digest(assessmentBinding(a)) })
    }
  } catch { /* Missing or mismatched native facts remain unavailable. */ }
  return a
}
function selectedRead(a: HolderExitAssessment): MorphoV2NativeHolderRead | null {
  if (typeof window !== 'undefined') return null
  try {
    const stored = assessments.get(a), o = a.morphoHolderPositionObservation,
      observation = o && observations.get(o), facts = stored && nativeFacts(stored.read)
    return stored && o === stored.observation && observation && facts &&
      observation.read === stored.read && digest(o) === observation.digest &&
      digest(assessmentBinding(a)) === stored.digest && boundToFacts(a, facts) ? stored.read : null
  } catch { return null }
}
/** Optional observation fields may be added only while the required native binding stays exact. */
export function carryMorphoV2NativeHolderAssessment<T extends HolderExitAssessment>(a: HolderExitAssessment, next: T): T {
  // Transfer only issues a fresh reference; sibling helpers cannot replace authority.
  if (assessments.has(next)) return next
  const read = selectedRead(a)
  if (read && digest(assessmentBinding(next)) === digest(assessmentBinding(a)) &&
      next.morphoHolderPositionObservation === a.morphoHolderPositionObservation)
    assessments.set(next, { read, observation: next.morphoHolderPositionObservation!,
      digest: digest(assessmentBinding(next)) })
  return next
}

/** Metadata agreement alone is not a native read receipt or a holder-position approval. */
export function agreeMorphoV2NativeCapacity(
  first: { host: string; assessment: HolderExitAssessment },
  second: { host: string; assessment: HolderExitAssessment }, asOfMs: number,
): HolderExitCapacityAgreement | null {
  try {
    const capacity = agreeHolderExitCapacityQuotes({ host: first.host, quote: first.assessment.capacityQuote },
      { host: second.host, quote: second.assessment.capacityQuote }, asOfMs)
    if (!capacity || capacity.quote.entitlementRaw === null ||
        capacity.quote.entitlementMethod !== 'preview_redeem_full_position') return null
    const q = capacity.quote, subject = resolveHolderExitSubject(q.routeKey, q.destination as Address)
    if (subject.kind !== 'morpho' || subject.payoutAsset.toLowerCase() !== q.asset) return null
    const bound = (a: HolderExitAssessment) => a.routeKey === q.routeKey &&
      a.destinationAddress.toLowerCase() === q.destination && a.owner.toLowerCase() === q.owner &&
      a.request.assetsRaw === q.requestedRaw && a.request.assetAddress.toLowerCase() === q.asset &&
      a.source.chainId === 1 && a.source.blockNumber === q.source.blockNumber &&
      a.source.blockHash.toLowerCase() === q.source.blockHash && a.source.blockTime === q.source.blockTime
    return bound(first.assessment) && bound(second.assessment) ? capacity : null
  } catch { return null }
}

/** Units come from two original required reads, bound to factory identity and actual source. */
export function resolveMorphoV2NativeHolderIdentity(
  first: HolderExitAssessment, second: HolderExitAssessment, capacity: HolderExitCapacityAgreement,
): MorphoV2NativeHolderIdentity | null {
  const a = selectedRead(first), b = selectedRead(second),
    af = nativeFacts(a), bf = nativeFacts(b)
  if (!a || !b || a === b || !af || !bf || af.client === bf.client ||
      digest(af.identity) !== digest(bf.identity) || !sameSource(af.source, bf.source) ||
      !boundToFacts({ ...first, capacityQuote: capacity.quote }, af) ||
      !boundToFacts({ ...second, capacityQuote: capacity.quote }, bf)) return null
  return af.identity
}
