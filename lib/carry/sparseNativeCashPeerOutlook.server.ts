import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { nativeCashGraphIntervalOutlook, type NativeCashGraphQuestion } from './nativeCashPeerIntervals'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'

/**
 * The issuer may reuse its original authenticated audit array to avoid a second parse.
 * Its qualifier must bind BOTH original question and array to that loader result and
 * private native receipts. A transport array or cloned selected history is not proof.
 */
export function issueSparseNativeCashPeerOutlook(
  question: NativeCashGraphQuestion,
  qualifyNativeOriginal: (original: NativeCashGraphQuestion, histories: readonly ConditionalSampledCashHistory[]) => boolean,
  originalAuthenticatedHistories?: readonly ConditionalSampledCashHistory[],
) {
  try {
    const histories=originalAuthenticatedHistories ??
      Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]
    if(!qualifyNativeOriginal(question,histories))return null
    const own=histories.find(h=>h.identity.routeKey===question.history.identity.routeKey &&
      h.identity.destination===question.history.identity.destination)
    // Injection preserves the exact selected original, not just equivalent JSON.
    if(!own || (originalAuthenticatedHistories ? own!==question.history :
      JSON.stringify(own)!==JSON.stringify(question.history)))return null
    return nativeCashGraphIntervalOutlook(question,histories,(q,hs)=>q===question && hs===histories &&
      qualifyNativeOriginal(q,hs))
  } catch { return null }
}
