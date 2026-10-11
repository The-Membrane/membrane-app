import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import capture from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.json'
import {
  stusdsProtocolReadPlan,
  replayStusdsCurrentProtocolCapacityEvidence,
} from '@/lib/carry/stusdsCurrentProtocolCapacityEvidence'
import {
  encodeStusdsProtocolEvidence,
  decodeStusdsProtocolEvidence,
} from '@/lib/carry/stusdsProtocolEvidenceCodec'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function fixture() {
  const source = {
    chainId: 1 as const,
    blockNumber: Number(capture.sources[2].blockNumber),
    blockHash: capture.sources[2].blockHash,
    blockTime: capture.sources[2].blockTime,
    finalized: true as const,
  }
  const origins = capture.origins.map((host) => {
    const rows = capture.traces.filter((t) => t.origin === host && t.anchor === 2),
      find = (k: string) => rows.find((t) => t.key === k)!
    return {
      host,
      observation: {
        source: structuredClone(source),
        readAtUtc: capture.capturedAt,
        nativeIdentity: {
          assetAddress: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
          assetDecimals: 18 as const,
          shareDecimals: 18 as const,
        },
        coreRuntimeCodes: {
          proxy: find('code_proxy').response!.result as string,
          asset: find('code_asset').response!.result as string,
        },
        traces: stusdsProtocolReadPlan(source).map((p) => {
          const t = find(p.key)
          return {
            key: p.key,
            method: t.request.method,
            params: structuredClone(t.request.params),
            result: t.response!.result,
          }
        }),
      },
    }
  })
  return {
    raw: { origins },
    expected: { source, asOfMs: Date.parse(capture.capturedAt), originHosts: capture.origins },
  }
}
describe('lossless StUSDS native runtime evidence codec', () => {
  it('deduplicates identical actual raw bytes after external replay, retaining byte-exact proof', () => {
    const f = fixture(),
      packed = encodeStusdsProtocolEvidence(f.raw, f.expected, hash)!
    expect(packed).toBeTruthy()
    expect(decodeStusdsProtocolEvidence(packed)).toEqual(f.raw)
    const bytes = new TextEncoder().encode(JSON.stringify(packed)).length
    expect(bytes).toBeLessThan(128 * 1024)
    expect(bytes).toBeLessThan(JSON.stringify(f.raw).length)
    expect(
      replayStusdsCurrentProtocolCapacityEvidence(
        decodeStusdsProtocolEvidence(packed),
        f.expected,
        hash,
      ),
    ).toEqual(replayStusdsCurrentProtocolCapacityEvidence(f.raw, f.expected, hash))
    process.stdout.write(`actual190fixture_compact_evidence_bytes=${bytes}\n`)
  })
  it.each(['unknown_ref', 'extra_code', 'missing_code', 'wrong_result', 'prototype', 'oversize'])(
    'rejects %s compact confusion',
    (mode) => {
      const f = fixture(),
        p: any = encodeStusdsProtocolEvidence(f.raw, f.expected, hash)
      if (mode === 'unknown_ref')
        p.origins[0].observation.coreRuntimeCodes.proxy.codeRef = 'constructor'
      if (mode === 'extra_code') p.runtimeCodes.foreign = '0x6000'
      if (mode === 'missing_code') delete p.runtimeCodes.asset
      if (mode === 'wrong_result') p.origins[0].observation.traces[0].result = { codeRef: 'proxy' }
      if (mode === 'prototype')
        Object.defineProperty(p.runtimeCodes, '__proto__', { value: '0x6000', enumerable: true })
      if (mode === 'oversize') p.runtimeCodes.asset = '0x' + '60'.repeat(131073)
      expect(decodeStusdsProtocolEvidence(p)).toBeNull()
    },
  )
  it('does not approve altered runtime bytes or forged source and isolates caller aliases', () => {
    const f = fixture(),
      p = encodeStusdsProtocolEvidence(f.raw, f.expected, hash)!
    const decoded = decodeStusdsProtocolEvidence(p)!
    decoded.origins[0].observation.coreRuntimeCodes.asset = '0x6000'
    expect(decodeStusdsProtocolEvidence(p)).toEqual(f.raw)
    p.runtimeCodes.asset = '0x6000'
    expect(
      replayStusdsCurrentProtocolCapacityEvidence(
        decodeStusdsProtocolEvidence(p),
        f.expected,
        hash,
      ),
    ).toBeNull()
    f.expected.source.blockHash = '0x' + 'a'.repeat(64)
    expect(encodeStusdsProtocolEvidence(f.raw, f.expected, hash)).toBeNull()
  })
})
