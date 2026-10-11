/** Offline orchestration and retained-data checks; importing performs no acquisition. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  prepareMorphoMultiAssetNativeHistory, morphoMultiAssetPointReadPlan,
  assertMorphoMultiAssetPrivacy, verifyMorphoMultiAssetReceipt,
  captureMorphoMultiAssetNativeHistory, createMorphoMultiAssetWriter,
} from '../../scripts/research/morpho-multi-asset-native-history-capture.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const seal=x=>({...x,sha256:sha(JSON.stringify(x))})
const owner='0x4bd98243845d823b0a79e34a873be93fb3bd7678'
const prepared=prepareMorphoMultiAssetNativeHistory('08')
const plan=prepared.plan,source=plan.anchors[0].source
const fixture=()=>JSON.parse(readFileSync(new URL('../../'+prepared.config.discovery.path,import.meta.url),'utf8'))
const verify=r=>verifyMorphoMultiAssetReceipt(r.control,r.traces,r.settlementReceipts)
const resealRow=(r,row)=>{r.control.terminalCommitments.find(c=>c.physicalId===row.physicalId).rowSha256=sha(JSON.stringify(row))}
test('retained AUSD discovery original seals and physical joins validate without capture',()=>assert.equal(verify(fixture()),true))
test('candidate identities and two authentic prior sources are fixed',()=>{
  assert.deepEqual(plan.candidates.map(c=>c.id),['08','32','14','30','16'])
  assert.deepEqual(plan.anchors.map(a=>a.source.blockNumber),['26100913','26108081'])
  assert.equal(prepared.config.subject.vault,'0x32401b9fb79065bc15949de0bd43927492f02f0c')
  assert.equal(prepared.config.params[0].toLowerCase(),prepared.config.subject.asset)
})
test('AUSD/EURCV planned job230 starts fits existing default138 per control',()=>{
  for(const id of ['08','32']){
    const c=prepareMorphoMultiAssetNativeHistory(id).config
    const current=morphoMultiAssetPointReadPlan(c,source,owner,true).length+3
    const prior=morphoMultiAssetPointReadPlan(c,source,owner,false).length+3
    assert.equal(current,38);assert.equal(prior,37);assert.equal(6+2*current+4*prior,230)
    assert.ok(current*2<=138)
  }
})
test('LINK/PYUSD correct native units and job224 starts without copied pilot IDs',()=>{
  const ids=[]
  for(const id of ['14','30']){
    const c=prepareMorphoMultiAssetNativeHistory(id).config
    assert.equal(c.assetDecimals,id==='14'?18:6);assert.equal(c.allocationIds.length,3)
    ids.push(...c.allocationIds)
    const n=morphoMultiAssetPointReadPlan(c,source,owner,true).length+3
    assert.equal(n,37);assert.equal(6+2*n+4*(n-1),224)
  }
  assert.equal(new Set(ids).size,6)
})
test('RLUSD separate idle-only plan104 starts omits every synthetic Blue/market gate',()=>{
  const c=prepareMorphoMultiAssetNativeHistory('16').config
  const specs=morphoMultiAssetPointReadPlan(c,source,owner,true)
  assert.equal(c.scope,'idle_only_research');assert.equal(c.adapter,'0x'+'0'.repeat(40))
  assert.equal(specs.length+3,17);assert.equal(6+2*17+4*16,104)
  assert.ok(specs.every(s=>!['market','position','blueCash','rateAtTarget','maxWithdraw'].includes(s.key)))
})
test('each native state/code/storage read uses exact hash canonical EIP1898',()=>{
  for(const s of morphoMultiAssetPointReadPlan(prepared.config,source,owner,true)){
    if(s.method==='eth_chainId'||s.method==='eth_getBlockByNumber')continue
    assert.deepEqual(s.params.at(-1),{blockHash:source.blockHash,requireCanonical:true})
  }
})
test('only current reads native owner S; historical plans contain no ownership query',()=>{
  const current=morphoMultiAssetPointReadPlan(prepared.config,source,owner,true)
  const prior=morphoMultiAssetPointReadPlan(prepared.config,source,owner,false)
  assert.equal(current.filter(s=>s.key==='owner_current_shares').length,1)
  assert.equal(prior.filter(s=>s.key==='owner_current_shares').length,0)
})
test('unknown candidate and malformed owner reject before origins',()=>{
  assert.throws(()=>prepareMorphoMultiAssetNativeHistory('99'),/candidate/)
  assert.throws(()=>morphoMultiAssetPointReadPlan(prepared.config,source,'0x123',true),/owner/)
})
test('invalid Q or out-of-range hypothetical S reject before async acquisition',async()=>{
  await assert.rejects(captureMorphoMultiAssetNativeHistory({candidate:'08',owner,requestedRaw:'0'}),/research_input/)
  await assert.rejects(captureMorphoMultiAssetNativeHistory({candidate:'08',owner,requestedRaw:'1',hypotheticalSharesRaw:String(1n<<256n)}),/research_input/)
})
test('RPC request IDs remain independent of capture-local physical IDs',()=>{
  const r=fixture();assert.ok(r.traces.every(t=>t.request.id===t.envelope.id))
  assert.equal(verify(r),true)
})
test('changed trace origin cannot borrow the other origin native row',()=>{
  const r=fixture();r.traces[0].host=r.traces[0].host==='rpc.ankr.com'?'eth-mainnet.g.alchemy.com':'rpc.ankr.com'
  assert.throws(()=>verify(r),/request_join/)
})
test('changed request bytes cannot borrow original row commitment',()=>{
  const r=fixture();r.traces[0].requestBodyBase64=Buffer.from('{}').toString('base64')
  r.traces[0].requestBodySha256=sha(Buffer.from('{}'))
  assert.throws(()=>verify(r),/request_join/)
})
test('changed RPC response id rejects even after response/body/row seals are regenerated',()=>{
  const r=fixture(),t=r.traces[0],row=r.control.ledger.find(x=>x.physicalId===t.physicalId)
  t.envelope.id+=1;const raw=Buffer.from(JSON.stringify(t.envelope))
  row.rawBodyBase64=raw.toString('base64');row.bodyBytes=raw.length;row.bodySha256=sha(raw);resealRow(r,row)
  assert.throws(()=>verify(r),/response_join/)
})
test('successful capture requires every original request trace',()=>{
  const r=fixture();r.traces.pop();assert.throws(()=>verify(r),/complete_originals/)
})
test('duplicate local physical trace IDs reject',()=>{
  const r=fixture();r.traces.push(r.traces[0]);assert.throws(()=>verify(r),/duplicate_physical/)
})
test('successful capture requires every sealed settlement',()=>{
  const r=fixture();r.settlementReceipts.pop();assert.throws(()=>verify(r),/complete_originals/)
})
test('same-id altered settlement cannot join a successful frozen row',()=>{
  const r=fixture(),s=r.settlementReceipts[0],{sha256,...body}=s
  body.observation={...body.observation,safeCode:'altered'}
  r.settlementReceipts[0]=seal(body);assert.throws(()=>verify(r),/settlement_join/)
})
test('bad raw response digest rejects independently of row commitment',()=>{
  const r=fixture(),row=r.control.ledger[0];row.bodySha256='0'.repeat(64);resealRow(r,row)
  assert.throws(()=>verify(r),/raw_body/)
})
test('credential query values reject while public metadata key is permitted',()=>{
  assert.equal(assertMorphoMultiAssetPrivacy({key:'native_metadata'},['privateToken']),true)
  assert.throws(()=>assertMorphoMultiAssetPrivacy({error:'privateToken'},['privateToken']),/privacy/)
})
test('raw JSON unicode and slash escapes are scanned before retention',()=>{
  const raw=String.raw`{"error":"\u0070rivateToken"}`
  assert.throws(()=>assertMorphoMultiAssetPrivacy({rawBodyBase64:Buffer.from(raw).toString('base64')},['privateToken']),/privacy/)
})
test('percent-escaped known credentials and late-not-in-ledger raw observations reject',()=>{
  const late={settlements:[{observation:{rawBodyBase64:Buffer.from('{"error":"%70rivateToken"}').toString('base64')}}]}
  assert.throws(()=>assertMorphoMultiAssetPrivacy(late,['privateToken']),/privacy/)
})
test('malformed escaped raw bytes fail closed; ordinary unescaped malformed JSON remains original failure data',()=>{
  assert.throws(()=>assertMorphoMultiAssetPrivacy({rawBodyBase64:Buffer.from(String.raw`{bad:\u0070}`).toString('base64')},['privateToken']),/malformed_escaped/)
  assert.equal(assertMorphoMultiAssetPrivacy({rawBodyBase64:Buffer.from('{bad}').toString('base64')},['privateToken']),true)
})
test('privacy rejects getters without invoking them and rejects cyclic/nonplain objects',()=>{
  let calls=0;const v={};Object.defineProperty(v,'error',{enumerable:true,get(){calls++;throw Error('invoked')}})
  assert.throws(()=>assertMorphoMultiAssetPrivacy(v,['privateToken']),/privacy_accessor/);assert.equal(calls,0)
  const cycle={};cycle.self=cycle;assert.throws(()=>assertMorphoMultiAssetPrivacy(cycle,[]),/privacy_plain/)
  assert.throws(()=>assertMorphoMultiAssetPrivacy(new Date(),[]),/privacy_plain/)
})
test('privacy rejects noncanonical base64 and duplicate native JSON keys',()=>{
  assert.throws(()=>assertMorphoMultiAssetPrivacy({rawBodyBase64:'e30='+' '},[]),/raw_base64/)
  // Duplicate JSON cannot be admitted as decoded native evidence.
  const r=fixture(),t=r.traces[0];t.requestBodyBase64=Buffer.from('{"id":1,"id":2}').toString('base64');t.requestBodySha256=sha(Buffer.from('{"id":1,"id":2}'))
  assert.throws(()=>verify(r))
})
test('writer cannot create output outside the closed cohort prefix',()=>{
  assert.throws(()=>createMorphoMultiAssetWriter('/private/tmp/not-a-morpho-cohort',[]),/output_path/)
})
test('legacy1GiB writer policy and canonical controller bounds remain untouched',()=>{
  const text=readFileSync(new URL('../../scripts/research/morpho-v2-adapter-capacity-capture.mjs',import.meta.url),'utf8')
  assert.match(text,/reserveBytes:\s*1073741824/)
  assert.equal(plan.policy.maxStartsPerControl,138);assert.equal(plan.policy.totalPhysicalCeiling,276)
  assert.equal(plan.policy.reserveBytes,256*1024**2);assert.equal(plan.policy.terminalTailBytes,512*1024)
})
