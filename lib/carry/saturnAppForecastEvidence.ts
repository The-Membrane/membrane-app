import { sha256, stringToHex } from 'viem'
import { buildSaturnHistoricalConversionProjection, type SaturnConversionCurrent, type SaturnConversionHistory, type SaturnHistoricalConversionProjection } from './saturnHistoricalConversionProjection'
import { SATURN_ORIGINAL_CONVERSION_PROFILE as P } from './saturnOriginalConversionProfile'
const ROUTE='AUSD → Staked USDat [USDat]',VAULT='0xd166337499e176bbc38a1fbd113ab144e5bd2df7',AUSD='0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
export type SaturnForecastQuestion={routeKey:string;
  destination:string;
  owner:string;
  requestedRaw:string;
  horizonHours:number;
  ticketId:string|null;
  asOfMs:number}
export type SaturnForecastEnvelope={schema:'saturn_exact_size_native_quote_forecast_v1';
  originalCaptureSha256:string;
  issuedAtMs:number;
  question:SaturnForecastQuestion;
  origins:readonly [SaturnNativeQuoteOrigin,SaturnNativeQuoteOrigin]}
export type SaturnNativeQuoteOrigin={host:string;
  current:SaturnConversionCurrent;
  history:SaturnConversionHistory;
  queueFacts:{vaultCashUsdatRaw:string;
  queueCashUsdatRaw:string;
  change:{priorSource:SaturnConversionCurrent['point']['source'];
  priorVaultCashUsdatRaw:string;
  periodMs:number;
  netVaultCashDeltaRaw:string}|null;
  source:SaturnConversionCurrent['point']['source']};
  ownedTicket:boolean}
/** Traverse plain JSON data without invoking accessors or serialization hooks. */
function canonicalStructuralJson(value: unknown): string {
  let entries = 0, characters = 0
  const active = new Set<object>()
  const emit = (text: string | undefined): string => {
    if (typeof text !== 'string' || (characters += text.length) > 131072)
      throw new Error('saturn_structural_bound')
    return text
  }
  const visit = (item: unknown, depth: number): string => {
    if (++entries > 8192 || depth > 32) throw new Error('saturn_structural_bound')
    if (item === null || typeof item === 'boolean') return emit(JSON.stringify(item))
    if (typeof item === 'string') {
      if (item.length > 131072) throw new Error('saturn_structural_bound')
      return emit(JSON.stringify(item))
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('saturn_structural_nonfinite')
      return emit(JSON.stringify(item))
    }
    if (typeof item !== 'object') throw new Error('saturn_structural_non_json')
    if (active.has(item)) throw new Error('saturn_structural_cycle')
    const prototype = Object.getPrototypeOf(item)
    const array = Array.isArray(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error('saturn_structural_prototype')
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(item, 'length')
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 256)
        throw new Error('saturn_structural_array')
    }
    const keys = Reflect.ownKeys(item)
    if (keys.some(key => typeof key !== 'string')) throw new Error('saturn_structural_symbol')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key as string], 'value')))
      throw new Error('saturn_structural_accessor')
    active.add(item)
    try {
      const parts: string[] = []
      if (array) {
        const length = descriptors.length.value
        if (keys.length !== length + 1) throw new Error('saturn_structural_array')
        parts.push(emit('['))
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !descriptor.enumerable) throw new Error('saturn_structural_array')
          if (index) parts.push(emit(','))
          parts.push(visit(descriptor.value, depth + 1))
        }
        parts.push(emit(']'))
      } else {
        if (keys.length > 128) throw new Error('saturn_structural_bound')
        parts.push(emit('{'))
        const sorted = (keys as string[]).sort()
        for (let index = 0; index < sorted.length; index++) {
          const key = sorted[index]
          if (index) parts.push(emit(','))
          parts.push(emit(JSON.stringify(key)), emit(':'), visit(descriptors[key].value, depth + 1))
        }
        parts.push(emit('}'))
      }
      // Only primitive strings are joined; no object or array is passed to JSON.stringify.
      return parts.join('')
    } finally { active.delete(item) }
  }
  return visit(value, 0)
}
const same = (a: unknown, b: unknown): boolean => {
  try { return canonicalStructuralJson(a) === canonicalStructuralJson(b) }
  catch { return false }
}
export const saturnNativeEvidenceDigest=(v:unknown)=>sha256(stringToHex(JSON.stringify(v))).slice(2)
const objects=new WeakMap<object,{envelope:SaturnForecastEnvelope;
  model:SaturnAppForecast}>(),receipts=new WeakMap<object,SaturnAppForecast>()
export type SaturnAppForecast=Readonly<{question:SaturnForecastQuestion;
  issuedAtMs:number;
  targetAt:string;
  scope:'owned_whole_ticket_if_delivered_conversion'|'hypothetical_exact_USDat_input_public_conversion_quote';
  conversion:SaturnHistoricalConversionProjection|null;
  conversionInputUsdatRaw:string;
  currentFinalAusdRaw:string;
  scenarios:readonly {targetAt:string;
  quotedFinalAusdRaw:string;
  requestedHeadroomAusdRaw:string}[];
  funding:{particularTicket:'simulated_current_claim'|'unknown';
  pullableUsdatRaw:null;
  simulatedClaimReturnUsdatRaw:string|null;
  aggregateVaultCashUsdatRaw:string;
  aggregateQueueCashUsdatRaw:string;
  aggregateCashIsTicketFunding:false;
  expectedAdditionalNetCompetingUsdatRaw:null;
  netCompetingFlow:'unknown';
  observedAggregateNetVaultCashDeltaRaw:string|null;
  assumedAggregateVaultCashAtHRaw:string|null;
  source:SaturnConversionCurrent['point']['source']};
  conditionalQuoteWindow:{firstElapsedMs:number;
  lastElapsedMs:number}|null;
  shrinking:boolean;
  holderEntitlementEstablished:boolean;
  holderExecutableExit:false;
  futureQueueRelease:'unknown_censored';
  chronologicalBacktestValidated:false;
  futurePoolInventoryBounded:false;
  futureMarketPriceBounded:false;
  predictivePlausibilityEstablished:false}>
export type SaturnAppForecastIssue=Readonly<{issuedAtMs:number}>
function aggregateProjection(f:SaturnNativeQuoteOrigin['queueFacts'],issued:number,hours:number):string|null{try{const c=f.change;
  if(!c)return null;
  if(!Number.isSafeInteger(c.periodMs)||
      c.periodMs<=0||
      !same({...c.priorSource,blockNumber:f.source.blockNumber,blockHash:f.source.blockHash,blockTime:f.source.blockTime},f.source)||
      BigInt(c.priorSource.blockNumber)>=BigInt(f.source.blockNumber)||
      Date.parse(f.source.blockTime)-Date.parse(c.priorSource.blockTime)!==c.periodMs||
      BigInt(f.vaultCashUsdatRaw)-BigInt(c.priorVaultCashUsdatRaw)!==BigInt(c.netVaultCashDeltaRaw))return null;
  const n=BigInt(c.netVaultCashDeltaRaw)*BigInt(issued-Date.parse(f.source.blockTime)+hours*3600000),d=BigInt(c.periodMs),x=BigInt(f.vaultCashUsdatRaw)+n/d-(n<0n&&
      n%d!==0n?1n:0n);
  return x>=(1n<<256n)?null:String(x<0n?0n:x)}catch{return null}}
function quoteWindow(c:SaturnConversionCurrent,h:SaturnConversionHistory,q:SaturnForecastQuestion){const age=BigInt(q.asOfMs-Date.parse(c.point.source.blockTime)),period=BigInt(Date.parse(h.points[1].source.blockTime)-Date.parse(h.points[0].source.blockTime)),delta=BigInt(h.points[1].ausdQuotedRaw!)-BigInt(h.points[0].ausdQuotedRaw!),limit=BigInt(q.horizonHours*3600000),need=BigInt(q.requestedRaw)-BigInt(c.point.ausdQuotedRaw!);
  if(delta===0n)return need<=0n?{firstElapsedMs:0,lastElapsedMs:Number(limit)}:null;
  let n=need*period-delta*age,d=delta;
  if(d<0n){n=-n;
  d=-d}const fl=n/d-(n<0n&&
      n%d!==0n?1n:0n),ce=fl+(n%d!==0n?1n:0n),first=delta>0n?(ce>0n?ce:0n):0n,last=delta<0n?(fl<limit?fl:limit):limit;
  return first>last?null:{firstElapsedMs:Number(first),lastElapsedMs:Number(last)}}
function build(envelope:SaturnForecastEnvelope,question:SaturnForecastQuestion):SaturnAppForecast|null{
 try{
 if(envelope.schema!=='saturn_exact_size_native_quote_forecast_v1'||
      envelope.originalCaptureSha256!==P.rawCaptureSha256||
      !same(envelope.question,question)||
      envelope.issuedAtMs!==question.asOfMs||
      question.routeKey!==ROUTE||
      question.destination!==VAULT||
      !/^0x[0-9a-f]{40}$/.test(question.owner)||
      !/^[1-9][0-9]{0,77}$/.test(question.requestedRaw)||
      BigInt(question.requestedRaw)>=(1n<<256n)||
      !Number.isSafeInteger(question.horizonHours)||
      question.horizonHours<1||
      question.horizonHours>168||
      !Array.isArray(envelope.origins)||
      envelope.origins.length!==2)return null
 const [a,b]=envelope.origins;
  if(a.host===b.host||
      ![a.host,b.host].every(x=>/^[a-z0-9.-]{1,253}$/.test(x)))return null
 if(!same({...a,host:''},{...b,host:''}))return null
 const c=a.current,h=a.history,source=c.point.source,codes=c.point.runtimeCodeHashes;
 if(c.physicalPullableUsdatRaw!==null)return null
 const validRaw=(x:unknown)=>typeof x==='string'&&
      /^(0|[1-9][0-9]{0,77})$/.test(x)&&
      BigInt(x)<1n<<256n
 if(c.input.assetUSDat!=='0x23238f20b894f29041f48d88ee91131c395aaa71'||
      c.input.assetDecimals!==6||
      !validRaw(c.input.usdatInputRaw)||
      !validRaw(a.queueFacts.vaultCashUsdatRaw)||
      !validRaw(a.queueFacts.queueCashUsdatRaw)||
      ![c.point,...h.points].every(p=>validRaw(p.usdcQuotedRaw)&&
      p.usdcQuotedRaw!=='0'&&
      validRaw(p.ausdQuotedRaw)&&
      p.ausdQuotedRaw!=='0'))return null
 if(source.finalized!==true||
      source.chainId!==1||
      !Number.isSafeInteger(Date.parse(source.blockTime))||
      question.asOfMs<Date.parse(source.blockTime)||
      question.asOfMs-Date.parse(source.blockTime)>1800000||
      c.readAtUtc!==new Date(question.asOfMs).toISOString()||
      h.knowledgeCutoff!==c.readAtUtc||
      !same(c.input,h.input)||
      !same(a.queueFacts.source,source)||
      h.points.length!==2||
      c.point.status!=='conditional_quote'||
      !c.point.identityVerified)return null
 if(!['vault','queue'].every(k=>codes[k as 'vault'|'queue']===P.anchors[0].runtimeCodeHashes[k as 'vault'|'queue'])||
      !['curve','pool','quoter'].every(k=>codes[k as 'curve'|'pool'|'quoter']===P.anchors[0].runtimeCodeHashes[k as 'curve'|'pool'|'quoter']))return null
 if(!h.points.every((p,i)=>same(p.source,P.anchors[i].source)&&
      p.ticket===null&&
      p.status==='conditional_quote'&&
      p.identityVerified&&
      ['curve','pool','quoter'].every(k=>p.runtimeCodeHashes[k as 'curve'|'pool'|'quoter']===P.anchors[i].runtimeCodeHashes[k as 'curve'|'pool'|'quoter'])))return null
 const {captureReceiptSha256:_,...cb}=c,{captureReceiptSha256:__,...hb}=h
 if(c.captureReceiptSha256!==saturnNativeEvidenceDigest(cb)||
      h.captureReceiptSha256!==saturnNativeEvidenceDigest(hb))return null
 const targetAt=new Date(question.asOfMs+question.horizonHours*3600000).toISOString(),t=c.point.ticket
 let conversion:SaturnHistoricalConversionProjection|null=null,scenarios:SaturnAppForecast['scenarios']
 if(a.ownedTicket){if(!t||
      question.ticketId!==t.ticketId||
      question.owner!==t.owner)return null
 conversion=buildSaturnHistoricalConversionProjection({mode:'current_conditional',routeKey:ROUTE,destination:VAULT,owner:question.owner,ticketId:t.ticketId,sharesRaw18:t.sharesRaw18,requestedAusdRaw:question.requestedRaw,payoutAsset:AUSD,payoutDecimals:6,horizonHours:question.horizonHours,current:c,history:h,asOfMs:question.asOfMs},(kind,hash,value)=>kind==='current'?hash===c.captureReceiptSha256&&
      same(value,c):hash===h.captureReceiptSha256&&
      same(value,h))
 if(!conversion||
      conversion.gapCensored)return null
 scenarios=conversion.scenarios.map(s=>({targetAt:s.targetAt,quotedFinalAusdRaw:s.quotedFinalAusdRaw!,requestedHeadroomAusdRaw:s.requestedHeadroomAusdRaw!}))
 }else{if(t!==null||
      c.input.usdatInputRaw!=='42103198'||
      c.claimSimulation!=='unassessed'||
      c.claimReturnUsdatRaw!==null||
      c.physicalPullableUsdatRaw!==null)return null
 const period=Date.parse(h.points[1].source.blockTime)-Date.parse(h.points[0].source.blockTime),elapsed=question.asOfMs-Date.parse(source.blockTime)+question.horizonHours*3600000,n=(BigInt(h.points[1].ausdQuotedRaw!)-BigInt(h.points[0].ausdQuotedRaw!))*BigInt(elapsed),d=BigInt(period),delta=n/d-(n<0n&&
      n%d!==0n?1n:0n),amount=BigInt(c.point.ausdQuotedRaw!)+delta,clamped=amount<0n?0n:amount;
  if(clamped>=(1n<<256n))return null
 scenarios=[{targetAt,quotedFinalAusdRaw:String(clamped),requestedHeadroomAusdRaw:String(clamped-BigInt(question.requestedRaw))}]
 }
 return Object.freeze({question:structuredClone(question),issuedAtMs:question.asOfMs,targetAt,scope:a.ownedTicket?'owned_whole_ticket_if_delivered_conversion':'hypothetical_exact_USDat_input_public_conversion_quote',conversion,conversionInputUsdatRaw:c.input.usdatInputRaw,currentFinalAusdRaw:c.point.ausdQuotedRaw!,scenarios,funding:{particularTicket:a.ownedTicket&&
      c.claimSimulation==='success'?'simulated_current_claim':'unknown',pullableUsdatRaw:null,simulatedClaimReturnUsdatRaw:a.ownedTicket&&
      c.claimSimulation==='success'?c.claimReturnUsdatRaw:null,aggregateVaultCashUsdatRaw:a.queueFacts.vaultCashUsdatRaw,aggregateQueueCashUsdatRaw:a.queueFacts.queueCashUsdatRaw,aggregateCashIsTicketFunding:false,expectedAdditionalNetCompetingUsdatRaw:null,netCompetingFlow:'unknown',observedAggregateNetVaultCashDeltaRaw:a.queueFacts.change?.netVaultCashDeltaRaw??null,assumedAggregateVaultCashAtHRaw:aggregateProjection(a.queueFacts,question.asOfMs,question.horizonHours),source},conditionalQuoteWindow:quoteWindow(c,h,question),shrinking:scenarios.some(s=>BigInt(s.quotedFinalAusdRaw)<BigInt(c.point.ausdQuotedRaw!)),holderEntitlementEstablished:a.ownedTicket,holderExecutableExit:false,futureQueueRelease:'unknown_censored',chronologicalBacktestValidated:false,futurePoolInventoryBounded:false,futureMarketPriceBounded:false,predictivePlausibilityEstablished:false})
 }catch{return null}
}
/** API-origin response validation mints one browser-local original;
   copied models and receipts are never admitted. */
export function saturnAppForecastFromResponse(response:unknown,status:number,question:Omit<SaturnForecastQuestion,'asOfMs'>,receivedAtMs:number):SaturnAppForecast|null{
 try{if(status!==200||
      !response||
      typeof response!=='object')return null
 const x=response as Record<string,unknown>,e=x.saturnHolderForecastEvidence as SaturnForecastEnvelope
 if(!e||
      JSON.stringify(e).length>65536||
      !Number.isSafeInteger(receivedAtMs)||
      receivedAtMs<e.issuedAtMs||
      receivedAtMs-e.issuedAtMs>1800000)return null
 const q={...question,asOfMs:e.issuedAtMs};
  if(!same({...e.question,asOfMs:0},{...q,asOfMs:0}))return null
 // Bind the separately retained forecast to the actual API assessment source and request.
 if((x.source as {originValidation?:string})?.originValidation!=='two_provider')return null
 const req=x.request as {assetsRaw?:string;
  horizonHours?:number;
  requestTokenId?:string},src=x.source as {blockHash?:string;
  blockNumber?:number;
  blockTime?:string}
 if(x.routeKey!==q.routeKey||
      x.destinationAddress!==q.destination||
      x.owner!==q.owner||
      req?.assetsRaw!==q.requestedRaw||
      (req as {assetAddress?:string})?.assetAddress!==AUSD||
      (src as {chainId?:number}).chainId!==1||
      req?.horizonHours!==q.horizonHours||
      src?.blockHash!==e.origins[0].current.point.source.blockHash||
      String(src?.blockNumber)!==e.origins[0].current.point.source.blockNumber||
      src?.blockTime!==e.origins[0].current.point.source.blockTime)return null
 if(req?.requestTokenId!==undefined&&
      req.requestTokenId!==q.ticketId)return null
 if(e.origins[0].ownedTicket){const t=e.origins[0].current.point.ticket,condition=x.stakedUsdatCondition as {existingTicketOwnership?:string;
  existingTicketId?:string;
  existingTicketRecordedRequest?:{sharesRaw18:string;
  usdatOwedRaw6:string;
  requestedAtUnix:string;
  minSharePriceRaw:string;
  rawStatus:number};
  existingTicketConversionQuote?:{usdatInputRaw:string;
  usdcQuotedRaw:string;
  ausdQuotedRaw:string};
  existingTicketClaimStatus?:string;
  existingTicketConversionBasis?:string};
  const rr=condition?.existingTicketRecordedRequest,quote=condition?.existingTicketConversionQuote;
  if(!t||
      condition.existingTicketOwnership!=='holder'||
      condition.existingTicketId!==t.ticketId||
      !rr||
      !same(rr,{sharesRaw18:t.sharesRaw18,usdatOwedRaw6:t.usdatOwedRaw6,requestedAtUnix:t.requestedAtUnix,minSharePriceRaw:t.minSharePriceRaw,rawStatus:t.status})||
      (quote&&
      (quote.usdatInputRaw!==e.origins[0].current.input.usdatInputRaw||
      quote.usdcQuotedRaw!==e.origins[0].current.point.usdcQuotedRaw||
      quote.ausdQuotedRaw!==e.origins[0].current.point.ausdQuotedRaw))||
      condition.existingTicketClaimStatus!==e.origins[0].current.claimSimulation||
      (quote&&
      condition.existingTicketConversionBasis!==(e.origins[0].current.entitlementMethod==='claim_return'?'claim_return':'recorded_owed_if_delivered')))return null}
 const m=build(e,q);
  if(m)objects.set(m,{envelope:structuredClone(e),model:m});
  return m
 }catch{return null}
}
export function saturnAppForecastIssue(model:SaturnAppForecast):SaturnAppForecastIssue|null{if(!objects.has(model))return null;
  const issue=Object.freeze({issuedAtMs:model.issuedAtMs});
  receipts.set(issue,model);
  return issue}
export function selectedSaturnAppForecastFromIssue(
  issue: unknown,
  expected: Omit<SaturnForecastQuestion, 'asOfMs'>,
  asOfMs: number,
): SaturnAppForecast | null {
  try {
    if (!issue || typeof issue !== 'object' || !Number.isSafeInteger(asOfMs)) return null
    const stored = receipts.get(issue)
    if (!stored) return null
    const original = objects.get(stored)
    if (!original) return null
    // Each selection owns a fresh graph. Neither a caller-controlled model nor a prior selection supplies facts.
    const envelope = structuredClone(original.envelope)
    const rebuilt = build(envelope, envelope.question)
    if (!rebuilt || !same(stored, rebuilt)) return null
    if (asOfMs < rebuilt.issuedAtMs || asOfMs - Date.parse(rebuilt.funding.source.blockTime) > 1800000)
      return null
    const { asOfMs: _issuedAt, ...question } = rebuilt.question
    // The rebuilt result is not entered in objects: it cannot mint a new issuer-authorized receipt.
    return same(question, expected) ? rebuilt : null
  } catch { return null }
}
