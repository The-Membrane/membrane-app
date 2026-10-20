"""Standalone zero-fit allocation acceptance: stdlib + NumPy + original independent checker.
Never imports Torch, recovery adapter, protocol, observer, or producer modules.
"""
from __future__ import annotations
import argparse
import ast
import importlib.metadata as md
import json
import math
import os
from pathlib import Path
import platform
import sys
import zipfile
import numpy as np

SOURCE_ROOT = Path(__file__).resolve().parent.parent / 'history-forecasts-continuation'
sys.path.insert(0, str(SOURCE_ROOT / 'scripts/research/history-forecasts'))
import r16_shallow_nn_independent as I
STATIC = ('lsH','lsf','dm','wm','r24','r168','r720','dd720','rng24','lvol','btc_r24','btc_dm')
LIMITS = ('Independently reconstructs canonical core membership and checks recorded allocation shapes; '
          'does not independently recompute historical feature values, observe constructor execution, '
          'verify training/gradients/weights, establish forecast skill, or restore lost historical receipts.')

def require(ok, message):
    if not ok: raise ValueError(message)

def pin(path):
    p = Path(path)
    return dict(path=str(p.resolve()),size=p.stat().st_size,sha256=I.sha(p))

def canonical(name):
    return name.lower().replace('_','-').replace('.','-')

def no_symlink(path):
    p = Path(path).absolute()
    require(not any(x.is_symlink() for x in (p,*p.parents)), 'symlink in path: '+str(p))

def certificate(scope, pins):
    attached = scope['operational_recovery']; pins.walk(attached)
    value = I.load(attached['path'])
    require(value.get('schema')=='r16-shallow-operational-certificate-v1' and value.get('stage')=='allocation', 'allocation certificate required')
    require(value.get('root')==str(SOURCE_ROOT), 'certificate source root differs')
    require(value.get('scientific_scope')=='seen-development-original-recipe-no-promotion', 'scientific scope differs')
    require(value['experiment_request']==scope['request'], 'certificate request binding differs')
    declaration = I.load(value['request']['path'])
    require(declaration.get('stage')=='allocation' and declaration.get('experiment_request')==scope['request'] and declaration.get('predecessor')==value['predecessor'], 'certificate declaration differs')
    require(len(value['original_sources'])==32, 'original 32-source packet required')
    anchors={'manifest':'609078248a692e286b9cca26c14c46aeffe8370e628046d825e64d52e45c8cc9','portability':'f8f360d8a83828ff73ee9d074328d9a845505f58b0ce2a9d0c947883c38337d0'}
    for name,entry in value['published_anchors'].items():
        require(name in anchors and entry['sha256']==anchors[name], 'published anchor identity differs')
        pins.check(dict(path=entry['path'],size=entry['bytes'],sha256=entry['sha256']))
    require(set(value['published_anchors'])==set(anchors), 'published anchors missing')
    published=I.load(value['published_anchors']['manifest']['path'])
    require(value['original_sources']==published['immutableSourcePins'], 'source packet differs from published immutable source pins')
    cursor=value
    for expected_stage in ('allocation','merge','generation'):
        require(cursor['schema']=='r16-shallow-operational-certificate-v1' and cursor['stage']==expected_stage, 'certificate stage ancestry differs')
        require(cursor['root']==value['root'] and cursor['adapter']==value['adapter'] and cursor['original_sources']==value['original_sources'] and cursor['published_anchors']==value['published_anchors'], 'certificate ancestry identity differs')
        declaration=I.load(cursor['request']['path'])
        require(declaration['stage']==expected_stage and declaration['experiment_request']==cursor['experiment_request'] and declaration['predecessor']==cursor['predecessor'], 'certificate ancestor declaration differs')
        if expected_stage=='generation':require(cursor['predecessor'] is None, 'fresh chain must start at generation')
        else:cursor=I.load(cursor['predecessor']['path'])
    for relative, entry in value['original_sources'].items():
        p = SOURCE_ROOT / relative
        require(p.resolve().is_relative_to(SOURCE_ROOT) and p.stat().st_size==entry['bytes'] and I.sha(p)==entry['sha256'], 'certificate original source differs: '+relative)
        pins.sources[str(p.resolve())]=entry['sha256']
    require(all(value['original_sources'][name]['sha256']==digest for name,digest in scope['source_sha256'].items()), 'scope/certificate scientific source differs')
    pins.walk(value['adapter'])
    require(Path(value['adapter']['path']).resolve()==SOURCE_ROOT/'scripts/research/history-forecasts/r16_shallow_recovery.py', 'adapter path differs')
    return value, attached

def runtime(scope, pins):
    current = sorted([d.metadata['Name'].lower(),d.version] for d in md.distributions() if d.metadata.get('Name'))
    base = scope['runtime']['base']
    require(base['packages']==current and base['executable']==sys.executable and base['python']==sys.version and base['machine']==platform.machine(), 'current runtime package/Python identity differs')
    require(scope['runtime']['prefix']==sys.prefix and scope['runtime']['base_prefix']==sys.base_prefix, 'current runtime prefix differs')
    require(scope['runtime']['python_flags']==dict(no_user_site=sys.flags.no_user_site,isolated=sys.flags.isolated), 'current Python flags differ')
    require(scope['runtime']['torch_threads']==1 and scope['runtime']['torch_interop_threads']==8 and scope['runtime']['default_device']=='cpu' and scope['runtime']['default_dtype']=='torch.float32', 'recorded Torch operating state differs')
    require(all(v=='1' for v in base['threads'].values()), 'recorded native thread controls differ')
    probe = I.load(scope['runtime_probe']['path'])
    require(probe.get('complete') is True and probe.get('optimizer_steps')==0 and probe.get('historical_inputs') is False, 'fresh zero-optimizer probe required')
    require(probe['current_runtime']==scope['runtime'] and probe['numpy_version']==np.__version__ and probe['executable']==sys.executable, 'probe current runtime identity differs')
    actual_versions={canonical(d.metadata['Name']):d.version for d in md.distributions() if d.metadata.get('Name')}
    require(probe['inventory']==actual_versions and len(actual_versions)==30, 'exact thirty-version inventory differs')
    for entry in list(probe['record_pins'].values())+probe['native_pins']:
        normalized=dict(path=entry['path'],size=entry.get('size',entry.get('bytes')),sha256=entry['sha256']);pins.check(normalized)
    fixture = I.load(scope['observer_fixture']['path'])
    require(fixture.get('complete') is True and fixture.get('tests_run')==9 and all(fixture.get(k)==0 for k in ('skipped','errors','failures')) and fixture.get('historical_inputs') is False, 'fresh nine-fixture evidence required')
    require(fixture['runtime']==scope['runtime'] and fixture['probe_sha256']==scope['runtime_probe']['sha256'], 'fixture runtime/probe differs')
    names=('r16_shallow_nn_observer.py','r16_shallow_nn_protocol.py','r16_shallow_nn_runner.py','r16_shallow_nn_monitor.py','test_r16_shallow_nn_observer.py')
    expected={str(Path('scripts/research/history-forecasts')/n):I.sha(SOURCE_ROOT/'scripts/research/history-forecasts'/n) for n in names}
    require(fixture['source_sha256']==expected, 'fixture source identity differs')
    tree=ast.parse((SOURCE_ROOT/'scripts/research/history-forecasts/test_r16_shallow_nn_observer.py').read_text())
    ids=[f'test_r16_shallow_nn_observer.{c.name}.{name}' for c in sorted((n for n in tree.body if isinstance(n,ast.ClassDef)),key=lambda n:n.name) for name in sorted(n.name for n in c.body if isinstance(n,ast.FunctionDef) and n.name.startswith('test_'))]
    require(fixture['ordered_test_ids']==ids and len(ids)==9, 'fixture test IDs differ')
    require(not any(k=='torch' or k.startswith('torch.') for k in sys.modules), 'independent checker imported Torch')

def first_cell(R, keys):
    g=I.groups(keys,R['sid']); split=I.split_time(R['ts'])
    tr_all=np.where((g%2!=0)&(R['ts']>=split+43200))[0]
    require(len(tr_all)>0, 'empty first-cell train support')
    low=np.min(g[tr_all]);va=tr_all[g[tr_all]==low];tr=tr_all[g[tr_all]!=low]
    rng=np.random.default_rng(20261903)
    if len(tr)>60000:tr=rng.choice(tr,60000,replace=False)
    tr_full=tr
    if len(va)>60000:va=rng.choice(va,60000,replace=False)
    te=np.where((g%2==0)&(R['ts']<split)&(R['ts']%86400==0))[0]
    arrays=dict(tr_all=tr_all,tr_full=tr_full,tr=tr_full[:60000],va=va,te=te)
    return split,{k:I.membership(ix,R,g) for k,ix in arrays.items()}

def npz_headers(path):
    result={}
    with zipfile.ZipFile(path) as z:
        require(len(z.namelist())==len(set(z.namelist())), 'duplicate NPZ members')
        for name in z.namelist():
            require(name.endswith('.npy') and '/' not in name, 'unexpected NPZ member')
            with z.open(name) as f:
                version=np.lib.format.read_magic(f)
                if version==(1,0):shape,fortran,dtype=np.lib.format.read_array_header_1_0(f)
                elif version==(2,0):shape,fortran,dtype=np.lib.format.read_array_header_2_0(f)
                else:raise ValueError('unsupported NPY header version')
            result[name[:-4]]=(shape,dtype)
    return result

def allocation_shapes(actual, base):
    n=sum(I.COUNTS.values())
    require(actual['allocated_prediction_matrices']=={m:dict(shape=[n,5],dtype='<f4',nbytes=n*5*4) for m in I.MODELS}, 'five prediction matrix allocation shapes differ')
    expected={}
    for name,dtype,width in [('sid','<i4',1),('ts','<i8',1),('T','<i4',1),('Tidx','<i4',1),('Y','|i1',5),('LF','<f4',5)]:
        expected[name]=dict(shape=[n] if width==1 else [n,width],dtype=dtype,nbytes=n*np.dtype(dtype).itemsize*width)
    headers={T:npz_headers(Path(base)/f'rows-T{T}.npz') for T in I.HORIZONS}
    for name in STATIC:
        types=[]
        for T in I.HORIZONS:
            shape,dtype=headers[T][name];require(shape==(I.COUNTS[T],) and not dtype.hasobject, 'source static field shape/dtype differs');types.append(dtype)
        dtype=np.result_type(*types)
        expected[name]=dict(shape=[n],dtype=dtype.str,nbytes=n*dtype.itemsize)
    require(actual['pooled_fields']==expected, 'pooled field allocation shapes differ')
    require(I.integer(actual['historical_feature_bytes']) and actual['historical_feature_bytes']>0, 'historical feature allocation telemetry invalid')
    return expected

def receipt_evidence_pins(entries, metadata_anchors):
    """Preserve checked historical metadata without reopening its unavailable old payload graph.
    Fresh operational/input/runtime pins retain the original checker's recursive size schema.
    """
    paths={str(Path(p['path']).resolve()) for p in metadata_anchors.values()}
    result=[]
    for entry in sorted(entries.values(),key=lambda p:p['path']):
        value=dict(entry)
        if value['path'] in paths:value['bytes']=value.pop('size')
        result.append(value)
    return result

def verify(scope_path,digest,out,receipt):
    scope_path=Path(scope_path).resolve();out=Path(out).resolve();receipt=Path(receipt).absolute()
    require(not receipt.exists() and not receipt.is_symlink(), 'receipt already exists')
    require(I.sha(scope_path)==digest, 'scope digest differs')
    scope=I.load(scope_path);require(scope['schema']=='r16-shallow-original-nn-v1' and scope['phase']=='allocation' and scope['out']==str(out), 'allocation scope/output required')
    require(scope['original_recipe']==dict(seed=20261903,models=list(I.MODELS),tiers='shallow',threads=1), 'original shallow recipe differs')
    require(len(scope['evidence']['canonical_keys'])==277 and len(scope['evidence']['raw_pins'])==282, 'original 277-series/282-input scope required')
    require(I.ROOT==SOURCE_ROOT, 'original independent checker source root differs')
    pins=I.Pins(scope['evidence']['datasets']);pins.check(pin(scope_path));pins.walk(scope)
    cert,cert_pin=certificate(scope,pins);runtime(scope,pins)
    monitor=pins.snapshot(out/'monitor.json');child=pins.snapshot(out/'child.json');actual=pins.snapshot(out/'allocation.json');start=pins.snapshot(out/'monitor-start.json');audit=pins.snapshot(out/'audit.json');links=pins.snapshot(out/'links.json')
    I.monitor_admission(monitor,start,'allocation',digest)
    require(child.get('complete') is True and child.get('scope_sha256')==digest and child.get('phase')=='allocation' and child.get('allocation_only') is True and I.integer(child.get('neural_fits')) and child['neural_fits']==0, 'successful zero-fit allocation child required')
    require(monitor['child_receipt']==pin(out/'child.json'), 'monitor child receipt differs')
    policy=scope['resource_policy'];require(policy==dict(rss_bytes=2500000000,wall_seconds=28800,grace_seconds=30), 'resource policy differs')
    require(monitor['elapsed_seconds']<=policy['wall_seconds'] and monitor['peak_sampled_child_rss_bytes']<=policy['rss_bytes'], 'observed resource cap exceeded')
    command=[sys.executable,cert['adapter']['path'],'invoke','--certificate',cert_pin['path'],'--certificate-sha256',cert_pin['sha256'],'--family','nn','--','_child','--scope',str(scope_path),'--scope-sha256',digest,'--out',str(out)]
    require(start['command']==command, 'actual child adapter argv differs')
    clean={'total':0,'attempts':[]}
    require(child['audit_violations']==clean and audit['violations']==clean, 'persistent audit denied attempt')
    require(audit['opened_raw_inputs']==child['opened_raw_inputs'] and set(child['opened_raw_inputs'])<={p['path'] for p in scope['evidence']['raw_pins']}, 'raw read ledger differs/unapproved')
    require(set(links)==set(I.INPUTS) and set(scope['evidence']['inputs'])==set(I.INPUTS), 'five exact hardlink inputs required')
    for name,p in scope['evidence']['inputs'].items():
        source=Path(p['path']);dest=out/name;no_symlink(source);no_symlink(dest);a=source.stat();b=dest.stat();proof=links[name]
        require((a.st_dev,a.st_ino)==(b.st_dev,b.st_ino)==(proof['device'],proof['inode']) and a.st_nlink>=2 and b.st_nlink>=2, 'hardlink inode/device differs')
        require(a.st_size==b.st_size==p['size']==proof['size'] and I.sha(dest)==p['sha256']==proof['sha256'] and proof['source']==str(source) and proof['destination']==str(dest) and proof['incremental_payload_bytes']==0, 'hardlink payload receipt differs')
    forbidden=[p.name for p in out.iterdir() if p.name.startswith('fit-') or p.name.startswith('rows-nn-') or p.name in ('nn-meta.json','score.json','dev-r162-nn.json','coverage.json','score-audit.json','score-monitor.json')]
    require(not forbidden, 'allocation contains fit/score artifacts: '+repr(forbidden))
    require(actual.get('status')=='allocation-only-before-first-make_model' and I.integer(actual.get('neural_fits')) and actual['neural_fits']==0 and actual.get('completed') is False and actual.get('scope_sha256')==digest, 'allocation before-constructor stop differs')
    meta=I.load(out/'rows-meta.json');keys=meta['series'];require(keys==scope['evidence']['canonical_keys'], 'canonical metadata series differ');R=I.core_rows(out);split,member=first_cell(R,keys)
    require(actual['first_membership']==dict(ordinal=0,cell=[0,0],model='nmlp',tsplit_float=split,membership=member), 'independent first-cell membership differs')
    fields=allocation_shapes(actual,out)
    source=SOURCE_ROOT/'scripts/research/history-forecasts/r16_nn.py';lines=source.read_text().splitlines();before=[i+1 for i,line in enumerate(lines) if line.strip()=='net = make_model(m, len(STATIC) + 2 + nT, L)']
    require(len(before)==1, 'original before-constructor trace anchor differs')
    pins.recheck();require(not any(k=='torch' or k.startswith('torch.') for k in sys.modules), 'independent verifier imported Torch')
    result=dict(schema='q26-fresh-allocation-independent-v1',complete=True,scope_sha256=digest,source_pins_verified=len(scope['source_sha256']),neural_fits=0,first_model_constructed=False,audit_violations=0,hardlink_inputs_verified=5,monitor_sha256=I.sha(out/'monitor.json'),child_sha256=I.sha(out/'child.json'),allocation_sha256=I.sha(out/'allocation.json'),first_cell_membership_verified=member,tsplit_float=split,pooled_fields_verified=fields,prediction_matrix_shapes_verified=True,original_before_constructor_line=before[0],checker=pin(__file__),original_independent_checker=pin(I.__file__),certificate=cert_pin,evidence_pins=receipt_evidence_pins(pins.entries,cert['published_anchors']),limitations=LIMITS,historical_feature_bytes_telemetry=actual['historical_feature_bytes'],numpy_version=np.__version__,runtime_executable=sys.executable)
    receipt.parent.mkdir(parents=True,exist_ok=True)
    with receipt.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--scope',required=True);p.add_argument('--scope-sha256',required=True);p.add_argument('--out-dir',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
    value=verify(a.scope,a.scope_sha256,a.out_dir,a.receipt);print(json.dumps(dict(complete=value['complete'],receipt=pin(a.receipt),source_pins_verified=value['source_pins_verified'],neural_fits=0)))
if __name__=='__main__':main()
