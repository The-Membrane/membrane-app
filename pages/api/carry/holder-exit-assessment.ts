import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import { encodeStusdsProtocolEvidence } from '@/lib/carry/stusdsProtocolEvidenceCodec'
import { replayStusdsCurrentProtocolCapacityEvidence } from '@/lib/carry/stusdsCurrentProtocolCapacityEvidence'
import {
  prewarmMorphoV2ProtocolHistory,
  readMorphoV2CurrentProtocolOrigin,
  type MorphoV2ProtocolRequestClient,
} from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import {
  approveMorphoV2HolderPositionEvidence,
  encodeMorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionExpectation,
} from '@/lib/carry/morphoV2HolderPositionEvidence'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import {
  encodeMorphoV2HistoricalHolderEaEvidencePair,
  type MorphoV2HistoricalHolderEaObservation,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { readMorphoV2HistoricalHolderEaOrigin } from '@/lib/carry/morphoV2HistoricalHolderEaReader.server'
import { encodeMorphoV2ProtocolEvidencePair } from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import {
  issueSusdeCurrentProtocolCapacityEvidence,
  readSusdeCurrentProtocolOrigin,
  type SusdeCurrentProtocolCapacityEvidence,
  type SusdeProtocolExpected,
  type SusdeProtocolRequestClient,
} from '@/lib/carry/susdeCurrentProtocolCapacity'
import { issueSusdeHolderForecastV2FromNativeOrigins } from '@/lib/carry/server/susdeHolderForecastIssuer'
import type { SusdeHolderForecastEnvelope } from '@/lib/carry/susdeHolderForecastEnvelope'
import {
  MAX_CURRENT_EXIT_BLOCK_AGE_MS,
  isCurrentHolderExitAssessment,
  readHolderExitAssessment,
  validateHolderExitAssessmentRequest,
  type HolderExitAssessment,
  type HolderExitAssessmentRequest,
} from '@/lib/carry/holderExitAssessment'
import {
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  type HolderExitCapacityBinding,
  type HolderExitCapacityAgreement,
} from '@/lib/carry/holderExitCapacity'
import { readFluidUsdcBridgeJointHistoricalEvidenceAtIssue } from '@/lib/carry/fluidUsdcBridgeJointHistoricalEvidence.server'
import type { FluidUsdcBridgeJointNativeHistoryEvidenceTransport } from '@/lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec'
import { resolveFluidUsdcBridgeJointTrustedProfile } from '@/lib/carry/fluidUsdcBridgeJointTrustedProfile'
import {
  acquireFluidUsdtBridgeNativeCapacity,
  selectedOriginalFluidUsdtBridgeNativeCapacity,
  type FluidUsdtBridgeNativeCapacityBinding,
} from '@/lib/carry/fluidUsdtBridgeNativeCapacity.server'
import {
  readFluidUsdtBridgeJointHistoricalEvidenceAtIssue,
  selectedOriginalFluidUsdtBridgeJointHistoricalEvidence,
  type FluidUsdtBridgeJointHistoricalEvidence,
} from '@/lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server'
import type { FluidUsdtBridgeJointCurrentEvidence } from '@/lib/carry/fluidUsdtBridgeJointHolderForecastBinding'
import {
  FLUID_USDT_QUOTE_ROUTE,
  FLUID_USDT_QUOTE_CONTRACTS,
} from '@/lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'
import {
  acquireUmbrellaGhoNativeCapacity,
  selectedOriginalUmbrellaGhoNativeCapacity,
} from '@/lib/carry/umbrellaGhoNativeCapacity.server'
import type {
  UmbrellaGhoNativeSource,
  UmbrellaGhoNativeCapacityBinding,
  UmbrellaGhoNativeCapacityFact,
} from '@/lib/carry/umbrellaGhoNativeCapacity'
import {
  readUmbrellaGhoJointHistoricalEvidenceAtIssue,
  selectedOriginalUmbrellaGhoJointHistoricalEvidence,
  type UmbrellaGhoJointHistoricalEvidenceTransport,
} from '@/lib/carry/umbrellaGhoJointHistoricalEvidence.server'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO, ORIGINAL_GHO } from '@/lib/carry/umbrellaGhoExit'
import { readUsd3JointHistoricalEvidenceAtIssue } from '@/lib/carry/usd3JointHistoricalEvidence.server'
import type { Usd3JointNativeHistoryEvidenceTransport } from '@/lib/carry/usd3JointNativeEvidenceCodec'
import { resolveUsd3JointTrustedProfile } from '@/lib/carry/usd3JointTrustedProfile'
import {
  agreeCometWithdrawFacts,
  type CometWithdrawFactsAgreement,
} from '@/lib/carry/cometHolderCapacityProjection'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET } from '@/lib/carry/apyUsdExit'
import {
  acquireApyUsdJointNativeCurrent,
  selectedOriginalApyUsdJointNativeCurrent,
  readApyUsdJointNativeHistoryAtIssue,
  selectedOriginalApyUsdJointNativeHistory,
  apyUsdJointNativeReceiptCandidateHints,
  type ApyUsdJointNativeAcquisitionBinding,
  type ApyUsdJointNativeCurrentAcquisition,
  type ApyUsdJointNativeHistoricalEvidence,
} from '@/lib/carry/apyUsdJointNativeEvidence.server'
import {
  resolveIssuedHolderExitSubject,
  assessHolderExitConditionalProjection,
  type HolderExitConditionalProjectionEvidence,
} from '@/lib/carry/holderExitMechanisms'
import { projectHolderExitMechanicalOutlook } from '@/lib/carry/holderExitMechanicalOutlook'
import type { HolderExitAssessmentView } from '@/lib/carry/holderExitMechanicalOutlookView'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'
import { loadMorphoV2IdleHistory } from '@/lib/carry/morphoV2IdleHistory.server'
import { loadMorphoV2IdleCompactPanel } from '@/lib/carry/morphoV2IdleCompactPanel.server'
import {
  createMorphoV2IdleNativeOrigin,
  readMorphoV2IdleNativeHolder,
  readMorphoV2IdleNativePanelHolder,
  requiredMorphoV2IdleHolderQuote,
  type MorphoV2IdleHolderRequest,
} from '@/lib/carry/morphoV2IdleNativeReader.server'
import {
  issueMorphoV2IdleHolderForecast,
  selectedMorphoV2IdleServerHolderForecastIssue,
  issueMorphoV2IdlePanelHolderForecast,
  selectedMorphoV2IdleServerPanelHolderForecastIssue,
} from '@/lib/carry/morphoV2IdleHolderForecastIssuer.server'
import { acquireSaturnAppForecast, selectedSaturnServerForecastEnvelope, isSaturnNativeClient } from '@/lib/carry/saturnHolderForecast.server'
import type { SaturnForecastEnvelope } from '@/lib/carry/saturnAppForecastEvidence'

const MAX_BODY_BYTES = 768
const localRates = new Map<string, { start: number; count: number }>()
type HolderExitOriginWitness = {
  host: string
  assessment: HolderExitAssessment
  /** Private association with the exact client that produced this required assessment. */
  client: Parameters<typeof readHolderExitAssessment>[0]['morpho']
  morphoV2HistoricalHolderEaObservation?: MorphoV2HistoricalHolderEaObservation | null
}
type MorphoV2IdleRequiredReadContext = {
  witnesses: readonly HolderExitOriginWitness[]
  /** Request-local association; these selected URLs never enter a public response or log. */
  selectedUrls: WeakMap<object, string>
}

// One finite local archive replay per module initialization. Required assessments
// never await it; cold optional reads return null without scheduling later RPC.
void prewarmMorphoV2ProtocolHistory()
const reviewedUsdtProfile = resolveMorphoV2TrustedProfile(
  'USDT → VaultV2 [USDT]',
  '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
)
if (reviewedUsdtProfile) void prewarmMorphoV2ProtocolHistory(reviewedUsdtProfile)
const observedMorphoV2Subjects = [
  [
    'AUSD → VaultV2 [AUSD]',
    '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  ],
  [
    'EURCV → VaultV2 [EURCV]',
    '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f',
    '0x5f7827fdeb7c20b443265fc2f40845b715385ff2',
  ],
  [
    'LINK → VaultV2 [LINK]',
    '0x610f5b68bd1eed68af649a3fd3dc2caa1ee4ae7e',
    '0x514910771af9ca656af840dff83e8264ecf986ca',
  ],
] as const
for (const [routeKey, destination, asset] of observedMorphoV2Subjects) {
  const profile = resolveMorphoV2TrustedProfile(routeKey, destination, asset)
  if (profile) void prewarmMorphoV2ProtocolHistory(profile)
}

export type HolderExitForecastSourceReference = {
  blockNumber: number
  blockHash: string
  blockTime: string
}
export type HolderExitAssessmentApiRequest = HolderExitAssessmentRequest & {
  forecastSourceReference?: HolderExitForecastSourceReference
}
export type HolderExitAssessmentApiView = HolderExitAssessmentView & {
  executionAgreement?: HolderExitConditionalProjectionEvidence
  capacityAgreement?: HolderExitCapacityAgreement
  stusdsCurrentProtocolCapacityEvidence?: NonNullable<
    ReturnType<typeof encodeStusdsProtocolEvidence>
  >
  morphoV2CurrentProtocolCapacityEvidence?: NonNullable<
    ReturnType<typeof encodeMorphoV2ProtocolEvidencePair>
  >
  morphoV2CurrentHolderPositionEvidence?: string
  morphoV2HistoricalHolderEaEvidence?: string
  morphoV2IdleHolderForecastEvidence?: string
  morphoV2IdleJointIssuedAtUtc?: string
  saturnHolderForecastEvidence?: SaturnForecastEnvelope
  cometFactsAgreement?: CometWithdrawFactsAgreement
  susdeCurrentProtocolCapacityEvidence?: SusdeCurrentProtocolCapacityEvidence
  susdeHolderForecastEnvelope?: SusdeHolderForecastEnvelope
  usd3JointHistoricalEvidence?: Usd3JointNativeHistoryEvidenceTransport
  usd3JointIssuedAtUtc?: string
  fluidUsdcBridgeJointHistoricalEvidence?: FluidUsdcBridgeJointNativeHistoryEvidenceTransport
  fluidUsdcBridgeJointIssuedAtUtc?: string
  fluidUsdtBridgeJointCurrentEvidence?: FluidUsdtBridgeJointCurrentEvidence
  fluidUsdtBridgeJointHistoricalEvidence?: FluidUsdtBridgeJointHistoricalEvidence
  fluidUsdtBridgeJointIssuedAtUtc?: string
  umbrellaGhoNativeCapacity?: UmbrellaGhoNativeCapacityFact
  umbrellaGhoJointHistoricalEvidence?: UmbrellaGhoJointHistoricalEvidenceTransport
  umbrellaGhoJointIssuedAtUtc?: string
  apyUsdJointNativeCurrentEvidence?: ApyUsdJointNativeCurrentAcquisition['evidence'] & {
    availableAtUtc: string
  }
  apyUsdJointHistoricalEvidence?: ApyUsdJointNativeHistoricalEvidence
  apyUsdJointIssuedAtUtc?: string
}

/** Finalize the issue clock after optional native acquisition, within this same
 * response. The collector retains its real clocks; current source TTL is rechecked. */
export async function withUsd3JointHistoricalEvidence<
  T extends {
    capacityAgreement?: HolderExitCapacityAgreement
    executionAgreement?: unknown
  },
>(
  input: HolderExitAssessmentRequest,
  response: T,
): Promise<
  T & {
    usd3JointHistoricalEvidence?: Usd3JointNativeHistoryEvidenceTransport
    usd3JointIssuedAtUtc?: string
  }
> {
  const capacity = response.capacityAgreement
  if (
    !capacity ||
    !resolveUsd3JointTrustedProfile(
      input.routeKey,
      input.destinationAddress.toLowerCase(),
      capacity.quote.asset,
    )
  )
    return response
  try {
    const binding: HolderExitCapacityBinding = {
      routeKey: input.routeKey,
      destination: input.destinationAddress.toLowerCase(),
      owner: input.owner.toLowerCase(),
      requestedRaw: input.assetsRaw,
      asset: capacity.quote.asset,
      assetDecimals: capacity.quote.assetDecimals,
      currentSource: { ...capacity.quote.source },
      asOfMs: Date.now(),
      ...(response.executionAgreement ? { executionAgreement: response.executionAgreement } : {}),
    }
    const original = structuredClone(capacity)
    if (!selectedHolderExitCapacity(original, binding)) return response
    const finalized = await readUsd3JointHistoricalEvidenceAtIssue(original, binding)
    return finalized
      ? {
          ...response,
          usd3JointHistoricalEvidence: finalized.evidence,
          usd3JointIssuedAtUtc: finalized.issuedAtUtc,
        }
      : response
  } catch {
    return response
  }
}
export async function withFluidUsdcBridgeJointHistoricalEvidence<
  T extends {
    capacityAgreement?: HolderExitCapacityAgreement
    executionAgreement?: unknown
  },
>(
  input: HolderExitAssessmentRequest,
  response: T,
): Promise<
  T & {
    fluidUsdcBridgeJointHistoricalEvidence?: FluidUsdcBridgeJointNativeHistoryEvidenceTransport
    fluidUsdcBridgeJointIssuedAtUtc?: string
  }
> {
  const capacity = response.capacityAgreement
  if (
    !capacity ||
    !resolveFluidUsdcBridgeJointTrustedProfile(
      input.routeKey,
      input.destinationAddress.toLowerCase(),
      capacity.quote.asset,
    )
  )
    return response
  try {
    const binding: HolderExitCapacityBinding = {
      routeKey: input.routeKey,
      destination: input.destinationAddress.toLowerCase(),
      owner: input.owner.toLowerCase(),
      requestedRaw: input.assetsRaw,
      asset: capacity.quote.asset,
      assetDecimals: capacity.quote.assetDecimals,
      currentSource: { ...capacity.quote.source },
      asOfMs: Date.now(),
      ...(response.executionAgreement ? { executionAgreement: response.executionAgreement } : {}),
    }
    const original = structuredClone(capacity)
    if (!selectedHolderExitCapacity(original, binding)) return response
    const finalized = await readFluidUsdcBridgeJointHistoricalEvidenceAtIssue(original, binding)
    return finalized
      ? {
          ...response,
          fluidUsdcBridgeJointHistoricalEvidence: finalized.evidence,
          fluidUsdcBridgeJointIssuedAtUtc: finalized.issuedAtUtc,
        }
      : response
  } catch {
    return response
  }
}
/** Optional native facts never change the required execution source or execution envelope. */
export async function withUmbrellaGhoJointHistoricalEvidence<T extends object>(
  input: HolderExitAssessmentRequest,
  response: T,
  agreedSource: UmbrellaGhoNativeSource | null,
): Promise<
  T & {
    umbrellaGhoNativeCapacity?: UmbrellaGhoNativeCapacityFact
    umbrellaGhoJointHistoricalEvidence?: UmbrellaGhoJointHistoricalEvidenceTransport
    umbrellaGhoJointIssuedAtUtc?: string
  }
> {
  try {
    // Copy primitive own data before any await; no accessor or mutable caller question is used.
    const own = (v: unknown, key: string): unknown => {
      if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype)
        throw Error('umbrella_optional_input')
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('umbrella_optional_input')
      return d.value
    }
    const question = {
      routeKey: own(input, 'routeKey'),
      destinationAddress: own(input, 'destinationAddress'),
      owner: own(input, 'owner'),
      assetsRaw: own(input, 'assetsRaw'),
      horizonHours: own(input, 'horizonHours'),
    } as HolderExitAssessmentRequest
    if (
      question.routeKey !== UMBRELLA_GHO_ROUTE ||
      typeof question.destinationAddress !== 'string' ||
      question.destinationAddress.toLowerCase() !== UMBRELLA_STKGHO ||
      typeof question.owner !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(question.owner) ||
      /^0x0{40}$/i.test(question.owner)
    )
      return response
    validateHolderExitAssessmentRequest(question)
    const s = {
      chainId: own(agreedSource, 'chainId'),
      blockNumber: own(agreedSource, 'blockNumber'),
      blockHash: own(agreedSource, 'blockHash'),
      blockTime: own(agreedSource, 'blockTime'),
      finalized: own(agreedSource, 'finalized'),
    }
    if (
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      (s.blockNumber as number) <= 0 ||
      typeof s.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(s.blockHash) ||
      typeof s.blockTime !== 'string' ||
      !Number.isSafeInteger(Date.parse(s.blockTime)) ||
      new Date(s.blockTime).toISOString() !== s.blockTime
    )
      return response
    const source: UmbrellaGhoNativeSource = {
      chainId: 1,
      blockNumber: s.blockNumber as number,
      blockHash: s.blockHash.toLowerCase(),
      blockTime: s.blockTime,
      finalized: true,
    }
    const startMs = Date.now(),
      sourceMs = Date.parse(source.blockTime)
    if (startMs < sourceMs || startMs - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS) return response
    const binding: UmbrellaGhoNativeCapacityBinding = {
      routeKey: question.routeKey,
      destination: UMBRELLA_STKGHO,
      owner: question.owner.toLowerCase(),
      asset: ORIGINAL_GHO,
      assetDecimals: 18,
      shareDecimals: 18,
      source,
      asOfMs: startMs,
    }
    // Default protected native acquisition independently verifies finalized headers and full S/Ea.
    const original = await acquireUmbrellaGhoNativeCapacity(binding)
    const fact = selectedOriginalUmbrellaGhoNativeCapacity(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (!original || !fact || original.fact !== fact) return response
    const finalized = await readUmbrellaGhoJointHistoricalEvidenceAtIssue(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (!finalized) return response
    const issueMs = Date.parse(finalized.issuedAtUtc),
      nowMs = Date.now()
    if (
      !Number.isSafeInteger(issueMs) ||
      new Date(issueMs).toISOString() !== finalized.issuedAtUtc ||
      issueMs < startMs ||
      issueMs > nowMs ||
      nowMs - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS ||
      Date.parse(finalized.evidence.acquiredAtUtc) > issueMs
    )
      return response
    const issueBinding = { ...binding, asOfMs: issueMs }
    if (
      selectedOriginalUmbrellaGhoNativeCapacity(original, issueBinding) !== fact ||
      !selectedOriginalUmbrellaGhoJointHistoricalEvidence(finalized, original, issueBinding)
    )
      return response
    return {
      ...response,
      umbrellaGhoNativeCapacity: fact,
      umbrellaGhoJointHistoricalEvidence: finalized.evidence,
      umbrellaGhoJointIssuedAtUtc: finalized.issuedAtUtc,
    }
  } catch {
    return response
  }
}

/** Optional APY evidence uses the complete question and actual retained original pointers.
 * Native full S/entitlements are read independently of requested Q. */
export async function withApyUsdJointHistoricalEvidence<T extends object>(
  input: HolderExitAssessmentRequest,
  response: T,
  agreedSource: ApyUsdJointNativeAcquisitionBinding['source'] | null,
): Promise<
  T & {
    apyUsdJointNativeCurrentEvidence?: ApyUsdJointNativeCurrentAcquisition['evidence'] & {
      availableAtUtc: string
    }
    apyUsdJointHistoricalEvidence?: ApyUsdJointNativeHistoricalEvidence
    apyUsdJointIssuedAtUtc?: string
  }
> {
  try {
    const own = (v: unknown, key: string): unknown => {
      if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype)
        throw Error('apy_optional_input')
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('apy_optional_input')
      return d.value
    }
    const receiptDescriptor = Object.getOwnPropertyDescriptor(input, 'receiptTokenId')
    if (
      receiptDescriptor &&
      (!receiptDescriptor.enumerable || !Object.hasOwn(receiptDescriptor, 'value'))
    )
      return response
    const question = {
      routeKey: own(input, 'routeKey'),
      destinationAddress: own(input, 'destinationAddress'),
      owner: own(input, 'owner'),
      assetsRaw: own(input, 'assetsRaw'),
      horizonHours: own(input, 'horizonHours'),
      ...(receiptDescriptor ? { receiptTokenId: receiptDescriptor.value } : {}),
    } as HolderExitAssessmentRequest
    if (
      question.routeKey !== APYUSD_ROUTE ||
      typeof question.destinationAddress !== 'string' ||
      question.destinationAddress.toLowerCase() !== APYUSD_VAULT ||
      typeof question.owner !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(question.owner) ||
      /^0x0{40}$/i.test(question.owner)
    )
      return response
    validateHolderExitAssessmentRequest(question)
    if (BigInt(question.assetsRaw) === 0n) return response
    const s = {
      chainId: own(agreedSource, 'chainId'),
      blockNumber: own(agreedSource, 'blockNumber'),
      blockHash: own(agreedSource, 'blockHash'),
      blockTime: own(agreedSource, 'blockTime'),
      finalized: own(agreedSource, 'finalized'),
    }
    if (
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      (s.blockNumber as number) <= 0 ||
      typeof s.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(s.blockHash) ||
      typeof s.blockTime !== 'string' ||
      !Number.isSafeInteger(Date.parse(s.blockTime)) ||
      new Date(s.blockTime).toISOString() !== s.blockTime
    )
      return response
    const source: ApyUsdJointNativeAcquisitionBinding['source'] = {
      chainId: 1,
      blockNumber: s.blockNumber as number,
      blockHash: s.blockHash.toLowerCase(),
      blockTime: s.blockTime,
      finalized: true,
    }
    const startMs = Date.now(),
      sourceMs = Date.parse(source.blockTime)
    if (startMs < sourceMs || startMs - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS) return response
    const binding: ApyUsdJointNativeAcquisitionBinding = {
      routeKey: question.routeKey,
      destination: APYUSD_VAULT,
      asset: APXUSD_ASSET,
      owner: question.owner.toLowerCase(),
      candidateReceiptIds: apyUsdJointNativeReceiptCandidateHints(
        question.owner.toLowerCase(),
        question.receiptTokenId,
      ),
      source,
      asOfMs: startMs,
    }
    const original = await acquireApyUsdJointNativeCurrent(binding)
    const fact = selectedOriginalApyUsdJointNativeCurrent(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (
      !original ||
      !fact ||
      original.fact !== fact ||
      fact.current.receiptInventory?.complete !== true
    )
      return response
    const finalized = await readApyUsdJointNativeHistoryAtIssue(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (!finalized) return response
    const issueMs = Date.parse(finalized.issuedAtUtc),
      nowMs = Date.now()
    const available = [
      original.evidence.binding.acquiredAtUtc,
      original.availableAtUtc,
      finalized.evidence.acquiredAtUtc,
      finalized.evidence.availableAtUtc,
    ].map((t) => Date.parse(t))
    if (
      !Number.isSafeInteger(issueMs) ||
      new Date(issueMs).toISOString() !== finalized.issuedAtUtc ||
      issueMs < startMs ||
      issueMs > nowMs ||
      nowMs < sourceMs ||
      nowMs - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS ||
      available.some((t) => !Number.isSafeInteger(t) || t > issueMs)
    )
      return response
    const issueBinding = { ...binding, asOfMs: issueMs }
    if (
      selectedOriginalApyUsdJointNativeCurrent(original, issueBinding) !== fact ||
      !selectedOriginalApyUsdJointNativeHistory(finalized, original, issueBinding)
    )
      return response
    return {
      ...response,
      apyUsdJointNativeCurrentEvidence: {
        ...original.evidence,
        availableAtUtc: original.availableAtUtc,
      },
      apyUsdJointHistoricalEvidence: finalized.evidence,
      apyUsdJointIssuedAtUtc: finalized.issuedAtUtc,
    }
  } catch {
    return response
  }
}

/** The required APY reader requests finalized and brackets the native block identity.
 * This joins actual independent SDK witnesses; the optional protected reader verifies them again. */
function agreedApyFinalizedSource(
  input: HolderExitAssessmentRequest,
  origins: readonly HolderExitOriginWitness[],
): ApyUsdJointNativeAcquisitionBinding['source'] | null {
  if (input.routeKey !== APYUSD_ROUTE || input.destinationAddress.toLowerCase() !== APYUSD_VAULT)
    return null
  const matches = (a: HolderExitAssessment) =>
    a.routeKey === input.routeKey &&
    a.destinationAddress.toLowerCase() === APYUSD_VAULT &&
    a.owner.toLowerCase() === input.owner.toLowerCase() &&
    a.request.assetsRaw === input.assetsRaw &&
    a.request.horizonHours === input.horizonHours &&
    a.request.assetAddress.toLowerCase() === APXUSD_ASSET &&
    a.source.chainId === 1
  for (let i = 0; i < origins.length; i++)
    for (let j = i + 1; j < origins.length; j++) {
      const a = origins[i],
        b = origins[j]
      if (a.host === b.host || !matches(a.assessment) || !matches(b.assessment)) continue
      const x = a.assessment.source,
        y = b.assessment.source
      if (
        x.blockNumber !== y.blockNumber ||
        x.blockHash.toLowerCase() !== y.blockHash.toLowerCase() ||
        x.blockTime !== y.blockTime
      )
        continue
      return {
        chainId: 1,
        blockNumber: x.blockNumber,
        blockHash: x.blockHash.toLowerCase(),
        blockTime: x.blockTime,
        finalized: true,
      }
    }
  return null
}

/** These source witnesses come from the required Umbrella reader, which requests
 * getBlock({blockTag:'finalized'}) and brackets that native identity. The optional
 * protected reader rechecks both finalized witnesses; a metadata flag alone is insufficient. */
function agreedUmbrellaFinalizedSource(
  input: HolderExitAssessmentRequest,
  origins: readonly HolderExitOriginWitness[],
): UmbrellaGhoNativeSource | null {
  if (
    input.routeKey !== UMBRELLA_GHO_ROUTE ||
    input.destinationAddress.toLowerCase() !== UMBRELLA_STKGHO
  )
    return null
  const matches = (a: HolderExitAssessment) =>
    a.routeKey === input.routeKey &&
    a.destinationAddress.toLowerCase() === UMBRELLA_STKGHO &&
    a.owner.toLowerCase() === input.owner.toLowerCase() &&
    a.request.assetsRaw === input.assetsRaw &&
    a.request.horizonHours === input.horizonHours &&
    a.request.assetAddress.toLowerCase() === ORIGINAL_GHO &&
    a.source.chainId === 1
  for (let i = 0; i < origins.length; i++)
    for (let j = i + 1; j < origins.length; j++) {
      const a = origins[i],
        b = origins[j]
      if (a.host === b.host || !matches(a.assessment) || !matches(b.assessment)) continue
      const x = a.assessment.source,
        y = b.assessment.source
      if (
        x.blockNumber !== y.blockNumber ||
        x.blockHash.toLowerCase() !== y.blockHash.toLowerCase() ||
        x.blockTime !== y.blockTime
      )
        continue
      return {
        chainId: 1,
        blockNumber: x.blockNumber,
        blockHash: x.blockHash.toLowerCase(),
        blockTime: x.blockTime,
        finalized: true,
      }
    }
  return null
}

/** Optional same-pool quote-funding context. Manual execution firstLegUsdcRaw is never R(Q). */
export async function withFluidUsdtBridgeJointHistoricalEvidence<T extends object>(
  input: HolderExitAssessmentRequest,
  response: T,
  agreedSource: FluidUsdtBridgeNativeCapacityBinding['source'] | null,
): Promise<
  T & {
    fluidUsdtBridgeJointCurrentEvidence?: FluidUsdtBridgeJointCurrentEvidence
    fluidUsdtBridgeJointHistoricalEvidence?: FluidUsdtBridgeJointHistoricalEvidence
    fluidUsdtBridgeJointIssuedAtUtc?: string
  }
> {
  try {
    const own = (v: unknown, key: string): unknown => {
      if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype)
        throw Error('fluid_usdt_optional_input')
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('fluid_usdt_optional_input')
      return d.value
    }
    const route = own(input, 'routeKey'),
      destination = own(input, 'destinationAddress'),
      owner = own(input, 'owner'),
      Q = own(input, 'assetsRaw'),
      H = own(input, 'horizonHours')
    const C = FLUID_USDT_QUOTE_CONTRACTS
    if (
      route !== FLUID_USDT_QUOTE_ROUTE ||
      typeof destination !== 'string' ||
      destination.toLowerCase() !== '0x273da948aca9261043fbdb2a857bc255ecc29012' ||
      typeof owner !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(owner) ||
      /^0x0{40}$/i.test(owner) ||
      typeof Q !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(Q) ||
      BigInt(Q) > (1n << 256n) - 1n ||
      !Number.isSafeInteger(H) ||
      (H as number) < 1 ||
      (H as number) > 8760
    )
      return response
    const s = {
      chainId: own(agreedSource, 'chainId'),
      blockNumber: own(agreedSource, 'blockNumber'),
      blockHash: own(agreedSource, 'blockHash'),
      blockTime: own(agreedSource, 'blockTime'),
      finalized: own(agreedSource, 'finalized'),
    }
    if (
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      (s.blockNumber as number) < 1 ||
      typeof s.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(s.blockHash) ||
      typeof s.blockTime !== 'string' ||
      !Number.isSafeInteger(Date.parse(s.blockTime)) ||
      new Date(s.blockTime).toISOString() !== s.blockTime
    )
      return response
    const source: FluidUsdtBridgeNativeCapacityBinding['source'] = {
      chainId: 1,
      blockNumber: s.blockNumber as number,
      blockHash: s.blockHash.toLowerCase(),
      blockTime: s.blockTime,
      finalized: true,
    }
    const start = Date.now(),
      sourceMs = Date.parse(source.blockTime)
    if (start < sourceMs || start - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS) return response
    const binding: FluidUsdtBridgeNativeCapacityBinding = {
      owner: owner.toLowerCase(),
      requestedFinalUsdtRaw: Q,
      source,
      asOfMs: start,
    }
    const original = await acquireFluidUsdtBridgeNativeCapacity(binding)
    const fact = selectedOriginalFluidUsdtBridgeNativeCapacity(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (!original || !fact || original.fact !== fact) return response
    const finalized = await readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(original, {
      ...binding,
      asOfMs: Date.now(),
    })
    if (!finalized) return response
    const issue = Date.parse(finalized.issuedAtUtc),
      now = Date.now()
    if (
      !Number.isSafeInteger(issue) ||
      new Date(issue).toISOString() !== finalized.issuedAtUtc ||
      issue < start ||
      issue > now ||
      now - sourceMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS ||
      [
        fact.acquiredAtUtc,
        fact.availableAtUtc,
        finalized.evidence.acquiredAtUtc,
        finalized.evidence.availableAtUtc,
      ].some((t) => !Number.isSafeInteger(Date.parse(t)) || Date.parse(t) > issue)
    )
      return response
    const atIssue = { ...binding, asOfMs: issue }
    if (
      selectedOriginalFluidUsdtBridgeNativeCapacity(original, atIssue) !== fact ||
      selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(finalized, original, atIssue) !==
        finalized.evidence.points
    )
      return response
    // Only selected original facts are projected. No raw transport, sink metadata or private capability leaves the server.
    const currentEvidence: FluidUsdtBridgeJointCurrentEvidence = {
      schema: 'fluid_usdt_bridge_joint_current_evidence_v1',
      source: { ...fact.source },
      current: {
        source: {
          chainId: 1,
          blockNumber: String(fact.source.blockNumber),
          blockHash: fact.source.blockHash,
          blockTime: fact.source.blockTime,
        },
        readAtUtc: fact.readAtUtc,
        acquiredAtUtc: fact.acquiredAtUtc,
        availableAtUtc: fact.availableAtUtc,
        provenanceRef: 'protected_native_current_same_pool_quote_funding',
        profileId: fact.profileId,
        holderSharesRaw: fact.sharesRaw,
        shareDecimals: 18,
        fullHolderNetUsdcRaw: fact.fullNetEaRaw,
        nativeProngs: { ...fact.nativeProngs },
        withdrawalFeeBps: fact.withdrawalFeeBps,
        paused: fact.paused,
        runtimeCodeHashes: { ...fact.runtimeCodeHashes },
        sourceClass: 'captured_identical_runtimes_only',
        owner: fact.owner,
        historicalOwnership: false,
        provenanceKind: 'native_current_full_position',
        conversion: {
          factory: C.factory,
          quoter: C.quoter,
          pool: C.pool,
          fee: 100,
          method: 'quoteExactOutputSingle',
          inputAsset: C.usdc,
          inputDecimals: 6,
          outputAsset: C.usdt,
          outputDecimals: 6,
          fixedFinalUsdtOutputRaw: fact.requestedFinalUsdtRaw,
          requiredNetUsdcRaw: fact.requiredNetUsdcRaw,
        },
      },
      roundtripUsdtRaw: fact.roundtripUsdtRaw,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
      sourceImplementationEquivalence: false,
      noUSDTCapacityAmountBand: true,
      noLinearScaling: true,
      combinedBridgeUSDTExecutionRoute: 'unassessed',
      MRaw: null,
    }
    return {
      ...response,
      fluidUsdtBridgeJointCurrentEvidence: currentEvidence,
      fluidUsdtBridgeJointHistoricalEvidence: finalized.evidence,
      fluidUsdtBridgeJointIssuedAtUtc: finalized.issuedAtUtc,
    }
  } catch {
    return response
  }
}

/** Required USDT first-leg SDK reads use native finalized and bracket its identity
 * (trackedDirectVaultExit). The optional protected reader verifies both witnesses again. */
function agreedFluidUsdtFinalizedSource(
  input: HolderExitAssessmentRequest,
  origins: readonly HolderExitOriginWitness[],
): FluidUsdtBridgeNativeCapacityBinding['source'] | null {
  if (
    input.routeKey !== FLUID_USDT_QUOTE_ROUTE ||
    input.destinationAddress.toLowerCase() !== '0x273da948aca9261043fbdb2a857bc255ecc29012'
  )
    return null
  const matches = (a: HolderExitAssessment) =>
    a.routeKey === input.routeKey &&
    a.destinationAddress.toLowerCase() === input.destinationAddress.toLowerCase() &&
    a.owner.toLowerCase() === input.owner.toLowerCase() &&
    a.request.assetsRaw === input.assetsRaw &&
    a.request.horizonHours === input.horizonHours &&
    a.request.assetAddress.toLowerCase() === FLUID_USDT_QUOTE_CONTRACTS.usdt &&
    a.source.chainId === 1
  for (let i = 0; i < origins.length; i++)
    for (let j = i + 1; j < origins.length; j++) {
      const a = origins[i],
        b = origins[j]
      if (a.host === b.host || !matches(a.assessment) || !matches(b.assessment)) continue
      const x = a.assessment.source,
        y = b.assessment.source
      if (
        x.blockNumber !== y.blockNumber ||
        x.blockHash.toLowerCase() !== y.blockHash.toLowerCase() ||
        x.blockTime !== y.blockTime
      )
        continue
      return {
        chainId: 1,
        blockNumber: x.blockNumber,
        blockHash: x.blockHash.toLowerCase(),
        blockTime: x.blockTime,
        finalized: true,
      }
    }
  return null
}

/** Optional idle observations require the exact independent required-read pair.
 * Failures leave the required assessment response intact. No startup or later work is scheduled. */
export async function withMorphoV2IdleHolderForecastEvidence<
  T extends { capacityAgreement?: HolderExitCapacityAgreement; executionAgreement?: unknown },
>(
  input: HolderExitAssessmentRequest,
  response: T,
  context: MorphoV2IdleRequiredReadContext | null = null,
): Promise<T & { morphoV2IdleHolderForecastEvidence?: string; morphoV2IdleJointIssuedAtUtc?: string }> {
  const capacity = response.capacityAgreement
  if (!capacity || !context) return response
  try {
    const profile = resolveMorphoV2IdleTrustedProfile(
      input.routeKey,
      input.destinationAddress.toLowerCase(),
      capacity.quote.asset,
    )
    if (!profile || !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours <= 0 || input.horizonHours > 168) return response
    const request: MorphoV2IdleHolderRequest = {
      routeKey: input.routeKey,
      destination: input.destinationAddress.toLowerCase(),
      owner: input.owner.toLowerCase(),
      requestedRaw: input.assetsRaw,
      asset: capacity.quote.asset,
      assetDecimals: capacity.quote.assetDecimals,
      source: { ...capacity.quote.source },
    }
    const execution = response.executionAgreement === undefined
      ? {}
      : { executionAgreement: response.executionAgreement }
    const agreement = requiredMorphoV2IdleHolderQuote(
      profile, request, capacity, Date.now(), response.executionAgreement,
    )
    if (!agreement) return response
    const fromRequiredRead = (origin: HolderExitCapacityAgreement['origins'][number]) => {
      const matches = context.witnesses.filter((witness) =>
        witness.host === origin.host &&
        isDeepStrictEqual(witness.assessment.capacityQuote, origin.quote),
      )
      if (matches.length !== 1) throw Error('idle_required_provider_identity')
      const selectedUrl = context.selectedUrls.get(matches[0].client)
      if (!selectedUrl) throw Error('idle_required_provider_missing')
      const nativeOrigin = createMorphoV2IdleNativeOrigin(selectedUrl)
      if (nativeOrigin.host !== origin.host) throw Error('idle_required_provider_host')
      return nativeOrigin
    }
    // Selection can clear unmatched successful-Q bounds. Validated raw quotes identify the required clients.
    const origins = [
      fromRequiredRead(capacity.origins[0]),
      fromRequiredRead(capacity.origins[1]),
    ] as const
    const panel = await loadMorphoV2IdleCompactPanel(profile)
    if (panel) {
      const nativeRead = await readMorphoV2IdleNativePanelHolder({
        profile, panel, request, capacityAgreement: agreement, origins, ...execution,
      })
      if (!nativeRead) return response
      const issueInput = {
        profile, panel, nativeRead, request, capacityAgreement: agreement,
        horizonHours: input.horizonHours, ...execution,
      }
      const issued = issueMorphoV2IdlePanelHolderForecast(issueInput)
      const finalizedAtMs = Date.now()
      if (!issued || !selectedMorphoV2IdleServerPanelHolderForecastIssue(issued, issueInput, finalizedAtMs))
        return response
      return {
        ...response,
        morphoV2IdleHolderForecastEvidence: issued.evidenceText,
        morphoV2IdleJointIssuedAtUtc: new Date(finalizedAtMs).toISOString(),
      }
    }
    const history = await loadMorphoV2IdleHistory(profile)
    const nativeRead = await readMorphoV2IdleNativeHolder({
      profile, history, request, capacityAgreement: agreement, origins, ...execution,
    })
    if (!nativeRead) return response
    const issueInput = {
      profile, history, nativeRead, request, capacityAgreement: agreement,
      horizonHours: input.horizonHours, ...execution,
    }
    const issued = issueMorphoV2IdleHolderForecast(issueInput)
    if (!issued) return response
    const finalizedAtMs = Date.now()
    if (!selectedMorphoV2IdleServerHolderForecastIssue(issued, issueInput, finalizedAtMs))
      return response
    return {
      ...response,
      morphoV2IdleHolderForecastEvidence: issued.evidenceText,
      morphoV2IdleJointIssuedAtUtc: new Date(finalizedAtMs).toISOString(),
    }
  } catch {
    return response
  }
}

async function withJointHistoricalEvidence<
  T extends { capacityAgreement?: HolderExitCapacityAgreement; executionAgreement?: unknown },
>(
  input: HolderExitAssessmentRequest,
  response: T,
  umbrellaSource: UmbrellaGhoNativeSource | null = null,
  apySource: ApyUsdJointNativeAcquisitionBinding['source'] | null = null,
  fluidUsdtSource: FluidUsdtBridgeNativeCapacityBinding['source'] | null = null,
  idleContext: MorphoV2IdleRequiredReadContext | null = null,
) {
  const finalized = await withFluidUsdcBridgeJointHistoricalEvidence(
    input,
    await withUsd3JointHistoricalEvidence(input, response),
  )
  const completed = await withFluidUsdtBridgeJointHistoricalEvidence(
    input,
    await withApyUsdJointHistoricalEvidence(
      input,
      await withUmbrellaGhoJointHistoricalEvidence(input, finalized, umbrellaSource),
      apySource,
    ),
    fluidUsdtSource,
  )
  const result = await withMorphoV2IdleHolderForecastEvidence(input, completed, idleContext)
  return withSaturnAppForecastEvidence(input, result, idleContext?.witnesses ?? [])
}
export async function withSaturnAppForecastEvidence<T>(input: HolderExitAssessmentRequest,
  result: T, context: readonly HolderExitOriginWitness[]) {
  if (input.routeKey !== 'AUSD → Staked USDat [USDat]' || context.length !== 2) return result
  const [first, second] = context
  if (!isSaturnNativeClient(first.client) || !isSaturnNativeClient(second.client)) return result
  const envelope = await acquireSaturnAppForecast(input, [
    { ...first, client: first.client }, { ...second, client: second.client },
  ])
  return envelope && selectedSaturnServerForecastEnvelope(envelope)
    ? { ...result, saturnHolderForecastEvidence: envelope } : result
}
const freshReference = (reference: HolderExitForecastSourceReference, nowMs: number) => {
  const ageMs = nowMs - Date.parse(reference.blockTime)
  return Number.isSafeInteger(nowMs) && ageMs >= -120000 && ageMs <= MAX_CURRENT_EXIT_BLOCK_AGE_MS
}

/** Server-only optional producer, after the required native executor's identity/EOA checks. */
function susdeProtocolExpected(assessment: HolderExitAssessment): SusdeProtocolExpected | null {
  const facts = assessment.susdeHolderFacts,
    condition = assessment.cooldownCondition,
    initiationStage = assessment.stages.find((stage) => stage.name === 'cooldown_initiation'),
    pendingStage = assessment.stages.find((stage) => stage.name === 'pending_claim')
  if (
    assessment.routeKey !== 'USDe → Staked USDe [USDe]' ||
    assessment.destinationAddress.toLowerCase() !== '0x9d39a5de30e57443bff2a8307a4256c8797a3497' ||
    assessment.request.assetAddress.toLowerCase() !==
      '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' ||
    !facts ||
    facts.activeEntitlementRaw === null ||
    !condition ||
    assessment.source.chainId !== 1 ||
    facts.source.chainId !== 1 ||
    facts.source.vaultAddress.toLowerCase() !== assessment.destinationAddress.toLowerCase() ||
    facts.source.assetAddress.toLowerCase() !== assessment.request.assetAddress.toLowerCase() ||
    facts.owner.toLowerCase() !== assessment.owner.toLowerCase() ||
    facts.source.blockNumber !== assessment.source.blockNumber ||
    facts.source.blockHash.toLowerCase() !== assessment.source.blockHash.toLowerCase() ||
    facts.source.blockTime !== assessment.source.blockTime ||
    facts.pendingAssetsRaw !== condition.pendingAssetsRaw ||
    facts.cooldownDurationSeconds !== String(condition.durationSeconds) ||
    (condition.durationSeconds > 0 &&
      facts.pendingAssetsRaw !== '0' &&
      condition.pendingClaimEarliestAt !==
        new Date(Number(facts.storedCooldownEndUnix) * 1000).toISOString()) ||
    (condition.initiationStatus === 'success' &&
      (initiationStage?.status !== 'simulated' ||
        initiationStage.amountRaw !== assessment.request.assetsRaw ||
        initiationStage.relatedToRequest !== true ||
        initiationStage.assetAddress.toLowerCase() !==
          assessment.request.assetAddress.toLowerCase())) ||
    !pendingStage ||
    pendingStage.amountRaw !== facts.pendingAssetsRaw ||
    pendingStage.relatedToRequest !== false
  )
    return null
  return {
    owner: assessment.owner.toLowerCase(),
    requestedRaw: assessment.request.assetsRaw,
    source: {
      chainId: 1,
      blockNumber: String(assessment.source.blockNumber),
      blockHash: assessment.source.blockHash.toLowerCase(),
      blockTime: assessment.source.blockTime,
      finalized: true,
    },
    activeSharesRaw: facts.activeSharesRaw,
    activeEntitlementRaw: facts.activeEntitlementRaw,
    maxWithdrawRaw:
      (condition.durationSeconds > 0
        ? facts.maxInitiationAssetsRaw
        : facts.maxDirectWithdrawalAssetsRaw) ?? '',
    pendingAssetsRaw: facts.pendingAssetsRaw,
    storedCooldownEndUnix: facts.storedCooldownEndUnix,
    cooldownDurationSeconds: facts.cooldownDurationSeconds,
    initiationStatus: condition.initiationStatus,
    pendingClaimStatus: condition.pendingClaimStatus,
  }
}

async function captureSusdeProtocolPair(
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
): Promise<readonly [HolderExitOriginWitness, HolderExitOriginWitness]> {
  try {
    const a = susdeProtocolExpected(first.assessment),
      b = susdeProtocolExpected(second.assessment)
    if (
      !a ||
      !b ||
      first.host === second.host ||
      !isDeepStrictEqual(a, b) ||
      !sameHolderExitAssessment(first.assessment, second.assessment)
    )
      return [first, second]
    if (Date.parse(a.source.blockTime) + 30 * 60 * 1000 - Date.now() <= 16000)
      return [first, second]
    const oa = await readSusdeCurrentProtocolOrigin(
      first.client as unknown as SusdeProtocolRequestClient,
      a,
    )
    if (!oa) return [first, second]
    const ob = await readSusdeCurrentProtocolOrigin(
      second.client as unknown as SusdeProtocolRequestClient,
      b,
    )
    return [
      { ...first, assessment: { ...first.assessment, susdeProtocolCapacityObservation: oa } },
      { ...second, assessment: { ...second.assessment, susdeProtocolCapacityObservation: ob } },
    ]
  } catch {
    return [first, second]
  }
}

function agreedSusdeProtocolEvidence(
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
) {
  try {
    const a = susdeProtocolExpected(first.assessment),
      b = susdeProtocolExpected(second.assessment),
      oa = first.assessment.susdeProtocolCapacityObservation,
      ob = second.assessment.susdeProtocolCapacityObservation
    if (!a || !b || !oa || !ob || !isDeepStrictEqual(a, b) || first.host === second.host)
      return null
    const origins = [
        { origin: first.host, observation: oa },
        { origin: second.host, observation: ob },
      ],
      issueAtMs = Date.now()
    try {
      const issued = issueSusdeHolderForecastV2FromNativeOrigins(origins, a, issueAtMs)
      if (issued) return issued
    } catch {
      // Forecast construction is optional; retain the already captured native witness.
    }
    const evidence = issueSusdeCurrentProtocolCapacityEvidence(origins, a, issueAtMs)
    return evidence ? { evidence, envelope: null } : null
  } catch {
    return null
  }
}

async function withMorphoV2ProtocolObservation(
  client: Parameters<typeof readHolderExitAssessment>[0]['morpho'],
  assessment: HolderExitAssessment,
): Promise<HolderExitAssessment> {
  const profile = resolveMorphoV2TrustedProfile(
    assessment.routeKey,
    assessment.destinationAddress,
    assessment.request.assetAddress,
  )
  // Reserve both sequential optional origins' eight-second bounds. The existing
  // response-time freshness gate still rejects an actually expired base source.
  const sourceHeadroomMs =
    Date.parse(assessment.source.blockTime) + MAX_CURRENT_EXIT_BLOCK_AGE_MS - Date.now()
  if (
    !Number.isSafeInteger(sourceHeadroomMs) ||
    sourceHeadroomMs <= 16_000 ||
    !profile ||
    !assessment.capacityQuote ||
    assessment.capacityQuote.assetDecimals !== profile.subject.assetDecimals ||
    assessment.capacityQuote.entitlementRaw === null ||
    assessment.source.chainId !== 1
  )
    return assessment
  try {
    // The required Morpho executor independently selects its actual finalized
    // header and verifies any reference pin's canonical height, hash and time.
    const observation = await readMorphoV2CurrentProtocolOrigin(
      // The native plan validates exact public methods/parameters; viem's generic
      // request schema is narrower than that raw wire type. Keep the same client.
      client as unknown as MorphoV2ProtocolRequestClient,
      {
        chainId: 1,
        blockNumber: assessment.source.blockNumber,
        blockHash: assessment.source.blockHash.toLowerCase(),
        blockTime: assessment.source.blockTime,
        finalized: true,
      },
      { deadlineMs: 8_000, profile },
    )
    return { ...assessment, morphoV2ProtocolCapacityObservation: observation }
  } catch {
    return { ...assessment, morphoV2ProtocolCapacityObservation: null }
  }
}

/** Issued only from the native configured-provider boundary; raw optional facts have their own agreement. */
function agreedStusdsProtocolEvidence(
  first: { host: string; assessment: HolderExitAssessment },
  second: { host: string; assessment: HolderExitAssessment },
) {
  try {
    const a = first.assessment,
      b = second.assessment
    if (
      a.routeKey !== 'USDS → StUsds [USDS]' ||
      a.destinationAddress.toLowerCase() !== '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9' ||
      b.routeKey !== a.routeKey ||
      b.destinationAddress.toLowerCase() !== a.destinationAddress.toLowerCase() ||
      a.owner !== b.owner ||
      a.request.assetsRaw !== b.request.assetsRaw ||
      a.source.chainId !== 1 ||
      b.source.chainId !== 1 ||
      a.source.blockNumber !== b.source.blockNumber ||
      a.source.blockHash.toLowerCase() !== b.source.blockHash.toLowerCase() ||
      a.source.blockTime !== b.source.blockTime ||
      !a.stusdsProtocolCapacityObservation ||
      !b.stusdsProtocolCapacityObservation
    )
      return null
    const source = {
      chainId: 1 as const,
      blockNumber: a.source.blockNumber,
      blockHash: a.source.blockHash.toLowerCase(),
      blockTime: a.source.blockTime,
      finalized: true as const,
    }
    const record = {
      origins: [
        { host: first.host, observation: a.stusdsProtocolCapacityObservation },
        { host: second.host, observation: b.stusdsProtocolCapacityObservation },
      ],
    }
    if (JSON.stringify(record).length > 1500000) return null
    const approved = replayStusdsCurrentProtocolCapacityEvidence(
      record,
      { source, asOfMs: Date.now(), originHosts: [first.host, second.host] },
      (text) => createHash('sha256').update(text).digest('hex'),
    )
    return approved
      ? encodeStusdsProtocolEvidence(
          record,
          { source, asOfMs: Date.now(), originHosts: [first.host, second.host] },
          (text) => createHash('sha256').update(text).digest('hex'),
        )
      : null
  } catch {
    return null
  }
}

/** Native bytes are bound to an independently agreed holder E and required quote source. */
function agreedMorphoV2ProtocolCapacity(
  first: { host: string; assessment: HolderExitAssessment },
  second: { host: string; assessment: HolderExitAssessment },
) {
  try {
    const a = first.assessment,
      b = second.assessment,
      asOfMs = Date.now()
    const capacity = agreeHolderExitCapacityQuotes(
      { host: first.host, quote: a.capacityQuote },
      { host: second.host, quote: b.capacityQuote },
      asOfMs,
    )
    if (
      !capacity ||
      capacity.quote.entitlementRaw === null ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      !resolveMorphoV2TrustedProfile(a.routeKey, a.destinationAddress, a.request.assetAddress)
    )
      return null
    const quote = capacity.quote
    const profile = resolveMorphoV2TrustedProfile(quote.routeKey, quote.destination, quote.asset)
    if (!profile) return null
    const bound = (assessment: HolderExitAssessment) =>
      assessment.routeKey === quote.routeKey &&
      assessment.destinationAddress.toLowerCase() === quote.destination &&
      assessment.owner.toLowerCase() === quote.owner &&
      assessment.request.assetsRaw === quote.requestedRaw &&
      assessment.request.assetAddress.toLowerCase() === profile.subject.asset &&
      quote.asset === profile.subject.asset &&
      quote.assetDecimals === profile.subject.assetDecimals &&
      assessment.source.chainId === 1 &&
      assessment.source.blockNumber === quote.source.blockNumber &&
      assessment.source.blockHash.toLowerCase() === quote.source.blockHash &&
      assessment.source.blockTime === quote.source.blockTime
    if (!bound(a) || !bound(b)) return null
    return capacity
  } catch {
    return null
  }
}

/** No optional await can change the finalized source selected by the next required origin. */
async function captureMorphoV2ProtocolPair(
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
  input: HolderExitAssessmentRequest,
): Promise<[HolderExitOriginWitness, HolderExitOriginWitness]> {
  if (!agreedMorphoV2ProtocolCapacity(first, second)) return [first, second]
  const observedFirst = {
    ...first,
    assessment: await withMorphoV2ProtocolObservation(first.client, first.assessment),
  }
  // A cold or failed first origin cannot yield a protocol pair. No later optional
  // RPC is scheduled merely because history prewarm eventually completes.
  if (!observedFirst.assessment.morphoV2ProtocolCapacityObservation) return [observedFirst, second]
  const observedSecond = {
    ...second,
    assessment: await withMorphoV2ProtocolObservation(second.client, second.assessment),
  }
  return captureMorphoV2HistoricalHolderEaPair(observedFirst, observedSecond, input)
}

function agreedMorphoV2ProtocolEvidence(
  first: { host: string; assessment: HolderExitAssessment },
  second: { host: string; assessment: HolderExitAssessment },
) {
  try {
    const capacity = agreedMorphoV2ProtocolCapacity(first, second),
      a = first.assessment,
      b = second.assessment
    if (
      !capacity ||
      !a.morphoV2ProtocolCapacityObservation ||
      !b.morphoV2ProtocolCapacityObservation
    )
      return null
    // Both required native executors independently established this source under
    // their actual finalized header, including canonical historical references.
    const expected = {
      source: { ...capacity.quote.source },
      asOfMs: Date.now(),
      originHosts: [first.host, second.host],
      profile: resolveMorphoV2TrustedProfile(
        capacity.quote.routeKey,
        capacity.quote.destination,
        capacity.quote.asset,
      )!,
    }
    const record = {
      origins: [
        { host: first.host, observation: a.morphoV2ProtocolCapacityObservation },
        { host: second.host, observation: b.morphoV2ProtocolCapacityObservation },
      ],
    }
    const sha256Text = (text: string) => createHash('sha256').update(text).digest('hex')
    // The codec independently replays the raw pair before issuing compact bytes.
    return encodeMorphoV2ProtocolEvidencePair(record, expected, sha256Text)
  } catch {
    return null
  }
}

/** Optional transport only: reviewed profiles and the independent quote bind every byte. */
function agreedMorphoV2HolderPositionEvidence(
  input: HolderExitAssessmentRequest,
  first: { host: string; assessment: HolderExitAssessment },
  second: { host: string; assessment: HolderExitAssessment },
) {
  try {
    const capacity = agreedMorphoV2ProtocolCapacity(first, second)
    if (!capacity) return null
    const quote = capacity.quote,
      position = quote.sourceHolderPosition,
      profile = resolveMorphoV2TrustedProfile(quote.routeKey, quote.destination, quote.asset),
      a = first.assessment.morphoHolderPositionObservation,
      b = second.assessment.morphoHolderPositionObservation
    if (
      !profile ||
      !position ||
      !a ||
      !b ||
      position.method !== 'balance_of_owner_at_source' ||
      quote.owner !== input.owner.toLowerCase() ||
      quote.routeKey !== input.routeKey ||
      quote.destination !== input.destinationAddress.toLowerCase() ||
      quote.assetDecimals !== profile.subject.assetDecimals ||
      position.shareDecimals !== profile.subject.shareDecimals ||
      quote.entitlementRaw === null
    )
      return null
    const expected: MorphoV2HolderPositionExpectation = {
      routeKey: profile.subject.routeKey,
      destination: profile.subject.destination as Address,
      owner: input.owner.toLowerCase() as Address,
      asset: profile.subject.asset as Address,
      assetDecimals: profile.subject.assetDecimals,
      shareDecimals: profile.subject.shareDecimals,
      source: {
        ...quote.source,
        blockHash: quote.source.blockHash as `0x${string}`,
        blockTime: new Date(quote.source.blockTime).toISOString(),
      },
      sharesRaw: position.sharesRaw,
      fullEaRaw: quote.entitlementRaw,
      originHosts: [first.host, second.host],
      asOfMs: Date.now(),
    }
    const pair: MorphoV2HolderPositionEvidence = {
      schemaVersion: 1,
      kind: 'morpho_v2_holder_position_pair_v1',
      origins: [
        { host: first.host, observation: a },
        { host: second.host, observation: b },
      ],
    }
    // Protocol transport, when present, is independently issued against this same
    // agreed quote source by agreedMorphoV2ProtocolEvidence. No extra RPC is needed.
    approveMorphoV2HolderPositionEvidence(pair, expected)
    return encodeMorphoV2HolderPositionEvidence(pair)
  } catch {
    return null
  }
}

/** Historical reads use the independently agreed full S, never requested Q. */
async function captureMorphoV2HistoricalHolderEaPair(
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
  input: HolderExitAssessmentRequest,
): Promise<[HolderExitOriginWitness, HolderExitOriginWitness]> {
  const capacity = agreedMorphoV2ProtocolCapacity(first, second)
  if (
    !capacity ||
    !agreedMorphoV2ProtocolEvidence(first, second) ||
    !agreedMorphoV2HolderPositionEvidence(input, first, second)
  )
    return [first, second]
  const quote = capacity.quote,
    profile = resolveMorphoV2TrustedProfile(quote.routeKey, quote.destination, quote.asset),
    sharesRaw = quote.sourceHolderPosition?.sharesRaw,
    source = { ...quote.source, blockHash: quote.source.blockHash as `0x${string}` }
  if (
    !profile ||
    !sharesRaw ||
    sharesRaw === '0' ||
    Date.parse(source.blockTime) + MAX_CURRENT_EXIT_BLOCK_AGE_MS - Date.now() <= 24_000
  )
    return [first, second]
  try {
    const a = await readMorphoV2HistoricalHolderEaOrigin(
      first.client as unknown as MorphoV2ProtocolRequestClient,
      source,
      { profile, sharesRaw, deadlineMs: 12_000 },
    )
    if (!a) return [first, second]
    const b = await readMorphoV2HistoricalHolderEaOrigin(
      second.client as unknown as MorphoV2ProtocolRequestClient,
      source,
      { profile, sharesRaw, deadlineMs: 12_000 },
    )
    return [
      { ...first, morphoV2HistoricalHolderEaObservation: a },
      { ...second, morphoV2HistoricalHolderEaObservation: b },
    ]
  } catch {
    return [first, second]
  }
}

function agreedMorphoV2HistoricalHolderEaEvidence(
  input: HolderExitAssessmentRequest,
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
) {
  try {
    const capacity = agreedMorphoV2ProtocolCapacity(first, second),
      a = first.morphoV2HistoricalHolderEaObservation,
      b = second.morphoV2HistoricalHolderEaObservation
    if (
      !capacity ||
      !a ||
      !b ||
      !agreedMorphoV2ProtocolEvidence(first, second) ||
      !agreedMorphoV2HolderPositionEvidence(input, first, second)
    )
      return null
    const quote = capacity.quote,
      profile = resolveMorphoV2TrustedProfile(quote.routeKey, quote.destination, quote.asset),
      sharesRaw = quote.sourceHolderPosition?.sharesRaw
    if (!profile || !sharesRaw) return null
    return encodeMorphoV2HistoricalHolderEaEvidencePair(
      {
        schemaVersion: 1,
        kind: 'morpho_v2_historical_holder_ea_pair_v1',
        origins: [
          { host: first.host, observation: a },
          { host: second.host, observation: b },
        ],
      },
      {
        profile,
        currentSource: { ...quote.source, blockHash: quote.source.blockHash as `0x${string}` },
        sharesRaw,
        originHosts: [first.host, second.host],
        asOfMs: Date.now(),
      },
    )
  } catch {
    return null
  }
}

/** Derived only from the two actual agreeing executor results, never a single-view adapter. */
function agreedExecutionResponse(
  input: HolderExitAssessmentRequest,
  first: HolderExitOriginWitness,
  second: HolderExitOriginWitness,
): HolderExitAssessmentApiView {
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: first.host, quote: first.assessment.capacityQuote },
    { host: second.host, quote: second.assessment.capacityQuote },
    Date.now(),
  )
  const cometFactsAgreement = agreeCometWithdrawFacts(
    { host: first.host, facts: first.assessment.cometFacts },
    { host: second.host, facts: second.assessment.cometFacts },
    Date.now(),
  )
  const stusdsCurrentProtocolCapacityEvidence = agreedStusdsProtocolEvidence(first, second)
  const morphoV2CurrentProtocolCapacityEvidence = agreedMorphoV2ProtocolEvidence(first, second)
  const morphoV2CurrentHolderPositionEvidence = agreedMorphoV2HolderPositionEvidence(
    input,
    first,
    second,
  )
  const morphoV2HistoricalHolderEaEvidence = agreedMorphoV2HistoricalHolderEaEvidence(
    input,
    first,
    second,
  )
  const susdeIssuance = agreedSusdeProtocolEvidence(
    first as HolderExitOriginWitness,
    second as HolderExitOriginWitness,
  )
  const response: HolderExitAssessmentApiView = {
    ...holderExitAssessmentResponse(
      withAgreedSusdeOptionalFacts(
        withAgreedApyUsdOptionalFacts(first.assessment, second.assessment),
        first.assessment,
      ),
    ),
    ...(capacityAgreement ? { capacityAgreement } : {}),
    ...(cometFactsAgreement ? { cometFactsAgreement } : {}),
    ...(stusdsCurrentProtocolCapacityEvidence ? { stusdsCurrentProtocolCapacityEvidence } : {}),
    ...(morphoV2CurrentProtocolCapacityEvidence ? { morphoV2CurrentProtocolCapacityEvidence } : {}),
    ...(morphoV2CurrentHolderPositionEvidence ? { morphoV2CurrentHolderPositionEvidence } : {}),
    ...(morphoV2HistoricalHolderEaEvidence ? { morphoV2HistoricalHolderEaEvidence } : {}),
    ...(susdeIssuance ? { susdeCurrentProtocolCapacityEvidence: susdeIssuance.evidence } : {}),
    ...(susdeIssuance?.envelope ? { susdeHolderForecastEnvelope: susdeIssuance.envelope } : {}),
  }
  const subject = resolveIssuedHolderExitSubject(input.routeKey, input.destinationAddress)
  if (
    !subject?.canonicalFinalAsset ||
    subject.mechanism !== 'atomic' ||
    subject.stages.length !== 1 ||
    subject.stages[0] !== 'atomic_exit'
  )
    return response
  const asset = subject.canonicalFinalAsset.address
  const decimals = subject.canonicalFinalAsset.decimals
  const matches = (a: HolderExitAssessment) =>
    typeof input.assetsRaw === 'string' &&
    /^(0|[1-9][0-9]{0,77})$/.test(input.assetsRaw) &&
    BigInt(input.assetsRaw) > 0n &&
    BigInt(input.assetsRaw) < 1n << 256n &&
    a.status === 'assessed' &&
    a.routeKey === input.routeKey &&
    a.destinationAddress.toLowerCase() === input.destinationAddress.toLowerCase() &&
    a.owner.toLowerCase() === input.owner.toLowerCase() &&
    a.request.assetsRaw === input.assetsRaw &&
    a.request.horizonHours === input.horizonHours &&
    a.request.assetAddress.toLowerCase() === asset &&
    a.finalPayout.status === 'simulated' &&
    a.finalPayout.amountRaw === input.assetsRaw &&
    a.finalPayout.assetAddress.toLowerCase() === asset &&
    a.stages.length === 1 &&
    a.stages[0].name === 'withdrawal' &&
    a.stages[0].status === 'simulated' &&
    a.stages[0].relatedToRequest === true &&
    a.stages[0].amountRaw === input.assetsRaw &&
    a.stages[0].assetAddress?.toLowerCase() === asset &&
    a.source.chainId === 1 &&
    Number.isSafeInteger(a.source.blockNumber) &&
    a.source.blockNumber > 0 &&
    typeof a.source.blockHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(a.source.blockHash) &&
    typeof a.source.blockTime === 'string' &&
    Number.isSafeInteger(Date.parse(a.source.blockTime)) &&
    new Date(Date.parse(a.source.blockTime)).toISOString() === a.source.blockTime &&
    isCurrentHolderExitAssessment(a, Date.now())
  try {
    if (first.host === second.host || !matches(first.assessment) || !matches(second.assessment))
      return response
    const question = {
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      owner: input.owner,
      finalAssetAddress: asset,
      finalAssetDecimals: decimals,
      assetsRaw: input.assetsRaw,
    }
    const executionAgreement: HolderExitConditionalProjectionEvidence = {
      question,
      routeAndContractIdentityVerified: true,
      inputAndFinalAssetAddressesVerified: true,
      simulations: [first, second].map(({ host, assessment }) => ({
        question: { ...question },
        originHost: host,
        source: {
          chainId: 1,
          blockNumber: assessment.source.blockNumber,
          blockHash: assessment.source.blockHash,
          blockTime: assessment.source.blockTime,
          finalized: true,
        },
        kind: 'full_route_execution',
        execution: 'single_call',
        fullRouteExecutionVerified: true,
        requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
        finalAssetAmountRaw: input.assetsRaw,
        status: 'simulated',
      })),
    }
    if (
      assessHolderExitConditionalProjection(subject, executionAgreement).tier !==
      'conditional_projection'
    )
      return response
    return { ...response, executionAgreement }
  } catch {
    return response
  }
}

/** Attach only server-computed facts to the agreed assessment, at response time. */
export function holderExitAssessmentResponse(
  assessment: HolderExitAssessment,
  nowMs = Date.now(),
): HolderExitAssessmentView {
  const {
    stusdsProtocolCapacityObservation: _privateProtocolObservation,
    morphoV2ProtocolCapacityObservation: _privateMorphoProtocolObservation,
    morphoHolderPositionObservation: _privateMorphoHolderObservation,
    susdeProtocolCapacityObservation: _privateSusdeProtocolObservation,
    ...publicAssessment
  } = assessment
  const verified: HolderExitAssessment = {
    ...publicAssessment,
    source: { ...assessment.source, originValidation: 'two_provider' },
  }
  try {
    const horizonSeconds = verified.request.horizonHours * 3600
    const outlook = projectHolderExitMechanicalOutlook(verified, {
      routeKey: verified.routeKey,
      destinationAddress: verified.destinationAddress,
      owner: verified.owner,
      assetAddress: verified.request.assetAddress,
      assetsRaw: verified.request.assetsRaw,
      nowMs,
      horizonSeconds,
    })
    return {
      ...verified,
      mechanicalOutlook: {
        issuedAt: new Date(nowMs).toISOString(),
        horizonSeconds,
        assessmentRequest: { ...verified.request },
        outlook,
      },
    }
  } catch {
    return verified
  }
}

const APYUSD_FEE_FACT_KEYS = [
  'currentFeeCurve',
  'currentMinimumClaimDelaySeconds',
  'ifInitiatedAtCheckedBlockClaimableAt',
  'ifInitiatedAtCheckedBlockEarliestNetRaw',
  'ifInitiatedAtCheckedBlockMinimumFeeAt',
  'ifInitiatedAtCheckedBlockMinimumFeeNetRaw',
  'ifInitiatedAtCheckedBlockHorizonNetRaw',
] as const
type ApyUsdCondition = NonNullable<HolderExitAssessment['apyUsdCondition']>
type ApyUsdFeeFacts = Pick<ApyUsdCondition, (typeof APYUSD_FEE_FACT_KEYS)[number]>
const unknownApyUsdFeeFacts: ApyUsdFeeFacts = {
  currentFeeCurve: null,
  currentMinimumClaimDelaySeconds: null,
  ifInitiatedAtCheckedBlockClaimableAt: null,
  ifInitiatedAtCheckedBlockEarliestNetRaw: null,
  ifInitiatedAtCheckedBlockMinimumFeeAt: null,
  ifInitiatedAtCheckedBlockMinimumFeeNetRaw: null,
  ifInitiatedAtCheckedBlockHorizonNetRaw: null,
}
const isApyUsdAssessment = (assessment: HolderExitAssessment) =>
  assessment.routeKey === APYUSD_ROUTE &&
  assessment.destinationAddress.toLowerCase() === APYUSD_VAULT.toLowerCase()

function apyUsdFeeFacts(condition: HolderExitAssessment['apyUsdCondition']): ApyUsdFeeFacts | null {
  if (
    !condition?.currentFeeCurve ||
    !APYUSD_FEE_FACT_KEYS.every(
      (key) => Object.hasOwn(condition, key) && condition[key] !== undefined,
    )
  )
    return null
  return {
    currentFeeCurve: condition.currentFeeCurve,
    currentMinimumClaimDelaySeconds: condition.currentMinimumClaimDelaySeconds,
    ifInitiatedAtCheckedBlockClaimableAt: condition.ifInitiatedAtCheckedBlockClaimableAt,
    ifInitiatedAtCheckedBlockEarliestNetRaw: condition.ifInitiatedAtCheckedBlockEarliestNetRaw,
    ifInitiatedAtCheckedBlockMinimumFeeAt: condition.ifInitiatedAtCheckedBlockMinimumFeeAt,
    ifInitiatedAtCheckedBlockMinimumFeeNetRaw: condition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw,
    ifInitiatedAtCheckedBlockHorizonNetRaw: condition.ifInitiatedAtCheckedBlockHorizonNetRaw,
  }
}

/** Agree optional native APY groups before deriving any public mechanical outlook. */
function withAgreedApyUsdOptionalFacts(
  first: HolderExitAssessment,
  second: HolderExitAssessment,
): HolderExitAssessment {
  if (!isApyUsdAssessment(first) || !isApyUsdAssessment(second)) return second
  if (!first.apyUsdCondition && !second.apyUsdCondition) return second
  const firstFees = apyUsdFeeFacts(first.apyUsdCondition)
  const secondFees = apyUsdFeeFacts(second.apyUsdCondition)
  const firstReceipt = first.apyUsdCondition?.existingReceipt
  const secondReceipt = second.apyUsdCondition?.existingReceipt
  return {
    ...second,
    apyUsdCondition: {
      ...second.apyUsdCondition,
      ...(firstFees && secondFees && isDeepStrictEqual(firstFees, secondFees)
        ? structuredClone(firstFees)
        : unknownApyUsdFeeFacts),
      existingReceipt:
        firstReceipt && secondReceipt && isDeepStrictEqual(firstReceipt, secondReceipt)
          ? structuredClone(firstReceipt)
          : null,
    },
  }
}

/** Optional full active entitlement must agree independently of the required assay. */
function withAgreedSusdeOptionalFacts(
  first: HolderExitAssessment,
  second: HolderExitAssessment,
): HolderExitAssessment {
  const { susdeHolderFacts: _optionalFacts, ...core } = first
  const a = first.susdeHolderFacts
  const b = second.susdeHolderFacts
  const bound = (assessment: HolderExitAssessment) => {
    const facts = assessment.susdeHolderFacts
    return (
      facts &&
      facts.originAgreement === 'not_compared' &&
      facts.owner === assessment.owner &&
      facts.source.vaultAddress === assessment.destinationAddress &&
      facts.source.assetAddress === assessment.request.assetAddress &&
      facts.source.chainId === assessment.source.chainId &&
      facts.source.blockNumber === assessment.source.blockNumber &&
      facts.source.blockHash === assessment.source.blockHash &&
      facts.source.blockTime === assessment.source.blockTime
    )
  }
  return a && b && bound(first) && bound(second) && isDeepStrictEqual(a, b)
    ? {
        ...core,
        susdeHolderFacts: { ...structuredClone(a), originAgreement: 'two_provider_agreed' },
      }
    : core
}

export function sameHolderExitAssessment(
  first: HolderExitAssessment,
  second: HolderExitAssessment,
): boolean {
  if (
    first.source.chainId !== 1 ||
    second.source.chainId !== 1 ||
    first.source.blockNumber !== second.source.blockNumber ||
    first.source.blockHash.toLowerCase() !== second.source.blockHash.toLowerCase() ||
    first.source.blockTime !== second.source.blockTime
  )
    return false
  const normalized = (assessment: HolderExitAssessment) => {
    const condition = assessment.stakedUsdatCondition
      ? { ...assessment.stakedUsdatCondition }
      : null
    if (condition) {
      delete condition.existingTicketConversionBasis
      delete condition.existingTicketConversionFeeStatus
      delete condition.existingTicketRecordedRequest
    }
    const apyCondition: Partial<ApyUsdCondition> | null =
      isApyUsdAssessment(assessment) && assessment.apyUsdCondition
        ? { ...assessment.apyUsdCondition }
        : null
    if (apyCondition) {
      for (const key of APYUSD_FEE_FACT_KEYS) delete apyCondition[key]
      delete apyCondition.existingReceipt
    }
    return {
      ...assessment,
      capacityQuote: undefined,
      susdeHolderFacts: undefined,
      susdeProtocolCapacityObservation: undefined,
      stusdsProtocolCapacityObservation: undefined,
      morphoV2ProtocolCapacityObservation: undefined,
      morphoHolderPositionObservation: undefined,
      cometFacts: undefined,
      cometFactsAgreement: undefined,
      source: { ...assessment.source, originValidation: 'two_provider' },
      pyusdYieldQueueCondition: undefined,
      ...(isApyUsdAssessment(assessment)
        ? {
            apyUsdCondition:
              apyCondition && Object.keys(apyCondition).length > 0 ? apyCondition : undefined,
          }
        : {}),
      ...(assessment.stakedUsdatCondition
        ? {
            stakedUsdatCondition: {
              ...condition,
              existingTicketConversionQuote: null,
              existingTicketConversionBasis: null,
              existingTicketConversionFeeStatus: null,
              existingTicketRecordedRequest: null,
            },
          }
        : {}),
    }
  }
  return JSON.stringify(normalized(first)) === JSON.stringify(normalized(second))
}

function withAgreedOptionalEvidence(
  first: HolderExitAssessment,
  second: HolderExitAssessment,
): HolderExitAssessment {
  const firstQuote = first.stakedUsdatCondition?.existingTicketConversionQuote
  const secondQuote = second.stakedUsdatCondition?.existingTicketConversionQuote
  const firstCondition = first.stakedUsdatCondition
  const secondCondition = second.stakedUsdatCondition
  const sameRecord =
    firstCondition?.existingTicketRecordedRequest &&
    secondCondition?.existingTicketRecordedRequest &&
    JSON.stringify(firstCondition.existingTicketRecordedRequest) ===
      JSON.stringify(secondCondition.existingTicketRecordedRequest)
  const sameQuote =
    firstQuote &&
    secondQuote &&
    JSON.stringify(firstQuote) === JSON.stringify(secondQuote) &&
    firstCondition?.existingTicketConversionBasis ===
      secondCondition?.existingTicketConversionBasis &&
    firstCondition?.existingTicketConversionFeeStatus ===
      secondCondition?.existingTicketConversionFeeStatus &&
    (secondCondition?.existingTicketConversionBasis !== 'recorded_owed_if_delivered' || sameRecord)
  const firstQueue = first.pyusdYieldQueueCondition
  const secondQueue = second.pyusdYieldQueueCondition
  return {
    ...second,
    pyusdYieldQueueCondition:
      firstQueue && secondQueue && JSON.stringify(firstQueue) === JSON.stringify(secondQueue)
        ? secondQueue
        : undefined,
    ...(second.stakedUsdatCondition
      ? {
          stakedUsdatCondition: {
            ...second.stakedUsdatCondition,
            existingTicketConversionQuote: sameQuote ? secondQuote : null,
            existingTicketConversionBasis: sameQuote
              ? (secondCondition?.existingTicketConversionBasis ?? null)
              : null,
            existingTicketConversionFeeStatus: sameQuote
              ? (secondCondition?.existingTicketConversionFeeStatus ?? null)
              : null,
            existingTicketRecordedRequest: sameRecord
              ? secondCondition?.existingTicketRecordedRequest
              : null,
          },
        }
      : {}),
  }
}

export function parseHolderExitAssessmentRequest(
  body: unknown,
): HolderExitAssessmentApiRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'routeKey',
          'destinationAddress',
          'owner',
          'assetsRaw',
          'sharesRaw',
          'horizonHours',
          'firstLegUsdcRaw',
          'receiptTokenId',
          'requestTokenId',
          'collateralVault',
          'ptRaw',
          'primeSharesRaw',
          'chainId',
          'forecastSourceReference',
        ].includes(key),
    ) ||
    (value.chainId !== undefined && value.chainId !== 1)
  )
    return null
  if (
    typeof value.routeKey !== 'string' ||
    typeof value.destinationAddress !== 'string' ||
    typeof value.owner !== 'string' ||
    typeof value.assetsRaw !== 'string' ||
    (value.sharesRaw !== undefined && typeof value.sharesRaw !== 'string') ||
    typeof value.horizonHours !== 'number' ||
    (value.firstLegUsdcRaw !== undefined && typeof value.firstLegUsdcRaw !== 'string') ||
    (value.receiptTokenId !== undefined && typeof value.receiptTokenId !== 'string') ||
    (value.requestTokenId !== undefined && typeof value.requestTokenId !== 'string') ||
    (value.collateralVault !== undefined && typeof value.collateralVault !== 'string') ||
    (value.ptRaw !== undefined && typeof value.ptRaw !== 'string') ||
    (value.primeSharesRaw !== undefined && typeof value.primeSharesRaw !== 'string')
  )
    return null
  let reference: HolderExitForecastSourceReference | undefined
  if (value.forecastSourceReference !== undefined) {
    const candidate = value.forecastSourceReference
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const r = candidate as Record<string, unknown>
    if (
      Object.keys(r).length !== 3 ||
      Object.keys(r).some((key) => !['blockNumber', 'blockHash', 'blockTime'].includes(key)) ||
      typeof r.blockNumber !== 'number' ||
      !Number.isSafeInteger(r.blockNumber) ||
      r.blockNumber < 1 ||
      typeof r.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(r.blockHash) ||
      typeof r.blockTime !== 'string' ||
      !Number.isSafeInteger(Date.parse(r.blockTime)) ||
      new Date(Date.parse(r.blockTime)).toISOString() !== r.blockTime ||
      !resolveIssuedHolderExitSubject(value.routeKey, value.destinationAddress)
    )
      return null
    reference = {
      blockNumber: r.blockNumber,
      blockHash: r.blockHash.toLowerCase(),
      blockTime: r.blockTime,
    }
    if (!freshReference(reference, Date.now())) return null
  }
  const input: HolderExitAssessmentApiRequest = {
    routeKey: value.routeKey,
    destinationAddress: value.destinationAddress.toLowerCase() as Address,
    owner: value.owner.toLowerCase() as Address,
    assetsRaw: value.assetsRaw,
    ...(reference ? { forecastSourceReference: reference } : {}),
    ...(value.sharesRaw !== undefined ? { sharesRaw: value.sharesRaw } : {}),
    horizonHours: value.horizonHours,
    ...(value.firstLegUsdcRaw !== undefined ? { firstLegUsdcRaw: value.firstLegUsdcRaw } : {}),
    ...(value.receiptTokenId !== undefined ? { receiptTokenId: value.receiptTokenId } : {}),
    ...(value.requestTokenId !== undefined ? { requestTokenId: value.requestTokenId } : {}),
    ...(value.collateralVault !== undefined
      ? { collateralVault: value.collateralVault.toLowerCase() as Address }
      : {}),
    ...(value.ptRaw !== undefined ? { ptRaw: value.ptRaw } : {}),
    ...(value.primeSharesRaw !== undefined ? { primeSharesRaw: value.primeSharesRaw } : {}),
  }
  try {
    validateHolderExitAssessmentRequest(input)
  } catch {
    return null
  }
  return input
}

function localLimit(address: string) {
  const now = Date.now()
  const prior = localRates.get(address)
  if (!prior || now - prior.start >= 60_000) {
    localRates.set(address, { start: now, count: 1 })
    if (localRates.size > 256) {
      for (const [key, entry] of localRates) if (now - entry.start >= 60_000) localRates.delete(key)
    }
    return true
  }
  prior.count += 1
  return prior.count <= 12
}

const HOLDER_EXIT_PROVIDER_FAILURE_CLASSES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'RpcRequestError',
  'HttpRequestError',
  'ContractFunctionExecutionError',
  'ContractFunctionRevertedError',
  'CallExecutionError',
  'TimeoutError',
])
const HOLDER_EXIT_PROVIDER_FAILURE_IDENTIFIERS = new Set([
  'morpho_chain_mismatch',
  'morpho_finalized_block_unavailable',
  'morpho_block_hash_changed',
  'morpho_contract_holder_path_unavailable',
  'morpho_simulation_result_invalid',
  'holder_provider_policy_inactive',
  'historical_depth_quote_provider_url_invalid',
  'historical_depth_quote_two_archive_hosts_required',
  'historical_depth_quote_archive_hosts_not_distinct',
  'historical_depth_quote_provider_policy_invalid',
  'historical_depth_quote_provider_policy_binding_missing',
  'historical_depth_quote_provider_policy_not_distinct',
])

const HOLDER_EXIT_PROVIDER_FAILURE_CAUSE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])
const HOLDER_EXIT_PROVIDER_FAILURE_RPC_METHODS = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_call',
])

function safeHolderExitFailureProperty(
  value: unknown,
  key: 'name' | 'message' | 'status' | 'code' | 'body' | 'method' | 'cause',
): unknown {
  try {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)[key]
      : undefined
  } catch {
    return undefined
  }
}

function logHolderExitProviderFailure(
  stage: 'provider_configuration' | 'holder_read' | 'holder_evidence',
  error: unknown,
  attemptOrdinal: 1 | 2 | null,
) {
  // Emit only closed local identifiers. Never serialize a body, params, URL or raw error.
  try {
    let errorClass = 'other_error'
    let identifier: string | null = null
    let httpStatus: number | null = null
    let causeCode: string | null = null
    let rpcMethod: string | null = null
    const name = safeHolderExitFailureProperty(error, 'name')
    const message = safeHolderExitFailureProperty(error, 'message')
    if (typeof name === 'string' && HOLDER_EXIT_PROVIDER_FAILURE_CLASSES.has(name))
      errorClass = name
    if (typeof message === 'string' && HOLDER_EXIT_PROVIDER_FAILURE_IDENTIFIERS.has(message))
      identifier = message
    let current: unknown = error
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
      const status = safeHolderExitFailureProperty(current, 'status')
      const code = safeHolderExitFailureProperty(current, 'code')
      if (httpStatus === null && typeof status === 'number' && Number.isInteger(status) &&
        status >= 100 && status <= 599) httpStatus = status
      if (causeCode === null && typeof code === 'string' &&
        HOLDER_EXIT_PROVIDER_FAILURE_CAUSE_CODES.has(code)) causeCode = code
      const currentName = depth === 0 ? name : safeHolderExitFailureProperty(current, 'name')
      if (rpcMethod === null && currentName === 'HttpRequestError') {
        const body = safeHolderExitFailureProperty(current, 'body')
        const method = safeHolderExitFailureProperty(body, 'method')
        if (typeof method === 'string' && HOLDER_EXIT_PROVIDER_FAILURE_RPC_METHODS.has(method))
          rpcMethod = method
      }
      current = safeHolderExitFailureProperty(current, 'cause')
    }
    console.error('holder_exit_assessment_provider_failure', {
      stage, errorClass, identifier, httpStatus, causeCode, rpcMethod, attemptOrdinal,
    })
  } catch {
    // Best-effort diagnostics preserve the original response and provider loop.
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const declared = Number(req.headers['content-length'] ?? 0)
  let actual = Number.POSITIVE_INFINITY
  try {
    actual = Buffer.byteLength(JSON.stringify(req.body ?? null))
  } catch {
    /* invalid body */
  }
  if (
    !Number.isSafeInteger(declared) ||
    declared < 0 ||
    declared > MAX_BODY_BYTES ||
    actual > MAX_BODY_BYTES
  )
    return res.status(413).json({ error: 'request_too_large' })
  const input = parseHolderExitAssessmentRequest(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_holder_exit_request' })
  try {
    const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
    const limit = await checkRateLimit(`holder-exit-assessment:${ipHash}`, 12, 60)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res.status(429).json({ error: 'rate_limited' })
    }
  } catch {
    const remote = req.socket?.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
      return res.status(503).json({ error: 'holder_exit_assessment_unavailable' })
    if (!localLimit(remote)) return res.status(429).json({ error: 'rate_limited' })
  }

  let urls: string[]
  try {
    const { configuredProviders, readProviderPolicy } =
      await import('@/scripts/research/carry-depth-quote-archive.mjs')
    const policy = readProviderPolicy()
    if (policy.status !== 'active') throw Error('holder_provider_policy_inactive')
    // Reuse the approved URI/hostname bindings; no environment mutation or public fallback.
    urls = configuredProviders(null, policy).map((origin: { url: string }) => origin.url)
  } catch (error) {
    logHolderExitProviderFailure('provider_configuration', error, null)
    return res.status(503).json({ error: 'holder_exit_assessment_unavailable' })
  }
  const witnessed: HolderExitOriginWitness[] = []
  const selectedProviderUrls = new WeakMap<object, string>()
  const { forecastSourceReference: reference, ...assessmentInput } = input
  let corroborated: HolderExitAssessment | null = null
  let capacityCorroborated: HolderExitCapacityAgreement | null = null
  let capacityWitnesses: typeof witnessed | null = null
  let cometFactsCorroborated: CometWithdrawFactsAgreement | null = null
  const attemptedHosts = new Set<string>()
  for (const url of urls) {
    let failureStage: 'holder_read' | 'holder_evidence' = 'holder_read'
    let attemptOrdinal: 1 | 2 | null = null
    try {
      if (reference && !freshReference(reference, Date.now())) break
      const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
      if (
        host.length > 253 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
          host,
        )
      )
        continue
      if (attemptedHosts.has(host)) continue
      attemptedHosts.add(host)
      attemptOrdinal = attemptedHosts.size === 1 ? 1 : attemptedHosts.size === 2 ? 2 : null
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      })
      const clients = { direct: client, apy: client, tracked: client, morpho: client }
      const sourcePin = reference
        ? {
            mode: 'internal_historical_finalized_block' as const,
            blockNumber: BigInt(reference.blockNumber),
            blockHash: reference.blockHash as `0x${string}`,
          }
        : undefined
      const assessment = sourcePin
        ? await readHolderExitAssessment(
            clients,
            assessmentInput,
            assessmentInput.routeKey === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey &&
              assessmentInput.destinationAddress.toLowerCase() ===
                DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination.toLowerCase()
              ? {
                  directFinalizedBlock: sourcePin,
                  includeCapacityFacts: true,
                  includeStusdsProtocolCapacity: true,
                }
              : {
                  ...(assessmentInput.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]'
                    ? { fluidUsdcBridgeFinalizedBlock: sourcePin }
                    : { atomicFinalizedBlock: sourcePin }),
                  includeCapacityFacts: true,
                  includeStusdsProtocolCapacity: true,
                  ...(assessmentInput.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]'
                    ? { includeFluidUsdcBridgeNativeCapacity: true as const }
                    : {}),
                },
          )
        : await readHolderExitAssessment(clients, assessmentInput, {
            includeCapacityFacts: true,
            includeStusdsProtocolCapacity: true,
            ...(assessmentInput.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]'
              ? { includeFluidUsdcBridgeNativeCapacity: true as const }
              : {}),
          })
      failureStage = 'holder_evidence'
      if (!isCurrentHolderExitAssessment(assessment, Date.now())) continue
      if (
        reference &&
        (assessment.source.blockNumber !== reference.blockNumber ||
          typeof assessment.source.blockHash !== 'string' ||
          assessment.source.blockHash.toLowerCase() !== reference.blockHash ||
          assessment.source.blockTime !== reference.blockTime)
      )
        continue
      selectedProviderUrls.set(client, url)
      for (const prior of witnessed) {
        cometFactsCorroborated ??= agreeCometWithdrawFacts(
          { host: prior.host, facts: prior.assessment.cometFacts },
          { host, facts: assessment.cometFacts },
          Date.now(),
        )
        if (!capacityCorroborated) {
          capacityCorroborated = agreeHolderExitCapacityQuotes(
            { host: prior.host, quote: prior.assessment.capacityQuote },
            { host, quote: assessment.capacityQuote },
            Date.now(),
          )
          if (capacityCorroborated) capacityWitnesses = [prior, { host, assessment, client }]
        }
      }
      const matches = witnessed.filter(
        (entry) => entry.host !== host && sameHolderExitAssessment(entry.assessment, assessment),
      )
      if (matches.length > 0) {
        const compared = matches.map((entry) =>
          withAgreedOptionalEvidence(entry.assessment, assessment),
        )
        const agreedOptional = compared.find(
          (entry) =>
            entry.stakedUsdatCondition?.existingTicketConversionQuote ||
            entry.pyusdYieldQueueCondition,
        )
        const verified = agreedOptional ?? compared[0]
        const anyOptional = [assessment, ...matches.map((entry) => entry.assessment)].some(
          (entry) =>
            entry.stakedUsdatCondition?.existingTicketConversionQuote ||
            entry.pyusdYieldQueueCondition,
        )
        if (agreedOptional || !anyOptional) {
          const morphoPair = await captureMorphoV2ProtocolPair(
            matches[0],
            {
              host,
              assessment: verified,
              client,
            },
            assessmentInput,
          )
          const [first, second] = await captureSusdeProtocolPair(morphoPair[0], morphoPair[1])
          if (
            !isCurrentHolderExitAssessment(first.assessment, Date.now()) ||
            !isCurrentHolderExitAssessment(second.assessment, Date.now())
          )
            break
          return res
            .status(200)
            .json(
              await withJointHistoricalEvidence(
                assessmentInput,
                agreedExecutionResponse(assessmentInput, first, second),
                agreedUmbrellaFinalizedSource(assessmentInput, [first, second]),
                agreedApyFinalizedSource(assessmentInput, [first, second]),
                agreedFluidUsdtFinalizedSource(assessmentInput, [first, second]),
                { witnesses: [first, second], selectedUrls: selectedProviderUrls },
              ),
            )
        }
        corroborated ??= verified
      }
      witnessed.push({ host, assessment, client })
    } catch (error) {
      logHolderExitProviderFailure(failureStage, error, attemptOrdinal)
      // Retry the whole pinned check on one provider; never merge values across providers.
    }
  }
  if (corroborated && assessmentInput.routeKey === 'AUSD → Staked USDat [USDat]') {
    const pair = witnessed.filter(w => sameHolderExitAssessment(w.assessment, corroborated!)).slice(0, 2)
    return res.status(200).json(await withSaturnAppForecastEvidence(assessmentInput, holderExitAssessmentResponse(corroborated), pair))
  }
  if (corroborated)
    return res
      .status(200)
      .json(
        await withFluidUsdtBridgeJointHistoricalEvidence(
          assessmentInput,
          await withApyUsdJointHistoricalEvidence(
            assessmentInput,
            await withUmbrellaGhoJointHistoricalEvidence(
              assessmentInput,
              holderExitAssessmentResponse(corroborated),
              agreedUmbrellaFinalizedSource(assessmentInput, witnessed),
            ),
            agreedApyFinalizedSource(assessmentInput, witnessed),
          ),
          agreedFluidUsdtFinalizedSource(assessmentInput, witnessed),
        ),
      )
  if (capacityCorroborated)
    capacityCorroborated = agreeHolderExitCapacityQuotes(
      capacityCorroborated.origins[0],
      capacityCorroborated.origins[1],
      Date.now(),
    )
  if (capacityCorroborated && capacityWitnesses) {
    capacityWitnesses = await captureMorphoV2ProtocolPair(
      capacityWitnesses[0],
      capacityWitnesses[1],
      assessmentInput,
    )
    capacityCorroborated = agreeHolderExitCapacityQuotes(
      capacityCorroborated.origins[0],
      capacityCorroborated.origins[1],
      Date.now(),
    )
  }
  const stusdsCurrentProtocolCapacityEvidence =
    capacityCorroborated && capacityWitnesses
      ? agreedStusdsProtocolEvidence(capacityWitnesses[0], capacityWitnesses[1])
      : null
  const morphoV2CurrentProtocolCapacityEvidence =
    capacityCorroborated && capacityWitnesses
      ? agreedMorphoV2ProtocolEvidence(capacityWitnesses[0], capacityWitnesses[1])
      : null
  const morphoV2CurrentHolderPositionEvidence =
    capacityCorroborated && capacityWitnesses
      ? agreedMorphoV2HolderPositionEvidence(
          assessmentInput,
          capacityWitnesses[0],
          capacityWitnesses[1],
        )
      : null
  const morphoV2HistoricalHolderEaEvidence =
    capacityCorroborated && capacityWitnesses
      ? agreedMorphoV2HistoricalHolderEaEvidence(
          assessmentInput,
          capacityWitnesses[0],
          capacityWitnesses[1],
        )
      : null
  return res.status(503).json(
    await withJointHistoricalEvidence(
      assessmentInput,
      {
        error: 'holder_exit_assessment_unavailable',
        ...(capacityCorroborated ? { capacityAgreement: capacityCorroborated } : {}),
        ...(stusdsCurrentProtocolCapacityEvidence ? { stusdsCurrentProtocolCapacityEvidence } : {}),
        ...(morphoV2CurrentProtocolCapacityEvidence
          ? { morphoV2CurrentProtocolCapacityEvidence }
          : {}),
        ...(morphoV2CurrentHolderPositionEvidence ? { morphoV2CurrentHolderPositionEvidence } : {}),
        ...(morphoV2HistoricalHolderEaEvidence ? { morphoV2HistoricalHolderEaEvidence } : {}),
        ...(cometFactsCorroborated &&
        agreeCometWithdrawFacts(
          cometFactsCorroborated.origins[0],
          cometFactsCorroborated.origins[1],
          Date.now(),
        )
          ? { cometFactsAgreement: cometFactsCorroborated }
          : {}),
      },
      agreedUmbrellaFinalizedSource(assessmentInput, witnessed),
      agreedApyFinalizedSource(assessmentInput, witnessed),
      agreedFluidUsdtFinalizedSource(assessmentInput, witnessed),
      { witnesses: capacityWitnesses ?? [], selectedUrls: selectedProviderUrls },
    ),
  )
}
