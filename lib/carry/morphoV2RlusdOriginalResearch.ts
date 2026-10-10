/** Server-only projection of accepted original report bytes. No app authority is issued here. */
import { createHash } from 'node:crypto'
import type { MorphoV2IdleHistoricalPoint } from './morphoV2IdleNativeEvidence'
import type { MorphoV2IdleIdentity, MorphoV2IdleSource } from './morphoV2IdleTrustedProfiles'

const REPORT_SHA256 = '4eb38c922a8373f0aeb38e1a1dcb6e7a4f52b0e38380a27b60293e447fb59422'
const CAPTURE_SHARES = '3479286870294737294548835'
const IDENTITY: MorphoV2IdleIdentity = Object.freeze({
  profileId: 'rlusd-vault-v2-idle', routeKey: 'RLUSD → VaultV2 [RLUSD]',
  destination: '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf',
  asset: '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', assetDecimals: 18, shareDecimals: 18,
})
export type MorphoV2RlusdOriginalResearchFacts = Readonly<{
  schema: 'morpho_v2_rlusd_idle_research_facts_v1'; researchOnly: true; authority: false
  captureCurrentReference: MorphoV2IdleSource; captureSharesRaw: string
  anchors: readonly MorphoV2IdleHistoricalPoint[]
  actualHistoricalOwnerSharesDiagnosticRaw: readonly string[]
  historicalOwnedEntitlementAssetRaw: null; verificationCompletedAtUtc: null
}>
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
/** Exact accepted report projection; full native replay and profile registration remain separate gates. */
export function decodeMorphoV2RlusdOriginalResearch(reportText: string): MorphoV2RlusdOriginalResearchFacts {
  if (typeof reportText !== 'string' || Buffer.byteLength(reportText, 'utf8') > 128 * 1024 ||
    createHash('sha256').update(reportText).digest('hex') !== REPORT_SHA256) throw new Error('rlusd_original_report_hash')
  const report = JSON.parse(reportText)
  if (report.schema !== 'morpho_v2_rlusd_idle_holder_native_join_report_v1') throw new Error('rlusd_original_report_schema')
  // Byte commitment above fixes every source, value, runtime pin and original control result.
  const anchors: MorphoV2IdleHistoricalPoint[] = report.points.slice(1).map((point: any) => ({
    identity: IDENTITY, owner: point.owner, source: point.source,
    regime: { kind: 'zero_adapter_idle', liquidityAdapter: point.liquidityAdapter, liquidityData: '0x',
      vaultRuntimeCodeHash: point.runtimes.vault.runtimeKeccak256,
      assetRuntimeCodeHash: point.runtimes.asset.runtimeKeccak256 },
    idleCashRaw: point.CAssetRaw,
    // Actual old stock is diagnostic only; no historical owned entitlement is asserted.
    historicalOwnerSharesRaw: null,
    fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares', source: point.source,
      probeSharesRaw: CAPTURE_SHARES, asset: IDENTITY.asset, assetDecimals: 18, shareDecimals: 18,
      assetsRaw: point.probeEaAssetRaw },
  }))
  return freeze({ schema: 'morpho_v2_rlusd_idle_research_facts_v1', researchOnly: true, authority: false,
    captureCurrentReference: report.currentSource, captureSharesRaw: CAPTURE_SHARES, anchors,
    actualHistoricalOwnerSharesDiagnosticRaw: report.points.slice(1).map((point: any) => point.actualOwnerSharesRaw),
    historicalOwnedEntitlementAssetRaw: null, verificationCompletedAtUtc: null })
}

/** Root readback provenance is separate from plain facts and grants no branded authority. */
export type MorphoV2RlusdRootVerification = Readonly<{
  schema: 'morpho_v2_rlusd_root_readback_v1'
  facts: MorphoV2RlusdOriginalResearchFacts
  originalPins: Readonly<{
    acceptanceManifestSha256: '4cbbb38337023d2212f250349c8e2bc12ff2e77205e5cf7f56b62847171127a0'
    reportSha256: '4eb38c922a8373f0aeb38e1a1dcb6e7a4f52b0e38380a27b60293e447fb59422'
    terminalSha256: 'e99907118fd622241bf3247bd313bb9f35d44168157ab81acdf002bdc8ca5bda'
    provenanceSha256: '9cdca6666dd55bbd38da0b0d431917759a066efa382aa73cc9124f538b0a338b'
  }>
  captureAvailability: Readonly<{
    nativeAcquisitionCompletedAtUtc: '2026-10-10T11:09:10.227Z'
    preTerminalRetentionCheckedAtUtc: '2026-10-10T11:09:10.983Z'
    // Native artifact availability from the accepted proof; not replay or root completion.
    finalArtifactAvailabilityAtUtc: '2026-10-10T11:09:11.001Z'
    availabilityProof: Readonly<{
      file: 'accepted/rlusd-native-holder-capture-parent-oct10-e9910769-5af3-4356-a433-4297081b467e-proof.json'
      sha256: '3f7784e346e56f8804c078f50cdd48a871c360d24675d025a4214889da3a2c0d'
      pointer: '/result/postRetentionCompletedAtUtc'
    }>
  }>
  rootReadback: Readonly<{
    normalizedFactsBytes: number; normalizedFactsSha256: string
    completedAtUtc: string; verificationKind: 'local_original_bytes_and_closure_readback'
  }>
  researchOnly: true; authority: false
}>
