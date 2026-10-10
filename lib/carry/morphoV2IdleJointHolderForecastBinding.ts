/** Browser-local original model and receipt identity for descriptive idle-stock replay. */
import {
  agreeHolderExitCapacityQuotes, selectedHolderExitCapacity,
  type HolderExitCapacityAgreement, type HolderExitCapacityBinding,
} from './holderExitCapacity'
import {
  approveMorphoV2IdleHolderForecastEvidence, selectedMorphoV2IdleHolderForecastEvidence,
  morphoV2IdleBrowserDataTree, MORPHO_V2_IDLE_BROWSER_HOSTS,
  type ApprovedMorphoV2IdleHolderForecastEvidence, type MorphoV2IdleHolderForecastEvidenceExpectation,
} from './morphoV2IdleHolderForecastEvidence'
import {
  buildMorphoV2IdleJointStockProjection, MORPHO_V2_IDLE_JOINT_STOCK_POLICY,
  type MorphoV2IdleJointStockProjection, type MorphoV2IdleNativeSource,
} from './morphoV2IdleJointStockProjection'
import { resolveMorphoV2IdleTrustedProfile, type MorphoV2IdleTrustedProfile } from './morphoV2IdleTrustedProfiles'

const UINT = /^(0|[1-9][0-9]{0,77})$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const MAX_UINT = (1n << 256n) - 1n
const TTL_MS = 1800000
function record(x: unknown): x is Record<string, unknown> { return x !== null && typeof x === 'object' && !Array.isArray(x) }
function freeze<T>(x: T): T { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
function uint(x: unknown, positive = false): x is string { return typeof x === 'string' && UINT.test(x) && BigInt(x) <= MAX_UINT && (!positive || BigInt(x) > 0n) }
function utc(x: unknown): x is string { return typeof x === 'string' && Number.isSafeInteger(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x }
function own(x: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every((k) => Object.hasOwn(x, k)) && Object.keys(x).every((k) => required.includes(k) || optional.includes(k))
}
export type MorphoV2IdleJointHolderForecastQuestion = {
  routeKey: string; destination: string; requestedRaw: string; requestedAssetAddress: string
  requestedAssetDecimals: number; requestedHolderAddress: string; horizonHours: number; asOfMs: number
  independentSource?: { chainId: 1; blockNumber: number; blockHash: string; blockTime: string; finalized: true }
}
function question(value: unknown): { question: MorphoV2IdleJointHolderForecastQuestion; profile: MorphoV2IdleTrustedProfile } | null {
  if (!morphoV2IdleBrowserDataTree(value) || !record(value) || !own(value, ['routeKey', 'destination', 'requestedRaw', 'requestedAssetAddress', 'requestedAssetDecimals', 'requestedHolderAddress', 'horizonHours', 'asOfMs'], ['independentSource'])) return null
  if (typeof value.destination !== 'string' || typeof value.requestedAssetAddress !== 'string' || typeof value.requestedHolderAddress !== 'string') return null
  const destination = value.destination.toLowerCase(), asset = value.requestedAssetAddress.toLowerCase(), owner = value.requestedHolderAddress.toLowerCase()
  if (!ADDRESS.test(destination) || !ADDRESS.test(asset) || !ADDRESS.test(owner) || !uint(value.requestedRaw, true) || !Number.isSafeInteger(value.asOfMs) || !Number.isSafeInteger(value.horizonHours) || (value.horizonHours as number) <= 0 || (value.horizonHours as number) * 3600000 > MORPHO_V2_IDLE_JOINT_STOCK_POLICY.maximumHorizonMs) return null
  const profile = resolveMorphoV2IdleTrustedProfile(value.routeKey, destination, asset)
  if (!profile || value.requestedAssetDecimals !== profile.identity.assetDecimals) return null
  let independentSource: MorphoV2IdleJointHolderForecastQuestion['independentSource']
  if (Object.hasOwn(value, 'independentSource')) {
    const s = value.independentSource
    if (!record(s) || !own(s, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']) || s.chainId !== 1 || s.finalized !== true || !Number.isSafeInteger(s.blockNumber) || (s.blockNumber as number) <= 0 || typeof s.blockHash !== 'string' || !HASH.test(s.blockHash) || !utc(s.blockTime)) return null
    independentSource = structuredClone(s) as MorphoV2IdleJointHolderForecastQuestion['independentSource']
  }
  return { profile, question: freeze({ routeKey: profile.identity.routeKey, destination, requestedRaw: value.requestedRaw, requestedAssetAddress: asset, requestedAssetDecimals: profile.identity.assetDecimals, requestedHolderAddress: owner, horizonHours: value.horizonHours as number, asOfMs: value.asOfMs as number, ...(independentSource ? { independentSource } : {}) }) }
}
type Original = {
  question: MorphoV2IdleJointHolderForecastQuestion; questionKey: string
  capacity: HolderExitCapacityAgreement; capacityBinding: HolderExitCapacityBinding
  evidence: ApprovedMorphoV2IdleHolderForecastEvidence; expectation: MorphoV2IdleHolderForecastEvidenceExpectation
}
const models = new WeakMap<object, Original>()
declare const originalIdleForecast: unique symbol
export type MorphoV2IdleJointHolderForecast = Readonly<{
  status: 'conditional_morpho_v2_idle_joint_holder_forecast'; profileId: string
  question: MorphoV2IdleJointHolderForecastQuestion; issuedAtMs: number; targetAtUtc: string
  source: MorphoV2IdleNativeSource; sourceProofValidUntil: string
  owner: string; currentSharesRaw: string; currentFullEaRaw: string; currentIdleCashRaw: string
  capsuleSha256: string; verifiedHistoryAvailableAtUtc: string
  process: MorphoV2IdleJointStockProjection
  claims: MorphoV2IdleJointStockProjection['claims']; readonly [originalIdleForecast]: true
}>
export function issuedMorphoV2IdleJointHolderForecast(
  capacityAgreement: unknown, idleEvidence: unknown, suppliedQuestion: unknown, executionAgreement?: unknown,
): MorphoV2IdleJointHolderForecast | null {
  try {
    const selection = question(suppliedQuestion)
    if (!selection || !morphoV2IdleBrowserDataTree(capacityAgreement) || !record(capacityAgreement) || !Array.isArray(capacityAgreement.origins) || capacityAgreement.origins.length !== 2) return null
    if (executionAgreement !== undefined && !morphoV2IdleBrowserDataTree(executionAgreement)) return null
    const { question: q, profile } = selection, origins = capacityAgreement.origins
    if (!origins.every((x) => record(x) && typeof x.host === 'string' && MORPHO_V2_IDLE_BROWSER_HOSTS.includes(x.host as typeof MORPHO_V2_IDLE_BROWSER_HOSTS[number]))) return null
    const rebuilt = agreeHolderExitCapacityQuotes(origins[0] as { host: string; quote: unknown }, origins[1] as { host: string; quote: unknown }, q.asOfMs)
    if (!rebuilt) return null
    const native = rebuilt.quote.source
    if (q.independentSource && (q.independentSource.chainId !== native.chainId || q.independentSource.blockNumber !== native.blockNumber || q.independentSource.blockHash !== native.blockHash || q.independentSource.blockTime !== native.blockTime || q.independentSource.finalized !== native.finalized)) return null
    const capacityBinding: HolderExitCapacityBinding = { routeKey: q.routeKey, destination: q.destination, owner: q.requestedHolderAddress, requestedRaw: q.requestedRaw, asset: q.requestedAssetAddress, assetDecimals: q.requestedAssetDecimals, currentSource: structuredClone(native), asOfMs: q.asOfMs, ...(executionAgreement !== undefined ? { executionAgreement } : {}) }
    const capacity = selectedHolderExitCapacity(capacityAgreement, capacityBinding), position = capacity?.quote.sourceHolderPosition
    if (!capacity || capacity.quote.entitlementMethod !== 'preview_redeem_full_position' || !uint(capacity.quote.entitlementRaw) || !position || position.method !== 'balance_of_owner_at_source' || position.shareDecimals !== profile.identity.shareDecimals || !uint(position.sharesRaw, true) || (capacity.quote.fullPositionEntitlementRaw !== undefined && capacity.quote.fullPositionEntitlementRaw !== capacity.quote.entitlementRaw)) return null
    const source: MorphoV2IdleNativeSource = { chainId: 1, blockNumber: String(native.blockNumber), blockHash: native.blockHash, blockTime: native.blockTime, finalized: true }
    const expectation: MorphoV2IdleHolderForecastEvidenceExpectation = { profile, owner: q.requestedHolderAddress, source, sharesRaw: position.sharesRaw, fullEaRaw: capacity.quote.entitlementRaw, asOfMs: q.asOfMs }
    const evidence = approveMorphoV2IdleHolderForecastEvidence(idleEvidence, expectation)
    if (!evidence) return null
    const process = buildMorphoV2IdleJointStockProjection({ identity: structuredClone(evidence.identity), owner: evidence.owner, currentSource: structuredClone(evidence.source), currentRegime: structuredClone(evidence.regime), currentSharesRaw: evidence.currentSharesRaw, currentIdleCashRaw: evidence.currentIdleCashRaw, currentFullEaRaw: evidence.currentFullEaRaw, asOfMs: q.asOfMs, horizonMs: q.horizonHours * 3600000, requestedRaw: q.requestedRaw, competingMRaw: null, donors: [{ id: 'native_idle_paired_anchors', start: structuredClone(evidence.anchors[0]), end: structuredClone(evidence.anchors[1]) }] })
    if (!process || process.donorCount !== 1 || process.usableDonorCount !== 1 || process.censoredDonorCount !== 0 || !process.descriptive.headline) return null
    const result = freeze({ status: 'conditional_morpho_v2_idle_joint_holder_forecast', profileId: profile.id, question: q, issuedAtMs: q.asOfMs, targetAtUtc: process.targetAtUtc, source, sourceProofValidUntil: new Date(Date.parse(source.blockTime) + TTL_MS).toISOString(), owner: evidence.owner, currentSharesRaw: evidence.currentSharesRaw, currentFullEaRaw: evidence.currentFullEaRaw, currentIdleCashRaw: evidence.currentIdleCashRaw, capsuleSha256: evidence.capsuleSha256, verifiedHistoryAvailableAtUtc: evidence.verifiedHistoryAvailableAtUtc, process, claims: process.claims }) as unknown as MorphoV2IdleJointHolderForecast
    models.set(result, { question: q, questionKey: JSON.stringify(q), capacity: rebuilt, capacityBinding, evidence, expectation }); return result
  } catch { return null }
}
export function morphoV2IdleJointHolderForecastRenderWindow(value: unknown, renderAtMs: number): boolean {
  try {
    if (!record(value) || !Number.isSafeInteger(renderAtMs)) return false
    const original = models.get(value)
    if (!original || renderAtMs < original.question.asOfMs || renderAtMs >= original.question.asOfMs + original.question.horizonHours * 3600000) return false
    return Boolean(selectedHolderExitCapacity(original.capacity, { ...original.capacityBinding, asOfMs: renderAtMs }) && selectedMorphoV2IdleHolderForecastEvidence(original.evidence, { ...original.expectation, asOfMs: renderAtMs }))
  } catch { return false }
}
export function selectedMorphoV2IdleJointHolderForecast(value: unknown, suppliedQuestion: unknown, renderAtMs: number): MorphoV2IdleJointHolderForecast | null {
  try {
    const selection = question(suppliedQuestion)
    if (!selection || !record(value)) return null
    const original = models.get(value)
    return original && original.questionKey === JSON.stringify(selection.question) && morphoV2IdleJointHolderForecastRenderWindow(value, renderAtMs) ? value as unknown as MorphoV2IdleJointHolderForecast : null
  } catch { return null }
}
declare const originalIdleReceipt: unique symbol
export type MorphoV2IdleJointHolderForecastIssue = Readonly<{
  kind: 'morpho_v2_idle_joint_holder_forecast_issue_v1'; profileId: string
  issuedAtMs: number; horizonHours: number; owner: string; requestedRaw: string
  sharesRaw: string; fullEntitlementRaw: string; asset: string; assetDecimals: number; shareDecimals: number
  block: string; blockHash: string; source: MorphoV2IdleNativeSource
  independentSource?: MorphoV2IdleJointHolderForecastQuestion['independentSource']
  readonly [originalIdleReceipt]: true
}>
const receipts = new WeakMap<object, MorphoV2IdleJointHolderForecast>()
export function morphoV2IdleJointHolderForecastIssue(model: unknown): MorphoV2IdleJointHolderForecastIssue | null {
  if (!record(model) || !models.has(model)) return null
  const value = model as unknown as MorphoV2IdleJointHolderForecast, q = value.question
  const issue = freeze({ kind: 'morpho_v2_idle_joint_holder_forecast_issue_v1', profileId: value.profileId, issuedAtMs: q.asOfMs, horizonHours: q.horizonHours, owner: value.owner, requestedRaw: q.requestedRaw, sharesRaw: value.currentSharesRaw, fullEntitlementRaw: value.currentFullEaRaw, asset: q.requestedAssetAddress, assetDecimals: q.requestedAssetDecimals, shareDecimals: value.process.identity.shareDecimals, block: value.source.blockNumber, blockHash: value.source.blockHash, source: structuredClone(value.source), ...(q.independentSource ? { independentSource: structuredClone(q.independentSource) } : {}) }) as unknown as MorphoV2IdleJointHolderForecastIssue
  receipts.set(issue, value); return issue
}
export function selectedMorphoV2IdleJointHolderForecastFromIssue(issue: unknown, suppliedQuestion: unknown, renderAtMs: number): MorphoV2IdleJointHolderForecast | null {
  if (!record(issue)) return null
  const model = receipts.get(issue)
  return model ? selectedMorphoV2IdleJointHolderForecast(model, suppliedQuestion, renderAtMs) : null
}
export function selectedMorphoV2IdleJointHolderForecastIssue(issue: unknown, suppliedQuestion: unknown, renderAtMs: number): MorphoV2IdleJointHolderForecastIssue | null {
  return selectedMorphoV2IdleJointHolderForecastFromIssue(issue, suppliedQuestion, renderAtMs) ? issue as MorphoV2IdleJointHolderForecastIssue : null
}
export function morphoV2IdleJointHolderForecastFromResponse(value: unknown, status: number, suppliedQuestion: unknown): MorphoV2IdleJointHolderForecast | null {
  try {
    if (!morphoV2IdleBrowserDataTree(value) || !record(value) || (status !== 200 && !(status === 503 && value.error === 'holder_exit_assessment_unavailable')) || !Object.hasOwn(value, 'morphoV2IdleHolderForecastEvidence') || typeof value.morphoV2IdleHolderForecastEvidence !== 'string') return null
    return issuedMorphoV2IdleJointHolderForecast(value.capacityAgreement, value.morphoV2IdleHolderForecastEvidence, suppliedQuestion, value.executionAgreement)
  } catch { return null }
}
export function morphoV2IdleJointHolderForecastIssueFromResponse(value: unknown, status: number, suppliedQuestion: unknown): MorphoV2IdleJointHolderForecastIssue | null {
  const model = morphoV2IdleJointHolderForecastFromResponse(value, status, suppliedQuestion)
  return model ? morphoV2IdleJointHolderForecastIssue(model) : null
}
