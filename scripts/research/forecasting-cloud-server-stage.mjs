/** Production server + one fixed client stage. Invoked only by the sealed full-app supervisor. */
import {spawn} from 'node:child_process'
import http from 'node:http'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
import {dirname,resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const kind=process.argv[2]
if(process.argv.length!==3||!['http','browser'].includes(kind))throw Error('only_fixed_http_or_browser_stage_allowed')
const home=process.env.HOME,runRoot='/workspace/membrane-datasets/forecasting-cloud/full-app-plan/runs'
if(!home||!isAbsolute(home)||relative(runRoot,home).startsWith('..')||home===runRoot)throw Error('fresh_supervised_evidence_HOME_required')
if(process.env.MEMBRANE_CLOUD_ACCEPTANCE!=='fixture')throw Error('explicit_fixture_mode_required')
if(!existsSync(resolve(ROOT,'.next/BUILD_ID')))throw Error('sealed_production_build_required_no_automatic_build')
const output=resolve(home,'run',kind);mkdirSync(output,{recursive:true})
// Browser config derives this same output from fresh supervised HOME, never a caller run ID.
const proof={schema:'forecasting_full_app_server_stage_v1',kind,origin:'http://127.0.0.1:3005',
 productionServer:true,automaticBuild:false,fixtureMode:'audited_history_synthetic_current_and_scenario',
 networkBoundary:'inherited_managed_policy_plus_userspace_guards_not_kernel_denial',outcome:'running',
 readinessAttempts:0,children:[],failure:null,cleanup:[]}
const save=()=>writeFileSync(resolve(output,'stage-receipt.json'),JSON.stringify(proof,null,2)+'\n')
save()
const children=[],exitPromises=new Map()
function start(name,args){
 const child=spawn(process.execPath,args,{cwd:ROOT,env:process.env,stdio:'inherit',detached:false})
 children.push(child);proof.children.push({name,pid:child.pid??null,argv:args});save()
 exitPromises.set(child,new Promise(resolveExit=>{child.once('exit',(code,signal)=>resolveExit({code,signal}));child.once('error',error=>resolveExit({code:null,signal:null,error:error.code??'spawn_error'}))}))
 return child
}
function delay(ms){return new Promise(done=>setTimeout(done,ms))}
function bounded(promise,ms){return new Promise(done=>{const timer=setTimeout(()=>done(null),ms);promise.then(value=>{clearTimeout(timer);done(value)})})}
function probe(){
 return new Promise(done=>{
  let settled=false;const finish=ok=>{if(!settled){settled=true;clearTimeout(timer);done(ok)}}
  const req=http.get('http://127.0.0.1:3005/api/carry/forecast-universe',{agent:false},res=>{
   let bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){res.destroy();finish(false)}})
   res.on('end',()=>finish(res.statusCode===200));res.on('error',()=>finish(false))
  });const timer=setTimeout(()=>{req.destroy();finish(false)},1000);req.on('error',()=>finish(false))
 })
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode!==null)return
 child.kill('SIGTERM')
 const soft=await bounded(exitPromises.get(child),2000)
 if(!soft){child.kill('SIGKILL');await bounded(exitPromises.get(child),2000)}
 proof.cleanup.push({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode,
  directChildStopped:child.exitCode!==null||child.signalCode!==null});save()
}
let interrupted=false
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{interrupted=true;for(const child of children)child.kill('SIGTERM')})
try {
 // NODE_OPTIONS keeps the launcher's sealed memory/network guard in server descendants.
 const server=start('next-production',[...process.execArgv,resolve(ROOT,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3005'])
 const until=Date.now()+20000;let ready=false
 while(Date.now()<until&&proof.readinessAttempts<16&&!interrupted){
  if(server.exitCode!==null||server.signalCode!==null)throw Error('production_server_exited_before_ready')
  proof.readinessAttempts++;save()
  if(await probe()){ready=true;break}
  await delay(200)
 }
 if(!ready)throw Error('production_readiness_deadline_exceeded')
 const keepArgs=process.execArgv.filter(arg=>!/^--max[-_]old[-_]space[-_]size(?:=|$)/.test(arg)&&!/^--max[-_]semi[-_]space[-_]size(?:=|$)/.test(arg))
 const args=kind==='http'?[...keepArgs,'--max-old-space-size=192','--max-semi-space-size=1',
  resolve(ROOT,'scripts/research/forecasting-cloud-http-driver.mjs'),'--output',output,'--fixture']:
  [...process.execArgv,resolve(ROOT,'node_modules/@playwright/test/cli.js'),'test','--config',
   resolve(ROOT,'scripts/research/forecasting-cloud.playwright.config.ts'),'--workers=1']
 const client=start(kind,args),result=await bounded(exitPromises.get(client),kind==='http'?100000:300000)
 if(!result)throw Error('fixed_client_stage_deadline_exceeded')
 if(interrupted||result.code!==0)throw Error(`${kind}_client_failed`)
 if(server.exitCode!==null||server.signalCode!==null)throw Error('production_server_exited_during_client')
 proof.outcome='passed'
} catch(error){proof.outcome='failed';proof.failure=error instanceof Error?error.message:'stage_failure';process.exitCode=1}
finally {
 for(const child of [...children].reverse())await stop(child)
 if(proof.cleanup.some(c=>!c.directChildStopped)){proof.outcome='failed';proof.failure='direct_child_cleanup_incomplete';process.exitCode=1}
 // Independent launcher must also verify all births/descendants and closed3005; this is direct-child cleanup only.
 save()
}
