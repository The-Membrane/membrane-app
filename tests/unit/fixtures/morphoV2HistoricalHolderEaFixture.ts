import {
  morphoV2HistoricalHolderEaCalldata,
  selectMorphoV2HistoricalHolderEaAnchors,
  type MorphoV2HistoricalHolderEaEvidencePair,
  type MorphoV2HistoricalHolderEaExpectation,
  type MorphoV2HistoricalHolderEaOriginObservation,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { reviewedMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'

export const historicalEaUint = (n: bigint): `0x${string}` =>
  `0x${n.toString(16).padStart(64, '0')}`
/** Synthetic fresh clocks and arbitrary full S, never a native capture claim. */
export function createMorphoV2HistoricalHolderEaFixture(
  asset: 'USDC' | 'USDT' = 'USDC',
  sharesRaw = '987654321123456789',
) {
  const profile =
    asset === 'USDC'
      ? resolveMorphoV2TrustedProfile(
          'USDC → VaultV2 [USDC]',
          '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        )!
      : resolveMorphoV2TrustedProfile(
          'USDT → VaultV2 [USDT]',
          '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
          '0xdac17f958d2ee523a2206206994597c13d831ec7',
        )!
  const last = reviewedMorphoV2ProtocolHistory(profile)!.history.points.at(-1)!.source
  const started = Date.parse(last.blockTime) + 60_000
  const expected: MorphoV2HistoricalHolderEaExpectation = {
    profile,
    currentSource: {
      chainId: 1,
      blockNumber: Number(last.blockNumber) + 5,
      blockHash: `0x${'b'.repeat(64)}`,
      blockTime: new Date(started).toISOString(),
      finalized: true,
    },
    sharesRaw,
    originHosts: ['first.example', 'second.example'],
    asOfMs: started + 2000,
  }
  const anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, expected.currentSource)
  const observation: MorphoV2HistoricalHolderEaOriginObservation = {
    schemaVersion: 1,
    kind: 'morpho_v2_historical_holder_ea_origin_v1',
    profileId: profile.id,
    ...profile.subject,
    destination: profile.subject.destination as `0x${string}`,
    asset: profile.subject.asset as `0x${string}`,
    currentSource: structuredClone(expected.currentSource),
    sharesRaw,
    startedAtUtc: new Date(started).toISOString(),
    readAtUtc: new Date(started + anchors.length * 100).toISOString(),
    deadlineMs: 12_000,
    traces: anchors.map((point, index) => ({
      source: structuredClone(point.source),
      key: 'previewRedeem',
      method: 'eth_call',
      params: [
        {
          to: profile.subject.destination as `0x${string}`,
          data: morphoV2HistoricalHolderEaCalldata(sharesRaw),
        },
        { blockHash: point.source.blockHash as `0x${string}`, requireCanonical: true },
      ],
      result: historicalEaUint(1000001n + BigInt(index) * 77n),
      startedAtUtc: new Date(started + index * 100).toISOString(),
      completedAtUtc: new Date(started + (index + 1) * 100).toISOString(),
    })),
  }
  const pair: MorphoV2HistoricalHolderEaEvidencePair = {
    schemaVersion: 1,
    kind: 'morpho_v2_historical_holder_ea_pair_v1',
    origins: [
      { host: expected.originHosts[0], observation: structuredClone(observation) },
      { host: expected.originHosts[1], observation: structuredClone(observation) },
    ],
  }
  return { expected, pair, anchors, started }
}
