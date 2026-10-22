"""Baseline-only exact replay from accepted fixed O33 reconstruction states.

Source qualification does not authorize execution. Never fits, scores, chooses an
arm, changes paths, relaxes equality, or touches unseen collections.
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
import numpy as np

PIN = 'f9389b68ee1a4a94417a9311bc42dc974b4613fd'
SCHEMA = 'q26-r164-baseline-replay-plan-v1'
MANIFEST_SCHEMA = 'q26-r164-baseline-replay-manifest-v1'
CONSTANTS = dict(paths=1000, origin_every=28, horizons=[24, 72, 168, 720],
    expected_series=42, expected_quarters=806, expected_origins=2619, expected_rows=104310)
HERE = Path(__file__).resolve().parent
SOURCES = ('r164_baseline_replay.py', 'r164_baseline_replay_check.py', 'r164_pool_moment_review.py',
    'r164_step_real_review.py', 'r164_step_review.py', 'r164_recursive.py',
    'a_touch.py', 'a2_touch.py', 'a3_touch.py', 'a4_touch.py', 'a5_touch.py', 'a6_touch.py')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), 'regular nonsymlink file required')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def record(path):
    path = Path(path)
    return dict(path=str(path), sha256=digest(path), size=path.stat().st_size)


def verify_record(item):
    require(type(item) is dict and set(item) == {'path', 'sha256', 'size'}, 'file record fields')
    require(type(item['path']) is str and Path(item['path']).is_absolute(), 'absolute input path')
    require(type(item['size']) is int and item['size'] >= 0, 'file size type')
    require(type(item['sha256']) is str and len(item['sha256']) == 64 and all(c in '0123456789abcdef' for c in item['sha256']), 'SHA256 encoding')
    require(digest(item['path']) == item['sha256'] and Path(item['path']).stat().st_size == item['size'], 'file record mismatch')


def read_record(item):
    verify_record(item)
    return json.loads(Path(item['path']).read_text(), object_pairs_hook=unique_object)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON object key')
        result[key] = value
    return result


def runtime_identity():
    return dict(python=sys.version, executable=sys.executable, machine=platform.machine(),
        platform=platform.platform(), dependencies={name: importlib.metadata.version(name)
        for name in ('numpy', 'scipy', 'numba', 'llvmlite')})


def integer(value):
    require(type(value) is int, 'integer required')
    return value


def probability(value):
    require(type(value) is float and math.isfinite(value) and 0 <= value <= 1, 'finite native float probability required')
    return float(value)


def historical_identity(key, historical, saved, filename=None, packet=None):
    """O144 identity is authenticated filename/state plus mandatory row series.

    Derived historical result objects do not have a series header. A header,
    if present in either enclosing object, must nevertheless agree.
    """
    require(type(key) is str and key.startswith('blind5:'), 'historical series key')
    require(saved['series'] == key, 'saved state series identity')
    if filename is not None:
        require(filename == key.replace(':', '-') + '.json', 'historical filename identity')
    require(type(historical) is dict and {'rows', 'quarter_fits'}.issubset(historical), 'historical result shape')
    for item in (historical, packet):
        if item is not None:
            require(type(item) is dict and ('series' not in item or item['series'] == key), 'contradictory historical series header')
    require(type(historical['rows']) is list and historical['rows'], 'historical rows required')
    require(all(type(row) is dict and row.get('series') == key for row in historical['rows']), 'mandatory historical row series identity')
    integer(historical['quarter_fits'])


def authenticate(plan_path, plan_sha256):
    # External hash admission precedes all JSON decoding.
    require(digest(plan_path) == plan_sha256, 'external plan hash mismatch')
    plan = json.loads(Path(plan_path).read_text(), object_pairs_hook=unique_object)
    require(set(plan) == {'schema', 'authorities', 'files', 'source_commit', 'runtime', 'constants', 'output_dir'}, 'plan fields')
    require(plan['schema'] == SCHEMA and plan['constants'] == CONSTANTS, 'fixed replay scope')
    require(all(type(plan['constants'][k]) is int for k in CONSTANTS if k != 'horizons') and
        all(type(h) is int for h in plan['constants']['horizons']), 'constant integer types')
    require(plan['runtime'] == runtime_identity(), 'runtime identity changed')
    require(type(plan['source_commit']) is str and len(plan['source_commit']) == 40 and all(c in '0123456789abcdef' for c in plan['source_commit']), 'source commit identity')
    require(Path(plan['output_dir']).is_absolute(), 'absolute output directory')
    authorities = plan['authorities']
    require(set(authorities) == {'state_plan', 'state_manifest', 'state_acceptance', 'original_config'}, 'authority roles')
    require(type(plan['files']) is list and plan['files'], 'file closure required')
    pins = {}
    for item in plan['files']:
        verify_record(item)
        require(item['path'] not in pins, 'duplicate file path')
        pins[item['path']] = item
    for name in SOURCES:
        require(str(HERE / name) in pins, 'missing executing source pin: ' + name)
    for item in authorities.values():
        verify_record(item)
        require(pins.get(item['path']) == item, 'authority absent from closure')
    state_plan = read_record(authorities['state_plan'])
    require(state_plan['pin'] == PIN and state_plan['horizons'] == CONSTANTS['horizons'], 'state scientific identity')
    require(state_plan['runtime'] == plan['runtime'], 'accepted state runtime differs')
    for path, sha in state_plan['files'].items():
        require(path in pins and pins[path]['sha256'] == sha, 'state input/source closure lost')
    manifest = read_record(authorities['state_manifest'])
    require(manifest['complete'] is True and manifest['plan'] == state_plan and manifest['plan_sha256'] == authorities['state_plan']['sha256'], 'state manifest binding')
    require((manifest['n_quarters'], manifest['n_origins']) == (806, 2619), 'state manifest counts')
    acceptance = read_record(authorities['state_acceptance'])
    require(acceptance['complete'] is True and acceptance['plan_sha256'] == authorities['state_plan']['sha256'] and acceptance['manifest_sha256'] == authorities['state_manifest']['sha256'], 'state acceptance binding')
    require(tuple(acceptance[k] for k in ('series', 'quarters', 'origins', 'historical_rows')) == (42, 806, 2619, 104310), 'state acceptance support')
    config = read_record(authorities['original_config'])
    config = config['config']
    require(type(config['paths']) is int and config['paths'] == 1000 and type(config['origin_every']) is int and config['origin_every'] == 28, 'original simulation configuration')
    require(config['pin'] == PIN[:7] and config['collection'] == 'blind5-prices', 'original collection identity')
    root = Path(authorities['state_manifest']['path']).parent
    outputs = manifest['output_sha256']
    require(len(outputs) == 42 and all(Path(n).name == n and n.startswith('blind5-') and n.endswith('.json') for n in outputs), 'state output names')
    require({p.name for p in root.iterdir()} == set(outputs) | {'manifest.json'}, 'state inventory')
    require(type(config['selected_series']) is list and len(config['selected_series']) == 42 and len(set(config['selected_series'])) == 42 and
        {k.replace(':', '-') + '.json' for k in config['selected_series']} == set(outputs), 'original selected series')
    require(config['selected_series'] == sorted(config['selected_series']), 'original series order')
    require(set(config['inputs']) == set(config['selected_series']), 'original input identity support')
    for name, expected in config['sources'].items():
        matches = [item for path, item in pins.items() if Path(path).name == name]
        require(len(matches) == 1 and matches[0]['sha256'] == expected, 'original source closure binding')
    for name in SOURCES:
        if name not in ('r164_baseline_replay.py', 'r164_baseline_replay_check.py', 'r164_pool_moment_review.py'):
            require(config['sources'].get(name) == pins[str(HERE / name)]['sha256'], 'original numerical source changed: ' + name)
    saved = {}
    for name, sha in outputs.items():
        path = str(root / name)
        require(path in pins and pins[path]['sha256'] == sha, 'state output closure')
        saved[name] = read_record(pins[path])
    historical = Path(state_plan['historical'])
    require({p.name for p in historical.iterdir()} == set(outputs), 'historical inventory')
    raw = Path(state_plan['datasets']) / 'blind5-prices'
    require(raw.is_dir() and not raw.is_symlink() and all(not p.is_symlink() and (not p.is_file() or str(p) in pins) for p in raw.rglob('*')), 'raw inventory')
    old = {}
    for name in outputs:
        path = str(historical / name)
        require(path in pins and saved[name]['historical_checkpoint_sha256'] == pins[path]['sha256'], 'historical state binding')
        packet = read_record(pins[path])
        require(type(packet) is dict and 'result' in packet, 'historical envelope shape')
        old[name] = packet['result']
        historical_identity(saved[name]['series'], old[name], saved[name], filename=name, packet=packet)
        npz = str(Path(state_plan['datasets']) / 'history-forecasts/r16/r164-dev-63d4700f/rows' / (Path(name).stem + '.npz'))
        require(npz in pins, 'NPZ pin missing')
        key = saved[name]['series']
        require(config['inputs'].get(key) == pins[npz]['sha256'], 'original NPZ content binding')
    return plan, state_plan, saved, old


def replay_series(key, ser, folds, saved, old, npz_path, G, P, R):
    """Fixed model, ordered reconstructed pool and fresh original seed per origin."""
    historical_identity(key, old, saved)
    require(saved['complete'] is True, 'series completion')
    rows = old['rows']
    require(rows, 'historical rows required')
    keys = [(r['series'], integer(r['i0']), integer(r['T']), integer(r['k'])) for r in rows]
    require(len(keys) == len(set(keys)) and all(k[0] == key for k in keys), 'unique historical keyed support')
    origins = sorted({k[1] for k in keys})
    require([integer(s['origin']) for s in saved['origins']] == origins, 'saved origin support/order')
    quarters = {integer(q['quarter']): q for q in saved['quarters']}
    require(len(quarters) == len(saved['quarters']) == integer(old['quarter_fits']), 'quarter support')
    assigned = {}
    for origin in origins:
        hits = [f for f in folds if f['qs_i'] <= origin < f['qe_i']]
        require(len(hits) == 1, 'unique quarter assignment')
        assigned[origin] = int(hits[0]['qs_i'])
        require(((ser.base_ts + 3600 * origin) // 86400) % 28 == 0, 'original origin selection')
    require(sorted(quarters) == sorted(set(assigned.values())), 'exact quarter inventory')
    with np.load(npz_path, allow_pickle=False) as z:
        require(str(z['name']) == key and int(z['base_ts']) == ser.base_ts, 'NPZ identity')
        levels = z['levels'].astype(float)
        t0, th, ki = (z[n] for n in ('t0_i', 'T_h', 'k_i'))
        require(t0.ndim == th.ndim == ki.ndim == 1 and len(t0) == len(th) == len(ki), 'NPZ support arrays')
        stored_keys = [(int(i), int(t), int(k)) for i, t, k in zip(t0, th, ki)]
        require(len(stored_keys) == len(set(stored_keys)), 'unique NPZ support')
        require(set(k[1:] for k in keys).issubset(set(stored_keys)), 'historical support absent from NPZ')
    require(levels.ndim == 1 and len(levels) and np.isfinite(levels).all() and np.all((levels > -1) & (levels < 0)), 'barrier geometry')
    require(tuple(R.EVAL_T) == tuple(CONSTANTS['horizons']), 'original full horizon vector')
    log_levels = np.log1p(levels)
    rebuilt = {}
    for quarter in sorted(quarters):
        q = quarters[quarter]
        model = G.GJR(**q['model'])
        pool, variance, quarter_h = P.reconstruct_pool(ser.close, ser.low, quarter, model)
        require(variance == q['training_variance'] == q['filter_initial_variance'], 'training variance drift')
        require(quarter_h == q['quarter_h'] and P.pool_descriptor(pool) == q['pool'], 'quarter/pool drift')
        rebuilt[quarter] = (model, pool, quarter_h)
    predictions = {}
    for state in saved['origins']:
        origin, quarter = state['origin'], integer(state['quarter'])
        require(quarter == assigned[origin], 'origin assignment')
        model, pool, quarter_h = rebuilt[quarter]
        returns = np.full(origin - quarter, np.nan)
        c = np.asarray(ser.close, dtype=float)
        if origin > quarter:
            with np.errstate(divide='ignore', invalid='ignore'):
                now, before = c[quarter:origin], c[quarter - 1:origin - 1]
                returns[:] = np.where((now > 0) & (before > 0), np.log(now / before), np.nan)
        h0 = float(G.filter_variance(returns, model, quarter_h)[-1])
        require(type(state['h0']) in (int, float) and math.isfinite(state['h0']) and h0 == state['h0'], 'origin h0 drift')
        # Full horizons even when this origin has unavailable labels at some T.
        p = G.simulate_hourly(model, state['h0'], log_levels, R.EVAL_T,
            1000, [9, R.series_seed(key), origin], pool=pool)
        require(np.asarray(p).shape == (4, len(levels)), 'simulator output shape')
        require(np.isfinite(p).all() and np.all((p >= 0) & (p <= 1)), 'simulator finite probabilities')
        predictions[origin] = p
    output = []
    for r in rows:
        horizon, depth = r['T'], r['k']
        require(horizon in R.EVAL_T and 0 <= depth < len(levels), 'historical query geometry')
        oldp = probability(r['p_garch'])
        newp = float(predictions[r['i0']][R.EVAL_T.index(horizon), depth])
        require(newp == oldp, 'exact original prediction mismatch')
        output.append(dict(series=key, i0=r['i0'], T=horizon, k=depth, p_replay=newp))
    return dict(series=key, rows=output), dict(quarters=len(quarters), origins=len(origins), historical_rows=len(rows))


def write_json(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def run(plan_path, output_dir, plan_sha256, loader=None):
    out = Path(output_dir)
    require(not os.path.lexists(out), 'fresh exclusive output required')
    plan, state_plan, saved, old = authenticate(plan_path, plan_sha256)
    require(str(out) == plan['output_dir'], 'declared output path mismatch')
    out.mkdir(parents=False, exist_ok=False)
    # Immutable partial marker remains if any following operation fails.
    write_json(out / 'started.json', dict(schema=MANIFEST_SCHEMA, complete=False, plan_sha256=plan_sha256))
    started = record(out / 'started.json')
    started['path'] = 'started.json'
    import r164_step_review as G
    import r164_pool_moment_review as P
    import r164_recursive as R
    if loader is None:
        loader = R.M6.build_blind_dir
    series, folds, _ = loader(state_plan['datasets'], 'blind5-prices', PIN, 'blind5:', verify=True)
    require(len(series) == 42 and set(series) == set(folds) and {k.replace(':', '-') + '.json' for k in series} == set(saved), 'loaded series support')
    counts = dict(series=42, quarters=0, origins=0, historical_rows=0)
    records = []
    for key in sorted(series):
        name = key.replace(':', '-') + '.json'
        npz = Path(state_plan['datasets']) / 'history-forecasts/r16/r164-dev-63d4700f/rows' / (Path(name).stem + '.npz')
        result, totals = replay_series(key, series[key], folds[key], saved[name], old[name], npz, G, P, R)
        write_json(out / name, result)
        item = record(out / name)
        records.append(dict(series=key, path=name, sha256=item['sha256'], size=item['size']))
        for field in totals:
            counts[field] += totals[field]
        R.M6._clear(series[key])
        print(key + ': exact retained predictions replayed', flush=True)
    require(tuple(counts[k] for k in ('series', 'quarters', 'origins', 'historical_rows')) == (42, 806, 2619, 104310), 'complete support totals')
    # Reauthenticate all inputs and inventories after numerical work.
    authenticate(plan_path, plan_sha256)
    require({p.name for p in out.iterdir()} == {r['path'] for r in records} | {'started.json'}, 'output inventory drift')
    for item in records + [started]:
        require(record(out / item['path']) == dict(path=str(out / item['path']), sha256=item['sha256'], size=item['size']), 'output changed during replay')
    write_json(out / 'manifest.json', dict(schema=MANIFEST_SCHEMA, plan_sha256=plan_sha256,
        complete=True, **counts, series_files=records, started_file=started))
    return counts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.plan, args.output_dir, args.plan_sha256)))
