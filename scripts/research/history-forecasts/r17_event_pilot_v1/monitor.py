"""Signed R17 build/train supervisor. Observes metadata, never parses numerical outputs."""
import argparse,datetime,hashlib,json,os,shutil,signal,subprocess,time
from pathlib import Path
ROOT=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-event-pilot-v1')
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=1200,output_bytes=500000000)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def need(ok,message):
 if not ok:raise ValueError(message)
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
 return h.hexdigest()
def pin(path):
 p=Path(path).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))
def check(p):need(pin(p['path'])==p,'admitted pin changed: '+p['path'])
def write(path,value):
 with open(path,'x') as f:json.dump(value,f,indent=2,sort_keys=True,allow_nan=False)
def output_size(paths):
 total=0
 for path in paths:
  try:
   if path.is_symlink():raise ValueError('output symlink refused')
   if path.is_file():total+=path.stat().st_size
   elif path.is_dir():
    for f in path.rglob('*'):
     try:
      if f.is_symlink():raise ValueError('output symlink refused')
      if f.is_file():total+=f.stat().st_size
     except FileNotFoundError:continue
  except FileNotFoundError:continue
 return total

def parse_ps(text,pgid):
 members=[]
 for line in text.splitlines():
  fields=line.split()
  need(len(fields)==5,'malformed process observation')
  try:pid,ppid,group,rss=map(int,fields[:4])
  except ValueError:raise ValueError('nonnumeric process observation')
  state=fields[4];need(pid>0 and ppid>=0 and group>=0 and rss>=0 and state[0].isalpha(),'invalid process observation')
  if group==pgid:members.append(dict(pid=pid,ppid=ppid,pgid=group,rss_bytes=rss*1024,state=state))
 need(len({x['pid'] for x in members})==len(members),'duplicate process observation')
 return members

def observe(pgid,timeout):
 need(timeout>0,'process observation deadline')
 r=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,rss=,stat='],capture_output=True,text=True,timeout=timeout)
 need(r.returncode==0,'process observation failed')
 return parse_ps(r.stdout,pgid)
def live(members):return [m for m in members if not m['state'].startswith('Z')]
def kill_group(pgid,sig,errors):
 try:os.killpg(pgid,sig)
 except ProcessLookupError:pass
 except OSError as e:errors.append(type(e).__name__+': '+str(e))
def cleanup(p):
 errors=[];pgid=p.pid;kill_group(pgid,signal.SIGTERM,errors)
 # The leader may already be terminal while its descendants remain alive.
 deadline=time.monotonic()+1
 while time.monotonic()<deadline:
  try:
   if not live(observe(pgid,min(.2,max(.001,deadline-time.monotonic())))):break
  except (OSError,ValueError,subprocess.TimeoutExpired):break
  time.sleep(.03)
 kill_group(pgid,signal.SIGKILL,errors)
 try:p.wait(timeout=3)
 except subprocess.TimeoutExpired:
  kill_group(pgid,signal.SIGKILL,errors)
  try:p.wait(timeout=3)
  except subprocess.TimeoutExpired:errors.append('leader_wait_timeout')
 members=None
 for attempt in range(4):
  try:
   members=observe(pgid,1)
   if not live(members):break
   kill_group(pgid,signal.SIGKILL,errors);time.sleep(.05)
  except (OSError,ValueError,subprocess.TimeoutExpired) as e:
   errors.append('cleanup_observation:'+type(e).__name__);members=None;break
 return dict(no_live_members_remaining=members is not None and not live(members),remaining_live_members=[] if members is None else live(members),remaining_zombies=[] if members is None else [m for m in members if m['state'].startswith('Z')],errors=errors)

def paths_from_request(r,root):
 work=Path(r['output']).resolve();need(work.parent==root and not work.exists(),'fresh direct-child output required')
 paths={k:Path(r[k]).resolve() for k in ['start_receipt','receipt','stdout_log','stderr_log']}
 need(all(p.parent==root and not p.exists() for p in paths.values()),'fresh sibling monitor paths required')
 need(len({work,*paths.values()})==5,'distinct monitor paths required')
 results=[(work/v).resolve() for v in r['expected_results']]
 need(bool(results) and len(set(results))==len(results),'expected result list')
 need(all(work in p.parents for p in results),'expected result must stay under output')
 return work,paths,results

def execute(r,request_pin,root=ROOT,policy=POLICY):
 root=root.resolve();work,paths,results=paths_from_request(r,root);owned=[work,*paths.values()];own=pin(__file__);pins=[request_pin,*r['pins']];started=now();t=time.monotonic();minimum=shutil.disk_usage(root).free;peak=0;maximum=0;reason=None;p=None;code=None;containment={'no_live_members_remaining':True,'remaining_live_members':[],'remaining_zombies':[],'errors':[]};verified=[]
 try:
  for expected in pins:check(expected);verified.append(expected)
  need(minimum>=policy['disk_reserve_bytes'],'disk reserve failed before launch')
  argv=r['argv'];need(isinstance(argv,list) and argv and all(isinstance(v,str) and v for v in argv),'exact argv list required')
  env=os.environ.copy();env.update(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
  # Avoid inheriting an unrelated dynamic-library override.
  env.pop('DYLD_LIBRARY_PATH',None)
  if r['phase']=='train':env['DYLD_LIBRARY_PATH']=r['dyld_library_path']
  with open(paths['stdout_log'],'xb') as stdout,open(paths['stderr_log'],'xb') as stderr:
   p=subprocess.Popen(argv,stdout=stdout,stderr=stderr,env=env,start_new_session=True)
   try:
    write(paths['start_receipt'],dict(schema='codex-r17-monitor-start-v1',phase=r['phase'],started_utc=started,child_pid=p.pid,pgid=p.pid,argv=argv,policy=policy,request=request_pin,verified_pins=verified,monitor_source=own))
    while p.poll() is None:
     remaining=policy['wall_seconds']-(time.monotonic()-t)
     if remaining<=0:reason='wall_time_exceeded';break
     try:
      members=observe(p.pid,min(3,remaining))
      if not members and p.poll() is None:raise ValueError('live leader absent from process group')
      peak=max(peak,sum(m['rss_bytes'] for m in members))
     except (OSError,ValueError,subprocess.TimeoutExpired):
      if p.poll() is None:
       reason='wall_time_exceeded' if time.monotonic()-t>=policy['wall_seconds'] else 'process_group_observation_failed'
       break
     minimum=min(minimum,shutil.disk_usage(root).free);maximum=max(maximum,output_size(owned))
     if peak>policy['rss_bytes']:reason='sampled_process_group_rss_exceeded'
     elif minimum<policy['disk_reserve_bytes']:reason='disk_reserve_failed'
     elif maximum>policy['output_bytes']:reason='recursive_output_and_logs_cap_failed'
     elif time.monotonic()-t>policy['wall_seconds']:reason='wall_time_exceeded'
     if reason:break
     time.sleep(min(.1,max(0,policy['wall_seconds']-(time.monotonic()-t))))
   finally:containment=cleanup(p)
   code=p.returncode
 except BaseException as e:
  reason=reason or 'monitor_error:'+type(e).__name__+': '+str(e)[:500]
  if p is not None:
   containment=cleanup(p);code=p.returncode
 changed=[]
 for expected in pins+[own]:
  try:check(expected)
  except (OSError,ValueError):changed.append(expected['path'])
 if changed:reason=reason or 'final_pin_changed'
 if not containment['no_live_members_remaining'] or containment['errors']:reason=reason or 'process_group_cleanup_unverified'
 try:
  minimum=min(minimum,shutil.disk_usage(root).free);maximum=max(maximum,output_size(owned))
  if minimum<policy['disk_reserve_bytes']:reason=reason or 'final_disk_reserve_failed'
  if maximum>policy['output_bytes']:reason=reason or 'final_output_cap_failed'
 except (OSError,ValueError) as e:reason=reason or 'final_metadata_observation_failed:'+type(e).__name__
 if time.monotonic()-t>policy['wall_seconds']:reason=reason or 'final_wall_time_exceeded'
 result_pins=[]
 for path in results:
  try:
   need(not path.is_symlink(),'expected result symlink refused')
   if path.is_file():result_pins.append(pin(path))
   else:reason=reason or 'expected_result_missing'
  except (OSError,ValueError) as e:reason=reason or 'result_metadata_failed:'+type(e).__name__
 if code!=0:reason=reason or 'child_nonzero_or_not_launched'
 value=dict(schema='codex-r17-monitor-receipt-v1',phase=r['phase'],complete=reason is None and code==0,started_utc=started,finished_utc=now(),elapsed_seconds=time.monotonic()-t,child_pid=None if p is None else p.pid,exit_code=code,stop_reason=reason,peak_sampled_process_group_rss_bytes=peak,minimum_sampled_free_disk_bytes=minimum,maximum_observed_output_and_logs_bytes=maximum,request=request_pin,monitor_source=own,initial_verified_pins=verified,final_rehashed_pin_count=len(pins)+1,changed_pin_paths=changed,containment=containment,result_pins=result_pins,limits='Sampled RSS/free/output observations are not hard maxima or syscall containment.',log_bytes={k:paths[k].stat().st_size if paths[k].exists() else 0 for k in ['stdout_log','stderr_log']})
 # Include the final receipt itself in the same output/log budget.
 estimate=len((json.dumps(value,indent=2,sort_keys=True,allow_nan=False)).encode())
 if maximum+estimate>policy['output_bytes']:value['complete']=False;value['stop_reason']=value['stop_reason'] or 'receipt_inclusive_output_cap_failed'
 write(paths['receipt'],value)
 return value

def main():
 a=argparse.ArgumentParser();a.add_argument('--request',required=True);a.add_argument('--sha256',required=True);args=a.parse_args();request=Path(args.request).resolve();rp=pin(request);need(rp['sha256']==args.sha256,'request hash mismatch');r=json.loads(request.read_text());need(r['schema']=='codex-r17-execution-request-v1' and r['status']=='READY_PARENT_REVIEWED','unadmitted request');need(r['phase'] in ('build','train'),'phase');need(r['policy']==POLICY,'policy changed');need(isinstance(r['pins'],list) and bool(r['pins']),'pins required')
 def terminate(signum,frame):raise RuntimeError('monitor received signal '+str(signum))
 signal.signal(signal.SIGTERM,terminate)
 value=execute(r,rp);print(json.dumps(value,sort_keys=True,allow_nan=False));return 0 if value['complete'] else 1
if __name__=='__main__':raise SystemExit(main())
