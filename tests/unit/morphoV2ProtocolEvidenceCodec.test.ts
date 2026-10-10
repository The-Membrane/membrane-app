import { createHash } from 'node:crypto'
import { sha256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  approveMorphoV2CurrentProtocolCapacityEvidence,
  replayMorphoV2CurrentProtocolCapacityEvidence,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'
import {
  decodeMorphoV2ProtocolEvidencePair,
  encodeMorphoV2ProtocolEvidencePair,
  MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS,
  type MorphoV2ProtocolEvidenceCompactPair,
} from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import { createMorphoV2ProtocolCapacityFixture } from './fixtures/morphoV2ProtocolCapacityFixture'
import { createMorphoV2UsdtProtocolCapacityFixture } from './fixtures/morphoV2UsdtProtocolCapacityFixture'

const nodeHash = (text: string) => createHash('sha256').update(text).digest('hex')
const browserHash = (text: string) => sha256(stringToHex(text)).slice(2)
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const codeKeys = ['code_vault', 'code_asset', 'code_adapter', 'code_blue', 'code_irm'] as const

function compactFixture() {
  const fixture = createMorphoV2ProtocolCapacityFixture()
  const compact = encodeMorphoV2ProtocolEvidencePair(fixture.pair, fixture.expected, nodeHash)
  expect(compact).not.toBeNull()
  return { ...fixture, compact: compact! }
}

function trace(compact: MorphoV2ProtocolEvidenceCompactPair, key: string, origin = 0) {
  const result = compact.origins[origin].observation.traces.find((row) => row.key === key)
  expect(result, key).toBeDefined()
  return result!
}

describe('lossless Morpho V2 current native evidence codec', () => {
  it('compacts the actual pilot pair below the transport bound without changing JSON bytes or approval', () => {
    const { pair, expected, compact } = compactFixture()
    const original = JSON.stringify(pair)
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    const bytes = byteLength(compact)
    expect(byteLength(pair)).toBe(246004)
    expect(compact.schemaVersion).toBe(1)
    expect(compact.kind).toBe('morpho_v2_current_protocol_origin_pair_v1')
    expect(Object.keys(compact.codeDictionary)).toEqual(codeKeys)
    expect(compact.origins.map((origin) => origin.host)).toEqual(expected.originHosts)
    expect(compact.origins.every((origin) => origin.observation.traces.length === 31)).toBe(true)
    for (const key of codeKeys) {
      expect(compact.codeDictionary[key]).toBe(
        pair.origins[0].observation.traces.find((row) => row.key === key)!.result,
      )
      expect(trace(compact, key).result).toEqual({ codeRef: key })
      expect(trace(compact, key, 1).result).toEqual({ codeRef: key })
    }
    expect(JSON.stringify(decoded)).toBe(original)
    expect(bytes).toBeLessThanOrEqual(256 * 1024)
    expect(bytes).toBeLessThan(byteLength(pair))
    expect(MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS).toEqual({
      compactPairBytes: 256 * 1024,
      rawOriginBytes: 256 * 1024,
      traceCount: 31,
    })
    const native = replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, nodeHash)!
    expect(native).not.toBeNull()
    expect(native.captureReceiptSha256).toBe(nodeHash(original))
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, nodeHash)).toEqual(
      native,
    )
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, browserHash)).toEqual(
      native,
    )
    const nodeApproval = approveMorphoV2CurrentProtocolCapacityEvidence(
      decoded,
      expected,
      nodeHash,
    )!
    const browserApproval = approveMorphoV2CurrentProtocolCapacityEvidence(
      decoded,
      expected,
      browserHash,
    )!
    expect(nodeApproval.current).toEqual(browserApproval.current)
    expect(nodeApproval.acceptEvidence(browserApproval.current)).toBe(true)
    expect(browserApproval.acceptEvidence(nodeApproval.current)).toBe(true)
    const changed = structuredClone(nodeApproval.current)
    changed.point.prongs.blueCashRaw = '1'
    expect(nodeApproval.acceptEvidence(changed)).toBe(false)
    expect(browserApproval.acceptEvidence(changed)).toBe(false)
    process.stdout.write(
      `morpho_actual190_current_pair_raw_bytes=${byteLength(pair)} compact_bytes=${bytes}\n`,
    )
  })

  it('preserves original field order, trace order and origin order in the receipt digest', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    pair.origins.reverse()
    for (const origin of pair.origins) {
      const header = origin.observation.traces[0]
      header.result = Object.fromEntries(
        Object.entries(header.result as Record<string, unknown>).reverse(),
      )
    }
    const original = JSON.stringify(pair)
    const compact = encodeMorphoV2ProtocolEvidencePair(pair, expected, browserHash)!
    expect(compact).not.toBeNull()
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    expect(JSON.stringify(decoded)).toBe(original)
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, browserHash)
        ?.captureReceiptSha256,
    ).toBe(nodeHash(original))
  })

  it.each([
    ['frame', 1],
    ['current receipt', 2],
  ] as const)('snapshots caller evidence before the %s hash callback', (_phase, mutateAt) => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    const original = JSON.stringify(pair)
    const approved = replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, nodeHash)
    let hashCalls = 0
    const compact = encodeMorphoV2ProtocolEvidencePair(pair, expected, (text) => {
      hashCalls += 1
      if (hashCalls === mutateAt) {
        for (const origin of pair.origins) {
          origin.observation.source.blockHash = `0x${'0'.repeat(64)}`
          origin.observation.traces.find((row) => row.key === 'code_blue')!.result = '0x00'
        }
      }
      return nodeHash(text)
    })
    expect(hashCalls).toBe(2)
    expect(JSON.stringify(pair)).not.toBe(original)
    expect(compact).not.toBeNull()
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    expect(JSON.stringify(decoded)).toBe(original)
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, nodeHash)).toEqual(
      approved,
    )
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, nodeHash)).toBeNull()
  })

  it('returns independent decoded trees and never grants approval merely by decoding', () => {
    const { pair, expected, compact } = compactFixture()
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)!
    decoded.origins[0].observation.traces[1].result = '0x00'
    expect(JSON.stringify(decodeMorphoV2ProtocolEvidencePair(compact))).toBe(JSON.stringify(pair))
    compact.codeDictionary.code_adapter = '0x00'
    const structurallyValid = decodeMorphoV2ProtocolEvidencePair(compact)
    expect(structurallyValid).not.toBeNull()
    expect(
      approveMorphoV2CurrentProtocolCapacityEvidence(structurallyValid, expected, nodeHash),
    ).toBeNull()
    expect(
      approveMorphoV2CurrentProtocolCapacityEvidence(structurallyValid, expected, browserHash),
    ).toBeNull()
  })

  it.each([
    'schema',
    'kind',
    'extra_top_level',
    'extra_dictionary',
    'missing_dictionary',
    'unknown_ref',
    'cross_key_ref',
    'extra_ref_field',
    'literal_code',
    'ref_in_noncode_result',
    'ref_in_params',
    'duplicate_trace',
    'missing_trace',
    'extra_trace',
    'duplicate_host',
    'unsafe_integer',
    'odd_code_hex',
  ])('rejects compact structural confusion: %s', (mode) => {
    const { compact } = compactFixture()
    const value: any = compact
    if (mode === 'schema') value.schemaVersion = 2
    if (mode === 'kind') value.kind = 'morpho_v2_current_protocol_origin_pair_v2'
    if (mode === 'extra_top_level') value.approved = true
    if (mode === 'extra_dictionary') value.codeDictionary.foreign = '0x00'
    if (mode === 'missing_dictionary') delete value.codeDictionary.code_irm
    if (mode === 'unknown_ref') trace(compact, 'code_adapter').result = { codeRef: 'unknown' }
    if (mode === 'cross_key_ref') trace(compact, 'code_adapter').result = { codeRef: 'code_asset' }
    if (mode === 'extra_ref_field')
      trace(compact, 'code_adapter').result = { codeRef: 'code_adapter', value: '0x00' }
    if (mode === 'literal_code')
      trace(compact, 'code_adapter').result = compact.codeDictionary.code_adapter
    if (mode === 'ref_in_noncode_result')
      trace(compact, 'asset').result = { nested: { codeRef: 'code_asset' } }
    if (mode === 'ref_in_params')
      trace(compact, 'asset').params = [{ nested: { codeRef: 'code_asset' } }]
    if (mode === 'duplicate_trace') trace(compact, 'asset').key = 'code_asset'
    if (mode === 'missing_trace') compact.origins[0].observation.traces.pop()
    if (mode === 'extra_trace')
      compact.origins[0].observation.traces.push(structuredClone(trace(compact, 'asset')))
    if (mode === 'duplicate_host') compact.origins[1].host = compact.origins[0].host
    if (mode === 'unsafe_integer')
      compact.origins[0].observation.source.blockNumber = Number.MAX_SAFE_INTEGER + 1
    if (mode === 'odd_code_hex') compact.codeDictionary.code_irm = '0x1'
    expect(decodeMorphoV2ProtocolEvidencePair(compact)).toBeNull()
  })

  it.each(['accessor', 'symbol', 'prototype', 'pollution_key', 'cycle', 'alias', 'sparse_array'])(
    'rejects non-JSON or aliased compact data: %s',
    (mode) => {
      const { compact } = compactFixture()
      let accessorReads = 0
      if (mode === 'accessor')
        Object.defineProperty(compact.codeDictionary, 'code_asset', {
          enumerable: true,
          get() {
            accessorReads++
            return '0x00'
          },
        })
      if (mode === 'symbol') (compact.codeDictionary as any)[Symbol('hidden')] = '0x00'
      if (mode === 'prototype') Object.setPrototypeOf(compact.codeDictionary, { hidden: '0x00' })
      if (mode === 'pollution_key')
        Object.defineProperty(compact.codeDictionary, '__proto__', {
          value: '0x00',
          enumerable: true,
        })
      if (mode === 'cycle') (trace(compact, 'asset') as any).result = compact
      if (mode === 'alias')
        compact.origins[1].observation.source = compact.origins[0].observation.source
      if (mode === 'sparse_array') delete compact.origins[0].observation.traces[1]
      expect(decodeMorphoV2ProtocolEvidencePair(compact)).toBeNull()
      expect(accessorReads).toBe(0)
    },
  )

  it('rejects oversized compact dictionaries and raw origins before transport', () => {
    const { compact, pair, expected } = compactFixture()
    compact.codeDictionary.code_irm = '0x' + '60'.repeat(131073)
    expect(byteLength(compact)).toBeGreaterThan(
      MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.compactPairBytes,
    )
    expect(decodeMorphoV2ProtocolEvidencePair(compact)).toBeNull()
    pair.origins[0].observation.traces.find((row) => row.key === 'asset')!.result =
      '0x' + '60'.repeat(131073)
    expect(byteLength(pair.origins[0].observation)).toBeGreaterThan(
      MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.rawOriginBytes,
    )
    expect(encodeMorphoV2ProtocolEvidencePair(pair, expected, nodeHash)).toBeNull()
  })

  it.each([
    'clock',
    'host',
    'config',
    'code',
    'code_alias',
    'source',
    'future_source',
    'stale_source',
    'expected_hosts',
  ])('fails native approval after structurally valid tampering: %s', (mode) => {
    const { compact, expected } = compactFixture()
    if (mode === 'clock')
      compact.origins[0].observation.traces[1].startedAtUtc = new Date(
        Date.parse(compact.origins[0].observation.traces[0].completedAtUtc) - 1,
      ).toISOString()
    if (mode === 'host') compact.origins[1].host = 'unapproved.example'
    if (mode === 'config')
      trace(compact, 'liquidityAdapter').result = trace(compact, 'asset').result
    if (mode === 'code') compact.codeDictionary.code_adapter = '0x00'
    if (mode === 'code_alias')
      compact.codeDictionary.code_adapter = compact.codeDictionary.code_asset
    if (mode === 'source') expected.source.blockHash = '0x' + 'a'.repeat(64)
    if (mode === 'future_source') expected.asOfMs = Date.parse(expected.source.blockTime) - 1
    if (mode === 'stale_source') expected.asOfMs = Date.parse(expected.source.blockTime) + 1800001
    if (mode === 'expected_hosts')
      expected.originHosts = [expected.originHosts[0], expected.originHosts[0]]
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    expect(decoded).not.toBeNull()
    expect(approveMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, nodeHash)).toBeNull()
    expect(
      approveMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, browserHash),
    ).toBeNull()
    expect(encodeMorphoV2ProtocolEvidencePair(decoded, expected, nodeHash)).toBeNull()
  })
})

describe('USDT profile authority through unchanged protocol codec', () => {
  it('roundtrips exactly 31 ordered traces and five code keys using independent USDT authority', () => {
    const { pair, expected } = createMorphoV2UsdtProtocolCapacityFixture()
    const compact = encodeMorphoV2ProtocolEvidencePair(pair, expected, nodeHash)
    expect(compact).not.toBeNull()
    expect(compact?.schemaVersion).toBe(1)
    expect(Object.keys(compact!.codeDictionary)).toEqual(codeKeys)
    const decoded = decodeMorphoV2ProtocolEvidencePair(compact)
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(pair))
    expect(decoded?.origins.every(({ observation }) => observation.traces.length === 31)).toBe(true)
    expect(byteLength(compact)).toBeLessThanOrEqual(
      MORPHO_V2_PROTOCOL_EVIDENCE_CODEC_LIMITS.compactPairBytes,
    )
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(decoded, expected, nodeHash),
    ).not.toBeNull()
    const { profile: _ignored, ...defaultExpected } = expected
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(decoded, defaultExpected, nodeHash),
    ).toBeNull()
    expect(encodeMorphoV2ProtocolEvidencePair(pair, defaultExpected, nodeHash)).toBeNull()
    expect(
      encodeMorphoV2ProtocolEvidencePair(
        pair,
        { ...expected, profile: structuredClone(expected.profile!) },
        nodeHash,
      ),
    ).toBeNull()
    expect(
      encodeMorphoV2ProtocolEvidencePair(
        { ...pair, profile: expected.profile, approved: true },
        expected,
        nodeHash,
      ),
    ).toBeNull()
  })
})
