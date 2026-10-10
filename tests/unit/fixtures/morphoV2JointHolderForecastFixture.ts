import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  sha256,
  stringToHex,
} from 'viem'
import { morphoV2AdapterCapacityMath } from '@/lib/carry/morphoV2AdapterCapacityMath'
import { morphoV2ProtocolReadPlan } from '@/lib/carry/morphoV2ProtocolCapacityReplay'
import {
  agreeHolderExitCapacityQuotes,
  buildHolderExitCapacityQuote,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { MorphoV2HolderForecastQuestion } from '@/lib/carry/morphoV2HolderForecastBinding'
import {
  encodeMorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionExpectation,
} from '@/lib/carry/morphoV2HolderPositionEvidence'
import {
  encodeMorphoV2HistoricalHolderEaEvidencePair,
  morphoV2HistoricalHolderEaCalldata,
  selectMorphoV2HistoricalHolderEaAnchors,
  type MorphoV2HistoricalHolderEaEvidencePair,
  type MorphoV2HistoricalHolderEaExpectation,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { encodeMorphoV2ProtocolEvidencePair } from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import { createMorphoV2ProtocolCapacityFixture } from './morphoV2ProtocolCapacityFixture'
import { createMorphoV2UsdtProtocolCapacityFixture } from './morphoV2UsdtProtocolCapacityFixture'

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
const PROTOCOL_ABI = parseAbi([
  'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
  'function position(bytes32,address) view returns(uint256,uint128,uint128)',
])
const hash = (text: string) => sha256(stringToHex(text)).slice(2)
export const MORPHO_JOINT_TEST_OWNER = `0x${'b'.repeat(40)}` as `0x${string}`
export const MORPHO_JOINT_RETAINED_FIXED_S = '10437267800221756345625'
export const jointUint = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`

/** Fully synthetic future source/header/holder responses. Retained runtime/prong
 * bytes are test inputs only; this fixture never establishes an actual capture. */
export function createMorphoV2JointHolderForecastFixture(
  asset: 'USDC' | 'USDT' = 'USDT',
  sharesRaw = MORPHO_JOINT_RETAINED_FIXED_S,
  includeHistorical = false,
  horizonHours = 24,
) {
  const f =
    asset === 'USDT'
      ? createMorphoV2UsdtProtocolCapacityFixture()
      : createMorphoV2ProtocolCapacityFixture()
  const profile =
    asset === 'USDT'
      ? f.expected.profile!
      : resolveMorphoV2TrustedProfile(
          'USDC → VaultV2 [USDC]',
          '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        )!
  const start = Date.parse('2026-10-08T08:00:00.000Z')
  const utc = (n: number) => new Date(start + n).toISOString()
  const source = {
    chainId: 1 as const,
    blockNumber: 26160000,
    blockHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    blockTime: utc(0),
    finalized: true as const,
  }
  const expected = { ...f.expected, profile, source, asOfMs: start + 10_000 }
  const pair = structuredClone(f.pair)
  for (const origin of pair.origins) {
    const o = origin.observation
    const trace = (key: string) => o.traces.find((t) => t.key === key)!
    const nativeUint = (key: string) => BigInt(trace(key).result as `0x${string}`)
    const retainedMarket = decodeFunctionResult({
      abi: PROTOCOL_ABI,
      functionName: 'market',
      data: trace('market').result as `0x${string}`,
    })
    // This is a new synthetic market, normalized to its synthetic source clock.
    // Both the native market response and market-dependent IRM calldata change.
    const market = [
      retainedMarket[0],
      retainedMarket[1],
      retainedMarket[2],
      retainedMarket[3],
      BigInt(start) / 1000n,
      retainedMarket[5],
    ] as const
    trace('market').result = encodeFunctionResult({
      abi: PROTOCOL_ABI,
      functionName: 'market',
      result: market,
    })
    const position = decodeFunctionResult({
      abi: PROTOCOL_ABI,
      functionName: 'position',
      data: trace('position').result as `0x${string}`,
    })
    const math = morphoV2AdapterCapacityMath({
      market,
      at: BigInt(start) / 1000n,
      borrowRate: nativeUint('borrowRate'),
      internalShares: nativeUint('adapterSupplyShares'),
      actualShares: position[0],
      idleCash: nativeUint('idleCash'),
      blueCash: nativeUint('blueCash'),
      allowance: nativeUint('adapterAllowance'),
      allocations: [0, 1, 2].map((i) => nativeUint('allocation' + i)),
      enrolled: true,
    })
    trace('adapterExpectedAssets').result = jointUint(BigInt(math.internalPositionAssetsRaw))
    trace('borrowRate').params = structuredClone(
      morphoV2ProtocolReadPlan(source, market, profile).find((spec) => spec.key === 'borrowRate')!
        .params,
    )
    o.source = structuredClone(source)
    o.startedAtUtc = utc(1000)
    o.readAtUtc = utc(4100)
    o.traces.forEach((t, i) => {
      t.startedAtUtc = utc(1000 + i * 100)
      t.completedAtUtc = utc(1100 + i * 100)
      if (t.method === 'eth_call' || t.method === 'eth_getCode')
        t.params[1] = { blockHash: source.blockHash, requireCanonical: true }
      else if (t.key.startsWith('header_')) {
        t.params[0] = `0x${source.blockNumber.toString(16)}`
        t.result = {
          number: `0x${source.blockNumber.toString(16)}`,
          hash: source.blockHash,
          timestamp: `0x${(BigInt(start) / 1000n).toString(16)}`,
        }
      }
    })
  }
  const question: MorphoV2HolderForecastQuestion = {
    routeKey: profile.subject.routeKey,
    destination: profile.subject.destination,
    requestedHolderAddress: MORPHO_JOINT_TEST_OWNER,
    requestedRaw: '1000000',
    requestedAssetAddress: profile.subject.asset,
    requestedAssetDecimals: 6,
    horizonHours,
    asOfMs: expected.asOfMs,
    independentSource: structuredClone(source),
  }
  const fullEaRaw = '10587996327'
  const assessment = {
    status: 'assessed',
    routeKey: question.routeKey,
    destinationAddress: question.destination,
    owner: MORPHO_JOINT_TEST_OWNER,
    request: {
      assetsRaw: question.requestedRaw,
      assetAddress: question.requestedAssetAddress,
      horizonHours,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'reverted',
        relatedToRequest: true,
        amountRaw: question.requestedRaw,
        assetAddress: question.requestedAssetAddress,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      amountRaw: null,
      assetAddress: question.requestedAssetAddress,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: fullEaRaw,
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
      sourceHolderPosition: { sharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' },
    },
    question.asOfMs,
  )!
  if (!quote) throw Error('synthetic_joint_capacity_quote_invalid')
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: expected.originHosts[0], quote },
    { host: expected.originHosts[1], quote },
    question.asOfMs,
  )!
  const holderExpected: MorphoV2HolderPositionExpectation = {
    ...profile.subject,
    destination: profile.subject.destination as `0x${string}`,
    asset: profile.subject.asset as `0x${string}`,
    owner: MORPHO_JOINT_TEST_OWNER,
    source,
    sharesRaw,
    fullEaRaw,
    originHosts: [...expected.originHosts] as [string, string],
    asOfMs: expected.asOfMs,
  }
  const holder: MorphoV2HolderPositionEvidence = {
    schemaVersion: 1,
    kind: 'morpho_v2_holder_position_pair_v1',
    origins: expected.originHosts.map((host) => ({
      host,
      observation: {
        schemaVersion: 1,
        kind: 'morpho_v2_holder_position_origin_v1',
        ...profile.subject,
        destination: profile.subject.destination as `0x${string}`,
        asset: profile.subject.asset as `0x${string}`,
        source: structuredClone(source),
        startedAtUtc: utc(5000),
        readAtUtc: utc(5200),
        deadlineMs: 8000,
        traces: [
          {
            key: 'balanceOf',
            method: 'eth_call',
            params: [
              {
                to: profile.subject.destination as `0x${string}`,
                data: encodeFunctionData({
                  abi: ABI,
                  functionName: 'balanceOf',
                  args: [MORPHO_JOINT_TEST_OWNER],
                }),
              },
              { blockHash: source.blockHash, requireCanonical: true },
            ],
            result: encodeFunctionResult({
              abi: ABI,
              functionName: 'balanceOf',
              result: BigInt(sharesRaw),
            }),
            startedAtUtc: utc(5000),
            completedAtUtc: utc(5100),
          },
          {
            key: 'previewRedeem',
            method: 'eth_call',
            params: [
              {
                to: profile.subject.destination as `0x${string}`,
                data: encodeFunctionData({
                  abi: ABI,
                  functionName: 'previewRedeem',
                  args: [BigInt(sharesRaw)],
                }),
              },
              { blockHash: source.blockHash, requireCanonical: true },
            ],
            result: encodeFunctionResult({
              abi: ABI,
              functionName: 'previewRedeem',
              result: BigInt(fullEaRaw),
            }),
            startedAtUtc: utc(5100),
            completedAtUtc: utc(5200),
          },
        ],
      },
    })) as MorphoV2HolderPositionEvidence['origins'],
  }
  const historicalExpected: MorphoV2HistoricalHolderEaExpectation = {
    profile,
    currentSource: source,
    sharesRaw,
    originHosts: [...expected.originHosts] as [string, string],
    asOfMs: expected.asOfMs,
  }
  const anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, source)
  const historical: MorphoV2HistoricalHolderEaEvidencePair = {
    schemaVersion: 1,
    kind: 'morpho_v2_historical_holder_ea_pair_v1',
    origins: expected.originHosts.map((host) => ({
      host,
      observation: {
        schemaVersion: 1,
        kind: 'morpho_v2_historical_holder_ea_origin_v1',
        profileId: profile.id,
        ...profile.subject,
        destination: profile.subject.destination as `0x${string}`,
        asset: profile.subject.asset as `0x${string}`,
        currentSource: structuredClone(source),
        sharesRaw,
        startedAtUtc: utc(6000),
        readAtUtc: utc(6000 + anchors.length * 100),
        deadlineMs: 12000,
        traces: anchors.map((point, i) => ({
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
          result: jointUint(1000001n + BigInt(i) * 77n),
          startedAtUtc: utc(6000 + i * 100),
          completedAtUtc: utc(6100 + i * 100),
        })),
      },
    })) as MorphoV2HistoricalHolderEaEvidencePair['origins'],
  }
  const compactProtocol = encodeMorphoV2ProtocolEvidencePair(pair, expected, hash)!
  const compactHolder = encodeMorphoV2HolderPositionEvidence(holder, holderExpected)!
  const compactHistorical = includeHistorical
    ? encodeMorphoV2HistoricalHolderEaEvidencePair(historical, historicalExpected)!
    : undefined
  if (
    !capacityAgreement ||
    !compactProtocol ||
    !compactHolder ||
    (includeHistorical && !compactHistorical)
  )
    throw Error('synthetic_joint_evidence_invalid')
  const response = {
    capacityAgreement,
    morphoV2CurrentProtocolCapacityEvidence: compactProtocol,
    morphoV2CurrentHolderPositionEvidence: compactHolder,
    ...(compactHistorical ? { morphoV2HistoricalHolderEaEvidence: compactHistorical } : {}),
  }
  return {
    question,
    expected,
    profile,
    pair,
    holder,
    holderExpected,
    historical,
    historicalExpected,
    anchors,
    compactProtocol,
    compactHolder,
    compactHistorical,
    capacityAgreement,
    response,
  }
}
