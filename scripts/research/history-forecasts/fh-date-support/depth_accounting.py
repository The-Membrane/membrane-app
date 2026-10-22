"""Fixed-current-cohort descriptive depth accounting; no fits or forecasts.

New reconstruction only. A missing conditional CDF remains undefined. Exact
linked interval envelopes describe hypothetical completions, not estimates.
"""
import argparse
from fractions import Fraction
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import sys
import types
import numpy as np

SCHEMA = 'q26-fh-depth-accounting-request-v1'
ROLES = {'plan', 'result', 'acceptance', 'witness', 'started', 'audit', 'checker',
         'source', 'python', 'support_module', 'support_request'}
FIELDS = {'main_index': '<i8', 'main_label_end': '<i8', 'main_state': 'i1',
          'D_original': '<f4', 'unknown_partition': 'i1'}
CAPACITY = 200000
MAX_OUTPUT = 67108864


def need(ok, why):
    if not ok:
        raise ValueError(why)


def canonical(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and not any(v.is_symlink() for v in (p, *p.parents)), 'canonical nonsymlink path')
    return p


def pin(path):
    p = canonical(path)
    need(p.is_file(), 'regular file')
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for data in iter(lambda: stream.read(1048576), b''):
            h.update(data)
    return {'path': str(p), 'size': p.stat().st_size, 'sha256': h.hexdigest()}


def checked(value):
    need(type(value) is dict and set(value) == {'path', 'size', 'sha256'} and
         type(value['size']) is int and value['size'] >= 0, 'exact byte pin')
    need(pin(value['path']) == value, 'byte pin mismatch')
    return Path(value['path'])


def read_json(path):
    def pairs(items):
        result = {}
        for k, v in items:
            need(k not in result, 'duplicate JSON key')
            result[k] = v
        return result
    def bad(_):
        raise ValueError('nonfinite JSON')
    return json.loads(Path(path).read_bytes(), object_pairs_hook=pairs, parse_constant=bad)


def module(value, name):
    p = checked(value)
    out = types.ModuleType(name)
    out.__file__ = str(p)
    exec(compile(p.read_bytes(), str(p), 'exec'), out.__dict__)
    return out


def fraction(value):
    value = Fraction(value)
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}


def authenticate(path, sha):
    p = canonical(path)
    need(p.stat().st_size <= 65536 and pin(p)['sha256'] == sha, 'external bounded request SHA')
    request = read_json(p)
    need(set(request) == {'schema', 'pins', 'out'} and request['schema'] == SCHEMA, 'new request schema')
    pins = request['pins']
    need(set(pins) == ROLES, 'exact request roles')
    for value in pins.values():
        checked(value)
    need(Path(pins['source']['path']) == Path(__file__).absolute(), 'executed new source')
    need(Path(pins['python']['path']) == Path(sys.executable).resolve(), 'executed Python')
    # Reuse immutable saved-chain validation, not its run/reconstruction method.
    support = module(pins['support_module'], '_depth_accepted_chain')
    _, oldplan, oldresult = support.authenticate(pins['support_request']['path'], pins['support_request']['sha256'])
    support_request = read_json(pins['support_request']['path'])
    for key in ('plan', 'result', 'acceptance', 'witness', 'started', 'python'):
        need(support_request['pins'][key] == pins[key], 'same accepted chain')
    need(support_request['pins']['implementation'] == pins['support_module'], 'accepted support helper source')
    need(pins['checker'] == oldplan['roles']['checker'] and pins['audit'] == oldplan['roles']['audit'], 'accepted adapter sources')
    checker = module(pins['checker'], '_depth_accepted_checker')
    # This metadata authenticator accepts the original existing output directory;
    # the producer's fresh-output authenticate/run methods are never invoked.
    metadata = checker.authenticate(oldplan, pins['plan']['sha256'])
    need(pins['python'] == oldplan['runtime']['executable'], 'same frozen interpreter')
    out = canonical(request['out'])
    need(not out.exists() and out.parent.is_dir() and
         not out.is_relative_to(Path(oldplan['out'])), 'fresh output outside accepted inventory')
    audit = module(pins['audit'], '_depth_accepted_audit_helpers')
    return request, oldplan, oldresult, metadata, checker, audit


def original_record(prep, ser, record):
    """O137 retained-record semantics at this record's own cutoff; never refit."""
    q = record['quarter_cutoff']
    need(type(q) is int and (q - ser.base_ts) % 3600 == 0, 'own cutoff grid')
    indices = np.arange(prep.n, dtype=np.int64)
    mature = indices + 24 <= (q - ser.base_ts) // 3600
    reg = np.flatnonzero(prep.okH & mature)
    need(type(record['n_reg']) is int and record['n_reg'] == len(reg), 'own n_reg')
    coef = record['coef']
    need((coef is None) == (len(reg) < 4), 'own original None rule')
    missing = coef is None
    if not missing:
        coef = np.asarray(coef, dtype=np.float64)
        need(coef.shape == (4,) and np.isfinite(coef).all(), 'retained coefficient schema')
    # Match original_record's own-maturity validation even for None. These
    # values validate historical metadata only; None never supplies a CDF.
    sigma = prep.sigma_H(coef)
    z, valid = prep.z_of(sigma)
    need(sigma.shape == z.shape == valid.shape == (prep.n,) and valid.dtype == bool, 'full vintage arrays')
    own_main = np.flatnonzero(valid & mature)
    fallback = np.flatnonzero(prep.P.valid[1.] & mature)
    def end(ix):
        return None if not len(ix) else int(ser.base_ts + 3600 * (int(ix[-1]) + 24))
    expected = {'har_label_end_max': end(reg), 'har_label_end_min': None if not len(reg) else
                int(ser.base_ts + 3600 * (int(reg[0]) + 24)), 'library_label_end_max': end(own_main),
                'fallback_library_label_end_max': end(fallback)}
    need(all(record[k] == v and (v is None or v <= q) for k, v in expected.items()), 'own record maturity metadata')
    if missing:
        return None, None, None, own_main
    return sigma, z, valid, own_main


def exact_witness(actual, accepted):
    need(set(actual) == set(accepted) == set(FIELDS), 'all five witness fields')
    for key, dtype in FIELDS.items():
        a, b = actual[key], accepted[key]
        need(a.dtype == b.dtype == np.dtype(dtype) and a.shape == b.shape and
             a.tobytes() == b.tobytes(), 'accepted witness bit identity: ' + key)


def reconstruct(plan, metadata, audit, accepted, out):
    staging, raw, manifest, cut = metadata
    producer = audit.source_module('_depth_original_staging', plan['roles']['staging_producer'])
    census = audit.source_module('_depth_original_census', plan['roles']['census'])
    finder = audit.FrozenSources(plan['legacy_sources'].values())
    need(not (set(finder.paths) & set(sys.modules)), 'no preloaded legacy source')
    sys.meta_path.insert(0, finder)
    oldpath = list(sys.path)
    try:
        with producer.guard([v['path'] for v in plan['files']], out):
            R12, A6, D, M2 = [importlib.import_module(k) for k in ('r12_tail', 'a6_touch', 'r16_dev', 'a2_touch')]
            pilot = plan['pilot']
            spec = audit.grid_spec(staging['required_raw_paths'], pilot['key'])
            groups = [m for m in manifest['series_horizons'] if m['sid'] == pilot['sid'] and m['horizon'] == 24]
            need(len(groups) == 1, 'one original H24 group')
            records = {}
            for name, key in (('current', 'current_cutoff'), ('previous', 'previous_cutoff')):
                matches = [r for r in groups[0]['quarters'] if r['quarter_cutoff'] == pilot[key]]
                need(len(matches) == 1, 'unique retained vintage')
                records[name] = matches[0]
            with audit.forbid_work(np, A6, M2):
                ser, _, _ = R12.load_series(spec)
                need(len(ser.close) + 1 <= CAPACITY and type(ser.base_ts) is int, 'whole raw history capacity')
                prep = A6.Prep6(ser, 24, with_fbL=False)
                need(type(prep.n) is int and prep.n == len(ser.close) + 1 and prep.n <= CAPACITY, 'whole Prep6 shape')
                vintages = {name: original_record(prep, ser, records[name]) for name in ('current', 'previous')}
                need(vintages['current'][0] is not None, 'current coefficient must exist')
                main = vintages['current'][3].astype('<i8', copy=False)
                feature = census.downside_feature(D.realized(ser), producer.sanitize)
                need(feature.dtype == np.dtype('<f4') and feature.shape == (prep.n,), 'original full float32 D')
                states = census.states_of(feature, cut)
                witness = audit.witness(np, main, ser.base_ts + 3600 * (main + 24), states[main], feature[main],
                                        pilot['previous_cutoff'], pilot['current_cutoff'], CAPACITY)
                exact_witness(witness, accepted)  # Gate before accounting or report.
                arrays = dict(witness)
                status = {}
                for name in ('current', 'previous'):
                    sigma, z, valid, _ = vintages[name]
                    retained, status[name] = fixed_vintage(sigma, z, valid, main)
                    for key, value in retained.items():
                        arrays[name + '_' + key] = value
                return arrays, status
    finally:
        sys.meta_path.remove(finder)
        sys.path[:] = oldpath


def fixed_vintage(sigma, z, valid, main):
    """Preserve every raw fixed-row value; eligibility never filters the cohort."""
    if sigma is None:
        need(z is None and valid is None, 'missing coefficient triple')
        return {'sigma': np.empty(0, dtype='<f8'), 'z': np.empty(0, dtype='<f8'),
                'valid': np.empty(0, dtype=bool)}, {
            'available': False, 'reason': 'missing_predecessor_coefficient', 'stored_fixed_rows': 0,
            'invalid_rows': None, 'nonfinite_sigma_rows': None, 'nonpositive_sigma_rows': None, 'nonfinite_z_rows': None}
    need(sigma.dtype == z.dtype == np.dtype('<f8') and valid.dtype == bool and
         sigma.ndim == z.ndim == valid.ndim == 1 and sigma.shape == z.shape == valid.shape,
         'original vintage dtype/shape')
    retained = {'sigma': sigma[main].copy(), 'z': z[main].copy(), 'valid': valid[main].copy()}
    badvalid = int(np.count_nonzero(~retained['valid']))
    badsigma = int(np.count_nonzero(~np.isfinite(retained['sigma'])))
    badz = int(np.count_nonzero(~np.isfinite(retained['z'])))
    nonpositive = int(np.count_nonzero(retained['sigma'] <= 0))
    okay = not (badvalid or badsigma or badz or nonpositive)
    return retained, {'available': okay, 'reason': None if okay else 'invalid_or_nonfinite_fixed_rows',
                      'stored_fixed_rows': len(main), 'invalid_rows': badvalid,
                      'nonfinite_sigma_rows': badsigma, 'nonpositive_sigma_rows': nonpositive, 'nonfinite_z_rows': badz}


def linear_forms(counts):
    """Seven columns: six original recent/older cells, then a constant one."""
    nr, no = sum(counts[0::2]), sum(counts[1::2])
    need(nr > 0 and no > 0 and counts[4] == 0 and counts[5] > 0, 'unknown older-only and two date groups')
    forms = {k: [Fraction(0)] * 7 for k in ('date_gap', 'common_composition', 'common_within', 'unknown_net')}
    for i in range(6):
        forms['date_gap'][i] = Fraction(1, nr) if i % 2 == 0 else Fraction(-1, no)
    for j in (0, 2):
        a, b = counts[j], counts[j + 1]
        need(a > 0 and b > 0, 'both known states required in both date groups')
        if a:
            pr, po = Fraction(a, nr), Fraction(b, no)
            forms['common_composition'][j:j + 2] = [(pr - po) / (2 * a), (pr - po) / (2 * b)]
            forms['common_within'][j:j + 2] = [(pr + po) / (2 * a), -(pr + po) / (2 * b)]
    alpha = Fraction(counts[5], no)
    forms['unknown_net'][5] = Fraction(-1, no)
    for name in ('composition_lower', 'composition_upper'):
        forms[name] = list(forms['common_composition'])
        forms[name][5] -= Fraction(1, 2 * no)
    forms['composition_lower'][6] -= alpha / 2
    for name in ('within_lower', 'within_upper'):
        forms[name] = list(forms['common_within'])
        forms[name][5] -= Fraction(1, 2 * no)
    forms['within_upper'][6] += alpha / 2
    # Empty cells have no observations and are identically zero.
    for row in forms.values():
        for i, n in enumerate(counts):
            if n == 0:
                row[i] = Fraction(0)
    den = math.lcm(*(v.denominator for row in forms.values() for v in row))
    coeff = {k: tuple(int(v * den) for v in row) for k, row in forms.items()}
    for j in range(7):
        need(coeff['date_gap'][j] == coeff['common_composition'][j] + coeff['common_within'][j] + coeff['unknown_net'][j], 'observed coefficient identity')
        need(coeff['date_gap'][j] == coeff['composition_lower'][j] + coeff['within_upper'][j] ==
             coeff['composition_upper'][j] + coeff['within_lower'][j], 'linked endpoint identity')
    return den, coeff, alpha


def accounting(z, states, ends, previous_cutoff):
    """Pure exact observed accounting and hypothetical pointwise envelopes."""
    need(z.dtype == np.dtype('<f8') and states.dtype == np.dtype('i1') and ends.dtype == np.dtype('<i8') and
         z.ndim == states.ndim == ends.ndim == 1 and len(z) == len(states) == len(ends) <= CAPACITY and
         len(z) > 0 and np.isfinite(z).all() and np.isin(states, (0, 1, -1)).all(), 'finite aligned depth vectors')
    older = ends <= previous_cutoff
    need(np.all(ends[states == -1] < previous_cutoff), 'unknown strictly before predecessor')
    cell = np.empty(len(z), dtype=np.int8)
    for j, state in enumerate((0, 1, -1)):
        cell[states == state] = 2 * j + older[states == state].astype(np.int8)
    totals = [int(np.count_nonzero(cell == j)) for j in range(6)]
    den, coeff, alpha = linear_forms(totals)
    knots = np.unique(np.where(z == 0, 0.0, z)).astype('<f8')
    table = np.zeros((len(knots) + 1, 6), dtype='<i8')
    for j in range(6):
        own = np.sort(z[cell == j])
        table[1:, j] = np.searchsorted(own, knots, side='right')
    maxima = {name: 0 for name in coeff}
    width_num = int((alpha / 2) * den)
    for row in table:
        values = tuple(int(v) for v in row) + (1,)
        f = {name: sum(c * v for c, v in zip(coef, values)) for name, coef in coeff.items()}
        need(f['date_gap'] == f['common_composition'] + f['common_within'] + f['unknown_net'], 'observed pointwise identity')
        need(f['date_gap'] == f['composition_lower'] + f['within_upper'] ==
             f['composition_upper'] + f['within_lower'], 'linked pointwise identity')
        need(f['composition_upper'] - f['composition_lower'] ==
             f['within_upper'] - f['within_lower'] == width_num, 'fixed exact endpoint widths')
        for name, value in f.items():
            maxima[name] = max(maxima[name], abs(value))
    left = Fraction.from_float(float(knots[0])) - 1
    report = {'schema': 'q26-fh-depth-accounting-kernel-v1', 'available': True,
              'rows': len(z), 'date_rows': [sum(totals[0::2]), sum(totals[1::2])], 'state_date_rows': totals,
              'cell_order': [[s, d] for s in (0, 1, -1) for d in ('recent', 'older')],
              'common_denominator': str(den), 'integer_coefficients': {k: [str(v) for v in row] for k, row in coeff.items()},
              'constant_column': 1, 'count_rows': len(table), 'observed_knots': len(knots),
              'left_state': {'kind': 'BEFORE_MIN', 'finite_exact_coordinate': fraction(left), 'count_row': 0,
                             'interpretation': 'Finite threshold below every observed depth, not a CDF value at minus infinity.'},
              'alpha_older_unknown_over_older_all': fraction(alpha), 'each_allocation_width': fraction(alpha / 2),
              'suprema': {k: fraction(Fraction(v, den)) for k, v in maxima.items()},
              'observed_identity_verified': True, 'linked_endpoint_identity_verified': True,
              'original_full_decomposition': 'UNAVAILABLE',
              'interpretation': 'Observed date_gap=common_composition+common_within+unknown_net. Bounds are linked hypothetical missing-CDF allocations, not fitted distributions or uncertainty intervals.'}
    return report, knots, table


def write_json(path, value):
    payload = (json.dumps(value, allow_nan=False, sort_keys=True, separators=(',', ':')) + '\n').encode()
    need(len(payload) <= 4194304, 'report byte cap')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def run(request_path, request_sha256, out_path):
    request, plan, oldresult, metadata, checker, audit = authenticate(request_path, request_sha256)
    out = canonical(out_path)
    need(str(out) == request['out'], 'signed exact output')
    out.mkdir(mode=0o700)
    write_json(out / 'started.json', {'schema': 'q26-fh-depth-accounting-started-v1', 'request_sha256': request_sha256,
                                     'reconstruction': True})
    checker.witness_header_check(request['pins']['witness']['path'], CAPACITY)
    with np.load(request['pins']['witness']['path'], allow_pickle=False) as saved:
        need(set(saved.files) == set(FIELDS) and len(saved.files) == len(FIELDS), 'accepted witness inventory')
        accepted = {key: saved[key] for key in FIELDS}
    arrays, status = reconstruct(plan, metadata, audit, accepted, out)
    reports = {}
    for name in ('current', 'previous'):
        if status[name]['available']:
            report, knots, counts = accounting(arrays[name + '_z'], arrays['main_state'], arrays['main_label_end'], plan['pilot']['previous_cutoff'])
            reports[name] = {**report, 'vintage_status': status[name]}
        else:
            knots = np.empty(0, dtype='<f8')
            counts = np.empty((0, 6), dtype='<i8')
            reports[name] = {'available': False, 'vintage_status': status[name], 'original_full_decomposition': 'UNAVAILABLE'}
        arrays[name + '_knots'] = knots
        arrays[name + '_counts'] = counts
    with (out / 'basis.npz').open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        np.savez_compressed(stream, **arrays)
        stream.flush()
        os.fsync(stream.fileno())
    need((out / 'basis.npz').stat().st_size <= MAX_OUTPUT, 'basis output cap')
    for value in request['pins'].values():
        checked(value)
    for value in plan['files']:
        checked(value)
    need(pin(request_path)['sha256'] == request_sha256, 'final request unchanged')
    need({p.name for p in Path(plan['out']).iterdir()} == {'started.json', 'witness.npz', 'result.json'}, 'old inventory unchanged')
    result = {'schema': 'q26-fh-depth-accounting-result-v1', 'label': 'CODEX CONTINUATION', 'complete': True,
              'request_sha256': request_sha256, 'request_pins': request['pins'], 'reconstruction': True,
              'historical_bridge_parity': 'UNAVAILABLE', 'accepted_witness_all_five_bit_identity': True,
              'source': request['pins']['source'], 'basis': pin(out / 'basis.npz'), 'started': pin(out / 'started.json'),
              'vintages': reports, 'cross_vintage_contrast': 'NOT_COMPUTED',
              'claims': 'Descriptive current-cohort reconstruction and exact accounting only. No fits, predictions, scores, imputation, causal attribution, sampling intervals or forecasting improvement.'}
    write_json(out / 'result.json', result)
    need({p.name for p in out.iterdir()} == {'started.json', 'basis.npz', 'result.json'}, 'new exact output inventory')
    return result


def main():
    parser = argparse.ArgumentParser()
    for key in ('request', 'request-sha256', 'out'):
        parser.add_argument('--' + key, required=True)
    a = parser.parse_args()
    run(a.request, a.request_sha256, a.out)


if __name__ == '__main__':
    main()
