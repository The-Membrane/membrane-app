#!/usr/bin/env python3
"""Sealed Linux offline gate. A single process group, scrubbed environment and bounded resources."""
import argparse,fcntl,hashlib,json,os,pathlib,signal,subprocess,time

def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(262144),b''): h.update(b)
 return h.hexdigest()
TRACKED = {}
def processes(group):
 rows={}
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
   s=(p/'stat').read_text().rsplit(')',1)[1].split()
   if s[0]=='Z': continue # Exited zombies cannot execute or retain resident memory.
   rows[int(p.name)]=(int(s[1]),int(s[2]),s[19],int(s[21])*os.sysconf('SC_PAGE_SIZE'))
  except (OSError,ValueError,IndexError): pass
 live={pid for pid,(_,g,birth,_) in rows.items() if g==group or TRACKED.get(pid)==birth}
 if group in rows: live.add(group)
 while True:
  expanded=live|{pid for pid,(parent,_,_,_) in rows.items() if parent in live}
  if expanded==live: break
  live=expanded
 for pid in live: TRACKED[pid]=rows[pid][2]
 return [(pid,rows[pid][3]) for pid in live]

def main():
 a=argparse.ArgumentParser(); a.add_argument('--spec',required=True); a.add_argument('--sha256',required=True); args=a.parse_args()
 assert sha(args.spec)==args.sha256,'spec_hash_mismatch'
 spec=json.loads(pathlib.Path(args.spec).read_text()); root=pathlib.Path(spec['evidenceRoot']); root.mkdir(parents=True,exist_ok=True)
 with open(root/'gate.lock','w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  start=time.monotonic(); deadline=start+60; code=None; child=None; peak=0; exit_code=None; pins_checked=False
  run=root/(spec['tag']+'-'+str(time.time_ns())); run.mkdir(mode=0o700)
  def pins():
   for p,b in spec['pins'].items():
    if time.monotonic()>=deadline-6: raise RuntimeError('pin_deadline')
    if sha(p)!=b: raise RuntimeError('pin_drift:'+p)
   for p,target in spec['links'].items():
    if str(pathlib.Path(p).resolve())!=target: raise RuntimeError('dependency_path_drift')
  def free():
   s=os.statvfs(root); return s.f_bavail*s.f_frsize
  try:
   assert free()>=288*1024**2,'disk_start_floor'; pins()
   env={'PATH':str(pathlib.Path(spec['argv'][0]).parent)+':/usr/bin:/bin','HOME':str(run),'TMPDIR':str(run),
     'MEMBRANE_DATASETS_DIR':spec['datasetsRoot'],'NODE_OPTIONS':'--max-old-space-size=192','NO_COLOR':'1'}
   with open(run/'stdout.log','wb') as out,open(run/'stderr.log','wb') as err:
    child=subprocess.Popen(spec['argv'],cwd=spec['checkout'],env=env,start_new_session=True,stdout=out,stderr=err)
    while child.poll() is None:
     rss=sum(r for _,r in processes(child.pid)); peak=max(peak,rss)
     if rss>384*1024**2: raise RuntimeError('aggregate_rss_limit')
     if free()<256*1024**2: raise RuntimeError('disk_reserve')
     if out.tell()+err.tell()>8*1024**2: raise RuntimeError('log_limit')
     if time.monotonic()>=deadline-6: raise RuntimeError('cooperative_deadline')
     time.sleep(.05)
    exit_code=child.returncode
   if processes(child.pid): raise RuntimeError('descendants_survived')
   pins(); pins_checked=True
   if exit_code: raise RuntimeError('test_failure')
  except Exception as e: code=str(e)
  finally:
   if child:
    for pid,_ in processes(child.pid):
     try: os.kill(pid,signal.SIGTERM)
     except ProcessLookupError: pass
    try: os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    until=min(deadline-1,time.monotonic()+2)
    while processes(child.pid) and time.monotonic()<until: time.sleep(.05)
    for pid,_ in processes(child.pid):
     try: os.kill(pid,signal.SIGKILL)
     except ProcessLookupError: pass
    try: os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    child.wait(timeout=max(.1,deadline-time.monotonic()))
   clean=not child or not processes(child.pid)
   proof={'status':'PASS' if code is None and clean else 'FAIL','reason':code,'specSha256':args.sha256,
    'exitCode':exit_code,'pinsCheckedBeforeAndAfter':pins_checked,'peakAggregateRssBytes':peak,'rssSamplingSeconds':0.05,
    'elapsedSeconds':time.monotonic()-start,'processGroupClean':clean,'diskAvailableBytes':free(),
    'limits':{'nodeHeapMiB':192,'aggregateRssMiB':384,'deadlineSeconds':60,'cleanupReserveSeconds':6,'diskReserveMiB':256},
    'logs':{p.name:sha(p) for p in run.glob('*.log')}}
   (run/'proof.json').write_text(json.dumps(proof,indent=2)+'\n'); print(json.dumps({'run':str(run),**proof}))
   return 0 if proof['status']=='PASS' else 1
if __name__=='__main__': raise SystemExit(main())
