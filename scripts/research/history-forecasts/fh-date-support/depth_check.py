"""Independent fixed-cohort depth-accounting adapter and saved verifier.

Original scientific arithmetic is shared and pinned. New producer code is never
imported. Cohort wiring, tie-batched ECDF counts and rational derivation are own.
No fit, prediction, cross-vintage contrast or older-reference calculation.
"""
import argparse
import contextlib
from fractions import Fraction
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import sys
import types
import zipfile

import numpy as np

CAPACITY = 200000
MAX_BYTES = 67108864
ROLES = {'producer_request', 'result', 'basis', 'started', 'producer_source',
         'terminal', 'checker_source', 'python', 'support_module', 'support_request',
         'plan', 'acceptance', 'witness', 'audit', 'checker'}
WITNESS = {'main_index': '<i8', 'main_label_end': '<i8', 'main_state': 'i1',
           'D_original': '<f4', 'unknown_partition': 'i1'}
FIELDS = dict(WITNESS)
for _v in ('current', 'previous'):
    FIELDS.update({_v+'_sigma': '<f8', _v+'_z': '<f8', _v+'_valid': '?',
                   _v+'_knots': '<f8', _v+'_counts': '<i8'})
NAMES = ('date_gap', 'common_composition', 'common_within', 'unknown_net',
         'composition_lower', 'composition_upper', 'within_lower', 'within_upper')
CLAIMS = 'Descriptive current-cohort reconstruction and exact accounting only. No fits, predictions, scores, imputation, causal attribution, sampling intervals or forecasting improvement.'


def need(ok, why):
    if not ok:
        raise ValueError(why)


def canonical(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and
         not any(x.is_symlink() for x in (p, *p.parents)), 'canonical nonsymlink path')
    return p


def pin(path):
    p = canonical(path)
    need(p.is_file(), 'regular file')
    h = hashlib.sha256()
    size = 0
    with p.open('rb') as stream:
        for b in iter(lambda: stream.read(1048576), b''):
            size += len(b)
            h.update(b)
    return dict(path=str(p), size=size, sha256=h.hexdigest())


def check(value):
    need(type(value) is dict and set(value) == {'path', 'size', 'sha256'} and
         type(value['size']) is int and value['size'] >= 0, 'exact byte pin')
    need(pin(value['path']) == value, 'byte pin mismatch')
    return Path(value['path'])


def read(path):
    def pairs(items):
        out = {}
        for k, v in items:
            need(k not in out, 'duplicate JSON key')
            out[k] = v
        return out
    def bad(_):
        raise ValueError('nonfinite JSON')
    return json.loads(Path(path).read_bytes(), object_pairs_hook=pairs, parse_constant=bad)


def module(value, name):
    p = check(value)
    out = types.ModuleType(name)
    out.__file__ = str(p)
    exec(compile(p.read_bytes(), str(p), 'exec'), out.__dict__)
    return out


def tree(actual, expected, why='exact saved tree'):
    need(type(actual) is type(expected), why+' type')
    if isinstance(expected, dict):
        need(set(actual) == set(expected), why+' keys')
        for key in expected:
            tree(actual[key], expected[key], why+'/'+str(key))
    elif isinstance(expected, list):
        need(len(actual) == len(expected), why+' length')
        for i, (a, b) in enumerate(zip(actual, expected)):
            tree(a, b, why+'/'+str(i))
    else:
        need(actual == expected, why+' value')


def scope_claims(value):
    need(type(value) is str and value == CLAIMS, 'exact bounded claims')


def terminal_check(body, pins, producer_request, plan):
    need(set(body) == {'schema', 'request', 'argv', 'complete', 'exit_code', 'reaped',
                       'no_live_members', 'elapsed_seconds', 'charged_seconds', 'output_pins'}, 'terminal schema')
    need(body['schema'] == 'q26-fh-depth-producer-terminal-v1' and body['complete'] is True and
         type(body['exit_code']) is int and body['exit_code'] == 0 and body['reaped'] is True and
         body['no_live_members'] is True and body['request'] == pins['producer_request'], 'accepted producer terminal')
    elapsed = body['elapsed_seconds']
    need(type(elapsed) in (int, float) and math.isfinite(elapsed) and 0 <= elapsed <= 60 and
         type(body['charged_seconds']) is int and body['charged_seconds'] == math.ceil(elapsed), 'finite producer charge')
    expected = [plan['runtime']['python_path'], '-B', pins['producer_source']['path'],
                '--request', pins['producer_request']['path'], '--request-sha256',
                pins['producer_request']['sha256'], '--out', producer_request['out']]
    tree(body['argv'], expected, 'sealed producer argv')
    tree(body['output_pins'], {k: pins[k] for k in ('result', 'basis', 'started')}, 'terminal outputs')


def authenticate(path, external_sha):
    p = canonical(path)
    need(p.stat().st_size <= 65536 and pin(p)['sha256'] == external_sha, 'external bounded request SHA')
    q = read(p)
    need(set(q) == {'schema', 'pins', 'out'} and q['schema'] == 'q26-fh-depth-check-request-v1', 'checker request schema')
    need(set(q['pins']) == ROLES, 'checker exact roles')
    pins = q['pins']
    for value in pins.values():
        check(value)
    need(pins['producer_request']['size'] <= 65536 and pins['terminal']['size'] <= 65536 and
         pins['started']['size'] <= 4096, 'bounded new authority metadata')
    need(pins['checker_source'] == pin(Path(__file__).absolute()) and
         Path(pins['python']['path']) == Path(sys.executable).resolve(), 'executed checker/runtime')
    support = module(pins['support_module'], '_depth_check_old_support')
    _, plan, _ = support.authenticate(pins['support_request']['path'], pins['support_request']['sha256'])
    old = read(pins['support_request']['path'])['pins']
    for role in ('plan', 'acceptance', 'witness', 'python'):
        tree(old[role], pins[role], 'original accepted chain')
    tree(old['implementation'], pins['support_module'], 'original support source')
    tree(plan['roles']['audit'], pins['audit'], 'original audit')
    tree(plan['roles']['checker'], pins['checker'], 'original checker')
    oldchecker = module(pins['checker'], '_depth_check_old_metadata')
    metadata = oldchecker.authenticate(plan, pins['plan']['sha256'])
    producer = read(pins['producer_request']['path'])
    need(set(producer) == {'schema', 'pins', 'out'} and producer['schema'] == 'q26-fh-depth-accounting-request-v1', 'producer request schema')
    expected_roles = {'plan', 'result', 'acceptance', 'witness', 'started', 'audit', 'checker',
                      'source', 'python', 'support_module', 'support_request'}
    need(set(producer['pins']) == expected_roles, 'producer request roles')
    for role in ('plan', 'acceptance', 'witness', 'audit', 'checker', 'python', 'support_module', 'support_request'):
        tree(producer['pins'][role], pins[role], 'producer original authority')
    for role in ('result', 'started'):
        tree(producer['pins'][role], old[role], 'producer old outputs')
    tree(producer['pins']['source'], pins['producer_source'], 'producer source identity')
    root = canonical(producer['out'])
    need(root.is_dir() and root.stat().st_mode & 0o777 == 0o700 and
         not root.is_relative_to(canonical(plan['out'])), 'new producer private root')
    inventory(root, {'started.json', 'basis.npz', 'result.json'})
    for role, filename in [('result', 'result.json'), ('basis', 'basis.npz'), ('started', 'started.json')]:
        need(Path(pins[role]['path']) == root/filename, 'new exact output pin')
    need(pins['result']['size'] <= 4194304 and pins['basis']['size'] <= MAX_BYTES, 'bounded saved outputs')
    result = read(pins['result']['path'])
    need(set(result) == {'schema', 'label', 'complete', 'request_sha256', 'request_pins', 'reconstruction',
                        'historical_bridge_parity', 'accepted_witness_all_five_bit_identity', 'source',
                        'basis', 'started', 'vintages', 'cross_vintage_contrast', 'claims'}, 'new result schema')
    need(result['schema'] == 'q26-fh-depth-accounting-result-v1' and result['label'] == 'CODEX CONTINUATION' and
         result['complete'] is True and result['reconstruction'] is True and
         result['historical_bridge_parity'] == 'UNAVAILABLE' and result['accepted_witness_all_five_bit_identity'] is True and
         result['cross_vintage_contrast'] == 'NOT_COMPUTED', 'result scope')
    scope_claims(result['claims'])
    tree(result['request_pins'], producer['pins'], 'saved producer request pins')
    need(result['request_sha256'] == pins['producer_request']['sha256'], 'producer request digest')
    for role in ('basis', 'started'):
        tree(result[role], pins[role], 'new output binding')
    tree(result['source'], pins['producer_source'], 'saved source')
    tree(read(pins['started']['path']), dict(schema='q26-fh-depth-accounting-started-v1',
         request_sha256=pins['producer_request']['sha256'], reconstruction=True), 'new started marker')
    terminal_check(read(pins['terminal']['path']), pins, producer, plan)
    receipt = canonical(q['out'])
    need(not receipt.exists() and receipt.parent.is_dir() and
         not receipt.is_relative_to(root) and not receipt.is_relative_to(canonical(plan['out'])), 'fresh external acceptance')
    # Original support authentication checked accepted witness headers, without decoding.
    basis_headers(pins['basis']['path'])
    return q, plan, metadata, result, producer


def inventory(root, names):
    need({p.name for p in root.iterdir()} == names and
         all(p.is_file() and not p.is_symlink() and p.stat().st_mode & 0o777 == 0o600 for p in root.iterdir()), 'exact private inventory')


def basis_headers(path):
    need(Path(path).stat().st_size <= MAX_BYTES, 'bounded compressed basis')
    shapes = {}
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        need(len(entries) == len(FIELDS) and {v.filename for v in entries} == {k+'.npy' for k in FIELDS}, 'exact basis members')
        need(sum(v.file_size for v in entries) <= MAX_BYTES, 'bounded expanded basis')
        for member in entries:
            need(not member.flag_bits & 1 and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'plain bounded NPY transport')
            key = member.filename[:-4]
            with archive.open(member) as stream:
                version = np.lib.format.read_magic(stream)
                need(version in ((1, 0), (2, 0)), 'NPY version')
                reader = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
                shape, order, dtype = reader(stream)
                rank = 2 if key.endswith('_counts') else 1
                need(len(shape) == rank and all(type(v) is int and v >= 0 for v in shape) and
                     shape[0] <= CAPACITY+(rank == 2) and not order and dtype == np.dtype(FIELDS[key]), 'bounded typed NPY shape')
                if rank == 2:
                    need(shape[1] == 6, 'six count columns')
                size = math.prod(shape)*dtype.itemsize
                need(member.file_size == stream.tell()+size, 'exact NPY payload bytes')
                shapes[key] = shape
    n = shapes['main_index'][0]
    need(all(shapes[k] == (n,) for k in WITNESS), 'all five aligned witness headers')
    for v in ('current', 'previous'):
        need(shapes[v+'_sigma'] == shapes[v+'_z'] == shapes[v+'_valid'] and shapes[v+'_z'][0] in (0, n), 'whole-vintage header shape')
        m = shapes[v+'_knots'][0]
        need(m <= n and shapes[v+'_counts'] in ((m+1, 6), (0, 6)) and
             (shapes[v+'_counts'] != (0, 6) or m == 0), 'full support header shapes')
        if n and shapes[v+'_sigma'] == (0,):
            need(m == 0 and shapes[v+'_counts'] == (0, 6), 'missing vintage has no empirical basis')


@contextlib.contextmanager
def no_models(A6, M2):
    def forbidden(*a, **k):
        raise RuntimeError('fit/prediction forbidden')
    targets = [(np.linalg, k) for k in ('solve', 'lstsq')]
    targets += [(A6.Prep6, k) for k in ('har_coef', 'fh_w', 'asof_rows', 'map_rows', 'beta_maps') if hasattr(A6.Prep6, k)]
    targets += [(M2, 'fhs_predict')]
    saved = [(obj, name, getattr(obj, name)) for obj, name in targets]
    for obj, name, _ in saved:
        setattr(obj, name, forbidden)
    try:
        yield
    finally:
        for obj, name, value in saved:
            setattr(obj, name, value)


def retained_record(prep, ser, record):
    q = record['quarter_cutoff']
    need(type(q) is int and (q-ser.base_ts) % 3600 == 0, 'record own clock')
    limit = (q-ser.base_ts)//3600
    mature = [i for i in range(prep.n) if i+24 <= limit]
    reg = [i for i in mature if bool(prep.okH[i])]
    need(type(record['n_reg']) is int and record['n_reg'] == len(reg), 'own regression count')
    coef = record['coef']
    missing = coef is None
    need(missing == (len(reg) < 4), 'own None coefficient rule')
    if not missing:
        coef = np.asarray(coef, dtype='<f8')
        need(coef.shape == (4,) and np.isfinite(coef).all(), 'original coefficient shape')
    sigma = prep.sigma_H(coef)
    z, valid = prep.z_of(sigma)
    need(sigma.dtype == z.dtype == np.dtype('<f8') and valid.dtype == bool and
         sigma.shape == z.shape == valid.shape == (prep.n,), 'whole original arrays')
    main = [i for i in mature if bool(valid[i])]
    fallback = [i for i in mature if bool(prep.P.valid[1.][i])]
    def end(values):
        return None if not values else int(ser.base_ts+3600*(values[-1]+24))
    expected = dict(har_label_end_max=end(reg), har_label_end_min=None if not reg else
                    int(ser.base_ts+3600*(reg[0]+24)), library_label_end_max=end(main),
                    fallback_library_label_end_max=end(fallback))
    need(all(record[k] == value and (value is None or value <= q) for k, value in expected.items()), 'own maturity extrema')
    return (None, None, None, main) if missing else (sigma, z, valid, main)


def vintage_rows(sigma, z, valid, indices):
    if sigma is None:
        need(z is None and valid is None, 'None triple')
        return dict(sigma=np.empty(0, '<f8'), z=np.empty(0, '<f8'), valid=np.empty(0, bool)), dict(
            available=False, reason='missing_predecessor_coefficient', stored_fixed_rows=0,
            invalid_rows=None, nonfinite_sigma_rows=None, nonpositive_sigma_rows=None, nonfinite_z_rows=None)
    rows = dict(sigma=sigma[indices].copy(), z=z[indices].copy(), valid=valid[indices].copy())
    a = sum(not bool(x) for x in rows['valid'])
    b = sum(not math.isfinite(float(x)) for x in rows['sigma'])
    c = sum(float(x) <= 0 for x in rows['sigma'])
    d = sum(not math.isfinite(float(x)) for x in rows['z'])
    okay = not (a or b or c or d)
    return rows, dict(available=okay, reason=None if okay else 'invalid_or_nonfinite_fixed_rows',
                     stored_fixed_rows=len(indices), invalid_rows=a, nonfinite_sigma_rows=b,
                     nonpositive_sigma_rows=c, nonfinite_z_rows=d)


def reconstruct(plan, metadata):
    stage, raw, manifest, cut = metadata
    staging = module(plan['roles']['staging_producer'], '_depth_check_original_staging')
    census = module(plan['roles']['census'], '_depth_check_original_census')
    finder = staging.FrozenSources([p['path'] for p in plan['legacy_sources'].values()])
    need(not (set(finder.paths) & set(sys.modules)), 'cold original source closure')
    sys.meta_path.insert(0, finder)
    oldpath = list(sys.path)
    try:
        with staging.guard([p['path'] for p in plan['files']], Path(plan['out'])):
            R12, A6, D, M2 = [importlib.import_module(k) for k in ('r12_tail', 'a6_touch', 'r16_dev', 'a2_touch')]
            pilot = plan['pilot']
            candidates = [p['path'] for p in raw['price_inputs'] if
                          Path(p['path']).parent == Path(raw['datasets'])/'blind6-prices' and
                          Path(p['path']).name.endswith('-1h.json') and
                          'blind6:'+Path(p['path']).name.split('-')[1] == pilot['key']]
            need(len(candidates) == 1 and candidates[0] in stage['required_raw_paths'], 'original fixed grid spec')
            spec = dict(kind='grid', key=pilot['key'], path=candidates[0])
            groups = [g for g in manifest['series_horizons'] if g['sid'] == pilot['sid'] and g['horizon'] == 24]
            need(len(groups) == 1, 'one H24 retained group')
            records = {}
            for v, key in [('current', 'current_cutoff'), ('previous', 'previous_cutoff')]:
                matches = [r for r in groups[0]['quarters'] if r['quarter_cutoff'] == pilot[key]]
                need(len(matches) == 1, 'one retained cutoff record')
                records[v] = matches[0]
            with no_models(A6, M2):
                ser, _, _ = R12.load_series(spec)
                need(type(ser.base_ts) is int and len(ser.close)+1 <= CAPACITY, 'whole grid capacity')
                prep = A6.Prep6(ser, 24, with_fbL=False)
                need(type(prep.n) is int and prep.n == len(ser.close)+1, 'full preparer shape')
                vintages = {v: retained_record(prep, ser, records[v]) for v in ('current', 'previous')}
                need(vintages['current'][0] is not None, 'current coefficient required')
                indices = np.asarray(vintages['current'][3], dtype='<i8')
                feature = census.downside_feature(D.realized(ser), staging.sanitize)
                need(feature.dtype == np.dtype('<f4') and feature.shape == (prep.n,), 'original float32 D')
                states = census.states_of(feature, cut)
                ends = np.asarray([ser.base_ts+3600*(int(i)+24) for i in indices], dtype='<i8')
                part = np.asarray([-1 if int(states[i]) != -1 else
                                   0 if int(t) < pilot['previous_cutoff'] else
                                   1 if int(t) == pilot['previous_cutoff'] else 2
                                   for i, t in zip(indices, ends)], dtype='i1')
                arrays = dict(main_index=indices, main_label_end=ends, main_state=states[indices].copy(),
                              D_original=feature[indices].copy(), unknown_partition=part)
                status = {}
                for v in ('current', 'previous'):
                    rows, status[v] = vintage_rows(*vintages[v][:3], indices)
                    arrays.update({v+'_'+k: value for k, value in rows.items()})
                return arrays, status
    finally:
        sys.meta_path.remove(finder)
        sys.path[:] = oldpath


def exact_arrays(actual, expected):
    need(set(actual) == set(expected), 'exact array field set')
    for key in expected:
        a, b = actual[key], expected[key]
        need(a.dtype == b.dtype and a.shape == b.shape and a.tobytes() == b.tobytes(), 'typed byte parity '+key)


def frac(v):
    return dict(numerator=str(v.numerator), denominator=str(v.denominator))


def cdf_forms(totals):
    nr, no = sum(totals[0::2]), sum(totals[1::2])
    need(nr > 0 and no > 0 and totals[4] == 0 and totals[5] > 0 and
         all(totals[i] > 0 for i in (0, 1, 2, 3)), 'fixed common and unknown support')
    alpha = Fraction(totals[5], no)
    def evaluate(count):
        delta = Fraction(sum(count[i] for i in (0, 2, 4) if totals[i]), nr)-Fraction(sum(count[i] for i in (1, 3, 5)), no)
        ck, wk = Fraction(0), Fraction(0)
        for i in (0, 2):
            r, o = Fraction(totals[i], nr), Fraction(totals[i+1], no)
            a, b = Fraction(count[i], totals[i]), Fraction(count[i+1], totals[i+1])
            ck += (r-o)*(a+b)/2
            wk += (r+o)*(a-b)/2
        f = Fraction(count[5], totals[5])
        return dict(date_gap=delta, common_composition=ck, common_within=wk, unknown_net=-alpha*f,
                    composition_lower=ck-alpha*(1+f)/2, composition_upper=ck-alpha*f/2,
                    within_lower=wk-alpha*f/2, within_upper=wk+alpha*(1-f)/2)
    zero = evaluate([0]*6)
    columns = []
    for i in range(6):
        unit = [0]*6
        unit[i] = 1
        val = evaluate(unit)
        columns.append({k: val[k]-zero[k] if totals[i] else Fraction(0) for k in NAMES})
    rational = {k: [col[k] for col in columns]+[zero[k]] for k in NAMES}
    den = math.lcm(*(v.denominator for row in rational.values() for v in row))
    coeff = {k: [int(v*den) for v in rational[k]] for k in NAMES}
    for i in range(7):
        need(coeff['date_gap'][i] == coeff['common_composition'][i]+coeff['common_within'][i]+coeff['unknown_net'][i], 'observed coefficient identity')
        need(coeff['date_gap'][i] == coeff['composition_lower'][i]+coeff['within_upper'][i] ==
             coeff['composition_upper'][i]+coeff['within_lower'][i], 'linked coefficient identity')
    return den, coeff, alpha


def recount(z, states, ends, previous):
    need(z.dtype == np.dtype('<f8') and states.dtype == np.dtype('i1') and ends.dtype == np.dtype('<i8') and
         z.ndim == states.ndim == ends.ndim == 1 and 0 < len(z) == len(states) == len(ends) <= CAPACITY, 'typed finite complete rows')
    totals, ordered = [0]*6, []
    for value, state, t in zip(z, states, ends):
        state, t, value = int(state), int(t), float(value)
        need(state in (0, 1, -1) and math.isfinite(value), 'original state and finite depth')
        need(state != -1 or t < previous, 'unknown strictly older')
        cell = 2*((0, 1, -1).index(state))+(t <= previous)
        totals[cell] += 1
        ordered.append((0.0 if value == 0 else value, cell))
    den, coeff, alpha = cdf_forms(totals)
    ordered.sort(key=lambda row: row[0])
    table, knots, counts = [[0]*6], [], [0]*6
    i = 0
    while i < len(ordered):
        u = ordered[i][0]
        while i < len(ordered) and ordered[i][0] == u:
            counts[ordered[i][1]] += 1
            i += 1
        knots.append(u)
        table.append(counts.copy())
    maxima = {k: 0 for k in NAMES}
    width = int(alpha*den/2)
    for row in table:
        value = {k: sum(a*b for a, b in zip(coeff[k], row+[1])) for k in NAMES}
        need(value['date_gap'] == value['common_composition']+value['common_within']+value['unknown_net'], 'observed count identity')
        need(value['date_gap'] == value['composition_lower']+value['within_upper'] ==
             value['composition_upper']+value['within_lower'], 'linked count identity')
        need(value['composition_upper']-value['composition_lower'] == value['within_upper']-value['within_lower'] == width, 'exact width')
        for k in NAMES:
            maxima[k] = max(maxima[k], abs(value[k]))
    report = dict(schema='q26-fh-depth-accounting-kernel-v1', available=True, rows=len(z),
        date_rows=[sum(totals[0::2]),sum(totals[1::2])], state_date_rows=totals,
        cell_order=[[s,d] for s in (0,1,-1) for d in ('recent','older')], common_denominator=str(den),
        integer_coefficients={k:[str(v) for v in coeff[k]] for k in NAMES}, constant_column=1,
        count_rows=len(table), observed_knots=len(knots), left_state=dict(kind='BEFORE_MIN',
        finite_exact_coordinate=frac(Fraction.from_float(knots[0])-1), count_row=0,
        interpretation='Finite threshold below every observed depth, not a CDF value at minus infinity.'),
        alpha_older_unknown_over_older_all=frac(alpha), each_allocation_width=frac(alpha/2),
        suprema={k:frac(Fraction(maxima[k],den)) for k in NAMES}, observed_identity_verified=True,
        linked_endpoint_identity_verified=True, original_full_decomposition='UNAVAILABLE',
        interpretation='Observed date_gap=common_composition+common_within+unknown_net. Bounds are linked hypothetical missing-CDF allocations, not fitted distributions or uncertainty intervals.')
    return report, np.asarray(knots,dtype='<f8'), np.asarray(table,dtype='<i8')


def verify_saved(basis, actual, status, accepted, pilot):
    need(set(basis) == set(FIELDS), 'full saved field set')
    exact_arrays({k:actual[k] for k in WITNESS}, accepted)
    exact_arrays({k:basis[k] for k in actual}, actual)
    expected_reports = {}
    for v in ('current','previous'):
        if status[v]['available']:
            report, knots, counts = recount(actual[v+'_z'],actual['main_state'],actual['main_label_end'],pilot['previous_cutoff'])
            expected_reports[v] = dict(report,vintage_status=status[v])
        else:
            knots, counts = np.empty(0,'<f8'), np.empty((0,6),'<i8')
            expected_reports[v] = dict(available=False,vintage_status=status[v],original_full_decomposition='UNAVAILABLE')
        exact_arrays({v+'_knots':basis[v+'_knots'],v+'_counts':basis[v+'_counts']},
                     {v+'_knots':knots,v+'_counts':counts})
    return expected_reports


def run(path, external_sha):
    q, plan, metadata, result, producer = authenticate(path, external_sha)
    pins = q['pins']
    with np.load(pins['witness']['path'], allow_pickle=False) as saved:
        accepted = {k:saved[k] for k in WITNESS}
    with np.load(pins['basis']['path'], allow_pickle=False) as saved:
        need(set(saved.files) == set(FIELDS) and len(saved.files) == len(FIELDS), 'full basis fields')
        basis = {k:saved[k] for k in FIELDS}
    actual, status = reconstruct(plan, metadata)
    expected_reports = verify_saved(basis,actual,status,accepted,plan['pilot'])
    tree(result['vintages'],expected_reports,'independent complete accounting')
    final_checks(q,plan,producer,path,external_sha)
    receipt = dict(schema='q26-fh-depth-check-acceptance-v1', label='CODEX CONTINUATION', complete=True,
        reconstruction=True,historical_bridge_parity='UNAVAILABLE',request_sha256=external_sha,
        result_sha256=pins['result']['sha256'],producer_terminal=pins['terminal'],checker_source=pins['checker_source'],
        proof=dict(all_five_accepted_witness_fields_exact=True,all_fixed_current_cohort_vintage_arrays_exact=True,
        own_cutoff_metadata_verified=True,complete_tie_batched_counts_verified=True,
        exact_rational_forms_suprema_and_linked_identities_verified=True,
        finite_left_and_right_states_retained_for_available_vintages=True,whole_vintage_unavailability_verified=True,
        independent_original_model_arithmetic=False,new_producer_imported=False,new_fits=False,new_predictions=False,
        cross_vintage_contrast_computed=False))
    payload=(json.dumps(receipt,sort_keys=True,allow_nan=False)+'\n').encode()
    fd=os.open(canonical(q['out']),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(payload);stream.flush();os.fsync(stream.fileno())
    return receipt


def final_checks(q,plan,producer,path,external_sha):
    pins=q['pins']
    for value in pins.values():
        check(value)
    for value in plan['files']:
        check(value)
    # Old result/started are nested authorities, not new result/started roles.
    for value in read(pins['support_request']['path'])['pins'].values():
        check(value)
    need(pin(path)['sha256'] == external_sha,'final checker request unchanged')
    inventory(canonical(producer['out']),{'started.json','basis.npz','result.json'})
    inventory(canonical(plan['out']),{'started.json','witness.npz','result.json'})


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--request',required=True)
    parser.add_argument('--request-sha256',required=True)
    args=parser.parse_args()
    run(args.request,args.request_sha256)
