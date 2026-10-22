"""Bounded saved-prediction accounting. No price-model fitting or simulation."""
from pathlib import Path
import argparse,gzip,hashlib,io,json,math,os,resource,shutil,signal,sys,time,types
POLICY=dict(wall_seconds=90,rss_bytes=1073741824,output_bytes=67108864,disk_reserve_bytes=2147483648)
DECODE_CAP=100663296

def need(ok,msg):
 if not ok:raise ValueError(msg)
def pin(path):
 p=Path(path);need(p.is_absolute() and p.resolve()==p and not p.is_symlink() and p.is_file(),'canonical file')
 raw=p.read_bytes();return dict(path=str(p),size=len(raw),sha256=hashlib.sha256(raw).hexdigest())
def read(q):
 need(pin(q['path'])==q,'pinned input drift');return Path(q['path']).read_bytes()
def module(q,name):
 m=types.ModuleType(name);m.__file__=q['path'];sys.modules[name]=m;exec(compile(read(q),q['path'],'exec'),vars(m));return m

def decode(raw,expected_sha,cap=DECODE_CAP):
 with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:out=f.read(cap+1)
 need(len(out)<=cap,'decompression cap')
 need(hashlib.sha256(out).hexdigest()==expected_sha,'published uncompressed identity')
 def reject(v):raise ValueError('nonfinite JSON '+v)
 return json.loads(out,parse_constant=reject)

def run(path,sha,out):
 start=time.monotonic();q=pin(path);need(q['sha256']==sha,'trusted request');r=json.loads(read(q));p=r['pins']
 need(r['schema']=='q26-weighted-causal-primary-pair-saved-request-v1' and r['saved_only'] is True and r['parent_admitted'] is True,'admitted saved scope')
 need(r['purpose']=='fixed_O12_prediction_error_accounting' and r['mode'] in ('produce','check') and type(r['fixture_only']) is bool,'fixed purpose/mode')
 need(r['policy']==POLICY and r['out']==out and p['implementation']==pin(__file__),'bound runner/output/policy')
 target=Path(out);need(target.is_absolute() and target.resolve()==target and target.parent.is_dir() and not target.exists() and not target.is_symlink(),'fresh output')
 need(r['invocation_python']==sys.executable and r['resolved_python']==str(Path(sys.executable).resolve()),'interpreter')
 for v in p.values():read(v)
 prior=signal.getsignal(signal.SIGALRM)
 def timeout(*_):raise TimeoutError('90s saved accounting cap')
 signal.signal(signal.SIGALRM,timeout);signal.setitimer(signal.ITIMER_REAL,90)
 try:
  C=module(p['accepted_runtime_consumer'],'q26_step_accepted_context');old=json.loads(read(p['accepted_runtime_request']))
  need(old['pins']['implementation']==p['accepted_runtime_consumer'],'accepted runtime context source')
  need(r['threads']==old['threads'] and all(os.environ.get(k)==v for k,v in r['threads'].items()),'thread environment')
  producer,watched,_=C.saved_context(old);watched += [q,*p.values()]
  def bound():
   rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
   need(time.monotonic()-start<90 and rss<=POLICY['rss_bytes'] and shutil.disk_usage(target.parent).free>=POLICY['disk_reserve_bytes'],'resource envelope')
  bound();G=C.module(producer['pins']['read_guard'],'q26_step_read_guard')
  with G.guard([v['path'] for v in watched],target.parent):
   manifest=json.loads(read(p['published_manifest']));raw=read(p['intraday_archive']);step_raw=read(p['step_archive'])
   for name,data in [('intraday-real.json.gz',raw),('step-real.json.gz',step_raw)]:
    declared=manifest['files'][name];need(len(data)==declared['bytes'] and hashlib.sha256(data).hexdigest()==declared['sha256'],'published compressed identity')
   data=decode(raw,manifest['files']['intraday-real.json.gz']['uncompressed_sha256']);bound()
   step=decode(step_raw,manifest['files']['step-real.json.gz']['uncompressed_sha256']);bound()
   need(type(data) is dict and type(data.get('rows')) is list and len(data['rows'])<=300000 and type(step) is dict,'bounded decoded schema')
   D=module(p['analysis'],'q26_step_error_analysis')
   if r['mode']=='produce':result=D.analyze(data,step)
   else:
    produced=json.loads(read(p['produced_output']));production=json.loads(read(p['production_request']));terminal=json.loads(read(p['production_terminal']));observed=json.loads(read(p['production_observer_request']))
    need(produced['schema']=='q26-step-error-accounting-accepted-v1' and produced['accepted'] is True and produced['mode']=='produce' and produced['fixture_only'] is r['fixture_only'] and produced['request']==p['production_request'],'completed production evidence')
    need(all(produced[k]==0 for k in ('new_fits','new_forecasts')) and produced['raw_bars_read'] is False,'unchanged saved scientific scope')
    need(production['schema']==r['schema'] and production['purpose']==r['purpose'] and production['policy']==r['policy'] and production['parent_admitted'] is True and production['saved_only'] is True and production['fixture_only'] is r['fixture_only'],'production scope binding')
    need(production['mode']=='produce' and production['out']==p['produced_output']['path'] and production['pins']['implementation']==p['implementation'],'production source/output binding')
    need(all(production[k]==r[k] for k in ('threads','invocation_python','resolved_python')),'production execution context')
    for key in ('published_manifest','intraday_archive','step_archive','accepted_runtime_consumer','accepted_runtime_request'):
     need(production['pins'][key]==p[key],'production input identity')
    need(terminal['schema']=='q26-weighted-causal-primary-pair-observer-terminal-v1' and terminal['complete'] is True and terminal['process_terminal'] is True and type(terminal['tool_terminal_exit']) is int and terminal['tool_terminal_exit']==0 and terminal['containment']['reaped'] is True and terminal['containment']['no_live_members_remaining'] is True,'terminal production required')
    need(terminal['fixture_only'] is r['fixture_only'] and observed.get('fixture_only',False) is r['fixture_only'],'production fixture boundary')
    need(terminal['request']==p['production_observer_request'] and terminal['runner']==p['implementation'] and observed['inner_request']==p['production_request'] and observed['output']==p['produced_output']['path'],'observed production binding')
    result=D.check(data,step,produced['result'])
   bound()
   for v in watched:need(pin(v['path'])==v,'post-analysis input drift')
   record=dict(schema='q26-step-error-accounting-accepted-v1',accepted=True,mode=r['mode'],fixture_only=r['fixture_only'],request=q,result=result,elapsed_seconds=time.monotonic()-start,new_fits=0,new_forecasts=0,raw_bars_read=False)
   encoded=(json.dumps(record,allow_nan=False,separators=(',',':'))+'\n').encode();need(len(encoded)<=POLICY['output_bytes'],'output cap');C.atomic(target,record);bound()
   return record
 finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,prior)

if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--request',required=True);a.add_argument('--sha256',required=True);a.add_argument('--out',required=True);v=a.parse_args();run(v.request,v.sha256,v.out)
