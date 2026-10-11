/** Root-only bounded research capture. Importing creates no origins, providers, timers or jobs. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, writeSync, fsyncSync, fstatSync, lstatSync, statfsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters, parseAbi, keccak256 } from 'viem'
import { ABI as LEGACY_ABI } from './morpho-v2-adapter-capacity-capture.mjs'
import { configuredUsd3HypotheticalOrigins, createUsd3HypotheticalCaptureControl, parseUsd3HypotheticalJson } from './usd3-hypothetical-history-capture.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const SELF = fileURLToPath(import.meta.url)
const PLAN = resolve(ROOT, 'scripts/research/morpho-multi-asset-native-history.plan.json')
const PLAN_SHA = '7130129a0d942011e5af45987c96845e6fde37a55badbb48f5937fc1da07967f'
const MB = 1024 * 1024, FILE = 8 * MB, TOTAL = 32 * MB, TAIL = 512 * 1024
const ZERO = '0x' + '0'.repeat(40), MAX = (1n << 256n) - 1n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const PARAMS = ['address','address','address','address','uint256'].map(type => ({type}))
const ABI = [...LEGACY_ABI, ...parseAbi([
  'function previewRedeem(uint256 shares) view returns(uint256)',
  'function withdraw(uint256 assets,address receiver,address owner) returns(uint256)',
])]
const flags = Object.freeze({ researchOnly:true, profileApproval:false, authenticated:false,
  originalIssuanceAuthority:false, sourceImplementationEquivalence:false, forecastAuthority:false,
  executionAuthority:false, historicalOwnership:false, calibratedProbability:false, coveragePromotion:false, MRaw:null })
const sha = b => createHash('sha256').update(b).digest('hex')
const seal = body => ({...body,sha256:sha(JSON.stringify(body))})
const check = (ok,why) => { if (!ok) throw Error('morpho_multi_'+why) }
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const uint = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v)<=MAX
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && v!==ZERO
const freeze = v => {if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
const json = v => JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x)
function syncDir(p) { const fd=openSync(p,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd)}finally{closeSync(fd)} }
function free() {const s=statfsSync(ROOT,{bigint:true});return s.bavail*s.bsize}
function read(p,privateMode=false) {
  const named=lstatSync(p);check(named.isFile()&&!named.isSymbolicLink()&&named.nlink===1&&named.size<=FILE,'file')
  if(privateMode)check((named.mode&0o777)===0o600,'private_mode')
  const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const a=fstatSync(fd),b=readFileSync(fd),z=fstatSync(fd),n=lstatSync(p)
    check(b.length===a.size&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===z[k]&&z[k]===n[k])&&n.nlink===1&&!n.isSymbolicLink(),'file_drift')
    return b
  } finally {closeSync(fd)}
}
function pinned(p) {check(typeof p==='string'&&!p.includes('..')&&!p.startsWith('/')&&!p.includes('\\'),'relative_pin');return resolve(ROOT,p)}
function bodySeal(v) {const {sha256,...body}=v;check(sha(JSON.stringify(body))===sha256,'body_seal');return body}
function header(v) {
  check(v&&/^0x[0-9a-f]+$/.test(v.number)&&/^0x[0-9a-f]{64}$/.test(v.hash)&&/^0x[0-9a-f]+$/.test(v.timestamp),'header')
  return {chainId:1,blockNumber:String(BigInt(v.number)),blockHash:v.hash,blockTime:new Date(Number(BigInt(v.timestamp))*1000).toISOString()}
}
function decode(name,data) {
  check(typeof data==='string'&&/^0x(?:[0-9a-f]{2})*$/.test(data),'ABI_result')
  const value=decodeFunctionResult({abi:ABI,functionName:name,data})
  const outputs=ABI.find(x=>x.type==='function'&&x.name===name).outputs
  check(encodeAbiParameters(outputs,outputs.length===1?[value]:value)===data,'ABI_canonical')
  return value
}
function pairedHeader(traces,key) {
  const hs=HOSTS.map(host=>{const xs=traces.filter(t=>t.host===host&&t.key===key);check(xs.length===1&&!xs[0].envelope.error,'header_pair');return header(xs[0].envelope.result)})
  check(same(hs[0],hs[1]),'header_identity');return hs[0]
}
function pair(traces,key) {
  const xs=HOSTS.map(host=>traces.filter(t=>t.host===host&&t.key===key))
  check(xs.every(x=>x.length===1)&&xs.every(x=>x[0].envelope&&!x[0].envelope.error)&&
    same(xs[0][0].envelope.result,xs[1][0].envelope.result),'paired_result')
  return xs[0][0].envelope.result
}
export function assertMorphoMultiAssetPrivacy(value,secrets) {
  let nodes=0,bytes=0;const seen=new Set()
  function scan(s) {
    bytes+=Buffer.byteLength(s);check(bytes<=32*MB&&!secrets.some(t=>s.includes(t)),'privacy')
    let x=s
    for(let n=0;n<2;n++){try{x=decodeURIComponent(x)}catch{break}check(!secrets.some(t=>x.includes(t)),'privacy')}
  }
  function visit(v,key='',depth=0) {
    check(++nodes<=100000&&depth<=24,'privacy_bound')
    if(v===null||typeof v==='boolean'||typeof v==='number')return
    if(typeof v==='string') {
      scan(v)
      if(/Base64$/.test(key)) {
        const b=Buffer.from(v,'base64');check(b.length<=65536&&b.toString('base64')===v,'raw_base64')
        const s=new TextDecoder('utf-8',{fatal:true}).decode(b);scan(s)
        let parsed
        try{parsed=parseUsd3HypotheticalJson(s)}catch{check(!s.includes('\\'),'malformed_escaped');return}
        visit(parsed,'',depth+1)
      }
      return
    }
    check(typeof v==='object'&&!seen.has(v)&&Object.getOwnPropertySymbols(v).length===0,'privacy_plain')
    const a=Array.isArray(v),p=Object.getPrototypeOf(v)
    check(a?p===Array.prototype:p===Object.prototype||p===null,'privacy_plain')
    const ds=Object.getOwnPropertyDescriptors(v);check(Object.values(ds).every(d=>Object.hasOwn(d,'value')),'privacy_accessor')
    seen.add(v)
    try{for(const [k,d]of Object.entries(ds)){if(a&&k==='length')continue;check(d.enumerable,'privacy_enumerable');scan(k);visit(d.value,k,depth+1)}}finally{seen.delete(v)}
  }
  visit(value);return true
}
function secretsFor(origins) {
  const out=new Set()
  for(const o of origins) {
    const u=new URL(o.url)
    // Credential query VALUES only: query names are public routing syntax.
    for(const t of [o.url,...u.pathname.split('/').filter(x=>x&&!['v2','v3','eth','rpc'].includes(x)),...u.searchParams.values()]) {
      if(!t)continue
      out.add(t);try{out.add(decodeURIComponent(t))}catch{}
    }
  }
  return [...out]
}
export function verifyMorphoMultiAssetReceipt(receipt,traces,settlements) {
  check(receipt.physicalStarts===receipt.ledger.length&&receipt.physicalStarts<=138,'physical_count')
  const used=new Set(),commits=new Map(receipt.terminalCommitments.map(c=>[c.physicalId,c.rowSha256]))
  check(commits.size===receipt.ledger.length,'commitment_count')
  for(const row of receipt.ledger) {
    check(commits.get(row.physicalId)===sha(JSON.stringify(row)),'row_seal')
    if(row.rawBodyBase64!==null) {
      const b=Buffer.from(row.rawBodyBase64,'base64');check(b.length<=65536&&b.toString('base64')===row.rawBodyBase64&&sha(b)===row.bodySha256&&b.length===row.bodyBytes,'raw_body')
    }
  }
  for(const t of traces) {
    if(t.physicalId===null)continue
    check(!used.has(t.physicalId),'duplicate_physical');used.add(t.physicalId)
    const row=receipt.ledger.find(r=>r.physicalId===t.physicalId),b=Buffer.from(t.requestBodyBase64,'base64')
    check(row&&t.host===row.host&&b.length<=2048&&b.toString('base64')===t.requestBodyBase64&&sha(b)===t.requestBodySha256&&
      same(parseUsd3HypotheticalJson(b.toString('utf8')),row.request)&&same(row.request,t.request),'request_join')
    if(t.envelope)check(t.envelope.jsonrpc==='2.0'&&t.envelope.id===t.request.id&&same(parseUsd3HypotheticalJson(Buffer.from(row.rawBodyBase64,'base64').toString('utf8')),t.envelope),'response_join')
  }
  const settled=new Set()
  for(const s of settlements){const b=bodySeal(s),row=receipt.ledger.find(r=>r.physicalId===b.physicalId)
    check(b.schema==='usd3_hypothetical_physical_settlement_v1'&&b.captureAcceptance===false&&row&&
      b.physicalId===b.observation.physicalId&&!settled.has(b.physicalId),'settlement_id');settled.add(b.physicalId)
    // Failed frozen receipts may have later observations; preserve their independently sealed truth.
    if(receipt.failure===null&&receipt.pendingSettlements===0)check(same(row,b.observation),'settlement_join')
  }
  if(receipt.failure===null&&receipt.pendingSettlements===0)check(used.size===receipt.physicalStarts&&settled.size===receipt.physicalStarts&&
    receipt.ledger.every(r=>r.accepted===true&&r.status==='success'),'complete_originals')
  return true
}
export function prepareMorphoMultiAssetNativeHistory(candidate='08') {
  const raw=read(PLAN);check(sha(raw)===PLAN_SHA,'plan_pin');const plan=JSON.parse(raw.toString())
  const c=plan.candidates.find(x=>x.id===candidate);check(c,'candidate')
  const original=read(pinned(c.discovery.path),true)
  check(original.length===c.discovery.bytes&&sha(original)===c.discovery.fileSha256,'discovery_pin')
  const packet=parseUsd3HypotheticalJson(original.toString());bodySeal(packet)
  check(packet.sha256===c.discovery.bodySha256&&same(packet.subject,c.subject)&&
    packet.facts.nativeAdapter===c.adapter&&packet.facts.liquidityData===c.liquidityData,'discovery_identity')
  verifyMorphoMultiAssetReceipt(packet.control,packet.traces,packet.settlementReceipts)
  for(const a of plan.anchors) {
    const bytes=read(pinned(a.receipt.path),true);check(bytes.length===a.receipt.bytes&&sha(bytes)===a.receipt.fileSha256,'anchor_pin')
    const r=parseUsd3HypotheticalJson(bytes.toString());bodySeal(r)
    const rows=r.rows.filter(x=>x.destination===c.subject.vault)
    check(r.sha256===a.receipt.bodySha256&&r.chainId===1&&r.block===a.source.blockNumber&&r.blockHash===a.source.blockHash&&r.blockAt===a.source.blockTime&&
      rows.length===1&&rows[0].state==='observed'&&rows[0].asset===c.subject.asset&&rows[0].assetDecimals===c.assetDecimals&&rows[0].shareDecimals===18,'anchor_identity')
  }
  const sources=plan.sourcePins.map(pin=>{const b=read(pinned(pin.path));check(b.length===pin.bytes&&sha(b)===pin.fileSha256,'source_pin');return {pin,bytes:b}})
  const configs=structuredClone(c)
  if(c.adapter!==ZERO) {
    const params=decodeAbiParameters(PARAMS,c.liquidityData)
    check(encodeAbiParameters(PARAMS,params)===c.liquidityData&&params[0].toLowerCase()===c.subject.asset&&params[3].toLowerCase()===c.dependencies.adaptiveCurveIrm,'market_parameters')
    configs.slotWords=Object.fromEntries(['vault','asset','adapter'].map(k=>[k,pair(packet.traces,'slot_'+k+'_implementation')]))
    configs.params=params;configs.marketId=keccak256(c.liquidityData)
    configs.allocationIds=[
      keccak256(encodeAbiParameters([{type:'string'},{type:'address'}],['this',c.adapter])),
      keccak256(encodeAbiParameters([{type:'string'},{type:'address'}],['collateralToken',params[1]])),
      keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'tuple',components:PARAMS}],['this/marketParams',c.adapter,params])),
    ]
  } else {check(c.scope==='idle_only_research','idle_scope')
    configs.slotWords=Object.fromEntries(['vault','asset'].map(k=>[k,pair(packet.traces,'slot_'+k+'_implementation')]))}
  return {plan,config:freeze(configs),sources,planBytes:raw,producerBytes:read(SELF)}
}
function specHelpers(c,source) {
  const pin={blockHash:source.blockHash,requireCanonical:true}
  const state=(key,method,args)=>({key,method,params:[...args,pin]})
  const call=(key,to,name,args=[],from=null)=>({key,name,...state(key,'eth_call',[{to,data:encodeFunctionData({abi:ABI,functionName:name,args}),...(from?{from,gas:'0x989680'}:{})}])})
  const code=(key,to)=>state(key,'eth_getCode',[to]),slot=(key,to)=>state(key,'eth_getStorageAt',[to,SLOT])
  const bracket=key=>({key,method:'eth_getBlockByNumber',params:['0x'+BigInt(source.blockNumber).toString(16),false]})
  return {call,code,slot,bracket}
}
export function morphoMultiAssetPointReadPlan(c,source,owner,current=false) {
  check(address(owner),'owner');const {call,code,slot,bracket}=specHelpers(c,source)
  const specs=[{key:'chain',method:'eth_chainId',params:[]},bracket('header_before'),
    code('code_vault',c.subject.vault),code('code_asset',c.subject.asset),slot('slot_vault',c.subject.vault),slot('slot_asset',c.subject.asset),
    call('vault_asset',c.subject.vault,'asset'),call('vault_decimals',c.subject.vault,'decimals'),call('asset_decimals',c.subject.asset,'decimals'),
    call('idle',c.subject.asset,'balanceOf',[c.subject.vault]),call('liquidityAdapter',c.subject.vault,'liquidityAdapter'),call('liquidityData',c.subject.vault,'liquidityData')]
  for(const [key,to] of Object.entries(c.implementationCandidates))if(to.address)specs.push(code('code_'+key+'_implementation',to.address))
  if(current)specs.push(call('owner_current_shares',c.subject.vault,'balanceOf',[owner]))
  if(c.adapter!==ZERO)specs.push(code('code_adapter',c.adapter),slot('slot_adapter',c.adapter),call('isAdapter',c.subject.vault,'isAdapter',[c.adapter]),
    call('parentVault',c.adapter,'parentVault'),call('adapter_asset',c.adapter,'asset'),call('morpho',c.adapter,'morpho'),call('adaptiveCurveIrm',c.adapter,'adaptiveCurveIrm'),
    call('internalSupplyShares',c.adapter,'supplyShares',[c.marketId]),call('expectedSupplyAssets',c.adapter,'expectedSupplyAssets',[c.marketId]),
    call('marketParams',c.dependencies.morpho,'idToMarketParams',[c.marketId]),call('market',c.dependencies.morpho,'market',[c.marketId]),
    call('position',c.dependencies.morpho,'position',[c.marketId,c.adapter]),call('feeRecipient',c.dependencies.morpho,'feeRecipient'),
    call('rateAtTarget',c.dependencies.adaptiveCurveIrm,'rateAtTarget',[c.marketId]),
    ...c.allocationIds.map((id,n)=>call('allocation'+n,c.subject.vault,'allocation',[id])),
    call('blueCash',c.subject.asset,'balanceOf',[c.dependencies.morpho]),call('adapterAllowance',c.subject.asset,'allowance',[c.adapter,c.subject.vault]),
    code('code_blue',c.dependencies.morpho),code('code_irm',c.dependencies.adaptiveCurveIrm))
  return specs
}
export function createMorphoMultiAssetWriter(dir,secrets) {
  check(dirname(resolve(dir))===resolve(ROOT,'data/research/venue-signals')&&
    resolve(dir).startsWith(resolve(ROOT,'data/research/venue-signals/morpho-multi-asset-native-history-')),'output_path')
  check(free()>=288n*BigInt(MB),'prejob_reserve');mkdirSync(dir,{mode:0o700});syncDir(dirname(dir))
  let charged=0;const files=[]
  return {files,charged:()=>charged,write(name,value,terminal=false,rawBody=false) {
    check(/^[a-zA-Z0-9_.-]+$/.test(name),'filename')
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(json(value))
    const tail=terminal?0:TAIL;check(bytes.length<=(terminal?TAIL:FILE)&&charged+bytes.length+tail<=TOTAL,'file_budget')
    check(free()>=256n*BigInt(MB)+BigInt(bytes.length+tail),'write_reserve')
    if(!Buffer.isBuffer(value))assertMorphoMultiAssetPrivacy(value,secrets)
    else {const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assertMorphoMultiAssetPrivacy(text,secrets)
      if(rawBody) {let parsed;try{parsed=parseUsd3HypotheticalJson(text)}catch{check(!text.includes('\\'),'malformed_escaped')}
        if(parsed!==undefined)assertMorphoMultiAssetPrivacy(parsed,secrets)}}
    const p=join(dir,name),fd=openSync(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    charged+=bytes.length
    try {
      let n=0;while(n<bytes.length)n+=writeSync(fd,bytes,n,bytes.length-n);fsyncSync(fd)
      const a=fstatSync(fd),b=lstatSync(p);check(a.dev===b.dev&&a.ino===b.ino&&a.size===bytes.length&&b.size===bytes.length&&b.nlink===1&&(b.mode&0o777)===0o600&&!b.isSymbolicLink(),'written_identity')
    }finally{closeSync(fd)}
    syncDir(dir);const ref={file:name,bytes:bytes.length,fileSha256:sha(bytes)};files.push(ref);return ref
  }}
}
export async function captureMorphoMultiAssetNativeHistory({candidate,owner,requestedRaw,hypotheticalSharesRaw=null}) {
  check(address(owner)&&uint(requestedRaw)&&requestedRaw!=='0'&&(hypotheticalSharesRaw===null||uint(hypotheticalSharesRaw)&&hypotheticalSharesRaw!=='0'),'research_input')
  const prepared=prepareMorphoMultiAssetNativeHistory(candidate),{config:c,plan}=prepared
  const origins=await configuredUsd3HypotheticalOrigins();check(origins.length===2&&origins.every((o,n)=>o.host===HOSTS[n]),'origins')
  const secret=secretsFor(origins),dir=resolve(ROOT,'data/research/venue-signals/morpho-multi-asset-native-history-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID())
  const out=createMorphoMultiAssetWriter(dir,secret),start=performance.now(),startedAtUtc=new Date().toISOString()
  let active=null,activeTraces=[],seq=0,physicalStarts=0,preDispatches=0,fullSharesRaw=null,currentOwnerSharesRaw=null,failure=null
  const points=[],controls=[],counted=new Set()
  const timer=setTimeout(()=>active?.stop('cohort_deadline'),plan.policy.cohortDeadlineMs)
  const unchanged=()=>{for(const {pin}of prepared.sources)check(sha(read(pinned(pin.path)))===pin.fileSha256,'source_drift');check(sha(read(SELF))===sha(prepared.producerBytes)&&sha(read(PLAN))===PLAN_SHA,'producer_drift')}
  const before=()=>{check(performance.now()-start<plan.policy.cohortDeadlineMs,'cohort_deadline');check(free()>=256n*BigInt(MB),'reserve');unchanged();check(performance.now()-start<plan.policy.cohortDeadlineMs,'cohort_deadline')}
  const send=async(control,host,spec,traces,label)=>{
    before();check(preDispatches<plan.policy.totalPhysicalCeiling,'global_dispatch_budget')
    const request={jsonrpc:'2.0',id:++seq,method:spec.method,params:spec.params},body=Buffer.from(JSON.stringify(request))
    check(body.length<=2048,'request_bound');out.write(label+'-'+seq+'-request.bin',body,false,true)
    const t={host:HOSTS[host],key:spec.key,request,requestBodyBase64:body.toString('base64'),requestBodySha256:sha(body),physicalId:null,envelope:null};traces.push(t)
    check(performance.now()-start<plan.policy.cohortDeadlineMs,'cohort_deadline');preDispatches++
    const response=await control.fetcher(origins[host].url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:body.toString()})
    const raw=Buffer.from(await response.arrayBuffer());check(raw.length<=65536,'response_bound')
    t.physicalId=Number(response.headers.get('x-usd3-physical-id'));check(Number.isSafeInteger(t.physicalId)&&t.physicalId>0,'physical_id')
    out.write(label+'-'+seq+'-response.bin',raw,false,true) // privacy and raw fsync precede JSON/ABI decoding
    t.envelope=parseUsd3HypotheticalJson(new TextDecoder('utf-8',{fatal:true}).decode(raw))
    return t.envelope
  }
  const stage=async(control,label,specs,traces)=>{
    for(let n=0;n<specs.length;n+=3){control.beginStage(label+'_'+n)
      for(const s of specs.slice(n,n+3))for(let h=0;h<2;h++)await send(control,h,s,traces,label)}
  }
  const finish=async(control,traces,label)=>{
    const receipt=await control.finish(),settlements=structuredClone(control.settlementReceipts) // snapshot ONCE, including late observations
    check(Number.isSafeInteger(receipt.physicalStarts)&&receipt.physicalStarts>=0&&receipt.physicalStarts<=138,'physical_count')
    // Charge observed starts even when privacy rejects retention; never publish unsafe original bytes.
    if(!counted.has(control)){physicalStarts+=receipt.physicalStarts;counted.add(control)}
    check(physicalStarts<=plan.policy.totalPhysicalCeiling,'global_physical_budget')
    assertMorphoMultiAssetPrivacy({receipt,settlements,traces},secret)
    verifyMorphoMultiAssetReceipt(receipt,traces,settlements)
    out.write(label+'-originals.json',seal({schema:'morpho_multi_asset_control_originals_v1',namespace:randomUUID(),receipt,settlements,traces,...flags}))
    const availableAtUtc=new Date().toISOString();controls.push({label,physicalStarts:receipt.physicalStarts,acquiredAtUtc:receipt.availableAtUtc,availableAtUtc})
    if(active===control)active=null;check(receipt.failure===null&&receipt.pendingSettlements===0,'control_failure');before();return {receipt,availableAtUtc}
  }
  try {
    out.write('input-plan.json',prepared.planBytes);out.write('executing-source.mjs',prepared.producerBytes)
    for(const [n,{pin,bytes}]of prepared.sources.entries())out.write('source-'+n+'-'+pin.path.split('/').at(-1),bytes)
    out.write('research-input.json',seal({candidate,owner,requestedRaw,hypotheticalSharesRaw,sourcePins:plan.sourcePins,producerSourceObserved:sha(prepared.producerBytes),...flags}))
    active=createUsd3HypotheticalCaptureControl(origins);let traces=[];activeTraces=traces
    await stage(active,'bootstrap',[{key:'chain',method:'eth_chainId',params:[]},{key:'finalized',method:'eth_getBlockByNumber',params:['finalized',false]}],traces)
    check(pair(traces,'chain')==='0x1','chain')
    const finals=HOSTS.map(host=>header(traces.find(t=>t.host===host&&t.key==='finalized').envelope.result))
    const B=finals.map(s=>BigInt(s.blockNumber)).reduce((a,b)=>a<b?a:b)
    await stage(active,'bootstrap_source',[{key:'common_source',method:'eth_getBlockByNumber',params:['0x'+B.toString(16),false]}],traces)
    const source=pairedHeader(traces,'common_source');check(finals.every(f=>BigInt(f.blockNumber)>=B&&(BigInt(f.blockNumber)!==B||same(f,source)))&&Date.now()>=Date.parse(source.blockTime)&&Date.now()-Date.parse(source.blockTime)<=1800000,'finalized_source')
    await finish(active,traces,'bootstrap');active=null
    for(const [index,s]of [source,...plan.anchors.map(a=>a.source)].entries()) {
      before();check(BigInt(s.blockNumber)>=BigInt(c.subject.creationBlockNumber),'precreation')
      const label='point_'+index;active=createUsd3HypotheticalCaptureControl(origins);traces=[];activeTraces=traces
      const specs=morphoMultiAssetPointReadPlan(c,s,owner,index===0)
      await stage(active,label,specs,traces)
      check(pair(traces,'chain')==='0x1'&&same(pairedHeader(traces,'header_before'),s),'point_source')
      check(decode('asset',pair(traces,'vault_asset')).toLowerCase()===c.subject.asset&&decode('decimals',pair(traces,'vault_decimals'))===18&&decode('decimals',pair(traces,'asset_decimals'))===c.assetDecimals,'units')
      check(decode('liquidityAdapter',pair(traces,'liquidityAdapter')).toLowerCase()===c.adapter&&decode('liquidityData',pair(traces,'liquidityData'))===(c.liquidityData??'0x'),'configured_datum')
      if(index===0){currentOwnerSharesRaw=String(decode('balanceOf',pair(traces,'owner_current_shares')));fullSharesRaw=currentOwnerSharesRaw==='0'?hypotheticalSharesRaw:currentOwnerSharesRaw;check(fullSharesRaw!==null&&fullSharesRaw!=='0','full_S')}
      const {call,bracket}=specHelpers(c,s),tail=[call('full_net_ea',c.subject.vault,'previewRedeem',[BigInt(fullSharesRaw)])]
      if(c.adapter!==ZERO) {
        const m=decode('market',pair(traces,'market'))
        check(m.length===6&&same(decode('idToMarketParams',pair(traces,'marketParams')).map(String).map(x=>x.toLowerCase()),c.params.map(String).map(x=>x.toLowerCase())),'market')
        tail.unshift(call('borrowRate',c.dependencies.adaptiveCurveIrm,'borrowRateView',[
          Object.fromEntries(['loanToken','collateralToken','oracle','irm','lltv'].map((k,n)=>[k,c.params[n]])),
          Object.fromEntries(['totalSupplyAssets','totalSupplyShares','totalBorrowAssets','totalBorrowShares','lastUpdate','fee'].map((k,n)=>[k,m[n]]))]))
      } else tail.push(call('requested_withdraw_simulation',c.subject.vault,'withdraw',[BigInt(requestedRaw),owner,owner],owner))
      tail.push(bracket('header_after'));await stage(active,label+'_tail',tail,traces)
      check(same(pairedHeader(traces,'header_after'),s),'source_after')
      const runtimes={}
      for(const spec of specs.filter(x=>x.method==='eth_getCode'))runtimes[spec.key]=keccak256(pair(traces,spec.key))
      const observedRuntimeMatches=Object.entries(c.runtimes).every(([key,value])=>{
        const mapped=key.replace('_implementation_candidate','_implementation')
        return runtimes['code_'+mapped]===value.runtimeKeccak256
      })
      check(observedRuntimeMatches&&(index===0||same(runtimes,points[0].runtimes)),'runtime_observation_changed')
      for(const [key,value]of Object.entries(c.slotWords))check(pair(traces,'slot_'+key)===value,'implementation_slot_changed')
      if(c.adapter!==ZERO)check(decode('isAdapter',pair(traces,'isAdapter'))===true&&
        decode('parentVault',pair(traces,'parentVault')).toLowerCase()===c.subject.vault&&
        decode('asset',pair(traces,'adapter_asset')).toLowerCase()===c.subject.asset&&
        decode('morpho',pair(traces,'morpho')).toLowerCase()===c.dependencies.morpho&&
        decode('adaptiveCurveIrm',pair(traces,'adaptiveCurveIrm')).toLowerCase()===c.dependencies.adaptiveCurveIrm,'adapter_dependencies')
      const facts={}
      for(const spec of [...specs,...tail].filter(x=>x.name&&x.key!=='requested_withdraw_simulation'))facts[spec.key]=decode(spec.name,pair(traces,spec.key))
      const simulation=c.adapter===ZERO?HOSTS.map(host=>{
        const envelope=traces.find(t=>t.host===host&&t.key==='requested_withdraw_simulation').envelope
        return {nativeEnvelope:envelope,simulationOutcome:envelope.error?'native_revert_not_execution': 'native_success_not_execution',
          returnedSharesRaw:envelope.error?null:String(decode('withdraw',envelope.result))}
      }):null
      const retained=await finish(active,traces,label);active=null
      const acquiredAtUtc=new Date(Math.max(...retained.receipt.ledger.map(r=>Date.parse(r.completedAtUtc)))).toISOString()
      const point={source:s,acquiredAtUtc,availableAtUtc:retained.availableAtUtc,scope:c.scope,owner:index===0?owner:null,
        fixedSharesRaw:fullSharesRaw,currentOwnerSharesRaw:index===0?currentOwnerSharesRaw:null,
        shareBasis:currentOwnerSharesRaw==='0'?'explicit_hypothetical_research_S':'current_native_owner_S_not_historical_ownership',
        requestedRaw,assetDecimals:c.assetDecimals,shareDecimals:18,marketId:c.marketId??null,allocationIds:c.allocationIds??null,
        nativeFacts:facts,runtimes,observedRuntimeMatches,requestedWithdrawalSimulation:simulation,...flags}
      out.write(label+'-facts.json',seal(JSON.parse(json(point))));points.push(point)
    }
    before();check(points.length===3&&Date.now()>=Date.parse(points[0].source.blockTime)&&Date.now()-Date.parse(points[0].source.blockTime)<=1800000,'final_current_TTL')
  } catch(e) {
    failure=String(e?.message??'').startsWith('morpho_multi_')?String(e.message).slice(0,96):'morpho_multi_native_unavailable'
    if(active){active.stop('research_capture_failed');try{await finish(active,activeTraces, 'failed_control')}catch{}active=null}
  } finally {clearTimeout(timer)}
  const terminal=seal({schema:'morpho_multi_asset_native_history_terminal_v1',captureStatus:failure?'partial':'native_points_retained',
    failure,startedAtUtc,qualificationClockBeforeTerminalFsync:new Date().toISOString(),elapsedMsBeforeTerminalFsync:performance.now()-start,
    completionBoundary:'point_originals_and_facts_retained_before_terminal_metadata_fsync',
    postTerminalRetentionQualified:false,candidate,subject:c.subject,controls,physicalStarts,preDispatches,pointCount:points.length,
    fullSharesRaw,currentOwnerSharesRaw,hypotheticalSharesRaw,
    shareBasis:currentOwnerSharesRaw===null?null:currentOwnerSharesRaw==='0'?'explicit_hypothetical_research_S':'native_current_owner_S',
    requestedRaw,files:[...out.files],chargedBytesBeforeTerminal:out.charged(),
    producerSourceObserved:sha(prepared.producerBytes),inputPlanFileSha256:PLAN_SHA,...flags})
  out.write('terminal.json',terminal,true)
  let postRetentionWithinDeadline=false
  try{before();check(points.length===3&&Date.now()>=Date.parse(points[0].source.blockTime)&&Date.now()-Date.parse(points[0].source.blockTime)<=1800000,'postretention_current_TTL');postRetentionWithinDeadline=true}catch{}
  return {directory:dir,status:failure||!postRetentionWithinDeadline?'partial':'research_capture_complete',
    failure:failure??(!postRetentionWithinDeadline?'postretention_resource_or_source_gate':null),physicalStarts,
    SDKphysicalStarts:null,pointCount:points.length,postRetentionWithinDeadline,availableAtUtc:new Date().toISOString(),...flags}
}
export async function main(argv=process.argv.slice(2)) {
  check(argv.length===8||argv.length===10,'usage')
  check(argv[0]==='--candidate'&&argv[2]==='--owner'&&argv[4]==='--requested-raw'&&argv[6]==='--capture','usage')
  check(argv[7]==='acknowledge-research-only','research_acknowledgement')
  if(argv.length===10)check(argv[8]==='--hypothetical-shares','usage')
  const result=await captureMorphoMultiAssetNativeHistory({candidate:argv[1],owner:argv[3],requestedRaw:argv[5],hypotheticalSharesRaw:argv[9]??null})
  console.log(JSON.stringify(result));if(result.status!=='research_capture_complete')process.exitCode=1
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error(JSON.stringify({status:'partial',failure:'morpho_multi_preflight_or_retention_unavailable',...flags}));process.exitCode=1})
