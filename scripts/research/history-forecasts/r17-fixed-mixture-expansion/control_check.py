"""Independent, opt-in saved original24 replay checker; no producer imports.

Importing this module never opens payloads. The CLI requires externally sealed
request AND terminal producer-result SHA256s. It neither fits nor promotes a model.
"""
import argparse
import ast
import hashlib
import importlib.metadata
import os
import json
from pathlib import Path
import re
import sys
import types
import zipfile
import numpy as np

SCOPE = 'ORIGINAL24_SAVED_REPLAY_CONTROL'
ARMS = ('A_raw_fH', 'B_common_shape', 'C_conditional')
HORIZONS = ('6', '12', '24', '72', '168')
START, YEAR25, END = 1704067200, 1735689600, 1767225600
PIN_ROLES = {'control', 'adapter', 'restoration', 'legacy_scope', 'raw_scope',
             'staging_request', 'manifest', 'cuts', 'original_request',
             'original_execution', 'original_monitor', 'original_report'}


def require(ok, why):
    if not ok:
        raise ValueError(why)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON field')
        result[key] = value
    return result


def decode(raw):
    def reject(value):
        raise ValueError('nonfinite JSON constant')
    def finite(value):
        number = float(value)
        require(np.isfinite(number), 'nonfinite JSON number')
        return number
    return json.loads(raw, object_pairs_hook=_object, parse_constant=reject, parse_float=finite)


def checked(pin):
    require(type(pin) is dict and set(pin) == {'path', 'size', 'sha256'}, 'pin schema')
    require(type(pin['path']) is str and str(Path(pin['path']).resolve()) == pin['path'], 'canonical pin path')
    require(type(pin['size']) is int and pin['size'] >= 0 and type(pin['sha256']) is str and
            re.fullmatch('[0-9a-f]{64}', pin['sha256']) is not None, 'pin digest schema')
    path = Path(pin['path'])
    require(path.is_file() and path.stat().st_size == pin['size'], 'pin file size')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    require(digest.hexdigest() == pin['sha256'], 'pin file hash')
    return path


def external(path, sha):
    path = Path(path)
    require(str(path.resolve()) == str(path), 'external canonical path')
    raw = path.read_bytes()
    require(type(sha) is str and hashlib.sha256(raw).hexdigest() == sha, 'external digest')
    return decode(raw)


def exact(actual, expected, where='data'):
    require(type(actual) is type(expected), 'exact JSON type: ' + where)
    if type(expected) is dict:
        require(set(actual) == set(expected), 'exact JSON fields: ' + where)
        for key in expected:
            exact(actual[key], expected[key], where + '/' + key)
    elif type(expected) is list:
        require(len(actual) == len(expected), 'exact JSON length: ' + where)
        for i, value in enumerate(expected):
            exact(actual[i], value, where + '/' + str(i))
    elif type(expected) is float:
        require(np.isfinite(actual) and actual.hex() == expected.hex(), 'exact JSON float: ' + where)
    else:
        require(actual == expected, 'exact JSON value: ' + where)


def pin_index(pins):
    require(type(pins) is list, 'flat pin inventory')
    by_path = {}
    for pin in pins:
        checked(pin)
        require(pin['path'] not in by_path, 'duplicate pinned path')
        by_path[pin['path']] = pin
    return by_path


def _bound(pin, inventory):
    require(pin['path'] in inventory and inventory[pin['path']] == pin, 'pin not in authenticated closure')


def _json(pin):
    return decode(Path(pin['path']).read_bytes())


def authenticate_request(request_path, request_sha):
    r = external(request_path, request_sha)
    require(r.get('schema') == 'q26-fixed-mixture-original24-control-v1' and
            r.get('status') == 'READY_PARENT_REVIEWED_ORIGINAL24_CONTROL' and
            r.get('scope') == SCOPE, 'DRAFT or wrong control request')
    require(set(r['pins']) == PIN_ROLES and set(r['inputs']) == set(HORIZONS), 'request role closure')
    require(set(r) == {'schema','status','scope','pins','inputs','science','files','runtime','out'}, 'exact request schema')
    inventory = pin_index(r['files'])  # EVERY current input before any archive decode.
    require(str(Path(__file__).resolve()) in inventory, 'independent checker source must be pinned')
    for pin in [*r['pins'].values(), *r['inputs'].values(), *r['science'].values()]:
        _bound(pin, inventory)
    require(len(r['science']) == 10, 'ten exact scientific helpers')
    original = _json(r['pins']['original_request'])
    execution = _json(r['pins']['original_execution'])
    monitor = _json(r['pins']['original_monitor'])
    restoration = _json(r['pins']['restoration'])
    require(execution['inner_request_pin'] == r['pins']['original_request'] and
            monitor['request'] == r['pins']['original_execution'], 'accepted original request/execution binding')
    require(monitor['complete'] is True and monitor['exit_code'] == 0 and
            monitor['stop_reason'] is None and not monitor['changed_pin_paths'] and
            monitor['containment']['no_live_members_remaining'] is True and
            not monitor['containment']['errors'] and not monitor['containment']['remaining_zombies'], 'original terminal success')
    require(restoration['original_trial_request'] == r['pins']['original_request'] and
            restoration['science_roles'] == r['science'], 'restored original scientific helper mapping')
    for role, pin in r['science'].items():
        old = original['pins'][role]
        require((pin['sha256'], pin['size']) == (old['sha256'], old['size']), 'exact original helper bytes')
    require(original['inputs'] == r['inputs'], 'original five input archive pins')
    for role in ('manifest', 'cuts', 'staging_request'):
        require(original['pins'][role] == r['pins'][role], 'original authority role: ' + role)
    old_outputs = monitor['result_pins']
    require(len(old_outputs) == 383, 'original 383 output closure')
    for pin in old_outputs:
        _bound(pin, inventory)
    names = [Path(pin['path']).name for pin in old_outputs]
    require(len(set(names)) == len(names) and set(names) == set(execution['expected_results']) and
            len(names) == len(execution['expected_results']), 'original expected result closure')
    require(next(pin for pin in old_outputs if Path(pin['path']).name == 'report.json') ==
            r['pins']['original_report'], 'original report authority')
    staging = _json(r['pins']['staging_request']); manifest = _json(r['pins']['manifest'])
    require(staging['selected'] == manifest['canonical_mapping'] and
            manifest['complete'] is True and manifest['request_protocol'] == staging['protocol'], 'original staged selection')
    require(staging['pins']['fit_scope'] == r['pins']['legacy_scope'] and
            staging['pins']['raw_scope'] == r['pins']['raw_scope'], 'original ancestor scopes')
    raw = _json(r['pins']['raw_scope'])['base_scope']
    rawpins = {p['path']:{k:p[k] for k in ('path','size','sha256')}
               for p in raw['price_inputs'] + raw['auxiliary_inputs']}
    for path in staging['required_raw_paths']:
        require(path in rawpins, 'required original raw authority'); _bound(rawpins[path], inventory)
    legacy = _json(r['pins']['legacy_scope'])
    require(len(legacy['source_sha256']) == 30, 'original30 scientific sources')
    for rel,sha in legacy['source_sha256'].items():
        require(len([p for p in inventory.values() if p['path'].endswith('/'+rel) and p['sha256']==sha])==1,
                'exact original legacy source closure')
    runtime=r['runtime']
    _bound(runtime['executable'],inventory)
    for pin in runtime['native_pins']: _bound(pin,inventory)
    require(Path(sys.executable).resolve()==Path(runtime['executable']['path']) and
            sys.version==runtime['version'] and sys.dont_write_bytecode and sys.flags.optimize==0, 'checker current interpreter identity/flags')
    for key,value in runtime['environment'].items():
        require(os.environ.get(key)==value, 'checker current runtime environment')
    require(all(runtime['environment'].get(k)=='1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')), 'checker one thread settings')
    for name,version in runtime['packages'].items():
        require(importlib.metadata.version(name)==version, 'checker current package identity')
    selected = staging['selected']
    canonical=raw['canonical_keys']
    require(len(canonical)==277 and len(set(canonical))==277 and
            all(type(s) is int and 0<=s<277 and canonical[s]==key for s,key in selected),
            'canonical277 original24 identity')
    require(len(selected) == 24 and len({s for s,k in selected}) == len({k for s,k in selected}) == 24,
            'original24 selection')
    cuts = _json(r['pins']['cuts'])
    require(cuts['complete'] is True and cuts['input_pins']['24'] == r['inputs']['24'] and
            cuts['request_pins']['manifest'] == r['pins']['manifest'], 'frozen cuts lineage')
    return r, inventory, old_outputs, selected


def authenticate_outputs(r, request_sha, result_path, result_sha):
    result = external(result_path, result_sha)
    require(result.get('schema') == 'q26-original24-control-result-v1' and result.get('scope') == SCOPE and
            result.get('request_sha256') == request_sha and result.get('source') == r['pins']['control'], 'output authority binding')
    require(result.get('complete') is True and result.get('full277_scientific_coverage') is False and
            type(result.get('regression_calls')) is int and result['regression_calls'] == 0, 'control scope metadata')
    inventory = pin_index(result['outputs'])
    require(len(inventory) == 385, '385 pinned output files')
    require(sum(p['size'] for p in inventory.values()) + Path(result_path).stat().st_size <= 32*1024*1024, 'control output byte cap')
    root = Path(r['out'])
    require(str(root.resolve()) == str(root) and Path(result_path) == root/'control-result.json', 'canonical output root')
    require(all(Path(p).is_relative_to(root) and p != str(root/'control-result.json') for p in inventory), 'output containment')
    disk = {str(p) for p in root.rglob('*') if p.is_file()}
    require(disk == set(inventory) | {str(Path(result_path))}, 'extra or missing output file')
    rel = {str(Path(p).relative_to(root)): pin for p,pin in inventory.items()}
    require({'native-report.json', 'canonical-native-report.json', 'adapter-component-report.json'} <= set(rel), 'report output closure')
    return result, rel


def read_archive(path):
    """Bound every ZIP/NPY header before NumPy can allocate a payload array."""
    import math
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        require(len(names)==len(set(names)) and len(names)<=24, 'NPZ member inventory')
        total=0
        for entry in z.infolist():
            require(entry.filename.endswith('.npy') and '/' not in entry.filename and
                    not entry.flag_bits&1, 'NPZ member inventory')
            require(entry.file_size<=64*1024*1024, 'NPZ member byte bound')
            total+=entry.file_size
            with z.open(entry) as stream:
                require(stream.read(6)==b'\x93NUMPY', 'NPY magic')
                version=stream.read(2)
                width=2 if version==b'\x01\x00' else 4 if version in (b'\x02\x00',b'\x03\x00') else 0
                require(width>0, 'NPY version')
                raw_length=stream.read(width)
                require(len(raw_length)==width, 'NPY header length field')
                length=int.from_bytes(raw_length,'little')
                require(0<length<=16384, 'NPY bounded header')
                raw=stream.read(length)
                require(len(raw)==length, 'NPY truncated header')
                header=ast.literal_eval(raw.decode('utf8' if version==b'\x03\x00' else 'latin1'))
                require(type(header) is dict and set(header)=={'descr','fortran_order','shape'} and
                        header['fortran_order'] is False, 'NPY exact layout')
                dtype=np.dtype(header['descr']);shape=header['shape']
                require(not dtype.hasobject and dtype.kind in 'biuf' and type(shape) is tuple and
                        1<=len(shape)<=2 and all(type(n) is int and 0<=n<=200000 for n in shape),
                        'NPY dtype/shape bounds')
                require(entry.file_size==8+width+length+math.prod(shape)*dtype.itemsize,
                        'NPY exact declared payload size')
        require(total<=128*1024*1024, 'NPZ uncompressed bound')
    with np.load(path, allow_pickle=False) as archive:
        return {key: archive[key] for key in archive.files}


def exact_arrays(actual, expected):
    require(set(actual) == set(expected), 'NPZ field inventory')
    for key in expected:
        x,y = actual[key], expected[key]
        require(x.dtype == y.dtype and x.shape == y.shape and x.tobytes(order='C') == y.tobytes(order='C'),
                'exact NPZ array: ' + key)


def quarter_pairs(old_pins, fresh_pins, records):
    """Independent per-pair receipt/data parity, including zero-row quarters."""
    old = {Path(p['path']).name: p for p in old_pins if Path(p['path']).name != 'report.json'}
    expected = {}
    for q in records:
        stem = 'sid-%d-q-%d.private' % (q['sid'], q['quarter_cutoff'])
        require(stem not in expected, 'duplicate quarter record')
        expected[stem] = q
    names = {stem+suffix for stem in expected for suffix in ('.npz', '.json')}
    require(set(old) == names and set(fresh_pins) == names, 'exact quarter pair coverage')
    all_rows = []
    for stem,q in expected.items():
        oldp, newp = old[stem+'.npz'], fresh_pins[stem+'.npz']
        receipts = []
        for table, npin in ((old,oldp), (fresh_pins,newp)):
            receipt = _json(table[stem+'.json'])
            require(type(receipt['sid']) is int and receipt['sid'] == q['sid'] and
                    type(receipt['quarter_cutoff']) is int and receipt['quarter_cutoff'] == q['quarter_cutoff'] and
                    type(receipt['rows']) is int and receipt['rows'] == q['J_n'] and
                    receipt['forecasts_only_on_original_J'] is True and receipt['file'] == stem+'.npz' and
                    receipt['size'] == npin['size'] and receipt['sha256'] == npin['sha256'], 'private receipt binding')
            receipts.append({k:v for k,v in receipt.items() if k not in ('size','sha256')})
        exact(receipts[1],receipts[0], 'private receipt science')
        a,b = read_archive(oldp['path']),read_archive(newp['path'])
        exact_arrays(b,a)
        n=q['J_n']; required={'sid','ts','on_J','candidate_prediction_valid','fH_fallback','issuance_state',*ARMS}
        require(set(a) == required and a['sid'].dtype == np.int32 and a['ts'].dtype == np.int64 and
                a['sid'].shape == a['ts'].shape == (n,) and np.all(a['sid'] == q['sid']), 'private keyed schema')
        require(a['on_J'].dtype == bool and a['candidate_prediction_valid'].dtype == bool and
                a['on_J'].shape == a['candidate_prediction_valid'].shape == (n,) and
                a['on_J'].all() and a['candidate_prediction_valid'].all(), 'private valid J flags')
        require(a['fH_fallback'].dtype == bool and a['fH_fallback'].shape == a['issuance_state'].shape == (n,), 'private policy flags')
        keys=list(zip(a['sid'].tolist(),a['ts'].tolist()))
        require(len(set(keys)) == len(keys) and np.all(a['ts'] >= q['quarter_cutoff']) and
                np.all(a['ts'] < next_quarter(q['quarter_cutoff'])), 'private quarter keys')
        for arm in ARMS:
            require(a[arm].dtype == np.float64 and a[arm].shape == (n,5) and np.isfinite(a[arm]).all() and
                    np.all((a[arm]>=0)&(a[arm]<=1)), 'private forecast schema')
        all_rows.append(a)
    return all_rows


def next_quarter(ts):
    import datetime as dt
    date=dt.datetime.fromtimestamp(ts,dt.timezone.utc)
    month=date.month+3
    return int(dt.datetime(date.year+(month>12), (month-1)%12+1, 1, tzinfo=dt.timezone.utc).timestamp())


def frozen_membership_hash(runner_pin):
    """Read only a literal identity constant from exact authenticated original source.

    The membership calculation remains independently implemented below. The
    private identity itself is never embedded in this publishable source.
    """
    path=checked(runner_pin)
    tree=ast.parse(path.read_bytes(),filename=str(path))
    values=[node.value.value for node in tree.body if isinstance(node,ast.Assign) and
            any(isinstance(target,ast.Name) and target.id=='J_HASH' for target in node.targets) and
            isinstance(node.value,ast.Constant)]
    require(len(values)==1 and type(values[0]) is str and re.fullmatch('[0-9a-f]{64}',values[0]),
            'literal frozen original membership authority')
    return values[0]


def joint_identity(inputs, rows):
    """Reconstruct label-independent five-H J directly, without archived helper code."""
    maps={}; arrays={}
    for h in HORIZONS:
        arrays[h] = a = read_archive(inputs[h]['path'])
        keys=list(zip(a['sid'].tolist(),a['ts'].tolist()))
        require(a['sid'].dtype == np.int32 and a['ts'].dtype == np.int64 and len(keys)==len(set(keys)), 'input unique exact keys')
        maps[h]={key:i for i,key in enumerate(keys)}
    common=set.intersection(*(set(m) for m in maps.values())); issued=set(); labelled=set()
    for key in common:
        if not START <= key[1] < END:
            continue
        if all(bool(arrays[h]['issue_eligible'][maps[h][key]]) and bool(arrays[h]['p_fH_valid'][maps[h][key]]) for h in HORIZONS):
            issued.add(key)
            if all(bool(arrays[h]['label_valid'][maps[h][key]]) for h in HORIZONS):
                labelled.add(key)
    require(issued == labelled, 'original J=L independently reconstructed')
    rowkeys=[(int(s),int(t)) for a in rows for s,t in zip(a['sid'],a['ts'])]
    require(len(rowkeys) == len(set(rowkeys)) and set(rowkeys) == issued, 'all and only original J saved keys')
    h24=arrays['24']; mapping=maps['24']
    for a in rows:
        ix=np.array([mapping[(int(s),int(t))] for s,t in zip(a['sid'],a['ts'])], dtype=np.int64)
        exact_arrays({'base':a['A_raw_fH']},{'base':h24['p_fH'][ix]})
    ordered=np.asarray(sorted(issued),dtype='<i8').reshape((-1,2))
    return dict(n=len(issued),year2024=sum(t<YEAR25 for s,t in issued),year2025=sum(t>=YEAR25 for s,t in issued),
                sha256=hashlib.sha256(ordered.tobytes()).hexdigest())


def report_parity(original, native, canonical, wrapper, selected, empty_reference):
    exact(native, original, 'native original54')
    selected_ids={s for s,k in selected}
    require(set(wrapper) == {'schema','scope','full277_scientific_coverage','unexecuted_status','ledger','component'} and
            wrapper['schema'] == 'q26-original24-adapter-component-control-v1' and wrapper['scope'] == SCOPE and
            wrapper['full277_scientific_coverage'] is False and wrapper['unexecuted_status'] == 'UNEXECUTED_CONTROL_ONLY', 'component wrapper')
    ledger=[dict(sid=s,status='REPLAY_CONTROL_EXECUTED' if s in selected_ids else 'UNEXECUTED_CONTROL_ONLY') for s in range(277)]
    exact(wrapper['ledger'], ledger, 'control scope ledger')
    component=wrapper['component']
    exact(component['quarter_records'],canonical['quarter_records'],'component canonical quarter records')
    require(component['J_n']==component['L24_n']==component['L5_n']==canonical['J_n'] and
            component['unseen_validation'] is False and component['empirical_admission_status']=='NOT_ADMITTED', 'component count/admission scope')
    series=component['series_ledger']
    require(len(series)==277 and [v['sid'] for v in series]==list(range(277)), 'component series inventory')
    for record in series:
        sid=record['sid']; own=[q for q in canonical['quarter_records'] if q['sid']==sid]
        require(record['evaluation_quarters']==len(own) and record['L5_n']==sum(q['J_n'] for q in own), 'component series quarter support')
        if sid not in selected_ids:
            require(record['status']=='UNEXECUTED_CONTROL_ONLY' and record['source_rows']==0, 'component unexecuted series metadata')
        else:
            require(record['status']=='CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE' and record['source_rows']>=record['L5_n'], 'component executed series metadata')
    require(component['scope'] == SCOPE and component['full277_scientific_coverage'] is False and len(component['views']) == 307 and
            len(canonical['views']) == 54, 'report view/scope inventory')
    common={}; empty=[]
    for view in component['views']:
        key=(view['view_type'],view['view'])
        if view['view_type'] == 'asset' and int(view['view']) not in selected_ids:
            empty.append(view)
        else:
            require(key not in common, 'duplicate component view')
            common[key]=view
    require(len(common)==54 and len(empty)==253 and {int(v['view']) for v in empty} == set(range(277))-selected_ids, 'common and unexecuted view closure')
    for expected in canonical['views']:
        key=(expected['view_type'],expected['view'])
        require(key in common, 'missing canonical view')
        new=common.pop(key)
        projected={k:new[k] for k in expected if k!='scored_J_n'}
        projected['scored_J_n']=new['scored_L24_n']
        exact(projected,expected,'canonical common54')
    require(not common, 'extra canonical view')
    exact(component['primary_candidate_passed'],canonical['primary_candidate_passed'],'canonical primary verdict')
    # Empty support is insufficient: the entire metric/paired payload must equal
    # the authenticated original reporter's empty-array result, field for field.
    for view in component['views']:
        require(view['forecast_J_n'] == view['scored_L24_n'] and view['J_unknown_label_n'] == 0, 'original control J=L counts')
    for view in empty:
        expected=dict(view_type='asset',view=view['view'],issued_n=0,forecast_J_n=0,scored_L24_n=0,
                      J_unknown_label_n=0,issued_outside_J_n=0,source_baseline_unavailable_n=0,
                      source_available_unknown_label_n=0,source_fallback_n=0,**empty_reference)
        exact(view,expected,'unexecuted exact empty reporter view')
    return ledger


def canonical_reference(science_pins, inputs, old_rows, records, cuts, selected):
    """Run authenticated ORIGINAL report code on independently rekeyed saved bytes.

    The new producer, adapter and all their helpers are deliberately excluded.
    """
    old_modules={name:sys.modules.get(name) for name in ('driver','kernel')}
    def module(role, name):
        pin=science_pins[role]; path=checked(pin); obj=types.ModuleType(name)
        obj.__file__=str(path)
        exec(compile(path.read_bytes(),str(path),'exec'),obj.__dict__)
        return obj
    try:
        sys.modules['kernel']=module('joint_kernel','kernel')
        sys.modules['driver']=module('joint_driver','driver')
        reporter=module('reporter','_q26_control_check_original_reporter')
        runner=module('runner','_q26_control_check_original_runner')
        saved=read_archive(inputs['24']['path'])
        # Stable SID sort exactly preserves each original series' archive row order.
        order=np.argsort(saved['sid'],kind='stable')
        saved={key:value[order] for key,value in saved.items()}
        old_by_key={(int(s),int(t)):(a,i) for a in old_rows for i,(s,t) in enumerate(zip(a['sid'],a['ts']))}
        keys=[(int(s),int(t)) for s,t in zip(saved['sid'],saved['ts'])]
        saved['on_J']=np.asarray([key in old_by_key for key in keys],dtype=bool)
        selected_keys=[key for key in keys if key in old_by_key]
        predictions={arm:np.asarray([old_by_key[key][0][arm][old_by_key[key][1]] for key in selected_keys],dtype=np.float64).reshape(-1,5)
                     for arm in ARMS}
        canonical_records=sorted(records,key=lambda q:q['sid'])
        report=runner.build_report(reporter,saved,saved['on_J'],cuts,[sid for sid,key in selected],predictions,canonical_records)
        empty=np.empty((0,5),dtype=np.float64)
        empty_reference=dict(arms={arm:reporter.metric(empty,empty) for arm in ARMS},
            paired={left+'_minus_'+right:reporter.paired(empty,empty,empty,np.ones(0,dtype=bool)) for left,right in runner.PAIRS})
        return report,empty_reference
    finally:
        for name, previous in old_modules.items():
            if previous is None: sys.modules.pop(name,None)
            else: sys.modules[name]=previous


def check(request_path, request_sha, result_path, result_sha):
    r, inputs, old_pins, selected = authenticate_request(request_path, request_sha)
    result, outputs = authenticate_outputs(r,request_sha,result_path,result_sha)
    original=_json(r['pins']['original_report'])
    native=_json(outputs['native-report.json']); canonical=_json(outputs['canonical-native-report.json'])
    wrapper=_json(outputs['adapter-component-report.json'])
    quarters=original['quarter_records']
    require(len(quarters)==191 and {q['sid'] for q in quarters} == {s for s,k in selected} and
            sum(q['J_n'] for q in quarters)==17180, 'original quarter record closure')
    required={'quarters/'+Path(p['path']).name for p in old_pins if Path(p['path']).name!='report.json'}
    require(set(outputs)==required|{'native-report.json','canonical-native-report.json','adapter-component-report.json'}, 'exact frozen output layout')
    rows=quarter_pairs(old_pins,{name[9:]:outputs[name] for name in required},quarters)
    identity=joint_identity(r['inputs'],rows)
    exact(identity,dict(n=17180,year2024=8420,year2025=8760,sha256=frozen_membership_hash(r['science']['runner'])),'independent original J identity')
    reference,empty_reference=canonical_reference(r['science'],r['inputs'],rows,quarters,_json(r['pins']['cuts'])['horizons']['24'],selected)
    exact(canonical,reference,'independent canonical original report')
    ledger=report_parity(original,native,canonical,wrapper,selected,empty_reference)
    exact(result['series_ledger'],ledger,'result scope ledger')
    # Detect source/input mutation during the numerical read/check interval.
    pin_index(r['files']); pin_index(result['outputs'])
    external(request_path,request_sha); external(result_path,result_sha)
    return dict(schema='q26-original24-independent-control-check-v1',scope=SCOPE,
                request_sha256=request_sha,result_sha256=result_sha,complete=True,
                exact_original_private_pairs=191,exact_original_native_views=54,
                exact_canonical_adapter_views=54,unexecuted_series=253,
                original_J=identity,full277_scientific_coverage=False,scientific_acceptance=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request',required=True);parser.add_argument('--request-sha256',required=True)
    parser.add_argument('--result',required=True);parser.add_argument('--result-sha256',required=True)
    args=parser.parse_args()
    print(json.dumps(check(args.request,args.request_sha256,args.result,args.result_sha256),allow_nan=False,separators=(',',':')))


if __name__ == '__main__':
    main()
