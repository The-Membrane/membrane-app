#!/usr/bin/env python3
"""DRAFT synthetic execution-only benchmark. Requires explicit parent-reviewed gate."""
import argparse, hashlib, importlib.util, json, multiprocessing as mp, os
from pathlib import Path
import shutil, signal, subprocess, sys, time
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
 os.environ[k]='1'
sys.dont_write_bytecode=True
SOURCE=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-operational-continuation-v3/train_models.py')
SOURCE_SHA='0e2a3d54c33a1ad98d1cc09ab2d87dfe7c6612d58a7301b7cd31b4a484b25ff6'
ARMS=('linear','xgb_base','xgb_shape');RSS_CAP=1_000_000_000;RESERVE=2_000_000_000

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def verify_source():
 if sha(SOURCE)!=SOURCE_SHA:raise ValueError('frozen trainer pin mismatch')
def load_source():
 verify_source();spec=importlib.util.spec_from_file_location('frozen_r17',SOURCE)
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def fixture(n=10000,eval_n=1000):
 import numpy as np
 r=np.random.default_rng(1701)
 def rows(k):
  base=r.normal(size=(k,12)).astype(np.float32);shape=r.normal(size=(k,6)).astype(np.float32)
  base[r.random(base.shape)<.03]=np.nan;shape[r.random(shape.shape)<.03]=np.nan
  p=np.tile(np.array([.01,.04,.10,.20,.35]),(k,1)).astype(np.float64)
  # Fixed synthetic weak state signal, complete monotone binary targets.
  u=r.random(k)[:,None];q=np.clip(p+.01*np.nan_to_num(base[:,0,None]),.001,.999)
  return dict(Xbase=base,Xshape=shape,p_fH=p,y=(u<q).astype(np.uint8))
 return rows(n),rows(eval_n)

def prediction_identity(a,b):
 import numpy as np
 if a.dtype!=b.dtype or a.shape!=b.shape or a.tobytes()!=b.tobytes():raise AssertionError('prediction dtype, shape or bytes differ; no tolerance waiver')
 return dict(bitwise_equal=a.tobytes()==b.tobytes(),sha256=hashlib.sha256(a.tobytes()).hexdigest(),n=len(a),max_abs_difference=float(np.max(np.abs(a-b))))

def worker(conn):
 os.setsid();start=time.monotonic()
 journal=os.environ.get('Q26_BENCH_OWNERSHIP_JOURNAL')
 if journal:
  fd=os.open(journal,os.O_WRONLY|os.O_APPEND)
  try:os.write(fd,(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})+'\n').encode())
  finally:os.close(fd)
 try:
  m=load_source();source_import=time.monotonic()-start
  t=time.monotonic();import xgboost as xgb
  if xgb.__version__!='3.4.1':raise ValueError('wrong XGBoost version')
  xgb_import=time.monotonic()-t
  conn.send(('ready',dict(source_import_seconds=source_import,xgb_import_seconds=xgb_import,pid=os.getpid())))
  while True:
   task=conn.recv()
   if task is None:break
   arm,train,evaluate,sent=task;received=time.monotonic();t=received
   xt,yt,mt=m.expand(train,__import__('numpy').arange(len(train['y'])),shape=arm=='xgb_shape')
   xe,_,me=m.expand(evaluate,__import__('numpy').arange(len(evaluate['y'])),shape=arm=='xgb_shape')
   expand=time.monotonic()-t;pre=[0.]
   # Timers wrap exact frozen routines and return their values without modification.
   original_fit,original_impute=m.impute_fit,m.impute
   def timed(fn):
    def call(*a,**kw):
     t=time.monotonic()
     try:return fn(*a,**kw)
     finally:pre[0]+=time.monotonic()-t
    return call
   m.impute_fit=timed(original_fit);m.impute=timed(original_impute);t=time.monotonic()
   try:pred,details=m.fit_predict(arm,xt,yt,mt,xe,me)
   finally:m.impute_fit=original_fit;m.impute=original_impute
   total=time.monotonic()-t
   conn.send(('result',pred,dict(arm=arm,ipc_send_to_receive_seconds=received-sent,expansion_seconds=expand,imputation_seconds=pre[0],fit_predict_total_seconds=total,fit_predict_less_imputation_seconds=total-pre[0],details=details,worker_completed_monotonic=time.monotonic())))
 except BaseException as ex:
  try:conn.send(('error',type(ex).__name__+': '+str(ex)[:500]))
  except (BrokenPipeError,EOFError):pass
 finally:conn.close()

def parse_sample(text,parent,group,observer=None):
 allrows=[]
 for line in text.splitlines():
  f=line.split()
  if len(f)!=5:raise ValueError('malformed process metadata')
  pid,ppid,pgid,rss=map(int,f[:4]);state=f[4]
  if pid<=0 or ppid<0 or pgid<0 or rss<0 or not state or not(state[0].isalpha() or state[0]=='?'):raise ValueError('invalid process metadata')
  allrows.append((pid,ppid,pgid,rss,state))
 if len({r[0] for r in allrows})!=len(allrows):raise ValueError('duplicate process PID')
 owned={parent,group}
 while True:
  expanded=owned|{pid for pid,ppid,pgid,_,_ in allrows if ppid in owned or pgid==group}
  if expanded==owned:break
  owned=expanded
 rows=[]
 for pid,ppid,pgid,rss,state in allrows:
  if pid in owned and pid!=observer:
   if state.startswith('?'):raise ValueError('owned RSS unknown; fail closed')
   rows.append((pid,rss*1024,state))
 if not any(p==parent for p,_,_ in rows):raise ValueError('missing benchmark parent RSS')
 return rows

def guard(group,deadline):
 remaining=deadline-time.monotonic()
 if remaining<=0:raise TimeoutError('whole benchmark 60-second deadline')
 if shutil.disk_usage(Path(__file__).parent).free<RESERVE:raise RuntimeError('disk reserve')
 probe=subprocess.Popen(['/bin/ps','-axo','pid=,ppid=,pgid=,rss=,stat='],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:stdout,stderr=probe.communicate(timeout=min(3.,remaining))
 except BaseException:
  probe.kill();probe.communicate(timeout=1.);raise
 if probe.returncode:raise RuntimeError('process probe failed')
 rows=parse_sample(stdout,os.getpid(),group,probe.pid);rss=sum(r for _,r,_ in rows)
 if rss>RSS_CAP:raise MemoryError('sampled parent plus worker group RSS cap')
 return rss

def cleanup(p):
 if p.pid is None:return
 # Worker owns a distinct session. Kill its whole group even after leader exit.
 for sig in (signal.SIGTERM,signal.SIGKILL):
  try:os.killpg(p.pid,sig)
  except ProcessLookupError:pass
  p.join(.5)
 if p.is_alive():p.kill();p.join(.5)
 if p.is_alive():raise RuntimeError('worker still alive')
 # Numeric metadata only. Zombies are distinguished from live descendants.
 ps=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,rss=,stat='],capture_output=True,text=True,timeout=2.)
 if ps.returncode:raise RuntimeError('cleanup census failed')
 live=[l for l in ps.stdout.splitlines() if len(l.split())==5 and int(l.split()[2])==p.pid and not l.split()[4].startswith('Z')]
 if live:raise RuntimeError('live worker group remains')

def receive(conn,p,deadline,resource):
 while True:
  resource['sampled_peak_parent_plus_worker_rss_bytes']=max(resource['sampled_peak_parent_plus_worker_rss_bytes'],guard(p.pid,deadline))
  if conn.poll(.02):
   msg=conn.recv()
   if msg[0]=='error':raise RuntimeError(msg[1])
   return msg
  if not p.is_alive():
   if conn.poll(0):continue
   raise RuntimeError('worker exited without reply')

def run(output):
 if output.exists():raise FileExistsError('fresh output required')
 verify_source();start=time.monotonic();deadline=start+60.;res={'sampled_peak_parent_plus_worker_rss_bytes':0};report={'status':'RUNNING','source_sha256':SOURCE_SHA,'resource':res,'results':[]}
 output.mkdir();p=None;parent=None
 try:
  guard(-1,deadline);train,evaluate=fixture();ctx=mp.get_context('spawn');predictions={}
  for mode in ('fresh','persistent'):
   p=None;parent=None
   for arm in ARMS:
    if p is None:
     parent,child=ctx.Pipe();p=ctx.Process(target=worker,args=(child,));t=time.monotonic();p.start();child.close();ready=receive(parent,p,deadline,res)
     if ready[0]!='ready':raise ValueError('worker handshake')
     readyinfo=dict(ready[1],spawn_to_ready_seconds=time.monotonic()-t)
    else:readyinfo=None
    t=time.monotonic();parent.send((arm,train,evaluate,time.monotonic()));msg=receive(parent,p,deadline,res)
    if msg[0]!='result':raise ValueError('worker result protocol')
    _,pred,timings=msg;timings.update(mode=mode,ready=readyinfo,parent_task_roundtrip_seconds=time.monotonic()-t)
    timings['result_receive_after_worker_complete_seconds']=time.monotonic()-timings.pop('worker_completed_monotonic')
    if mode=='fresh':predictions[arm]=pred
    else:timings['parity']=prediction_identity(predictions[arm],pred)
    report['results'].append(timings)
    if mode=='fresh':parent.send(None);p.join(min(.5,max(0,deadline-time.monotonic())));cleanup(p);parent.close();p=None
   if p is not None:parent.send(None);p.join(min(.5,max(0,deadline-time.monotonic())));cleanup(p);parent.close();p=None
  guard(-1,deadline);verify_source();report['status']='COMPLETE'
 except BaseException as ex:report.update(status='FAILED',error_type=type(ex).__name__,error=str(ex)[:500]);raise
 finally:
  try:
   if p is not None:cleanup(p)
  finally:
   if parent is not None:parent.close()
   report['elapsed_seconds']=time.monotonic()-start
   (output/'result.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
 return report

def main():
 a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);a.add_argument('--parent-reviewed',action='store_true');args=a.parse_args()
 if not args.parent_reviewed:raise SystemExit('DRAFT: explicit parent-reviewed execution gate required')
 root=Path(__file__).resolve().parent
 if args.output.resolve().parent!=root:raise ValueError('output must be fresh direct child of benchmark directory')
 run(args.output)
if __name__=='__main__':main()
