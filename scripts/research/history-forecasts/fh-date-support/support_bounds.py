"""Counts and identified width only, from a previously accepted private witness.

Does not reconstruct original inputs, load D/depth features, fit, forecast, or
estimate a missing-state CDF. Parent supplies an external finite process budget.
"""
import argparse
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import sys
import types
import numpy as np

PIN_ROLES = {'plan', 'result', 'acceptance', 'witness', 'started', 'implementation', 'python'}
INVENTORY = {'started.json', 'witness.npz', 'result.json'}
CAPACITY = 200000
MAX_BYTES = 67108864
MAX_OUTPUT = 65536


def need(ok, why):
    if not ok:
        raise ValueError(why)


def canonical(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and
         not any(v.is_symlink() for v in (p, *p.parents)), 'canonical absolute nonsymlink path')
    return p


def checked(pin):
    need(type(pin) is dict and set(pin) == {'path', 'size', 'sha256'}, 'exact pin schema')
    p = canonical(pin['path'])
    need(p.is_file() and type(pin['size']) is int and pin['size'] >= 0, 'regular pinned file')
    h = hashlib.sha256()
    n = 0
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            n += len(chunk)
            h.update(chunk)
    need(n == pin['size'] and h.hexdigest() == pin['sha256'], 'pin mismatch')
    return p


def json_read(path):
    def pairs(items):
        out = {}
        for k, v in items:
            need(k not in out, 'duplicate JSON key')
            out[k] = v
        return out
    def bad(_):
        raise ValueError('nonfinite JSON constant')
    return json.loads(Path(path).read_bytes(), object_pairs_hook=pairs, parse_constant=bad)


def import_checker(pin):
    p = checked(pin)
    module = types.ModuleType('accepted_fh_date_support_header_checker')
    module.__file__ = str(p)
    exec(compile(p.read_bytes(), str(p), 'exec'), module.__dict__)
    return module


def authenticate(request_path, request_sha256):
    path = canonical(request_path)
    need(path.is_file() and path.stat().st_size <= MAX_OUTPUT, 'bounded request metadata')
    need(hashlib.sha256(path.read_bytes()).hexdigest() == request_sha256, 'external request SHA')
    request = json_read(path)
    need(set(request) == {'schema', 'pins', 'out'} and request['schema'] == 'q26-fh-support-width-request-v1', 'request schema')
    pins = request['pins']
    need(set(pins) == PIN_ROLES, 'exact request pin roles')
    for pin in pins.values():
        checked(pin)
    need(Path(pins['implementation']['path']) == Path(__file__).absolute(), 'executed implementation identity')
    need(Path(pins['python']['path']) == Path(sys.executable).resolve(), 'executed Python identity')
    need(pins['witness']['size'] <= MAX_BYTES, 'bounded witness compressed size')
    # Only JSON metadata and file hashes above; no np.load or recovered sources.
    plan, result, acceptance, started = [json_read(pins[k]['path']) for k in ('plan', 'result', 'acceptance', 'started')]
    need(plan['schema'] == 'q26-fh-date-support-plan-v1' and plan['parent_admitted'] is True and
         plan['mode'] == 'NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT' and plan['row_capacity'] == CAPACITY, 'accepted original plan')
    need(pins['python'] == plan['runtime']['executable'] and
         sys.version.split()[0] == plan['runtime']['python_version'] and
         np.__version__ == plan['runtime']['packages']['numpy'], 'accepted runtime identity')
    checker_pin = plan['roles']['checker']
    need(checker_pin in plan['files'], 'accepted checker closure')
    checked(checker_pin)
    need(result['schema'] == 'q26-fh-date-support-result-v1' and result['complete'] is True and
         result['reconstruction'] is True and result['historical_bridge_parity'] == 'UNAVAILABLE', 'accepted result schema')
    need(acceptance['schema'] == 'q26-fh-date-support-acceptance-v1' and acceptance['complete'] is True and
         acceptance['reconstruction'] is True and acceptance['historical_bridge_parity'] == 'UNAVAILABLE', 'saved acceptance schema')
    need(result['plan_sha256'] == acceptance['plan_sha256'] == started['plan_sha256'] == pins['plan']['sha256'], 'original plan SHA chain')
    need(acceptance['result_sha256'] == pins['result']['sha256'] and acceptance['checker_source'] == checker_pin and
         acceptance['summary'] == result['summary'], 'saved result acceptance binding')
    need(result['source'] == plan['roles']['audit'] and result['source'] in plan['files'], 'accepted producer source binding')
    need(result['witness'] == pins['witness'] and result['started'] == pins['started'], 'accepted output exact pins')
    need(started == {'schema': 'q26-fh-date-support-started-v1', 'plan_sha256': pins['plan']['sha256'], 'reconstruction': True}, 'started receipt')
    root = canonical(plan['out'])
    need(root.is_dir() and {x.name for x in root.iterdir()} == INVENTORY, 'original exact output inventory')
    need(all(not x.is_symlink() and x.is_file() for x in root.iterdir()), 'original regular output inventory')
    for role, filename in (('result', 'result.json'), ('witness', 'witness.npz'), ('started', 'started.json')):
        need(Path(pins[role]['path']) == root / filename, 'original exact output path')
    checker = import_checker(checker_pin)
    pilot = plan['pilot']
    need(type(pilot['previous_cutoff']) is int and checker.predecessor(pilot['current_cutoff']) == pilot['previous_cutoff'], 'immediate predecessor')
    # Header validation inspects all five original fields without decoding their data.
    checker.witness_header_check(pins['witness']['path'], CAPACITY)
    return request, plan, result


def extent(values):
    return {'count': len(values), 'min': None if not len(values) else int(values.min()),
            'max': None if not len(values) else int(values.max())}


def counts_numpy(ends, states, p):
    older = ends <= p
    cells = {str(s): {'recent': int(np.count_nonzero((states == s) & ~older)),
                      'older': int(np.count_nonzero((states == s) & older))} for s in (0, 1, -1)}
    unknown = states == -1
    date = {'recent': int(np.count_nonzero(~older)), 'older': int(np.count_nonzero(older))}
    buckets = {name: extent(ends[mask]) for name, mask in (
        ('before', unknown & (ends < p)), ('equal', unknown & (ends == p)),
        ('after', unknown & (ends > p)), ('all', unknown))}
    return {'cells': cells, 'date_rows': date, 'unknown': {'total': cells['-1']['older'] + cells['-1']['recent'], **buckets}}


def counts_loop(ends, states, p):
    cells = {str(s): {'recent': 0, 'older': 0} for s in (0, 1, -1)}
    date = {'recent': 0, 'older': 0}
    buckets = {k: {'count': 0, 'min': None, 'max': None} for k in ('before', 'equal', 'after', 'all')}
    total = 0
    for j in range(len(ends)):
        t, s = int(ends[j]), int(states[j])
        d = 'older' if t <= p else 'recent'
        cells[str(s)][d] += 1
        date[d] += 1
        if s == -1:
            total += 1
            for key in ('before' if t < p else 'equal' if t == p else 'after', 'all'):
                row = buckets[key]
                row['count'] += 1
                row['min'] = t if row['min'] is None else min(row['min'], t)
                row['max'] = t if row['max'] is None else max(row['max'], t)
    return {'cells': cells, 'date_rows': date, 'unknown': {'total': total, **buckets}}


def fraction_record(value):
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}


def count_and_width(ends, states, plan, result):
    need(type(ends) is np.ndarray and type(states) is np.ndarray and
         ends.dtype == np.dtype('<i8') and states.dtype == np.dtype('i1') and
         ends.ndim == states.ndim == 1 and len(ends) == len(states) <= CAPACITY, 'typed aligned saved arrays')
    n = len(ends)
    q, p = plan['pilot']['current_cutoff'], plan['pilot']['previous_cutoff']
    need(np.all(ends % 3600 == 0) and np.all(ends <= q) and
         np.all(ends[1:] > ends[:-1]) and np.all(np.isin(states, (-1, 0, 1))), 'saved state/date domain')
    summary = result['summary']
    need(set(summary['state_counts']) == {'0', '1', '-1'} and
         all(type(v) is int and v >= 0 for v in summary['state_counts'].values()), 'typed accepted state counts')
    need(set(summary['unknown']) == {'total', 'before', 'equal', 'after', 'all'} and
         type(summary['unknown']['total']) is int and summary['unknown']['total'] >= 0, 'typed accepted unknown total')
    for key in ('before', 'equal', 'after', 'all'):
        bucket = summary['unknown'][key]
        need(set(bucket) == {'count', 'min', 'max'} and type(bucket['count']) is int and
             bucket['count'] >= 0 and all(v is None or type(v) is int for v in (bucket['min'], bucket['max'])), 'typed accepted extent')
    need(type(summary['rows']) is int and summary['rows'] == n, 'accepted row count')
    for key, value in (('main_label_end', ends), ('main_state', states)):
        need(hashlib.sha256(value.tobytes()).hexdigest() == summary['array_sha256'][key], 'accepted decoded array digest')
    a, b = counts_numpy(ends, states, p), counts_loop(ends, states, p)
    need(a == b, 'independent count disagreement')
    need(summary['state_counts'] == {s: sum(row.values()) for s, row in a['cells'].items()} and
         summary['unknown'] == a['unknown'], 'accepted count/extent summary')
    need(all(a['date_rows'][d] > 0 for d in ('recent', 'older')), 'two nonempty date groups')
    unknown = a['cells']['-1']
    need(unknown['older'] > 0 and unknown['recent'] == 0 and
         a['unknown']['before']['count'] == unknown['older'] and
         a['unknown']['equal']['count'] == a['unknown']['after']['count'] == 0,
         'unknown state must occur strictly before predecessor only')
    for state in ('0', '1'):
        r, o = a['cells'][state]['recent'], a['cells'][state]['older']
        need((r == o == 0) or (r > 0 and o > 0), 'other one-sided state prevents full width claim')
    alpha = Fraction(unknown['older'], a['date_rows']['older'])
    width = alpha / 2
    return {'rows': n, **a, 'alpha_older_unknown_over_older_all': fraction_record(alpha),
            'each_symmetric_allocation_pointwise_width': fraction_record(width),
            'independent_reducer_agreement': True,
            'full_original_decomposition': 'UNAVAILABLE',
            'historical_bridge_parity': 'UNAVAILABLE',
            'interpretation': 'Exact missing-support width only. No CDF centers, imputation, sampling uncertainty, causal or forecasting claim.'}


def run(request_path, request_sha256, out_path):
    out = canonical(out_path)
    need(not out.exists() and out.parent.is_dir(), 'exclusive fresh output')
    request, plan, result = authenticate(request_path, request_sha256)
    need(str(out) == request['out'], 'signed exact output path')
    need(not out.is_relative_to(Path(plan['out'])), 'output outside original inventory')
    with np.load(request['pins']['witness']['path'], allow_pickle=False) as saved:
        # Intentionally decode only these two accepted arrays, never D/depth/index.
        ends = saved['main_label_end']
        states = saved['main_state']
    ends.setflags(write=False)
    states.setflags(write=False)
    value = count_and_width(ends, states, plan, result)
    for pin in request['pins'].values():
        checked(pin)
    need(hashlib.sha256(canonical(request_path).read_bytes()).hexdigest() == request_sha256, 'final request SHA')
    need({x.name for x in Path(plan['out']).iterdir()} == INVENTORY, 'final original output inventory')
    value.update(schema='q26-fh-support-width-result-v1', label='CODEX CONTINUATION', complete=True,
                 request_sha256=request_sha256, request_pins=request['pins'],
                 original_plan_sha256=request['pins']['plan']['sha256'],
                 original_result_sha256=request['pins']['result']['sha256'],
                 accepted_checker_source=plan['roles']['checker'],
                 helper_use='Pinned checker imported only for header validation and calendar predecessor. No original scientific source executed.',
                 reconstruction=True)
    payload = (json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':')) + '\n').encode()
    need(len(payload) <= MAX_OUTPUT, 'bounded output')
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    run(args.request, args.request_sha256, args.out)


if __name__ == '__main__':
    main()
