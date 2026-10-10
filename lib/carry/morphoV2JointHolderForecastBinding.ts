import { sha256, stringToHex } from 'viem'
import {
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  type HolderExitCapacityBinding,
} from './holderExitCapacity'
import type { MorphoV2HolderForecastQuestion } from './morphoV2HolderForecastBinding'
import {
  approveMorphoV2HolderPositionEvidence,
  decodeMorphoV2HolderPositionEvidence,
  selectedMorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionExpectation,
} from './morphoV2HolderPositionEvidence'
import {
  approveMorphoV2HistoricalHolderEaEvidence,
  decodeMorphoV2HistoricalHolderEaEvidencePair,
  selectMorphoV2HistoricalHolderEaAnchors,
  selectedMorphoV2HistoricalHolderEaEvidence,
  type MorphoV2HistoricalHolderEaExpectation,
} from './morphoV2HistoricalHolderEaEvidence'
import {
  buildMorphoV2JointStockProjection,
  type MorphoV2JointStockFrame,
} from './morphoV2JointStockProjection'
import {
  approveMorphoV2CurrentProtocolCapacityEvidence,
  isMorphoV2NativeSourceValid,
  type MorphoV2NativeSource,
} from './morphoV2ProtocolCapacityReplay'
import { decodeMorphoV2ProtocolEvidencePair } from './morphoV2ProtocolEvidenceCodec'
import {
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolEvidence,
} from './morphoV2ReviewedProtocolHistories'
import { resolveMorphoV2TrustedProfile } from './morphoV2TrustedProfiles'
import type { MorphoV2ProtocolPoint } from './morphoV2HolderTimeProcess'

const HOSTS: [string, string] = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const SOURCE_TTL_MS = 30 * 60 * 1000
const UINT_MAX = (1n << 256n) - 1n
const hash = (text: string) => sha256(stringToHex(text)).slice(2)
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= UINT_MAX
const address = (v: unknown): v is `0x${string}` =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function sameSource(a: MorphoV2NativeSource, b: MorphoV2NativeSource): boolean {
  return ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'].every(
    (key) => a[key as keyof typeof a] === b[key as keyof typeof b],
  )
}
function sameAnchor(
  a: { chainId: number; blockNumber: string; blockHash: string; blockTime: string },
  b: { chainId: number; blockNumber: string; blockHash: string; blockTime: string },
) {
  return (
    a.chainId === b.chainId &&
    a.blockNumber === b.blockNumber &&
    a.blockHash === b.blockHash &&
    a.blockTime === b.blockTime
  )
}
function canonicalQuestion(supplied: MorphoV2HolderForecastQuestion) {
  const q = structuredClone(supplied)
  const destination = q.destination?.toLowerCase(),
    asset = q.requestedAssetAddress?.toLowerCase(),
    owner = q.requestedHolderAddress?.toLowerCase()
  if (
    !address(destination) ||
    !address(asset) ||
    !address(owner) ||
    !uint(q.requestedRaw) ||
    BigInt(q.requestedRaw) === 0n ||
    ![1, 24, 48, 168].includes(q.horizonHours) ||
    !Number.isSafeInteger(q.asOfMs)
  )
    return null
  const profile = resolveMorphoV2TrustedProfile(q.routeKey, destination, asset)
  if (!profile || q.requestedAssetDecimals !== profile.subject.assetDecimals) return null
  return {
    question: {
      routeKey: q.routeKey,
      destination,
      requestedAssetAddress: asset,
      requestedHolderAddress: owner,
      requestedRaw: q.requestedRaw,
      requestedAssetDecimals: q.requestedAssetDecimals,
      horizonHours: q.horizonHours,
      asOfMs: q.asOfMs,
      ...(q.independentSource ? { independentSource: q.independentSource } : {}),
    },
    profile,
  }
}

/** Identities are derived from approved native facts, never transported regime labels. */
function frame(
  profileId: string,
  evidence: ReviewedMorphoV2ProtocolEvidence,
  point: MorphoV2ProtocolPoint,
  sharesRaw: string,
  assetsRaw: string,
): MorphoV2JointStockFrame {
  const source = point.source
  return {
    source: {
      chainId: source.chainId,
      blockNumber: source.blockNumber,
      blockHash: source.blockHash,
      blockTime: source.blockTime,
    },
    regime: {
      profile: profileId,
      runtimeCodeIdentity: hash(JSON.stringify(evidence.runtimeIdentities)),
      configurationIdentity: hash(JSON.stringify(evidence.configured)),
      feePolicyIdentity: hash(JSON.stringify([point.prongs.market[5], point.prongs.feeRecipient])),
      enrolled: true, // Approved native protocol replay requires isAdapter == true.
      ...evidence.subject,
    },
    prongs: structuredClone(point.prongs),
    fixedShareEntitlement: {
      method: 'native_preview_redeem_fixed_shares',
      sharesRaw,
      assetsRaw,
    },
  }
}

function issueJoint(
  capacityAgreement: unknown,
  executionAgreement: unknown,
  compactProtocol: unknown,
  compactHolder: unknown,
  compactHistorical: unknown,
  suppliedQuestion: MorphoV2HolderForecastQuestion,
) {
  const selection = canonicalQuestion(suppliedQuestion)
  if (!selection) return null
  const { question: q, profile } = selection
  if (!record(capacityAgreement) || !Array.isArray(capacityAgreement.origins)) return null
  const origins = capacityAgreement.origins
  if (
    origins.length !== 2 ||
    Object.keys(origins).length !== 2 ||
    ![0, 1].every(
      (index) =>
        Object.hasOwn(origins, index) &&
        record(origins[index]) &&
        HOSTS.includes(origins[index].host as string),
    )
  )
    return null
  const rebuilt = agreeHolderExitCapacityQuotes(
    origins[0] as { host: string; quote: unknown },
    origins[1] as { host: string; quote: unknown },
    q.asOfMs,
  )
  if (!rebuilt) return null
  const source = rebuilt.quote.source as MorphoV2HolderPositionExpectation['source']
  if (q.independentSource && !sameSource(source, q.independentSource)) return null
  const binding: HolderExitCapacityBinding = {
    routeKey: q.routeKey,
    destination: q.destination,
    owner: q.requestedHolderAddress,
    requestedRaw: q.requestedRaw,
    asset: q.requestedAssetAddress,
    assetDecimals: profile.subject.assetDecimals,
    currentSource: structuredClone(source),
    asOfMs: q.asOfMs,
    executionAgreement,
  }
  const capacity = selectedHolderExitCapacity(capacityAgreement, binding)
  const position = capacity?.quote.sourceHolderPosition
  if (
    !capacity ||
    capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
    !uint(capacity.quote.entitlementRaw) ||
    !position ||
    !uint(position.sharesRaw) ||
    BigInt(position.sharesRaw) === 0n ||
    position.method !== 'balance_of_owner_at_source' ||
    position.shareDecimals !== profile.subject.shareDecimals ||
    (capacity.quote.fullPositionEntitlementRaw !== undefined &&
      capacity.quote.fullPositionEntitlementRaw !== capacity.quote.entitlementRaw)
  )
    return null
  const history = reviewedMorphoV2ProtocolHistory(profile)
  if (
    !history ||
    !approveReviewedMorphoV2ProtocolHistory(profile, history, hash) ||
    Date.parse(history.knowledgeCutoff) > q.asOfMs ||
    !Number.isSafeInteger(Date.parse(history.knowledgeCutoff))
  )
    return null
  const rawProtocol = decodeMorphoV2ProtocolEvidencePair(compactProtocol)
  const current = rawProtocol
    ? approveMorphoV2CurrentProtocolCapacityEvidence(
        rawProtocol,
        { profile, source, asOfMs: q.asOfMs, originHosts: HOSTS },
        hash,
      )
    : null
  if (!current || typeof compactHolder !== 'string') return null
  const holderExpected: MorphoV2HolderPositionExpectation = {
    routeKey: q.routeKey,
    destination: q.destination as `0x${string}`,
    owner: q.requestedHolderAddress as `0x${string}`,
    asset: q.requestedAssetAddress as `0x${string}`,
    assetDecimals: profile.subject.assetDecimals,
    shareDecimals: profile.subject.shareDecimals,
    source,
    sharesRaw: position.sharesRaw,
    fullEaRaw: capacity.quote.entitlementRaw,
    originHosts: [...HOSTS],
    asOfMs: q.asOfMs,
  }
  const holder = approveMorphoV2HolderPositionEvidence(
    decodeMorphoV2HolderPositionEvidence(compactHolder),
    holderExpected,
  )
  if (!selectedMorphoV2HolderPositionEvidence(holder, holderExpected)) return null
  const historicalExpected: MorphoV2HistoricalHolderEaExpectation = {
    profile,
    currentSource: source,
    sharesRaw: holder.sharesRaw,
    originHosts: [...HOSTS],
    asOfMs: q.asOfMs,
  }
  let historical: ReturnType<typeof approveMorphoV2HistoricalHolderEaEvidence> | null = null
  let knowledgeCutoffUtc = history.knowledgeCutoff
  let historicalPoints: { point: MorphoV2ProtocolPoint; assetsRaw: string }[]
  if (compactHistorical !== undefined && compactHistorical !== null) {
    if (typeof compactHistorical !== 'string') return null
    const raw = decodeMorphoV2HistoricalHolderEaEvidencePair(compactHistorical)
    if (!raw) return null
    historical = approveMorphoV2HistoricalHolderEaEvidence(raw, historicalExpected)
    if (
      !selectedMorphoV2HistoricalHolderEaEvidence(historical, historicalExpected) ||
      Date.parse(historical.knowledgeCutoffUtc) > q.asOfMs
    )
      return null
    knowledgeCutoffUtc = new Date(
      Math.max(Date.parse(history.knowledgeCutoff), Date.parse(historical.knowledgeCutoffUtc)),
    ).toISOString()
    const anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, source)
    if (anchors.length !== historical.points.length) return null
    historicalPoints = anchors.map((point, index) => {
      if (!sameAnchor(point.source, historical!.points[index].source))
        throw Error('anchor_mismatch')
      return { point, assetsRaw: historical!.points[index].assetsRaw }
    })
  } else {
    const native = history.nativeQualification
    if (
      profile.id !== 'morpho_v2_usdt_reviewed_joint_history' ||
      !native ||
      holder.sharesRaw !== '10437267800221756345625' ||
      native.fixedSharesRaw !== holder.sharesRaw
    )
      return null
    historicalPoints = history.history.points
      .filter(
        (point) =>
          BigInt(point.source.blockNumber) < BigInt(source.blockNumber) &&
          Date.parse(point.source.blockTime) < Date.parse(source.blockTime),
      )
      .map((point) => {
        const fixed = native.points.find((p) =>
          sameAnchor(p.source, point.source),
        )?.fixedShareEntitlement
        if (
          !fixed ||
          fixed.method !== 'native_preview_redeem_fixed_shares' ||
          fixed.sharesRaw !== holder.sharesRaw ||
          !uint(fixed.assetsRaw)
        )
          throw Error('missing_native_Ea')
        return { point, assetsRaw: fixed.assetsRaw }
      })
  }
  const currentFrame = frame(
    profile.id,
    current.current,
    current.current.point,
    holder.sharesRaw,
    holder.fullEaRaw,
  )
  const frames = historicalPoints.map(({ point, assetsRaw }) =>
    frame(profile.id, history, point, holder.sharesRaw, assetsRaw),
  )
  if (frames.length < 2) return null
  const donors = frames.slice(1).map((end, i) => ({
    id: `${frames[i].source.blockHash}:${end.source.blockHash}`,
    start: frames[i],
    end,
  }))
  const sourceAt = Date.parse(source.blockTime)
  const sourceAgeMs = q.asOfMs - sourceAt
  if (!Number.isSafeInteger(sourceAgeMs) || sourceAgeMs < 0 || sourceAgeMs > SOURCE_TTL_MS)
    return null
  const assetSymbol = /\[([A-Z][A-Z0-9]{0,15})\]$/.exec(profile.subject.routeKey)?.[1]
  if (!assetSymbol) return null
  const process = buildMorphoV2JointStockProjection({
    current: currentFrame,
    donors,
    fixedSharesRaw: holder.sharesRaw,
    requestedRaw: q.requestedRaw,
    horizonMs: q.horizonHours * 3600000,
    sourceAgeMs,
    marketMaximumRaw: capacity.quote.quotedMaxWithdrawRaw,
    queuedCompetingMRaw: null,
    includeSampledDuration: true,
  })
  if (!process) return null
  // The mechanical model exposes usable-only diagnostics even for excluded donors.
  // The issuer's complete headline must account for every attempted donor.
  if (process.excludedDonors.length > 0) process.descriptiveExpectedFlow.headline = null
  const result = freeze({
    status: 'conditional_morpho_v2_joint_holder_forecast' as const,
    input: {
      binding: { ...binding, executionAgreement: undefined },
      capacityAgreement: structuredClone(capacity),
      current: structuredClone(current.current),
      horizonHours: q.horizonHours,
      asOfMs: q.asOfMs,
    },
    profileId: profile.id,
    source: structuredClone(source),
    owner: binding.owner,
    sharesRaw: holder.sharesRaw,
    fullEaRaw: holder.fullEaRaw,
    asset: binding.asset,
    assetDecimals: binding.assetDecimals,
    shareDecimals: profile.subject.shareDecimals,
    requestedRaw: binding.requestedRaw,
    horizonHours: q.horizonHours,
    issueAtUtc: new Date(q.asOfMs).toISOString(),
    targetAtUtc: new Date(q.asOfMs + q.horizonHours * 3600000).toISOString(),
    assetSymbol,
    sourceProofValidUntil: new Date(sourceAt + SOURCE_TTL_MS).toISOString(),
    knowledgeCutoffUtc,
    historicalEaMethod: historical
      ? ('native_current_full_S_historical_quotes' as const)
      : ('reviewed_fixed_S_native_quotes' as const),
    historicalPastOwnershipProven: false,
    donorSemantics: 'adjacent_strictly_prior_NET_stock_changes' as const,
    attemptedDonorCount: donors.length,
    completeDonorSet:
      process.excludedDonors.length === 0 && process.scenarios.every((s) => s.status === 'usable'),
    process,
    authenticated: false,
    holderExecutableExit: false,
    forecastValidated: false,
    prospectiveValidated: false,
    calibratedProbability: false,
    sourceImplementationEquivalence: false,
  })
  const issuedQuestion = freeze(structuredClone(q))
  issued.set(result, {
    question: issuedQuestion,
    recheck: (at) =>
      Boolean(
        isMorphoV2NativeSourceValid(result.source, at) &&
        current.acceptEvidence(result.input.current) &&
        selectedMorphoV2HolderPositionEvidence(holder, { ...holderExpected, asOfMs: at }) &&
        (!historical ||
          selectedMorphoV2HistoricalHolderEaEvidence(historical, {
            ...historicalExpected,
            asOfMs: at,
          })),
      ),
  })
  return result
}
export type MorphoV2JointHolderForecast = NonNullable<ReturnType<typeof issueJoint>>
const issued = new WeakMap<
  object,
  {
    question: NonNullable<ReturnType<typeof canonicalQuestion>>['question']
    recheck: (asOfMs: number) => boolean
  }
>()

/** Raw payload flags and serialized approvals cannot substitute for either native boundary. */
export function issuedMorphoV2JointHolderForecast(
  capacityAgreement: unknown,
  executionAgreement: unknown,
  compactProtocol: unknown,
  compactHolder: unknown,
  compactHistorical: unknown,
  question: MorphoV2HolderForecastQuestion,
): MorphoV2JointHolderForecast | null {
  try {
    return issueJoint(
      capacityAgreement,
      executionAgreement,
      compactProtocol,
      compactHolder,
      compactHistorical,
      question,
    )
  } catch {
    return null
  }
}

export function morphoV2JointHolderForecastRenderWindow(value: unknown, asOfMs: number): boolean {
  if (!record(value)) return false
  const bound = issued.get(value)
  if (!bound || !Number.isSafeInteger(asOfMs)) return false
  const selected = value as unknown as MorphoV2JointHolderForecast
  return (
    asOfMs >= bound.question.asOfMs &&
    asOfMs <= Date.parse(selected.sourceProofValidUntil) &&
    asOfMs < Date.parse(selected.targetAtUtc) &&
    bound.recheck(asOfMs)
  )
}

/** Cache selection binds the complete original question; rendering only advances the clock. */
export function selectedMorphoV2JointHolderForecast(
  value: unknown,
  question: MorphoV2HolderForecastQuestion,
  asOfMs = question.asOfMs,
): MorphoV2JointHolderForecast | null {
  try {
    if (!record(value)) return null
    const bound = issued.get(value),
      selected = canonicalQuestion(question)
    if (
      !bound ||
      !selected ||
      JSON.stringify(bound.question) !== JSON.stringify(selected.question) ||
      !morphoV2JointHolderForecastRenderWindow(value, asOfMs)
    )
      return null
    return value as unknown as MorphoV2JointHolderForecast
  } catch {
    return null
  }
}

export type MorphoV2JointHolderForecastIssue = Readonly<{
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  sharesRaw: string
  fullEaRaw: string
  asset: string
  assetDecimals: number
  shareDecimals: number
  profileId: string
  block: string
  blockHash: string
  source: MorphoV2NativeSource
  independentSource?: MorphoV2NativeSource
}>
const receipts = new WeakMap<object, MorphoV2JointHolderForecast>()
export function morphoV2JointHolderForecastIssue(
  value: unknown,
): MorphoV2JointHolderForecastIssue | null {
  if (!record(value) || !issued.has(value)) return null
  const model = value as unknown as MorphoV2JointHolderForecast
  const question = issued.get(value)!.question
  const receipt = freeze({
    issuedAtMs: question.asOfMs,
    horizonHours: model.horizonHours,
    owner: model.owner,
    requestedRaw: model.requestedRaw,
    sharesRaw: model.sharesRaw,
    fullEaRaw: model.fullEaRaw,
    asset: model.asset,
    assetDecimals: model.assetDecimals,
    shareDecimals: model.shareDecimals,
    profileId: model.profileId,
    block: String(model.source.blockNumber),
    blockHash: model.source.blockHash,
    source: structuredClone(model.source),
    ...(question.independentSource
      ? { independentSource: structuredClone(question.independentSource) }
      : {}),
  })
  receipts.set(receipt, model)
  return receipt
}

export function selectedMorphoV2JointHolderForecastIssue(
  value: unknown,
  question: MorphoV2HolderForecastQuestion,
  asOfMs = question.asOfMs,
): MorphoV2JointHolderForecastIssue | null {
  if (!record(value)) return null
  const model = receipts.get(value)
  return model && selectedMorphoV2JointHolderForecast(model, question, asOfMs)
    ? (value as MorphoV2JointHolderForecastIssue)
    : null
}

/** Only the original private receipt can select its original immutable model. */
export function selectedMorphoV2JointHolderForecastFromIssue(
  value: unknown,
  question: MorphoV2HolderForecastQuestion,
  asOfMs = question.asOfMs,
): MorphoV2JointHolderForecast | null {
  if (!record(value)) return null
  const model = receipts.get(value)
  return model ? selectedMorphoV2JointHolderForecast(model, question, asOfMs) : null
}

export function morphoV2JointHolderForecastFromResponse(
  value: unknown,
  status: number,
  question: MorphoV2HolderForecastQuestion,
): MorphoV2JointHolderForecast | null {
  if (
    !record(value) ||
    ![200, 503].includes(status) ||
    (status === 503 && value.error !== 'holder_exit_assessment_unavailable')
  )
    return null
  return issuedMorphoV2JointHolderForecast(
    value.capacityAgreement,
    value.executionAgreement,
    value.morphoV2CurrentProtocolCapacityEvidence,
    value.morphoV2CurrentHolderPositionEvidence,
    value.morphoV2HistoricalHolderEaEvidence,
    question,
  )
}
export function morphoV2JointHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  question: MorphoV2HolderForecastQuestion,
): MorphoV2JointHolderForecastIssue | null {
  const model = morphoV2JointHolderForecastFromResponse(value, status, question)
  return model ? morphoV2JointHolderForecastIssue(model) : null
}
