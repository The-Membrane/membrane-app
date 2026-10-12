import morphoCashRegistrations from './morpho-v2-asset-identities.json'
import type { nativeCashGraphIntervalOutlook } from './nativeCashPeerIntervals'
import { matchingNativePrimaryEventImpact, type NativePrimaryEventImpact } from './nativePrimaryEventImpact'
import type { FixedEntitlementCashOutlook } from './fixedEntitlementCashOutlook'

export type NativeCashHolderModel = FixedEntitlementCashOutlook & { owner: string; nativeSharesRaw: string;
  sparsePeerOutlook?: ReturnType<typeof nativeCashGraphIntervalOutlook>
  primaryEventImpact?: NativePrimaryEventImpact | null
}
export type NativeCashHolderQuestion = {
  routeKey: string; destination: string; owner: string; requestedRaw: string
  asset: string; assetDecimals: number; horizonHours: number
  source: { blockNumber: number; blockHash: string; blockTime: string }
  asOfMs: number
}
export type NativeCashHolderOutlookIssue = Readonly<{ kind: 'native_cash_holder_outlook_receipt' }>
const receipts = new WeakMap<object, { model: NativeCashHolderModel; seal: string }>()
function matches(m: NativeCashHolderModel, q: NativeCashHolderQuestion) {
  const recovery = m.historicalRecovery, h = recovery.question, result = recovery.result
  if (JSON.stringify(h.identity) !== JSON.stringify(m.identity) ||
      JSON.stringify(h.currentSource) !== JSON.stringify(m.currentSource) || h.owner !== m.owner ||
      h.requestedRaw !== m.requestedRaw || h.fullEntitlementRaw !== m.fullEntitlementRaw ||
      h.additionalCompetitionRaw !== m.additionalCompetitionRaw || h.horizonHours !== m.horizonHours ||
      h.issuedAtUtc !== m.issuedAtUtc || recovery.forecastValidated !== false ||
      recovery.calibratedProbability !== false || recovery.holderExecutableExit !== false ||
      (result && (result.routeKey !== m.identity.routeKey + ':' + m.identity.destination ||
        result.metric !== 'cash_units' || result.amount !== 1 || result.horizonHours !== m.horizonHours ||
        result.asOf !== m.issuedAtUtc || result.realIssueAt !== m.issuedAtUtc ||
        result.issueClockBasis !== 'availability_clock' || result.scenarioAt !== null ||
        result.regimeBasis !== 'assumed_unchanged' ||
        result.forecastValidated !== false || result.holderExecutable !== false ||
        result.continuousPathKnown !== false))) return false
  const graph = m.sparsePeerOutlook
  if (graph) {
    const g = graph.question
    if (JSON.stringify(g.identity) !== JSON.stringify(m.identity) || JSON.stringify(g.currentSource) !== JSON.stringify(m.currentSource) ||
        g.owner !== m.owner || g.requestedRaw !== m.requestedRaw || g.fullEntitlementRaw !== m.fullEntitlementRaw ||
        g.additionalCompetitionRaw !== m.additionalCompetitionRaw || g.horizonHours !== m.horizonHours || g.issuedAtUtc !== m.issuedAtUtc ||
        graph.holderExecutableExit !== false || graph.forecastValidated !== false || graph.calibratedProbability !== false ||
        m.currentSource.chainId !== 1 || m.currentSource.asset !== m.identity.asset || m.currentSource.assetDecimals !== m.identity.assetDecimals) return false
    const peer = graph.peerAnalogScenarios
    if (peer) {
      if (peer.schema !== 'unconditioned_native_cash_peer_analogues_v1' ||
          peer.scope !== 'unconditioned_relative_NET_peer_analogues' ||
          peer.compatibility !== 'registered_chain1_MorphoV2_cash_inventory_same_underlying_address_and_decimals' ||
          peer.targetAtUtc !== m.process.targetAtUtc || peer.incidentConditioned !== false ||
          peer.forecastValidated !== false || peer.holderExecutableExit !== false || peer.calibratedProbability !== false ||
          peer.accounting !== 'peer_NET_already_includes_other_users_no_own_NET_blend_additional_M_separate_Q_once' ||
          !Array.isArray(peer.scenarios) || peer.scenarios.length > 96 ||
          peer.scenarios.some(p => p.peerIdentity.destination === m.identity.destination ||
            p.peerIdentity.asset !== m.identity.asset || p.peerIdentity.assetDecimals !== m.identity.assetDecimals ||
            !morphoCashRegistrations.entries.some(e => e.vault === p.peerIdentity.destination && e.asset === p.peerIdentity.asset) ||
            !/^[a-f0-9]{64}$/.test(p.sourcePointSha256) || !/^[a-f0-9]{64}$/.test(p.targetPointSha256) ||
            !Number.isSafeInteger(Date.parse(p.sourceAtUtc)) || !Number.isSafeInteger(Date.parse(p.targetAtUtc)) ||
            !Number.isSafeInteger(Date.parse(p.historyEvidence.availableAt)) ||
            Date.parse(p.sourceAtUtc) >= Date.parse(p.targetAtUtc) ||
            Date.parse(p.targetAtUtc) >= Date.parse(m.currentSource.blockTime) ||
            Date.parse(p.targetAtUtc) > Date.parse(p.historyEvidence.availableAt) ||
            Date.parse(p.historyEvidence.availableAt) > Date.parse(m.issuedAtUtc) ||
            (p.censored ? p.capacityRaw !== null || p.headroomRaw !== null : p.capacityRaw === null || p.headroomRaw === null))) return false
    }
  }
  const observedNet = m.adverseEventScenario
  if (observedNet && (JSON.stringify(observedNet.input.currentSource) !== JSON.stringify(m.currentSource) ||
      JSON.stringify(observedNet.input.history.identity) !== JSON.stringify(m.identity) ||
      observedNet.input.question.requestedRaw !== m.requestedRaw || observedNet.input.question.horizonHours !== m.horizonHours ||
      observedNet.input.question.issuedAtUtc !== m.issuedAtUtc || observedNet.causalNewsEffect !== false ||
      observedNet.calibrated !== false || observedNet.holderExecutableExit !== false)) return false
  if (m.primaryEventImpact && !matchingNativePrimaryEventImpact(m.primaryEventImpact,m)) return false
  return m.identity.routeKey === q.routeKey && m.identity.destination === q.destination.toLowerCase() &&
    m.owner.toLowerCase() === q.owner.toLowerCase() && m.requestedRaw === q.requestedRaw &&
    m.identity.asset === q.asset.toLowerCase() && m.identity.assetDecimals === q.assetDecimals &&
    m.horizonHours === q.horizonHours && m.currentSource.block === String(q.source.blockNumber) &&
    m.currentSource.blockHash === q.source.blockHash.toLowerCase() && m.currentSource.blockTime === q.source.blockTime &&
    m.forecastValidated === false && m.holderExecutableExit === false && m.calibratedProbability === false &&
    Number.isSafeInteger(q.asOfMs) && q.asOfMs >= Date.parse(m.issuedAtUtc) &&
    q.asOfMs <= Date.parse(m.process.sourceProofValidUntil) && q.asOfMs < Date.parse(m.process.targetAtUtc)
}
/** Retain the original successful API receipt against the independently requested question.
 * This browser identity guard prevents later copies/mutations from becoming an issued view;
 * server receipt qualification remains the authority for chain facts.
 */
export function retainNativeCashHolderOutlook(value: unknown, status: number, q: NativeCashHolderQuestion): NativeCashHolderOutlookIssue | null {
  try {
    if (status !== 200 || !value || typeof value !== 'object' || !matches(value as NativeCashHolderModel, q)) return null
    const model = structuredClone(value) as NativeCashHolderModel
    const issue = Object.freeze({ kind: 'native_cash_holder_outlook_receipt' as const })
    receipts.set(issue, { model, seal: JSON.stringify(model) })
    return issue
  } catch { return null }
}
export function selectedNativeCashHolderOutlook(issue: unknown, q: NativeCashHolderQuestion): NativeCashHolderModel | null {
  try {
    if (!issue || typeof issue !== 'object') return null
    const retained = receipts.get(issue)
    return retained && JSON.stringify(retained.model) === retained.seal && matches(retained.model, q) ? retained.model : null
  } catch { return null }
}
