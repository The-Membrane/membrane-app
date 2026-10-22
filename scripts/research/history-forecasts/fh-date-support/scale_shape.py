"""Saved-data descriptive scale/shape kernels; no model or inferential test.

Median normalization uses exact binary64 rational ratios, never floating division.
The protocol's source-qualified orientation is applied outside analyze_pair.
"""
from fractions import Fraction
import numpy as np

QUANTILES = ((1,10),(1,4),(1,2),(3,4),(9,10),(19,20),(99,100))
CAPACITY = 200000


def need(ok, why):
    if not ok:
        raise ValueError(why)


def record(value):
    value = Fraction(value)
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}


def finite_vector(values):
    need(type(values) is np.ndarray and values.dtype == np.dtype('<f8') and
         values.ndim == 1 and 0 < len(values) <= CAPACITY and np.isfinite(values).all(),
         'nonempty finite complete binary64 vector')


def exact_ratio(value, median):
    """Unreduced exact ratio; positive denominator preserves comparison order."""
    numerator, denominator = float(value).as_integer_ratio()
    mn, md = float(median).as_integer_ratio()
    need(mn > 0, 'strictly positive normalization median')
    return numerator * md, denominator * mn


def ratio_cmp(a, b):
    delta = a[0] * b[1] - b[0] * a[1]
    return (delta > 0) - (delta < 0)


def ks_sorted(recent, older, recent_median=None, older_median=None):
    """Whole tied union, integer ECDF differences, exact normalized ordering.

    Positive scaling preserves each original sorted order. Only a linear merge
    is needed after sorting, including when float quotients overflow or tie.
    """
    normalized = recent_median is not None or older_median is not None
    need(not normalized or (recent_median is not None and older_median is not None and
                           recent_median > 0 and older_median > 0), 'paired positive medians')
    nr, no = len(recent), len(older)
    need(nr > 0 and no > 0, 'two nonempty groups')
    i = j = maximum = 0
    def key(value, median):
        return exact_ratio(value, median) if normalized else float(value).as_integer_ratio()
    kr = key(recent[0], recent_median)
    ko = key(older[0], older_median)
    while i < nr or j < no:
        if i == nr:
            pivot = ko
        elif j == no:
            pivot = kr
        else:
            pivot = kr if ratio_cmp(kr, ko) <= 0 else ko
        while i < nr and ratio_cmp(kr, pivot) == 0:
            i += 1
            if i < nr:
                kr = key(recent[i], recent_median)
        while j < no and ratio_cmp(ko, pivot) == 0:
            j += 1
            if j < no:
                ko = key(older[j], older_median)
        maximum = max(maximum, abs(i * no - j * nr))
    return Fraction(maximum, nr * no)


def quantiles(sorted_values):
    out = []
    n = len(sorted_values)
    for numerator, denominator in QUANTILES:
        rank = (numerator * n + denominator - 1) // denominator
        value = float(sorted_values[rank - 1])
        if value == 0:
            value = 0.0  # signed zeros share one numerical quantile coordinate
        out.append({'probability': [numerator, denominator], 'rank': rank,
                    'value_hex': value.hex(), 'exact_value': record(Fraction.from_float(value))})
    return out


def analyze_pair(recent_values, older_values):
    """Fixed quantiles and ECDF distances; no selection or pass/fail verdict."""
    finite_vector(recent_values)
    finite_vector(older_values)
    recent, older = np.sort(recent_values), np.sort(older_values)
    qr, qo = quantiles(recent), quantiles(older)
    mr, mo = float(recent[(len(recent) - 1) // 2]), float(older[(len(older) - 1) // 2])
    raw = ks_sorted(recent, older)
    normalization = {'available': False, 'reason': 'nonpositive_median',
                     'medians': {'recent': record(Fraction.from_float(mr)), 'older': record(Fraction.from_float(mo))},
                     'median_relative_profiles': None, 'normalized_ks': None, 'direction': None}
    if mr > 0 and mo > 0:
        normalized = ks_sorted(recent, older, mr, mo)
        profiles = {}
        for name, qq, mm in (('recent', qr, mr), ('older', qo, mo)):
            median = Fraction.from_float(mm)
            profiles[name] = [record(Fraction(int(q['exact_value']['numerator']), int(q['exact_value']['denominator'])) / median) for q in qq]
        normalization.update(available=True, reason=None, median_relative_profiles=profiles,
                             normalized_ks=record(normalized),
                             direction='reduced' if normalized < raw else 'increased' if normalized > raw else 'equal')
    return {'recent_rows': len(recent), 'older_rows': len(older), 'raw_ks': record(raw),
            'quantiles': {'recent': qr, 'older': qo}, 'normalization': normalization}


TARGET = 'signed_adverse_excursion_X_equals_minus_Z'
INTERPRETATION = 'Descriptive ECDF distances on fixed known-state cohorts. Median normalization is a scale comparison, not a significance test, mechanism attribution or forecast evaluation.'


def analyze_basis(current_z, previous_z, states, ends, previous_cutoff, current_cutoff, expected_reports):
    """All four preregistered known-state/date comparisons, same accepted rows.

    Original signed log-minimum Z is negated into adverse orientation X=-Z.
    Favorable positive Z remains negative X. Unknown state is retained in full
    provenance, outside this explicitly conditional known-state target only.
    """
    finite_vector(current_z)
    finite_vector(previous_z)
    n = len(current_z)
    need(type(states) is np.ndarray and type(ends) is np.ndarray and
         states.dtype == np.dtype('i1') and ends.dtype == np.dtype('<i8') and
         states.shape == ends.shape == current_z.shape == previous_z.shape and
         np.isin(states, (0,1,-1)).all(), 'full typed aligned accepted basis')
    need(type(previous_cutoff) is int and type(current_cutoff) is int and previous_cutoff < current_cutoff and
         np.all(ends % 3600 == 0) and np.all(ends <= current_cutoff) and np.all(ends[1:] > ends[:-1]), 'accepted full ordered mature hourly keys')
    older = ends <= previous_cutoff
    counts = [int(np.count_nonzero((states == state) & date)) for state in (0,1,-1) for date in (~older,older)]
    dates = [int(np.count_nonzero(~older)), int(np.count_nonzero(older))]
    need(set(expected_reports) == {'current','previous'}, 'two accepted vintage reports')
    for report in expected_reports.values():
        need(report['available'] is True and type(report['rows']) is int and report['rows'] == n and
             type(report['state_date_rows']) is list and len(report['state_date_rows']) == 6 and
             all(type(x) is int for x in report['state_date_rows']) and report['state_date_rows'] == counts and
             type(report['date_rows']) is list and all(type(x) is int for x in report['date_rows']) and report['date_rows'] == dates,
             'accepted full state/date count binding')
    pairs = {}
    for vintage, original in (('current',current_z),('previous',previous_z)):
        for state in (0,1):
            recent_values = -original[(states == state) & ~older]
            older_values = -original[(states == state) & older]
            pairs[vintage+'_state_'+str(state)] = analyze_pair(recent_values,older_values)
    return {'schema':'q26-fh-scale-shape-analysis-v1','target':TARGET,'known_states':[0,1],
            'quantile_ratios':[list(q) for q in QUANTILES], 'pairs':pairs,
            'provenance_counts':{'cell_order':[[s,d] for s in (0,1,-1) for d in ('recent','older')],
                                 'date_rows':dates,'state_date_rows':counts,'unknown_rows':counts[4]+counts[5]},
            'interpretation':INTERPRETATION}


# Saved-only transport. Parent supplies an independent finite process deadline.
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import types

ROLES = {'basis','result','acceptance','parent','closed','phase','producer_request','checker_request',
         'producer_terminal','checker_terminal','plan','depth_checker_source','source','python'}
MAX_REPORT = 1048576


def canonical(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and not any(v.is_symlink() for v in (p,*p.parents)), 'canonical nonsymlink path')
    return p


def pin(path):
    p = canonical(path)
    need(p.is_file(), 'regular file')
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1048576),b''):
            h.update(chunk)
    return {'path':str(p),'size':p.stat().st_size,'sha256':h.hexdigest()}


def checked(value):
    need(type(value) is dict and set(value) == {'path','size','sha256'} and type(value['size']) is int and
         value['size'] >= 0 and pin(value['path']) == value, 'exact unchanged byte pin')
    return Path(value['path'])


def read(path):
    p = canonical(path)
    need(p.is_file() and p.stat().st_size <= 4194304, 'bounded metadata')
    def pairs(items):
        out = {}
        for k,v in items:
            need(k not in out, 'duplicate JSON key')
            out[k] = v
        return out
    def bad(_):
        raise ValueError('nonfinite JSON')
    return json.loads(p.read_bytes(),object_pairs_hook=pairs,parse_constant=bad)


def terminal_metadata(value, kind, inner_pin, source, output, runtime):
    need(value['schema'] == 'q26-weighted-causal-primary-pair-observer-terminal-v1' and
         value['complete'] is True and type(value['tool_terminal_exit']) is int and value['tool_terminal_exit'] == 0 and
         value['fixture_only'] is False and value['process_terminal'] is True and value['observer_timeout'] is False and
         value['reason'] is None and value['errors'] == [] and value['containment']['reaped'] is True and
         value['containment']['no_live_members_remaining'] is True and value['containment']['remaining_live_members'] == [] and
         value['runner'] == source, 'accepted actual terminal')
    outer = read(checked(value['request']))
    argv = [runtime['python_path'],'-B',source['path'],'--request',inner_pin['path'],'--request-sha256',inner_pin['sha256']]
    if kind == 'producer':
        argv += ['--out',output]
    need(outer['schema'] == 'q26-fh-depth-observer-request-v1' and outer['kind'] == kind and
         outer['fixture_only'] is False and outer['inner_request'] == inner_pin and outer['runner'] == source and
         outer['argv'] == argv and outer['output'] == output and outer['python_pin'] == runtime['executable'] and
         outer['invocation_python'] == runtime['python_path'], 'terminal exact sealed command')


def authenticate(request_path, request_sha256, out_path):
    rp = canonical(request_path)
    need(rp.stat().st_size <= 65536 and pin(rp)['sha256'] == request_sha256, 'external request SHA')
    q = read(rp)
    need(set(q) == {'schema','pins','out'} and q['schema'] == 'q26-fh-scale-shape-request-v1' and set(q['pins']) == ROLES, 'saved analysis request schema')
    pins = q['pins']
    for value in pins.values():
        checked(value)
    need(pins['source'] == pin(Path(__file__).absolute()) and Path(pins['python']['path']) == Path(sys.executable).resolve(), 'executed source and interpreter')
    need(pins['basis']['size'] <= 67108864, 'bounded saved basis')
    closed,phase,parent,result,acceptance,producer,checker_request,plan = [read(pins[k]['path']) for k in
        ('closed','phase','parent','result','acceptance','producer_request','checker_request','plan')]
    need(closed['schema'] == 'q26-depth-phase-closed-v1' and closed['status'] == 'CLOSED_ACCEPTED' and
         closed['admission_authority'] == pins['phase'] and closed['parent_acceptance_path'] == pins['parent']['path'] and
         closed['no_running_jobs'] is True and closed['unused_reused'] is False and
         closed['initial_phase_file_is_immutable_admission'] is True, 'closed accepted parent phase')
    need(phase['schema'] == 'q26-fh-depth-phase-v1' and phase['parent_admitted'] is True and
         phase['inner_request'] == pins['producer_request'], 'immutable original admission')
    need(parent['schema'] == 'q26-depth-parent-acceptance-v1' and parent['complete'] is True and
         parent['all_final_pins'] == 'PASS' and parent['result'] == pins['result'] and parent['basis'] == pins['basis'] and
         parent['independent_acceptance'] == pins['acceptance'] and parent['vintages_both_available'] is True and
         parent['original_inventory_preserved'] is True and parent['historical_bridge_parity'] == 'UNAVAILABLE' and
         parent['cross_vintage_contrast'] == 'NOT_COMPUTED', 'parent accepted basis authority')
    need(producer['schema'] == 'q26-fh-depth-accounting-request-v1' and checker_request['schema'] == 'q26-fh-depth-check-request-v1' and
         producer['pins']['plan'] == checker_request['pins']['plan'] == pins['plan'], 'original inner requests')
    need(result['schema'] == 'q26-fh-depth-accounting-result-v1' and result['complete'] is True and
         result['reconstruction'] is True and result['historical_bridge_parity'] == 'UNAVAILABLE' and
         result['cross_vintage_contrast'] == 'NOT_COMPUTED' and result['accepted_witness_all_five_bit_identity'] is True and
         result['request_sha256'] == pins['producer_request']['sha256'] and result['request_pins'] == producer['pins'] and
         result['source'] == producer['pins']['source'] and result['basis'] == pins['basis'], 'accepted original report')
    need(acceptance['schema'] == 'q26-fh-depth-check-acceptance-v1' and acceptance['complete'] is True and
         acceptance['reconstruction'] is True and acceptance['historical_bridge_parity'] == 'UNAVAILABLE' and
         acceptance['result_sha256'] == pins['result']['sha256'] and acceptance['request_sha256'] == pins['checker_request']['sha256'] and
         acceptance['checker_source'] == checker_request['pins']['checker_source'] == pins['depth_checker_source'] and
         checker_request['pins']['producer_request'] == pins['producer_request'] and checker_request['pins']['result'] == pins['result'] and
         checker_request['pins']['basis'] == pins['basis'] and checker_request['pins']['producer_source'] == result['source'] and
         checker_request['pins']['started'] == result['started'] and acceptance['producer_terminal'] == checker_request['pins']['terminal'], 'independent accepted report bindings')
    runtime = plan['runtime']
    need(plan['schema'] == 'q26-fh-date-support-plan-v1' and plan['parent_admitted'] is True and plan['row_capacity'] == CAPACITY and
         runtime['executable'] == pins['python'] and runtime['python_path'] == sys.executable and
         runtime['python_version'] == sys.version.split()[0] and sys.dont_write_bytecode and not sys.flags.optimize, 'same saved runtime')
    need(runtime['env'] == {'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONOPTIMIZE':'0'} and
         all(os.environ.get(k) == v for k,v in runtime['env'].items()) and
         set(runtime['packages']) == {'numpy','scipy','numba','llvmlite'} and
         all(importlib.metadata.version(k) == v for k,v in runtime['packages'].items()), 'same package and thread environment')
    producer_terminal,checker_terminal = (read(pins[k]['path']) for k in ('producer_terminal','checker_terminal'))
    terminal_metadata(producer_terminal,'producer',pins['producer_request'],result['source'],producer['out'],runtime)
    terminal_metadata(checker_terminal,'saved_check',pins['checker_request'],pins['depth_checker_source'],checker_request['out'],runtime)
    need(phase['producer_observer_request'] == producer_terminal['request'], 'phase actual observer binding')
    oldroot = canonical(pins['phase']['path']).parent
    need(canonical(producer['out']) == oldroot/'producer' and canonical(pins['basis']['path']) == oldroot/'producer'/'basis.npz' and
         canonical(pins['result']['path']) == oldroot/'producer'/'result.json' and
         canonical(checker_request['out']) == canonical(pins['acceptance']['path']), 'original saved output paths')
    out = canonical(out_path)
    need(str(out) == q['out'] and not out.exists() and out.parent.is_dir() and not out.is_relative_to(oldroot), 'fresh signed output outside entire old root')
    need(all(result['vintages'][v]['available'] is True for v in ('current','previous')), 'both accepted vintages available')
    # Execute only the already accepted checker module for bounded ZIP headers.
    header = types.ModuleType('scale_shape_accepted_basis_headers')
    header.__file__ = pins['depth_checker_source']['path']
    raw = checked(pins['depth_checker_source']).read_bytes()
    exec(compile(raw,header.__file__,'exec'),header.__dict__)
    header.basis_headers(pins['basis']['path'])
    return q,plan,result


def run(request_path, request_sha256, out_path):
    q,plan,result = authenticate(request_path,request_sha256,out_path)
    with np.load(q['pins']['basis']['path'],allow_pickle=False) as saved:
        arrays = [saved[k] for k in ('current_z','previous_z','main_state','main_label_end')]
    for values in arrays:
        values.setflags(write=False)
    analysis = analyze_basis(*arrays,plan['pilot']['previous_cutoff'],plan['pilot']['current_cutoff'],result['vintages'])
    for value in q['pins'].values():
        checked(value)
    need(pin(request_path)['sha256'] == request_sha256, 'final unchanged request')
    report = {'schema':'q26-fh-scale-shape-result-v1','label':'CODEX CONTINUATION','complete':True,
              'request_sha256':request_sha256,'request_pins':q['pins'],'source':q['pins']['source'],
              'analysis':analysis,'limitations':INTERPRETATION}
    payload = (json.dumps(report,sort_keys=True,allow_nan=False,separators=(',',':'))+'\n').encode()
    need(len(payload) <= MAX_REPORT, 'bounded saved report')
    fd = os.open(canonical(out_path),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(payload);stream.flush();os.fsync(stream.fileno())
    return report


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    for key in ('request','request-sha256','out'):
        parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    run(args.request,args.request_sha256,args.out)
