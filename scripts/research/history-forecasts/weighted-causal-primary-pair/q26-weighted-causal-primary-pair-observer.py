"""Bounded external resource observer. No scientific decoding or result interpretation."""
import argparse,hashlib,json,math,os,re,shutil,signal,subprocess,sys,time
from pathlib import Path
POLICY=dict(wall_seconds=120,rss_bytes=1073741824,output_bytes=67108864,disk_reserve_bytes=2147483648)
def need(ok,why):
 if not ok:raise ValueError(why)
def canonical(path):
 p=Path(path);need(p.is_absolute() and p.resolve()==p and not p.is_symlink(),'canonical path');return p
def pin(path):
 p=canonical(path);need(p.is_file(),'regular pinned file');h=hashlib.sha256();size=0
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b);size+=len(b)
 return dict(path=str(p),size=size,sha256=h.hexdigest())
def check(q):
 need(type(q)is dict and set(q)=={'path','size','sha256'} and type(q['size'])is int and q['size']>=0 and re.fullmatch('[0-9a-f]{64}',q['sha256']) and pin(q['path'])==q,'pin mismatch')
def read(q):check(q);return json.loads(Path(q['path']).read_bytes())
def exclusive(path,obj):
 raw=(json.dumps(obj,sort_keys=True,allow_nan=False)+'\n').encode()
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 need(path.read_bytes()==raw and path.stat().st_mode&0o777==0o600,'private metadata readback')
def output_size(output,logs):
 total=sum(p.stat().st_size for p in logs if p.is_file())
 if output.is_symlink():raise ValueError('output symlink')
 if output.is_file():return total+output.stat().st_size
 if output.is_dir():
  for base,dirs,files in os.walk(output,followlinks=False):
   for name in dirs+files:need(not (Path(base)/name).is_symlink(),'output symlink')
   total+=sum((Path(base)/name).stat().st_size for name in files)
 return total
def snapshot(pgid,timeout=.5):
 r=subprocess.run(['/bin/ps','-axo','pid=,pgid=,rss=,stat='],capture_output=True,text=True,timeout=timeout)
 need(r.returncode==0,'process observation failed');members=[]
 for line in r.stdout.splitlines():
  if not line.strip():continue
  fields=line.split();need(len(fields)==4,'process observation shape')
  pid,group,rss=map(int,fields[:3]);need(pid>0 and group>=0 and rss>=0,'process observation value')
  if group==pgid:members.append(dict(pid=pid,rss_bytes=rss*1024,zombie=fields[3].startswith('Z')))
 return dict(rss_bytes=sum(m['rss_bytes'] for m in members),live_members=[m['pid'] for m in members if not m['zombie']])
def cleanup(proc,errors,sample=snapshot,kill=os.killpg):
 # SIGTERM received during cleanup must not interrupt terminal persistence.
 def send(sig):
  try:kill(proc.pid,sig)
  except ProcessLookupError:pass
  except OSError as e:errors.append('signal_'+str(sig)+':'+type(e).__name__)
 send(signal.SIGTERM)
 try:proc.wait(timeout=.5)
 except subprocess.TimeoutExpired:pass
 except OSError as e:errors.append('term_wait:'+type(e).__name__)
 live=None
 try:live=sample(proc.pid)['live_members']
 except (OSError,ValueError,subprocess.TimeoutExpired) as e:errors.append('term_observe:'+type(e).__name__)
 if proc.poll()is None or live is None or live:
  send(signal.SIGKILL)
  try:proc.wait(timeout=1.5)
  except subprocess.TimeoutExpired:errors.append('kill_wait:TimeoutExpired')
  except OSError as e:errors.append('kill_wait:'+type(e).__name__)
 try:live=sample(proc.pid)['live_members']
 except (OSError,ValueError,subprocess.TimeoutExpired) as e:live=None;errors.append('final_observe:'+type(e).__name__)
 return dict(reaped=proc.poll()is not None,no_live_members_remaining=live==[],remaining_live_members=live)
def preflight(path,sha,receipt):
 rp=pin(path);need(rp['sha256']==sha,'trusted observer request SHA');r=read(rp)
 need(r['schema']=='q26-weighted-causal-primary-pair-observer-request-v1','observer request schema')
 need(r['kind']in ('producer','saved_check'),'observer purpose');policy=r['policy'];expected=dict(POLICY,wall_seconds=120 if r['kind']=='producer' else 90)
 if r.get('fixture_only')is True:
  need(type(policy['wall_seconds'])in (int,float) and 0<policy['wall_seconds']<=2 and all(policy[k]==expected[k] for k in expected if k!='wall_seconds'),'tiny synthetic policy')
 else:need(policy==expected and all(type(policy[k])is int for k in policy),'fixed prospective policy')
 inner=read(r['inner_request']);check(r['runner']);need(r['runner']in r['source_pins'],'runner in source pins')
 for q in r['source_pins']:check(q)
 argv=r['argv'];need(type(argv)is list and len(argv)>=3 and all(type(s)is str and s for s in argv),'exact argv')
 need(argv[:3]==[inner['invocation_python'],'-B',r['runner']['path']] and str(Path(argv[0]).resolve())==inner['resolved_python'],'sealed invocation and runner')
 need(argv[3:]==['--request',r['inner_request']['path'],'--sha256',r['inner_request']['sha256'],'--out',r['output']],'exact request/SHA/output command binding')
 if r['kind']=='producer':
  need(inner['schema']=='q26-weighted-causal-primary-pair-run-request-v1' and inner['parent_admitted']is True and inner['pins']['implementation']==r['runner'] and inner['out']==r['output'],'admitted producer binding')
  need(all(q in r['source_pins'] for q in inner['pins'].values() if Path(q['path']).suffix in ('.py','.md')),'all declared producer source pins bound')
 else:
  need(inner['schema']=='q26-weighted-causal-primary-pair-saved-request-v1' and inner['parent_admitted']is True and inner['saved_only']is True and inner['pins']['implementation']==r['runner'] and inner['out']==r['output'],'admitted saved-only consumer binding')
 output=canonical(r['output']);dest=canonical(receipt);need(output.parent==dest.parent and output.parent.is_dir(),'one existing evidence parent')
 paths=dict(receipt=dest,start=Path(str(dest)+'.start.json'),stdout=Path(str(dest)+'.stdout.log'),stderr=Path(str(dest)+'.stderr.log'))
 need(len({output,*paths.values()})==5 and all(not p.exists() and not p.is_symlink() for p in [output,*paths.values()]),'fresh exclusive outputs and logs')
 need(shutil.disk_usage(output.parent).free>=policy['disk_reserve_bytes'],'disk reserve before start')
 return rp,r,output,paths
def observe(path,sha,receipt,*,factory=subprocess.Popen,sample=snapshot,kill=os.killpg):
 started=time.monotonic();rp,r,out,paths=preflight(path,sha,receipt);policy=r['policy'];errors=[];proc=None;reason=None;code=None;peak=0;minimum=shutil.disk_usage(out.parent).free;maximum=0;creating=False;deferred=False;owned=False;containment=dict(reaped=False,no_live_members_remaining=None,remaining_live_members=None)
 def interrupt(*_):
  nonlocal deferred
  if creating:deferred=True;return
  raise InterruptedError('observer SIGTERM')
 previous=signal.signal(signal.SIGTERM,interrupt)
 try:
  exclusive(paths['start'],dict(schema='q26-weighted-causal-primary-pair-observer-start-v1',request=rp,runner=r['runner'],policy=policy,started_unix=time.time(),fixture_only=r.get('fixture_only',False)));owned=True
  env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1');env.pop('DYLD_LIBRARY_PATH',None)
  with os.fdopen(os.open(paths['stdout'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stdout,os.fdopen(os.open(paths['stderr'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stderr:
   creating=True
   try:proc=factory(r['argv'],stdout=stdout,stderr=stderr,env=env,start_new_session=True)
   finally:creating=False
   if deferred:raise InterruptedError('observer SIGTERM during child creation')
   while proc.poll()is None:
    remaining=policy['wall_seconds']-(time.monotonic()-started)
    if remaining<=0:reason='wall_timeout';break
    state=sample(proc.pid,timeout=min(.5,remaining));peak=max(peak,state['rss_bytes']);minimum=min(minimum,shutil.disk_usage(out.parent).free);maximum=max(maximum,output_size(out,[paths['start'],paths['stdout'],paths['stderr']]))
    if peak>policy['rss_bytes']:reason='sampled_rss_exceeded'
    elif minimum<policy['disk_reserve_bytes']:reason='disk_reserve_failed'
    elif maximum>policy['output_bytes']:reason='output_cap_failed'
    if reason:break
    time.sleep(min(.05,max(0,policy['wall_seconds']-(time.monotonic()-started))))
   if proc.poll()is not None:
    code=proc.poll();state=sample(proc.pid);containment=dict(reaped=True,no_live_members_remaining=not state['live_members'],remaining_live_members=state['live_members'])
    if state['live_members']:reason=reason or 'live_descendants_after_exit'
   else:reason=reason or 'unreaped_child'
 except BaseException as e:
  if not owned:raise
  reason=reason or type(e).__name__;errors.append('observer:'+type(e).__name__)
 finally:
  signal.signal(signal.SIGTERM,signal.SIG_IGN)
  try:
   if owned:
    if proc is not None and (proc.poll()is None or containment['no_live_members_remaining']is not True):containment=cleanup(proc,errors,sample,kill)
    code=None if proc is None else proc.poll()
    try:minimum=min(minimum,shutil.disk_usage(out.parent).free);maximum=max(maximum,output_size(out,[paths['start'],paths['stdout'],paths['stderr']]))
    except (OSError,ValueError) as e:reason=reason or 'final_resource_observation_failed';errors.append(type(e).__name__)
    if code is not None and code!=0:reason=reason or 'child_nonzero_exit'
    if minimum<policy['disk_reserve_bytes']:reason=reason or 'disk_reserve_failed'
    if maximum>policy['output_bytes']:reason=reason or 'output_cap_failed'
    if time.monotonic()-started>policy['wall_seconds']:reason=reason or 'wall_timeout'
    value=dict(schema='q26-weighted-causal-primary-pair-observer-terminal-v1',request=rp,runner=r['runner'],child_pid=None if proc is None else proc.pid,tool_terminal_exit=code,process_terminal=containment['reaped'],observer_timeout=reason=='wall_timeout',complete=code==0 and reason is None and containment['no_live_members_remaining']is True,reason=reason,errors=errors,containment=containment,elapsed_seconds=time.monotonic()-started,peak_sampled_process_group_rss_bytes=peak,minimum_sampled_free_disk_bytes=minimum,maximum_observed_output_and_logs_bytes=maximum,limits='Sampled resources; no hard peak or syscall-containment guarantee.',fixture_only=r.get('fixture_only',False))
    value['charged_seconds']=math.ceil(value['elapsed_seconds']);exclusive(paths['receipt'],value)
  finally:signal.signal(signal.SIGTERM,previous)
 return value
if __name__=='__main__':
 a=argparse.ArgumentParser(description=__doc__);a.add_argument('--request',required=True);a.add_argument('--sha256',required=True);a.add_argument('--receipt',required=True);v=a.parse_args()
 try:
  result=observe(v.request,v.sha256,v.receipt);print(json.dumps({k:result[k] for k in ('complete','reason','elapsed_seconds','charged_seconds')}));sys.exit(0 if result['complete'] else 1)
 except Exception as e:print(json.dumps(dict(complete=False,error_type=type(e).__name__)));sys.exit(1)
