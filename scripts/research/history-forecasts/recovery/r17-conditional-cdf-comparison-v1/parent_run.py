#!/usr/bin/env python3
"""Parent-owned single-attempt 120s guard; no automatic restart."""
import hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PY='/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python'
def pin(p):
 p=Path(p);b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())
def main():
 started=time.monotonic();rp=ROOT/'request.parent.json';r=json.loads(rp.read_text());receipt=ROOT/'result-v1.outer-receipt.json';out=ROOT/'result-v1'
 if receipt.exists() or out.exists():raise ValueError('attempt already exists; do not restart')
 tracked=[pin(rp)]+[r[k] for k in ['source_pin','tests_pin','design_pin','base_request_pin','cuts_pin','outer_guard_pin']]+r['parent_review_pins']
 for p in tracked:
  if pin(p['path'])!=p:raise ValueError('prelaunch pin mismatch')
 assert r['status']=='PARENT_FROZEN_COMPARISON' and r['policy']==dict(wall_seconds=120,rss_bytes=1000000000,disk_reserve_bytes=2147483648,output_bytes=10000000)
 env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
 timed_out=False;code=None;pid=None
 try:
  with (ROOT/'result-v1.stdout').open('xb') as stdout,(ROOT/'result-v1.stderr').open('xb') as stderr:
   proc=subprocess.Popen([PY,'-B',r['source_pin']['path'],'--request',str(rp),'--sha256',pin(rp)['sha256'],'--out',str(out)],stdout=stdout,stderr=stderr,env=env,start_new_session=True);pid=proc.pid
   try:code=proc.wait(timeout=max(.001,120-(time.monotonic()-started)))
   except subprocess.TimeoutExpired:
    timed_out=True
    try:os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    try:code=proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
     try:os.killpg(proc.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     code=proc.wait(timeout=1)
 finally:
  post=[pin(p['path']) for p in tracked];changed=[p['path'] for p,q in zip(tracked,post) if p!=q];elapsed=time.monotonic()-started
  result=out/'result.json';result_pin=pin(result) if result.exists() else None
  accepted=code==0 and not timed_out and not changed and result_pin is not None
  receipt.write_text(json.dumps(dict(returncode=code,pid=pid,timed_out=timed_out,outer_elapsed_seconds=elapsed,expected_pins=tracked,post_pins=post,changed_pin_paths=changed,result_pin=result_pin,execution_complete=accepted,meaning='Execution acceptance only; scientific output verification pending.'),indent=2)+'\n')
  print(json.dumps(dict(returncode=code,timed_out=timed_out,elapsed=elapsed,unchanged_pins=not changed,result_pin=result_pin)))
 if not accepted:raise SystemExit(1)
if __name__=='__main__':main()
