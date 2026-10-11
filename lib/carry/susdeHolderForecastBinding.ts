import {
  buildSusdeHolderTimeProcess,
  buildSusdeHolderTimeProcessV2,
  type SusdeCurrentSource,
} from './susdeHolderTimeProcess'
import { matchingHolderExitViewAssessment } from './holderExitMechanicalOutlookView'
import {
  SUSDE_HOLDER_FORECAST_HORIZONS,
  type SusdeHolderForecastEnvelope,
  type SusdeHolderForecastHorizon,
  type SusdeHolderTimeProcessModel,
} from './susdeHolderForecastEnvelope'

const ROUTE = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return a === b
}
const sameSource = (a: SusdeCurrentSource, b: SusdeCurrentSource) =>
  ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'].every(
    (key) => a[key as keyof SusdeCurrentSource] === b[key as keyof SusdeCurrentSource],
  )
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}

export type SusdeHolderForecastQuestion = {
  routeKey: string
  destination: string
  requestedHolderAddress?: string | null
  requestedRaw: string | null
  requestedAssetAddress: string | null
  requestedAssetDecimals: number | null
  horizonHours: number
  asOfMs: number
  source?: SusdeCurrentSource
}
// Identity is admitted only by the owned API fetch below. JSON copies and arbitrary props fail closed.
const receipts = new WeakMap<
  object,
  {
    response: object
    coreSource: SusdeCurrentSource
    models: Map<number, SusdeHolderTimeProcessModel>
  }
>()

export function holderExitRequestCanPublish(
  controller: AbortController,
  current: AbortController | null,
) {
  return current === controller && !controller.signal.aborted
}

/** The owned finalized API's required core supplies the source frame independently of the envelope. */
export function susdeCoreAssessmentSource(
  value: unknown,
  q: SusdeHolderForecastQuestion,
): SusdeCurrentSource | null {
  try {
    if (
      q.routeKey !== ROUTE ||
      q.destination.toLowerCase() !== VAULT ||
      q.requestedAssetAddress?.toLowerCase() !== USDE ||
      q.requestedAssetDecimals !== 18
    )
      return null
    const core = matchingHolderExitViewAssessment(value, {
      routeKey: q.routeKey,
      destination: q.destination,
      owner: q.requestedHolderAddress ?? null,
      requestedRaw: q.requestedRaw,
      payoutAsset: q.requestedAssetAddress,
      horizonHours: q.horizonHours,
      asOfMs: q.asOfMs,
    })
    if (
      !core ||
      !record(value) ||
      !record(value.source) ||
      (value.source.finalized !== undefined && value.source.finalized !== true)
    )
      return null
    const condition = core.cooldownCondition,
      stages = core.stages,
      payout = core.finalPayout
    const modeMatches =
      condition &&
      (condition.exitMode === 'direct_withdrawal'
        ? condition.durationSeconds === 0 &&
          condition.initiationStatus === 'not_applicable' &&
          ['success', 'evm_revert'].includes(condition.directWithdrawalStatus ?? '') &&
          stages[0]?.name === 'withdrawal' &&
          stages[0]?.status ===
            (condition.directWithdrawalStatus === 'success' ? 'simulated' : 'reverted')
        : condition.exitMode === 'cooldown' &&
          condition.durationSeconds > 0 &&
          condition.directWithdrawalStatus === null &&
          ['success', 'evm_revert'].includes(condition.initiationStatus) &&
          stages[0]?.name === 'cooldown_initiation' &&
          stages[0]?.status ===
            (condition.initiationStatus === 'success' ? 'simulated' : 'reverted'))
    if (
      core.status !== 'partial' ||
      stages.length !== 2 ||
      !modeMatches ||
      !condition ||
      stages[0].assetAddress?.toLowerCase() !== USDE ||
      stages[0].amountRaw !== q.requestedRaw ||
      stages[0].relatedToRequest !== true ||
      stages[1].name !== 'pending_claim' ||
      stages[1].assetAddress?.toLowerCase() !== USDE ||
      stages[1].relatedToRequest !== false ||
      !['success', 'evm_revert', 'not_yet_eligible', 'no_pending_claim'].includes(
        condition.pendingClaimStatus,
      ) ||
      stages[1].status !==
        (condition.pendingClaimStatus === 'success'
          ? 'simulated'
          : condition.pendingClaimStatus === 'evm_revert'
            ? 'reverted'
            : 'unassessed') ||
      !/^\d+$/.test(condition.pendingAssetsRaw) ||
      typeof condition.aggregateSiloUsdeRaw !== 'string' ||
      !/^\d{1,78}$/.test(condition.aggregateSiloUsdeRaw) ||
      BigInt(condition.aggregateSiloUsdeRaw) > (1n << 256n) - 1n ||
      stages[1].amountRaw !== condition.pendingAssetsRaw ||
      !Number.isSafeInteger(condition.durationSeconds) ||
      condition.durationSeconds < 0 ||
      typeof condition.newRequestWouldResetPending !== 'boolean' ||
      (condition.pendingClaimEarliestAt !== null &&
        !Number.isFinite(Date.parse(condition.pendingClaimEarliestAt))) ||
      (condition.ifInitiatedAtCheckedBlockEarliestAt !== null &&
        !Number.isFinite(Date.parse(condition.ifInitiatedAtCheckedBlockEarliestAt))) ||
      payout.status !== 'unassessed' ||
      payout.amountRaw !== null
    )
      return null
    const source: SusdeCurrentSource = {
      chainId: 1,
      blockNumber: String(core.source.blockNumber),
      blockHash: core.source.blockHash.toLowerCase(),
      blockTime: core.source.blockTime,
      finalized: true,
    }
    return !q.source || sameSource(source, q.source) ? freeze(source) : null
  } catch {
    return null
  }
}

function matchesQuestion(e: SusdeHolderForecastEnvelope, q: SusdeHolderForecastQuestion) {
  return (
    q.routeKey === ROUTE &&
    q.destination.toLowerCase() === VAULT &&
    q.requestedAssetAddress?.toLowerCase() === USDE &&
    q.requestedAssetDecimals === 18 &&
    e.owner === q.requestedHolderAddress?.toLowerCase() &&
    e.originalRequestedRaw === q.requestedRaw &&
    SUSDE_HOLDER_FORECAST_HORIZONS.some((h) => h === q.horizonHours) &&
    Number.isSafeInteger(q.asOfMs) &&
    q.asOfMs >= Date.parse(e.issueAtUtc) &&
    q.asOfMs <= Date.parse(e.sourceProofValidUntil) &&
    (!q.source || sameSource(e.source, q.source))
  )
}

function isEnvelope(v: unknown): v is SusdeHolderForecastEnvelope {
  if (
    !record(v) ||
    !['susde_holder_forecast_envelope_v1', 'susde_holder_forecast_envelope_v2'].includes(
      String(v.schema),
    ) ||
    typeof v.owner !== 'string' ||
    !/^0x[a-f0-9]{40}$/.test(v.owner) ||
    typeof v.originalRequestedRaw !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(v.originalRequestedRaw) ||
    typeof v.issueAtUtc !== 'string' ||
    !Number.isSafeInteger(Date.parse(v.issueAtUtc)) ||
    typeof v.sourceProofValidUntil !== 'string' ||
    !Number.isSafeInteger(Date.parse(v.sourceProofValidUntil)) ||
    typeof v.currentReceiptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.currentReceiptSha256) ||
    !record(v.source) ||
    !record(v.inputCommon) ||
    !record(v.inputCommon.current) ||
    !record(v.modelsByHorizonHours) ||
    !Array.isArray(v.supportedHorizonHours) ||
    v.supportedHorizonHours.length !== 4 ||
    !SUSDE_HOLDER_FORECAST_HORIZONS.every((h, i) => v.supportedHorizonHours![i] === h) ||
    [
      'executable',
      'fullHolderAbility',
      'forecastValidated',
      'prospectiveValidated',
      'calibratedProbability',
    ].some((k) => v[k] !== false)
  )
    return false
  if (
    v.schema === 'susde_holder_forecast_envelope_v1'
      ? typeof v.historyCaptureSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.historyCaptureSha256) ||
        Object.hasOwn(v, 'evidenceSetSha256')
      : typeof v.evidenceSetSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.evidenceSetSha256) ||
        Object.hasOwn(v, 'historyCaptureSha256')
  )
    return false
  const e = v as unknown as SusdeHolderForecastEnvelope
  const c = e.inputCommon.current
  if (
    e.source.chainId !== 1 ||
    e.source.finalized !== true ||
    !/^[1-9][0-9]{0,77}$/.test(e.source.blockNumber) ||
    !/^0x[a-f0-9]{64}$/.test(e.source.blockHash) ||
    !Number.isSafeInteger(Date.parse(e.source.blockTime)) ||
    !sameSource(e.source, c.source) ||
    c.owner !== e.owner ||
    c.assetDecimals !== 18 ||
    c.captureReceiptSha256 !== e.currentReceiptSha256 ||
    (e.schema === 'susde_holder_forecast_envelope_v1'
      ? e.inputCommon.history.captureFileSha256 !== e.historyCaptureSha256
      : e.inputCommon.history.evidenceSetSha256 !== e.evidenceSetSha256) ||
    e.inputCommon.issueAtUtc !== e.issueAtUtc ||
    e.inputCommon.requestedRaw !== e.originalRequestedRaw ||
    e.inputCommon.analysisMode !== 'issue_time_conditional'
  )
    return false
  return SUSDE_HOLDER_FORECAST_HORIZONS.every((h) => {
    const m = e.modelsByHorizonHours[h]
    // Validate every transmitted output against the exact branch pin and entire current witness.
    const acceptCurrentEvidence = (candidate: unknown) => exact(candidate, c)
    const rebuilt =
      e.schema === 'susde_holder_forecast_envelope_v1'
        ? buildSusdeHolderTimeProcess({ ...e.inputCommon, horizonHours: h }, acceptCurrentEvidence)
        : buildSusdeHolderTimeProcessV2(
            { ...e.inputCommon, horizonHours: h },
            acceptCurrentEvidence,
          )
    if (!rebuilt) return false
    const { input: _input, ...output } = rebuilt
    return (
      exact(m, output) &&
      m?.status === 'conditional_susde_holder_funding_time_process' &&
      m.owner === e.owner &&
      m.originalRequestedRaw === e.originalRequestedRaw &&
      m.issueAtUtc === e.issueAtUtc &&
      m.sourceProofValidUntil === e.sourceProofValidUntil &&
      Date.parse(m.targetAtUtc) === Date.parse(e.issueAtUtc) + h * 3600000 &&
      m.executable === false &&
      m.fullHolderAbility === false &&
      m.forecastValidated === false &&
      m.prospectiveValidated === false &&
      m.metadata.calibratedProbability === false &&
      !!m.active?.funding?.targetSummary &&
      !!m.pending &&
      (!m.pending.applicable || !!m.pending.funding?.targetSummary) &&
      (!m.newCooldown || !!m.newCooldown.funding?.targetSummary)
    )
  })
}

/** Fetch and admit the native server issuance without recreating model or evidence authority. */
export async function fetchSusdeHolderForecastResponse(
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch('/api/carry/holder-exit-assessment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  })
  const result: unknown = await response.json()
  try {
    const e = record(result) ? result.susdeHolderForecastEnvelope : null
    const question: SusdeHolderForecastQuestion = {
      routeKey: String(body.routeKey),
      destination: String(body.destinationAddress),
      requestedHolderAddress: String(body.owner),
      requestedRaw: String(body.assetsRaw),
      requestedAssetAddress: USDE,
      requestedAssetDecimals: 18,
      horizonHours: Number(body.horizonHours),
      asOfMs: Date.now(),
    }
    const coreSource = susdeCoreAssessmentSource(result, question)
    if (
      response.status === 200 &&
      isEnvelope(e) &&
      body.chainId === 1 &&
      coreSource &&
      sameSource(e.source, coreSource) &&
      matchesQuestion(e, { ...question, source: coreSource }) &&
      !signal?.aborted
    ) {
      freeze(result)
      receipts.set(e, { response: result as object, coreSource, models: new Map() })
    }
  } catch {
    /* Optional malformed forecast leaves the core assessment usable. */
  }
  return { response, result }
}

export function selectedSusdeHolderForecast(
  value: unknown,
  question: SusdeHolderForecastQuestion,
): SusdeHolderTimeProcessModel | null {
  try {
    if (!record(value) || !receipts.has(value)) return null
    const e = value as unknown as SusdeHolderForecastEnvelope
    const { coreSource, models } = receipts.get(e)!
    if (!sameSource(e.source, coreSource) || !matchesQuestion(e, question)) return null
    if (!models.has(question.horizonHours)) {
      const h = question.horizonHours as SusdeHolderForecastHorizon
      models.set(
        h,
        freeze({
          ...e.modelsByHorizonHours[h],
          input: { ...e.inputCommon, horizonHours: h },
        }) as SusdeHolderTimeProcessModel,
      )
    }
    return models.get(question.horizonHours)!
  } catch {
    return null
  }
}

export function susdeHolderForecastIssueFromResponse(
  value: unknown,
  status: number,
  question: SusdeHolderForecastQuestion,
) {
  const e = status === 200 && record(value) ? value.susdeHolderForecastEnvelope : null
  if (!record(e) || receipts.get(e)?.response !== value) return null
  const model = selectedSusdeHolderForecast(e, question)
  if (!model) return null
  const envelope = e as SusdeHolderForecastEnvelope
  return {
    issuedAtMs: Date.parse(envelope.issueAtUtc),
    horizonHours: question.horizonHours,
    owner: envelope.owner,
    requestedRaw: envelope.originalRequestedRaw,
    block: envelope.source.blockNumber,
    blockHash: envelope.source.blockHash,
    susdeForecast: envelope,
  }
}
