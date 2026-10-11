import { requiredPinnedForecastArtifact } from './pinnedForecastArtifacts'
export type StusdsProtocolPoint = {
  source:{chainId:1;blockNumber:string;blockHash:string;blockTime:string;finalized:boolean}
  status:string;addresses:Record<string,string>;ilk:string;runtimeIdentities:Record<string,unknown>
  globalProngs:Record<'totalSupplyRaw'|'chiRaw'|'strRaw'|'rhoUnix'|'chiNowRaw'|'vatArtRaw'|'vatStoredRateRaw'|'jugDutyRaw'|'jugRhoUnix'|'jugBaseRaw'|'burnRateNowRaw'|'clipDueRaw',string> & {
    units:unknown;method:string;unusedFundsBurnRaw:string;unusedFundsGetterRaw:string|null;getterRateBasis:string;
    sourceRuleEquivalence:string;retainedImplementationMatches:boolean;derivationEligibility:string }
  holderQuote?:unknown;missingLegs:unknown[];sourceImplementationEquivalence:false;holderExecutableExit:false;forecastValidated:false
}
type Artifact={captureReceiptSha256:string;knowledgeCutoff:string;asset:string;assetDecimals:number;
  history:{points:StusdsProtocolPoint[];elapsedSeconds:number[]};current:StusdsProtocolPoint}
const evidence=()=>requiredPinnedForecastArtifact<Artifact>('stusds-historical-capacity-2026-10-07T14-29.export.json')
function freeze<T>(v:T):T {if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
export const STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN=Object.freeze({
  exportFileSha256:'f4b1ec1130f300d43e0ec7d0a60f9f18c4c17b2580a32460f8d5add533bd08fe',
  rawFileSha256:'525aa24f506c23d91d7c74c27215c0fee73f04ccbfcca3c8f2312c42e118a294',
  get captureReceiptSha256(){return evidence().captureReceiptSha256}, get knowledgeCutoff(){return evidence().knowledgeCutoff},
  get asset(){return evidence().asset},get assetDecimals(){return evidence().assetDecimals},get history(){return freeze(evidence().history)},
})
export function stusdsPinnedProtocolHistory(){return {...STUSDS_PROTOCOL_CAPACITY_HISTORY_PIN}}
