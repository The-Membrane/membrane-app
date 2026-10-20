"""CODEX CONTINUATION: canonical shallow-row adapter; no producer invocation.
New reconstruction only: historical NN weights/runtime/model-menu are unrecovered.
The existing D.task remains immutable; this adapter strips its returned payload.
"""
from __future__ import annotations
import ast
import hashlib
import json
from pathlib import Path
import os
import numpy as np
import r16_dev as D
import r16_nn as NN  # Torch is imported only inside NN execution functions.

SUMMARY_SHA256='bab3c5445894eeb2ec56307689452c101ef9831bdae95a1a486059b5a9a447bb'
ORIGINAL_CODE='7bdaa124'
ORIGINAL_TASK_AST_SHA256='480788695a93dd68b1f4e2015f0bfd08e13f7e8a463ffa454a5f6490a709a9b6'
HORIZONS=(1,3,12)
FIELDS=('sid','ts','y','fH','f')+tuple(NN.STATIC)
DTYPES={k:('int32' if k=='sid' else 'int64' if k=='ts' else 'int8' if k=='y' else 'float32') for k in FIELDS}


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()


def load_published_summary(path):
    if sha(path)!=SUMMARY_SHA256: raise ValueError('canonical published summary SHA mismatch')
    summary=json.loads(Path(path).read_text())
    canonical_specs(summary,[dict(key=k) for k in summary['series']])
    return summary


def canonical_specs(summary,available_specs):
    keys=summary.get('series',[])
    if summary.get('code')!=ORIGINAL_CODE or len(keys)!=277 or len(set(keys))!=277 or not all(isinstance(k,str) for k in keys):
        raise ValueError('exact published 277-key canonical summary required')
    specs=list(available_specs); names=[s['key'] for s in specs]
    if len(names)!=len(set(names)): raise ValueError('duplicate available spec key')
    if set(names)!=set(keys): raise ValueError('missing or unknown available spec keys')
    bykey={s['key']:s for s in specs}
    return [bykey[k] for k in keys]


def verify_task_ast(path=None):
    path=Path(D.__file__) if path is None else Path(path)
    node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='task')
    actual=hashlib.sha256(ast.dump(node,include_attributes=False).encode()).hexdigest()
    if actual!=ORIGINAL_TASK_AST_SHA256: raise ValueError('original per-series producer AST differs')
    return actual


def read_unique_json(path):
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result: raise ValueError('duplicate JSON key')
            result[key]=value
        return result
    return json.loads(Path(path).read_text(),object_pairs_hook=unique)


def validate_horizon(values,T,sid):
    if set(values)!=set(FIELDS): raise ValueError('exact retained fields required')
    if np.asarray(values['ts']).ndim!=1: raise ValueError('timestamp vector required')
    n=len(values['ts']); k=len(D.LV[T])
    for name,v in values.items():
        expected=(n,k) if name in ('y','fH','f') else (n,)
        if np.asarray(v).shape!=expected or str(np.asarray(v).dtype)!=DTYPES[name]:
            raise ValueError('original horizon shape/dtype required: '+name)
    for name in ('f','fH'):
        v=values[name]
        if not np.isfinite(v).all() or np.any((v<0)|(v>1)): raise ValueError('finite baseline probabilities in [0,1] required')
    if np.any(values['sid']!=sid) or not np.isin(values['y'],[0,1]).all():
        raise ValueError('original binary labels and canonical SID required')
    if len(np.unique(values['ts']))!=n: raise ValueError('duplicate per-series timestamp')
    return n


def retain_series_rows(result,key_to_sid):
    key=result['key']
    if key not in key_to_sid: raise ValueError('unknown task result key')
    sid=key_to_sid[key]; rows={}
    for T in HORIZONS:
        if T not in result['rows']: continue  # Preserve original absent horizons, not invented rows.
        src=result['rows'][T]; n=len(src['ts']); k=len(D.LV[T])
        if np.asarray(src['ts']).ndim!=1 or not np.issubdtype(np.asarray(src['ts']).dtype,np.integer):
            raise ValueError('original integer timestamp vector required')
        for name in ('y','fH','f'):
            if np.asarray(src[name]).shape!=(n,k): raise ValueError('horizon-level shape mismatch')
        if not np.isin(src['y'],[0,1]).all(): raise ValueError('binary original labels required')
        for name in NN.STATIC:
            if np.asarray(src[name]).shape!=(n,): raise ValueError('static-feature shape mismatch')
        # No sorting, thinning, imputation, clipping or dtype conversion of producer fields.
        rows[T]={name:(np.full(n,sid,np.int32) if name=='sid' else np.asarray(src[name])) for name in FIELDS}
        validate_horizon(rows[T],T,sid)
    return rows


def write_series_shard(root,result,key_to_sid):
    """One durable immutable directory per completed series, independent of arrival order."""
    rows=retain_series_rows(result,key_to_sid); sid=key_to_sid[result['key']]
    root=Path(root); root.mkdir(parents=True,exist_ok=True)
    final=root/f'{sid:03d}'; temporary=root/f'.{sid:03d}.partial'
    if final.exists() or temporary.exists(): raise FileExistsError('existing complete/partial shard requires explicit reconciliation')
    temporary.mkdir()
    receipt=dict(schema='r16-shallow-series-shard-v1',key=result['key'],canonical_sid=sid,
        fields=list(FIELDS),files={},fallback=result.get('fallback'),fits=result.get('fits'))
    for T,values in rows.items():
        name=f'rows-T{T}.npz'; path=temporary/name
        np.savez_compressed(path,**values)
        receipt['files'][str(T)]=dict(name=name,sha256=sha(path),rows=len(values['ts']),
            dtypes={k:str(v.dtype) for k,v in values.items()})
    (temporary/'manifest.json').write_text(json.dumps(receipt,indent=2,allow_nan=False)+'\n')
    os.replace(temporary,final)
    return receipt


def collect_shards(results,root,canonical_keys):
    """Consume any completion order; duplicate/missing/unknown series are hard errors."""
    keys=list(canonical_keys)
    if len(keys)!=len(set(keys)): raise ValueError('duplicate canonical key')
    mapping={k:i for i,k in enumerate(keys)}; seen=set()
    for result in results:
        key=result['key']
        if key in seen: raise ValueError('duplicate task result key')
        if key not in mapping: raise ValueError('unknown task result key')
        write_series_shard(root,result,mapping); seen.add(key)
    if seen!=set(keys): raise ValueError('missing task result key; completed shards preserved')
    return mapping


def merge_shards(root,out,canonical_keys):
    """Merge one shallow horizon at a time; never materialize the all-horizon archive.
    Both durable shards and final archives occupy disk until an explicit later cleanup.
    """
    root,out=Path(root),Path(out); keys=list(canonical_keys)
    if len(keys)!=len(set(keys)): raise ValueError('duplicate canonical key')
    expected={f'{i:03d}' for i in range(len(keys))}
    if set(p.name for p in root.iterdir())!=expected: raise ValueError('missing/unknown/partial shard directory')
    manifests=[]
    for sid,key in enumerate(keys):
        directory=root/f'{sid:03d}'; receipt=read_unique_json(directory/'manifest.json')
        if receipt.get('schema')!='r16-shallow-series-shard-v1': raise ValueError('shard schema mismatch')
        records=receipt.get('files',{})
        if not isinstance(records,dict) or not set(records).issubset({str(T) for T in HORIZONS}):
            raise ValueError('unknown shard horizon')
        for T,record in records.items():
            if record.get('name')!=f'rows-T{T}.npz': raise ValueError('unexpected shard payload name')
            if record.get('dtypes')!=DTYPES: raise ValueError('shard declared dtypes mismatch')
        expected_files={'manifest.json'}|{record['name'] for record in records.values()}
        if set(p.name for p in directory.iterdir())!=expected_files: raise ValueError('unexpected/missing shard file')
        if receipt['key']!=key or receipt['canonical_sid']!=sid or receipt['fields']!=list(FIELDS):
            raise ValueError('shard identity/schema mismatch')
        manifests.append(receipt)
    if out.exists(): raise FileExistsError('output path already exists')
    out.mkdir(parents=True); outputs={}
    for T in HORIZONS:
        parts=[]
        for sid,receipt in enumerate(manifests):
            if str(T) not in receipt['files']: continue
            record=receipt['files'][str(T)]; p=root/f'{sid:03d}'/record['name']
            if sha(p)!=record['sha256']: raise ValueError('shard payload SHA mismatch')
            with np.load(p,allow_pickle=False) as z: values={k:z[k] for k in z.files}
            n=validate_horizon(values,T,sid)
            if n!=record['rows'] or {k:str(v.dtype) for k,v in values.items()}!=record['dtypes']:
                raise ValueError('shard row identity/dtype mismatch')
            parts.append(values)
        if not parts: raise ValueError('no original rows for required shallow horizon')
        values={k:np.concatenate([v[k] for v in parts],axis=0) for k in FIELDS}
        p=out/f'rows-T{T}.npz'; np.savez_compressed(p,**values)
        outputs[str(T)]=dict(rows=len(values['ts']),sha256=sha(p),name=p.name)
    metadata=dict(series=keys,code=D.git_sha(),producer_reference_code=ORIGINAL_CODE,reconstruction=True,
        provenance='Canonical SID adapter of immutable original D.task; not original historical archives or weights',outputs=outputs)
    (out/'rows-meta.json').write_text(json.dumps(metadata,indent=2)+'\n')
    return metadata
