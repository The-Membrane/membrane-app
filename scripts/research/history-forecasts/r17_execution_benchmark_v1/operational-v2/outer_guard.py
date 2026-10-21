#!/usr/bin/env python3
"""DRAFT watchdog for one source-pinned synthetic benchmark, never a market job."""
import argparse,hashlib,json,math,os,re,shutil,signal,subprocess,sys,time
from pathlib import Path
WALL=54.;RSS=1_000_000_000;DISK=2_000_000_000
ROOT=Path(__file__).resolve().parent

def pin(p):
 p=Path(p);return dict(path=str(p),size=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())
def verify(pins):
 for expected in pins:
  if pin(expected['path'])!=expected:raise ValueError('source/runtime pin mismatch: '+expected['path'])
def rows(text):
 result=[]
 for line in text.splitlines():
  f=line.split()
  if len(f)!=5:raise ValueError('malformed census')
  pid,ppid,pgid,rss=map(int,f[:4])
  if pid<1 or ppid<0 or pgid<0 or rss<0 or not re.fullmatch(r'[A-Za-z?][A-Za-z+<>]*',f[4]):raise ValueError('invalid census')
  result.append((pid,ppid,pgid,rss*1024,f[4]))
 if len({r[0] for r in result})!=len(result):raise ValueError('duplicate PID')
 return result

def census(deadline):
 left=deadline-time.monotonic()
 if left<=0:raise TimeoutError('wall_time_exceeded')
 p=subprocess.Popen(['/bin/ps','-axo','pid=,ppid=,pgid=,rss=,stat='],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:out,err=p.communicate(timeout=min(2.,left))
 except BaseException:
  p.kill();p.communicate(timeout=1.);raise
 if p.returncode:raise RuntimeError('process census nonzero')
 return rows(out),p.pid

def ownership(sample,parent,leader,pids,groups,journal,observer):
 # The reviewed worker journals its new session before imports or other children.
 if journal.exists():
  if journal.stat().st_size>8192:raise ValueError('ownership journal size')
  raw=journal.read_text()
  for line in raw.splitlines():
   item=json.loads(line);pid=item['pid'];group=item['pgid']
   if type(pid) is not int or type(group) is not int or pid<=1 or group!=pid or group==os.getpgrp():raise ValueError('invalid worker ownership')
   pids.add(pid);groups.add(group)
 owned={leader,parent}
 while True:
  new=owned|{pid for pid,ppid,group,_,_ in sample if ppid in owned or group in groups}
  if new==owned:break
  owned=new
 selected=[r for r in sample if r[0] in owned and r[0]!=observer]
 pids.update(r[0] for r in selected if r[0]!=parent)
 return selected

def validate_predecessor(req):
 previous=req['predecessor'];verify([previous['request'],previous['receipt']])
 old=json.loads(Path(previous['request']['path']).read_text());receipt=json.loads(Path(previous['receipt']['path']).read_text())
 if old['status']!='READY_PARENT_REVIEWED' or receipt['status']!='FAILED' or receipt['stop_reason']!='ValueError: owned_RSS_unknown':raise ValueError('unexpected predecessor state')
 if Path(previous['receipt']['path']).parent!=Path(old['output']):raise ValueError('receipt/request binding')
 if receipt['child_returncode']!=-15 or receipt['cleanup']['live_pids']!=[]:raise ValueError('predecessor not terminal')
 charged=math.ceil(receipt['elapsed_seconds'])
 if charged!=6 or req['prior_charged_seconds']!=charged or req['remaining_wall_seconds']!=60-charged or WALL!=60-charged:raise ValueError('shared time budget mismatch')
 if Path(old['result']).exists():raise ValueError('unexpected completed predecessor result')
 verify(old['pins'])
 oldbench=next(x for x in old['pins'] if x['path']==old['command'][1])
 if pin(Path(__file__).with_name('benchmark.py'))['sha256']!=oldbench['sha256']:raise ValueError('scientific benchmark bytes changed')
 return old

def qualified_sample(parent,leader,pids,groups,journal,wall_deadline,report):
 # Initial census counts toward MAX3; all calls share this absolute deadline.
 deadline=min(time.monotonic()+2.,wall_deadline)
 for number in range(1,4):
  if time.monotonic()>=deadline:raise TimeoutError('owned_RSS_qualification_deadline')
  sample,observer=census(deadline);selected=ownership(sample,parent,leader,pids,groups,journal,observer)
  if not any(r[0]==parent for r in selected):raise ValueError('parent RSS missing')
  unknown=[r for r in selected if r[4].startswith('?')];known=sum(r[3] for r in selected if not r[4].startswith('?'))
  report['peak_known_rss_lower_bound_bytes']=max(report['peak_known_rss_lower_bound_bytes'],known)
  attempt=dict(probe=number,known_rss_subtotal_lower_bound_bytes=known,total_rss_bytes=None if unknown else known,unknown_owned_count=len(unknown),unknown_owned_metadata=[dict(pid=r[0],ppid=r[1],pgid=r[2],rss_bytes=None,reported_rss_bytes=r[3],state=r[4]) for r in unknown[:32]],unknown_metadata_truncated=max(0,len(unknown)-32),remaining_qualification_seconds=max(0,deadline-time.monotonic()))
  report['probe_count']+=1
  if unknown:
   report['unknown_owned_snapshots']+=1
   if len(report['unknown_observations'])<64:report['unknown_observations'].append(attempt)
   else:report['unknown_observations_truncated']+=1
  if known>RSS:raise MemoryError('known_RSS_cap')
  if not unknown:
   if time.monotonic()>=deadline:raise TimeoutError('owned_RSS_qualification_deadline')
   report['complete_census_count']+=1
   report['sampled_peak_parent_and_owned_rss_bytes']=known if report['sampled_peak_parent_and_owned_rss_bytes'] is None else max(known,report['sampled_peak_parent_and_owned_rss_bytes'])
   if number>1:report['recovered_unknown_samples']+=1
   return selected
  if number<3:
   remaining=deadline-time.monotonic()
   if remaining>0:time.sleep(min(.025,remaining))
 raise ValueError('owned_RSS_unknown_after_three_censuses')

def cleanup(p,pids,groups,journal):
 errors=[];zombies=[]
 # Journal may contain a short-lived session absent from prior sampled censuses.
 try:ownership([],os.getpid(),p.pid,pids,groups,journal,-1)
 except BaseException as ex:errors.append(type(ex).__name__+': '+str(ex)[:200])
 for sig in (signal.SIGTERM,signal.SIGKILL):
  for group in groups:
   try:os.killpg(group,sig)
   except ProcessLookupError:pass
   except OSError as ex:errors.append(type(ex).__name__+': '+str(ex)[:200])
  try:p.wait(timeout=.25)
  except subprocess.TimeoutExpired:pass
 try:
  sample,observer=census(time.monotonic()+2.)
  remaining=ownership(sample,os.getpid(),p.pid,pids,groups,journal,observer)
  live=[r[0] for r in remaining if r[0]!=os.getpid() and not r[4].startswith('Z')]
  zombies=[r[0] for r in remaining if r[4].startswith('Z')]
  if live:errors.append('live owned members remain: '+str(live))
 except BaseException as ex:errors.append('cleanup census: '+type(ex).__name__+': '+str(ex)[:200]);live=None
 return dict(errors=errors,live_pids=live,zombie_pids=zombies)

def execute(req):
 start=time.monotonic();deadline=start+WALL
 out=Path(req['output']);out.mkdir();journal=out/'worker-ownership.jsonl';journal.touch()
 report={'status':'FAILED','sampled_peak_parent_and_owned_rss_bytes':None,'minimum_free_bytes':None,'samples':0,'peak_known_rss_lower_bound_bytes':0,'probe_count':0,'complete_census_count':0,'unknown_owned_snapshots':0,'unknown_observations':[],'unknown_observations_truncated':0,'recovered_unknown_samples':0,'policy':{'wall_seconds':WALL,'rss_bytes':RSS,'disk_reserve_bytes':DISK},'stop_reason':None};p=None;pids=set();groups=set()
 try:
  validate_predecessor(req);verify(req['pins']);env=os.environ.copy();env.update({k:'1' for k in ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS']});env.update(PYTHONDONTWRITEBYTECODE='1',DYLD_LIBRARY_PATH=req['libomp_directory'],Q26_BENCH_OWNERSHIP_JOURNAL=str(journal))
  if shutil.disk_usage(out).free<DISK:raise RuntimeError('disk_reserve')
  if time.monotonic()>=deadline:raise TimeoutError('wall_time_exceeded_before_spawn')
  with (out/'stdout.txt').open('wb') as stdout,(out/'stderr.txt').open('wb') as stderr:
   p=subprocess.Popen(req['command'],stdout=stdout,stderr=stderr,env=env,start_new_session=True);pids.add(p.pid);groups.add(p.pid)
   while True:
    if time.monotonic()>=deadline:raise TimeoutError('wall_time_exceeded')
    free=shutil.disk_usage(out).free;report['minimum_free_bytes']=free if report['minimum_free_bytes'] is None else min(free,report['minimum_free_bytes'])
    if free<DISK:raise RuntimeError('disk_reserve')
    if sum(x.stat().st_size for x in out.rglob('*') if x.is_file())>20_000_000:raise RuntimeError('output_size_cap')
    qualified_sample(os.getpid(),p.pid,pids,groups,journal,deadline,report)
    report['samples']+=1
    if p.poll() is not None:break
    time.sleep(min(.02,max(0,deadline-time.monotonic())))
   if p.returncode!=0:raise RuntimeError('child_nonzero')
  verify(req['pins']);result=Path(req['result']);report['result_pin']=pin(result)
  if json.loads(result.read_text()).get('status')!='COMPLETE':raise ValueError('incomplete result')
  if time.monotonic()>=deadline:raise TimeoutError('wall_time_exceeded')
  report['status']='COMPLETE'
 except BaseException as ex:report['stop_reason']=type(ex).__name__+': '+str(ex)[:500]
 finally:
  if p is not None:
   report['cleanup']=cleanup(p,pids,groups,journal);report['child_returncode']=p.returncode
   if report['cleanup']['errors'] or report['cleanup']['live_pids']!=[]:report['status']='FAILED'
  report['elapsed_seconds']=time.monotonic()-start
  report['prior_charged_seconds']=req['prior_charged_seconds']
  report['original_budget_charged_seconds']=req['prior_charged_seconds']+report['elapsed_seconds']
  if report['elapsed_seconds']>WALL:report.update(status='FAILED',stop_reason='wall_time_exceeded_including_cleanup')
  (out/'receipt.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
 return report

def main():
 a=argparse.ArgumentParser();a.add_argument('--request',type=Path,required=True);a.add_argument('--sha256',required=True);args=a.parse_args()
 if pin(args.request)['sha256']!=args.sha256:raise ValueError('request hash mismatch')
 req=json.loads(args.request.read_text())
 if req['status']!='READY_PARENT_REVIEWED':raise ValueError('request not admitted')
 out=Path(req['output']).resolve();result=Path(req['result']).resolve()
 if out.parent!=ROOT or out.exists() or result!=ROOT/'benchmark-results-parent-admitted-v2'/'result.json' or result.parent.exists():raise ValueError('output paths not fresh/fixed')
 expected=[req['runtime_python'],str(ROOT/'benchmark.py'),'--output',str(result.parent),'--parent-reviewed']
 if req['command']!=expected:raise ValueError('unexpected command')
 raise SystemExit(0 if execute(req)['status']=='COMPLETE' else 1)
if __name__=='__main__':main()
