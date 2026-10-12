import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { nativeCashGraphIntervalOutlook, type NativeCashGraphQuestion } from './nativeCashPeerIntervals'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'

/** Qualification closes over original native receipts; no HTTP evidence or cloned receipts enter here. */
export function issueSparseNativeCashPeerOutlook(
  question: NativeCashGraphQuestion,
  qualifyNativeOriginal: (original: NativeCashGraphQuestion) => boolean,
) {
  try {
    if(!qualifyNativeOriginal(question))return null
    const audit=loadPinnedAudit()
    const histories=Object.values(audit.histories) as ConditionalSampledCashHistory[]
    // The loader validates immutable byte pins, identity, availability and all retained source anchors.
    const own=histories.find(h=>h.identity.routeKey===question.history.identity.routeKey &&
      h.identity.destination===question.history.identity.destination)
    if(!own || JSON.stringify(own)!==JSON.stringify(question.history))return null
    return nativeCashGraphIntervalOutlook(question,histories,(q,hs)=>q===question && hs===histories &&
      qualifyNativeOriginal(q) && Object.values(audit.histories).includes(own))
  } catch { return null }
}
