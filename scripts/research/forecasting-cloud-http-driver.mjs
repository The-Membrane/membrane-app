/** Read-only HTTP preparation. Run only inside the separately reviewed bounded supervisor. */
import http from 'node:http'
import {createHash} from 'node:crypto'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,relative} from 'node:path'
const ROOT='/workspace/work', BASE='http://127.0.0.1:3005', MAX_REQUESTS=16,MAX_BYTES=1048576,TIMEOUT_MS=10000
const args=process.argv.slice(2)
const fixtureMode=args.length===3&&args[2]==='--fixture'
if((args.length!==2&&!fixtureMode)||args[0]!=='--output')throw Error('usage: node scripts/research/forecasting-cloud-http-driver.mjs --output /workspace/work/forecasting-full-app-http [--fixture]')
const output=resolve(args[1]),rel=relative(ROOT,output)
if(!rel||rel.startsWith('..')||rel.startsWith('/'))throw Error('output_must_be_workspace_work_child')
mkdirSync(output,{recursive:true})
const usdc='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',owner='0x0000000000000000000000000000000000000001'
const manifest={schema:'forecasting_bounded_http_manifest_v1',base:BASE,maxRequests:MAX_REQUESTS,
 maxResponseBytes:MAX_BYTES,timeoutMs:TIMEOUT_MS,redirects:0,concurrency:1,
 transport:'node_http_direct_ipv4_loopback_no_proxy',
 allowedMethods:{GET:['/ethereum/carry','/api/carry/forecast-universe','/api/carry/forecast-artifacts','/api/carry/route-context',...(fixtureMode?['/api/carry/cloud-acceptance-holder','/cloud-acceptance/holder']:[])],POST:['/api/carry/holder-exit-assessment']},
 mode:fixtureMode?'read_only_explicit_synthetic_holder_fixture_no_live_qualification':'read_only_provider_unavailable_no_live_qualification',
 networkBoundary:'userspace_localhost_driver_only_not_kernel_wide_denial',requests:[]}
const records=[]
function progress(){writeFileSync(resolve(output,'receipt.json'),JSON.stringify({schema:'forecasting_bounded_http_receipt_v1',outcome:'running',requestCount:manifest.requests.length,completedRequests:records.length,records,liveProviderQualified:false,financialTransactions:false,productionDeployment:false},null,2)+'\n')}
progress()
function request(name,path,method='GET',body){
 if(manifest.requests.length>=MAX_REQUESTS)throw Error('request_budget_exceeded')
 const url=new URL(path,BASE)
 if(url.origin!==BASE||url.username||url.password||!(manifest.allowedMethods[method]??[]).includes(url.pathname))throw Error('request_not_enrolled')
 const bytes=body===undefined?null:Buffer.from(JSON.stringify(body))
 const descriptor={name,method,path:url.pathname+url.search,body:body??null}
 manifest.requests.push(descriptor)
 writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');progress()
 return new Promise((done,reject)=>{
  const start=Date.now(),chunks=[];let count=0,settled=false
  const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)}
  const req=http.request(url,{method,agent:false,headers:{'Accept':name==='carry_page'?'text/html':'application/json',
   ...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
   res.on('data',chunk=>{count+=chunk.length;if(count>MAX_BYTES){res.destroy();req.destroy();fail(Error('response_byte_budget_exceeded'))}else chunks.push(chunk)})
   res.on('error',fail)
   res.on('end',()=>{
    if(settled)return;settled=true;clearTimeout(timer)
    const raw=Buffer.concat(chunks),record={...descriptor,status:res.statusCode,bytes:raw.length,
     sha256:createHash('sha256').update(raw).digest('hex'),elapsedMs:Date.now()-start,
     contentType:res.headers['content-type']??null,assertions:[]}
    records.push(record);progress();writeFileSync(resolve(output,`${String(records.length).padStart(2,'0')}-${name}.body`),raw)
    done({record,text:raw.toString('utf8'),json:()=>JSON.parse(raw.toString('utf8'))})
   })
  })
  const timer=setTimeout(()=>{req.destroy();fail(Error('request_deadline_exceeded'))},TIMEOUT_MS)
  req.on('error',fail);if(bytes)req.write(bytes);req.end()
 })
}
function check(response,condition,label){response.record.assertions.push({label,passed:!!condition});if(!condition)throw Error(`assertion_failed:${label}`)}
function errorResponse(r,status,error){const v=r.json();check(r,r.record.status===status&&v.error===error,`${status}:${error}`)}
let outcome='failed',failure=null
try{
 const page=await request('carry_page','/ethereum/carry')
 check(page,page.record.status===200&&page.text.includes('__NEXT_DATA__')&&page.text.includes('Membrane Carry'),'real_carry_html_200')
 const universe=await request('forecast_universe','/api/carry/forecast-universe'),u=universe.json()
 check(universe,universe.record.status===200&&u.chainId===1&&u.status==='source_inventory_only'&&Array.isArray(u.routeGroups),'universe_schema')
 check(universe,u.totals?.routeGroups>=25&&u.routeGroups.length===u.totals.routeGroups&&u.routeGroups.every(g=>g.forecastValidation==='not_validated'),'frozen_groups_preserved_with_supplements')
 const group=u.routeGroups.find(g=>g.routeKey==='USDC → supply on Aave V3'),dest=group?.contractSubjects?.[0]?.destinationAddress
 check(universe,/^0x[0-9a-f]{40}$/.test(dest??''),'aave_usdc_registered_destination')
 const artifacts=await request('forecast_artifacts','/api/carry/forecast-artifacts'),a=artifacts.json()
 check(artifacts,artifacts.record.status===200&&Array.isArray(a.artifacts)&&a.artifacts.every(x=>typeof x.name==='string'&&typeof x.text==='string')&&new Set(a.artifacts.map(x=>x.name)).size===a.artifacts.length,'optional_artifact_transport_schema')
 errorResponse(await request('invalid_route_context','/api/carry/route-context'),400,'invalid_route_event_question')
 const question={routeKey:group.routeKey,destination:dest,requestedRaw:'1000000',payoutAsset:usdc,assetDecimals:6,horizonHours:24}
 const query=new URLSearchParams(Object.entries(question).map(([k,v])=>[k,String(v)]))
 const context=await request('aave_route_context',`/api/carry/route-context?${query}`),c=context.json()
 check(context,context.record.status===200&&c.status==='route_event_context'&&Object.entries(question).every(([k,v])=>c.question?.[k]===v),'route_context_question_binding')
 check(context,c.forecastValidated===false&&c.prospectiveValidated===false&&c.holderExecutableExit===false&&c.newsImpact?.status==='unavailable','route_context_no_false_forecast_or_execution')
 errorResponse(await request('invalid_holder','/api/carry/holder-exit-assessment','POST',{}),400,'invalid_holder_exit_request')
 const holder=await request('holder_provider_unavailable','/api/carry/holder-exit-assessment','POST',{
  routeKey:group.routeKey,destinationAddress:dest,owner,assetsRaw:'1000000',horizonHours:24})
 errorResponse(holder,503,'holder_exit_assessment_unavailable')
 check(holder,holder.json().nativeCashHolderOutlook==null,'no_cash_claim_without_current_original_provider_receipts')
 if(fixtureMode){
  for(const variant of ['adequate','below','censored']){
   const r=await request(`fixture_${variant}`,`/api/carry/cloud-acceptance-holder?variant=${variant}`),f=r.json()
   const assessment=f.props?.holderAssessment,model=assessment?.nativeCashHolderOutlook
   check(r,r.record.status===200&&f.fixtureKind==='audited-history-synthetic-current-and-scenario'&&!!model,'explicit_synthetic_fixture_label')
   check(r,model.owner===assessment.owner&&model.requestedRaw===assessment.request?.assetsRaw&&model.horizonHours===assessment.request?.horizonHours&&model.identity?.asset===assessment.request?.assetAddress,'fixture_question_binding')
   check(r,model.forecastValidated===false&&model.holderExecutableExit===false&&model.calibratedProbability===false,'fixture_no_live_forecast_execution_or_calibration')
   if(variant==='censored')check(r,model.process.targetSummary===null&&model.process.scenarios.every(x=>x.status==='censored_path'&&x.targetHeadroomRaw===null),'all_censored_fixture')
   if(variant==='adequate')check(r,model.process.scenarios.every(x=>x.status==='conditional_path'&&x.targetHeadroomRaw==='1'&&x.sampledShortfalls.length===0),'adequate_no_shortfall_fixture')
  }
  const fixturePage=await request('holder_fixture_page','/cloud-acceptance/holder')
  check(fixturePage,fixturePage.record.status===200&&fixturePage.text.includes('__NEXT_DATA__'),'explicit_fixture_page_html')
 }
 outcome='passed'
}catch(error){failure=error instanceof Error?error.message:'driver_failure'}finally{
 writeFileSync(resolve(output,'receipt.json'),JSON.stringify({schema:'forecasting_bounded_http_receipt_v1',outcome,failure,
  requestCount:manifest.requests.length,completedRequests:records.length,records,
  liveProviderQualified:false,financialTransactions:false,productionDeployment:false},null,2)+'\n')
}
if(outcome!=='passed')process.exitCode=1
