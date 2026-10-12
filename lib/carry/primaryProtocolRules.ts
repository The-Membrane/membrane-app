import type { readAavePrimaryEventFacts } from './aavePrimaryEventFacts.server'
import type { RouteEventQuestion } from './routeEventContext'
type Rules = ReturnType<typeof readAavePrimaryEventFacts>
const PIN='17e896684f87f87eb65ba446fa87093647f1a953da522a8b421a4423ae7c003b'
/** Selection binding for the successful route-context response, not arbitrary JSON authenticity. */
export function selectedPrimaryProtocolRules(value: Rules|undefined,q:RouteEventQuestion,now:number) {
 try {
  if(!value||value.status!=='recorded_primary_facts'||value.schema!=='route_primary_event_facts_v1'||
    value.version!=='aave_v3_ethereum_core'||value.sourceSha256!==PIN||value.currentConfigurationKnown!==false||
    value.holderExecutableExit!==false||value.forecastValidated!==false||!['routeKey','destination','requestedRaw','payoutAsset','assetDecimals','horizonHours'].every(k=>(value.question as any)[k]===(q as any)[k]))return null
  const issued=Date.parse(value.issuedAtUtc)
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(issued)||issued>now||now-issued>1800000||
    Date.parse(value.availableAtUtc)>issued||!value.conditionalScenarios.length||value.conditionalScenarios.length>2)return null
  const seen=new Set<string>()
  for(const s of value.conditionalScenarios) {
   const e=s.sourceEvent
   if(!['paused','frozen','liquidationThresholdBps'].includes(s.parameter)||seen.has(s.parameter)||
    e.affected.routeKey!==q.routeKey||e.affected.destination!==q.destination||e.affected.asset!==q.payoutAsset||
    e.affected.assetDecimals!==q.assetDecimals||e.affected.version!==value.version||
    e.primarySource.contentSha256!==PIN||!/^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}#eventlog$/.test(e.primarySource.url)||
    Date.parse(e.availableAtUtc)>issued||Date.parse(e.occurredAtUtc)>Date.parse(e.availableAtUtc)||
    Date.parse(s.targetAtUtc)!==issued+q.horizonHours*3600000||
    s.currentConfigurationKnown!==false||s.otherProtocolChecksKnown!==false||s.causalNewsEffect!==false||s.holderExecutableExit!==false)return null
   if(s.parameter==='liquidationThresholdBps') {
    if(!/^[1-9][0-9]{0,4}$/.test(s.value)||BigInt(s.value)>10000n||e.originalArgs.liquidationThreshold!==s.value||
      s.collateralValueRule.denominatorBps!==s.value||s.collateralValueRule.numerator!=='10000'||
      s.collateralValueRule.valueUnit!=='same_quote_currency_value_not_asset_raw'||s.collateralValueRule.applicability!=='sole_collateral_standard_mode_fixed_prices'||
      s.collateralValueRule.relation!=='remaining_collateral_value_gte_debt_value_times_10000_div_threshold_bps'||
      s.borrowerStateKnown!==false||s.pricesKnown!==false||s.eModeKnown!==false||s.initialDepositUpperBoundRaw!==null||s.holderExitUpperBoundRaw!==null)return null
   } else if(typeof s.value!=='boolean'||e.originalArgs[s.parameter]!==s.value||
      s.initialDepositBlockedByThisParameter!==s.value||s.holderExitBlockedByThisParameter!==(s.parameter==='paused'&&s.value)||
      s.initialDepositUpperBoundRaw!==(s.value?'0':null)||s.holderExitUpperBoundRaw!==(s.parameter==='paused'&&s.value?'0':null))return null
   seen.add(s.parameter)
  }
  return value
 }catch{return null}
}
