"""Parent monitor only; launching this file starts the admitted337-world synthetic run."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
PY='/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python'
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=300,output_bytes=10000000)


def need(ok,message):
    if not ok:raise ValueError(message)

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return h.hexdigest()

def pin(path):
    p=Path(path).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))

def check(p):need(pin(p['path'])==p,'admitted file changed: '+p['path'])

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()

def write(path,value):
    with open(path,'x') as f:json.dump(value,f,indent=2,allow_nan=False)

def output_size(path):
    total=0
    if not path.exists():return total
    for f in path.rglob('*'):
        try:
            if f.is_file():total+=f.stat().st_size
        except FileNotFoundError:
            # Per-world synthetic fixture files are removed between samples.
            continue
    return total

def stop_child(p):
    if p.poll() is None:
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.wait(timeout=5)


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--sha256',required=True);a=ap.parse_args()
    request=Path(a.request).resolve();request_pin=pin(request);need(request_pin['sha256']==a.sha256,'request hash')
    r=json.loads(request.read_text());need(r['schema']=='codex-r164-range-uncertainty-request-v1' and r['status']=='READY_PARENT_REVIEWED','unadmitted request')
    need(r['policy']==POLICY,'policy changed');need(len(r['source_pins'])==9,'source closure count')
    helper=Path(r['helper_pin']['path']);work=Path(r['output']).resolve();out=work/'result.json'
    pins=[request_pin,r['helper_pin'],r['test_pin'],*r['source_pins'],r['runtime_proof_pin']]
    for admitted in pins:check(admitted)
    own_pin=pin(__file__)
    need(not work.exists() and work.parent==E and shutil.disk_usage(E).free>=POLICY['disk_reserve_bytes'],'fresh output/reserve')
    monitor=E/'r164-range-uncertainty-parent-monitor-v1.json';startpath=E/'r164-range-uncertainty-parent-monitor-start-v1.json';log=E/'r164-range-uncertainty-parent-v1.stderr.log'
    need(not any(p.exists() for p in (monitor,startpath,log)),'monitor paths must be fresh')
    env=os.environ.copy();env.update(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
    cmd=[PY,str(helper),'--request',str(request),'--sha256',a.sha256,'--out',str(work)]
    started=now();t=time.monotonic();peak=0;minimum=shutil.disk_usage(E).free;maxsize=0;reason=None
    with open(log,'x') as err:
        p=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=err,env=env,start_new_session=True)
        try:
            write(startpath,dict(schema='codex-r164-range-uncertainty-parent-monitor-start-v1',started_utc=started,child_pid=p.pid,command=cmd,policy=POLICY,
                request=request_pin,initial_verified_pins=pins,monitor_implementation=own_pin))
            while p.poll() is None:
                try:
                    rss=subprocess.run(['/bin/ps','-o','rss=','-p',str(p.pid)],capture_output=True,text=True,check=False,timeout=3)
                    if rss.returncode==0 and rss.stdout.strip():peak=max(peak,int(rss.stdout.strip())*1024)
                    elif p.poll() is None:reason='child_rss_observation_failed'
                except (subprocess.TimeoutExpired,OSError,ValueError):reason='child_rss_observation_failed'
                free=shutil.disk_usage(E).free;minimum=min(minimum,free);maxsize=max(maxsize,output_size(work))
                if peak>POLICY['rss_bytes']:reason=reason or 'sampled_child_rss_exceeded'
                if free<POLICY['disk_reserve_bytes']:reason=reason or 'disk_reserve_failed'
                if time.monotonic()-t>POLICY['wall_seconds']:reason=reason or 'wall_time_exceeded'
                if maxsize>POLICY['output_bytes']:reason=reason or 'recursive_output_cap_failed'
                if reason:break
                time.sleep(.25)
        except BaseException as exc:reason=reason or 'parent_monitor_exception:'+type(exc).__name__
        finally:stop_child(p)
        code=p.wait()
    minimum=min(minimum,shutil.disk_usage(E).free);maxsize=max(maxsize,output_size(work))
    if time.monotonic()-t>POLICY['wall_seconds']:reason=reason or 'final_wall_time_exceeded'
    if minimum<POLICY['disk_reserve_bytes']:reason=reason or 'final_disk_reserve_failed'
    if maxsize>POLICY['output_bytes']:reason=reason or 'final_recursive_output_cap_failed'
    if not out.is_file():reason=reason or 'output_missing'
    final_pins_ok=True;changed=[]
    for admitted in pins+[own_pin]:
        try:check(admitted)
        except (OSError,ValueError):final_pins_ok=False;changed.append(admitted['path'])
    if not final_pins_ok:reason=reason or 'final_admission_pin_changed'
    value=dict(schema='codex-r164-range-uncertainty-parent-monitor-v1',started_utc=started,ended_utc=now(),child_pid=p.pid,exit_code=code,
        complete=code==0 and reason is None,stop_reason=reason,elapsed_seconds=time.monotonic()-t,peak_sampled_child_rss_bytes=peak,
        minimum_sampled_free_disk_bytes=minimum,maximum_observed_recursive_output_bytes=maxsize,request=request_pin,start_sha256=sha(startpath),stderr_bytes=log.stat().st_size,
        initial_verified_pin_count=len(pins),final_rehashed_pin_count=len(pins),final_admission_pins_unchanged=final_pins_ok,changed_pin_paths=changed,
        final_rehash_scope='request, helper, test, all9 original source files, runtime proof; monitor source also rehashed')
    if out.exists():value['output']=pin(out)
    write(monitor,value);print(json.dumps(value));return 0 if value['complete'] else 1

if __name__=='__main__':raise SystemExit(main())
