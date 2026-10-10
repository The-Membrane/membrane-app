import {
  replayMorphoV2CurrentProtocolCapacityEvidence,
  type MorphoV2ProtocolOriginObservation,
  type MorphoV2ProtocolReplayExpected,
} from './morphoV2ProtocolCapacityReplay'
import type { MorphoV2Sha256Text } from './morphoV2ProtocolCapacityHistoryPins'

const CODE_KEYS = ['code_vault', 'code_asset', 'code_adapter', 'code_blue', 'code_irm'] as const
type CodeKey = (typeof CODE_KEYS)[number]
type Origin = { host: string; observation: MorphoV2ProtocolOriginObservation }
export type MorphoV2ProtocolEvidencePair = { origins: [Origin, Origin] }
export type MorphoV2ProtocolEvidenceCompactPair = {
  schemaVersion: 1
  kind: 'morpho_v2_current_protocol_origin_pair_v1'
  codeDictionary: Record<CodeKey, string>
  origins: [Origin, Origin]
}

export const MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS = Object.freeze({
  compactPairBytes: 256 * 1024,
  rawOriginBytes: 256 * 1024,
  traceCount: 31,
})

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> =>
  record(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key))
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Only plain JSON data is transportable. Compact input cannot hide shared objects or accessors. */
function jsonTree(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  if (Array.isArray(value) && ownKeys.length !== value.length + 1) return false
  seen.add(value)
  const names = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, i) => String(i))
    : ownKeys
  const valid = names.every((key) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(
      descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.enumerable &&
      jsonTree(descriptor.value, seen),
    )
  })
  return valid
}

function hasReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReference)
  if (!record(value)) return false
  return Object.hasOwn(value, 'codeRef') || Object.values(value).some(hasReference)
}

function pairShape(value: unknown, compact: boolean): value is MorphoV2ProtocolEvidencePair {
  if (!record(value) || !Array.isArray(value.origins) || value.origins.length !== 2) return false
  const hosts = new Set<string>()
  return value.origins.every((origin) => {
    if (
      !keys(origin, ['host', 'observation']) ||
      typeof origin.host !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(origin.host) ||
      hosts.has(origin.host) ||
      !keys(origin.observation, ['source', 'startedAtUtc', 'readAtUtc', 'deadlineMs', 'traces'])
    )
      return false
    hosts.add(origin.host)
    const observation = origin.observation
    if (
      !keys(observation.source, [
        'chainId',
        'blockNumber',
        'blockHash',
        'blockTime',
        'finalized',
      ]) ||
      observation.source.chainId !== 1 ||
      typeof observation.source.blockNumber !== 'number' ||
      !Number.isSafeInteger(observation.source.blockNumber) ||
      observation.source.blockNumber <= 0 ||
      typeof observation.source.blockHash !== 'string' ||
      typeof observation.source.blockTime !== 'string' ||
      observation.source.finalized !== true ||
      typeof observation.startedAtUtc !== 'string' ||
      typeof observation.readAtUtc !== 'string' ||
      typeof observation.deadlineMs !== 'number' ||
      !Number.isSafeInteger(observation.deadlineMs) ||
      !Array.isArray(observation.traces) ||
      observation.traces.length !== MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.traceCount
    )
      return false
    const traceKeys = new Set<string>()
    const codeKeys = new Set<CodeKey>()
    return (
      observation.traces.every((trace) => {
        if (
          !keys(trace, ['key', 'method', 'params', 'result', 'startedAtUtc', 'completedAtUtc']) ||
          typeof trace.key !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(trace.key) ||
          traceKeys.has(trace.key) ||
          typeof trace.method !== 'string' ||
          !Array.isArray(trace.params) ||
          hasReference(trace.params) ||
          typeof trace.startedAtUtc !== 'string' ||
          typeof trace.completedAtUtc !== 'string'
        )
          return false
        traceKeys.add(trace.key)
        if (!CODE_KEYS.includes(trace.key as CodeKey)) return !hasReference(trace.result)
        const key = trace.key as CodeKey
        codeKeys.add(key)
        return (
          trace.method === 'eth_getCode' &&
          (compact
            ? keys(trace.result, ['codeRef']) && trace.result.codeRef === key
            : typeof trace.result === 'string' && /^0x(?:[a-fA-F0-9]{2})*$/.test(trace.result))
        )
      }) && codeKeys.size === CODE_KEYS.length
    )
  })
}

/** Structural decoding restores every original JSON field; it never approves evidence. */
export function decodeMorphoV2ProtocolEvidencePair(
  value: unknown,
): MorphoV2ProtocolEvidencePair | null {
  try {
    if (
      !jsonTree(value) ||
      !keys(value, ['schemaVersion', 'kind', 'codeDictionary', 'origins']) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'morpho_v2_current_protocol_origin_pair_v1' ||
      !keys(value.codeDictionary, CODE_KEYS) ||
      !pairShape(value, true)
    )
      return null
    const dictionary = value.codeDictionary as Record<CodeKey, string>
    if (
      !CODE_KEYS.every(
        (key) =>
          typeof dictionary[key] === 'string' && /^0x(?:[a-fA-F0-9]{2})*$/.test(dictionary[key]),
      ) ||
      byteLength(value) > MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.compactPairBytes
    )
      return null
    const result = { origins: structuredClone(value.origins) } as MorphoV2ProtocolEvidencePair
    for (const origin of result.origins) {
      for (const trace of origin.observation.traces)
        if (CODE_KEYS.includes(trace.key as CodeKey))
          trace.result = dictionary[trace.key as CodeKey]
      if (byteLength(origin.observation) > MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.rawOriginBytes)
        return null
    }
    return pairShape(result, false) ? result : null
  } catch {
    return null
  }
}

/** Replay against independent source/clock/hosts and optional private profile authority.
 * Decoding remains structural; payload fields never select a replay profile. */
export function encodeMorphoV2ProtocolEvidencePair(
  value: unknown,
  expected: MorphoV2ProtocolReplayExpected,
  sha256Text: MorphoV2Sha256Text,
): MorphoV2ProtocolEvidenceCompactPair | null {
  try {
    if (
      !jsonTree(value) ||
      !keys(value, ['origins']) ||
      !pairShape(value, false) ||
      value.origins.some(
        (origin) =>
          byteLength(origin.observation) > MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.rawOriginBytes,
      )
    )
      return null
    const snapshot = structuredClone(value)
    if (!replayMorphoV2CurrentProtocolCapacityEvidence(snapshot, expected, sha256Text)) return null
    const original = JSON.stringify(snapshot)
    const origins = JSON.parse(original).origins as MorphoV2ProtocolEvidencePair['origins']
    const codeDictionary = {} as Record<CodeKey, string>
    for (const key of CODE_KEYS) {
      const first = origins[0].observation.traces.find((trace) => trace.key === key)!
      const second = origins[1].observation.traces.find((trace) => trace.key === key)!
      if (first.result !== second.result) return null
      codeDictionary[key] = first.result as string
      first.result = { codeRef: key }
      second.result = { codeRef: key }
    }
    const compact: MorphoV2ProtocolEvidenceCompactPair = {
      schemaVersion: 1,
      kind: 'morpho_v2_current_protocol_origin_pair_v1',
      codeDictionary,
      origins,
    }
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    return decoded && JSON.stringify(decoded) === original ? compact : null
  } catch {
    return null
  }
}
