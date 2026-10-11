/** Real retained inputs + unsigned controlled mutations; never calls a capture factory. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, decodeFunctionData } from 'viem'
import { ABI } from '../../scripts/research/morpho-v2-adapter-capacity-capture.mjs'
import { verifyMorphoMultiAssetReceipt, assertMorphoMultiAssetPrivacy } from '../../scripts/research/morpho-multi-asset-native-history-capture.mjs'
import {
  preparePyusdPerAnchorNativeHistory, pyusdPerAnchorNativeConfiguration,
  pyusdPerAnchorConfigurationReadPlan, pyusdPerAnchorCapacityReadPlan,
  pyusdResearchConfigurationRegimes, decodePyusdHistoricalNativeResult, finalizePyusdPerAnchorTerminal, main,
} from '../../scripts/research/morpho-pyusd-per-anchor-native-history-capture.mjs'
const prepared=preparePyusdPerAnchorNativeHistory()
const {plan,base,basis,historical,retainedCurrentConfiguration:current}=prepared
const source=plan.anchors[0].source
const params=['address','address','address','address','uint256'].map(type=>({type}))
const encoded=data=>encodeAbiParameters([{type:'bytes'}],[data])
const changed=values=>encodeAbiParameters(params,values)
const fixture=name=>JSON.parse(readFileSync(new URL('../../'+plan.basisReferences.find(r=>r.path.endsWith('/'+name)).path,import.meta.url),'utf8'))
test('pinned current and failed originals retain exact native row/RPC/host/settlement joins',()=>{
  for(const name of ['point_0-originals.json','failed_control-originals.json']){
    const r=fixture(name);assert.equal(verifyMorphoMultiAssetReceipt(r.receipt,r.traces,r.settlements),true)
  }
})
test('retained basis is explicitly hypothetical S with no newly acquired current',()=>{
  assert.equal(basis.currentOwnerSharesRaw,'0');assert.equal(basis.fixedSharesRaw,'1000000000000000000')
  assert.equal(basis.shareBasis,'explicit_hypothetical_research_S')
  assert.equal(plan.researchBasis.acquiredAtUtc,basis.acquiredAtUtc)
  assert.equal(plan.researchBasis.availableAtUtc,basis.availableAtUtc)
})
test('real paired failed-prefix tuple supplies historical collateral/oracle77percent',()=>{
  const r=fixture('failed_control-originals.json'),ts=r.traces.filter(t=>t.key==='liquidityData')
  assert.equal(ts.length,2);assert.equal(ts[0].envelope.result,ts[1].envelope.result)
  const c=pyusdPerAnchorNativeConfiguration(base,ts[0].envelope.result)
  assert.equal(c.params[1].toLowerCase(),'0x45804880de22913dafe09f4980848ece6ecbaf78')
  assert.equal(c.params[2].toLowerCase(),'0xa0514f4035f013941cf63c203dced759c95cface')
  assert.equal(c.params[4],770000000000000000n)
})
test('current86percent tuple remains separate from observed historical tuple',()=>{
  assert.equal(current.params[4],860000000000000000n)
  assert.notEqual(current.marketId,historical.marketId)
  assert.notEqual(current.configurationRegimeId,historical.configurationRegimeId)
})
test('two same historical regimes cannot imply a stable retained-current regime',()=>{
  const summary=pyusdResearchConfigurationRegimes(current,[historical,historical])
  assert.equal(summary.historicalRegimesDiffer,false)
  assert.deepEqual(summary.historicalMatchesRetainedBasis,[false,false])
  assert.equal(summary.retainedBasisLiquidityData,current.liquidityData)
  assert.equal(summary.stationaryCurrentToHistoryRegimeAssumed,false)
  assert.equal(summary.noStationaryRegimePooling,true);assert.equal(summary.forecastAuthority,false)
})
test('a changed later historical regime is independently recorded against retained basis',()=>{
  const summary=pyusdResearchConfigurationRegimes(current,[historical,current])
  assert.equal(summary.historicalRegimesDiffer,true)
  assert.deepEqual(summary.historicalMatchesRetainedBasis,[false,true])
  assert.equal(summary.forecastAuthority,false)
})
test('forged regime label cannot override its exact native datum binding',()=>{
  assert.throws(()=>pyusdResearchConfigurationRegimes(current,[{...historical,configurationRegimeId:current.configurationRegimeId},historical]),/regime_binding/)
})
test('history chain/config12 + owncapacity21 + quote/header3 gives144 starts',()=>{
  assert.equal(pyusdPerAnchorConfigurationReadPlan(base,source).length,12)
  assert.equal(pyusdPerAnchorCapacityReadPlan(historical,source,basis.owner).length,21)
  assert.equal(2*2*(12+21+3),144);assert.equal(plan.policy.expectedPhysicalStarts,144)
  assert.equal(plan.policy.defaultControlStarts,138);assert.equal(plan.policy.maximumPhysicalStarts,276)
})
test('configuration stage contains no market/position/allocation calls or native owner query',()=>{
  const p=pyusdPerAnchorConfigurationReadPlan(base,source)
  assert.ok(p.every(s=>!['market','marketParams','position','allocation0','allocation1','allocation2','owner_current_shares'].includes(s.key)))
  assert.equal(p.at(-1).key,'liquidityData')
})
test('actual historical market getter calldata uses its own native marketId',()=>{
  const p=pyusdPerAnchorCapacityReadPlan(historical,source,basis.owner)
  for(const key of ['internalSupplyShares','expectedSupplyAssets','marketParams','market','position','rateAtTarget']){
    const s=p.find(x=>x.key===key),decoded=decodeFunctionData({abi:ABI,data:s.params[0].data})
    assert.equal(decoded.args[0],historical.marketId)
    assert.notEqual(decoded.args[0],current.marketId)
  }
})
test('all three allocation getters bind per-point native IDs, not pilot/current IDs',()=>{
  const p=pyusdPerAnchorCapacityReadPlan(historical,source,basis.owner)
  for(let n=0;n<3;n++){
    const s=p.find(x=>x.key==='allocation'+n),decoded=decodeFunctionData({abi:ABI,data:s.params[0].data})
    assert.equal(decoded.args[0],historical.allocationIds[n])
  }
  assert.equal(historical.allocationIds[0],current.allocationIds[0])
  assert.notEqual(historical.allocationIds[1],current.allocationIds[1])
  assert.notEqual(historical.allocationIds[2],current.allocationIds[2])
})
test('current-market substitution rejects before a historical capacity plan can be built',()=>{
  assert.throws(()=>pyusdPerAnchorCapacityReadPlan({...historical,marketId:current.marketId},source,basis.owner),/wrong_market_or_allocations/)
})
test('current allocation substitution rejects despite unchanged adapter',()=>{
  assert.throws(()=>pyusdPerAnchorCapacityReadPlan({...historical,allocationIds:current.allocationIds},source,basis.owner),/wrong_market_or_allocations/)
})
test('current parameter substitution rejects despite the same native loan asset and IRM',()=>{
  assert.throws(()=>pyusdPerAnchorCapacityReadPlan({...historical,params:current.params},source,basis.owner),/wrong_market_or_allocations/)
})
test('each state/code/storage call is pinned to its exact canonical historical hash',()=>{
  const all=[...pyusdPerAnchorConfigurationReadPlan(base,source),...pyusdPerAnchorCapacityReadPlan(historical,source,basis.owner)]
  for(const s of all.filter(s=>!['eth_chainId','eth_getBlockByNumber'].includes(s.method)))
    assert.deepEqual(s.params.at(-1),{blockHash:source.blockHash,requireCanonical:true})
})
test('wrong native loan asset or IRM never becomes a supported tuple',()=>{
  const badAsset=[...historical.params];badAsset[0]='0x0000000000000000000000000000000000000001'
  assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(changed(badAsset))),/market_dependencies/)
  const badIrm=[...historical.params];badIrm[3]='0x0000000000000000000000000000000000000001'
  assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(changed(badIrm))),/market_dependencies/)
})
test('zero collateral/oracle and LLTV endpoints reject rather than inventing a market',()=>{
  for(const index of [1,2]){
    const p=[...historical.params];p[index]='0x'+'0'.repeat(40)
    assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(changed(p))),/market_dependencies/)
  }
  for(const n of [0n,1000000000000000000n]){
    const p=[...historical.params];p[4]=n
    assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(changed(p))),/market_dependencies/)
  }
})
test('trailing ABI bytes and wrong tuple length reject',()=>{
  assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(historical.liquidityData)+'00'),/ABI_canonical/)
  assert.throws(()=>pyusdPerAnchorNativeConfiguration(base,encoded(historical.liquidityData.slice(0,-64))),/market_datum/)
})
test('native full-S quote decoder rejects malformed/trailing output without Q scaling',()=>{
  assert.equal(decodePyusdHistoricalNativeResult('previewRedeem',encodeAbiParameters([{type:'uint256'}],[1234567n])),1234567n)
  assert.throws(()=>decodePyusdHistoricalNativeResult('previewRedeem',encodeAbiParameters([{type:'uint256'}],[1234567n])+'00'),/ABI_canonical/)
})
test('late settlement escaped credential remains blocked by the unchanged raw privacy helper',()=>{
  const raw=String.raw`{"error":"\u0070rivateToken"}`
  const late={settlements:[{observation:{rawBodyBase64:Buffer.from(raw).toString('base64')}}]}
  assert.throws(()=>assertMorphoMultiAssetPrivacy(late,['privateToken']),/privacy/)
})
test('source plan pins preserve exact originals and unchanged legacy writer reserve',()=>{
  assert.equal(plan.basisReferences.length,4);assert.equal(plan.sourcePins.length,22)
  const old=readFileSync(new URL('../../scripts/research/morpho-v2-adapter-capacity-capture.mjs',import.meta.url),'utf8')
  assert.match(old,/reserveBytes:\s*1073741824/)
  assert.equal(plan.policy.prejobBytes,288*1024**2);assert.equal(plan.policy.reserveBytes,256*1024**2)
})
test('CLI needs explicit research acknowledgement before any capture',async()=>{
  await assert.rejects(main([]),/usage/)
  await assert.rejects(main(['--capture','production']),/usage/)
})

test('terminal reserve rejection preserves74 actual native starts and pending0 from pinned originals',()=>{
  const {receipt}=fixture('point_0-originals.json')
  assert.equal(receipt.physicalStarts,74);assert.equal(receipt.pendingSettlements,0);assert.equal(receipt.failure,null)
  const directory=new URL('../../data/research/venue-signals/morpho-multi-asset-native-history-pyusd-per-anchor-controlled-fault',import.meta.url).pathname
  const accounting={directory,physicalStarts:receipt.physicalStarts,preDispatches:74,failure:null,
    controls:[{label:'anchor_0',physicalStarts:receipt.physicalStarts,pendingSettlements:receipt.pendingSettlements,
      failure:receipt.failure,acquiredAtUtc:receipt.availableAtUtc,originalsRetained:true,availableAtUtc:receipt.availableAtUtc}]}
  let writes=0,written
  const result=finalizePyusdPerAnchorTerminal({write(name,body,terminal){
    writes++;written={name,body,terminal}
    throw Error('morpho_multi_write_reserve')
  }},accounting,{schema:'controlled_terminal_fault',publishedPointCount:0})
  assert.equal(written.name,'terminal.json');assert.equal(written.terminal,true);assert.equal(written.body.physicalStarts,74)
  assert.equal(writes,1);assert.equal(result.status,'partial');assert.equal(result.directory,directory)
  assert.equal(result.physicalStarts,74);assert.equal(result.preDispatches,74);assert.equal(result.pendingSettlements,0)
  assert.equal(result.controls[0].failure,null);assert.equal(result.controls[0].originalsRetained,true)
  assert.equal(result.retentionFailure,'terminal_retention_rejected');assert.equal(result.terminalRetained,false)
  assert.equal(result.failure,'pyusd_anchor_terminal_retention_unavailable');assert.equal(result.forecastAuthority,false)
})
test('synthetic pending control remains visible when terminal retention fails without originals',()=>{
  const directory=new URL('../../data/research/venue-signals/morpho-multi-asset-native-history-pyusd-per-anchor-synthetic-pending',import.meta.url).pathname
  const result=finalizePyusdPerAnchorTerminal({write(){throw Error('private-provider-error-must-not-escape')}},
    {directory,physicalStarts:5,preDispatches:6,failure:'pyusd_anchor_control_failure',controls:[
      {label:'failed_control',physicalStarts:5,pendingSettlements:1,failure:'synthetic_control_failure',
        acquiredAtUtc:'2026-10-09T10:00:00.000Z',originalsRetained:false,availableAtUtc:null}]},
    {schema:'explicitly_synthetic_pending_terminal'})
  assert.equal(result.physicalStarts,5);assert.equal(result.preDispatches,6);assert.equal(result.pendingSettlements,1)
  assert.equal(result.controls[0].originalsRetained,false);assert.equal(result.controls[0].availableAtUtc,null)
  assert.equal(result.controls[0].failure,'native_control_failed');assert.equal(result.failure,'pyusd_anchor_control_failure')
  assert.equal(result.retentionFailure,'terminal_retention_rejected');assert.ok(!JSON.stringify(result).includes('private-provider'))
})
test('successful terminal retention publishes accounting but does not claim postretention qualification',()=>{
  const directory=new URL('../../data/research/venue-signals/morpho-multi-asset-native-history-pyusd-per-anchor-controlled-success',import.meta.url).pathname
  let saved
  const result=finalizePyusdPerAnchorTerminal({write(name,body,terminal){saved={name,body,terminal}}},
    {directory,physicalStarts:0,preDispatches:0,failure:null,controls:[]},
    {schema:'controlled_terminal_success',postTerminalRetentionQualified:false})
  assert.equal(result.terminalRetained,true);assert.equal(result.retentionFailure,null)
  assert.equal(saved.body.postTerminalRetentionQualified,false);assert.equal(saved.terminal,true)
  assert.equal(saved.body.pendingSettlements,0);assert.equal(saved.body.executionAuthority,false)
})
