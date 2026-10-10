import { isDeepStrictEqual } from 'node:util'

import {
  issueSusdeCurrentProtocolCapacityEvidence,
  replaySusdeCurrentProtocolCapacityEvidence,
  type SusdeCurrentProtocolCapacityEvidence,
  type SusdeProtocolExpected,
} from '../susdeCurrentProtocolCapacity'
import {
  buildSusdeHolderTimeProcess,
  buildSusdeHolderTimeProcessV2,
} from '../susdeHolderTimeProcess'
import { freezeSusde, susdePinnedJointHistory } from '../susdeJointHistoryPins'
import { susdePinnedJointHistoryEvidenceSet } from '../susdeJointHistoryEvidenceSet'
import {
  SUSDE_HOLDER_FORECAST_HORIZONS,
  type SusdeHolderForecastEnvelopeV1,
  type SusdeHolderForecastEnvelopeV2,
} from '../susdeHolderForecastEnvelope'

// Never populate this set with replayed JSON or a caller's success flag/self hash.
const issuedCompactEvidence = new WeakSet<object>()

/** Default denial: only the authenticated native-origin issuance path below can authorize. */
export function issueSusdeHolderForecastEnvelope(
  evidence: unknown,
  expected: SusdeProtocolExpected,
  origins: readonly string[],
  issueAtMs: number,
): SusdeHolderForecastEnvelopeV1 | null {
  try {
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      !issuedCompactEvidence.has(evidence) ||
      !Number.isSafeInteger(issueAtMs)
    )
      return null
    // This native compact object's acquisition/issuance clock is immutable, including on reuse.
    if (
      (evidence as SusdeCurrentProtocolCapacityEvidence).availableAtUtc !==
      new Date(issueAtMs).toISOString()
    )
      return null
    const current = replaySusdeCurrentProtocolCapacityEvidence(
      evidence,
      expected,
      origins,
      issueAtMs,
    )
    if (!current) return null
    const approved = freezeSusde(structuredClone(current)),
      acceptCurrentEvidence = (candidate: unknown) => isDeepStrictEqual(candidate, approved),
      issueAtUtc = new Date(issueAtMs).toISOString(),
      history = susdePinnedJointHistory(),
      models = {} as SusdeHolderForecastEnvelopeV1['modelsByHorizonHours']
    for (const horizonHours of SUSDE_HOLDER_FORECAST_HORIZONS) {
      const model = buildSusdeHolderTimeProcess(
        {
          current,
          history,
          requestedRaw: expected.requestedRaw,
          issueAtUtc,
          horizonHours,
          analysisMode: 'issue_time_conditional',
        },
        acceptCurrentEvidence,
      )
      if (!model) return null
      // Full native evidence is retained once in the immutable envelope binding.
      const { input: _input, ...publicModel } = model
      ;(models as Record<number, typeof publicModel>)[horizonHours] = publicModel
    }
    return freezeSusde({
      schema: 'susde_holder_forecast_envelope_v1',
      owner: current.owner,
      originalRequestedRaw: expected.requestedRaw,
      source: structuredClone(current.source),
      issueAtUtc,
      sourceProofValidUntil: models[1].sourceProofValidUntil,
      currentReceiptSha256: current.captureReceiptSha256,
      historyCaptureSha256: history.captureFileSha256,
      supportedHorizonHours: [...SUSDE_HOLDER_FORECAST_HORIZONS],
      inputCommon: {
        current,
        history,
        requestedRaw: expected.requestedRaw,
        issueAtUtc,
        analysisMode: 'issue_time_conditional',
      },
      modelsByHorizonHours: models,
      executable: false,
      fullHolderAbility: false,
      forecastValidated: false,
      prospectiveValidated: false,
      calibratedProbability: false,
    })
  } catch {
    return null
  }
}

/** Native observations are accepted only by the producer's process-private client association. */
export function issueSusdeHolderForecastFromNativeOrigins(
  nativeOrigins: Parameters<typeof issueSusdeCurrentProtocolCapacityEvidence>[0],
  expected: SusdeProtocolExpected,
  issueAtMs: number,
): {
  evidence: SusdeCurrentProtocolCapacityEvidence
  envelope: SusdeHolderForecastEnvelopeV1
} | null {
  try {
    const evidence = issueSusdeCurrentProtocolCapacityEvidence(nativeOrigins, expected, issueAtMs)
    if (!evidence) return null
    issuedCompactEvidence.add(evidence)
    const envelope = issueSusdeHolderForecastEnvelope(
      evidence,
      expected,
      nativeOrigins.map((entry) => entry.origin),
      issueAtMs,
    )
    return envelope ? freezeSusde({ evidence, envelope }) : null
  } catch {
    return null
  }
}

/** Current v2 issuance requires the same process-private native evidence authority. */
export function issueSusdeHolderForecastEnvelopeV2(
  evidence: unknown,
  expected: SusdeProtocolExpected,
  origins: readonly string[],
  issueAtMs: number,
): SusdeHolderForecastEnvelopeV2 | null {
  try {
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      !issuedCompactEvidence.has(evidence) ||
      !Number.isSafeInteger(issueAtMs)
    )
      return null
    // This native compact object's acquisition/issuance clock is immutable, including on reuse.
    if (
      (evidence as SusdeCurrentProtocolCapacityEvidence).availableAtUtc !==
      new Date(issueAtMs).toISOString()
    )
      return null
    const current = replaySusdeCurrentProtocolCapacityEvidence(
      evidence,
      expected,
      origins,
      issueAtMs,
    )
    if (!current) return null
    const approved = freezeSusde(structuredClone(current)),
      acceptCurrentEvidence = (candidate: unknown) => isDeepStrictEqual(candidate, approved),
      issueAtUtc = new Date(issueAtMs).toISOString(),
      history = susdePinnedJointHistoryEvidenceSet(),
      models = {} as SusdeHolderForecastEnvelopeV2['modelsByHorizonHours']
    for (const horizonHours of SUSDE_HOLDER_FORECAST_HORIZONS) {
      const model = buildSusdeHolderTimeProcessV2(
        {
          current,
          history,
          requestedRaw: expected.requestedRaw,
          issueAtUtc,
          horizonHours,
          analysisMode: 'issue_time_conditional',
        },
        acceptCurrentEvidence,
      )
      if (!model) return null
      // Full native evidence is retained once in the immutable envelope binding.
      const { input: _input, ...publicModel } = model
      ;(models as Record<number, typeof publicModel>)[horizonHours] = publicModel
    }
    return freezeSusde({
      schema: 'susde_holder_forecast_envelope_v2',
      owner: current.owner,
      originalRequestedRaw: expected.requestedRaw,
      source: structuredClone(current.source),
      issueAtUtc,
      sourceProofValidUntil: models[1].sourceProofValidUntil,
      currentReceiptSha256: current.captureReceiptSha256,
      evidenceSetSha256: history.evidenceSetSha256,
      supportedHorizonHours: [...SUSDE_HOLDER_FORECAST_HORIZONS],
      inputCommon: {
        current,
        history,
        requestedRaw: expected.requestedRaw,
        issueAtUtc,
        analysisMode: 'issue_time_conditional',
      },
      modelsByHorizonHours: models,
      executable: false,
      fullHolderAbility: false,
      forecastValidated: false,
      prospectiveValidated: false,
      calibratedProbability: false,
    })
  } catch {
    return null
  }
}

/** Native observations are accepted only by the producer's process-private client association. */
export function issueSusdeHolderForecastV2FromNativeOrigins(
  nativeOrigins: Parameters<typeof issueSusdeCurrentProtocolCapacityEvidence>[0],
  expected: SusdeProtocolExpected,
  issueAtMs: number,
): {
  evidence: SusdeCurrentProtocolCapacityEvidence
  envelope: SusdeHolderForecastEnvelopeV2
} | null {
  try {
    const evidence = issueSusdeCurrentProtocolCapacityEvidence(nativeOrigins, expected, issueAtMs)
    if (!evidence) return null
    issuedCompactEvidence.add(evidence)
    const envelope = issueSusdeHolderForecastEnvelopeV2(
      evidence,
      expected,
      nativeOrigins.map((entry) => entry.origin),
      issueAtMs,
    )
    return envelope ? freezeSusde({ evidence, envelope }) : null
  } catch {
    return null
  }
}
