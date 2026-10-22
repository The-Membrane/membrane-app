"""Saved-only O139 verification; source alone authorizes no input decoding.

The registered kernel is replayed, including its learned CAL quantiles. An
independent original-source AST reference checks Roriginal's endpoints, bins and
native metrics. Original shard selection/membership remains source-qualified.
"""
import argparse
import ast
import copy
import hashlib
import json
import math
import os
import resource
import shutil
import signal
import struct
import sys
import time
import types
from pathlib import Path

CELLS = ((24, 5), (72, 7))
ARMS = ('F', 'Rclock', 'Roriginal')
RANGES_SHA = '64743b5a6c99b4a8387f573dede3e8ad03c16bc3262d176d9c4b92e24a0ce7d4'
RESULTS = {'cell-24-k5.npz', 'cell-72-k7.npz', 'private-detail.json',
           'public-summary.json', 'checkpoint.json'}


def need(ok, why):
    if not ok:
        raise ValueError(why)


def pin(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and p.is_file() and not p.is_symlink(), 'canonical regular pin')
    h = hashlib.sha256(); size = 0
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            h.update(chunk); size += len(chunk)
    return dict(path=str(p), size=size, sha256=h.hexdigest())


def check(q):
    need(type(q) is dict and set(q) == {'path', 'size', 'sha256'} and pin(q['path']) == q, 'pin drift')


def read(q):
    check(q)
    return json.loads(Path(q['path']).read_bytes())


def module(q, name):
    check(q); m = types.ModuleType(name); m.__file__ = q['path']; sys.modules[name] = m
    exec(compile(Path(q['path']).read_bytes(), q['path'], 'exec'), vars(m))
    return m


def native(np, value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {k: native(np, v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [native(np, v) for v in value]
    return value


def exact_tree(x, y, where='root'):
    need(type(x) is type(y), 'type ' + where)
    if type(x) is dict:
        need(set(x) == set(y), 'fields ' + where)
        for k in x:
            exact_tree(x[k], y[k], where + '.' + k)
    elif type(x) is list:
        need(len(x) == len(y), 'length ' + where)
        for i, (a, b) in enumerate(zip(x, y)):
            exact_tree(a, b, where + '[' + str(i) + ']')
    elif type(x) is float:
        need(math.isfinite(x) and struct.pack('!d', x) == struct.pack('!d', y), 'float bits ' + where)
    else:
        need(x == y, 'value ' + where)


def exact_array(np, x, y, where):
    x, y = np.asarray(x), np.asarray(y)
    need(x.dtype == y.dtype and x.shape == y.shape, 'array schema ' + where)
    if x.dtype.kind == 'f':
        a, b = np.isnan(x), np.isnan(y)
        need(np.array_equal(a, b) and x[~a].tobytes() == y[~b].tobytes(), 'array bits ' + where)
    else:
        need(x.tobytes() == y.tobytes(), 'array values ' + where)


def original_reference(np, p, y, sg, day, source):
    """Execute authenticated ORIGINAL AST, not the diagnostic's reference arm.

    Stable source-line selection is bound to the complete original source SHA.
    Keep its quantile expressions, grouping, CAL loop and scoring operations.
    No original loader, file main, CALb, bootstrap or RNG is executed.
    """
    need(type(source) is bytes and hashlib.sha256(source).hexdigest() == RANGES_SHA, 'original ranges source identity')
    tree = ast.parse(source)
    functions = {'wquant', 'validate_nominal', 'clipped_calibration_range',
                 'interval_score', 'realized_group_coverage'}
    definitions = [copy.deepcopy(n) for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in functions]
    need(len(definitions) == len(functions), 'original callback AST')
    env = dict(np=np, NBIN=5, N_SG=5, nominal=.9)
    exec(compile(ast.fix_missing_locations(ast.Module(body=definitions, type_ignores=[])), '<original callbacks>', 'exec'), env)
    env.update(p=np.asarray(p, np.float64), y=np.asarray(y, np.float64),
               g=np.asarray(sg, np.int64), blk=(np.asarray(day, np.int64)-17532)//182)
    env['lo'] = {'CAL': np.full(len(p), np.nan)}
    env['hi'] = {'CAL': np.full(len(p), np.nan)}
    lines = {131, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 168, 169, 170, 177, 179}
    assignments = sorted([copy.deepcopy(n) for n in ast.walk(tree)
                          if isinstance(n, ast.Assign) and n.lineno in lines], key=lambda n: n.lineno)
    need(len(assignments) == len(lines), 'original grouping/quantile AST')
    loops = [n for n in ast.walk(tree) if isinstance(n, ast.For) and n.lineno == 191]
    need(len(loops) == 1, 'original CAL loop AST')
    loop = copy.deepcopy(loops[0]); need(len(loop.body) == 1 and isinstance(loop.body[0], ast.For), 'original held-fold loop')
    loop.body[0].body = [n for n in loop.body[0].body if n.lineno <= 201]
    need(loop.body[0].body[-1].lineno == 201, 'complete original CAL-only loop')
    exec(compile(ast.fix_missing_locations(ast.Module(body=assignments+[loop], type_ignores=[])), '<original CAL>', 'exec'), env)
    lower, upper = env['lo']['CAL'], env['hi']['CAL']
    count = int(np.isfinite(lower).sum()); n = len(p)
    metric = dict(native_rows=n, partitioned_rows=n, eligible_rows=count,
                  evaluated_rows=count, available_rows=count, unavailable_rows=n-count,
                  groups=0, coverage=None, row_median_width_pp=None,
                  interval_score_pp=None, below=0, above=0)
    if count:
        env['cname'] = 'CAL'
        score_lines = {228, 232, 233, 234, 236, 237, 238, 239, 240, 241, 242, 243, 244}
        score = sorted([copy.deepcopy(z) for z in ast.walk(tree)
                        if isinstance(z, (ast.Assign, ast.If)) and z.lineno in score_lines], key=lambda z: z.lineno)
        need(len(score) == len(score_lines), 'original native scoring AST')
        exec(compile(ast.fix_missing_locations(ast.Module(body=score, type_ignores=[])), '<original native score>', 'exec'), env)
        metric.update(groups=int(env['okg'].sum()), coverage=float(env['cov'].mean()),
                      row_median_width_pp=float(np.median(env['wid'])*100),
                      interval_score_pp=float(env['IS'].mean()*100),
                      below=int((env['yg'] < env['Lg']-1e-12).sum()),
                      above=int((env['yg'] > env['Ug']+1e-12).sum()))
    return dict(lower=lower, upper=upper, bins=env['b'], metric=metric)


def flatten(result):
    a = result['private_arrays']
    out = {k: a[k] for k in ('p', 'y', 'sg', 'day', 'block', 'past_bins', 'original_bins', 'clock_target')}
    for arm in ARMS:
        out[arm+'_lower'], out[arm+'_upper'] = a['bounds'][arm]
        out[arm+'_eligible'] = a['arm_eligible'][arm]
    return out


def verify_saved(np, payloads, detail, public, *, kernel, original_ranges_raw, bound=lambda: None):
    need(type(payloads) is dict and set(payloads) == set(CELLS), 'both fixed cells retained')
    need(set(detail) == {'schema', 'cells', 'catalogues'} and detail['schema'] == 'q26-weighted-causal-primary-pair-detail-v1', 'private detail schema')
    public_fields = {'schema', 'cells', 'calculations_complete', 'scientific_acceptance',
                     'original_R164_NOT_RUN_unchanged', 'base_forecast_model_fits', 'interpretation'}
    need(set(public) == public_fields and public['schema'] == 'q26-weighted-causal-primary-pair-summary-v1', 'public summary schema')
    exact_tree(dict(calculations_complete=True, scientific_acceptance=False,
                    original_R164_NOT_RUN_unchanged=True, base_forecast_model_fits=0,
                    interpretation='Historical descriptive weighted causal amendment; partial support retained; no power or promotion.'),
               {k: public[k] for k in public_fields-{'schema', 'cells'}}, 'public fixed meaning')
    need(len(detail['cells']) == len(detail['catalogues']) == len(public['cells']) == 2, 'two-cell detail/public geometry')
    common_catalogue = None; global_ids = {}; row_totals = []; source_keys = set()
    for pos, key in enumerate(CELLS):
        bound(); a = payloads[key]; n = len(a['p'])
        fields = {'p', 'y', 'sg', 'day', 'block', 'past_bins', 'original_bins', 'clock_target', 'series', 'cluster', 'row_index'}
        fields |= {arm+'_'+suffix for arm in ARMS for suffix in ('lower', 'upper', 'eligible')}
        need(set(a) == fields, 'exact private NPZ fields')
        for name in fields:
            kind = 'bool' if name == 'clock_target' or name.endswith('_eligible') else 'float64' if name in ('p', 'y') or name.endswith(('_lower', '_upper')) else 'int16' if name in ('series', 'cluster') else 'int64'
            need(a[name].dtype == np.dtype(kind) and a[name].shape == (n,), 'private dtype/shape '+name)
        cat = detail['catalogues'][pos]
        need(set(cat) == {'cell', 'names', 'file_order', 'has_boot', 'original_joint_mask'} and cat['cell'] == [*key, 'alts'], 'catalogue cell')
        names, files = cat['names'], cat['file_order']
        need(type(names) is list and type(files) is list and 0 < len(names) == len(files) <= 130 and len(set(names)) == len(names) and all(type(x) is str for x in names+files), 'catalogue geometry')
        need(files == sorted(set(files)) and type(cat['has_boot']) is bool and cat['original_joint_mask'] is True, 'sorted original catalogue/mask declaration')
        catalogue = (names, files, cat['has_boot'])
        if common_catalogue is None: common_catalogue = catalogue
        else: need(catalogue == common_catalogue, 'same full catalogue for both cells')
        need(np.all((a['series'] >= 0) & (a['series'] < len(names))) and np.all(a['cluster'] >= 0) and np.all(a['row_index'] >= 0), 'source key domains')
        need(np.all(np.diff(a['series'].astype(np.int64)) >= 0), 'original catalogue row order')
        keys = set(zip(a['series'].tolist(), a['row_index'].tolist()))
        need(len(keys) == n and not (keys & source_keys), 'unique disjoint original source rows across distinct cells')
        source_keys.update(keys)
        for sid in np.unique(a['series']):
            take = a['series'] == sid; indices = a['row_index'][take]
            need(np.all(np.diff(indices) > 0), 'source row-index order/uniqueness')
            ids = (tuple(np.unique(a['cluster'][take]).tolist()), tuple(np.unique(a['sg'][take]).tolist()))
            need(len(ids[0]) == len(ids[1]) == 1, 'constant source cluster/SG')
            s = int(sid)
            need(s not in global_ids or global_ids[s] == ids, 'cross-cell source cluster/SG identity'); global_ids[s] = ids
        result = kernel.cell(a['p'], a['y'], a['sg'], a['day'], horizon=key[0], level_index=key[1])
        for name, value in flatten(result).items(): exact_array(np, value, a[name], name)
        expected = native(np, {k: v for k, v in result.items() if k != 'private_arrays'})
        exact_tree(expected, detail['cells'][pos], 'private cell '+str(key))
        exact_tree({k: v for k, v in expected.items() if k != 'folds'}, public['cells'][pos], 'public cell '+str(key))
        reference = original_reference(np, a['p'], a['y'], a['sg'], a['day'], original_ranges_raw)
        exact_array(np, reference['lower'], a['Roriginal_lower'], 'independent original lower')
        exact_array(np, reference['upper'], a['Roriginal_upper'], 'independent original upper')
        exact_array(np, reference['bins'], a['original_bins'], 'independent original bins')
        exact_tree(reference['metric'], expected['original_reference_native'], 'independent original native metrics')
        row_totals.append(n); bound()
    return dict(both_fixed_cells_verified=True, all_saved_array_bits_and_nan_masks_exact=True,
                all_fold_receipts_views_support_and_pair_deltas_exact=True,
                original_reference_independent_AST_endpoints_bins_and_native_metrics_exact=True,
                source_key_order_and_cross_cell_mapping_verified=True,
                raw_shard_membership_independently_reconstructed=False,
                original_mask_and_row_alignment_source_qualified=True,
                native_rows=row_totals, new_base_forecasting_model_fits=0,
                no_new_power_or_confirmation_claim=True)


POLICY = dict(wall_seconds=90, rss_bytes=1073741824,
              disk_reserve_bytes=2147483648, output_bytes=67108864)


def saved_context(r):
    """Authenticate retained metadata/runtime/outputs, NEVER original shards.

    Producer completion and the parent's freshly captured five output pins are
    authorities here. This function deliberately does not call any producer or
    original-input authenticator. It does not claim a fresh raw membership audit.
    """
    need(r.get('schema') == 'q26-weighted-causal-primary-pair-saved-request-v1'
         and r.get('parent_admitted') is True and r.get('saved_only') is True, 'saved admission')
    need(r['policy'] == POLICY, 'saved fixed policy')
    p = r['pins']
    need({'implementation', 'tests', 'producer_request', 'producer_terminal',
          'producer_observer_request'} <= set(p), 'saved source roles')
    need(p['implementation'] == pin(__file__), 'consumer executing source')
    # Metadata pins are read before any saved NPZ. No source shard is opened.
    producer = read(p['producer_request'])
    need(producer['schema'] == 'q26-weighted-causal-primary-pair-run-request-v1'
         and producer['parent_admitted'] is True
         and producer['cells'] == [[24, 5, 'alts'], [72, 7, 'alts']], 'producer fixed admitted pair')
    old = read(producer['pins']['accepted_input_request'])
    need(len(old['inputs']) == 130 and len({v['path'] for v in old['inputs']}) == 130, 'retained130 membership metadata')
    forbidden = {str(Path(v['path']).resolve()) for v in old['inputs']}
    watched = {}

    def add(q, legacy=False):
        # Check path separation BEFORE opening bytes. Legacy interpreter alias
        # metadata remains authenticated; its watched byte identity is canonical.
        need(type(q) is dict and set(q) == {'path', 'size', 'sha256'}, 'typed watched pin')
        path = str(Path(q['path']).resolve())
        need(path not in forbidden, 'original shard read forbidden in saved consumer')
        v = dict(q, path=path) if legacy else q
        check(v)
        need(path not in watched or watched[path] == v, 'conflicting watched identity')
        watched[path] = v

    for v in p.values(): add(v)
    for v in producer['pins'].values(): add(v)
    for v in old['pins'].values(): add(v)
    for v in old['runtime_pins']: add(v, legacy=True)
    need(r['invocation_python'] == sys.executable
         and r['resolved_python'] == str(Path(sys.executable).resolve()), 'saved interpreter')
    need(r['threads'] == old['threads'] and all(os.environ.get(k) == v for k, v in r['threads'].items()), 'saved thread environment')
    need(r['resolved_python'] in watched, 'watched interpreter binary')
    outer, terminal = read(p['producer_observer_request']), read(p['producer_terminal'])
    need(outer['inner_request'] == p['producer_request']
         and outer['runner'] == producer['pins']['implementation'], 'observer inner/runner binding')
    need(terminal['schema'] == 'q26-weighted-causal-primary-pair-observer-terminal-v1'
         and terminal['request'] == p['producer_observer_request']
         and terminal['runner'] == producer['pins']['implementation']
         and type(terminal['tool_terminal_exit']) is int and terminal['tool_terminal_exit'] == 0
         and terminal['process_terminal'] is True and terminal['complete'] is True
         and terminal['fixture_only'] is False
         and terminal['containment']['reaped'] is True
         and terminal['containment']['no_live_members_remaining'] is True, 'producer terminal authority')
    outputs = r['outputs']; need(set(outputs) == RESULTS, 'all five saved outputs')
    root = Path(producer['out'])
    need(root.is_dir() and not root.is_symlink() and root.resolve() == root
         and root.stat().st_mode & 0o777 == 0o700
         and {x.name for x in root.iterdir()} == RESULTS, 'existing exact private producer root')
    for name, q in outputs.items():
        need(q['path'] == str(root/name) and (root/name).stat().st_mode & 0o777 == 0o600, 'saved output path/mode')
        add(q)
    need(sum(q['size'] for q in outputs.values()) <= POLICY['output_bytes'], 'saved output byte cap')
    cp = read(outputs['checkpoint.json'])
    need(cp['schema'] == 'q26-weighted-causal-primary-pair-checkpoint-v1'
         and cp['status'] == 'COMPLETE' and cp['stage'] == 'complete'
         and type(cp['completed_cells']) is int and cp['completed_cells'] == 2, 'scientific checkpoint complete both cells')
    return producer, list(watched.values()), [v['path'] for v in old['inputs']]


def bind_production_catalogues(detail, file_order):
    """Bind saved catalogue order to authenticated metadata, without raw reads.

    This proves the catalogue declaration's scope, not independently loaded
    shard membership or the source-qualified SG/cluster assignment.
    """
    need(type(file_order) is list and len(file_order) == 130
         and len(set(file_order)) == 130, 'production130 source catalogue')
    need(type(detail.get('catalogues')) is list and len(detail['catalogues']) == 2, 'production two catalogues')
    for cat in detail['catalogues']:
        need(cat['file_order'] == file_order and type(cat['names']) is list
             and len(cat['names']) == 130, 'production catalogue exact accepted file order')


def atomic(path, value):
    raw = (json.dumps(value, allow_nan=False, separators=(',', ':'))+'\n').encode()
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())
    need(path.stat().st_mode & 0o777 == 0o600 and path.read_bytes() == raw, 'receipt readback')


def accept(path, sha, out):
    started = time.monotonic(); request_pin = pin(path)
    need(request_pin['sha256'] == sha, 'trusted saved request SHA')
    r = read(request_pin); target = Path(out)
    need(r['out'] == out and target.is_absolute() and target.resolve() == target
         and not target.exists() and not target.is_symlink() and target.parent.is_dir(), 'fresh bound receipt')
    prior_handler = signal.getsignal(signal.SIGALRM)
    def timeout(*_): raise TimeoutError('saved verification wall cap')
    signal.signal(signal.SIGALRM, timeout)
    prior_timer = signal.setitimer(signal.ITIMER_REAL, POLICY['wall_seconds'])
    try:
        producer, watched, file_order = saved_context(r); watched.append(request_pin)
        def bound():
            need(time.monotonic()-started < POLICY['wall_seconds'], 'saved wall cap')
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if sys.platform != 'darwin': rss *= 1024
            need(rss <= POLICY['rss_bytes'] and shutil.disk_usage(target.parent).free >= POLICY['disk_reserve_bytes'], 'saved resource cap')
        bound()
        G = module(producer['pins']['read_guard'], 'q26_saved_pair_guard')
        with G.guard([v['path'] for v in watched], target.parent):
            import numpy as np
            K = module(producer['pins']['kernel'], 'q26_saved_pair_science')
            payloads = {}
            for H, k in CELLS:
                with np.load(r['outputs'][f'cell-{H}-k{k}.npz']['path'], allow_pickle=False) as z:
                    payloads[(H, k)] = {name: z[name] for name in z.files}
                bound()
            detail, public = read(r['outputs']['private-detail.json']), read(r['outputs']['public-summary.json'])
            bind_production_catalogues(detail, file_order)
            proof = verify_saved(np, payloads, detail, public, kernel=K,
                                 original_ranges_raw=Path(producer['pins']['original_ranges']['path']).read_bytes(), bound=bound)
            for v in watched: check(v)
            bound(); elapsed = time.monotonic()-started
            receipt = dict(schema='q26-weighted-causal-primary-pair-saved-acceptance-v1',
                           accepted=True, request=request_pin, consumer_source=r['pins']['implementation'],
                           producer_request=r['pins']['producer_request'],
                           producer_terminal=r['pins']['producer_terminal'],
                           producer_observer_request=r['pins']['producer_observer_request'],
                           output_pins=r['outputs'], proof=proof, elapsed_seconds=elapsed,
                           charged_seconds=math.ceil(elapsed), saved_only=True)
            atomic(target, receipt)
        return receipt
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior_handler)
        if prior_timer[0]: signal.setitimer(signal.ITIMER_REAL, *prior_timer)


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('--request', required=True); cli.add_argument('--sha256', required=True)
    cli.add_argument('--out', required=True)
    a = cli.parse_args(); accept(a.request, a.sha256, a.out)
