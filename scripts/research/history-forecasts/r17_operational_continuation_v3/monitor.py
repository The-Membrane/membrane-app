"""Signed R17 build/train supervisor. Observes metadata, never parses numerical outputs."""
import argparse,datetime,hashlib,json,os,re,shutil,signal,subprocess,time
from pathlib import Path
ROOT=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-operational-continuation-v3')
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=1075,output_bytes=500000000)
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
  state=fields[4];need(pid>0 and ppid>=0 and group>=0 and rss>=0 and re.fullmatch(r'[A-Za-z?][A-Za-z+<>]*',state) is not None,'invalid process observation')
  if group==pgid:members.append(dict(pid=pid,ppid=ppid,pgid=group,rss_bytes=None if state.startswith('?') else rss*1024,reported_rss_bytes=rss*1024,rss_qualified=not state.startswith('?'),state=state))
 need(len({x['pid'] for x in members})==len(members),'duplicate process observation')
 return members

class ObservationError(ValueError):
 def __init__(self,message,diagnostic):super().__init__(message);self.diagnostic=diagnostic

def first_invalid_row(text,pgid):
 seen=set()
 for line in text.splitlines():
  f=line.split()
  if len(f)!=5:return line[:250]
  try:pid,ppid,group,rss=map(int,f[:4])
  except ValueError:return line[:250]
  if not(pid>0 and ppid>=0 and group>=0 and rss>=0 and re.fullmatch(r'[A-Za-z?][A-Za-z+<>]*',f[4]) is not None):return line[:250]
  if group==pgid:
   if pid in seen:return line[:250]
   seen.add(pid)
 return None

def census(pgid,timeout):
 need(timeout>0,'process observation deadline')
 diagnostic={'ps_return_code':None,'ps_stderr':None,'first_invalid_metadata_row':None}
 try:
  r=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,rss=,stat='],capture_output=True,text=True,timeout=timeout)
 except (OSError,subprocess.TimeoutExpired) as ex:
  stderr=getattr(ex,'stderr',None)
  if isinstance(stderr,bytes):stderr=stderr.decode(errors='replace')
  diagnostic.update(exception_type=type(ex).__name__,exception_message=str(ex)[:500],ps_stderr=None if stderr is None else str(stderr)[:2048])
  raise ObservationError('process observation exception',diagnostic) from ex
 diagnostic.update(ps_return_code=r.returncode,ps_stderr=r.stderr[:2048])
 if r.returncode!=0:raise ObservationError('process observation failed',diagnostic)
 try:
  members=parse_ps(r.stdout,pgid)
  outside=sum(1 for line in r.stdout.splitlines() if line.split()[4].startswith('?') and int(line.split()[2])!=pgid)
  return {'members':members,'unknown_outside_group_count':outside}
 except ValueError as ex:
  diagnostic.update(exception_type=type(ex).__name__,exception_message=str(ex)[:500],first_invalid_metadata_row=first_invalid_row(r.stdout,pgid))
  raise ObservationError('process observation parse failed',diagnostic) from ex

class ObservedMembers(list):
 def __init__(self,members,metadata):super().__init__(members);self.observation_metadata=metadata

def observe(pgid,timeout):
 # MAX3 includes the initial census. Never reset this absolute deadline.
 need(timeout>0,'process observation deadline')
 deadline=time.monotonic()+min(3.,timeout);attempts=[]
 for number in range(1,4):
  remaining=deadline-time.monotonic()
  if remaining<=0:break
  try:sample=census(pgid,remaining)
  except (OSError,ValueError,subprocess.TimeoutExpired) as exc:
   raise ObservationError('process census failed',{'attempts':attempts,'attempted_ps_probes':number,'failure':getattr(exc,'diagnostic',None),'exception_type':type(exc).__name__,'exception_message':str(exc)[:500]}) from exc
  members=sample['members'];unknown=[m for m in members if not m['rss_qualified']]
  subtotal=sum(m['rss_bytes'] for m in members if m['rss_bytes'] is not None)
  attempt={'probe':number,'unknown_owned_count':len(unknown),'unknown_owned_metadata':unknown[:16],'unknown_metadata_truncated':max(0,len(unknown)-16),'unknown_outside_group_count':sample['unknown_outside_group_count'],'known_rss_subtotal_lower_bound':subtotal,'total_rss_bytes':None if unknown else subtotal,'remaining_probe_seconds':max(0,deadline-time.monotonic())};attempts.append(attempt)
  if subtotal>POLICY['rss_bytes']:raise ObservationError('known group RSS lower bound exceeds cap',{'attempts':attempts,'attempted_ps_probes':number,'reason':'known_rss_lower_bound_exceeded','total_rss_bytes':None if unknown else subtotal})
  if not unknown:
   if time.monotonic()>deadline:break
   return ObservedMembers(members,{'attempts':attempts,'attempted_ps_probes':number,'recovered_unknown':len(attempts)>1})
  if number<3:
   remaining=deadline-time.monotonic()
   if remaining>0:time.sleep(min(.025,remaining))
 raise ObservationError('owned process RSS remains unqualified',{'attempts':attempts,'attempted_ps_probes':len(attempts),'total_rss_bytes':None,'max_probes_including_initial':3,'remaining_probe_seconds':max(0,deadline-time.monotonic())})

def record_observation(summary,metadata):
 attempts=metadata.get('attempts',[]) if metadata else []
 summary['ps_probes']+=metadata.get('attempted_ps_probes',len(attempts)) if metadata else 0
 summary['peak_known_rss_lower_bound_bytes']=max([summary['peak_known_rss_lower_bound_bytes']]+[a['known_rss_subtotal_lower_bound'] for a in attempts])
 complete=[a['total_rss_bytes'] for a in attempts if a['total_rss_bytes'] is not None]
 summary['complete_census_count']+=len(complete)
 if complete:summary['peak_complete_census_rss_bytes']=max(complete+([] if summary['peak_complete_census_rss_bytes'] is None else [summary['peak_complete_census_rss_bytes']]))
 summary['unknown_owned_snapshots']+=sum(a['unknown_owned_count']>0 for a in attempts)
 summary['unknown_outside_rows']+=sum(a['unknown_outside_group_count'] for a in attempts)
 summary['recovered_samples']+=int(bool(metadata and metadata.get('recovered_unknown')))
 for attempt in attempts:
  if attempt['unknown_owned_count'] or attempt['unknown_outside_group_count']:
   if len(summary['unknown_events'])<32:summary['unknown_events'].append(attempt)
   else:summary['unknown_events_truncated']+=1

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
   if not live(census(pgid,min(.2,max(.001,deadline-time.monotonic())))['members']):break
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
   members=census(pgid,1)['members']
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
 root=root.resolve();work,paths,results=paths_from_request(r,root);owned=[work,*paths.values()];own=pin(__file__);pins=[request_pin,*r['pins']];started=now();t=time.monotonic();minimum=shutil.disk_usage(root).free;peak=0;maximum=0;reason=None;observation_summary={'ps_probes':0,'peak_known_rss_lower_bound_bytes':0,'peak_complete_census_rss_bytes':None,'complete_census_count':0,'unknown_owned_snapshots':0,'unknown_outside_rows':0,'recovered_samples':0,'unknown_events':[],'unknown_events_truncated':0};last_observation_failure=None;p=None;code=None;containment={'no_live_members_remaining':True,'remaining_live_members':[],'remaining_zombies':[],'errors':[]};verified=[]
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
      record_observation(observation_summary,getattr(members,'observation_metadata',None))
      if not members and p.poll() is None:raise ValueError('live leader absent from process group')
      peak=max(peak,sum(m['rss_bytes'] for m in members))
     except (OSError,ValueError,subprocess.TimeoutExpired) as exc:
      record_observation(observation_summary,getattr(exc,'diagnostic',None))
      last_observation_failure={'exception_type':type(exc).__name__,'exception_message':str(exc)[:500],'detail':getattr(exc,'diagnostic',None),'remaining_wall_seconds':policy['wall_seconds']-(time.monotonic()-t),'leader_status':p.poll()}
      if getattr(exc,'diagnostic',{}).get('reason')=='known_rss_lower_bound_exceeded':
       reason='sampled_process_group_rss_lower_bound_exceeded'
       break
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
 final_elapsed=time.monotonic()-t
 if final_elapsed>policy['wall_seconds']:reason=reason or 'wall_time_exceeded'
 value=dict(schema='codex-r17-monitor-receipt-v1',phase=r['phase'],complete=reason is None and code==0,started_utc=started,finished_utc=now(),elapsed_seconds=final_elapsed,child_pid=None if p is None else p.pid,exit_code=code,stop_reason=reason,peak_sampled_process_group_rss_bytes=max(peak,observation_summary['peak_complete_census_rss_bytes'] or 0),complete_census_count=observation_summary['complete_census_count'],peak_complete_census_rss_bytes=observation_summary['peak_complete_census_rss_bytes'],peak_sampled_known_rss_lower_bound_bytes=observation_summary['peak_known_rss_lower_bound_bytes'],minimum_sampled_free_disk_bytes=minimum,maximum_observed_output_and_logs_bytes=maximum,request=request_pin,monitor_source=own,initial_verified_pins=verified,final_rehashed_pin_count=len(pins)+1,changed_pin_paths=changed,containment=containment,result_pins=result_pins,observation_failure=last_observation_failure,unknown_observation_summary=observation_summary,limits='Sampled RSS/free/output observations are not hard maxima or syscall containment.',log_bytes={k:paths[k].stat().st_size if paths[k].exists() else 0 for k in ['stdout_log','stderr_log']})
 # Include the final receipt itself in the same output/log budget.
 estimate=len((json.dumps(value,indent=2,sort_keys=True,allow_nan=False)).encode())
 if maximum+estimate>policy['output_bytes']:value['complete']=False;value['stop_reason']=value['stop_reason'] or 'receipt_inclusive_output_cap_failed'
 write(paths['receipt'],value)
 return value

def main():
 a=argparse.ArgumentParser();a.add_argument('--request',required=True);a.add_argument('--sha256',required=True);args=a.parse_args();request=Path(args.request).resolve();rp=pin(request);need(rp['sha256']==args.sha256,'request hash mismatch');r=json.loads(request.read_text());need(r['schema']=='codex-r17-execution-request-v1' and r['status']=='READY_PARENT_REVIEWED','unadmitted request');need(r['phase'] in ('build','train'),'phase');need(r['policy']==POLICY,'policy changed');need(r['time_accounting']=={'original_budget_seconds':1200,'prior_attempt_charged_seconds':125,'remaining_seconds':1075},'time accounting changed');need(isinstance(r['pins'],list) and bool(r['pins']),'pins required')
 def terminate(signum,frame):raise RuntimeError('monitor received signal '+str(signum))
 signal.signal(signal.SIGTERM,terminate)
 value=execute(r,rp);print(json.dumps(value,sort_keys=True,allow_nan=False));return 0 if value['complete'] else 1
if __name__=='__main__':raise SystemExit(main())
