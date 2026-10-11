import capture from '@/data/research/venue-signals/morpho-usdt-protocol-prong-evidence-2026-10-08/00-actual-1.json'
import { decodeFunctionResult, parseAbi } from 'viem'
import {
  morphoV2ProtocolReadPlan,
  type MorphoV2NativeSource,
  type MorphoV2ProtocolCapacityExpected,
  type MorphoV2ProtocolCapacityObservation,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'

/** Native retained USDT response bytes with deliberately synthetic fresh clocks.
 * This tests the current 31-prong schema, not a native live capture or browser acceptance.
 * Historical full-S previewRedeem is excluded from the current transport schema. */
export function createMorphoV2UsdtProtocolCapacityFixture(): {
  pair: MorphoV2ProtocolCapacityObservation
  expected: MorphoV2ProtocolCapacityExpected
} {
  const profile = resolveMorphoV2TrustedProfile(
    'USDT → VaultV2 [USDT]',
    '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  )!
  const anchor = capture.plan.anchors[0]
  const source: MorphoV2NativeSource = {
    chainId: 1,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    blockTime: anchor.blockTime,
    finalized: true,
  }
  const hosts = [...new Set(capture.traces.map((trace) => trace.origin))]
  const fixed = morphoV2ProtocolReadPlan(source, undefined, profile)
  const result = (host: string, spec: (typeof fixed)[number]): unknown => {
    const row = capture.traces.find(
      (trace) =>
        trace.origin === host &&
        trace.request.method === spec.method &&
        JSON.stringify(trace.request.params) === JSON.stringify(spec.params),
    )
    if (!row) throw new Error('Missing retained USDT native read: ' + spec.key)
    const raw = JSON.parse(row.responseText).result
    return spec.key.startsWith('header_')
      ? { number: raw.number, hash: raw.hash, timestamp: raw.timestamp }
      : raw
  }
  const rawMarket = result(hosts[0], fixed.find((spec) => spec.key === 'market')!)
  const market = decodeFunctionResult({
    abi: parseAbi([
      'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
    ]),
    functionName: 'market',
    data: rawMarket as `0x${string}`,
  })
  const specs = morphoV2ProtocolReadPlan(source, market, profile)
  const start = Date.parse(source.blockTime) + 1000
  const utc = (offset: number) => new Date(start + offset).toISOString()
  return {
    pair: {
      origins: hosts.map((host) => ({
        host,
        observation: {
          source: structuredClone(source),
          startedAtUtc: utc(0),
          readAtUtc: utc(specs.length * 100),
          deadlineMs: 8000,
          traces: specs.map((spec, index) => ({
            key: spec.key,
            method: spec.method,
            params: structuredClone(spec.params),
            result: result(host, spec),
            startedAtUtc: utc(index * 100),
            completedAtUtc: utc((index + 1) * 100),
          })),
        },
      })),
    },
    expected: { source, asOfMs: start + 5000, originHosts: hosts, profile },
  }
}
