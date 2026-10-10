import { createHash } from 'node:crypto'
import { lstatSync,openSync,readSync,closeSync,fstatSync,constants } from 'node:fs'
import { resolve } from 'node:path'
import { decodeFunctionResult,encodeFunctionData,keccak256,parseAbi,type Address,type PublicClient } from 'viem'
import { normalizedSaturnEvidence } from '../../scripts/research/saturn-historical-conversion-capture.mjs'
import { STAKED_USDAT_VAULT as V,STAKED_USDAT_QUEUE as Q,USDAT_ASSET as U,STAKED_USDAT_IMPLEMENTATION as VI,STAKED_USDAT_IMPLEMENTATION_CODE_HASH as VH,STAKED_USDAT_QUEUE_IMPLEMENTATION as QI,STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH as QH } from './stakedUsdatExit'
import { readSaturnTicketConversionQuote,SATURN_CURVE_POOL as C,SATURN_UNISWAP_POOL as P,SATURN_UNISWAP_QUOTER as R } from './saturnTicketConversionQuote'
import { SATURN_ORIGINAL_CONVERSION_PROFILE as PROFILE } from './saturnOriginalConversionProfile'
import {saturnNativeEvidenceDigest,type SaturnForecastEnvelope,type SaturnForecastQuestion,type SaturnNativeQuoteOrigin} from './saturnAppForecastEvidence'
import type {HolderExitAssessment,HolderExitAssessmentRequest} from './holderExitAssessment'
import type {SaturnConversionSource,SaturnConversionPoint,SaturnConversionCurrent,SaturnConversionHistory} from './saturnHistoricalConversionProjection'
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const ABI=parseAbi(['function ownerOf(uint256) view returns(address)','function nextTokenId() view returns(uint256)','function requests(uint256) view returns(uint256 shares,uint256 owed,uint256 timestamp,uint256 minPrice,uint8 status)','function paused() view returns(bool)','function claim(uint256) returns(uint256)','function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function asset() view returns(address)','function getWithdrawalQueue() view returns(address)','function USDAT() view returns(address)','function STAKED_USDAT() view returns(address)'])
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),raw=(x:unknown):x is string=>typeof x==='string'&&
      /^[1-9][0-9]{0,77}$/.test(x)&&
      BigInt(x)<1n<<256n
const issued=new WeakMap<object,string>()
let retainedChecked=false
function retained(){if(retainedChecked)return
 const p=resolve(PROFILE.rawCapturePath),s=lstatSync(p);
  if(!s.isFile()||
      s.isSymbolicLink()||
      s.size!==PROFILE.rawCaptureBytes)throw Error('saturn_original_capture_unavailable')
 const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  const b=Buffer.alloc(s.size);
  try{const a=fstatSync(fd);
  if(a.dev!==s.dev||
      a.ino!==s.ino||
      !a.isFile()||
      a.size!==s.size)throw Error('saturn_original_capture_identity');
  let at=0;
  while(at<b.length){const n=readSync(fd,b,at,b.length-at,null);
  if(!n)throw Error('saturn_original_capture_short_read');
  at+=n}const z=fstatSync(fd);
  if(z.size!==s.size||
      z.mtimeMs!==s.mtimeMs||
      z.ctimeMs!==s.ctimeMs)throw Error('saturn_original_capture_changed')}finally{closeSync(fd)}
 if(createHash('sha256').update(b).digest('hex')!==PROFILE.rawCaptureSha256)throw Error('saturn_original_capture_pin')
 const native=JSON.parse(b.toString('utf8')),h=normalizedSaturnEvidence(native,native.plan).history
 if(h.points.length!==2||
      !h.points.every((p:SaturnConversionPoint,i:number)=>same(p.source,PROFILE.anchors[i].source)&&
      same(p.runtimeCodeHashes,PROFILE.anchors[i].runtimeCodeHashes)))throw Error('saturn_original_native_replay')
 retainedChecked=true
}
export type SaturnNativeClient=Pick<PublicClient,'getChainId'|'getBlock'|'getCode'|'getStorageAt'|'readContract'|'call'>
export function isSaturnNativeClient(x:object):x is SaturnNativeClient{return ['getChainId','getBlock','getCode','getStorageAt','readContract','call'].every(k=>typeof Object.getOwnPropertyDescriptor(x,k)?.value==='function')}
function capped(client:SaturnNativeClient,state:{starts:number;
  deadline:number}){const methods=['getChainId','getBlock','getCode','getStorageAt','readContract','call'] as const
 return Object.fromEntries(methods.map(key=>[key,async(...args:unknown[])=>{if(Date.now()>state.deadline||
      ++state.starts>160)throw Error('saturn_native_budget');
  const fn=client[key] as (...args:unknown[])=>Promise<unknown>;
  return fn.apply(client,args)}])) as Pick<PublicClient,typeof methods[number]>
}
async function header(client:Pick<PublicClient,'getBlock'>,s:SaturnConversionSource){const b=await client.getBlock({blockNumber:BigInt(s.blockNumber)});
  if(b.hash!==s.blockHash||
      String(b.number)!==s.blockNumber||
      new Date(Number(b.timestamp)*1000).toISOString()!==s.blockTime)throw Error('saturn_native_source_changed')}
async function codes(client:Pick<PublicClient,'getCode'>,s:SaturnConversionSource,current:boolean){const values:Record<string,string|null>={};
  for(const [key,address] of [['curve',C],['pool',P],['quoter',R],...(current?[['vault',V],['queue',Q]]:[])] as [string,Address][]){const code=await client.getCode({address,blockHash:s.blockHash as `0x${string}`,requireCanonical:true});
  if(!code||
      code==='0x'||
      code.length>262144)throw Error('saturn_runtime_missing');
  values[key]=keccak256(code);
  if(values[key]!==PROFILE.anchors[0].runtimeCodeHashes[key as keyof typeof PROFILE.anchors[0]['runtimeCodeHashes']])throw Error('saturn_runtime_regime_changed')}
 return {curve:values.curve!,pool:values.pool!,quoter:values.quoter!,vault:values.vault??null,queue:values.queue??null}
}
/** This function performs native reads itself. Caller flags, normalization callbacks and serialized read objects cannot issue evidence. */
export async function acquireSaturnAppForecast(input:HolderExitAssessmentRequest,witnesses:readonly {host:string;
  assessment:HolderExitAssessment;
  client:SaturnNativeClient}[]):Promise<SaturnForecastEnvelope|null>{
 try{if(input.routeKey!=='AUSD → Staked USDat [USDat]'||
      input.destinationAddress.toLowerCase()!==V||
      witnesses.length!==2||
      witnesses[0].host===witnesses[1].host||
      !Number.isSafeInteger(input.horizonHours)||
      input.horizonHours<1||
      input.horizonHours>168)return null
 const source=witnesses[0].assessment.source;
  if(!same(source,witnesses[1].assessment.source))return null
 const s:SaturnConversionSource={chainId:1,blockNumber:String(source.blockNumber),blockHash:source.blockHash,blockTime:source.blockTime,finalized:true};
  if(!Number.isFinite(Date.parse(s.blockTime))||
      Date.now()<Date.parse(s.blockTime)||
      Date.now()-Date.parse(s.blockTime)>1800000)return null
 retained();
  const state={starts:0,deadline:Date.now()+45000},clients=witnesses.map(w=>capped(w.client,state));
  const rows:SaturnNativeQuoteOrigin[]=[]
 for(let i=0;
  i<2;
  i++){
 const client=clients[i];
  if(await client.getChainId()!==1)throw Error('saturn_chain');
  const tip=await client.getBlock({blockTag:'finalized'});
  if(tip.number<BigInt(s.blockNumber))throw Error('saturn_not_finalized');
  await header(client,s)
 const pin={blockHash:s.blockHash as `0x${string}`,requireCanonical:true as const},runtime=await codes(client,s,true)
 for(const [address,implementation,expected] of [[V,VI,VH],[Q,QI,QH]] as [Address,Address,`0x${string}`][]){const slot=await client.getStorageAt({address,slot:SLOT,...pin});
  if(slot?.slice(-40).toLowerCase()!==implementation.slice(2))throw Error('saturn_implementation_changed');
  const code=await client.getCode({address:implementation,...pin});
  if(!code||
      code.length>262144||
      keccak256(code)!==expected)throw Error('saturn_implementation_code_changed')}
 const identity=await Promise.all([client.readContract({address:V,abi:ABI,functionName:'asset',...pin}),client.readContract({address:V,abi:ABI,functionName:'getWithdrawalQueue',...pin}),client.readContract({address:Q,abi:ABI,functionName:'USDAT',...pin}),client.readContract({address:Q,abi:ABI,functionName:'STAKED_USDAT',...pin})]);
  if(!same(identity.map(x=>x.toLowerCase()),[U,Q,U,V]))throw Error('saturn_same_source_identity_changed');
  const shareDecimals = await client.readContract({address:V,abi:ABI,functionName:'decimals',...pin});
  if (shareDecimals !== 18) throw Error('saturn_units_changed');
  // The exact-size conversion reader independently requires USDat/USDC/AUSD decimals = 6 at this same B.
 const [vp,qp,vc,qc]=await Promise.all([client.readContract({address:V,abi:ABI,functionName:'paused',...pin}),client.readContract({address:Q,abi:ABI,functionName:'paused',...pin}),client.readContract({address:U,abi:ABI,functionName:'balanceOf',args:[V],...pin}),client.readContract({address:U,abi:ABI,functionName:'balanceOf',args:[Q],...pin})])
 let ticket:SaturnConversionPoint['ticket']=null,claim:SaturnConversionCurrent['claimSimulation']='unassessed',returned:string|null=null
 if(input.requestTokenId){let owner:Address|null=null;
  try{owner=await client.readContract({address:Q,abi:ABI,functionName:'ownerOf',args:[BigInt(input.requestTokenId)],...pin})}catch(error){if(error instanceof Error&&
      /revert/i.test(error.message))owner=null;
  else throw error}
 if(owner?.toLowerCase()===input.owner.toLowerCase()){const t=await client.readContract({address:Q,abi:ABI,functionName:'requests',args:[BigInt(input.requestTokenId)],...pin});
  if(t[0]<=0n||
      t[1]<=0n||
      t[2]<=0n||
      t[2]*1000n>BigInt(Date.parse(s.blockTime)))throw Error('saturn_owned_record_invalid');
  ticket={owner:input.owner.toLowerCase(),ticketId:input.requestTokenId,sharesRaw18:String(t[0]),usdatOwedRaw6:String(t[1]),requestedAtUnix:String(t[2]),minSharePriceRaw:String(t[3]),status:t[4],vaultPaused:vp,queuePaused:qp}
 try{const r=await client.call({to:Q,account:owner,data:encodeFunctionData({abi:ABI,functionName:'claim',args:[BigInt(input.requestTokenId)]}),gas:15000000n,...pin});
  if(!r.data)throw Error('saturn_claim_empty');
  returned=String(decodeFunctionResult({abi:ABI,functionName:'claim',data:r.data}));
  if(!raw(returned))throw Error('saturn_claim_invalid');
  claim='success'}catch(error){if(error instanceof Error&&
      /revert/i.test(error.message)){claim='evm_revert';
  returned=null}else throw error}
 const prior=witnesses[i].assessment.stakedUsdatCondition,record=prior?.existingTicketRecordedRequest;
  if(prior?.existingTicketOwnership!=='holder'||
      prior.existingTicketId!==ticket.ticketId||
      !record||
      record.sharesRaw18!==ticket.sharesRaw18||
      record.usdatOwedRaw6!==ticket.usdatOwedRaw6||
      record.requestedAtUnix!==ticket.requestedAtUnix||
      record.minSharePriceRaw!==ticket.minSharePriceRaw||
      record.rawStatus!==ticket.status||
      prior.existingTicketClaimStatus!==claim)throw Error('saturn_current_ticket_rebound')
 }}
 if(!ticket&&
      witnesses[i].assessment.stakedUsdatCondition?.existingTicketOwnership==='holder')throw Error('saturn_same_source_ownership_disagrees')
 const amount=claim==='success'?returned!:ticket?.usdatOwedRaw6??'42103198',nativeInput={usdatInputRaw:amount,assetUSDat:U,assetDecimals:6 as const},quote=await readSaturnTicketConversionQuote(client,s.blockHash as `0x${string}`,amount)
 if(ticket){const agreed=witnesses[i].assessment.stakedUsdatCondition?.existingTicketConversionQuote;
  if(agreed&&
      !same(quote,agreed))throw Error('saturn_current_quote_rebound')}
 const point:SaturnConversionPoint={source:s,usdcQuotedRaw:quote.usdcQuotedRaw,ausdQuotedRaw:quote.ausdQuotedRaw,status:'conditional_quote',runtimeCodeHashes:runtime,identityVerified:true,ticket,missingLegs:[]}
 const points:SaturnConversionPoint[]=[]
 for(const a of PROFILE.anchors){await header(client,a.source);
  const runtime=await codes(client,a.source,false),q=await readSaturnTicketConversionQuote(client,a.source.blockHash,amount);
  await header(client,a.source);
  points.push({source:a.source,usdcQuotedRaw:q.usdcQuotedRaw,ausdQuotedRaw:q.ausdQuotedRaw,status:'conditional_quote',runtimeCodeHashes:runtime,identityVerified:true,ticket:null,missingLegs:[]})}
 await header(client,s)
 let change:SaturnNativeQuoteOrigin['queueFacts']['change']=null
 if(BigInt(s.blockNumber)>256n&&
      state.starts+3<=160){try{const prior=await client.getBlock({blockNumber:BigInt(s.blockNumber)-256n});
  if(!prior.hash)throw Error('saturn_prior_source');
  const ps:SaturnConversionSource={chainId:1,blockNumber:String(prior.number),blockHash:prior.hash,blockTime:new Date(Number(prior.timestamp)*1000).toISOString(),finalized:true};
  const balance=await client.readContract({address:U,abi:ABI,functionName:'balanceOf',args:[V],blockHash:prior.hash,requireCanonical:true});
  await header(client,ps);
  const periodMs=Date.parse(s.blockTime)-Date.parse(ps.blockTime);
  if(periodMs>0)change={priorSource:ps,priorVaultCashUsdatRaw:String(balance),periodMs,netVaultCashDeltaRaw:String(vc-balance)}}catch{change=null}}
 const current={captureReceiptSha256:'',readAtUtc:'',input:nativeInput,point,entitlementMethod:claim==='success'?'claim_return' as const:'recorded_usdat_owed' as const,physicalPullableUsdatRaw:null,claimSimulation:claim,claimReturnUsdatRaw:returned},history={status:'verified_two_origin_saturn_conversion_history' as const,knowledgeCutoff:'',captureReceiptSha256:'',input:nativeInput,points,elapsedSeconds:[0,(Date.parse(points[1].source.blockTime)-Date.parse(points[0].source.blockTime))/1000]}
 rows.push({host:witnesses[i].host,current,history,queueFacts:{vaultCashUsdatRaw:String(vc),queueCashUsdatRaw:String(qc),change,source:s},ownedTicket:ticket!==null})
 }
 const issuedAtMs=Date.now();
  if(issuedAtMs>state.deadline||
      issuedAtMs-Date.parse(s.blockTime)>1800000||
      issuedAtMs<Date.parse(s.blockTime))return null
 for(const row of rows){row.current.readAtUtc=new Date(issuedAtMs).toISOString();
  row.history.knowledgeCutoff=row.current.readAtUtc;
  const {captureReceiptSha256:_,...c}=row.current,{captureReceiptSha256:__,...h}=row.history;
  row.current.captureReceiptSha256=saturnNativeEvidenceDigest(c);
  row.history.captureReceiptSha256=saturnNativeEvidenceDigest(h)}
 if(!same(rows[0].queueFacts.change,rows[1].queueFacts.change)){rows[0].queueFacts.change=null;
  rows[1].queueFacts.change=null}
 if(!same({...rows[0],host:''},{...rows[1],host:''}))return null
 const question:SaturnForecastQuestion={routeKey:input.routeKey,destination:V,owner:input.owner.toLowerCase(),requestedRaw:input.assetsRaw,horizonHours:input.horizonHours,ticketId:input.requestTokenId??null,asOfMs:issuedAtMs}
 const e:SaturnForecastEnvelope={schema:'saturn_exact_size_native_quote_forecast_v1',originalCaptureSha256:PROFILE.rawCaptureSha256,issuedAtMs,question,origins:rows as [SaturnNativeQuoteOrigin,SaturnNativeQuoteOrigin]};
  if(Buffer.byteLength(JSON.stringify(e))>65536)return null;
  issued.set(e,saturnNativeEvidenceDigest(e));
  return Object.freeze(e)
 }catch{return null}
}
export function selectedSaturnServerForecastEnvelope(value:unknown):SaturnForecastEnvelope|null{return value!==null&&
      typeof value==='object'&&
      issued.has(value)&&
      issued.get(value)===saturnNativeEvidenceDigest(value)?value as SaturnForecastEnvelope:null}
