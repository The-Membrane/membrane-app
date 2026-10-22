"""Unchanged fixed-C admission only; qualified Q/S/O retains observation."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import math

HERE=Path(__file__).resolve().parent
OLD_PATH=HERE/'preparation_observer.py'
OLD_SHA='390a4e72d2f9c56da5dbbc431767abc3afa8bae26872e0405f8e56d41494a3d5'
raw=OLD_PATH.read_bytes()
if hashlib.sha256(raw).hexdigest()!=OLD_SHA:raise ValueError('qualified original24 observer changed')
spec=importlib.util.spec_from_file_location('_q26_fixed_c_qualified_preparation_observer',OLD_PATH)
P=importlib.util.module_from_spec(spec);exec(compile(raw,str(OLD_PATH),'exec'),vars(P))
M=P.M
Q,O=P.Q,P.O
SCHEMA='q26-full277-fixed-c-observer-request-v1'
SCOPE='FULL277_UNCHANGED_FIXED_C_EVALUATION'
POLICY=dict(rss_bytes=1342177280,output_bytes=805306368,disk_reserve_bytes=2415919104)
BUDGET=dict(total_seconds=3720,producer_seconds=1800,checker_seconds=1800,cleanup_seconds=120)
KEYS={'schema','kind','fixture_only','policy','invocation_python','resolved_python','python_pin',
      'source_pins','runtime_pins','phase','inner_request','runner','argv','output'}
PHASE_KEYS={'schema','status','scope','started_unix','deadline_unix',*BUDGET}


def phase(r,completed=False):
    p=M.read(r['phase'],65536)
    extra={'producer_terminal','producer_manifest','producer_stdout'} if r['kind']=='saved_check' else set()
    O.need(set(p)==PHASE_KEYS|extra and p['schema']=='q26-full277-fixed-c-phase-v1' and
           p['status']=='ADMITTED_PARENT_REVIEWED' and p['scope']==SCOPE and
           all(type(p[k])is int and p[k]==v for k,v in BUDGET.items()),'DRAFT or wrong fresh3720 phase')
    O.need(all(type(p[k])in(int,float) and math.isfinite(p[k]) for k in ('started_unix','deadline_unix')) and
           p['deadline_unix']==p['started_unix']+3720 and p['started_unix']<=time.time() and
           time.time()+(0 if completed else r['policy']['wall_seconds']+120)<=p['deadline_unix'],
           'nonrenewable fresh phase deadline with cleanup reserve')
    if extra:O.need(p['producer_terminal']==r['producer_observer_terminal'] and
                    p['producer_manifest']==r['producer_manifest'] and p['producer_stdout']==r['producer_stdout'],
                    'parent conditional producer evidence')
    return p


def runner_argv(r,mode):
    argv=[r['invocation_python'],'-B',r['runner']['path'],'--mode',mode,'--request',r['inner_request']['path'],
          '--request-sha256',r['inner_request']['sha256']]
    if mode=='check':argv+=['--manifest',r['producer_manifest']['path'],'--manifest-sha256',r['producer_manifest']['sha256']]
    return argv


def producer_binding(r,inner):
    terminal=M.read(r['producer_observer_terminal'],65536)
    O.need(terminal['schema']=='q26-weighted-causal-primary-pair-observer-terminal-v1' and
           terminal['complete'] is True and type(terminal['tool_terminal_exit'])is int and
           terminal['tool_terminal_exit']==0 and terminal['process_terminal'] is True and
           terminal['observer_timeout'] is False and terminal['reason'] is None and terminal['errors']==[] and
           terminal['fixture_only'] is r['fixture_only'] and
           terminal['containment']==dict(reaped=True,no_live_members_remaining=True,remaining_live_members=[]),
           'actual clean preparation producer terminal')
    O.need(type(terminal['charged_seconds'])is int and terminal['charged_seconds']==math.ceil(terminal['elapsed_seconds']) and
           0<=terminal['elapsed_seconds']<=1800,'actual producer charge')
    original=M.read(terminal['request'],M.OUTER_CAP)
    O.need(set(original)==KEYS and original['schema']==SCHEMA and original['kind']=='producer' and
           original['fixture_only'] is r['fixture_only'] and original['inner_request']==r['inner_request'] and
           original['runner']==terminal['runner'] and original['python_pin']==r['python_pin'] and
           original['invocation_python']==r['invocation_python'] and original['resolved_python']==r['resolved_python'] and
           original['source_pins']==r['source_pins'] and original['runtime_pins']==r['runtime_pins'] and
           original['output']==inner['out'] and original['argv']==runner_argv(original,'produce'),
           'same actual producer admission/command lineage')
    if not r['fixture_only']:O.need(original['runner']==r['runner'],'same fixed preparation transport source')
    policy=original['policy']
    O.need({k:v for k,v in policy.items() if k!='wall_seconds'}==POLICY and
           ((r['fixture_only'] and type(policy['wall_seconds'])in(int,float) and 0<policy['wall_seconds']<=2) or
            (not r['fixture_only'] and type(policy['wall_seconds'])is int and policy['wall_seconds']==1800)),
           'original producer fixed resource policy')
    previous=phase(original,completed=True);current=phase(r)
    O.need(all(previous[k]==current[k] for k in PHASE_KEYS),'same producer/checker3720 clock')
    root=M.canonical(inner['out']);O.need(root.is_dir(),'existing preparation root')
    O.need(r['producer_manifest']['path']==str(root/'manifest.json'),'exact externally sealed manifest path')
    manifest=M.read(r['producer_manifest'])
    if r['fixture_only']:
        O.need(manifest['schema']=='q26-full277-fixed-c-transport-fixture-result-v1' and
               manifest['fixture_only'] is True and manifest['complete'] is True and
               manifest['request_sha256']==r['inner_request']['sha256'],'generated-only manifest')
    else:
        O.need(manifest['schema']=='q26-full277-fixed-c-manifest-v1' and manifest['complete'] is True and manifest['scope']==SCOPE and
               manifest['canonical_mapping']==inner['canonical_mapping'] and
               manifest['empirical_admission_status']=='ADMITTED_SEEN_DEVELOPMENT_FIXED_C_EVALUATION_ONLY' and
               manifest['candidate_evaluation_status']=='EVALUATED_UNCHANGED_C' and
               manifest['forecast_promotion_status']=='NOT_ADMITTED' and manifest['unseen_validation'] is False and
               manifest['source_synthetic_component'] is False and len(manifest['series_receipts'])==277,
               'actual full277 baseline preparation manifest')
        for p in manifest['series_receipts']:
            O.need(M.canonical(p['path']).is_relative_to(root),'prepared receipt beneath root');M.checked(p)
    if not r['fixture_only']:
        proof=M.read(r['producer_stdout'],65536)
        O.need(r['producer_stdout']['path']==r['producer_observer_terminal']['path']+'.stdout.log' and
               proof['schema']=='q26-full277-fixed-c-produced-v1' and proof['complete'] is True and
               proof['scope']==SCOPE and proof['request']==r['inner_request'] and
               proof['manifest']==r['producer_manifest'] and proof['series']==277 and
               proof['unchanged_C_evaluated'] is True and proof['original24_controls']=='EXACT' and
               proof['forecast_promotion_status']=='NOT_ADMITTED' and proof['unseen_validation'] is False,
               'actual producer stdout bound to request and manifest')
    else:M.checked(r['producer_stdout'])
    return root


def preflight(path,sha,receipt):
    rp=O.pin(M.canonical(path));O.need(rp['sha256']==sha and rp['size']<=M.OUTER_CAP,'external bounded observer SHA')
    r=M.read(rp,M.OUTER_CAP)
    extra={'producer_observer_terminal','producer_manifest','producer_stdout'} if r.get('kind')=='saved_check' else set()
    O.need(set(r)==KEYS|extra and r['schema']==SCHEMA and r['kind']in('producer','saved_check') and
           type(r['fixture_only'])is bool,'strict full277 observer purpose')
    p=r['policy'];O.need(set(p)==set(POLICY)|{'wall_seconds'} and
        all(type(p[k])is int and p[k]==v for k,v in POLICY.items()),'fixed preparation resources')
    if r['fixture_only']:O.need(type(p['wall_seconds'])in(int,float) and 0<p['wall_seconds']<=2,'tiny generated transport')
    else:O.need(type(p['wall_seconds'])is int and p['wall_seconds']==1800,'fixed preparation phase wall')
    phase(r)
    for k in ('python_pin','inner_request','runner'):M.checked(r[k])
    O.need(r['invocation_python']==sys.executable and str(Path(r['invocation_python']).resolve())==
           r['resolved_python']==r['python_pin']['path'],'current invocation/resolved interpreter')
    sources=M.closure(r['source_pins']);runtime=M.closure(r['runtime_pins'])
    for path in (Path(__file__),OLD_PATH,P.OLD_PATH,M.Q_PATH,Path(Q.S.__file__),Path(O.__file__)):
        O.need(sources.get(str(path.resolve()))==O.pin(path.resolve()),'unchanged observer source closure')
    O.need(sources.get(r['runner']['path'])==r['runner'],'runner in source closure')
    inner=M.read(r['inner_request'])
    if r['fixture_only']:
        O.need(set(inner)=={'schema','status','scope','files','runtime','out'} and
               inner['schema']=='q26-full277-fixed-c-transport-fixture-v1' and
               inner['status']=='READY_SYNTHETIC_OBSERVER_FIXTURE' and inner['scope']=='FIXTURE_ONLY',
               'typed generated fixture only')
        files=M.closure(inner['files'])
    else:
        O.need(r['runner']==O.pin(HERE/'fixed_c_run.py'),'fixed preparation worker')
        R=load_run(r['runner'])
        inner,prep,old,_,raw_scope,_=R.authenticate(r['inner_request']['path'],r['inner_request']['sha256'],
                                   mode='produce' if r['kind']=='producer' else 'check')
        files={p['path']:p for p in inner['files']}
    M.runtime_environment(inner)
    wanted={p['path']:p for p in [inner['runtime']['executable'],*inner['runtime']['native_pins']]}
    O.need(runtime==wanted and inner['runtime']['executable']==r['python_pin'],'entire current runtime closure')
    for p in wanted.values():O.need(files.get(p['path'])==p,'runtime in inner closure')
    for p in inner['files']:
        if Path(p['path']).suffix in('.py','.md'):O.need(sources.get(p['path'])==p,'all source files in outer closure')
    roots=({M.canonical(p['path']).parent for p in inner['files']} if r['fixture_only'] else
           R.protected_roots(inner,prep,old,raw_scope))
    if r['kind']=='producer':
        O.need(r['output']==inner['out'],'exact fresh prepared output')
        if not r['fixture_only']:O.need(M.canonical(r['output'])==R.ROOT,'fixed full277 output root')
    else:
        roots.add(producer_binding(r,inner))
        if not r['fixture_only']:
            O.need(M.canonical(r['output'])==R.CHECK_ROOT,'fixed saved-check write/resource-accounting root')
    O.need(r['argv']==runner_argv(r,'produce' if r['kind']=='producer' else 'check'),'literal preparation argv')
    output,dest=M.canonical(r['output']),M.canonical(receipt)
    O.need(output.parent==dest.parent and output.parent.is_dir(),'existing shared evidence parent')
    if not r['fixture_only']:O.need(output.parent==R.ROOT.parent,'fixed research evidence parent')
    paths=dict(receipt=dest,start=Path(str(dest)+'.start.json'),stdout=Path(str(dest)+'.stdout.log'),stderr=Path(str(dest)+'.stderr.log'))
    targets=[output,*paths.values(),Path(str(dest)+'.sampling.json'),Path(str(dest)+'.post-containment.json')]
    O.need(len(set(targets))==7 and all(not p.exists() and not p.is_symlink() for p in targets),'seven exclusive destinations')
    if r['fixture_only']:
        O.need(all(not p.is_relative_to(root) for p in targets for root in roots),'immutable roots remain read-only')
    else:
        R.protect_targets(targets,inner['files'],roots)
    O.need(O.shutil.disk_usage(output.parent).free>=r['policy']['disk_reserve_bytes'],'prelaunch disk reserve')
    return rp,r,output,paths


def load_run(record):
    M.checked(record);raw=Path(record['path']).read_bytes()
    O.need(hashlib.sha256(raw).hexdigest()==record['sha256'],'transport unchanged before compile')
    spec=importlib.util.spec_from_file_location('_q26_fixed_c_run_metadata',record['path'])
    module=importlib.util.module_from_spec(spec);exec(compile(raw,record['path'],'exec'),vars(module));return module


def observe(path,sha,receipt,*,factory=subprocess.Popen,sample=None,kill=O.os.killpg):
    previous=Q.preflight;Q.preflight=preflight
    def launch(*args,**kwargs):
        rp=O.pin(M.canonical(path));O.need(rp['sha256']==sha,'launch external observer SHA')
        r=M.read(rp,M.OUTER_CAP);inner=M.read(r['inner_request'])
        O.need(args and args[0]==r['argv'],'launch exact admitted command')
        env=dict(kwargs['env']);env.update(M.runtime_environment(inner));kwargs['env']=env
        return factory(*args,**kwargs)
    try:return Q.observe(path,sha,receipt,factory=launch,sample=sample,kill=kill)
    finally:Q.preflight=previous


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for k in ('request','sha256','receipt'):p.add_argument('--'+k,required=True)
    a=p.parse_args();r=observe(a.request,a.sha256,a.receipt)
    print(json.dumps({k:r[k] for k in('complete','reason','elapsed_seconds','charged_seconds')}))
    raise SystemExit(0 if r['complete'] else 1)
