"""CODEX CONTINUATION: freeze/run orchestration; generation needs a frozen scope.
Run writes canonical per-series shards only; merging/training need a later scope.
No Torch import, neural training, reserve acquisition, uploads or implicit resume.
"""
from __future__ import annotations
import argparse
import ast
from datetime import datetime,timezone
import hashlib
import io
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import numpy as np
from threadpoolctl import threadpool_info
import r16_shallow_reconstruction as A

SCHEMA='r16-shallow-reconstruction-run-v1'
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
AUXILIARY={
 'deribit-dvol/dvol-eth-1h.json':'c55620d0227bb88f3d695a51c6c6ffefbd90db04428fa88728127d64011a9617',
 'deribit-dvol/dvol-btc-1h.json':'e736f4cde9de756d3ebd7916373d60f1c15aec4940f86b3b06e6dead1fc7308d'}


def utc(): return datetime.now(timezone.utc).isoformat()


def atomic_json(path,value):
    path=Path(path); temp=path.with_name(path.name+'.tmp')
    temp.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n'); os.replace(temp,path)


def runtime():
    packages=sorted([d.metadata['Name'].lower(),d.version] for d in importlib.metadata.distributions() if d.metadata.get('Name'))
    return dict(executable=sys.executable,python=sys.version,platform=platform.platform(),machine=platform.machine(),
        packages=packages,threadpools=threadpool_info(),threads={k:os.environ.get(k) for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')})


def source_closure():
    """Over-approximate static local imports, including function-local imports.
    Include adapter/producer/NN and runner tests; optional local branches are pinned too.
    """
    todo=[Path(__file__).resolve(),Path(A.__file__),Path(A.D.__file__),Path(A.NN.__file__),
          HERE/'test_r16_shallow_reconstruction_runner.py',HERE/'test_r16_shallow_reconstruction.py']
    seen=set()
    while todo:
        path=todo.pop().resolve()
        if path in seen: continue
        seen.add(path)
        for node in ast.walk(ast.parse(path.read_text())):
            names=[n.name for n in node.names] if isinstance(node,ast.Import) else ([node.module] if isinstance(node,ast.ImportFrom) and node.module else [])
            for name in names:
                candidate=HERE/(name.split('.')[0]+'.py')
                if candidate.is_file() and candidate.resolve() not in seen: todo.append(candidate)
    return {str(p.relative_to(ROOT)):A.sha(p) for p in sorted(seen)}


def pin(path):
    p=Path(path).resolve(); return dict(path=str(p),sha256=A.sha(p),size=p.stat().st_size)


def check_pin(entry):
    p=Path(entry['path'])
    if not p.is_file() or p.stat().st_size!=entry['size'] or A.sha(p)!=entry['sha256']:
        raise ValueError('input/source pin mismatch: '+str(p))


def read_price_manifest(path,datasets):
    manifest=A.read_unique_json(path); files=manifest.get('files',[])
    if not manifest.get('complete') or manifest.get('verified_count')!=280 or len(files)!=280 or manifest.get('errors'):
        raise ValueError('complete verified original 280-price manifest required')
    names=[f['path'] for f in files]
    if len(set(names))!=280: raise ValueError('duplicate raw path')
    result=[]
    for record in files:
        relative=Path(record['path'])
        if relative.is_absolute() or '..' in relative.parts: raise ValueError('raw path escapes dataset root')
        p=(datasets/relative).resolve()
        if not p.is_relative_to(datasets): raise ValueError('raw symlink escapes dataset root')
        result.append(dict(path=str(p),relative=str(relative),size=record['size'],sha256=record['sha256']))
    return result


def freeze(request_path,out):
    out=Path(out)
    if out.exists(): raise FileExistsError('frozen scope already exists')
    request=A.read_unique_json(request_path); datasets=Path(request['datasets']).resolve()
    summary=A.load_published_summary(request['summary_path'])
    specs=A.canonical_specs(summary,A.D.R12.dev_specs(str(datasets)))
    prices=read_price_manifest(request['price_manifest_path'],datasets)
    if A.read_unique_json(request['price_manifest_path']).get('dataset_commit')!=request['dataset_commit']:
        raise ValueError('original dataset reference differs from price manifest')
    required={str(Path(s['path']).resolve()) for s in specs if 'path' in s}
    required|={str((datasets/A.D.M2.A.INPUTS[k][0]).resolve()) for k in ('eth_price','btc_price','steth_price')}
    required|={str((datasets/A.D.M2.KLINES[p][0]).resolve()) for p in ('ETHUSDT','BTCUSDT')}
    if {p['path'] for p in prices}!=required or len(required)!=280:
        raise ValueError('price manifest differs from exact original development price closure')
    auxiliary=[]
    for relative,digest in AUXILIARY.items():
        p=pin(datasets/relative)
        if p['sha256']!=digest: raise ValueError('frozen original DVOL identity mismatch')
        p['relative']=relative; auxiliary.append(p)
    for p in prices+auxiliary: check_pin(p)
    A.verify_task_ast()
    policy=request['disk_policy']
    if set(policy)!={'reserve_bytes','max_shard_bytes','max_shards_bytes','temporary_reserve_bytes'} or any(type(v) is not int or v<=0 for v in policy.values()):
        raise ValueError('explicit positive disk policy required')
    if policy['reserve_bytes']<2_000_000_000: raise ValueError('minimum two-billion-byte reserve required')
    source=source_closure(); plan=pin(request['plan_path'])
    scope=dict(schema=SCHEMA,created_at=utc(),request=pin(request_path),datasets=str(datasets),
        dataset_commit=request['dataset_commit'],source_commit=A.D.git_sha(),summary=pin(request['summary_path']),
        price_manifest=pin(request['price_manifest_path']),plan=plan,source_sha256=source,runtime=runtime(),
        price_inputs=prices,auxiliary_inputs=auxiliary,canonical_keys=summary['series'],
        disk_policy=policy,producer_task_ast_sha256=A.verify_task_ast(),
        interpretation='New canonical row reconstruction only; retrospective cross-fitting, not forward validation or historical state recovery')
    out.parent.mkdir(parents=True,exist_ok=True); atomic_json(out,scope)
    return dict(scope_path=str(out.resolve()),scope_sha256=A.sha(out),sources=len(source),price_inputs=280,auxiliary_inputs=2)


def preflight(scope):
    if scope.get('schema')!=SCHEMA: raise ValueError('unknown frozen scope')
    if A.D.git_sha()!=scope['source_commit']: raise ValueError('source commit differs from freeze')
    for k in ('request','summary','price_manifest','plan'): check_pin(scope[k])
    if source_closure()!=scope['source_sha256']: raise ValueError('local source closure differs')
    if runtime()!=scope['runtime']: raise ValueError('runtime differs from freeze')
    if len(scope['price_inputs'])!=280 or len(scope['auxiliary_inputs'])!=2: raise ValueError('282 input pins required')
    for p in scope['price_inputs']+scope['auxiliary_inputs']: check_pin(p)
    summary=A.load_published_summary(scope['summary']['path'])
    if summary['series']!=scope['canonical_keys']: raise ValueError('canonical ordering differs')
    if A.verify_task_ast()!=scope['producer_task_ast_sha256']: raise ValueError('task AST differs')
    return A.canonical_specs(summary,A.D.R12.dev_specs(scope['datasets']))


def budget(path,policy,allowance):
    free=shutil.disk_usage(path).free
    if free<policy['reserve_bytes']+allowance: raise RuntimeError('insufficient disk headroom before allocation/write')
    return free


def shard_write_bound(rows,result,sid):
    """Conservative file-byte bound: NPY headers + zlib compressBound + ZIP64 overhead.
    Parent's temporary reserve separately covers directory/filesystem allocation.
    No compression ratio is assumed; even incompressible arrays are budgeted.
    """
    total=0; records={}
    for T,values in rows.items():
        archive=120  # End-of-central-directory plus ZIP64 end/locator allowance.
        for name,array in values.items():
            header=io.BytesIO()
            np.lib.format.write_array_header_1_0(header,np.lib.format.header_data_from_array_1_0(array))
            n=len(header.getvalue())+array.nbytes
            compressed=n+(n>>12)+(n>>14)+(n>>25)+13  # zlib's documented compressBound formula.
            filename=len((name+'.npy').encode())
            archive+=compressed+30+filename+20+24+46+filename+32
        total+=archive
        records[str(T)]=dict(name=f'rows-T{T}.npz',sha256='0'*64,rows=len(values['ts']),
                            dtypes={k:str(v.dtype) for k,v in values.items()})
    receipt=dict(schema='r16-shallow-series-shard-v1',key=result['key'],canonical_sid=sid,
        fields=list(A.FIELDS),files=records,fallback=result.get('fallback'),fits=result.get('fits'))
    return total+len((json.dumps(receipt,indent=2,allow_nan=False)+'\n').encode())


def run(scope_path,out,expected_scope_sha256):
    scope_path=Path(scope_path); out=Path(out)
    if out.exists(): raise FileExistsError('output path exists; no implicit resume')
    if A.sha(scope_path)!=expected_scope_sha256: raise ValueError('explicit frozen scope SHA mismatch')
    scope=A.read_unique_json(scope_path); specs=preflight(scope); policy=scope['disk_policy']
    out.parent.mkdir(parents=True,exist_ok=True)
    budget(out.parent,policy,policy['max_shards_bytes']+policy['temporary_reserve_bytes'])
    out.mkdir(); started=utc(); atomic_json(out/'run.json',dict(status='started',started_at=started,scope_sha256=expected_scope_sha256))
    completed=[]; cumulative_bound=0
    try:
        # This is the only initializer needed before calling the unchanged sequential task.
        budget(out,policy,policy['max_shard_bytes']); A.D.init_btc(scope['datasets'])
        mapping={k:i for i,k in enumerate(scope['canonical_keys'])}; shards=out/'shards'
        for spec in specs:
            budget(out,policy,policy['max_shards_bytes']-cumulative_bound+policy['temporary_reserve_bytes'])
            result=A.D.task(spec)
            if result['key']!=spec['key']: raise ValueError('producer returned unexpected key')
            retained=A.retain_series_rows(result,mapping)
            estimate=shard_write_bound(retained,result,mapping[result['key']])
            if cumulative_bound+estimate>policy['max_shards_bytes']: raise RuntimeError('total shard bound exceeds frozen disk allowance')
            if estimate>policy['max_shard_bytes']: raise RuntimeError('series shard exceeds frozen disk allowance')
            budget(out,policy,estimate+policy['temporary_reserve_bytes']); receipt=A.write_series_shard(shards,result,mapping)
            directory=shards/f"{mapping[result['key']]:03d}"
            actual_bytes=sum(p.stat().st_size for p in directory.iterdir())
            if actual_bytes>estimate: raise RuntimeError('actual shard exceeds proven file-byte bound')
            cumulative_bound+=estimate
            completed.append(dict(key=result['key'],canonical_sid=mapping[result['key']],files=receipt['files'],
                shard_file_bytes=actual_bytes,shard_write_bound_bytes=estimate))
            atomic_json(out/'progress.json',dict(status='running',completed_series=len(completed),last_key=result['key'],at=utc()))
            del retained,result
        manifest=dict(complete=True,status='complete',started_at=started,ended_at=utc(),scope_sha256=expected_scope_sha256,
            price_inputs_verified=280,auxiliary_inputs_verified=2,series=len(completed),shards=completed,
            output_kind='canonical_series_shards_only',merged=False,shard_write_bound_bytes=cumulative_bound,
            free_bytes_after=budget(out,policy,0),runtime=scope['runtime'])
        atomic_json(out/'run.json',manifest); atomic_json(out/'manifest.json',manifest)
        return manifest
    except BaseException as error:
        atomic_json(out/'run.json',dict(status='error',complete=False,started_at=started,ended_at=utc(),
            scope_sha256=expected_scope_sha256,completed_series=len(completed),error_type=type(error).__name__,error=str(error),
            recovery='Completed/partial shards preserved; no automatic restart or resume'))
        raise


def load_source_check(scope,specs):
    """No probability-model fitting: exercise the exact raw loaders only."""
    counts=[]; policy=scope['disk_policy']
    budget(scope['datasets'],policy,policy['max_shard_bytes'])
    A.D.init_btc(scope['datasets'])
    for spec in specs:
        budget(scope['datasets'],policy,policy['max_shard_bytes'])
        series,folds,_=A.D.R12.load_series(spec)
        counts.append(dict(key=spec['key'],bars=len(series.close),folds=len(folds)))
        if hasattr(A.D.A6,'_clear'): A.D.A6._clear(series)
    return dict(checked_series=len(counts),series=counts,no_task_called=True,no_neural_training=True)


def main():
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest='command',required=True)
    f=sub.add_parser('freeze'); f.add_argument('--request',required=True); f.add_argument('--out',required=True)
    r=sub.add_parser('run'); r.add_argument('--scope',required=True); r.add_argument('--scope-sha256',required=True); r.add_argument('--out',required=True)
    p=sub.add_parser('preflight'); p.add_argument('--scope',required=True); p.add_argument('--scope-sha256',required=True); p.add_argument('--load-sources',action='store_true')
    args=parser.parse_args()
    if args.command=='preflight':
        if A.sha(args.scope)!=args.scope_sha256: raise ValueError('scope SHA mismatch')
        scope=A.read_unique_json(args.scope); specs=preflight(scope)
        print(json.dumps(load_source_check(scope,specs) if args.load_sources else dict(verified_series=len(specs),input_pins=282)))
        return
    result=freeze(args.request,args.out) if args.command=='freeze' else run(args.scope,args.out,args.scope_sha256)
    print(json.dumps(result if args.command=='freeze' else {k:result[k] for k in ('complete','series','started_at','ended_at')}))


if __name__=='__main__': main()
