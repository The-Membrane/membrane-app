"""Single-child operational process-group monitor; never retries or resumes."""
from __future__ import annotations
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import r16_shallow_nn_protocol as P


def resident_bytes(pid):
    """Host ps reports KiB. Failure is operational, never a missing-value bypass."""
    if sys.platform!='darwin' and not sys.platform.startswith('linux'):raise RuntimeError('unsupported RSS monitor platform')
    try:result=subprocess.run(['ps','-o','rss=','-p',str(pid)],capture_output=True,text=True,check=False,timeout=5)
    except (OSError,subprocess.TimeoutExpired) as error:raise RuntimeError('RSS observation unavailable: '+str(error)) from error
    value=result.stdout.strip()
    if result.returncode or not value:raise RuntimeError(f'RSS observation unavailable: ps exit {result.returncode}, stderr={result.stderr[:256]!r}')
    try:amount=int(value)
    except ValueError as error:raise RuntimeError('invalid ps RSS value') from error
    if amount<=0:raise RuntimeError('nonpositive ps RSS value')
    return amount*1024


def terminate_group(child,grace):
    try:os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError:return
    try:child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        child.wait()



def cache_environment(out,create=False):
    root=Path(out).resolve()/'work-cache'
    paths=dict(TMPDIR=root/'tmp',TEMP=root/'tmp',TMP=root/'tmp',TORCHINDUCTOR_CACHE_DIR=root/'inductor',NUMBA_CACHE_DIR=root/'numba')
    if create:
        if root.is_symlink():raise ValueError('working-cache root symlink prohibited')
        for path in set(paths.values()):
            if path.is_symlink():raise ValueError('working-cache symlink prohibited')
            path.mkdir(parents=True,exist_ok=True)
            if not path.resolve().is_relative_to(root):raise ValueError('working-cache escaped owned root')
    return {k:str(v) for k,v in paths.items()}


def run(scope_path,digest,out,score=False):
    scope=P.preflight(scope_path,digest);out=Path(out).resolve()
    if out!=Path(scope['out']):raise ValueError('result directory differs from frozen request')
    policy=scope['score_resource_policy'] if score else scope['resource_policy']
    phase='score' if score else scope['phase'];prefix='score-' if score else ''
    P.disk(out,scope['archive_bounds'])
    if score:
        if scope['phase']!='fit':raise ValueError('score requires fit scope')
        for name in ('monitor.json','child.json'):
            proof=P.R.A.read_unique_json(out/name)
            if not proof.get('complete') or proof.get('phase')!='fit' or proof.get('scope_sha256')!=digest:raise ValueError('matching terminal fit required')
        if (out/'score.json').exists() or (out/'dev-r162-nn.json').exists():raise FileExistsError('score already exists')
    else:P.R.atomic_json(out/'links.json',P.stage(out,scope['evidence']['inputs']))
    env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',**cache_environment(out,create=True))
    started=P.R.utc();start=time.monotonic();peak=0;failure=None
    command=[sys.executable,str(P.HERE/'r16_shallow_nn_runner.py'),'_score_child' if score else '_child',
        '--scope',str(Path(scope_path).resolve()),'--scope-sha256',digest,'--out',str(out)]
    previous={};received=[]
    def interrupted(number,frame):received.append(signal.Signals(number).name)
    with open(out/(prefix+'process.log'),'xb') as log:
        child=None
        for number in (signal.SIGTERM,signal.SIGHUP):previous[number]=signal.signal(number,interrupted)
        try:
            child=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
            P.R.atomic_json(out/(prefix+'monitor-start.json'),dict(status='started',phase=phase,scope_sha256=digest,monitor_pid=os.getpid(),child_pid=child.pid,child_pgid=os.getpgid(child.pid),started_at=started,command=command,working_cache_environment=cache_environment(out)))
            if received:raise RuntimeError('monitor received signal '+received[-1])
            while child.poll() is None:
                if received:raise RuntimeError('monitor received signal '+received[-1])
                elapsed=time.monotonic()-start
                try:rss=resident_bytes(child.pid)
                except RuntimeError:
                    if child.poll() is not None:break  # ps raced a completed child; final gates still apply.
                    raise
                peak=max(peak,rss)
                if rss>policy['rss_bytes']:raise RuntimeError('operational RSS cap exceeded')
                if elapsed>policy['wall_seconds']:raise RuntimeError('operational wall cap exceeded')
                P.disk(out,scope['archive_bounds'])
                if (out/(prefix+'process.log')).stat().st_size>P.LOG_BYTES:raise RuntimeError('external process log cap exceeded')
                time.sleep(1)
        except BaseException as error:
            failure=type(error).__name__+': '+str(error)
            if child is not None:terminate_group(child,policy['grace_seconds'])
        finally:
            for number,handler in previous.items():signal.signal(number,handler)
        code=child.wait() if child is not None else None
    elapsed=time.monotonic()-start
    if received and failure is None:failure='monitor received signal '+received[-1]
    if elapsed>policy['wall_seconds'] and failure is None:failure='operational wall cap exceeded at completion'
    if code!=0 and failure is None:failure=f'child exit {code}'
    value=dict(complete=failure is None,phase=phase,started_at=started,ended_at=P.R.utc(),elapsed_seconds=elapsed,
        scope_sha256=digest,child_pid=child.pid if child is not None else None,child_exit=code,peak_sampled_child_rss_bytes=peak,failure=failure,
        monitor='Child RSS via ps each second with5s observation timeout; fail closed while live. Not an exhaustive instantaneous peak.',
        timeout='External process-group SIGTERM on wall/RSS/disk/observation/signal breach,30s grace thenSIGKILL; no retry/resume',
        recovery='All partial outputs preserved')
    if value['complete']:
        try:
            receipt=P.R.A.read_unique_json(out/('score.json' if score else 'child.json'));P.disk(out,scope['archive_bounds'])
            if not receipt.get('complete') or receipt.get('scope_sha256')!=digest or receipt.get('phase')!=phase:raise ValueError('missing/mismatched complete child receipt')
            value['child_receipt']=P.R.pin(out/('score.json' if score else 'child.json'))
        except BaseException as error:value.update(complete=False,failure=type(error).__name__+': '+str(error))
    P.R.atomic_json(out/(prefix+'monitor.json'),value)
    if not value['complete']:raise RuntimeError(value['failure'])
    return value
