"""Parent-owned one-attempt outer wall/resource guard. No automatic retry."""
import time
SUPERVISOR_START=time.monotonic()
import hashlib,json,os,signal,subprocess,sys,shutil,math
from pathlib import Path

def pin(path):
    p=Path(path)
    if not p.is_absolute():raise ValueError('absolute authenticated path required')
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())

def main(request):
    start=SUPERVISOR_START;rp=Path(request).resolve();r=json.loads(rp.read_text())
    prior=r.get('prior_wall_charged_seconds',0)
    if isinstance(prior,bool) or not isinstance(prior,(int,float)):raise ValueError('invalid prior wall charge')
    try:prior=float(prior)
    except (OverflowError,ValueError):raise ValueError('invalid prior wall charge')
    if not math.isfinite(prior) or prior<0:raise ValueError('invalid prior wall charge')
    start-=prior  # Charge continuation against the original 120-second budget.
    root=rp.parent;out=Path(r['intended_output']);receipt=root/'result-v1.outer-receipt.json'
    if out.exists() or receipt.exists():raise ValueError('attempt exists; restart refused')
    assert r['admission_status']=='parent_accepted'
    assert r['policy']==dict(wall_seconds=120,rss_bytes=1000000000,disk_reserve_bytes=2147483648,output_bytes=10000000)
    tracked=[pin(rp)]+list(r['source_pins'].values())+[r[k] for k in ['old_request','old_result','endpoint_proof','runtime_identity_audit']]+r['runtime_pins']
    for p in tracked:
        if time.monotonic()-start>=118:raise TimeoutError('prelaunch authentication deadline')
        if pin(p['path'])!=p:raise ValueError('prelaunch pin mismatch: '+p['path'])
    request_digest=pin(rp)['sha256']
    if request_digest!=tracked[0]['sha256']:raise ValueError('request changed before launch')
    if shutil.disk_usage(root).free<2147483648:raise ValueError('prelaunch disk reserve')
    if time.monotonic()-start>=118:raise TimeoutError('prelaunch deadline')
    env=dict(os.environ,**r['threads'],PYTHONDONTWRITEBYTECODE='1')
    proc=None;code=None;reason=None;observations=[]
    try:
        with (root/'result-v1.stdout').open('xb') as stdout,(root/'result-v1.stderr').open('xb') as stderr:
            proc=subprocess.Popen([r['invocation_python'],'-B',r['source_pins']['implementation']['path'],'--request',str(rp),'--request-sha256',request_digest,'--out',str(out)],stdout=stdout,stderr=stderr,env=env,start_new_session=True)
            while proc.poll() is None:
                elapsed=time.monotonic()-start;free=shutil.disk_usage(root).free
                ps=subprocess.run(['/bin/ps','-o','rss=','-p',str(proc.pid)],capture_output=True,text=True,timeout=1)
                raw=ps.stdout.strip();rss=int(raw)*1024 if raw.isdigit() else None
                observations.append(dict(elapsed_seconds=elapsed,rss_bytes=rss,free_bytes=free))
                if elapsed>=119:reason='wall_deadline'
                elif free<2147483648:reason='disk_reserve'
                elif rss is not None and rss>1000000000:reason='RSS_limit'
                elif rss is None and proc.poll() is None:reason='unobserved_live_RSS'
                if reason:
                    try:os.killpg(proc.pid,signal.SIGTERM)
                    except ProcessLookupError:pass
                    try:proc.wait(timeout=.3)
                    except subprocess.TimeoutExpired:
                        try:os.killpg(proc.pid,signal.SIGKILL)
                        except ProcessLookupError:pass
                    break
                time.sleep(.2)
            code=proc.wait(timeout=.5)
    finally:
        if proc is not None and proc.poll() is None:
            try:os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            code=proc.wait(timeout=.5)
        changed=[]
        for p in tracked:
            if time.monotonic()-start>=119:
                reason=reason or 'final_authentication_deadline';break
            if pin(p['path'])!=p:changed.append(p['path'])
        result=out/'result.json';result_pin=pin(result) if result.exists() else None
        final_free=shutil.disk_usage(root).free
        if final_free<2147483648:reason=reason or 'final_disk_reserve'
        child_receipt=out/'resource-receipt.json'
        child_resources=json.loads(child_receipt.read_text()) if child_receipt.exists() else None
        if code==0:
            if not child_resources or not child_resources.get('observations'):reason=reason or 'missing_child_resource_receipt'
            elif any(x['peak_rss_bytes']>1000000000 or x['free_bytes']<2147483648 for x in child_resources['observations']):reason=reason or 'child_resource_limit'
        elapsed=time.monotonic()-start
        accepted=code==0 and reason is None and not changed and result_pin is not None and elapsed<119
        record=dict(execution_complete=accepted,returncode=code,stop_reason=reason,outer_elapsed_seconds=elapsed,prior_wall_charged_seconds=prior,changed_pins=changed,result_pin=result_pin,observations=observations,final_free_bytes=final_free,meaning='Execution acceptance only; independent scientific verification remains required.')
        receipt.write_text(json.dumps(record,indent=2)+'\n')
        after_write=time.monotonic()-start
        if after_write>=120:accepted=False;record.update(execution_complete=False,stop_reason='receipt_write_deadline')
        record['elapsed_through_first_receipt_write']=after_write
        receipt.write_text(json.dumps(record,indent=2)+'\n')
        if time.monotonic()-start>=120:
            accepted=False;record.update(execution_complete=False,stop_reason='final_receipt_deadline');receipt.write_text(json.dumps(record,indent=2)+'\n')
        print(json.dumps({k:v for k,v in record.items() if k!='observations'}))
    if not accepted:raise SystemExit(1)

if __name__=='__main__':main(sys.argv[1])
