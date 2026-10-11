import { createHash } from 'node:crypto'
import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import type { HolderExitAssessment } from './holderExitAssessment'
import { agreeMorphoV2NativeCapacity, resolveMorphoV2NativeHolderIdentity,
  selectedMorphoV2NativeCash, readMorphoV2NativeCashForAssessment } from './morphoV2NativeHolderIdentity.server'
import { buildFixedEntitlementCashOutlook, type FixedEntitlementCashInput } from './fixedEntitlementCashOutlook'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'

type Witness = { host: string; assessment: HolderExitAssessment }
/** Native S/Ea and cash independently agree at one finalized source; no rich profile required. */
export async function issueMorphoNativeCashOutlook(first: Witness, second: Witness, horizonHours: number) {
  try {
    const at = Date.now(), capacity = agreeMorphoV2NativeCapacity(first, second, at)
    if (!capacity) return null
    const identity = resolveMorphoV2NativeHolderIdentity(first.assessment,second.assessment,capacity)
    if (!identity || capacity.quote.entitlementRaw === null) return null
    const [a,b] = await Promise.all([readMorphoV2NativeCashForAssessment(first.assessment),readMorphoV2NativeCashForAssessment(second.assessment)])
    if (!a || !b || !selectedMorphoV2NativeCash(a,first.assessment) || !selectedMorphoV2NativeCash(b,second.assessment) ||
        a.cashRaw !== b.cashRaw || a.fullEaRaw !== b.fullEaRaw || a.sharesRaw !== b.sharesRaw ||
        JSON.stringify(a.source)!==JSON.stringify(b.source)) return null
    const audit = loadPinnedAudit(), history = Object.values(audit.histories).find((h:any)=>
      h.identity.routeKey===identity.routeKey && h.identity.destination===identity.destination) as ConditionalSampledCashHistory | undefined
    if (!history) return null
    const issuedAtUtc = new Date().toISOString(), readAt = a.readAtUtc > b.readAtUtc ? a.readAtUtc : b.readAtUtc
    const input: FixedEntitlementCashInput = {history,currentSource:{routeKey:identity.routeKey,destination:identity.destination,
      asset:identity.asset,assetDecimals:identity.assetDecimals,chainId:1,cashRaw:a.cashRaw,block:String(a.source.blockNumber),
      blockHash:a.source.blockHash,blockTime:a.source.blockTime,readAt,sourceKind:'live_read_only_two_origin_finalized'},
      fullEntitlementRaw:capacity.quote.entitlementRaw,requestedRaw:capacity.quote.requestedRaw,additionalCompetitionRaw:'0',horizonHours,issuedAtUtc}
    // This predicate closes over the originals. Qualification happens before any clone/transport.
    const outlook = buildFixedEntitlementCashOutlook(input, original=>original===input &&
      !!selectedMorphoV2NativeCash(a,first.assessment) && !!selectedMorphoV2NativeCash(b,second.assessment) &&
      !!resolveMorphoV2NativeHolderIdentity(first.assessment,second.assessment,capacity), text=>createHash('sha256').update(text).digest('hex'))
    return outlook ? {...outlook,owner:capacity.quote.owner,nativeSharesRaw:a.sharesRaw} : null
  } catch { return null }
}
