"""Bounded adapter, NOT an admission. Existing O113 authenticate is reused only
for retained source/runtime/130-input provenance; its old accounting is not reused.
No point-model fitting, resampling, raw acquisition or discovery is performed.
"""
import ast
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import shutil
import signal
import sys
import time

POLICY=dict(wall_seconds=120,rss_bytes=1073741824,disk_reserve_bytes=2147483648,output_bytes=67108864)
CELLS=((24,5),(72,7))
OUTPUTS=('cell-24-k5.npz','cell-72-k7.npz','private-detail.json','public-summary.json','checkpoint.json')


def need(ok,msg):
    if not ok:raise ValueError(msg)


def pin(path):
    path=Path(path);h=hashlib.sha256();n=0
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b);n+=len(b)
    return dict(path=str(path),size=n,sha256=h.hexdigest())


def checked(p):
    need(type(p) is dict and set(p)=={'path','size','sha256'} and type(p['path']) is str,'typed pin')
    q=Path(p['path']);need(q.is_absolute() and not q.is_symlink() and str(q)==str(q.resolve()),'canonical nonsymlink pin')
    need(pin(q)==p,'pin mismatch');return q.read_bytes()


def module(name,p):
    raw=checked(p);m=importlib.util.module_from_spec(importlib.util.spec_from_loader(name,loader=None))
    m.__file__=p['path'];need(name not in sys.modules,'occupied source name');sys.modules[name]=m
    try:exec(compile(raw,p['path'],'exec'),m.__dict__)
    except BaseException:sys.modules.pop(name,None);raise
    return m


def atomic(path,value):
    raw=(json.dumps(value,allow_nan=False,separators=(',',':'))+'\n').encode()
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    need(path.stat().st_mode&0o777==0o600 and path.read_bytes()==raw,'JSON readback')


def checkpoint(path,value):
    # Initial root is exclusive; only this producer replaces its checkpoint.
    tmp=path.with_name('.checkpoint.tmp');atomic(tmp,value);os.replace(tmp,path)


def input_authenticate(A,old,source_pin):
    # Reuse ONLY original byte/runtime/membership statements78-99, excluding
    # secondary scope/status, old wall policy/budget and old output contract.
    tree=ast.parse(checked(source_pin));f=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='authenticate')
    body=[n for n in f.body if 78<=n.lineno<=99]
    need(len(body)==21,'qualified auth source layout')
    body=ast.parse("p=r['pins']").body+body
    fn=ast.FunctionDef(name='_retained_input_auth',args=f.args,body=body,decorator_list=[])
    env=dict(A.__dict__);exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),source_pin['path'],'exec'),env)
    env['_retained_input_auth'](old)


def authenticate(r):
    need(r.get('schema')=='q26-weighted-causal-primary-pair-run-request-v1' and r.get('parent_admitted') is True,'DRAFT not admitted')
    need(r['policy']==POLICY and r['cells']==[[24,5,'alts'],[72,7,'alts']],'fixed policy/pair')
    p=r['pins'];need({'implementation','tests','protocol','kernel','input_adapter','accepted_input_request','accepted_input_authenticator','read_guard','original_ranges','original_score'}<=set(p),'source roles')
    need(p['implementation']==pin(__file__),'executing source')
    for v in p.values():checked(v)
    old=json.loads(checked(p['accepted_input_request']))
    need(old['pins']['runner']==p['accepted_input_authenticator'] and old['pins']['read_guard']==p['read_guard'] and old['pins']['ranges']==p['original_ranges'] and old['pins']['score']==p['original_score'],'accepted input auth/guard binding')
    A=module('q26_weighted_old_input_auth',p['accepted_input_authenticator'])
    try:input_authenticate(A,old,p['accepted_input_authenticator'])
    finally:sys.modules.pop(A.__name__,None)
    need(len(old['inputs'])==130 and len({x['path'] for x in old['inputs']})==130,'exact130 input paths')
    need(r['invocation_python']==sys.executable and r['resolved_python']==str(Path(sys.executable).resolve()),'interpreter binding')
    need(r['threads']==old['threads'],'accepted thread policy')
    out=Path(r['out']);need(out.is_absolute() and str(out)==str(out.resolve()) and not out.exists() and not out.is_symlink(),'fresh canonical output')
    need(out.parent.is_dir(),'existing output parent')
    return old


def persist(np,path,arrays):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:np.savez_compressed(f,**arrays);f.flush();os.fsync(f.fileno())
    with np.load(path,allow_pickle=False) as z:
        need(set(z.files)==set(arrays),'NPZ exact fields')
        for k,v in arrays.items():
            w=z[k];need(w.dtype==v.dtype and w.shape==v.shape,'NPZ dtype/shape')
            need(np.array_equal(w,v,equal_nan=True),'NPZ readback values')
            if v.dtype.kind=='f':need(w.tobytes()==v.tobytes(),'NPZ float bits')
    need(path.stat().st_mode&0o777==0o600,'NPZ mode')


def calculate(np,K,I,original,files,out,bound):
    details=[];catalogues=[];summaries=[]
    for H,k in CELLS:
        checkpoint(out/'checkpoint.json',dict(schema='q26-weighted-causal-primary-pair-checkpoint-v1',status='RUNNING',stage='cell',cell=[H,k,'alts'],completed_cells=len(details)))
        selected=I.stream_primary(np,files,original,cell=I.PrimaryCell(H,k),checkpoint=bound)
        rows=selected['rows'];bound();r=K.cell(**{f:rows[f] for f in ('p','y','sg','day')},horizon=H,level_index=k);bound()
        a=r.pop('private_arrays');arrays={f:v for f,v in a.items() if f not in ('bounds','arm_eligible')}
        arrays.update({f:rows[f] for f in ('series','cluster','row_index')})
        for arm in K.ARMS:
            arrays[arm+'_lower'],arrays[arm+'_upper']=a['bounds'][arm]
            arrays[arm+'_eligible']=a['arm_eligible'][arm]
        persist(np,out/f'cell-{H}-k{k}.npz',arrays);bound()
        details.append(r);summaries.append({f:v for f,v in r.items() if f!='folds'})
        catalogues.append(dict(cell=[H,k,'alts'],names=list(selected['names']),file_order=list(selected['file_order']),has_boot=selected['has_boot'],original_joint_mask=selected['original_joint_mask']))
        checkpoint(out/'checkpoint.json',dict(schema='q26-weighted-causal-primary-pair-checkpoint-v1',status='RUNNING',stage='cell_persisted',cell=[H,k,'alts'],completed_cells=len(details)))
        del arrays,a,rows,r,selected
    atomic(out/'private-detail.json',dict(schema='q26-weighted-causal-primary-pair-detail-v1',cells=details,catalogues=catalogues));bound()
    return dict(schema='q26-weighted-causal-primary-pair-summary-v1',cells=summaries,calculations_complete=True,
        scientific_acceptance=False,original_R164_NOT_RUN_unchanged=True,base_forecast_model_fits=0,
        interpretation='Historical descriptive weighted causal amendment; partial support retained; no power or promotion.')


def run(r):
    start=time.monotonic();out=None;stage='authenticate';previous=signal.getsignal(signal.SIGALRM)
    def timeout(*_):raise TimeoutError('120s bounded weighted-pair job')
    signal.signal(signal.SIGALRM,timeout);signal.setitimer(signal.ITIMER_REAL,POLICY['wall_seconds'])
    names=[]
    try:
        old=authenticate(r);out=Path(r['out']);out.mkdir(mode=0o700);need(out.stat().st_mode&0o777==0o700,'output directory mode')
        def bound():
            rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
            size=sum(x.stat().st_size for x in out.iterdir() if x.is_file())
            need(time.monotonic()-start<=POLICY['wall_seconds'] and rss<=POLICY['rss_bytes'] and shutil.disk_usage(out).free>=POLICY['disk_reserve_bytes'] and size<=POLICY['output_bytes'],'resource envelope')
        bound();p=r['pins'];G=module('q26_weighted_pair_guard',p['read_guard']);names.append(G.__name__)
        reads=[x['path'] for x in [*p.values(),*old['pins'].values(),*old['inputs'],*old['runtime_pins']]]
        with G.guard(reads,out):
            stage='imports';import numpy as np
            I=module('q26_weighted_pair_inputs',p['input_adapter']);names.append(I.__name__)
            K=module('q26_weighted_pair_kernel',p['kernel']);names.append(K.__name__)
            original=I.contracts(np,checked(old['pins']['ranges']),checked(old['pins']['score']))
            stage='cells';summary=calculate(np,K,I,original,[x['path'] for x in old['inputs']],out,bound)
            output_pins=[pin(out/name) for name in ('cell-24-k5.npz','cell-72-k7.npz','private-detail.json')]
            stage='final_reauthentication'
            # The original auth refuses existing NEW out only via our outer auth;
            # reauthenticate old immutable closure directly, without any old job.
            A=module('q26_weighted_old_input_recheck',p['accepted_input_authenticator']);names.append(A.__name__)
            input_authenticate(A,old,p['accepted_input_authenticator'])
            for v in p.values():checked(v)
            for v in output_pins:checked(v)
            bound();stage='summary';atomic(out/'public-summary.json',summary);bound()
            checkpoint(out/'checkpoint.json',dict(schema='q26-weighted-causal-primary-pair-checkpoint-v1',status='COMPLETE',stage='complete',completed_cells=2,elapsed_seconds=time.monotonic()-start))
            need(set(x.name for x in out.iterdir())==set(OUTPUTS),'exact output closure');bound()
        return summary
    except BaseException as exc:
        if out is not None and out.is_dir():
            if (out/'public-summary.json').exists():(out/'public-summary.json').unlink()
            checkpoint(out/'checkpoint.json',dict(schema='q26-weighted-causal-primary-pair-checkpoint-v1',status='FAILED',stage=stage,error_type=type(exc).__name__,elapsed_seconds=time.monotonic()-start))
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
        for name in reversed(names):sys.modules.pop(name,None)


if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--sha256',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
    q=Path(args.request);need(pin(q)['sha256']==args.sha256,'trusted request identity')
    request=json.loads(q.read_bytes());need(args.out==request['out'],'CLI/request output binding');run(request)
