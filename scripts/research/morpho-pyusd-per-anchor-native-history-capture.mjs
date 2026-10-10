/** Separate root-only PYUSD research capture. Imports perform no provider acquisition. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync, statfsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters, parseAbi, keccak256 } from 'viem'
import { ABI as LEGACY_ABI } from './morpho-v2-adapter-capacity-capture.mjs'
import { configuredUsd3HypotheticalOrigins, createUsd3HypotheticalCaptureControl, parseUsd3HypotheticalJson } from './usd3-hypothetical-history-capture.mjs'
import { prepareMorphoMultiAssetNativeHistory, morphoMultiAssetPointReadPlan, assertMorphoMultiAssetPrivacy, verifyMorphoMultiAssetReceipt, createMorphoMultiAssetWriter } from './morpho-multi-asset-native-history-capture.mjs'

const ROOT=resolve(fileURLToPath(new URL('../../',import.meta.url))),SELF=fileURLToPath(import.meta.url)
const PLAN=resolve(ROOT,'scripts/research/morpho-pyusd-per-anchor-native-history.plan.json')
const PLAN_SHA='159be07cd2e51998a688b57633a25e55a84b4666d110488c1e3b5d2a5edc43aa'
const HOSTS=['eth-mainnet.g.alchemy.com','rpc.ankr.com'],ZERO='0x'+'0'.repeat(40)
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const PARAMS=['address','address','address','address','uint256'].map(type=>({type}))
const ABI=[...LEGACY_ABI,...parseAbi(['function previewRedeem(uint256 shares) view returns(uint256)'])]
const flags=Object.freeze({researchOnly:true,profileApproval:false,authenticated:false,originalIssuanceAuthority:false,
  sourceImplementationEquivalence:false,forecastAuthority:false,executionAuthority:false,historicalOwnership:false,
  calibratedProbability:false,coveragePromotion:false,noStationaryRegimePooling:true,MRaw:null})
const sha=x=>createHash('sha256').update(x).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const check=(ok,s)=>{if(!ok)throw Error('pyusd_anchor_'+s)}
const seal=x=>({...x,sha256:sha(JSON.stringify(x))})
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v)
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x}
const free=()=>{const s=statfsSync(ROOT,{bigint:true});return s.bavail*s.bsize}
function pathOf(p){check(typeof p==='string'&&!p.startsWith('/')&&!p.includes('..')&&!p.includes('\\'),'path');return resolve(ROOT,p)}
function read(p,privateMode=false){
  const n=lstatSync(p);check(n.isFile()&&!n.isSymbolicLink()&&n.nlink===1&&n.size<=8388608,'file')
  if(privateMode)check((n.mode&0o777)===0o600,'private_mode')
  const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const a=fstatSync(fd),b=readFileSync(fd),z=fstatSync(fd),named=lstatSync(p)
    check(b.length===a.size&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>n[k]===a[k]&&a[k]===z[k]&&z[k]===named[k])&&a.nlink===1&&named.nlink===1&&(!privateMode||((a.mode&0o777)===0o600&&(named.mode&0o777)===0o600)),'file_drift');return b
  }finally{closeSync(fd)}
}
function sealedObject(bytes){const v=parseUsd3HypotheticalJson(bytes.toString('utf8')),{sha256,...body}=v;check(sha(JSON.stringify(body))===sha256,'body_seal');return v}
export function decodePyusdHistoricalNativeResult(name,data){
  check(typeof data==='string'&&/^0x(?:[0-9a-f]{2})*$/.test(data),'ABI_result')
  const result=decodeFunctionResult({abi:ABI,functionName:name,data}),outputs=ABI.find(x=>x.type==='function'&&x.name===name).outputs
  check(encodeAbiParameters(outputs,outputs.length===1?[result]:result)===data,'ABI_canonical');return result
}
function pair(traces,key){
  const xs=HOSTS.map(host=>traces.filter(t=>t.host===host&&t.key===key))
  check(xs.every(x=>x.length===1&&x[0].envelope&&!x[0].envelope.error)&&same(xs[0][0].envelope.result,xs[1][0].envelope.result),'paired_'+key)
  return xs[0][0].envelope.result
}
function header(v){
  check(v&&/^0x[0-9a-f]+$/.test(v.number)&&/^0x[0-9a-f]{64}$/.test(v.hash)&&/^0x[0-9a-f]+$/.test(v.timestamp),'header')
  return {chainId:1,blockNumber:String(BigInt(v.number)),blockHash:v.hash,blockTime:new Date(Number(BigInt(v.timestamp))*1000).toISOString()}
}
function pairedHeader(traces,key){
  const hs=HOSTS.map(host=>{const ts=traces.filter(t=>t.host===host&&t.key===key);check(ts.length===1&&!ts[0].envelope.error,'header_pair');return header(ts[0].envelope.result)})
  check(same(hs[0],hs[1]),'header_disagreement');return hs[0]
}
export function pyusdPerAnchorNativeConfiguration(base,encodedLiquidityResult){
  const liquidityData=decodePyusdHistoricalNativeResult('liquidityData',encodedLiquidityResult)
  check(liquidityData.length===322,'market_datum')
  const params=decodeAbiParameters(PARAMS,liquidityData)
  check(encodeAbiParameters(PARAMS,params)===liquidityData&&params[0].toLowerCase()===base.subject.asset&&
    params[3].toLowerCase()===base.dependencies.adaptiveCurveIrm&&params[1].toLowerCase()!==ZERO&&params[2].toLowerCase()!==ZERO&&
    params[4]>0n&&params[4]<1000000000000000000n,'market_dependencies')
  const marketId=keccak256(liquidityData)
  const allocationIds=[
    keccak256(encodeAbiParameters([{type:'string'},{type:'address'}],['this',base.adapter])),
    keccak256(encodeAbiParameters([{type:'string'},{type:'address'}],['collateralToken',params[1]])),
    keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'tuple',components:PARAMS}],['this/marketParams',base.adapter,params])),
  ]
  return freeze({...base,liquidityData,params,marketId,allocationIds,configurationRegimeId:sha(json({adapter:base.adapter,liquidityData}))})
}
export function pyusdResearchConfigurationRegimes(current,historical){
  check(Array.isArray(historical)&&historical.length===2,'regime_count')
  for(const r of [current,...historical])check(r.configurationRegimeId===sha(json({adapter:r.adapter,liquidityData:r.liquidityData})),'regime_binding')
  return {retainedBasisConfigurationRegimeId:current.configurationRegimeId,retainedBasisLiquidityData:current.liquidityData,
    historicalRegimesDiffer:historical[0].configurationRegimeId!==historical[1].configurationRegimeId,
    historicalMatchesRetainedBasis:historical.map(r=>r.configurationRegimeId===current.configurationRegimeId),
    stationaryCurrentToHistoryRegimeAssumed:false,noStationaryRegimePooling:true,forecastAuthority:false}
}
function helpers(c,s){
  const pin={blockHash:s.blockHash,requireCanonical:true}
  const state=(key,method,args)=>({key,method,params:[...args,pin]})
  const call=(key,to,name,args=[])=>({key,name,...state(key,'eth_call',[{to,data:encodeFunctionData({abi:ABI,functionName:name,args})}])})
  const code=(key,to)=>state(key,'eth_getCode',[to]),slot=(key,to)=>state(key,'eth_getStorageAt',[to,SLOT])
  const bracket=key=>({key,method:'eth_getBlockByNumber',params:['0x'+BigInt(s.blockNumber).toString(16),false]})
  return {call,code,slot,bracket}
}
export function pyusdPerAnchorConfigurationReadPlan(c,s){
  const {call,code,slot,bracket}=helpers(c,s)
  return [{key:'chain',method:'eth_chainId',params:[]},bracket('header_before'),code('code_vault',c.subject.vault),code('code_asset',c.subject.asset),
    slot('slot_vault',c.subject.vault),slot('slot_asset',c.subject.asset),call('vault_asset',c.subject.vault,'asset'),
    call('vault_decimals',c.subject.vault,'decimals'),call('asset_decimals',c.subject.asset,'decimals'),call('idle',c.subject.asset,'balanceOf',[c.subject.vault]),
    call('liquidityAdapter',c.subject.vault,'liquidityAdapter'),call('liquidityData',c.subject.vault,'liquidityData')]
}
export function pyusdPerAnchorCapacityReadPlan(c,s,owner){
  const derived=pyusdPerAnchorNativeConfiguration(c,encodeAbiParameters([{type:'bytes'}],[c.liquidityData]))
  check(c.marketId===derived.marketId&&same(c.allocationIds,derived.allocationIds)&&same(c.params.map(String),derived.params.map(String)),'wrong_market_or_allocations')
  const keys=new Set(pyusdPerAnchorConfigurationReadPlan(c,s).map(x=>x.key))
  return morphoMultiAssetPointReadPlan(c,s,owner,false).filter(x=>!keys.has(x.key))
}
export function preparePyusdPerAnchorNativeHistory(){
  const bytes=read(PLAN);check(sha(bytes)===PLAN_SHA,'plan_pin');const plan=JSON.parse(bytes.toString('utf8')),prior=prepareMorphoMultiAssetNativeHistory('30')
  check(same(prior.config.subject,plan.candidate.subject)&&prior.config.adapter===plan.candidate.adapter,'candidate')
  const originals={}
  for(const ref of plan.basisReferences){const b=read(pathOf(ref.path),true);check(b.length===ref.bytes&&sha(b)===ref.fileSha256,'basis_pin')
    const v=sealedObject(b);check(v.sha256===ref.bodySha256,'basis_body');originals[ref.path.split('/').at(-1)]=v}
  const f=originals['point_0-facts.json'],r=originals['point_0-originals.json'],failed=originals['failed_control-originals.json'],terminal=originals['terminal.json']
  verifyMorphoMultiAssetReceipt(r.receipt,r.traces,r.settlements);verifyMorphoMultiAssetReceipt(failed.receipt,failed.traces,failed.settlements)
  check(f.owner===plan.researchBasis.owner&&f.currentOwnerSharesRaw==='0'&&f.fixedSharesRaw===plan.researchBasis.fixedHypotheticalSharesRaw&&
    f.shareBasis==='explicit_hypothetical_research_S'&&f.assetDecimals===6&&f.shareDecimals===18&&same(f.source,plan.researchBasis.source)&&
    terminal.failure==='morpho_multi_configured_datum'&&terminal.pointCount===1,'research_basis')
  check(decodePyusdHistoricalNativeResult('balanceOf',pair(r.traces,'owner_current_shares'))===0n&&
    String(decodePyusdHistoricalNativeResult('previewRedeem',pair(r.traces,'full_net_ea')))===f.nativeFacts.full_net_ea&&
    decodePyusdHistoricalNativeResult('liquidityData',pair(r.traces,'liquidityData'))===prior.config.liquidityData&&
    same(pairedHeader(r.traces,'header_before'),f.source)&&same(pairedHeader(r.traces,'header_after'),f.source),'current_original')
  const retainedCurrentConfiguration=pyusdPerAnchorNativeConfiguration(prior.config,pair(r.traces,'liquidityData'))
  const historical=pyusdPerAnchorNativeConfiguration(prior.config,pair(failed.traces,'liquidityData'))
  check(historical.liquidityData===plan.knownOctober1LiquidityData&&same(pairedHeader(failed.traces,'header_before'),plan.anchors[0].source),'old_configuration')
  for(const ref of plan.basisReferences){const b=read(pathOf(ref.path),true);check(sha(b)===ref.fileSha256,'basis_recheck')}
  const sources=plan.sourcePins.map(pin=>{const b=read(pathOf(pin.path));check(b.length===pin.bytes&&sha(b)===pin.fileSha256,'source_pin');return {pin,bytes:b}})
  return {plan,base:prior.config,basis:f,expectedRuntimes:f.runtimes,sources,planBytes:bytes,producerBytes:read(SELF),historical,retainedCurrentConfiguration}
}
function secretsFor(origins){
  const secrets=new Set()
  for(const o of origins){const u=new URL(o.url)
    for(const t of [o.url,...u.pathname.split('/').filter(x=>x&&!['v2','v3','eth','rpc'].includes(x)),...u.searchParams.values()]){
      if(!t)continue;secrets.add(t);try{secrets.add(decodeURIComponent(t))}catch{}
    }}
  return [...secrets]
}
export function finalizePyusdPerAnchorTerminal(writer,accounting,terminal){
  const bounded=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max
  check(typeof accounting.directory==='string'&&accounting.directory.startsWith(resolve(ROOT,'data/research/venue-signals/morpho-multi-asset-native-history-pyusd-per-anchor-'))&&accounting.directory.length<=512,'terminal_directory')
  check(bounded(accounting.physicalStarts,276)&&bounded(accounting.preDispatches,276)&&Array.isArray(accounting.controls)&&accounting.controls.length<=2,'terminal_accounting')
  const controls=accounting.controls.map(c=>{
    check(typeof c.label==='string'&&/^(anchor_[01]|failed_control)$/.test(c.label)&&bounded(c.physicalStarts,138)&&bounded(c.pendingSettlements,138),'terminal_control')
    return {label:c.label,physicalStarts:c.physicalStarts,pendingSettlements:c.pendingSettlements,
      failure:c.failure===null?null:'native_control_failed',acquiredAtUtc:c.acquiredAtUtc,
      originalsRetained:c.originalsRetained===true,availableAtUtc:c.originalsRetained===true?c.availableAtUtc:null}
  })
  const result={directory:accounting.directory,physicalStarts:accounting.physicalStarts,preDispatches:accounting.preDispatches,
    controls,pendingSettlements:controls.reduce((n,c)=>n+c.pendingSettlements,0),failure:accounting.failure,
    SDKphysicalStarts:null,...flags}
  try{
    const body=seal({...terminal,physicalStarts:result.physicalStarts,preDispatches:result.preDispatches,controls,
      pendingSettlements:result.pendingSettlements,SDKphysicalStarts:null,...flags})
    check(Buffer.byteLength(JSON.stringify(body))<=512*1024,'terminal_bound')
    writer.write('terminal.json',body,true)
    return {...result,terminalRetained:true,retentionFailure:null}
  }catch{
    return {...result,status:'partial',failure:result.failure??'pyusd_anchor_terminal_retention_unavailable',
      terminalRetained:false,retentionFailure:'terminal_retention_rejected'}
  }
}
export async function capturePyusdPerAnchorNativeHistory(){
  const p=preparePyusdPerAnchorNativeHistory(),{plan,base,basis}=p
  const origins=await configuredUsd3HypotheticalOrigins();check(origins.length===2&&origins.every((o,n)=>o.host===HOSTS[n]),'origins')
  const secrets=secretsFor(origins),dir=resolve(ROOT,'data/research/venue-signals/morpho-multi-asset-native-history-pyusd-per-anchor-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID())
  const writer=createMorphoMultiAssetWriter(dir,secrets),start=performance.now(),startedAtUtc=new Date().toISOString()
  let active=null,activeTraces=[],rpcId=0,dispatches=0,physicalStarts=0,failure=null
  const counted=new Map(),points=[],controls=[]
  const unchanged=()=>{
    for(const {pin}of p.sources)check(sha(read(pathOf(pin.path)))===pin.fileSha256,'source_drift')
    for(const ref of plan.basisReferences)check(sha(read(pathOf(ref.path),true))===ref.fileSha256,'basis_drift')
    check(sha(read(PLAN))===PLAN_SHA&&sha(read(SELF))===sha(p.producerBytes),'producer_drift')
  }
  const before=()=>{check(performance.now()-start<480000&&free()>=256n*1024n*1024n,'deadline_or_reserve');unchanged();check(performance.now()-start<480000,'deadline')}
  const timer=setTimeout(()=>active?.stop('cohort_deadline'),480000)
  const send=async(control,spec,host,traces,label)=>{
    before();check(dispatches<276,'dispatch_budget')
    const request={jsonrpc:'2.0',id:++rpcId,method:spec.method,params:spec.params},bytes=Buffer.from(JSON.stringify(request))
    check(bytes.length<=2048,'request_bound');writer.write(label+'-'+rpcId+'-request.bin',bytes,false,true)
    const t={host:HOSTS[host],key:spec.key,request,requestBodyBase64:bytes.toString('base64'),requestBodySha256:sha(bytes),physicalId:null,envelope:null};traces.push(t)
    check(performance.now()-start<480000,'deadline');dispatches++
    const response=await control.fetcher(origins[host].url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:bytes.toString('utf8')})
    const raw=Buffer.from(await response.arrayBuffer());check(raw.length<=65536,'response_bound')
    t.physicalId=Number(response.headers.get('x-usd3-physical-id'));check(Number.isSafeInteger(t.physicalId)&&t.physicalId>0,'physical_id')
    writer.write(label+'-'+rpcId+'-response.bin',raw,false,true)
    t.envelope=parseUsd3HypotheticalJson(new TextDecoder('utf-8',{fatal:true}).decode(raw));return t.envelope
  }
  const stage=async(control,specs,traces,label)=>{
    for(let n=0;n<specs.length;n+=3){control.beginStage(label+'_'+n)
      for(const spec of specs.slice(n,n+3))for(let h=0;h<2;h++)await send(control,spec,h,traces,label)}
  }
  const finish=async(control,traces,label)=>{
    const receipt=await control.finish()
    if(active===control)active=null
    check(Number.isSafeInteger(receipt.physicalStarts)&&receipt.physicalStarts>=0&&receipt.physicalStarts<=138&&
      Number.isSafeInteger(receipt.pendingSettlements)&&receipt.pendingSettlements>=0&&receipt.pendingSettlements<=138,'physical_count')
    let summary=counted.get(control)
    if(!summary){
      physicalStarts+=receipt.physicalStarts
      summary={label,physicalStarts:receipt.physicalStarts,pendingSettlements:receipt.pendingSettlements,
        failure:receipt.failure===null?null:'native_control_failed',acquiredAtUtc:receipt.availableAtUtc,
        originalsRetained:false,availableAtUtc:null}
      counted.set(control,summary);controls.push(summary)
    }
    check(physicalStarts<=276,'physical_budget')
    const settlements=structuredClone(control.settlementReceipts)
    assertMorphoMultiAssetPrivacy({receipt,settlements,traces},secrets);verifyMorphoMultiAssetReceipt(receipt,traces,settlements)
    writer.write(label+'-originals.json',seal({schema:'pyusd_per_anchor_native_originals_v1',namespace:randomUUID(),receipt,settlements,traces,...flags}))
    const availableAtUtc=new Date().toISOString();summary.originalsRetained=true;summary.availableAtUtc=availableAtUtc
    check(receipt.failure===null&&receipt.pendingSettlements===0,'control_failure');before();return {receipt,availableAtUtc}
  }
  try{
    writer.write('input-plan.json',p.planBytes);writer.write('executing-source.mjs',p.producerBytes)
    for(const [n,{pin,bytes}]of p.sources.entries())writer.write('source-'+n+'-'+pin.path.split('/').at(-1),bytes)
    writer.write('research-basis.json',seal({source:basis.source,nativeCurrentSharesRaw:'0',fixedHypotheticalSharesRaw:basis.fixedSharesRaw,
      acquiredAtUtc:basis.acquiredAtUtc,originalControlAvailableAtUtc:basis.availableAtUtc,originalReferences:plan.basisReferences,...flags}))
    for(const [index,anchor]of plan.anchors.entries()){
      before();const source=anchor.source,label='anchor_'+index
      check(Date.now()>=Date.parse(source.blockTime)&&BigInt(source.blockNumber)>=BigInt(base.subject.creationBlockNumber),'source_time')
      active=createUsd3HypotheticalCaptureControl(origins);const traces=[];activeTraces=traces
      const initial=pyusdPerAnchorConfigurationReadPlan(base,source);await stage(active,initial,traces,label+'_configuration')
      check(pair(traces,'chain')==='0x1'&&same(pairedHeader(traces,'header_before'),source),'source_before')
      check(decodePyusdHistoricalNativeResult('asset',pair(traces,'vault_asset')).toLowerCase()===base.subject.asset&&
        decodePyusdHistoricalNativeResult('decimals',pair(traces,'vault_decimals'))===18&&decodePyusdHistoricalNativeResult('decimals',pair(traces,'asset_decimals'))===6&&
        decodePyusdHistoricalNativeResult('liquidityAdapter',pair(traces,'liquidityAdapter')).toLowerCase()===base.adapter,'identity_units_adapter')
      const native=pyusdPerAnchorNativeConfiguration(base,pair(traces,'liquidityData'))
      if(index===0)check(native.liquidityData===plan.knownOctober1LiquidityData,'known_prior_configuration')
      const capacity=pyusdPerAnchorCapacityReadPlan(native,source,basis.owner);await stage(active,capacity,traces,label+'_own_market')
      const market=decodePyusdHistoricalNativeResult('market',pair(traces,'market')),nativeParams=decodePyusdHistoricalNativeResult('idToMarketParams',pair(traces,'marketParams'))
      check(market.length===6&&same(nativeParams.map(String).map(x=>x.toLowerCase()),native.params.map(String).map(x=>x.toLowerCase())),'native_market_parameters')
      const {call,bracket}=helpers(native,source)
      const tail=[call('borrowRate',native.dependencies.adaptiveCurveIrm,'borrowRateView',[
        Object.fromEntries(['loanToken','collateralToken','oracle','irm','lltv'].map((k,n)=>[k,native.params[n]])),
        Object.fromEntries(['totalSupplyAssets','totalSupplyShares','totalBorrowAssets','totalBorrowShares','lastUpdate','fee'].map((k,n)=>[k,market[n]]))]),
        call('full_net_ea',native.subject.vault,'previewRedeem',[BigInt(basis.fixedSharesRaw)]),bracket('header_after')]
      await stage(active,tail,traces,label+'_quote')
      check(same(pairedHeader(traces,'header_after'),source),'source_after')
      const runtimes={}
      for(const spec of [...initial,...capacity].filter(x=>x.method==='eth_getCode'))runtimes[spec.key]=keccak256(pair(traces,spec.key))
      check(same(runtimes,p.expectedRuntimes),'runtime_continuity')
      for(const [key,value]of Object.entries(base.slotWords))check(pair(traces,'slot_'+key)===value,'implementation_slot')
      check(decodePyusdHistoricalNativeResult('isAdapter',pair(traces,'isAdapter'))===true&&
        decodePyusdHistoricalNativeResult('parentVault',pair(traces,'parentVault')).toLowerCase()===base.subject.vault&&
        decodePyusdHistoricalNativeResult('asset',pair(traces,'adapter_asset')).toLowerCase()===base.subject.asset&&
        decodePyusdHistoricalNativeResult('morpho',pair(traces,'morpho')).toLowerCase()===base.dependencies.morpho&&
        decodePyusdHistoricalNativeResult('adaptiveCurveIrm',pair(traces,'adaptiveCurveIrm')).toLowerCase()===base.dependencies.adaptiveCurveIrm,'native_dependencies')
      const facts={}
      for(const spec of [...initial,...capacity,...tail].filter(s=>s.name))facts[spec.key]=decodePyusdHistoricalNativeResult(spec.name,pair(traces,spec.key))
      const retained=await finish(active,traces,label)
      const acquiredAtUtc=new Date(Math.max(...retained.receipt.ledger.map(r=>Date.parse(r.completedAtUtc)))).toISOString()
      const point=JSON.parse(json({source,acquiredAtUtc,originalsAvailableAtUtc:retained.availableAtUtc,
        owner:null,fixedSharesRaw:basis.fixedSharesRaw,shareBasis:'explicit_hypothetical_research_S',
        assetDecimals:6,shareDecimals:18,adapter:native.adapter,liquidityData:native.liquidityData,marketParams:native.params,marketId:native.marketId,
        allocationIds:native.allocationIds,configurationRegimeId:native.configurationRegimeId,nativeFacts:facts,runtimes,...flags}))
      writer.write(label+'-facts.json',seal(point));points.push({...point,availableAtUtc:new Date().toISOString()})
    }
    before();check(points.length===2&&physicalStarts===144,'complete_points')
  }catch(e){
    failure=String(e?.message??'').startsWith('pyusd_anchor_')?String(e.message).slice(0,96):'pyusd_anchor_native_or_retention_unavailable'
    if(active){active.stop('research_capture_failed');try{await finish(active,activeTraces,'failed_control')}catch{}active=null}
  }finally{clearTimeout(timer)}
  const terminalResult=finalizePyusdPerAnchorTerminal(writer,{directory:dir,physicalStarts,preDispatches:dispatches,controls,failure},{schema:'pyusd_per_anchor_native_history_terminal_v1',failure,captureStatus:failure?'partial':'research_points_retained',
    startedAtUtc,qualificationClockBeforeTerminalFsync:new Date().toISOString(),elapsedMsBeforeTerminalFsync:performance.now()-start,
    completionBoundary:'originals_and_point_facts_fsynced_before_terminal_metadata',postTerminalRetentionQualified:false,
    physicalStarts,preDispatches:dispatches,SDKphysicalStarts:null,publishedPointCount:points.length,controls,
    points,retainedBasisConfiguration:{source:basis.source,configurationRegimeId:p.retainedCurrentConfiguration.configurationRegimeId,
      liquidityData:p.retainedCurrentConfiguration.liquidityData,sourceClass:'retained_research_reference_not_current_quote'},
    configurationRegimeSummary:points.length===2?pyusdResearchConfigurationRegimes(p.retainedCurrentConfiguration,points):null,
    historicalPointsVsRetainedBasis:points.map(point=>({source:point.source,configurationRegimeId:point.configurationRegimeId,
      matchesRetainedBasis:point.configurationRegimeId===p.retainedCurrentConfiguration.configurationRegimeId})),
    stationaryCurrentToHistoryRegimeAssumed:false,
    researchBasis:plan.researchBasis,currentAcquisitionPerformed:false,producerSourceObserved:sha(p.producerBytes),inputPlanSha256:PLAN_SHA,
    files:[...writer.files],chargedBytesBeforeTerminal:writer.charged(),...flags})
  let postRetentionWithinDeadline=false
  if(terminalResult.terminalRetained)try{before();postRetentionWithinDeadline=true}catch{}
  return {...terminalResult,status:terminalResult.failure||!postRetentionWithinDeadline?'partial':'research_capture_complete',
    failure:terminalResult.failure??(!postRetentionWithinDeadline?'postretention_resource_or_source_gate':null),
    publishedPointCount:points.length,postRetentionWithinDeadline,
    availableAtUtc:terminalResult.terminalRetained?new Date().toISOString():null}
}
export async function main(argv=process.argv.slice(2)){
  check(argv.length===2&&argv[0]==='--capture'&&argv[1]==='acknowledge-research-only','usage')
  const result=await capturePyusdPerAnchorNativeHistory();console.log(JSON.stringify(result));if(result.status!=='research_capture_complete')process.exitCode=1
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error(JSON.stringify({status:'partial',failure:'pyusd_anchor_preflight_or_retention_unavailable',...flags}));process.exitCode=1})
