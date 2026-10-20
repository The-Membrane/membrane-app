"""Canonical projected rows only; accepted five-series parity is a frozen prerequisite."""
from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import time
import r16_shallow_reconstruction_runner as R
import r16_shallow_projection as P
import r16_shallow_projection_parity as S

SCHEMA='r16-shallow-projected-generation-v1'
PARITY_SCOPE_SHA='e56dfd9301f4cc5a347d4d24680bcabfad3a483f82d75ee895dc5c676ca02d05'
PARITY_MANIFEST_SHA='8204b1fd940ad998c8d01c0b03e41a8ac48eacb1a7d96e58a19a99ca50b1d830'
EXPECTED_ROWS={'1':1424924,'3':1424353,'12':1422858}
POLICY=dict(reserve_bytes=2_000_000_000,max_shards_bytes=420106366,max_shard_bytes=50_000_000,temporary_reserve_bytes=50_000_000)
SECONDS=3600


def sources():
    pins=S.parity_sources()
    for name in ('r16_shallow_projected_generation.py','test_r16_shallow_projected_generation.py'):
        p=R.HERE/name;pins[str(p.relative_to(R.ROOT))]=R.A.sha(p)
    return pins


def accepted_proof(request):
    scope_path=Path(request['parity_scope_path']);manifest_path=Path(request['parity_manifest_path'])
    if R.A.sha(scope_path)!=PARITY_SCOPE_SHA or R.A.sha(manifest_path)!=PARITY_MANIFEST_SHA:
        raise ValueError('accepted parity scope/manifest changed')
    old=R.A.read_unique_json(scope_path);manifest=R.A.read_unique_json(manifest_path)
    if old['source_sha256']!=S.parity_sources():raise ValueError('accepted source closure changed')
    if not manifest.get('complete') or not manifest.get('all_five_exact') or manifest.get('child_calls')!=10:
        raise ValueError('accepted parity completion missing')
    independent_path=Path(request['parity_independent_path']);independent=R.A.read_unique_json(independent_path)
    expected=dict(complete=True,descriptor_pairs=255,distinct_child_pids=10,input_pins=282,source_pins=21,scope_sha256=PARITY_SCOPE_SHA)
    if any(independent.get(k)!=v for k,v in expected.items()):raise ValueError('independent parity evidence incomplete')
    if [(p['sid'],p['key']) for p in independent['pairs']]!=list(S.SELECTED.items()):raise ValueError('independent identities differ')
    references={};projections={}
    for sid,key in S.SELECTED.items():
        pair={}
        for arm in ('original','projection'):
            path=manifest_path.parent/f'{arm}-{sid:03d}.json';value=R.A.read_unique_json(path)
            S.validate_receipt(value,sid,arm,old,PARITY_SCOPE_SHA);pair[arm]=value
            (references if arm=='original' else projections)[str(sid)]=R.pin(path)
        S.compare(pair['original'],pair['projection'])
        rows={T:v['fields']['ts']['shape'][0] for T,v in pair['original']['descriptors'].items()}
        entry=next(p for p in independent['pairs'] if p['sid']==sid)
        if entry['rows']!=rows:raise ValueError('independent parity row counts differ')
    return old,dict(scope=R.pin(scope_path),manifest=R.pin(manifest_path),independent=R.pin(independent_path),
        references=references,projections=projections)



def same_recipe(base,old):
    previous=old['base_scope']
    for key in ('datasets','dataset_commit','canonical_keys','runtime','price_inputs','auxiliary_inputs','summary','price_manifest','producer_task_ast_sha256'):
        if base[key]!=previous[key]:raise ValueError('generation differs from accepted parity: '+key)
    if base['disk_policy']!=POLICY:raise ValueError('exact frozen disk policy required')
    if any(v!='1' for v in base['runtime']['threads'].values()):raise ValueError('single-thread runtime required')


def freeze(request_path,out):
    out=Path(out)
    if out.exists():raise FileExistsError('generation scope exists')
    request=R.A.read_unique_json(request_path);old,proof=accepted_proof(request)
    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='projected-freeze-',dir=out.parent) as temp:
        path=Path(temp)/'base.json';R.freeze(request_path,path);base=R.A.read_unique_json(path)
    same_recipe(base,old)
    scope=dict(schema=SCHEMA,created_at=R.utc(),base_scope=base,proof=proof,source_sha256=sources(),
        expected_rows=EXPECTED_ROWS,series=277,seconds=SECONDS,
        context='One BTC initialization; sequential canonical P.task calls; unchanged keyed CHAIN cache and per-horizon cache clearing',
        limitations='Five on-path sentinels do not prove every historical array; global totals verify support size, not forecasting skill or forward validity')
    R.atomic_json(out,scope);return dict(scope_path=str(out.resolve()),scope_sha256=R.A.sha(out))


def preflight(scope_path,digest):
    if R.A.sha(scope_path)!=digest:raise ValueError('frozen generation SHA changed')
    scope=R.A.read_unique_json(scope_path)
    if scope.get('schema')!=SCHEMA or scope['source_sha256']!=sources():raise ValueError('generation source/schema differs')
    if scope['expected_rows']!=EXPECTED_ROWS or scope['series']!=277 or scope['seconds']!=3600:raise ValueError('fixed generation target differs')
    proof=scope['proof']
    for k in ('scope','manifest','independent'):R.check_pin(proof[k])
    for group in ('references','projections'):
        if set(proof[group])!={str(sid) for sid in S.SELECTED}:raise ValueError('five receipt pins required per arm')
        for pin in proof[group].values():R.check_pin(pin)
    old=R.A.read_unique_json(proof['scope']['path'])
    if proof['scope']['sha256']!=PARITY_SCOPE_SHA or proof['manifest']['sha256']!=PARITY_MANIFEST_SHA:
        raise ValueError('unaccepted parity proof')
    if old['source_sha256']!=S.parity_sources():raise ValueError('previously compared source files changed')
    base=scope['base_scope'];same_recipe(base,old)
    # Fresh base was frozen at the generation commit; never call preflight on old HEAD.
    specs=R.preflight(base)
    if len(specs)!=277:raise ValueError('exact277 original canonical series required')
    return scope,specs


def write_receipt(path,value,policy):
    n=len((json.dumps(value,indent=2,allow_nan=False)+'\n').encode())
    R.budget(Path(path).parent,policy,n);R.atomic_json(path,value)


def check_deadline(start):
    if time.monotonic()-start>SECONDS:raise TimeoutError('projected generation elapsed budget exceeded')


def run(scope_path,digest,out):
    start=time.monotonic();out=Path(out)
    if out.exists():raise FileExistsError('output exists; no overwrite, retry or implicit resume')
    scope,specs=preflight(scope_path,digest);base=scope['base_scope'];policy=base['disk_policy']
    if out.resolve().is_relative_to(Path(base['datasets']).resolve()):raise ValueError('derived output must be outside raw dataset checkout')
    out.parent.mkdir(parents=True,exist_ok=True)
    R.budget(out.parent,policy,policy['max_shards_bytes']+policy['temporary_reserve_bytes'])
    out.mkdir();started=R.utc();completed=[];bound=0;totals={k:0 for k in EXPECTED_ROWS};sentinels=[];stage='initialize'
    write_receipt(out/'run.json',dict(status='started',started_at=started,scope_sha256=digest),policy)
    allowed=[p['path'] for p in base['price_inputs']+base['auxiliary_inputs']]+[base[k]['path'] for k in ('summary','price_manifest')]
    hook,reads,violations=S.read_audit(base['datasets'],allowed);sys.addaudithook(hook)
    def clean():
        if violations['total']:raise S.AuditViolation('persistent denied input attempt prevents generation')
    try:
        check_deadline(start);clean()
        if R.A.D._BTC or R.A.D.R12._CHAIN:raise RuntimeError('generation must begin with fresh BTC/CHAIN cache')
        R.A.D.init_btc(base['datasets']);clean()
        mapping={k:i for i,k in enumerate(base['canonical_keys'])};shards=out/'shards'
        for sid,spec in enumerate(specs):
            stage=f'task SID{sid}';check_deadline(start);clean()
            R.budget(out,policy,policy['max_shards_bytes']-bound+policy['temporary_reserve_bytes'])
            result=P.task(spec);check_deadline(start);clean()
            if result['key']!=base['canonical_keys'][sid]:raise ValueError('projected producer key differs')
            rows=R.A.retain_series_rows(result,mapping)
            for T,r in rows.items():totals[str(T)]+=len(r['ts'])
            if any(totals[k]>EXPECTED_ROWS[k] for k in totals):raise ValueError('row totals exceed original support')
            if sid in S.SELECTED:
                stage=f'context sentinel SID{sid}'
                reference=R.A.read_unique_json(scope['proof']['references'][str(sid)]['path'])
                if S.describe_rows(rows)!=reference['descriptors']:raise ValueError('on-path original context sentinel differs')
                sentinels.append(dict(sid=sid,key=spec['key'],exact=True))
            estimate=R.shard_write_bound(rows,result,sid)
            if estimate>policy['max_shard_bytes'] or bound+estimate>policy['max_shards_bytes']:raise RuntimeError('conservative shard bound exceeds frozen cap')
            stage=f'write SID{sid}';clean();R.budget(out,policy,estimate+policy['temporary_reserve_bytes'])
            receipt=R.A.write_series_shard(shards,result,mapping);directory=shards/f'{sid:03d}'
            actual=sum(p.stat().st_size for p in directory.iterdir())
            if actual>estimate:raise RuntimeError('actual shard bytes exceed proven bound')
            bound+=estimate
            completed.append(dict(sid=sid,key=spec['key'],files=receipt['files'],manifest_sha256=R.A.sha(directory/'manifest.json'),
                actual_file_bytes=actual,write_bound_bytes=estimate))
            write_receipt(out/'progress.json',dict(status='running',completed_series=len(completed),row_totals=totals,
                sentinels=sentinels,stage=stage,at=R.utc()),policy)
            del rows,result
        stage='completion gates';check_deadline(start);clean()
        if len(completed)!=277 or totals!=EXPECTED_ROWS or [s['sid'] for s in sentinels]!=list(S.SELECTED):
            raise ValueError('277-series, three row-total or five-sentinel completion gate failed')
        final=dict(complete=True,status='complete',started_at=started,ended_at=R.utc(),scope_sha256=digest,series=277,
            row_totals=totals,sentinels=sentinels,shards=completed,write_bound_bytes=bound,
            actual_file_bytes=sum(c['actual_file_bytes'] for c in completed),audit_violations=violations,
            opened_inputs=dict(sorted(reads.items())),merged=False,neural_training=False,
            interpretation=scope['limitations'],free_bytes_after=R.budget(out,policy,0))
        write_receipt(out/'run.json',final,policy);check_deadline(start);clean();write_receipt(out/'manifest.json',final,policy)
        return final
    except BaseException as error:
        failure=dict(complete=False,status='error',started_at=started,ended_at=R.utc(),stage=stage,
            completed_series=len(completed),row_totals=totals,sentinels=sentinels,audit_violations=violations,
            opened_inputs=dict(sorted(reads.items())),error_type=type(error).__name__,error=S.safe_message(error),
            recovery='Completed and partial shards preserved; no automatic restart or resume')
        try:write_receipt(out/'run.json',failure,policy)
        except BaseException:pass  # Preserve original failure and existing start/progress if disk cannot hold error receipt.
        raise


def main():
    import argparse
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    f=sub.add_parser('freeze');f.add_argument('--request',required=True);f.add_argument('--out',required=True)
    r=sub.add_parser('run');r.add_argument('--scope',required=True);r.add_argument('--scope-sha256',required=True);r.add_argument('--out',required=True)
    a=p.parse_args();value=freeze(a.request,a.out) if a.command=='freeze' else run(a.scope,a.scope_sha256,a.out)
    print(json.dumps(value if a.command=='freeze' else {k:value[k] for k in ('complete','series','row_totals','started_at','ended_at')}))


if __name__=='__main__':main()
