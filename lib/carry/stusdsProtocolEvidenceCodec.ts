import {
  replayStusdsCurrentProtocolCapacityEvidence,
  type StusdsProtocolOriginObservation,
  type StusdsProtocolSource,
} from './stusdsCurrentProtocolCapacityEvidence'

const runtimeKeys = ['proxy', 'asset', 'implementation', 'vat', 'jug', 'clip'] as const
const MAX_BYTES = 128 * 1024
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  record(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const code = (v: unknown): v is string =>
  typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(v) && v.length <= 262146
function withinBound(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_BYTES
}
type NativeRecord = { origins: { host: string; observation: StusdsProtocolOriginObservation }[] }
/** Lossless encoding of original, externally replay-approved RPC byte strings.
 * References deduplicate identical observations; decoding does not manufacture or attest RPC replies. */
export function encodeStusdsProtocolEvidence(
  supplied: unknown,
  expected: { source: StusdsProtocolSource; asOfMs: number; originHosts: readonly string[] },
  hash: (s: string) => string,
) {
  try {
    const v = structuredClone(supplied) as NativeRecord,
      e = structuredClone(expected)
    if (!replayStusdsCurrentProtocolCapacityEvidence(v, e, hash)) return null
    const codes: Record<string, string> = {}
    for (const origin of v.origins) {
      const o = origin.observation
      for (const k of runtimeKeys) {
        const c =
          k === 'proxy' || k === 'asset'
            ? o.coreRuntimeCodes[k]
            : o.traces.find((t) => t.key === 'code_' + k)?.result
        if (!code(c) || (codes[k] !== undefined && codes[k] !== c)) return null
        codes[k] = c
      }
    }
    const origins = structuredClone(v.origins) as any[]
    for (const { observation: o } of origins) {
      for (const k of ['proxy', 'asset']) o.coreRuntimeCodes[k] = { codeRef: k }
      for (const t of o.traces)
        if (t.key.startsWith('code_')) t.result = { codeRef: t.key.slice(5) }
    }
    const compact = {
      schema: 'stusds_lossless_runtime_code_refs_v1' as const,
      runtimeCodes: codes,
      origins,
    }
    return withinBound(compact) && decodeStusdsProtocolEvidence(compact) ? compact : null
  } catch {
    return null
  }
}
/** Returns original raw observations, not approved source evidence. Full external replay remains mandatory. */
export function decodeStusdsProtocolEvidence(supplied: unknown): NativeRecord | null {
  try {
    const v = structuredClone(supplied)
    if (
      !exactKeys(v, ['schema', 'runtimeCodes', 'origins']) ||
      v.schema !== 'stusds_lossless_runtime_code_refs_v1' ||
      !exactKeys(v.runtimeCodes, runtimeKeys) ||
      !runtimeKeys.every((k) => code(v.runtimeCodes[k])) ||
      !Array.isArray(v.origins) ||
      v.origins.length !== 2 ||
      !withinBound(v)
    )
      return null
    for (const origin of v.origins) {
      if (
        !exactKeys(origin, ['host', 'observation']) ||
        typeof origin.host !== 'string' ||
        origin.host.length > 253
      )
        return null
      const o = origin.observation
      if (
        !exactKeys(o, ['source', 'readAtUtc', 'nativeIdentity', 'coreRuntimeCodes', 'traces']) ||
        !exactKeys(o.coreRuntimeCodes, ['proxy', 'asset']) ||
        !Array.isArray(o.traces) ||
        o.traces.length !== 21
      )
        return null
      if (
        !exactKeys(o.source, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']) ||
        !exactKeys(o.nativeIdentity, ['assetAddress', 'assetDecimals', 'shareDecimals'])
      )
        return null
      for (const k of ['proxy', 'asset']) {
        if (!exactKeys(o.coreRuntimeCodes[k], ['codeRef']) || o.coreRuntimeCodes[k].codeRef !== k)
          return null
        o.coreRuntimeCodes[k] = v.runtimeCodes[k]
      }
      let count = 0
      for (const t of o.traces) {
        if (
          !exactKeys(t, ['key', 'method', 'params', 'result']) ||
          typeof t.key !== 'string' ||
          typeof t.method !== 'string' ||
          !Array.isArray(t.params)
        )
          return null
        if (t.key.startsWith('code_')) {
          const k = t.key.slice(5)
          if (
            !['implementation', 'vat', 'jug', 'clip'].includes(k) ||
            !exactKeys(t.result, ['codeRef']) ||
            t.result.codeRef !== k
          )
            return null
          t.result = v.runtimeCodes[k]
          count++
        } else if (typeof t.result !== 'string' || t.result.length > 262146) return null
      }
      if (count !== 4) return null
    }
    return { origins: v.origins } as NativeRecord
  } catch {
    return null
  }
}
