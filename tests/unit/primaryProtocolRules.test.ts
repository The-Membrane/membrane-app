import {it,expect} from 'vitest'
import {readAavePrimaryEventFacts} from '@/lib/carry/aavePrimaryEventFacts.server'
import {selectedPrimaryProtocolRules} from '@/lib/carry/primaryProtocolRules'
const q={routeKey:'USDC → supply on Aave V3',destination:'0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',payoutAsset:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',assetDecimals:6,requestedRaw:'10000',horizonHours:48},now=Date.parse('2026-10-12T12:00:00.000Z')
it('selects genuine primary protocol conditional rules for the exact route question',()=>{
 const r=readAavePrimaryEventFacts(q,now);expect(selectedPrimaryProtocolRules(r,q,now)).not.toBeNull()
 expect(selectedPrimaryProtocolRules(r,{...q,horizonHours:24},now)).toBeNull()
 expect(selectedPrimaryProtocolRules(r,{...q,payoutAsset:'0x'+'a'.repeat(40)},now)).toBeNull()
 expect(selectedPrimaryProtocolRules(r,q,now+1800001)).toBeNull()
})
it('rejects false current-state or final-exit rule claims and future evidence',()=>{
 const r=readAavePrimaryEventFacts(q,now)
 for(const patch of [{currentConfigurationKnown:true},{holderExitUpperBoundRaw:'100'},{targetAtUtc:'2026-10-13T12:00:00.000Z'}]) {
  const bad=structuredClone(r);Object.assign(bad.conditionalScenarios[0],patch);expect(selectedPrimaryProtocolRules(bad,q,now)).toBeNull()
 }
})
