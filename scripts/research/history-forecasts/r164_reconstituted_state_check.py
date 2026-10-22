"""Independent, optimizer-free checker for newly reconstituted O33 states.

No producer or GJR calculation helper is imported. External admission must pin
both the plan and output manifest. A caller may supply its separately qualified
a6-compatible loader. This verifies fixed-state arithmetic, not optimizer choice,
optimizer convergence, original state-byte recovery, or predictive parity.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, localcontext
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import sys

import numpy as np
from numba import njit

PIN = 'f9389b68ee1a4a94417a9311bc42dc974b4613fd'
HORIZONS = (24, 72, 168, 720)
FIELDS = ('expected_terminal_h', 'expected_terminal_h2', 'expected_sum_h',
          'nominal_terminal_h', 'nominal_sum_h', 'terminal_mean_ratio', 'sum_mean_ratio')
EPS = np.finfo(float).eps
OBJECTIVE_ABSOLUTE = 1e-8
LOG_TOLERANCE = 1e-9


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    require(type(value) in (float, int) and math.isfinite(value), 'finite numeric scalar required')
    return float(value)


def integer(value):
    require(type(value) is int, 'integer required')
    return value


def digest(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), 'regular nonsymlink file required')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def read_json(path, expected):
    require(digest(path) == expected, 'file hash mismatch: ' + str(path))
    return json.loads(Path(path).read_text())


def runtime_identity():
    return dict(python=sys.version, executable=sys.executable, machine=platform.machine(),
                platform=platform.platform(), dependencies={name: importlib.metadata.version(name)
                for name in ('numpy', 'scipy', 'numba', 'llvmlite')})


@njit(cache=False)
def filter_fixed(returns, w, alpha, gamma, beta, initial):
    # Preserve original floating operation order; no fastmath or optimizer.
    result = np.empty(len(returns) + 1)
    result[0] = initial
    for i in range(len(returns)):
        r = returns[i]
        if np.isfinite(r):
            result[i + 1] = w + ((alpha + gamma * (r < 0)) * r * r + beta * result[i])
        else:
            result[i + 1] = w + (alpha + .5 * gamma + beta) * result[i]
    return result


@njit(cache=False)
def objective_filter(returns, w, alpha, gamma, beta, initial):
    # _loss has a distinct left-associative update: (w + shock) + beta*h.
    result = np.empty(len(returns) + 1)
    result[0] = initial
    for i in range(len(returns)):
        r = returns[i]
        if np.isfinite(r):
            result[i + 1] = w + (alpha + gamma * (r < 0)) * r * r + beta * result[i]
        else:
            result[i + 1] = w + (alpha + .5 * gamma + beta) * result[i]
    return result


def model_values(model):
    require(set(model) == {'w', 'alpha', 'gamma', 'beta'}, 'model fields')
    w, a, g, b = [number(model[k]) for k in ('w', 'alpha', 'gamma', 'beta')]
    require(w > 0 and min(a, g, b) >= 0 and a + .5 * g + b < .9995, 'model constraints')
    return w, a, g, b


def reconstruct(close, low, quarter, max_origin, model):
    w, a, g, b = model_values(model)
    require(1 <= quarter <= max_origin <= len(close) and len(close) == len(low), 'prefix bounds')
    c, l = np.asarray(close[:max_origin], dtype=float), np.asarray(low[:max_origin], dtype=float)
    returns, wick = np.full(max_origin, np.nan), np.full(max_origin, np.nan)
    with np.errstate(divide='ignore', invalid='ignore', over='ignore'):
        returns[1:] = np.where((c[1:] > 0) & (c[:-1] > 0), np.log(c[1:] / c[:-1]), np.nan)
        wick[1:] = np.where((l[1:] > 0) & (c[:-1] > 0), np.log(l[1:] / c[:-1]), np.nan)
    start = max(1, quarter - 26280)
    train = returns[start:quarter]
    finite = train[np.isfinite(train)]
    require(len(finite) >= 2000, 'training finite support')
    variance = float(np.var(finite))
    require(math.isfinite(variance) and variance > 0, 'positive training variance')
    require(w == variance * (1 - a - .5 * g - b), 'variance targeting omega')
    h = filter_fixed(returns, w, a, g, b, variance)
    require(np.isfinite(h).all() and (h > 0).all(), 'positive finite filter')
    pairs = np.column_stack((train, wick[start:quarter])) / np.sqrt(h[start:quarter, None])
    valid = np.isfinite(pairs).all(axis=1) & (pairs[:, 1] <= np.maximum(pairs[:, 0], 0) + 1e-12)
    pairs = pairs[valid]
    require(len(pairs) > 1000, 'paired pool support')
    pairs[:, 1] = np.minimum(pairs[:, 1], np.minimum(pairs[:, 0], 0))
    canonical = np.ascontiguousarray(pairs, dtype='<f8')
    descriptor = dict(stored=False, sha256=hashlib.sha256(canonical.tobytes(order='C')).hexdigest(),
        shape=list(canonical.shape), dtype='<f8', order='C',
        hash_encoding='raw contiguous little-endian float64 payload; no header')
    # Objective filter starts at the trailing-window variance, not inception h.
    # Original QMLE objective groups persistence before subtraction, whereas
    # saved variance-targeted omega uses sequential subtractions. Preserve both.
    objective_w = variance * (1 - (a + .5 * g + b))
    ht = objective_filter(train, objective_w, a, g, b, variance)[:-1]
    mask = np.isfinite(train)
    components = np.log(ht[mask]) + train[mask] * train[mask] / ht[mask]
    require(np.isfinite(components).all(), 'finite objective components')
    objective = .5 * float(np.sum(components))
    objective_tolerance = 64 * EPS * float(np.sum(np.abs(components))) + OBJECTIVE_ABSOLUTE
    z = pairs[:, 0]
    square = z * z
    multiplier = b + (a + g * (z < 0)) * square
    moments = dict(z_mean=float(np.mean(z)), z2=float(np.mean(square)),
        z2_negative=float(np.mean(square * (z < 0))), z4=float(np.mean(square * square)),
        rho_emp=float(np.mean(multiplier)), mean_A2=float(np.mean(multiplier * multiplier)),
        rho_nominal=float(a + .5 * g + b), pool_pairs=len(pairs))
    require(all(math.isfinite(v) for v in moments.values()), 'finite multiplier moments')
    moments.update(empirical_mean_stationary=moments['rho_emp'] < 1,
        empirical_h_second_moment_stationary=moments['mean_A2'] < 1)
    return dict(variance=variance, finite=len(finite), h=h, pool=descriptor, moments=moments,
                objective=objective, objective_tolerance=objective_tolerance, start=start)


def decimal_moments(model, h0, moments, horizons=HORIZONS):
    """Independent 80-digit ordinary-domain recurrences, never logaddexp."""
    require(number(h0) > 0, 'positive origin variance')
    require(horizons and all(type(t) is int and t > 0 for t in horizons), 'horizons')
    w, a, g, b = model_values(model)
    with localcontext() as context:
        context.prec = 80
        context.Emax, context.Emin = 999999999, -999999999
        dec = Decimal.from_float
        w, rho, a2 = dec(w), dec(number(moments['rho_emp'])), dec(number(moments['mean_A2']))
        nominal_rho = dec(float(a + .5 * g + b))
        require(rho >= 0 and a2 >= 0, 'nonnegative multiplier moments')
        mean = nominal = dec(float(h0))
        second, total, nominal_total = mean * mean, Decimal(0), Decimal(0)
        result = {}
        for t in range(1, max(horizons) + 1):
            total += mean
            nominal_total += nominal
            second = w * w + 2 * w * rho * mean + a2 * second
            mean = w + rho * mean
            nominal = w + nominal_rho * nominal
            if t in horizons:
                values = (mean, second, total, nominal, nominal_total, mean / nominal, total / nominal_total)
                result[str(t)] = {k: (v, v.log10()) for k, v in zip(FIELDS, values)}
        return result


def check_horizons(saved, model, h0, moments):
    reference = decimal_moments(model, h0, moments)
    require(set(saved) == {str(h) for h in HORIZONS}, 'saved horizon support')
    largest = Decimal.from_float(float(np.finfo(float).max))
    half_smallest = Decimal.from_float(float(np.nextafter(0., 1.))) / 2
    maximum_error = 0.
    for horizon, fields in reference.items():
        cell = saved[horizon]
        require(set(cell) == set(FIELDS) | {'log10', 'nonrepresentable_float64'}, 'horizon fields')
        require(set(cell['log10']) == set(FIELDS), 'log fields')
        overflow = []
        for name, (value, logvalue) in fields.items():
            expected_log = float(logvalue)
            observed_log = number(cell['log10'][name])
            tolerance = LOG_TOLERANCE * (1 + abs(expected_log))
            error = abs(observed_log - expected_log)
            require(error <= tolerance, 'Decimal log moment mismatch: ' + name)
            maximum_error = max(maximum_error, error)
            if value > largest:
                overflow.append(name)
                require(cell[name] is None, 'overflow must be null')
            else:
                ordinary = number(cell[name])
                require(ordinary >= 0, 'nonnegative finite moment')
                if ordinary == 0:
                    require(value <= half_smallest, 'unjustified underflow zero')
                else:
                    require(abs(math.log10(ordinary) - expected_log) <= tolerance, 'ordinary moment mismatch')
        require(cell['nonrepresentable_float64'] == overflow, 'overflow flags')
    return maximum_error


def check_diagnostics(saved, rebuilt, quarter, origin):
    require(type(saved['optimizer_success']) is bool, 'optimizer status must be boolean')
    require(integer(saved['finite_training_returns']) == rebuilt['finite'], 'finite training count')
    require(integer(saved['pool_pairs']) == rebuilt['moments']['pool_pairs'], 'pool diagnostic count')
    require(integer(saved['training_end_exclusive']) == quarter, 'training end clock')
    require(integer(saved['state_end_exclusive']) == origin, 'state end clock')
    difference = abs(number(saved['objective']) - rebuilt['objective'])
    require(difference <= rebuilt['objective_tolerance'], 'fixed-parameter objective mismatch')
    return difference


def check_series(key, saved, old, close, low, folds):
    require(saved['complete'] is True and saved['series'] == key, 'series identity/status')
    rows = old['rows']
    require(rows and all(r['p_garch'] is not None for r in rows), 'historical GJR availability')
    origins = sorted({integer(r['i0']) for r in rows})
    states = saved['origins']
    require([integer(s['origin']) for s in states] == origins, 'exact origin support/order')
    assignment = {}
    for origin in origins:
        hits = [f for f in folds if f['qs_i'] <= origin < f['qe_i']]
        require(len(hits) == 1, 'unique quarter assignment')
        assignment[origin] = int(hits[0]['qs_i'])
    quarters = saved['quarters']
    quarter_keys = [integer(q['quarter']) for q in quarters]
    require(quarter_keys == sorted(set(assignment.values())), 'exact quarter support/order')
    require(integer(old['quarter_fits']) == len(quarters), 'historical quarter count')
    reconstructed = {}
    max_log_error = 0.
    for q in quarters:
        index = q['quarter']
        members = [o for o in origins if assignment[o] == index]
        rebuilt = reconstruct(close, low, index, max(members), q['model'])
        require(q['training_variance'] == rebuilt['variance'] and q['filter_initial_variance'] == rebuilt['variance'], 'training variance')
        require(integer(q['training_start_inclusive']) == rebuilt['start'], 'training start')
        require(q['quarter_h'] == float(rebuilt['h'][index]), 'quarter state')
        require(q['pool'] == rebuilt['pool'], 'canonical pool descriptor/hash')
        require(q['reconstruction_verified_exact'] is True, 'reconstruction flag')
        require(q['reconstruction'] == 'reconstruct_pool(pinned_close,pinned_low,quarter,GJR(**model),training_variance)', 'reconstruction recipe')
        require(set(q['moments']) == set(rebuilt['moments']), 'pool moment fields')
        for name, value in rebuilt['moments'].items():
            observed = q['moments'][name]
            if type(value) is bool:
                require(type(observed) is bool and observed == value, 'stationarity flag')
            elif type(value) is int:
                require(integer(observed) == value, 'moment pool count')
            else:
                require(abs(number(observed) - value) <= 64 * EPS * (1 + abs(value)), 'pool moment mismatch')
        check_diagnostics(q['diagnostics'], rebuilt, index, min(members))
        reconstructed[index] = (q, rebuilt)
    for s in states:
        origin, index = s['origin'], integer(s['quarter'])
        require(index == assignment[origin], 'origin quarter')
        q, rebuilt = reconstructed[index]
        require(number(s['h0']) == float(rebuilt['h'][origin]), 'origin state')
        check_diagnostics(s['diagnostics'], rebuilt, index, origin)
        max_log_error = max(max_log_error, check_horizons(s['horizons'], q['model'], s['h0'], rebuilt['moments']))
    return dict(quarters=len(quarters), origins=len(origins), historical_rows=len(rows), max_log10_error=max_log_error)


def check(plan_path, output_dir, plan_sha256, manifest_sha256, loader=None):
    """Authenticate before decoding; loader returns (series, folds, metadata)."""
    plan_path, output_dir = Path(plan_path), Path(output_dir)
    plan = read_json(plan_path, plan_sha256)
    require(plan['pin'] == PIN and plan['horizons'] == list(HORIZONS), 'plan scientific identity')
    require(plan['runtime'] == runtime_identity(), 'runtime identity')
    pins = plan['files']
    require(type(pins) is dict and pins, 'input pins')
    for path, expected in pins.items():
        require(digest(path) == expected, 'input hash mismatch: ' + path)
    manifest_path = output_dir / 'manifest.json'
    manifest = read_json(manifest_path, manifest_sha256)
    require(manifest['complete'] is True and manifest['plan'] == plan and manifest['plan_sha256'] == plan_sha256, 'bound complete manifest')
    require(integer(manifest['n_origins']) == 2619 and integer(manifest['n_quarters']) == 806, 'manifest counts')
    outputs = manifest['output_sha256']
    require(len(outputs) == 42 and all(Path(n).name == n and n.startswith('blind5-') and n.endswith('.json') for n in outputs), 'output inventory')
    require({p.name for p in output_dir.glob('*.json')} == set(outputs) | {'manifest.json'}, 'unexpected/missing output JSON')
    decoded = {n: read_json(output_dir / n, expected) for n, expected in outputs.items()}
    historical = Path(plan['historical'])
    require({p.name for p in historical.glob('blind5-*.json')} == set(outputs), 'historical filename support')
    old = {}
    for name in outputs:
        path = historical / name
        require(str(path) in pins and decoded[name]['historical_checkpoint_sha256'] == pins[str(path)], 'historical checkpoint binding')
        old[name] = read_json(path, pins[str(path)])['result']
        stored = Path(plan['datasets']) / 'history-forecasts/r16/r164-dev-63d4700f/rows' / (Path(name).stem + '.npz')
        require(str(stored) in pins, 'stored-row input pin missing')
    raw = Path(plan['datasets']) / 'blind5-prices'
    require(all(str(p) in pins for p in raw.rglob('*') if p.is_file()), 'unpinned raw input')
    require(all(str(p) in pins for p in historical.glob('*.json')), 'unpinned historical input')
    if loader is None:
        import a6_touch
        loader = a6_touch.build_blind_dir
    series, folds, _ = loader(plan['datasets'], 'blind5-prices', PIN, 'blind5:', verify=True)
    require(len(series) == 42 and set(series) == set(folds), 'loaded series support')
    require({k.replace(':', '-') + '.json' for k in series} == set(outputs), 'loaded/output identity')
    totals = dict(series=42, quarters=0, origins=0, historical_rows=0, max_log10_error=0.)
    for key in sorted(series):
        name = key.replace(':', '-') + '.json'
        result = check_series(key, decoded[name], old[name], series[key].close, series[key].low, folds[key])
        for field in ('quarters', 'origins', 'historical_rows'):
            totals[field] += result[field]
        totals['max_log10_error'] = max(totals['max_log10_error'], result['max_log10_error'])
    require((totals['quarters'], totals['origins'], totals['historical_rows']) == (806, 2619, 104310), 'complete original support totals')
    # Recheck bytes after arithmetic and loader activity, before accepting.
    require(digest(plan_path) == plan_sha256 and digest(manifest_path) == manifest_sha256, 'authority changed during check')
    for path, expected in pins.items():
        require(digest(path) == expected, 'input changed during check')
    for name, expected in outputs.items():
        require(digest(output_dir / name) == expected, 'output changed during check')
    require({p.name for p in output_dir.glob('*.json')} == set(outputs) | {'manifest.json'}, 'output inventory changed during check')
    require({p.name for p in historical.glob('blind5-*.json')} == set(outputs), 'historical inventory changed during check')
    require(all(str(p) in pins for p in raw.rglob('*') if p.is_file()), 'raw inventory changed during check')
    return dict(complete=True, **totals, optimizer_selection_verified=False,
        optimizer_success_verified=False, original_state_bytes_recovered=False,
        prediction_parity_verified=False, plan_sha256=plan_sha256, manifest_sha256=manifest_sha256)


def run_to_receipt(plan_path, output_dir, plan_sha256, manifest_sha256, out, loader=None):
    """Refuse existing output before reads, then exclusively persist <=64KiB."""
    out = Path(out)
    require(not os.path.lexists(out), 'receipt output already exists')
    require(out.parent.is_dir(), 'receipt parent directory required')
    require(not out.resolve().is_relative_to(Path(output_dir).resolve()), 'receipt must be outside producer root')
    result = check(plan_path, output_dir, plan_sha256, manifest_sha256, loader=loader)
    payload = (json.dumps(result, sort_keys=True, allow_nan=False) + '\n').encode()
    require(len(payload) <= 65536, 'receipt exceeds 64KiB')
    with out.open('xb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    receipt = run_to_receipt(args.plan, args.output_dir, args.plan_sha256, args.manifest_sha256, args.out)
    print(json.dumps(dict(complete=receipt['complete'], series=receipt['series'], quarters=receipt['quarters'], origins=receipt['origins'])))
