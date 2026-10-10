/** Server issuance requires original archive replay and a completed privately bound fresh read. */
import { createHash } from 'node:crypto'
import { encodeMorphoV2IdleHolderForecastEvidence } from './morphoV2IdleHolderForecastEvidence'
import { isOriginalMorphoV2IdleNativeHistory, type MorphoV2IdleNativeHistory } from './morphoV2IdleNativeEvidence'
import {
  selectedMorphoV2IdleNativeRead, type MorphoV2IdleNativeRead, type MorphoV2IdleHolderRequest,
} from './morphoV2IdleNativeReader.server'
import { isAppOwnedMorphoV2IdleTrustedProfile, MORPHO_V2_IDLE_CLAIMS, type MorphoV2IdleTrustedProfile } from './morphoV2IdleTrustedProfiles'
import { isOriginalMorphoV2IdleCompactPanel, type OriginalMorphoV2IdleCompactPanel } from './morphoV2IdleCompactPanel.server'
import { encodeMorphoV2IdlePanelHolderForecastEvidence } from './morphoV2IdleCompactPanelEvidence'
import { selectedMorphoV2IdleNativePanelRead, type MorphoV2IdleNativePanelRead } from './morphoV2IdleNativeReader.server'

export const MORPHO_V2_IDLE_PINNED_CAPSULE = Object.freeze({ bytes: 3926,
  sha256: '880b5424feaf11b8301bdbd560fde261999a31696acac7dccb039fbccc5ddfc6',
  maxBytes: 64 * 1024, maxEnvelopeBytes: 256 * 1024,
})
function dataProperties(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return required.every(key => descriptors[key] && Object.hasOwn(descriptors[key], 'value')) &&
    optional.every(key => !descriptors[key] || Object.hasOwn(descriptors[key], 'value'))
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
/** Regenerate from original history, never a temporary file, approval flag or supplied capsule. */
export function morphoV2IdlePinnedHistoricalCapsule(profile: MorphoV2IdleTrustedProfile, history: MorphoV2IdleNativeHistory): string | null {
  try {
    if (!isAppOwnedMorphoV2IdleTrustedProfile(profile) || !isOriginalMorphoV2IdleNativeHistory(history, profile)) return null
    const text = JSON.stringify({ schemaVersion: 1, kind: 'morpho_v2_idle_pinned_historical_capsule_v1', profileId: profile.id,
      identity: history.identity, captureSharesRaw: history.captureSharesRaw, captureOwner: history.captureOwner, anchors: history.anchors,
      provenance: { nativeTerminalFileSha256: profile.history.terminalFileSha256, nativeReportFileSha256: profile.history.reportFileSha256,
        sourceCompanionManifestSha256: profile.history.companionManifestSha256, verifiedReplayCompletedAtUtc: history.provenance.verifiedReplayCompletedAtUtc,
        ...(profile.history.kind === 'rlusd_acceptance_v1' ? { historyAvailableAtUtc: history.provenance.historyAvailableAtUtc, captureAvailableAtUtc: history.provenance.captureAvailableAtUtc,
          rootNormalizationCompletedAtUtc: profile.history.rootNormalizationCompletedAtUtc, independentReplayCompletedAtUtc: null } : {}) },
      claims: MORPHO_V2_IDLE_CLAIMS })
    return Buffer.byteLength(text) === profile.history.capsule.bytes && createHash('sha256').update(text).digest('hex') === profile.history.capsule.sha256 ? text : null
  } catch { return null }
}
export type MorphoV2IdleHolderForecastIssueInput = {
  profile: MorphoV2IdleTrustedProfile; history: MorphoV2IdleNativeHistory; nativeRead: MorphoV2IdleNativeRead
  request: MorphoV2IdleHolderRequest; capacityAgreement: unknown; executionAgreement?: unknown; horizonHours: number
}
declare const issueBrand: unique symbol
export type MorphoV2IdleServerHolderForecastIssue = Readonly<{
  evidenceText: string; issuedAtMs: number; horizonHours: number; request: MorphoV2IdleHolderRequest
  supplementalStarts: number; sdkPhysicalStarts: null; claims: typeof MORPHO_V2_IDLE_CLAIMS
  readonly [issueBrand]: true
}>
const issued = new WeakMap<object, MorphoV2IdleHolderForecastIssueInput>()
/** Issue time is measured after native work, canonical encoding and a final source-age check. */
export function issueMorphoV2IdleHolderForecast(input: MorphoV2IdleHolderForecastIssueInput): MorphoV2IdleServerHolderForecastIssue | null {
  try {
    if (!dataProperties(input, ['profile', 'history', 'nativeRead', 'request', 'capacityAgreement', 'horizonHours'], ['executionAgreement'])) return null
    const horizonHours = input.horizonHours
    if (!Number.isSafeInteger(horizonHours) || horizonHours <= 0 || horizonHours > 168) return null
    const selectionAtMs = Date.now()
    const selected = selectedMorphoV2IdleNativeRead(input.nativeRead, { profile: input.profile, history: input.history, request: input.request, capacityAgreement: input.capacityAgreement, executionAgreement: input.executionAgreement, asOfMs: selectionAtMs })
    const capsuleText = morphoV2IdlePinnedHistoricalCapsule(input.profile, input.history)
    if (!selected || !capsuleText) return null
    const evidenceText = encodeMorphoV2IdleHolderForecastEvidence({ schema: 'morpho_v2_idle_holder_forecast_evidence_v1',
      capsuleText, current: selected.current, historicalPreviewSupplement: selected.historicalPreviewSupplement })
    if (!evidenceText || Buffer.byteLength(evidenceText) > MORPHO_V2_IDLE_PINNED_CAPSULE.maxEnvelopeBytes) return null
    // Prepare every private snapshot before capturing the issue clock.
    const request = freeze(structuredClone(input.request)), snapshot = freeze({ profile: input.profile, history: input.history, nativeRead: selected,
      request, capacityAgreement: freeze(structuredClone(input.capacityAgreement)),
      ...(input.executionAgreement === undefined ? {} : { executionAgreement: freeze(structuredClone(input.executionAgreement)) }), horizonHours })
    const issuedAtMs = Date.now()
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < selectionAtMs || !selectedMorphoV2IdleNativeRead(selected, { profile: snapshot.profile, history: snapshot.history, request: snapshot.request,
      capacityAgreement: snapshot.capacityAgreement, executionAgreement: snapshot.executionAgreement, asOfMs: issuedAtMs })) return null
    const result = freeze({ evidenceText, issuedAtMs, horizonHours, request,
      supplementalStarts: selected.supplementalStarts, sdkPhysicalStarts: null, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleServerHolderForecastIssue
    const finalizedAtMs = Date.now()
    if (!Number.isSafeInteger(finalizedAtMs) || finalizedAtMs < issuedAtMs || !selectedMorphoV2IdleNativeRead(selected, {
      profile: snapshot.profile, history: snapshot.history, request: snapshot.request, capacityAgreement: snapshot.capacityAgreement,
      executionAgreement: snapshot.executionAgreement, asOfMs: finalizedAtMs })) return null
    issued.set(result, snapshot)
    return result
  } catch { return null }
}
/** Server original identity is local; JSON transport cannot mint a server receipt or authority. */
export function selectedMorphoV2IdleServerHolderForecastIssue(value: unknown, expected: MorphoV2IdleHolderForecastIssueInput, asOfMs = Date.now()): MorphoV2IdleServerHolderForecastIssue | null {
  try {
    if (!value || typeof value !== 'object' || !dataProperties(expected, ['profile', 'history', 'nativeRead', 'request', 'capacityAgreement', 'horizonHours'], ['executionAgreement'])) return null
    const original = issued.get(value), issue = value as MorphoV2IdleServerHolderForecastIssue
    if (!original || original.profile !== expected.profile || original.history !== expected.history || original.nativeRead !== expected.nativeRead ||
      original.horizonHours !== expected.horizonHours ||
      !Number.isSafeInteger(asOfMs) || asOfMs < issue.issuedAtMs || asOfMs - issue.issuedAtMs > 1_800_000) return null
    return selectedMorphoV2IdleNativeRead(original.nativeRead, { profile: expected.profile, history: expected.history, request: expected.request, capacityAgreement: expected.capacityAgreement, executionAgreement: expected.executionAgreement, asOfMs }) ? issue : null
  } catch { return null }
}

export type MorphoV2IdlePanelHolderForecastIssueInput = {
  profile: MorphoV2IdleTrustedProfile; panel: OriginalMorphoV2IdleCompactPanel; nativeRead: MorphoV2IdleNativePanelRead
  request: MorphoV2IdleHolderRequest; capacityAgreement: unknown; executionAgreement?: unknown; horizonHours: number
}
declare const panelIssueBrand: unique symbol
export type MorphoV2IdleServerPanelHolderForecastIssue = Readonly<{
  evidenceText: string; issuedAtMs: number; horizonHours: number; request: MorphoV2IdleHolderRequest
  supplementalStarts: 32; sdkPhysicalStarts: null; claims: typeof MORPHO_V2_IDLE_CLAIMS
  readonly [panelIssueBrand]: true
}>
const panelIssued = new WeakMap<object, MorphoV2IdlePanelHolderForecastIssueInput>()
/** Exact pinned panel + original fresh current read. Conditional historical rates mint no execution claim. */
export function issueMorphoV2IdlePanelHolderForecast(input: MorphoV2IdlePanelHolderForecastIssueInput): MorphoV2IdleServerPanelHolderForecastIssue | null {
  try {
    if (!dataProperties(input, ['profile', 'panel', 'nativeRead', 'request', 'capacityAgreement', 'horizonHours'], ['executionAgreement']) || !isOriginalMorphoV2IdleCompactPanel(input.panel, input.profile)) return null
    const horizonHours = input.horizonHours
    if (!Number.isSafeInteger(horizonHours) || horizonHours <= 0 || horizonHours > 168) return null
    const selectionAtMs = Date.now()
    const selected = selectedMorphoV2IdleNativePanelRead(input.nativeRead, { profile: input.profile, panel: input.panel, request: input.request, capacityAgreement: input.capacityAgreement, executionAgreement: input.executionAgreement, asOfMs: selectionAtMs })
    if (!selected) return null
    const evidenceText = encodeMorphoV2IdlePanelHolderForecastEvidence({ schema: 'morpho_v2_idle_holder_forecast_evidence_v2', panelText: input.panel.text, current: selected.current })
    if (!evidenceText || Buffer.byteLength(evidenceText) > MORPHO_V2_IDLE_PINNED_CAPSULE.maxEnvelopeBytes) return null
    const request = freeze(structuredClone(input.request)), snapshot = freeze({ profile: input.profile, panel: input.panel, nativeRead: selected, request,
      capacityAgreement: freeze(structuredClone(input.capacityAgreement)), ...(input.executionAgreement === undefined ? {} : { executionAgreement: freeze(structuredClone(input.executionAgreement)) }), horizonHours })
    const issuedAtMs = Date.now()
    const expected = { profile: snapshot.profile, panel: snapshot.panel, request: snapshot.request, capacityAgreement: snapshot.capacityAgreement, executionAgreement: snapshot.executionAgreement }
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < selectionAtMs || !selectedMorphoV2IdleNativePanelRead(selected, { ...expected, asOfMs: issuedAtMs })) return null
    const result = freeze({ evidenceText, issuedAtMs, horizonHours, request, supplementalStarts: 32, sdkPhysicalStarts: null, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleServerPanelHolderForecastIssue
    const finalizedAtMs = Date.now()
    if (!Number.isSafeInteger(finalizedAtMs) || finalizedAtMs < issuedAtMs || !selectedMorphoV2IdleNativePanelRead(selected, { ...expected, asOfMs: finalizedAtMs })) return null
    panelIssued.set(result, snapshot); return result
  } catch { return null }
}
export function selectedMorphoV2IdleServerPanelHolderForecastIssue(value: unknown, expected: MorphoV2IdlePanelHolderForecastIssueInput, asOfMs = Date.now()): MorphoV2IdleServerPanelHolderForecastIssue | null {
  try {
    if (!value || typeof value !== 'object' || !dataProperties(expected, ['profile', 'panel', 'nativeRead', 'request', 'capacityAgreement', 'horizonHours'], ['executionAgreement'])) return null
    const original = panelIssued.get(value), issue = value as MorphoV2IdleServerPanelHolderForecastIssue
    if (!original || original.profile !== expected.profile || original.panel !== expected.panel || original.nativeRead !== expected.nativeRead || original.horizonHours !== expected.horizonHours || !Number.isSafeInteger(asOfMs) || asOfMs < issue.issuedAtMs || asOfMs - issue.issuedAtMs > 1800000) return null
    return selectedMorphoV2IdleNativePanelRead(original.nativeRead, { profile: expected.profile, panel: expected.panel, request: expected.request, capacityAgreement: expected.capacityAgreement, executionAgreement: expected.executionAgreement, asOfMs }) ? issue : null
  } catch { return null }
}
