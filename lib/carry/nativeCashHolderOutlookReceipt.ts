import type { FixedEntitlementCashOutlook } from './fixedEntitlementCashOutlook'

export type NativeCashHolderModel = FixedEntitlementCashOutlook & { owner: string; nativeSharesRaw: string }
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
