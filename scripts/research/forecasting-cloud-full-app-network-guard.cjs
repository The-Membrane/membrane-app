// Userspace host hooks only. Managed egress policy remains authoritative; no socket/native/kernel denial claim.
const fs = require('node:fs')
const path = require('node:path')
const stage = process.env.MEMBRANE_CLOUD_STAGE_KIND
const home = process.env.HOME
const root = '/workspace/membrane-datasets/forecasting-cloud/full-app-plan/runs'
if (!home || !path.isAbsolute(home) || home === root || path.relative(root, home).startsWith('..'))
  throw Error('full_app_network_guard_evidence_HOME_invalid')
if (!['full-typecheck', 'production-build', 'bounded-http', 'chromium-browser', 'selftest'].includes(stage))
  throw Error('full_app_network_guard_stage_invalid')
const directory = path.join(home, 'run'), ledger = path.join(directory, 'network-access.jsonl')
fs.mkdirSync(directory, { recursive: true })
if (fs.lstatSync(directory).isSymbolicLink() || (fs.existsSync(ledger) && fs.lstatSync(ledger).isSymbolicLink()))
  throw Error('full_app_network_guard_ledger_symlink')
const fontHosts = Object.freeze(['fonts.googleapis.com', 'fonts.gstatic.com'])
function record(hook, host, method, allowed) {
  if (fs.existsSync(ledger) && fs.statSync(ledger).size > 1048576)
    throw Error('full_app_network_guard_ledger_budget_exceeded')
  fs.appendFileSync(ledger, JSON.stringify({schema:'full_app_node_host_access_v1',stage,hook,
    host,method,outcome:allowed?'allowed':'blocked'})+'\n', {mode:0o600})
  if (!allowed) throw Error('full_app_network_guard_host_not_enrolled')
}
function check(hook, protocol, hostname, port, method) {
  // Host/method are closed-safe fields; never log paths, credentials, query strings or raw options.
  const safeHost = typeof hostname === 'string' && /^[a-z0-9.-]{1,253}$/.test(hostname) ? hostname : '<invalid>'
  const safePort = String(port), safeMethod = typeof method === 'string' && /^[A-Z]{1,16}$/.test(method) ? method : '<invalid>'
  const host = safeHost+':'+(/^\d{1,5}$/.test(safePort)?safePort:'invalid')
  const fonts = stage==='production-build' && protocol==='https:' && safePort==='443' &&
    fontHosts.includes(safeHost) && safeMethod==='GET'
  const loopback = ['bounded-http','chromium-browser'].includes(stage) && protocol==='http:' &&
    safeHost==='127.0.0.1' && safePort==='3005' && ['GET','POST','HEAD'].includes(safeMethod)
  record(hook,host,safeMethod,fonts||loopback)
}
function target(hook, defaultProtocol, args) {
  try {
    const first=args[0], second=args[1]
    let options, url
    if(typeof first==='string'||first instanceof URL){url=new URL(first);options=second&&typeof second==='object'?second:{}}
    else if(first&&typeof first==='object'){options=first}
    else return check(hook,'','<invalid>','invalid','<invalid>')
    const protocol=options.protocol??url?.protocol??defaultProtocol
    let hostname=options.hostname??options.host??url?.hostname??'localhost'
    let port=options.port??url?.port??''
    if(typeof hostname==='string'&&hostname.includes(':')&&!options.hostname){
      const pieces=hostname.split(':');if(pieces.length!==2)return check(hook,'','<invalid>','invalid','<invalid>')
      hostname=pieces[0];port=port||pieces[1]
    }
    check(hook,protocol,hostname,port|| (protocol==='https:'?'443':'80'),options.method??'GET')
  } catch(error) {
    if(error?.message?.startsWith('full_app_network_guard_'))throw error
    record(hook,'<invalid>:invalid','<invalid>',false)
  }
}
for(const [name,protocol] of [['http','http:'],['https','https:']]) {
  const module=require('node:'+name)
  for(const key of ['request','get']) {
    const original=module[key]
    module[key]=function(...args){target(name+'.'+key,protocol,args);return Reflect.apply(original,this,args)}
  }
}
if(typeof globalThis.fetch==='function') {
  const original=globalThis.fetch
  globalThis.fetch=function(input,options){
    try {
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url)
      check('fetch',url.protocol,url.hostname,url.port||(url.protocol==='https:'?'443':'80'),
        options?.method??(typeof input==='object'?input.method:undefined)??'GET')
    } catch(error) {
      if(error?.message?.startsWith('full_app_network_guard_'))throw error
      record('fetch','<invalid>:invalid','<invalid>',false)
    }
    return Reflect.apply(original,this,[input,options])
  }
}
require('node:module').syncBuiltinESMExports()
