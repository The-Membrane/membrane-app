"""Saved O81 forecast adapter — CODEX CONTINUATION; no model reconstruction.

The pure reducer accepts synthetic or separately admitted decoded arrays. Transport
requires an externally hashed parent request; merely importing this file admits no
historical data. Original saved rows are declared available by the O81 contract.
"""
import argparse
import ast
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
import zipfile
from fractions import Fraction

import numpy as np

HORIZONS = (6, 12, 24, 72, 168)
BARRIERS = (-.4, -.2, -.1, -.05, -.02)
ARMS = ('baseline_raw', 'linear_projected', 'xgb_base_projected', 'xgb_shape_projected')
CONTROLS = ('baseline_raw', 'baseline_clipped_control', 'linear_raw', 'linear_projected',
            'xgb_base_raw', 'xgb_base_projected', 'xgb_shape_raw', 'xgb_shape_projected')
FIELDS = ('sid', 'ts', 'y', 'label_valid') + CONTROLS
EPS = 1e-6
START, YEAR25, END = 1704067200, 1735689600, 1767225600
PAIRED_DELTA_CONTRACT = ('Brier and sum_probability use exact binary64 dyadic differences; '
                         'displayed values round exact totals once. Bounded log loss uses paired '
                         'binary64 logs and fsum with compatibility-only comparison; no exact tiny log-loss direction claim.')


def need(condition, message):
    if not condition:
        raise ValueError(message)


JSON_CAP, OUTPUT_CAP = 16*1024**2, 64*1024**2


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def nonfinite(value):
        raise ValueError('nonfinite JSON constant: ' + value)
    def finite_float(value):
        result = float(value); need(math.isfinite(result), 'nonfinite JSON number')
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite, parse_float=finite_float)


def fraction_record(value):
    return [str(value.numerator), str(value.denominator)]


def pin(path):
    path = Path(path)
    need(path.is_absolute() and str(path.resolve()) == str(path) and not path.is_symlink(), 'canonical file path')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return dict(path=str(path), size=path.stat().st_size, sha256=h.hexdigest())


def checked(record):
    need(isinstance(record, dict) and set(record) == {'path', 'size', 'sha256'}, 'three-field pin')
    need(pin(record['path']) == record, 'file pin changed')
    return Path(record['path'])


def validate_archive(data, allowed_sids, row_capacity=200000):
    need(set(data) == set(FIELDS), 'saved archive exact fields')
    n = len(data['sid'])
    need(n <= row_capacity, 'row capacity')
    for name, dtype, shape in [('sid', 'int32', (n,)), ('ts', 'int64', (n,)),
                               ('y', 'uint8', (n, 5)), ('label_valid', 'bool', (n,))]:
        a = data[name]
        need(isinstance(a, np.ndarray) and a.dtype == np.dtype(dtype) and a.shape == shape,
             'saved field geometry: ' + name)
    need(np.all((data['ts'] >= START) & (data['ts'] < END) & (data['ts'] % 86400 == 0)), 'UTC evaluation clock')
    need(set(map(int, data['sid'])) <= set(allowed_sids), 'canonical SID membership')
    keys = list(zip(map(int, data['sid']), map(int, data['ts'])))
    need(len(set(keys)) == n, 'duplicate canonical issuance key')
    valid_y = data['y'][data['label_valid']]
    need(np.all((valid_y == 0) | (valid_y == 1)), 'observed labels binary')
    need(np.all(valid_y[:, 1:] >= valid_y[:, :-1]), 'observed labels barrier ordered')
    for name in CONTROLS:
        a = data[name]
        need(isinstance(a, np.ndarray) and a.dtype == np.dtype('float64') and a.shape == (n, 5),
             'saved probability geometry: ' + name)
        need(np.isfinite(a).all() and np.all((a >= 0) & (a <= 1)), 'declared available probability invalid')
    for name in ARMS:
        need(np.all(data[name][:, 1:] >= data[name][:, :-1]), 'candidate source barrier order')
    return {key: i for i, key in enumerate(keys)}


def metrics(y, p, baseline, sid, ts):
    """Preserve original O81 float64 score arithmetic and original fields."""
    n = len(y)
    if not n:
        return {'status': 'no_scored_rows', 'n': 0}
    y = y.astype(float); p = p.astype(float)
    clipped = np.clip(p, EPS, 1 - EPS)
    brier = float(np.mean((p - y) ** 2)); ref = float(np.mean((baseline - y) ** 2))
    events = int(y.sum()); expected = float(p.sum())
    return dict(status='scored', n=n, series=len(np.unique(sid)), utc_epoch_weeks=len(np.unique(ts // 604800)),
                events=events, sum_probability=expected, brier=brier, baseline_raw_brier=ref,
                bss=None if ref == 0 else 1 - brier / ref,
                bss_status='undefined_zero_baseline_loss' if ref == 0 else 'defined',
                bounded_logloss=float(np.mean(-y * np.log(clipped) - (1-y) * np.log1p(-clipped))),
                logloss_clipped_predictions=int(((p < EPS) | (p > 1-EPS)).sum()),
                observed_over_expected=None if expected == 0 else events / expected,
                observed_over_expected_status='undefined_zero_expected' if expected == 0 else 'defined',
                expected_over_observed=None if events == 0 else expected / events,
                expected_over_observed_status='undefined_zero_events' if events == 0 else 'defined')


def missing_bounds(y, p, baseline, valid):
    n = len(y); known = valid; unknown = ~known
    if not n:
        return dict(status='no_issued_rows', n=0, unknown_rows=0, mean_d_lower=None,
                    mean_d_upper=None, scope='missing-label sensitivity bounds, not confidence intervals')
    d0 = p*p - baseline*baseline; d1 = (p-1)**2 - (baseline-1)**2
    known_sum = float(np.where(y[known] == 1, d1[known], d0[known]).sum())
    return dict(status='bounded', n=n, known_rows=int(known.sum()), unknown_rows=int(unknown.sum()),
                known_sum_d=known_sum,
                mean_d_lower=(known_sum + float(np.minimum(d0[unknown], d1[unknown]).sum())) / n,
                mean_d_upper=(known_sum + float(np.maximum(d0[unknown], d1[unknown]).sum())) / n,
                scope='missing-label sensitivity bounds, not confidence intervals')


def summarize(data, predictions, h, sids):
    """All original group views; no outcome-defined projection membership."""
    sid, ts, y, valid = (data[k] for k in ('sid', 'ts', 'y', 'label_valid'))
    groups = [('all', 'all', np.ones(len(ts), bool)), ('year', '2024', ts < YEAR25),
              ('year', '2025', ts >= YEAR25)]
    groups += [('asset', str(s), sid == s) for s in sids]
    scores, bounds, descriptive = [], [], []
    for kind, key, mask in groups:
        scored = mask & valid
        for name, probs in predictions.items():
            for j, barrier in enumerate(BARRIERS):
                identity = dict(horizon_hours=h, group_type=kind, group=key, prediction=name, barrier=barrier)
                scores.append({**identity, **metrics(y[scored, j], probs[scored, j],
                                                     data['baseline_raw'][scored, j], sid[scored], ts[scored])})
                bounds.append({**identity, **missing_bounds(y[mask, j], probs[mask, j],
                                                            data['baseline_raw'][mask, j], valid[mask])})
                n = int(scored.sum())
                descriptive.append({**identity, 'issued_rows': int(mask.sum()), 'scored_rows': n,
                                    'unknown_labels': int((mask & ~valid).sum()),
                                    'mean_prediction': float(probs[scored, j].mean()) if n else None,
                                    'observed_frequency': float(y[scored, j].mean()) if n else None,
                                    'signed_error': float((probs[scored, j] - y[scored, j]).mean()) if n else None})
    return dict(scores=scores, missing_label_sensitivity=bounds, descriptive=descriptive)


def reconcile_native(observed, accepted):
    """Use prospectively fixed historical metric compatibility, never for keys/counts."""
    float_fields = {'sum_probability', 'brier', 'baseline_raw_brier', 'bss', 'bounded_logloss',
                    'observed_over_expected', 'expected_over_observed', 'known_sum_d',
                    'mean_d_lower', 'mean_d_upper'}
    for field in ('scores', 'missing_label_sensitivity'):
        identity = lambda r: tuple(r[k] for k in ('horizon_hours', 'group_type', 'group', 'prediction', 'barrier'))
        actual = {identity(r): r for r in observed[field]}
        expected = {identity(r): r for r in accepted[field]}
        need(len(actual) == len(observed[field]) and len(expected) == len(accepted[field]), 'duplicate native metric key')
        need(set(actual) == set(expected), 'unchanged native metric key inventory')
        for key, row in actual.items():
            target = expected[key]
            need(set(row) == set(target), 'unchanged native metric fields')
            for name, value in row.items():
                other = target[name]
                compatible = (type(value) is float and type(other) is float and
                              math.isfinite(value) and math.isfinite(other) and
                              math.isclose(value, other, rel_tol=2e-11, abs_tol=2e-12))
                need(compatible if name in float_fields and value is not None and other is not None
                     else type(value) is type(other) and value == other,
                     'unchanged native point metric parity: ' + field + '/' + name)


def paired_delta(y, candidate, original):
    """Exact dyadic Brier/probability deltas; compatibility-only paired log loss."""
    n = len(y)
    if not n:
        return dict.fromkeys(('brier', 'bounded_logloss', 'sum_probability', 'exact_brier',
                              'exact_sum_probability', 'brier_direction', 'sum_probability_direction'))
    pairs = [(float(q).as_integer_ratio(), float(p).as_integer_ratio(), int(label))
             for label, q, p in zip(y, candidate, original)]
    exponent = max(max(q[1].bit_length(), p[1].bit_length())-1 for q, p, label in pairs)
    scale = 1 << exponent; probability_numerator = brier_numerator = 0
    for (qn, qd), (pn, pd), label in pairs:
        qi = qn << (exponent-(qd.bit_length()-1)); pi = pn << (exponent-(pd.bit_length()-1))
        difference = qi-pi
        probability_numerator += difference
        brier_numerator += qi*qi-pi*pi-2*label*scale*difference
    probability = Fraction(probability_numerator, scale)
    brier = Fraction(brier_numerator, n*scale*scale)
    direction = lambda value: 'negative' if value < 0 else 'positive' if value > 0 else 'zero'
    y = y.astype(float)
    cp, op = np.clip(candidate, EPS, 1-EPS), np.clip(original, EPS, 1-EPS)
    candidate_ll = -y*np.log(cp) - (1-y)*np.log1p(-cp)
    original_ll = -y*np.log(op) - (1-y)*np.log1p(-op)
    return dict(brier=float(brier), exact_brier=fraction_record(brier), brier_direction=direction(brier),
                bounded_logloss=math.fsum((candidate_ll-original_ll).tolist()) / n,
                sum_probability=float(probability), exact_sum_probability=fraction_record(probability),
                sum_probability_direction=direction(probability))


def reduce_saved(archives, canonical_mapping, project, accepted_horizons=None):
    """Pure saved-row reduction. `project` is the qualified exact grid kernel.

    Returns fresh candidate-only per-horizon arrays and JSON-compatible accounting.
    Archived rows are all declared available. Missing horizon keys are partial
    grids; their native predictions remain byte-identical, including signed zero.
    """
    need(set(archives) == set(HORIZONS), 'all five horizon archives required')
    need(isinstance(canonical_mapping, list) and all(isinstance(v, list) and len(v) == 2 for v in canonical_mapping), 'canonical mapping')
    sids = [int(v[0]) for v in canonical_mapping]
    need(len(set(sids)) == len(sids) and len({v[1] for v in canonical_mapping}) == len(sids), 'unique canonical mapping')
    indices = {h: validate_archive(archives[h], sids) for h in HORIZONS}
    for h in HORIZONS:
        need(set(map(int, archives[h]['sid'])) == set(sids) and
             set(map(int, archives[h]['sid'][archives[h]['label_valid']])) == set(sids),
             'native issued/scored/canonical asset sets must agree')
    native_reports = {h: summarize(archives[h], {a: archives[h][a] for a in CONTROLS}, h, sids)
                      for h in HORIZONS}
    if accepted_horizons is not None:
        for h in HORIZONS: reconcile_native(native_reports[h], accepted_horizons[h])
    union = set().union(*(set(v) for v in indices.values()))
    common = set.intersection(*(set(v) for v in indices.values()))
    # Check nested observed outcomes wherever both original horizon labels exist.
    for a, h1 in enumerate(HORIZONS):
        for h2 in HORIZONS[a+1:]:
            for key in indices[h1].keys() & indices[h2].keys():
                i, j = indices[h1][key], indices[h2][key]
                if archives[h1]['label_valid'][i] and archives[h2]['label_valid'][j]:
                    need(np.all(archives[h1]['y'][i] <= archives[h2]['y'][j]), 'nonnested observed horizon labels')
    output = {h: {k: archives[h][k].copy() for k in ('sid', 'ts', 'y', 'label_valid') + ARMS} for h in HORIZONS}
    for h in HORIZONS:
        output[h]['projected'] = np.zeros(len(archives[h]['sid']), bool)
    totals = {arm: [dict(vectors=0, original=Fraction(0), ideal=Fraction(0), displacement=Fraction(0),
                        represented=Fraction(0), quantization_bound=Fraction(0)) for _ in BARRIERS] for arm in ARMS}
    structure = {a: dict(exact_violations_before=0, diagnostic_violations_before=0,
                         represented_changed_cells=0,
                         quantization_bound_all_J=[Fraction(0) for _ in BARRIERS]) for a in ARMS}
    for key in sorted(common):
        rows = [indices[h][key] for h in HORIZONS]
        valid = all(bool(archives[h]['label_valid'][i]) for h, i in zip(HORIZONS, rows))
        for h, i in zip(HORIZONS, rows):
            output[h]['projected'][i] = True
        for arm in ARMS:
            grid = np.stack([archives[h][arm][i] for h, i in zip(HORIZONS, rows)])
            result = project(grid)
            for h, i, values in zip(HORIZONS, rows, result.probabilities):
                output[h][arm][i] = values
            for hi in range(5):
                for hj in range(hi+1, 5):
                    delta = grid[hi] - grid[hj]
                    structure[arm]['exact_violations_before'] += int((delta > 0).sum())
                    structure[arm]['diagnostic_violations_before'] += int((delta > 1e-12).sum())
            structure[arm]['represented_changed_cells'] += int((grid != result.probabilities).sum())
            for j, col in enumerate(result.columns):
                structure[arm]['quantization_bound_all_J'][j] += col.quantization_bound
            if valid:
                for j, column in enumerate(result.columns):
                    p = tuple(Fraction.from_float(float(v)) for v in grid[:, j])
                    q = column.exact_values
                    represented = tuple(Fraction.from_float(float(v)) for v in result.probabilities[:, j])
                    y = tuple(int(archives[h]['y'][i, j]) for h, i in zip(HORIZONS, rows))
                    loss = lambda v: sum(((a-b)**2 for a, b in zip(v, y)), Fraction(0))
                    t = totals[arm][j]; t['vectors'] += 1
                    t['original'] += loss(p); t['ideal'] += loss(q); t['represented'] += loss(represented)
                    displacement = sum(((a-b)**2 for a, b in zip(p, q)), Fraction(0))
                    need(loss(q) <= loss(p)-displacement, 'ideal theorem fixture/instrument failure')
                    need(abs(loss(represented)-loss(q)) <= column.quantization_bound, 'exact quantization bound failure')
                    t['displacement'] += displacement; t['quantization_bound'] += column.quantization_bound
    reports = []
    for h in HORIZONS:
        data = archives[h]
        native = native_reports[h]
        candidate = summarize(data, {a: output[h][a] for a in ARMS}, h, sids)
        comparison = []
        for row in candidate['scores']:
            group = row['group']
            mask = data['label_valid'].copy()
            if row['group_type'] == 'asset': mask &= data['sid'] == int(group)
            elif row['group_type'] == 'year': mask &= (data['ts'] < YEAR25) if group == '2024' else (data['ts'] >= YEAR25)
            j = BARRIERS.index(row['barrier']); arm = row['prediction']
            comparison.append({k: row[k] for k in ('horizon_hours', 'group_type', 'group', 'prediction', 'barrier')} |
                              paired_delta(data['y'][mask, j], output[h][arm][mask, j], data[arm][mask, j]))
        provenance = {} if accepted_horizons is None else {
            k: v for k, v in accepted_horizons[h].items()
            if k.startswith('evaluation_') or k in ('issue_eligible_origins', 'issue_eligible_invalid_baseline')}
        reports.append(dict(horizon_hours=h, native=native, candidate=candidate,
                            candidate_minus_own_source=comparison, original_provenance=provenance,
                            projected_rows=int(output[h]['projected'].sum()),
                            unchanged_partial_rows=int((~output[h]['projected']).sum())))
    exact_totals = {arm: [{k: fraction_record(v) if isinstance(v, Fraction) else v for k, v in t.items()}
                         for t in rows] for arm, rows in totals.items()}
    membership = '\n'.join(f'{sid}:{ts}' for sid, ts in sorted(common)).encode()
    for arm in ARMS:
        structure[arm]['quantization_bound_all_J'] = list(map(fraction_record, structure[arm]['quantization_bound_all_J']))
    return output, dict(schema='q26-r17-saved-repair-analysis-v1', horizons=reports,
                        common_prediction_only_J=dict(rows=len(common), sha256=hashlib.sha256(membership).hexdigest()),
                        union_rows=len(union), partial_grid_rows=len(union-common),
                        common_support_across_four_arms=True, structural=structure,
                        exact_complete_coherent_loss=exact_totals, primary=dict(horizon_hours=24, barrier=-.1),
                        native_metric_parity='PASS' if accepted_horizons is not None else 'NOT_CHECKED_SYNTHETIC',
                        paired_delta_contract=PAIRED_DELTA_CONTRACT,
                        claims='Seen-data descriptive repair only; no inference, model selection, blind authority or per-horizon guarantee.')


def archive_headers(path):
    """Bounded ZIP/NPY-header inspection before any ndarray payload is decoded."""
    descriptions = {}; expanded = 0
    with zipfile.ZipFile(path) as z:
        members = z.infolist()
        need(len(members) == 12 and {i.filename for i in members} == {f'{k}.npy' for k in FIELDS}, 'exact ZIP inventory')
        for member in members:
            need(not member.flag_bits & 1 and member.compress_type == zipfile.ZIP_DEFLATED and
                 member.file_size <= 64*1024**2, 'bounded unencrypted deflated member')
            with z.open(member) as stream:
                magic = stream.read(8)
                need(magic[:6] == b'\x93NUMPY' and magic[6:] in (b'\x01\x00', b'\x02\x00'), 'NPY version')
                width = 2 if magic[6] == 1 else 4
                raw = stream.read(width); need(len(raw) == width, 'NPY header length')
                count = int.from_bytes(raw, 'little'); need(count <= 10000, 'NPY bounded header')
                header = stream.read(count); need(len(header) == count, 'NPY truncated header')
                meta = ast.literal_eval(header.decode('latin1'))
            need(isinstance(meta, dict) and set(meta) == {'descr', 'fortran_order', 'shape'} and meta['fortran_order'] is False, 'NPY schema/order')
            key = member.filename[:-4]; shape = meta['shape']
            dtype = {'sid': '<i4', 'ts': '<i8', 'y': '|u1', 'label_valid': '|b1'}.get(key, '<f8')
            need(meta['descr'] == dtype and isinstance(shape, tuple) and len(shape) in (1, 2) and
                 all(type(x) is int and x >= 0 for x in shape) and shape[0] <= 200000 and
                 shape == ((shape[0],) if key in ('sid', 'ts', 'label_valid') else (shape[0], 5)), 'NPY shape/dtype')
            nbytes = math.prod(shape) * np.dtype(dtype).itemsize
            need(member.file_size == 8 + width + count + nbytes, 'NPY exact payload length')
            expanded += nbytes; descriptions[key] = (shape, dtype)
    need(len({shape[0] for shape, dtype in descriptions.values()}) == 1 and expanded <= 64*1024**2, 'archive row/payload cap')
    return descriptions


def read_json(record, limit=16*1024**2):
    need(type(record.get('size')) is int and 0 <= record['size'] <= limit, 'JSON byte cap')
    path = checked(record)
    return strict_json(path.read_bytes())


def authenticate(request_path, request_sha256, out):
    path = Path(request_path)
    need(path.is_absolute() and str(path.resolve()) == str(path) and not path.is_symlink(), 'canonical request path')
    need(path.stat().st_size <= 1024**2, 'request byte cap')
    raw = path.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == request_sha256, 'external request digest')
    request = strict_json(raw)
    need(set(request) == {'schema', 'pins', 'out'} and request['schema'] == 'q26-r17-saved-repair-request-v1', 'request schema')
    pins = request['pins']; roles = {'source', 'checker', 'kernel', 'check_kernel', 'protocol', 'runtime', 'location', 'headers'} | {f'archive_{h}' for h in HORIZONS}
    need(set(pins) == roles, 'request roles')
    for record in pins.values(): checked(record)
    need(pins['source']['path'] == str(Path(__file__).resolve()), 'producer source identity')
    location = read_json(pins['location']); authorities = location['authority_references']
    closure = list(pins.values()) + list(authorities.values())
    for record in closure: checked(record)
    staged = read_json(authorities['staged_manifest']); original = read_json(authorities['staging_request'])
    mapping = location['canonical_mapping']
    need(len(mapping) == 24 and mapping == staged['canonical_mapping'] == original['selected'] and staged['complete'] is True, 'canonical selection ancestry')
    need(location['canonical_mapping_authority']['pin'] == authorities['staged_manifest'], 'canonical mapping authority')
    result = read_json(authorities['complete_result']); monitor = read_json(authorities['complete_monitor']); audit = read_json(authorities['complete_parent_audit'])
    need(result['complete'] is True and audit['accepted'] is True and audit['result'] == authorities['complete_result'] and audit['monitor'] == authorities['complete_monitor'], 'accepted result/audit binding')
    need(monitor['complete'] is True and monitor['exit_code'] == 0 and monitor['changed_pin_paths'] == [] and
         monitor['observation_failure'] is None and monitor['stop_reason'] is None and
         monitor['containment']['errors'] == [] and monitor['containment']['no_live_members_remaining'] is True and
         monitor['containment']['remaining_live_members'] == [] and monitor['containment']['remaining_zombies'] == [], 'accepted clean monitor')
    need(authorities['complete_result'] in monitor['result_pins'], 'accepted monitor result pin')
    accepted = {int(v['horizon_hours']): v for v in result['horizons']}
    need(set(accepted) == set(HORIZONS) and len(result['horizons']) == 5, 'accepted horizon inventory')
    qualified = read_json(pins['headers'])
    need(qualified['status'] == 'HEADERS_AND_METADATA_ONLY_QUALIFIED' and qualified['source_location'] == pins['location'], 'header qualification binding')
    for h in HORIZONS:
        record = pins[f'archive_{h}']
        need(record == location['completed_O81_predictions'][str(h)]['pin'] and record in monitor['result_pins'] and
             record['sha256'] == accepted[h]['local_predictions_sha256'], 'archive accepted provenance')
        need(qualified['prediction_archives'][str(h)]['pin'] == record, 'archive header authority')
        descriptions = archive_headers(record['path'])
        for name, (shape, dtype) in descriptions.items():
            expected = qualified['prediction_archives'][str(h)]['fields'][name]
            need(list(shape) == expected['shape'] and dtype == expected['dtype'], 'qualified header identity')
    runtime = read_json(pins['runtime']); closure.append(runtime['executable']); checked(runtime['executable'])
    expected_env = dict(OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1', PYTHONOPTIMIZE='0', PYTHONDONTWRITEBYTECODE='1')
    need(set(runtime) == {'executable', 'python_version', 'numpy_version', 'env'} and runtime['env'] == expected_env and
         all(os.environ.get(k) == v for k, v in expected_env.items()) and
         str(Path(sys.executable).resolve()) == runtime['executable']['path'] and
         sys.flags.optimize == 0 and sys.flags.dont_write_bytecode == 1 and
         sys.version.split()[0] == runtime['python_version'] and np.__version__ == runtime['numpy_version'], 'frozen runtime identity')
    destination = Path(out)
    need(str(destination.resolve()) == str(destination) == request['out'] and not destination.exists(), 'fresh canonical output directory')
    protected = {Path(record['path']).parent for record in closure}
    need(all(not destination.is_relative_to(root) for root in protected), 'output outside input authority roots')
    return request, mapping, accepted, closure


def load_kernel(record):
    path = checked(record); name = '_q26_saved_exact_kernel'
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    sys.modules[name] = module
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module.project_grid


def output_bytes(root):
    return sum(p.stat().st_size for p in root.iterdir() if p.is_file())


def write_json(path, value):
    path = Path(path); payload = (json.dumps(value, separators=(',', ':'), allow_nan=False)+'\n').encode()
    need(len(payload) <= JSON_CAP and output_bytes(path.parent) + len(payload) <= OUTPUT_CAP, 'JSON/output byte cap')
    with path.open('xb') as stream: stream.write(payload)


def run(request_path, request_sha256, out):
    request, mapping, accepted, closure = authenticate(request_path, request_sha256, out)
    root = Path(out); root.mkdir(mode=0o700)
    started = root/'started.json'
    write_json(started, dict(schema='q26-r17-saved-repair-started-v1', request_sha256=request_sha256, request_pins=request['pins']))
    archives = {}
    for h in HORIZONS:
        with np.load(request['pins'][f'archive_{h}']['path'], allow_pickle=False) as archive:
            archives[h] = {key: archive[key] for key in FIELDS}
        need(len(archives[h]['sid']) == accepted[h]['evaluation_issued_origins'] and
             int(archives[h]['label_valid'].sum()) == accepted[h]['evaluation_complete_label_origins'], 'accepted row/mask counts')
    outputs, analysis = reduce_saved(archives, mapping, load_kernel(request['pins']['kernel']), accepted)
    candidates = {}
    for h in HORIZONS:
        path = root/f'candidate-{h}.npz'
        payload = io.BytesIO(); np.savez_compressed(payload, **outputs[h])
        need(output_bytes(root) + payload.getbuffer().nbytes <= OUTPUT_CAP, 'candidate output byte cap')
        with path.open('xb') as stream: stream.write(payload.getbuffer())
        candidates[str(h)] = pin(path)
    started_pin = pin(started)
    for record in closure + list(candidates.values()) + [started_pin]: checked(record)
    need(hashlib.sha256(Path(request_path).read_bytes()).hexdigest() == request_sha256, 'final request digest')
    result = dict(schema='q26-r17-saved-repair-result-v1', label='CODEX CONTINUATION', complete=True,
                  request_sha256=request_sha256, request_pins=request['pins'], source=request['pins']['source'],
                  started=started_pin, candidates=candidates, analysis=analysis)
    need({p.name for p in root.iterdir()} == {'started.json'} | {f'candidate-{h}.npz' for h in HORIZONS}, 'output inventory')
    write_json(root/'result.json', result)
    need(output_bytes(root) <= OUTPUT_CAP and {p.name for p in root.iterdir()} ==
         {'started.json', 'result.json'} | {f'candidate-{h}.npz' for h in HORIZONS}, 'final output cap/inventory')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True); parser.add_argument('--request-sha256', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args(); run(args.request, args.request_sha256, args.out)
