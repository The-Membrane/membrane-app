"""CODEX CONTINUATION: separately frozen, merge-only projected row derivative.
No producer, fitting, neural execution, scoring, cleanup or implicit resume.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
import r16_shallow_reconstruction_runner as R

HERE=Path(__file__).resolve().parent
SCHEMA='r16-shallow-merge-only-v1'
GENERATION_SHA='3a64af819f09940642222d890c895549d2f73e2fc6b9c3d070dc58106af754ce'
GENERATION_MANIFEST_SHA='354f3d358aaecfda4be4c81ef354e5d908bf8f2d9a58245443a0407f54505380'
GENERATION_INDEPENDENT_SHA='f870b9c860ccfab62a76aa00fd8d724e53b6778f55d7280e06b75b12c14a2472'
EXPECTED={'1':1424924,'3':1424353,'12':1422858}
RESERVE=2_000_000_000
TEMPORARY=50_000_000
SECONDS=3600
MAX_OUTPUT=420106366
POLICY=dict(reserve_bytes=RESERVE,max_output_bytes=MAX_OUTPUT,temporary_reserve_bytes=TEMPORARY)


def rss_observation():
    """Best-effort process-lifetime high-water; never a phase-specific limit."""
    metric='resource.getrusage(RUSAGE_SELF).ru_maxrss'
    try:
        import resource
        raw=int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        unit='bytes' if sys.platform=='darwin' else 'KiB' if sys.platform.startswith('linux') else 'unknown'
        normalized=raw if unit=='bytes' else raw*1024 if unit=='KiB' else None
    except (ImportError,AttributeError,OSError,ValueError,OverflowError):
        raw,unit,normalized=None,'unavailable',None
    return dict(metric=metric,raw_value=raw,raw_unit=unit,peak_rss_bytes=normalized,
        scope='Process-lifetime high-water including imports/preflight/merge/verification; not a phase-only peak or enforced limit')


def metadata_pin(path):return R.pin(path)


def accepted_generation(request):
    scope_path=Path(request['generation_scope_path'])
    if R.A.sha(scope_path)!=GENERATION_SHA:raise ValueError('unaccepted generation scope')
    scope=R.A.read_unique_json(scope_path);base=scope['base_scope']
    manifest_path=Path(request['generation_manifest_path']);manifest=R.A.read_unique_json(manifest_path)
    independent_path=Path(request['generation_independent_path']);independent=R.A.read_unique_json(independent_path)
    if R.A.sha(manifest_path)!=GENERATION_MANIFEST_SHA or R.A.sha(independent_path)!=GENERATION_INDEPENDENT_SHA:
        raise ValueError('accepted generation proof pin changed')
    if not manifest.get('complete') or manifest.get('series')!=277 or manifest.get('row_totals')!=EXPECTED:
        raise ValueError('terminal original277 generation required')
    if manifest.get('scope_sha256')!=GENERATION_SHA or manifest.get('merged') is not False or manifest.get('neural_training') is not False:
        raise ValueError('generation provenance differs')
    if manifest.get('audit_violations')!=dict(total=0,attempts=[]):raise ValueError('generation denial ledger is not clean')
    expected=dict(complete=True,scope_sha256=GENERATION_SHA,canonical_series=277,row_totals=EXPECTED,
        source_pins=23,original_unchanged_source_pins=21,raw_input_pins=282,exact_sentinel_field_comparisons=255,
        manifest_sha256=R.A.sha(manifest_path))
    if any(independent.get(k)!=v for k,v in expected.items()):raise ValueError('independent generation evidence differs')
    for relative,digest in scope['source_sha256'].items():
        if R.A.sha(R.ROOT/relative)!=digest:raise ValueError('frozen generation source changed')
    for k in ('request','summary','price_manifest','plan'):R.check_pin(base[k])
    for entry in base['price_inputs']+base['auxiliary_inputs']:R.check_pin(entry)
    proof=scope['proof']
    for k in ('scope','manifest','independent'):R.check_pin(proof[k])
    for group in ('references','projections'):
        for entry in proof[group].values():R.check_pin(entry)
    keys=R.A.load_published_summary(base['summary']['path'])['series']
    if keys!=base['canonical_keys'] or len(keys)!=277:raise ValueError('original canonical identity differs')
    root=manifest_path.parent/'shards'
    if {p.name for p in root.iterdir()}!={f'{i:03d}' for i in range(277)}:raise ValueError('canonical shards missing/extra')
    if len(manifest['shards'])!=277:raise ValueError('exact277 shard records required')
    pins=[];totals={k:0 for k in EXPECTED};records=[]
    for sid,key in enumerate(keys):
        directory=root/f'{sid:03d}';path=directory/'manifest.json';record=R.A.read_unique_json(path)
        outer=manifest['shards'][sid]
        if outer.get('sid')!=sid or outer.get('key')!=key:raise ValueError('generation shard order differs')
        if record.get('schema')!='r16-shallow-series-shard-v1' or record.get('key')!=key or record.get('canonical_sid')!=sid:
            raise ValueError('shard canonical identity differs')
        if record['fields']!=list(R.A.FIELDS) or outer['files']!=record['files'] or outer['manifest_sha256']!=R.A.sha(path):
            raise ValueError('shard receipt differs')
        if set(record['files'])-set(EXPECTED):raise ValueError('unknown horizon')
        if {p.name for p in directory.iterdir()}!={'manifest.json'}|{f'rows-T{k}.npz' for k in record['files']}:
            raise ValueError('unexpected shard contents')
        pins.append(metadata_pin(path))
        for horizon,entry in record['files'].items():
            payload=directory/entry['name']
            if entry['name']!=f'rows-T{horizon}.npz' or entry['dtypes']!=R.A.DTYPES or R.A.sha(payload)!=entry['sha256']:
                raise ValueError('shard payload differs')
            totals[horizon]+=entry['rows'];pins.append(metadata_pin(payload))
        records.append(record)
    if totals!=EXPECTED:raise ValueError('original three row totals differ')
    evidence=dict(scope=metadata_pin(scope_path),manifest=metadata_pin(manifest_path),independent=metadata_pin(independent_path),
        shard_pins=pins,shards=str(root.resolve()),canonical_keys=keys,source_sha256=scope['source_sha256'],
        raw_pins=base['price_inputs']+base['auxiliary_inputs'],metadata_pins=[base[k] for k in ('request','summary','price_manifest','plan')],
        datasets=base['datasets'],generation_runtime=base['runtime'])
    return evidence


def merge_bounds():
    bounds={}
    for horizon,n in EXPECTED.items():
        width=len(R.A.D.LV[int(horizon)]);bound=120
        for name in R.A.FIELDS:
            shape=(n,width) if name in ('y','fH','f') else (n,)
            array=np.lib.format.header_data_from_array_1_0(np.empty(0,dtype=R.A.DTYPES[name]))
            array['shape']=shape
            header=io.BytesIO();np.lib.format.write_array_header_1_0(header,array)
            count=int(np.prod(shape))*np.dtype(R.A.DTYPES[name]).itemsize+len(header.getvalue())
            compressed=count+(count>>12)+(count>>14)+(count>>25)+13
            filename=len((name+'.npy').encode());bound+=compressed+30+filename+20+24+46+filename+32
        bounds[f'rows-T{horizon}.npz']=bound
    return bounds


def freeze(request_path,out):
    out=Path(out)
    if out.exists():raise FileExistsError('merge scope exists')
    request=R.A.read_unique_json(request_path);evidence=accepted_generation(request)
    if R.runtime()!=evidence['generation_runtime']:raise ValueError('runtime differs from verified generation')
    if request.get('disk_policy')!=POLICY:raise ValueError('exact frozen disk policy required')
    if sum(merge_bounds().values())>MAX_OUTPUT:raise ValueError('conservative output bound exceeds declared maximum')
    pins=dict(evidence['source_sha256'])
    for name in ('r16_shallow_merge_runner.py','test_r16_shallow_merge_runner.py'):
        path=HERE/name;pins[str(path.relative_to(R.ROOT))]=R.A.sha(path)
    scope=dict(schema=SCHEMA,created_at=R.utc(),request=metadata_pin(request_path),plan=metadata_pin(request['plan_path']),
        source_sha256=pins,runtime=R.runtime(),evidence=evidence,bounds=merge_bounds(),
        policy=POLICY,seconds=SECONDS,
        interpretation='Projected generation derivative; original D.task is not rerun by this merge')
    out.parent.mkdir(parents=True,exist_ok=True);R.atomic_json(out,scope)
    return dict(scope_path=str(out.resolve()),scope_sha256=R.A.sha(out))


def preflight(path,digest):
    if R.A.sha(path)!=digest:raise ValueError('frozen merge scope changed')
    scope=R.A.read_unique_json(path)
    if scope['schema']!=SCHEMA or scope['bounds']!=merge_bounds() or scope['policy']!=POLICY or scope['seconds']!=SECONDS:
        raise ValueError('fixed merge recipe differs')
    for k in ('request','plan'):R.check_pin(scope[k])
    for relative,expected in scope['source_sha256'].items():
        if R.A.sha(R.ROOT/relative)!=expected:raise ValueError('source pin changed')
    if R.runtime()!=scope['runtime']:raise ValueError('runtime changed')
    evidence=scope['evidence']
    for k in ('scope','manifest','independent'):R.check_pin(evidence[k])
    for entry in evidence['shard_pins']+evidence['raw_pins']+evidence['metadata_pins']:R.check_pin(entry)
    return scope


def write_guard(out,bounds):
    """Disk checks immediately before unchanged adapter opens each output file."""
    out=Path(out).resolve();seen=set();state=dict(active=True,archive_open_checks=[])
    def hook(event,args):
        if not state['active'] or event!='open' or isinstance(args[0],int):return
        path=Path(os.path.abspath(os.fsdecode(args[0]))).resolve()
        if not path.is_relative_to(out):return
        mode=args[1];flags=args[2] or 0
        writing=bool(flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or (isinstance(mode,str) and any(c in mode for c in 'wax+'))
        if not writing:return
        allowed=set(bounds)|{'rows-meta.json','merge-provenance.json','merge-provenance.json.tmp'}
        if path.parent!=out or path.name not in allowed:raise ValueError('unexpected merge output write')
        if path.name in bounds:
            if path.name in seen:raise ValueError('duplicate archive write')
            remaining=sum(value for name,value in bounds.items() if name not in seen)
            R.budget(out,dict(reserve_bytes=RESERVE),remaining+TEMPORARY)
            seen.add(path.name);state['archive_open_checks'].append(path.name)
        else:R.budget(out,dict(reserve_bytes=RESERVE),TEMPORARY)
    return hook,state


def verify_merge(shards,out,keys):
    """Compare every merged field to ordered per-SID bytes without concatenation."""
    shards,out=Path(shards),Path(out);outputs={}
    for horizon in R.A.HORIZONS:
        target=out/f'rows-T{horizon}.npz'
        with np.load(target,allow_pickle=False) as z:
            if tuple(z.files)!=R.A.FIELDS:raise ValueError('merged field order/schema differs')
            merged={k:z[k] for k in z.files}
        n=EXPECTED[str(horizon)];width=len(R.A.D.LV[horizon]);hashes={k:hashlib.sha256() for k in R.A.FIELDS}
        for name,a in merged.items():
            if str(a.dtype)!=R.A.DTYPES[name] or a.shape!=((n,width) if name in ('y','fH','f') else (n,)):
                raise ValueError('merged shape/dtype differs')
        offset=0
        for sid,key in enumerate(keys):
            receipt=R.A.read_unique_json(shards/f'{sid:03d}'/'manifest.json')
            if str(horizon) not in receipt['files']:continue
            entry=receipt['files'][str(horizon)];p=shards/f'{sid:03d}'/entry['name']
            if R.A.sha(p)!=entry['sha256']:raise ValueError('source shard changed during merge')
            with np.load(p,allow_pickle=False) as part:
                count=entry['rows']
                for name in R.A.FIELDS:
                    source=part[name];a=merged[name][offset:offset+count]
                    if source.tobytes(order='C')!=a.tobytes(order='C'):raise ValueError('canonical concatenation byte mismatch')
                    hashes[name].update(source.tobytes(order='C'))
                if not np.all(merged['sid'][offset:offset+count]==sid):raise ValueError('canonical SID order differs')
            offset+=count
        if offset!=n:raise ValueError('merged row total differs')
        for name,a in merged.items():
            if hashlib.sha256(a.tobytes(order='C')).hexdigest()!=hashes[name].hexdigest():raise ValueError('concatenation hash mismatch')
        outputs[str(horizon)]=dict(rows=n,sha256=R.A.sha(target),file_bytes=target.stat().st_size,
            canonical_field_sha256={k:h.hexdigest() for k,h in hashes.items()})
    return outputs


def run(scope_path,digest,out):
    out=Path(out);sidecar=out.with_name(out.name+'.merge-run.json')
    if out.exists() or sidecar.exists():raise FileExistsError('existing merge output/receipt; no implicit resume')
    scope=preflight(scope_path,digest);evidence=scope['evidence']
    if out.resolve().is_relative_to(Path(evidence['datasets']).resolve()):raise ValueError('merge output inside raw dataset checkout')
    if out.resolve().is_relative_to(Path(evidence['shards']).resolve()):raise ValueError('merge output inside input shards')
    generation_root=Path(evidence['manifest']['path']).resolve().parent
    if out.resolve().is_relative_to(generation_root):raise ValueError('merge output inside immutable generation directory')
    out.parent.mkdir(parents=True,exist_ok=True);bounds=scope['bounds'];start=time.monotonic();started=R.utc()
    R.budget(out.parent,dict(reserve_bytes=RESERVE),sum(bounds.values())+TEMPORARY)
    R.atomic_json(sidecar,dict(complete=False,status='started',started_at=started,scope_sha256=digest))
    hook,state=write_guard(out,bounds);sys.addaudithook(hook)
    try:
        metadata=R.A.merge_shards(evidence['shards'],out,evidence['canonical_keys'])
        if state['archive_open_checks']!=list(bounds):raise ValueError('archive write guards missing')
        if time.monotonic()-start>SECONDS:raise TimeoutError('merge elapsed budget exceeded')
        if {p.name for p in out.iterdir()}!=set(bounds)|{'rows-meta.json'}:raise ValueError('unexpected merge adapter output set')
        persisted_metadata=R.A.read_unique_json(out/'rows-meta.json')
        if persisted_metadata!=metadata:raise ValueError('persisted adapter metadata differs')
        outputs=verify_merge(evidence['shards'],out,evidence['canonical_keys'])
        if any(v['file_bytes']>bounds[f'rows-T{t}.npz'] for t,v in outputs.items()):raise RuntimeError('merged archive exceeded conservative bound')
        if metadata['series']!=evidence['canonical_keys'] or {t:v['rows'] for t,v in metadata['outputs'].items()}!=EXPECTED:
            raise ValueError('adapter metadata canonical rows differ')
        for horizon,value in outputs.items():
            if metadata['outputs'][horizon]!={'name':f'rows-T{horizon}.npz','rows':value['rows'],'sha256':value['sha256']}:
                raise ValueError('adapter metadata output identity differs')
        if time.monotonic()-start>SECONDS:raise TimeoutError('merge verification elapsed budget exceeded')
        provenance=dict(complete=True,started_at=started,ended_at=R.utc(),scope_sha256=digest,outputs=outputs,
            generation_scope_sha256=evidence['scope']['sha256'],generation_manifest_sha256=evidence['manifest']['sha256'],
            original_task_executed=False,neural_training=False,scoring=False,canonical_concatenation_verified=True,
            archive_open_checks=state['archive_open_checks'],conservative_output_bound=sum(bounds.values()),
            elapsed_seconds=time.monotonic()-start,resource_observation=rss_observation(),
            elapsed_scope='Merge and verification after pinned preflight; soft post-operation checks, not a hard timeout',
            interpretation=scope['interpretation'],adapter_metadata_warning='rows-meta generic D.task lineage describes retained field ancestry; this merge used projected generation shards')
        R.budget(out,dict(reserve_bytes=RESERVE),TEMPORARY)
        R.atomic_json(out/'merge-provenance.json',provenance)
        if {p.name for p in out.iterdir()}!=set(bounds)|{'rows-meta.json','merge-provenance.json'}:
            raise ValueError('unexpected final merge output set')
        R.atomic_json(sidecar,provenance)
        return provenance
    except BaseException as error:
        failure=dict(complete=False,status='error',started_at=started,ended_at=R.utc(),scope_sha256=digest,
            error_type=type(error).__name__,error=str(error).replace('\n',' ')[:320],
            elapsed_seconds=time.monotonic()-start,resource_observation=rss_observation(),
            recovery='Partial output preserved; no overwrite, retry or implicit resume')
        try:R.budget(out.parent,dict(reserve_bytes=RESERVE),10000);R.atomic_json(sidecar,failure)
        except BaseException:pass
        raise
    finally:state['active']=False


def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='command',required=True)
    freeze_parser=sub.add_parser('freeze');freeze_parser.add_argument('--request',required=True);freeze_parser.add_argument('--out',required=True)
    for name in ('run','verify'):
        p=sub.add_parser(name);p.add_argument('--scope',required=True);p.add_argument('--scope-sha256',required=True);p.add_argument('--out',required=True)
    args=parser.parse_args()
    if args.command=='freeze':result=freeze(args.request,args.out)
    elif args.command=='run':result=run(args.scope,args.scope_sha256,args.out)
    else:
        scope=preflight(args.scope,args.scope_sha256);result=verify_merge(scope['evidence']['shards'],args.out,scope['evidence']['canonical_keys'])
    print(json.dumps(result))


if __name__=='__main__':main()
