"""Original24 replay-control primitives. No empirical admission or CLI yet.

The original science and source-qualified adapter are supplied by authenticated
transport. This component never calls stage_series, build_horizon or har_coef.
"""
import json
from pathlib import Path
import numpy as np


def need(ok, message):
    if not ok: raise ValueError(message)


def exact_tree(actual, expected, at='report'):
    """Exact typed JSON science parity, including represented float bits."""
    need(type(actual) is type(expected), 'report type parity: ' + at)
    if isinstance(expected, dict):
        need(set(actual) == set(expected), 'report field parity: ' + at)
        for key in expected: exact_tree(actual[key], expected[key], at + '/' + key)
    elif isinstance(expected, list):
        need(len(actual) == len(expected), 'report list parity: ' + at)
        for i, value in enumerate(expected): exact_tree(actual[i], value, at + '/' + str(i))
    elif isinstance(expected, float):
        need(np.isfinite(actual) and actual.hex() == expected.hex(), 'report float parity: ' + at)
    else: need(actual == expected, 'report value parity: ' + at)


def private_inventory(adapter, pins, quarters):
    """Authenticate exactly one original pair for every required calendar quarter."""
    expected = {}
    for q in quarters:
        stem = 'sid-%d-q-%d.private' % (q['sid'], q['quarter_cutoff'])
        for suffix in ('.npz', '.json'):
            name = stem + suffix
            need(name not in expected, 'duplicate required calendar quarter')
            expected[name] = q
    need(len(pins) == len(expected), 'original private pair inventory')
    indexed = {}
    for pin in pins:
        name = Path(pin['path']).name
        need(name in expected and name not in indexed, 'unexpected/duplicate original quarter file')
        need(adapter.pin(pin['path']) == pin, 'original quarter input pin')
        indexed[name] = pin
    for name, pin in indexed.items():
        if not name.endswith('.json'): continue
        receipt = read_json(pin['path'])
        q = expected[name]; npin = indexed[name[:-5] + '.npz']
        need(receipt['sid'] == q['sid'] and receipt['quarter_cutoff'] == q['quarter_cutoff'] and
             receipt['rows'] == q['J_n'] and receipt['forecasts_only_on_original_J'] is True and
             receipt['file'] == Path(npin['path']).name and receipt['size'] == npin['size'] and
             receipt['sha256'] == npin['sha256'], 'original quarter receipt binding')
    return indexed


def compare_quarters(adapter, fresh, original, quarters):
    """Require exact all-field ndarray identity, not compressed-container identity."""
    old = private_inventory(adapter, original, quarters)
    new = private_inventory(adapter, fresh, quarters)
    need(set(old) == set(new), 'replayed quarter inventory')
    for name in old:
        if name.endswith('.npz'):
            a=load_npz(old[name]['path'],private=True);b=load_npz(new[name]['path'],private=True)
            need(set(a) == set(b), 'quarter field parity')
            for key in a:
                x, y = a[key], b[key]
                need(x.dtype == y.dtype and x.shape == y.shape and x.tobytes() == y.tobytes(),
                     'quarter exact array parity: ' + key)
        else:
            a = read_json(old[name]['path']); b = read_json(new[name]['path'])
            # Recompression may change file hash/size. All scientific/support fields remain exact.
            exact_tree({k:v for k,v in b.items() if k not in ('size', 'sha256')},
                       {k:v for k,v in a.items() if k not in ('size', 'sha256')}, 'quarter receipt')


def align_predictions(science, saved, series):
    """All and only original J, restored to the original saved H24 row order."""
    positions = {(int(s), int(t)): i for i, (s,t) in enumerate(zip(saved['sid'][saved['on_J']], saved['ts'][saved['on_J']]))}
    need(len(positions) == int(saved['on_J'].sum()), 'unique original J keys')
    forecasts = {a: np.full((len(positions), 5), np.nan) for a in science.runner.ARMS}
    seen = np.zeros(len(positions), bool)
    for result in series:
        p = result.predictions
        keys = [(int(s),int(t)) for s,t in zip(p['sid'],p['ts'])]
        need(len(keys) == len(set(keys)) and all(k in positions for k in keys), 'replay candidate J keys')
        ix = np.array([positions[k] for k in keys], np.int64)
        need(not seen[ix].any(), 'duplicate replay candidate key')
        for arm in forecasts:
            need(p[arm].dtype == np.float64 and p[arm].shape == (len(keys),5), 'replay candidate schema')
            forecasts[arm][ix] = p[arm]
        seen[ix] = True
    need(seen.all(), 'missing replay J keys')
    need(np.array_equal(forecasts['A_raw_fH'], saved['p_fH'][saved['on_J']]), 'original keyed baseline parity')
    return forecasts


def replay_series(adapter, science, A6, M2, D, saved, selected, metadata, load_series,
                  original_private_pins, original_quarters, out, checkpoint=lambda: None):
    """No fit: original raw + retained coefficients -> exact private-quarter control.

    Production transport must authenticate all sources/runtime/raw/input bytes and
    bound archive headers before invoking this decoded-input seam.
    """
    private_inventory(adapter, original_private_pins, original_quarters)
    results = []; records = []
    for sid, key in selected:
        checkpoint(); ser = load_series(key)
        local = {k: v[saved['sid'] == sid] for k,v in saved.items()}
        result = adapter.evaluate_series(science, A6, M2, D, ser, sid, metadata[sid], local,
                                         dict(L5_n=int(local['on_J'].sum())), out, checkpoint)
        results.append(result); records.extend(result.quarters)
        del ser; checkpoint()
    exact_tree(records, original_quarters, 'original quarter records')
    fresh = [pin for result in results for pin in result.persistence]
    compare_quarters(adapter, fresh, original_private_pins, original_quarters)
    predictions = align_predictions(science, saved, results)
    return predictions, records, fresh, results


def original_report_control(science, saved, cuts, selected, predictions, records, retained):
    """Call the unchanged original 54-view reporter, including its fixed cohort guards."""
    report = science.runner.build_report(science.reporter, saved, saved['on_J'], cuts,
                                        [sid for sid,key in selected], predictions, records)
    exact_tree(report, retained)
    return report


def control_scope_ledger(mapping, selected):
    need(len(mapping) == 277 and mapping == [[i,k] for i,(_,k) in enumerate(mapping)] and
         len({k for _,k in mapping}) == 277, 'canonical277 control ledger')
    need(len(selected) == 24 and len({sid for sid,key in selected}) == 24 and
         all(mapping[sid] == [sid,key] for sid,key in selected), 'original24 control selection')
    selected_ids = {sid for sid,key in selected}
    return [dict(sid=sid, status='REPLAY_CONTROL_EXECUTED' if sid in selected_ids else
                 'UNEXECUTED_CONTROL_ONLY') for sid,key in mapping]


def component_report_control(adapter, science, saved, cuts, mapping, selected, results):
    """Exercise the qualified adapter without claiming the unexecuted253 are empty markets.

    Native floating arithmetic is compared on the SAME canonical SID-row order.
    The separately called original_report_control preserves original archive order.
    """
    by_sid = {int(r.saved['sid'][0]): r for r in results if len(r.saved['sid'])}
    need(set(by_sid) == {sid for sid,key in selected}, 'executed original24 source rows')
    canonical = []
    for sid,key in mapping:
        if sid in by_sid: canonical.append(by_sid[sid]); continue
        empty_saved = {k: v[:0].copy() for k,v in saved.items()}
        empty_predictions = dict(sid=np.empty(0,np.int32),ts=np.empty(0,np.int64),
                                 **{a:np.empty((0,5),np.float64) for a in science.runner.ARMS})
        canonical.append(adapter.SeriesResult(empty_saved,empty_predictions,[],[],dict(L5_n=0),
                                               'UNEXECUTED_CONTROL_ONLY'))
    component = adapter.report(science, canonical, cuts, mapping)
    # These are transport placeholders, not claims about other series' market support.
    component['scope'] = 'ORIGINAL24_SAVED_REPLAY_CONTROL'
    component['full277_scientific_coverage'] = False
    all_saved = {k:np.concatenate([r.saved[k] for r in canonical]) for k in saved}
    forecasts = align_predictions(science, all_saved, canonical)
    native = science.runner.build_report(science.reporter,all_saved,all_saved['on_J'],cuts,
                                         [sid for sid,key in selected],forecasts,
                                         [q for r in canonical for q in r.quarters])
    selected_ids = {sid for sid,key in selected}
    common = [v for v in component['views'] if v['view_type'] != 'asset' or int(v['view']) in selected_ids]
    indexed = {(v['view_type'],v['view']):v for v in common}
    need(len(indexed) == len(native['views']) == 54, 'canonical common54 views')
    for old in native['views']:
        new = indexed[(old['view_type'],old['view'])]
        projection = {k:new[k] for k in old if k != 'scored_J_n'}
        projection['scored_J_n'] = new['scored_L24_n']
        exact_tree(projection, old, 'canonical common54')
    need(component['primary_candidate_passed'] is native['primary_candidate_passed'], 'canonical primary verdict')
    return component, native

# Narrow authenticated transport. Resource/process containment is supplied by the
# separately pinned parent observer. Importing this file never authorizes a run.
import argparse
import ast
import hashlib
import importlib
import importlib.metadata
import importlib.util
import math
import os
import sys
import zipfile

JSON_CAP = 16*1024**2
PIN_ROLES = {'control','adapter','restoration','legacy_scope','raw_scope','staging_request','manifest','cuts',
             'original_request','original_execution','original_monitor','original_report'}
SCOPE = 'ORIGINAL24_SAVED_REPLAY_CONTROL'


def canonical(path):
    p=Path(path)
    need(p.is_absolute() and str(p.resolve()) == str(p) and not p.is_symlink(), 'canonical path')
    return p


def file_pin(path):
    p=canonical(path); h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def checked(record):
    need(set(record)=={'path','size','sha256'} and file_pin(record['path']) == record,'input pin mismatch')
    return canonical(record['path'])


def read_json(path):
    p=canonical(path); need(p.stat().st_size <= JSON_CAP, 'JSON size cap')
    def pairs(items):
        result={}
        for k,v in items:need(k not in result,'duplicate JSON key');result[k]=v
        return result
    def finite(v):
        x=float(v);need(math.isfinite(x),'nonfinite JSON number');return x
    def bad(v):raise ValueError('nonfinite JSON constant')
    return json.loads(p.read_bytes(),object_pairs_hook=pairs,parse_float=finite,parse_constant=bad)


def authenticate(path, digest):
    request_pin=file_pin(path); need(request_pin['sha256']==digest,'external control request SHA')
    q=read_json(path)
    need(q.get('status','DRAFT')=='READY_PARENT_REVIEWED_ORIGINAL24_CONTROL','DRAFT: no payload admission')
    need(set(q)=={'schema','status','scope','pins','inputs','science','files','runtime','out'} and
         q['schema']=='q26-fixed-mixture-original24-control-v1' and q['scope']==SCOPE,'control request schema/scope')
    need(set(q['pins'])==PIN_ROLES and set(q['inputs'])=={'6','12','24','72','168'},'control pin roles')
    need(q['pins']['control']==file_pin(__file__),'control source identity')
    files={}
    for p in q['files']:
        need(p['path'] not in files,'duplicate closure path');checked(p);files[p['path']]=p
    roles=[*q['pins'].values(),*q['inputs'].values(),*q['science'].values()]
    for p in roles:need(files.get(p['path'])==p,'role absent from authenticated closure')
    docs={k:read_json(q['pins'][k]['path']) for k in PIN_ROLES-{'control','adapter'}}
    old=docs['original_request'];execution=docs['original_execution'];monitor=docs['original_monitor']
    need(execution['inner_request_pin']==q['pins']['original_request'] and monitor['request']==q['pins']['original_execution'], 'original execution chain')
    need(monitor['complete'] is True and monitor['exit_code']==0 and not monitor['changed_pin_paths'] and
         monitor['containment']['no_live_members_remaining'] is True and not monitor['containment']['errors'] and
         not monitor['containment']['remaining_zombies'],'original successful containment')
    need(q['inputs']==old['inputs'],'original five input identities')
    for role in ('manifest','cuts','staging_request','producer'):
        actual=q['science']['producer'] if role=='producer' else q['pins'][role]
        need(actual==old['pins'][role],'original authority identity: '+role)
    need(docs['restoration']['science_roles']==q['science'],'restored scientific closure')
    for role,p in q['science'].items():
        oldpin=old['pins'][role]
        need((p['size'],p['sha256'])==(oldpin['size'],oldpin['sha256']),'accepted source content identity')
    stage=docs['staging_request'];manifest=docs['manifest'];raw=docs['raw_scope']['base_scope'];fit=docs['legacy_scope']
    need(stage['pins']['fit_scope']==q['pins']['legacy_scope'] and stage['pins']['raw_scope']==q['pins']['raw_scope'], 'staging ancestor chain')
    need(manifest['complete'] is True and manifest['canonical_mapping']==stage['selected'] and
         all(p in manifest['outputs'] for p in q['inputs'].values()),'original selected24 manifest')
    need(len(stage['selected'])==24 and len({s for s,k in stage['selected']})==24,'original24 selection')
    cuts=docs['cuts'];need(cuts['schema']=='r17-conditional-depth-cuts-v1' and cuts['complete'] is True and
         cuts['phase']=='cuts' and cuts['input_pins']['24']==q['inputs']['24'] and
         cuts['request_pins']['manifest']==q['pins']['manifest'] and
         set(cuts['horizons']['24'])=={'issued_log_sigma','downside_imbalance_D','jump_share_D'},'all three original cut authorities')
    original_outputs=monitor['result_pins']; need(len(original_outputs)==383,'original383 output closure')
    for p in original_outputs:need(files.get(p['path'])==p,'original output absent from closure')
    need(q['pins']['original_report'] in original_outputs and
         set(Path(p['path']).name for p in original_outputs)==set(execution['expected_results']), 'original report and output inventory')
    needed_raw=set(stage['required_raw_paths']);rawpins={p['path']:{k:p[k] for k in ('path','size','sha256')} for p in raw['price_inputs']+raw['auxiliary_inputs']}
    need(needed_raw<=set(rawpins) and all(files.get(p)==rawpins[p] for p in needed_raw),'required original raw closure')
    # Exact30 source identities are recognized by their repository-relative suffix.
    source_paths=[]
    for relative,sha in fit['source_sha256'].items():
        candidates=[p for p in q['files'] if p['path'].endswith('/'+relative) and p['sha256']==sha]
        need(len(candidates)==1,'original legacy source closure');source_paths.append(candidates[0]['path'])
    need(len(source_paths)==30,'original30 scientific sources')
    runtime=q['runtime'];need(Path(sys.executable).resolve()==Path(runtime['executable']['path']).resolve() and
         files.get(runtime['executable']['path'])==runtime['executable'],'current interpreter pin')
    need(sys.version==runtime['version'] and sys.dont_write_bytecode and sys.flags.optimize==0,'current runtime/flags')
    for k,v in runtime['environment'].items():need(os.environ.get(k)==v,'runtime environment')
    need(all(runtime['environment'].get(k)=='1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')),'one thread settings')
    for package,version in runtime['packages'].items():need(importlib.metadata.version(package)==version,'current package version')
    for p in runtime['native_pins']:need(files.get(p['path'])==p,'current native closure')
    out=canonical(q['out']);need(not out.exists(),'fresh output root')
    for p in q['files']:
        parent=Path(p['path']).parent
        need(out!=parent and parent not in out.parents and out not in Path(p['path']).parents,'output outside protected input roots')
    return q,docs,request_pin,source_paths,original_outputs


def load_npz(path,private=False,headers_only=False):
    """Bound all headers and payload dimensions before decoding this archive."""
    with zipfile.ZipFile(path) as z:
        names=z.namelist();need(len(names)==len(set(names)) and len(names)<=24,'NPZ inventory cap')
        total=0
        for entry in z.infolist():
            need(entry.filename.endswith('.npy') and '/' not in entry.filename and not entry.flag_bits&1,'NPZ member')
            need(entry.file_size<=64*1024**2,'NPZ member cap');total+=entry.file_size
            with z.open(entry) as f:
                need(f.read(6)==b'\x93NUMPY','NPY magic');version=f.read(2)
                width=2 if version==b'\x01\x00' else 4 if version in (b'\x02\x00',b'\x03\x00') else 0
                need(width>0,'NPY version');length=int.from_bytes(f.read(width),'little');need(length<=16384,'NPY header cap')
                header=ast.literal_eval(f.read(length).decode('latin1'))
                need(set(header)=={'descr','fortran_order','shape'} and header['fortran_order'] is False,'NPY layout')
                dtype=np.dtype(header['descr']);shape=header['shape']
                need(not dtype.hasobject and dtype.kind in 'biuf' and isinstance(shape,tuple) and
                     1<=len(shape)<=2 and all(type(n)is int and 0<=n<=200000 for n in shape),'NPY dtype/shape bounds')
                need(entry.file_size==6+2+width+length+math.prod(shape)*dtype.itemsize,'NPY exact payload size')
        need(total<=256*1024**2,'NPZ total cap')
    if headers_only:return None
    with np.load(path,allow_pickle=False) as z:return {k:z[k] for k in z.files}


def write_json(path,value):
    raw=json.dumps(value,allow_nan=False,separators=(',',':')).encode();need(len(raw)<=JSON_CAP,'output JSON cap')
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:
        f.write(raw);f.flush();os.fsync(f.fileno())


def run(path,digest):
    q,docs,request_pin,source_paths,original_outputs=authenticate(path,digest)
    import types
    adapter_pin=q['pins']['adapter'];checked(adapter_pin)
    source=Path(adapter_pin['path']).read_bytes()
    need(hashlib.sha256(source).hexdigest()==adapter_pin['sha256'],'adapter source changed before compile')
    adapter=types.ModuleType('_q26_control_adapter');adapter.__file__=adapter_pin['path']
    sys.modules[adapter.__name__]=adapter
    exec(compile(source,adapter.__file__,'exec'),adapter.__dict__)
    science=adapter.load_science(dict(schema='q26-fixed-mixture-expansion-source-v1',
        status='READY_SYNTHETIC_SOURCE_QUALIFICATION',science=q['science']))
    selected=docs['staging_request']['selected'];raw=docs['raw_scope']['base_scope']
    mapping=[[i,k] for i,k in enumerate(raw['canonical_keys'])]
    adapter.validate_universe(science,mapping,raw['canonical_keys'],selected)
    retained=docs['original_report'];quarters=retained['quarter_records']
    need(len(quarters)==191 and retained['J_n']==17180 and retained['regression_calls']==0,'fixed original control counts')
    metadata={m['sid']:m for m in docs['manifest']['series_horizons'] if m['horizon']==24}
    need(set(metadata)=={sid for sid,key in selected} and sum(len(m['quarters']) for m in metadata.values())==357,'original357 source metadata')
    private=[p for p in original_outputs if Path(p['path']).name!='report.json']
    private_inventory(adapter,private,quarters)
    # Qualify ALL original ZIP/NPY headers before the FIRST empirical payload.
    for p in [*q['inputs'].values(),*private]:
        if p['path'].endswith('.npz'):load_npz(p['path'],headers_only=True)
    archives={int(h):load_npz(p['path']) for h,p in q['inputs'].items()}
    joint=science.joint_driver.assemble(archives)
    need(np.array_equal(joint['J'],joint['L']) and int(joint['J'].sum())==17180 and joint['J_hash']==science.runner.J_HASH,'original fixed J=L membership')
    saved,ledger=adapter.attach_joint(science,archives);del archives,joint
    cuts=docs['cuts']['horizons']['24'];need(cuts['downside_imbalance_D']['cut']==science.runner.CUT,'fixed original cut')
    finder=science.producer.FrozenSources(source_paths)
    need(not(set(finder.paths)&set(sys.modules)),'cold original source imports')
    sys.meta_path.insert(0,finder)
    out=Path(q['out']);out.mkdir(mode=0o700);private_out=out/'quarters';private_out.mkdir(mode=0o700)
    try:
        R12=importlib.import_module('r12_tail');A6=importlib.import_module('a6_touch')
        M2=importlib.import_module('a2_touch');D=importlib.import_module('r16_dev')
        R12._CHAIN.clear();specs={s['key']:s for s in R12.dev_specs(raw['datasets'])}
        need(set(specs)==set(raw['canonical_keys']),'original loader canonical closure')
        def loader(key):return R12.load_series(specs[key])[0]
        reads=[p['path'] for p in q['files']]+[request_pin['path']]
        with science.producer.guard(reads,out):
            predictions,records,fresh,results=replay_series(adapter,science,A6,M2,D,saved,selected,metadata,loader,private,quarters,private_out)
            native=original_report_control(science,saved,cuts,selected,predictions,records,retained)
            component,canonical_native=component_report_control(adapter,science,saved,cuts,mapping,selected,results)
            wrapper=dict(schema='q26-original24-adapter-component-control-v1',scope=SCOPE,
                full277_scientific_coverage=False,unexecuted_status='UNEXECUTED_CONTROL_ONLY',
                ledger=control_scope_ledger(mapping,selected),component=component)
            write_json(out/'native-report.json',native);write_json(out/'canonical-native-report.json',canonical_native)
            write_json(out/'adapter-component-report.json',wrapper)
    finally:
        if finder in sys.meta_path:sys.meta_path.remove(finder)
    for p in q['files']:need(file_pin(p['path'])==p,'final input closure changed')
    need(file_pin(path)==request_pin,'control request changed')
    expected={Path(p['path']).name for p in fresh}|{'native-report.json','canonical-native-report.json','adapter-component-report.json'}
    files=[p for p in out.rglob('*') if p.is_file()]
    need(len(files)==385 and {p.name for p in files}==expected,'exact control output inventory')
    need(sum(p.stat().st_size for p in files)<=32*1024**2,'total control output cap')
    outputs=[file_pin(p) for p in sorted(files)]
    result=dict(schema='q26-original24-control-result-v1',label='CODEX CONTINUATION',scope=SCOPE,complete=True,
        request_sha256=digest,source=q['pins']['control'],outputs=outputs,original24_array_parity='EXACT_ALL_FIELDS',
        original54_native_report_parity='EXACT',canonical54_adapter_report_parity='EXACT',
        full277_scientific_coverage=False,regression_calls=0,series_ledger=control_scope_ledger(mapping,selected))
    result_bytes=json.dumps(result,allow_nan=False,separators=(',',':')).encode()
    need(sum(p.stat().st_size for p in files)+len(result_bytes)<=32*1024**2,'final control output cap')
    write_json(out/'control-result.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--request',required=True);parser.add_argument('--request-sha256',required=True)
    args=parser.parse_args();run(args.request,args.request_sha256)
