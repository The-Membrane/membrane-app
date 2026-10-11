import capture from '@/data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json'
import type {
  MorphoV2NativeSource,
  MorphoV2ProtocolCapacityExpected,
  MorphoV2ProtocolCapacityObservation,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'

/** Actual pilot requests, native response bytes and their original observation clocks. */
export function createMorphoV2ProtocolCapacityFixture(): {
  pair: MorphoV2ProtocolCapacityObservation
  expected: MorphoV2ProtocolCapacityExpected
} {
  const source: MorphoV2NativeSource = {
    chainId: 1,
    blockNumber: Number(capture.sources[2].blockNumber),
    blockHash: capture.sources[2].blockHash,
    blockTime: capture.sources[2].blockTime,
    finalized: true,
  }
  const origins = capture.origins.map((host) => {
    const rows = capture.traces.filter((row) => row.origin === host && row.anchor === 2)
    return {
      host,
      observation: {
        source: structuredClone(source),
        startedAtUtc: rows[0].startedAt,
        readAtUtc: rows.at(-1)!.completedAt,
        deadlineMs: 8000,
        traces: rows.map((row) => {
          const native = row.response!.result
          // The native reader retains only these three fields from each RPC block header.
          const result = row.key.startsWith('header_')
            ? {
                number: (native as { number: string }).number,
                hash: (native as { hash: string }).hash,
                timestamp: (native as { timestamp: string }).timestamp,
              }
            : native
          return {
            key: row.key,
            method: row.request.method,
            params: structuredClone(row.request.params),
            result: structuredClone(result),
            startedAtUtc: row.startedAt,
            completedAtUtc: row.completedAt,
          }
        }),
      },
    }
  })
  return {
    pair: { origins },
    expected: {
      source,
      asOfMs: Date.parse(capture.capturedAt),
      originHosts: [...capture.origins],
    },
  }
}
