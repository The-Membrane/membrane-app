"""Saved-only deterministic accounting. No CAL, forecast or original-shard read."""
from pathlib import Path
import hashlib,json,os,sys,time,signal,resource,shutil,types
POLICY=dict(wall_seconds=90,rss_bytes=1073741824,output_bytes=67108864,disk_reserve_bytes=2147483648)
def need(ok,msg):
 if not ok:raise ValueError(msg)
def pin(p):
 p=Path(p);need(p.is_absolute() and p.resolve()==p and not p.is_symlink(),'canonical pin');h=hashlib.sha256();n=0
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b);n+=len(b)
 return dict(path=str(p),size=n,sha256=h.hexdigest())
def read(p):
 need(pin(p['path'])==p,'immutable pin');return Path(p['path']).read_bytes()
def module(p,name):
 m=types.ModuleType(name);m.__file__=p['path'];sys.modules[name]=m;exec(compile(read(p),p['path'],'exec'),vars(m));return m
def run(path,sha,out):
 started=time.monotonic();q=pin(path);need(q['sha256']==sha,'trusted request');r=json.loads(read(q))
 need(r['schema']=='q26-weighted-causal-primary-pair-saved-request-v1' and r['purpose']=='fixed_interval_score_accounting' and r['parent_admitted'] is True and r['saved_only'] is True,'fixed saved accounting scope')
 need(r['policy']==POLICY and r['out']==out,'fixed bound output/policy');p=r['pins']
 need(p['implementation']==pin(__file__),'actual implementation')
 target=Path(out);need(target.is_absolute() and target.resolve()==target and not target.exists() and not target.is_symlink() and target.parent.is_dir(),'fresh output')
 for v in p.values():read(v)
 need(r['invocation_python']==sys.executable and r['resolved_python']==str(Path(sys.executable).resolve()),'interpreter')
 prior=signal.getsignal(signal.SIGALRM)
 def timeout(*_):raise TimeoutError('90s saved accounting cap')
 signal.signal(signal.SIGALRM,timeout);signal.setitimer(signal.ITIMER_REAL,90)
 try:
  C=module(p['accepted_consumer'],'q26_accounting_accepted_context')
  old=json.loads(read(p['accepted_saved_request']));a=json.loads(read(p['parent_acceptance']));b=json.loads(read(p['independent_acceptance']))
  need(a['accepted'] is True and b['accepted'] is True and a['saved_only'] is True and b['saved_only'] is True,'two accepted saved authorities')
  need(a['request']==p['accepted_saved_request'] and a['output_pins']==b['output_pins']==old['outputs'] and a['proof']==b['proof'],'accepted saved identity binding')
  need(old['pins']['implementation']==p['accepted_consumer'] and r['threads']==old['threads'] and all(os.environ.get(k)==v for k,v in r['threads'].items()),'context/source/thread binding')
  producer,watched,_=C.saved_context(old)
  watched += [q,*p.values()]
  def bound():
   rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
   need(time.monotonic()-started<90 and rss<=POLICY['rss_bytes'] and shutil.disk_usage(target.parent).free>=POLICY['disk_reserve_bytes'],'resource envelope')
  bound();G=C.module(producer['pins']['read_guard'],'q26_accounting_read_guard')
  with G.guard([x['path'] for x in watched],target.parent):
   import numpy as np
   D=module(p['components'],'q26_fixed_score_components');payloads={}
   for H,k in ((24,5),(72,7)):
    with np.load(old['outputs'][f'cell-{H}-k{k}.npz']['path'],allow_pickle=False) as z:payloads[(H,k)]={name:z[name] for name in z.files}
    bound()
   result=D.analyze(np,payloads,C.read(old['outputs']['public-summary.json']));bound()
   for v in watched:need(pin(v['path'])==v,'post-accounting byte drift')
   record=dict(schema='q26-range-score-components-accepted-v1',accepted=True,purpose=r['purpose'],request=q,result=result,
     elapsed_seconds=time.monotonic()-started,unchanged_saved_outputs=True,original_totals_exact=True,component_reduction_allowance='64 epsilon scaled verification policy, not a proved universal bound or statistical interval',
     no_original_shard_reads=True,new_model_fits=0,new_calibration_fits=0,new_forecasts=0)
   raw=(json.dumps(record,allow_nan=False,separators=(',',':'))+'\n').encode();need(len(raw)<=POLICY['output_bytes'],'output cap');C.atomic(target,record);bound()
  return record
 finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,prior)
if __name__=='__main__':
 import argparse
 ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--sha256',required=True);ap.add_argument('--out',required=True);a=ap.parse_args();run(a.request,a.sha256,a.out)
