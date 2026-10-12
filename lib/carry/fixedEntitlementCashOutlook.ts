import { buildConditionalTimeProcess, type ConditionalTimeProcessInput } from '../venueForecast/conditionalTimeProcess'
import { buildConditionalSampledCashPathProjection, type ConditionalSampledCashHistory, type ConditionalSampledCashCurrentSource } from './conditionalSampledCashPathProjection'
import { buildConditionalEventImpact } from './conditionalEventImpact'
import { fixedEntitlementHistoricalRecovery } from './fixedEntitlementHistoricalRecovery'

export type FixedEntitlementCashInput = {
  history: ConditionalSampledCashHistory
  currentSource: ConditionalSampledCashCurrentSource
  fullEntitlementRaw: string
  requestedRaw: string
  additionalCompetitionRaw: string
  horizonHours: number
  issuedAtUtc: string
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
/** Qualified fixed-Ea cash proxy. The caller must qualify original receipts before cloning. */
export function buildFixedEntitlementCashOutlook(
  input: FixedEntitlementCashInput,
  qualifyOriginal: (input: FixedEntitlementCashInput) => boolean,
  hash: (text: string) => string,
) {
  try {
    if (!input || !qualifyOriginal(input)) return null
    input = structuredClone(input)
    if (!raw(input.fullEntitlementRaw) || !raw(input.requestedRaw) || !raw(input.additionalCompetitionRaw)) return null
    const authenticated = buildConditionalSampledCashPathProjection({history: input.history,
      currentSource: input.currentSource, request: {requestedRaw: input.requestedRaw, asOf: input.issuedAtUtc}}, hash)
    if (authenticated.status !== 'estimated') return null
    const s = input.currentSource, regime = s.routeKey + ':' + s.destination
    const channels: ConditionalTimeProcessInput['channels'] = [{key:'cash',assetAddress:s.asset,
      decimals:s.assetDecimals,unit:'native_underlying_cash',negativeHandling:'clamp_zero'}]
    const approved: ConditionalTimeProcessInput = { channels,
      observations: input.history.points.map(p=>({sourceAtUtc:p[3],availableAtUtc:input.history.witness.availableAt,
        regime,channels,valuesByChannel:{cash:p[4]},provenanceRef:p[1]+':'+p[2]})),
      outputAsset:{assetAddress:s.asset,decimals:s.assetDecimals},
      measurementRule:'cash_clipped_by_qualified_full_entitlement_held_constant',
      current:{sourceAtUtc:s.blockTime,readAtUtc:s.readAt,regime,valuesByChannel:{cash:s.cashRaw},
        provenanceRef:s.block+':'+s.blockHash,fullEntitlementRaw:input.fullEntitlementRaw},
      issueAtUtc:input.issuedAtUtc,requestedRaw:input.requestedRaw,horizonHours:input.horizonHours,maxHistoricalGapSeconds:91800 }
    const competition = BigInt(input.additionalCompetitionRaw), entitlement = BigInt(input.fullEntitlementRaw)
    const process = buildConditionalTimeProcess(approved, candidate=>JSON.stringify(candidate)===JSON.stringify(approved), state=>{
      const cash = BigInt(state.cash), afterM = cash > competition ? cash-competition : 0n
      return {availableRaw:String(afterM < entitlement ? afterM : entitlement),entitlementRaw:input.fullEntitlementRaw}
    })
    if (!process) return null
    const cashNow = BigInt(s.cashRaw), afterCompetition = cashNow > competition ? cashNow-competition : 0n
    const currentCapacity = afterCompetition < entitlement ? afterCompetition : entitlement
    const currentHeadroom = currentCapacity-BigInt(input.requestedRaw)
    const shrinking = process.scenarios.filter(s=>s.targetHeadroomRaw !== null && BigInt(s.targetHeadroomRaw)<currentHeadroom).length
    const historyLast = input.history.points.at(-1)!
    const adverseEventScenario = buildConditionalEventImpact({question:{...input.history.identity,
      requestedRaw:input.requestedRaw,horizonHours:input.horizonHours,issuedAtUtc:input.issuedAtUtc},
      currentSource:input.currentSource,history:input.history})
    const adverseHeadrooms = (adverseEventScenario?.scenarios ?? []).filter(p=>p.status==='usable').map(p=>{
      const cash=BigInt(p.targetCashRaw), afterM=cash>competition?cash-competition:0n
      return (afterM<entitlement?afterM:entitlement)-BigInt(input.requestedRaw)
    }).sort((a,b)=>a<b?-1:a>b?1:0)
    const adverseHolderHeadroom = adverseHeadrooms.length ? {
      minimumRaw:String(adverseHeadrooms[0]),maximumRaw:String(adverseHeadrooms.at(-1)),
      usableScenarios:adverseHeadrooms.length,
      censoredScenarios:adverseEventScenario!.scenarios.length-adverseHeadrooms.length,
      causalNewsEffect:false as const,
    } : null
    return {schema:'fixed_entitlement_cash_outlook_v1' as const,identity:input.history.identity,
      currentSource:input.currentSource,requestedRaw:input.requestedRaw,fullEntitlementRaw:input.fullEntitlementRaw,
      additionalCompetitionRaw:input.additionalCompetitionRaw,issuedAtUtc:input.issuedAtUtc,horizonHours:input.horizonHours,
      accounting:'historical_net_cash_includes_other_users_additional_M_separate_Q_subtracted_once' as const,
      assumption:'repeat_historical_net_rates_fixed_full_entitlement_unchanged_authority_and_regime' as const,
      executionLimits:['cash_is_proxy_not_maxWithdraw','adapter_pullability_not_modeled','future_pause_gates_fees_and_share_changes_not_modeled'],
      capacityChange:{cashChangeSinceLastHistoricalSampleRaw:String(cashNow-BigInt(historyLast[4])),
        historicalSampleAtUtc:historyLast[3],currentCapacityProxyRaw:String(currentCapacity),currentHeadroomRaw:String(currentHeadroom)},
      shrinkingAlert:{status:shrinking ? 'conditional_shrinking_capacity' as const : 'no_shrink_in_usable_scenarios' as const,
        shrinkingScenarios:shrinking,usableScenarios:process.scenarios.filter(s=>s.targetHeadroomRaw!==null).length,
        censoredScenarios:process.scenarios.filter(s=>s.targetHeadroomRaw===null).length,calibrated:false as const},
      adverseEventScenario,adverseHolderHeadroom,historicalRecovery:fixedEntitlementHistoricalRecovery(input),
      process,forecastValidated:false as const,holderExecutableExit:false as const,calibratedProbability:false as const}
  } catch { return null }
}
export type FixedEntitlementCashOutlook = NonNullable<ReturnType<typeof buildFixedEntitlementCashOutlook>>
