"""Independent saved-output gate for retained O33 probability replay.

No producer, simulator, optimizer or numerical helper is imported. Saved replay
parity cannot establish original state identity or unseen predictive skill.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import sys

PIN = 'f9389b68ee1a4a94417a9311bc42dc974b4613fd'
CONSTANTS = dict(paths=1000, origin_every=28, horizons=[24,72,168,720],
    expected_series=42, expected_quarters=806, expected_origins=2619, expected_rows=104310)
SCHEMA = 'q26-r164-baseline-replay-manifest-v1'

def require(condition, message):
    if not condition:
        raise ValueError(message)

def integer(value):
    require(type(value) is int, 'native integer required')
    return value

def probability(value):
    require(type(value) is float and math.isfinite(value) and 0 <= value <= 1,
            'finite native float probability required')
    return value

def digest(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), 'regular nonsymlink file required')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024*1024):
            h.update(block)
    return h.hexdigest()

def unique_object(pairs):
    result = {}
    for key,value in pairs:
        require(key not in result, 'duplicate JSON object key')
        result[key] = value
    return result

def read_json(path, expected):
    require(digest(path) == expected, 'file hash mismatch: '+str(path))
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_object)

def runtime_identity():
    return dict(python=sys.version, executable=sys.executable, machine=platform.machine(),
        platform=platform.platform(), dependencies={n:importlib.metadata.version(n)
        for n in ('numpy','scipy','numba','llvmlite')})

def record(item):
    require(type(item) is dict and set(item)=={'path','sha256','size'}, 'file record fields')
    require(type(item['path']) is str and Path(item['path']).is_absolute(), 'absolute input path required')
    path = Path(item['path'])
    require(type(item['sha256']) is str and len(item['sha256'])==64 and
        all(c in '0123456789abcdef' for c in item['sha256']), 'SHA256 required')
    require(integer(item['size']) >= 0 and path.stat().st_size==item['size'], 'file size mismatch')
    require(digest(path)==item['sha256'], 'file record hash mismatch')
    return str(path)

def inventory(root, names):
    root=Path(root)
    require(root.is_dir() and not root.is_symlink(), 'regular directory required')
    require({p.name for p in root.iterdir()}==set(names), 'directory inventory mismatch')
    require(all(p.is_file() and not p.is_symlink() for p in root.iterdir()), 'regular file inventory required')

def row_key(row,key):
    require(row['series']==key, 'row series identity')
    origin,horizon,depth=(integer(row[k]) for k in ('i0','T','k'))
    require(origin>=0 and horizon in CONSTANTS['horizons'] and depth>=0, 'row origin/horizon/depth')
    return key,origin,horizon,depth

def check_series(key,replay,historical,state):
    require(set(replay)=={'series','rows'} and replay['series']==key, 'replay series fields/identity')
    require(historical['series']==key, 'historical series identity')
    require(state['series']==key and state['complete'] is True, 'accepted state series identity')
    require(type(replay['rows']) is list and type(historical['rows']) is list and replay['rows']
        and len(replay['rows'])==len(historical['rows']), 'exact row count')
    seen,origins=set(),set()
    for new,old in zip(replay['rows'],historical['rows']):
        require(set(new)=={'series','i0','T','k','p_replay'}, 'replay row fields')
        old_identity=dict(old)
        old_identity.setdefault('series',key)
        identity=row_key(new,key)
        require(identity==row_key(old_identity,key), 'exact original row identity/order')
        require(identity not in seen, 'duplicate row key')
        seen.add(identity)
        origins.add(identity[1])
        require(probability(new['p_replay'])==probability(old['p_garch']), 'exact native-float probability parity')
    require([integer(s['origin']) for s in state['origins']]==sorted(origins), 'state origin coverage/order')
    quarters=[integer(q['quarter']) for q in state['quarters']]
    require(quarters and quarters==sorted(set(quarters)), 'state quarter coverage/order')
    require({integer(s['quarter']) for s in state['origins']}==set(quarters), 'origin/quarter coverage')
    require(integer(historical['quarter_fits'])==len(quarters), 'historical quarter count')
    require(all(s['quarter']<=s['origin'] for s in state['origins']), 'state quarter after origin')
    return dict(quarters=len(quarters),origins=len(origins),historical_rows=len(seen))

def check(plan_path,output_dir,plan_sha256,manifest_sha256):
    plan_path,output_dir=Path(plan_path),Path(output_dir)
    plan=read_json(plan_path,plan_sha256)
    require(set(plan)=={'schema','authorities','files','source_commit','runtime','constants','output_dir'}, 'plan fields')
    require(plan['schema']=='q26-r164-baseline-replay-plan-v1' and plan['constants']==CONSTANTS, 'fixed replay constants')
    require(plan['runtime']==runtime_identity(), 'runtime identity')
    require(Path(plan['output_dir']).is_absolute() and Path(plan['output_dir']).resolve()==output_dir.resolve(), 'bound output root')
    require(type(plan['source_commit']) is str and len(plan['source_commit'])==40 and
        all(c in '0123456789abcdef' for c in plan['source_commit']), 'source commit identity')
    require(type(plan['files']) is list and plan['files'], 'file closure')
    pins={}
    for item in plan['files']:
        path=record(item)
        require(path not in pins, 'duplicate input pin')
        pins[path]=item
    require(str(Path(__file__).resolve()) in pins, 'executing checker source pin required')
    require(str(Path(__file__).resolve().with_name('r164_baseline_replay.py')) in pins,
            'sibling replay producer source pin required')
    authorities=plan['authorities']
    require(set(authorities)=={'state_plan','state_manifest','state_acceptance','original_config'}, 'authority set')
    decoded={}
    for name,item in authorities.items():
        path=record(item)
        require(pins.get(path)==item, 'authority missing from closure')
        decoded[name]=read_json(path,item['sha256'])
    sp,sm,sa=decoded['state_plan'],decoded['state_manifest'],decoded['state_acceptance']
    require(sp['pin']==PIN and sp['horizons']==CONSTANTS['horizons'], 'state scientific authority')
    require(sp['runtime']==plan['runtime'], 'state runtime authority')
    for path,expected in sp['files'].items():
        require(path in pins and pins[path]['sha256']==expected, 'state input/source closure')
    require(sm['complete'] is True and sm['plan']==sp and sm['plan_sha256']==authorities['state_plan']['sha256'], 'state manifest plan binding')
    require(sa['complete'] is True and sa['plan_sha256']==authorities['state_plan']['sha256'] and
        sa['manifest_sha256']==authorities['state_manifest']['sha256'], 'state acceptance binding')
    targets=dict(series=42,quarters=806,origins=2619,historical_rows=104310)
    require(all(integer(sa[k])==v for k,v in targets.items()), 'accepted state support')
    require(integer(sm['n_quarters'])==806 and integer(sm['n_origins'])==2619, 'state manifest support')
    config=decoded['original_config']['config']
    require(integer(config['paths'])==1000 and integer(config['origin_every'])==28, 'original configuration')
    manifest_path=output_dir/'manifest.json'
    manifest=read_json(manifest_path,manifest_sha256)
    require(set(manifest)=={'schema','complete','plan_sha256','series','quarters','origins','historical_rows','series_files','started_file'}, 'manifest fields')
    require(manifest['schema']==SCHEMA and manifest['complete'] is True and manifest['plan_sha256']==plan_sha256, 'bound replay manifest')
    entries=manifest['series_files']
    require(type(entries) is list and len(entries)==42, '42 replay series required')
    keys=[e['series'] for e in entries]
    require(all(type(k) is str and k.startswith('blind5:') for k in keys) and keys==sorted(set(keys)), 'series inventory/order')
    require(config['pin']=='f9389b6' and config['collection']=='blind5-prices' and config['selected_series']==keys, 'original selected series/source')
    require(set(config['inputs'])==set(keys), 'original input inventory')
    for name,expected in config['sources'].items():
        matches=[r for p,r in pins.items() if Path(p).name==name]
        require(len(matches)==1 and matches[0]['sha256']==expected, 'original source binding')
    state_outputs=sm['output_sha256']
    require(set(state_outputs)=={k.replace(':','-')+'.json' for k in keys}, 'state/replay series support')
    state_root=Path(authorities['state_manifest']['path']).parent
    historical_root=Path(sp['historical'])
    raw_root=Path(sp['datasets'])/'blind5-prices'
    raw_names={Path(p).name for p in pins if Path(p).parent==raw_root}
    require(len(raw_names)==42, '42 authenticated raw inputs required')
    inventory(raw_root,raw_names)
    inventory(state_root,set(state_outputs)|{'manifest.json'})
    inventory(historical_root,state_outputs)
    names=[]
    totals=dict(series=42,quarters=0,origins=0,historical_rows=0)
    for entry in entries:
        require(set(entry)=={'series','path','sha256','size'}, 'series record fields')
        key,name=entry['series'],entry['path']
        require(type(name) is str and Path(name).name==name and name==key.replace(':','-')+'.json', 'safe exact output filename')
        names.append(name)
        record(dict(path=str(output_dir/name),sha256=entry['sha256'],size=entry['size']))
        replay=read_json(output_dir/name,entry['sha256'])
        state_path,old_path=state_root/name,historical_root/name
        require(str(state_path) in pins and pins[str(state_path)]['sha256']==state_outputs[name], 'saved state pin')
        require(str(old_path) in pins, 'historical row pin')
        state=read_json(state_path,state_outputs[name])
        require(state['historical_checkpoint_sha256']==pins[str(old_path)]['sha256'], 'state historical binding')
        old=read_json(old_path,pins[str(old_path)]['sha256'])['result']
        npz=Path(sp['datasets'])/'history-forecasts/r16/r164-dev-63d4700f/rows'/(Path(name).stem+'.npz')
        require(str(npz) in pins and pins[str(npz)]['sha256']==config['inputs'][key], 'stored-row NPZ pin/original identity')
        for field,value in check_series(key,replay,old,state).items():
            totals[field]+=value
    inventory(output_dir,set(names)|{'manifest.json','started.json'})
    require(all(integer(manifest[k])==totals[k]==v for k,v in targets.items()), 'complete replay support')
    started=manifest['started_file']
    require(set(started)=={'path','sha256','size'} and started['path']=='started.json', 'start marker record')
    started_path=output_dir/'started.json'
    started_record=dict(path=str(started_path),sha256=started['sha256'],size=started['size'])
    record(started_record)
    require(read_json(started_path,started['sha256'])==dict(schema=SCHEMA,complete=False,plan_sha256=plan_sha256), 'bound immutable start marker')
    # Recheck all bytes and inventories after row comparison, before acceptance.
    require(digest(plan_path)==plan_sha256 and digest(manifest_path)==manifest_sha256, 'authority changed during check')
    for item in pins.values():
        record(item)
    for entry in entries:
        record(dict(path=str(output_dir/entry['path']),sha256=entry['sha256'],size=entry['size']))
    record(started_record)
    inventory(output_dir,set(names)|{'manifest.json','started.json'})
    inventory(state_root,set(state_outputs)|{'manifest.json'})
    inventory(historical_root,state_outputs)
    inventory(raw_root,raw_names)
    return dict(complete=True,**totals,exact_probability_parity_verified=True,
        simulation_independently_reexecuted=False,original_state_bytes_recovered=False,
        unseen_performance_verified=False,counterfactual_validity_verified=False,
        original_blind_a='NOT RUN',original_blind_b='NOT RUN',
        plan_sha256=plan_sha256,manifest_sha256=manifest_sha256)

def run_to_receipt(plan_path,output_dir,plan_sha256,manifest_sha256,out):
    out=Path(out)
    require(not os.path.lexists(out), 'receipt output already exists')
    require(out.parent.is_dir(), 'receipt parent directory required')
    require(not out.resolve().is_relative_to(Path(output_dir).resolve()), 'receipt must be outside producer root')
    result=check(plan_path,output_dir,plan_sha256,manifest_sha256)
    payload=(json.dumps(result,sort_keys=True,allow_nan=False)+'\n').encode()
    require(len(payload)<=65536, 'receipt exceeds 64KiB')
    with out.open('xb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('plan','output-dir','plan-sha256','manifest-sha256','out'):
        parser.add_argument('--'+flag,required=True)
    args=parser.parse_args()
    result=run_to_receipt(args.plan,args.output_dir,args.plan_sha256,args.manifest_sha256,args.out)
    print(json.dumps(dict(complete=result['complete'],series=result['series'],historical_rows=result['historical_rows'])))
