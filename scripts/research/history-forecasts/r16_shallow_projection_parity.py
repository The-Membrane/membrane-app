"""Five-series exact-byte projection parity; stage only until a scope is frozen."""
from __future__ import annotations
import argparse
import ast
from collections import Counter
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import numpy as np
import r16_shallow_reconstruction_runner as R

SCHEMA='r16-shallow-projection-parity-v1'
SELECTED={0:'P1:KRAKEN-ETH',1:'dev:BTC',2:'dev:ETH',3:'A2:BNBUSDT',276:'blind8:ZROUSDT'}
CHILD_SECONDS=600
TOTAL_SECONDS=3600
OUTPUT_LIMIT=1_000_000
DISK_RESERVE=2_000_000_000


class AuditViolation(BaseException):
    """Cannot be silently swallowed by legacy except Exception fallbacks."""


def parity_sources():
    todo=[Path(__file__),R.HERE/'test_r16_shallow_projection_parity.py',
          R.HERE/'r16_shallow_projection.py',R.HERE/'test_r16_shallow_projection.py']
    pins=R.source_closure()
    while todo:
        p=todo.pop().resolve(); key=str(p.relative_to(R.ROOT))
        if key in pins:continue
        pins[key]=R.A.sha(p)
        for node in ast.walk(ast.parse(p.read_text())):
            names=[n.name for n in node.names] if isinstance(node,ast.Import) else ([node.module] if isinstance(node,ast.ImportFrom) and node.module else [])
            for name in names:
                candidate=R.HERE/(name.split('.')[0]+'.py')
                if candidate.is_file() and str(candidate.relative_to(R.ROOT)) not in pins:todo.append(candidate)
    return pins


def freeze(request,out):
    out=Path(out)
    if out.exists():raise FileExistsError('parity scope already exists')
    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='parity-freeze-',dir=out.parent) as temp:
        p=Path(temp)/'base.json';R.freeze(request,p);base=R.A.read_unique_json(p)
    for sid,key in SELECTED.items():
        if base['canonical_keys'][sid]!=key:raise ValueError('fixed parity SID/key differs')
    if any(v!='1' for v in base['runtime']['threads'].values()):raise ValueError('freeze requires all three thread variables set to1')
    scope=dict(schema=SCHEMA,created_at=R.utc(),base_scope=base,source_sha256=parity_sources(),
        selected={str(k):v for k,v in SELECTED.items()},child_seconds=CHILD_SECONDS,total_seconds=TOTAL_SECONDS,
        output_limit_bytes=OUTPUT_LIMIT,disk_reserve_bytes=DISK_RESERVE,
        interpretation='Five-series exact implementation parity only; no forecasting skill, full-generation approval or historical-state recovery')
    R.atomic_json(out,scope);return dict(scope_path=str(out.resolve()),scope_sha256=R.A.sha(out))


def preflight(scope_path,digest):
    if R.A.sha(scope_path)!=digest:raise ValueError('scope SHA differs')
    scope=R.A.read_unique_json(scope_path)
    if scope.get('schema')!=SCHEMA or scope['source_sha256']!=parity_sources():raise ValueError('parity source/schema differs')
    if scope['selected']!={str(k):v for k,v in SELECTED.items()}:raise ValueError('selected identities differ')
    if [scope[k] for k in ('child_seconds','total_seconds','output_limit_bytes','disk_reserve_bytes')]!=[600,3600,1_000_000,2_000_000_000]:
        raise ValueError('frozen resource controls differ')
    specs=R.preflight(scope['base_scope'])
    for sid,key in SELECTED.items():
        if specs[sid]['key']!=key:raise ValueError('canonical identity differs')
    return scope,specs


def read_audit(root,allowed):
    root=Path(root).resolve();allowed={str(Path(p).resolve()) for p in allowed};counts=Counter();ledger=dict(total=0,attempts=[])
    def deny(reason,path):
        ledger['total']+=1
        if len(ledger['attempts'])<16:ledger['attempts'].append(dict(reason=reason,path=str(path)[:512]))
        raise AuditViolation(reason)
    def hook(event,args):
        if event!='open' or isinstance(args[0],int):return
        lexical=Path(os.path.abspath(os.fsdecode(args[0])));path=lexical.resolve()
        namespace_inside=lexical.is_relative_to(root) or any(parent.resolve()==root for parent in lexical.parents)
        if namespace_inside and not path.is_relative_to(root):deny('dataset symlink escapes approved root',lexical)
        if not path.is_relative_to(root):return
        mode=args[1] if len(args)>1 else None;flags=args[2] if len(args)>2 else 0
        write=bool((flags or 0)&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or (isinstance(mode,str) and any(c in mode for c in 'wax+'))
        if write:deny('dataset writes prohibited during parity',path)
        if str(path) not in allowed:deny('unlisted dataset read prohibited',path)
        counts[str(path)]+=1
    return hook,counts,ledger


def descriptor(array):
    a=np.asarray(array);floating=np.issubdtype(a.dtype,np.floating)
    mask=np.isnan(a) if floating else np.zeros(a.shape,dtype=bool)
    return dict(shape=list(a.shape),dtype=a.dtype.str,nan_mask_sha256=hashlib.sha256(mask.tobytes(order='C')).hexdigest(),sha256=hashlib.sha256(memoryview(np.ascontiguousarray(a)).cast('B')).hexdigest(),
        nbytes=a.nbytes,elements=a.size,finite=int(np.isfinite(a).sum()),nan=int(np.isnan(a).sum()) if floating else 0,
        positive_inf=int(np.isposinf(a).sum()) if floating else 0,negative_inf=int(np.isneginf(a).sum()) if floating else 0)


def describe_rows(rows):
    if set(rows)!=set(R.A.HORIZONS) or any(not len(rows[T]['ts']) for T in R.A.HORIZONS):
        raise ValueError('selected positive path requires all three nonempty horizons')
    descriptors={str(T):dict(present=T in rows,fields={k:descriptor(v) for k,v in rows.get(T,{}).items()}) for T in R.A.HORIZONS}
    buffer=io.BytesIO();np.savez_compressed(buffer,**{f'T{T}__{k}':v for T,r in rows.items() for k,v in r.items()});buffer.seek(0)
    with np.load(buffer,allow_pickle=False) as z:
        for T,r in rows.items():
            for k in r:
                if descriptor(z[f'T{T}__{k}'])!=descriptors[str(T)]['fields'][k]:raise ValueError('in-memory NPZ roundtrip changes bytes')
    return descriptors


def safe_message(message):
    text=str(message).replace('\n',' ')[:320]
    for delimiter in ('[','{'):
        if delimiter in text:text=text.split(delimiter,1)[0]+'<bracketed detail omitted>'
    return text


def bounded_json(path,value):
    path=Path(path); n=len((json.dumps(value,indent=2,allow_nan=False)+'\n').encode())
    current=output_bytes(path.parent) if path.parent.exists() else 0
    old=path.stat().st_size if path.exists() else 0
    if current-old+n>OUTPUT_LIMIT:raise RuntimeError('canonical receipts exceed aggregate output cap')
    R.budget(path.parent,dict(reserve_bytes=DISK_RESERVE),n)
    R.atomic_json(path,value)


def child(scope_path,digest,sid,arm,receipt):
    receipt=Path(receipt)
    if receipt.exists():raise FileExistsError('child receipt already exists')
    if sid not in SELECTED or arm not in ('original','projection'):raise ValueError('unknown parity arm/SID')
    scope,specs=preflight(scope_path,digest);base=scope['base_scope'];started=R.utc()
    R.budget(receipt.parent,dict(reserve_bytes=DISK_RESERVE),max(0,OUTPUT_LIMIT-output_bytes(receipt.parent)))
    allowed=[p['path'] for p in base['price_inputs']+base['auxiliary_inputs']]+[base[k]['path'] for k in ('summary','price_manifest')]
    hook,reads,violations=read_audit(base['datasets'],allowed);sys.addaudithook(hook)
    try:
        if R.A.D.R12._CHAIN or R.A.D._BTC:raise RuntimeError('fresh child unexpectedly contains chain/BTC cache')
        R.A.D.init_btc(base['datasets'])
        if violations['total']:raise AuditViolation('initializer suppressed an input audit violation')
        producer=R.A.D.task if arm=='original' else importlib.import_module('r16_shallow_projection').task
        result=producer(specs[sid])
        if violations['total']:raise AuditViolation('producer suppressed an input audit violation')
        if result['key']!=SELECTED[sid]:raise ValueError('producer identity differs')
        rows=R.A.retain_series_rows(result,{k:i for i,k in enumerate(base['canonical_keys'])})
        value=dict(complete=True,arm=arm,sid=sid,key=SELECTED[sid],pid=os.getpid(),started_at=started,ended_at=R.utc(),
            descriptors=describe_rows(rows),memory_npz_roundtrip=True,opened_inputs=dict(sorted(reads.items())),
            producer_fits=result.get('fits'),producer_fallback=result.get('fallback'),scope_sha256=digest,audit_violations=violations)
        if violations['total']:raise AuditViolation('input audit violation prevents completion')
        bounded_json(receipt,value)
    except BaseException as error:
        bounded_json(receipt,dict(complete=False,arm=arm,sid=sid,started_at=started,ended_at=R.utc(),
            error_type=type(error).__name__,error=safe_message(error),opened_inputs=dict(sorted(reads.items())),audit_violations=violations))
        raise


def validate_descriptors(value):
    if set(value)!=set(map(str,R.A.HORIZONS)):raise ValueError('all three horizon descriptors required')
    for T,entry in value.items():
        fields=entry['fields']
        if not entry['present'] or set(fields)!=set(R.A.FIELDS):raise ValueError('positive complete field set required')
        shape=fields['ts']['shape'];n=shape[0] if len(shape)==1 else 0
        if type(n) is not int or n<=0:raise ValueError('nonempty original rows required')
        for name,d in fields.items():
            expected=[n,len(R.A.D.LV[int(T)])] if name in ('y','f','fH') else [n]
            if d['shape']!=expected or d['dtype']!=np.dtype(R.A.DTYPES[name]).str:raise ValueError('field shape/dtype differs')
            elements=int(np.prod(expected))
            if d['elements']!=elements or d['nbytes']!=elements*np.dtype(d['dtype']).itemsize:raise ValueError('field byte-count differs')
            if sum(d[k] for k in ('finite','nan','positive_inf','negative_inf'))!=elements:raise ValueError('field count totals differ')
            for key in ('sha256','nan_mask_sha256'):
                if len(d[key])!=64 or any(c not in '0123456789abcdef' for c in d[key]):raise ValueError('invalid byte hash')


def validate_receipt(value,sid,arm,scope,digest):
    if not value.get('complete') or (value.get('sid'),value.get('arm'),value.get('key'))!=(sid,arm,SELECTED[sid]):
        raise ValueError('child completion/identity differs')
    if value.get('scope_sha256')!=digest or value.get('memory_npz_roundtrip') is not True:raise ValueError('child provenance/codec check differs')
    if value.get('audit_violations')!={'total':0,'attempts':[]}:raise ValueError('audited denied attempt prevents approval')
    base=scope['base_scope'];allowed={str(Path(p['path']).resolve()) for p in base['price_inputs']+base['auxiliary_inputs']}
    allowed|={str(Path(base[k]['path']).resolve()) for k in ('summary','price_manifest')}
    reads=value.get('opened_inputs')
    if not isinstance(reads,dict) or not set(reads).issubset(allowed) or any(type(v) is not int or v<=0 for v in reads.values()):
        raise ValueError('audited read-set differs from approved inputs')
    btc=str((Path(base['datasets'])/'binance-klines/BTCUSDT-1h.json').resolve())
    if btc not in reads:raise ValueError('original BTC initialization read absent')
    validate_descriptors(value['descriptors'])


def compare(original,projected):
    if not original.get('complete') or not projected.get('complete'):raise ValueError('incomplete parity arm')
    if (original['sid'],original['key'])!=(projected['sid'],projected['key']):raise ValueError('arm identity mismatch')
    validate_descriptors(original['descriptors']);validate_descriptors(projected['descriptors'])
    if original['descriptors']!=projected['descriptors']:raise ValueError('exact field bytes/shape/dtype/order differ')
    return True


def output_bytes(out):return sum(p.stat().st_size for p in Path(out).iterdir() if p.is_file())


def run(scope_path,digest,out):
    start=time.monotonic();out=Path(out)
    if out.exists():raise FileExistsError('parity output exists; no retry/resume/overwrite')
    scope,_=preflight(scope_path,digest);out.parent.mkdir(parents=True,exist_ok=True)
    R.budget(out.parent,dict(reserve_bytes=DISK_RESERVE),OUTPUT_LIMIT);out.mkdir()
    started=R.utc();completed=[];calls=0;active=None
    bounded_json(out/'run.json',dict(status='started',started_at=started,scope_sha256=digest))
    try:
        for sid in SELECTED:
            receipts=[]
            for arm in ('original','projection'):
                active=dict(sid=sid,key=SELECTED[sid],arm=arm)
                R.budget(out,dict(reserve_bytes=DISK_RESERVE),max(0,OUTPUT_LIMIT-output_bytes(out)))
                remaining=TOTAL_SECONDS-(time.monotonic()-start)
                if remaining<=0:raise TimeoutError('total parity runtime exhausted')
                path=out/f'{arm}-{sid:03d}.json';env=dict(os.environ)
                env.update({k:'1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')})
                cmd=[sys.executable,str(Path(__file__).resolve()),'__child','--scope',str(Path(scope_path).resolve()),
                    '--scope-sha256',digest,'--sid',str(sid),'--arm',arm,'--receipt',str(path.resolve())]
                calls+=1
                try:
                    result=subprocess.run(cmd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=min(CHILD_SECONDS,remaining),check=False)
                except subprocess.TimeoutExpired as error:
                    raise TimeoutError('child deadline terminated execution; no retry') from error
                if time.monotonic()-start>TOTAL_SECONDS:raise TimeoutError('total elapsed parity deadline exceeded after child')
                if result.returncode:
                    bounded_json(out/f'error-{sid:03d}-{arm}.json',dict(sid=sid,arm=arm,returncode=result.returncode,
                        stage='child_error_receipt' if path.exists() else 'child_exit_before_receipt',
                        child_receipt=path.name if path.exists() else None))
                    raise RuntimeError(f'child failed sid={sid} arm={arm}, status={result.returncode}; bounded diagnostic receipt saved')
                value=R.A.read_unique_json(path)
                validate_receipt(value,sid,arm,scope,digest)
                receipts.append(value)
                if output_bytes(out)>OUTPUT_LIMIT:raise RuntimeError('total canonical receipts exceed one-million-byte cap')
            compare(*receipts);completed.append(dict(sid=sid,key=SELECTED[sid],exact=True))
            bounded_json(out/'comparisons.json',dict(completed=completed,projection_approved=False))
        if time.monotonic()-start>TOTAL_SECONDS:raise TimeoutError('total elapsed parity deadline exceeded before finalization')
        final=dict(complete=True,all_five_exact=True,child_calls=calls,completed=completed,started_at=started,ended_at=R.utc(),
            projection_approved=False,interpretation='Exact five-series parity only; full generation requires separately frozen scope',scope_sha256=digest)
        bounded_json(out/'run.json',final);bounded_json(out/'manifest.json',final)
        return final
    except BaseException as error:
        bounded_json(out/'run.json',dict(complete=False,status='error',started_at=started,ended_at=R.utc(),child_calls=calls,
            completed=completed,active_child=active,projection_approved=False,error_type=type(error).__name__,error=safe_message(error)))
        raise


def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    f=sub.add_parser('freeze');f.add_argument('--request',required=True);f.add_argument('--out',required=True)
    for name in ('run','__child'):
        q=sub.add_parser(name);q.add_argument('--scope',required=True);q.add_argument('--scope-sha256',required=True)
        if name=='run':q.add_argument('--out',required=True)
        else:q.add_argument('--sid',type=int,required=True);q.add_argument('--arm',choices=('original','projection'),required=True);q.add_argument('--receipt',required=True)
    a=p.parse_args()
    result=freeze(a.request,a.out) if a.command=='freeze' else run(a.scope,a.scope_sha256,a.out) if a.command=='run' else child(a.scope,a.scope_sha256,a.sid,a.arm,a.receipt)
    if result is not None:print(json.dumps(result))


if __name__=='__main__':main()
