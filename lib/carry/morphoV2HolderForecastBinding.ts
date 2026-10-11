import { sha256, stringToHex } from 'viem'
import {
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  type HolderExitCapacityBinding,
} from './holderExitCapacity'
import {
  buildMorphoV2HolderTimeProcess,
  selectedMorphoV2HolderTimeProcess,
  MORPHO_V2_PILOT,
} from './morphoV2HolderTimeProcess'
import {
  approveMorphoV2PinnedProtocolHistory,
  morphoV2PinnedProtocolHistory,
} from './morphoV2ProtocolCapacityHistoryPins'
import {
  approveMorphoV2CurrentProtocolCapacityEvidence,
  type MorphoV2NativeSource,
} from './morphoV2ProtocolCapacityReplay'
import { decodeMorphoV2ProtocolEvidencePair } from './morphoV2ProtocolEvidenceCodec'

const approvedHosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const hash = (text: string) => sha256(stringToHex(text)).slice(2)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const issued = new WeakSet<object>()
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export type MorphoV2HolderForecastQuestion = {
  routeKey: string
  destination: string
  requestedHolderAddress?: string | null
  requestedRaw: string | null
  requestedAssetAddress: string | null
  requestedAssetDecimals: number | null
  horizonHours: number
  asOfMs: number
  independentSource?: MorphoV2NativeSource
}
export type MorphoV2HolderForecastIssue = {
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  block: string
  blockHash: string
  source: MorphoV2NativeSource
  independentSource?: MorphoV2NativeSource
}

/** The optional payload is useful even when execution remains unavailable. */
export function morphoV2ProtocolEvidenceFromResponse(
  value: unknown,
  status: number,
): unknown | null {
  return (status === 200 || status === 503) &&
    record(value) &&
    (status !== 503 || value.error === 'holder_exit_assessment_unavailable') &&
    value.morphoV2CurrentProtocolCapacityEvidence !== undefined
    ? value.morphoV2CurrentProtocolCapacityEvidence
    : null
}

/** Native holder quotes supply source and full E independently of protocol model bytes. */
export function issuedMorphoV2HolderForecast(
  capacityAgreement: unknown,
  executionAgreement: unknown,
  compactEvidence: unknown,
  question: MorphoV2HolderForecastQuestion,
) {
  try {
    const q = structuredClone(question)
    if (
      q.routeKey !== MORPHO_V2_PILOT.routeKey ||
      q.destination.toLowerCase() !== MORPHO_V2_PILOT.destination ||
      q.requestedAssetAddress?.toLowerCase() !== MORPHO_V2_PILOT.asset ||
      q.requestedAssetDecimals !== 6 ||
      !q.requestedHolderAddress ||
      !/^0x[0-9a-f]{40}$/.test(q.requestedHolderAddress.toLowerCase()) ||
      !q.requestedRaw ||
      !/^[1-9][0-9]{0,77}$/.test(q.requestedRaw) ||
      ![1, 24, 48, 168].includes(q.horizonHours) ||
      !Number.isSafeInteger(q.asOfMs) ||
      !record(capacityAgreement) ||
      !Array.isArray(capacityAgreement.origins) ||
      capacityAgreement.origins.length !== 2
    )
      return null
    const origins = capacityAgreement.origins
    if (
      !origins.every(
        (origin) => record(origin) && approvedHosts.some((host) => host === origin.host),
      )
    )
      return null
    const agreement = agreeHolderExitCapacityQuotes(origins[0], origins[1], q.asOfMs)
    if (!agreement) return null
    const source = agreement.quote.source
    if (
      q.independentSource &&
      ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'].some(
        (key) =>
          source[key as keyof typeof source] !== q.independentSource![key as keyof typeof source],
      )
    )
      return null
    const binding: HolderExitCapacityBinding = {
      routeKey: q.routeKey,
      destination: q.destination.toLowerCase(),
      owner: q.requestedHolderAddress.toLowerCase(),
      requestedRaw: q.requestedRaw,
      asset: q.requestedAssetAddress.toLowerCase(),
      assetDecimals: q.requestedAssetDecimals,
      currentSource: structuredClone(source),
      asOfMs: q.asOfMs,
      executionAgreement,
    }
    const capacity = selectedHolderExitCapacity(capacityAgreement, binding)
    if (
      !capacity ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      capacity.quote.entitlementRaw === null
    )
      return null
    const raw = decodeMorphoV2ProtocolEvidencePair(compactEvidence)
    const current = raw
      ? approveMorphoV2CurrentProtocolCapacityEvidence(
          raw,
          { source: binding.currentSource, asOfMs: q.asOfMs, originHosts: approvedHosts },
          hash,
        )
      : null
    if (!current) return null
    const input = {
      history: morphoV2PinnedProtocolHistory(),
      current: current.current,
      capacityAgreement: capacity,
      binding,
      horizonHours: q.horizonHours,
      asOfMs: q.asOfMs,
    }
    const accept = (kind: 'history' | 'current', candidate: unknown) =>
      kind === 'history'
        ? approveMorphoV2PinnedProtocolHistory(candidate, hash)
        : current.acceptEvidence(candidate)
    const built = buildMorphoV2HolderTimeProcess(input, accept)
    const selected = built
      ? selectedMorphoV2HolderTimeProcess(built, input, q.asOfMs, accept)
      : null
    if (!selected) return null
    const result = freeze(selected)
    issued.add(result)
    return result
  } catch {
    return null
  }
}

export function morphoV2HolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  question: MorphoV2HolderForecastQuestion,
): MorphoV2HolderForecastIssue | null {
  const compact = morphoV2ProtocolEvidenceFromResponse(value, status)
  if (!compact || !record(value)) return null
  const selected = issuedMorphoV2HolderForecast(
    value.capacityAgreement,
    value.executionAgreement,
    compact,
    question,
  )
  if (!selected) return null
  const b = selected.input.binding
  return {
    issuedAtMs: selected.input.asOfMs,
    horizonHours: selected.input.horizonHours,
    owner: b.owner,
    requestedRaw: b.requestedRaw,
    block: String(b.currentSource.blockNumber),
    blockHash: b.currentSource.blockHash,
    source: structuredClone(b.currentSource),
    ...(question.independentSource
      ? { independentSource: structuredClone(question.independentSource) }
      : {}),
  }
}

/** Cached private issuance keeps its receipt time while only source/target expiry advances. */
export function morphoV2HolderForecastRenderWindow(
  value: NonNullable<ReturnType<typeof issuedMorphoV2HolderForecast>>,
  asOfMs: number,
) {
  return (
    issued.has(value) &&
    Number.isSafeInteger(asOfMs) &&
    asOfMs >= value.input.asOfMs &&
    asOfMs <= Date.parse(value.sourceProofValidUntil) &&
    asOfMs < Date.parse(value.targetAtUtc)
  )
}
