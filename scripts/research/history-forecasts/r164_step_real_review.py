#!/usr/bin/env python3
"""Report-only reconstruction on the exact 42 already-seen blind5 series.

Pinned f9389b6 build is mandatory. Origin support comes from published R16.4
rows, on UTC day modulo 28. No unseen/reserved collections are loaded. This
changes a step-model bundle, not exclusively volatility or HAR causality.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import os
import platform
import sys
import importlib.metadata
from pathlib import Path
import tempfile
import numpy as np
import r164_recursive as R
import r164_step_review as G

HERE = Path(__file__).resolve().parent
SOURCE_FILES = ('r164_step_real_review.py', 'r164_step_review.py', 'r164_recursive.py',
                'a_touch.py', 'a2_touch.py', 'a3_touch.py', 'a4_touch.py', 'a6_touch.py', 'a5_touch.py')
MODELS = ('garch', 'fH', 'rec12', 'base12')


def runtime_identity():
    return dict(python=sys.version, executable=sys.executable, machine=platform.machine(),
                platform=platform.platform(),
                dependencies={name: importlib.metadata.version(name)
                              for name in ('numpy', 'scipy', 'numba', 'llvmlite')})


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def signature(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_checkpoint(path, expected_signature):
    if not Path(path).exists():
        return None
    with open(path) as stream:
        result = json.load(stream)
    if result.get('signature') != expected_signature or result.get('complete') is not True:
        raise ValueError('stale/incomplete checkpoint; source/input/config hash mismatch')
    return result


def common_pairs(rows):
    """Never silently treat missing predictions as zero or change paired support."""
    selected, reasons = [], Counter()
    for row in rows:
        y = row.get('y')
        if y not in (0., 1.):
            reasons['invalid_outcome'] += 1
            continue
        missing = [name for name in MODELS if row.get('p_' + name) is None]
        if missing:
            reasons['missing_' + '+'.join(missing)] += 1
            continue
        predictions = [row['p_' + name] for name in MODELS]
        if not all(np.isfinite(p) and 0 <= p <= 1 for p in predictions):
            reasons['invalid_prediction'] += 1
            continue
        selected.append(row)
    return selected, dict(reasons)


def summarize(rows, bootstrap=2000, seed=0):
    """Paired series-cluster × calendar-block pigeonhole bootstrap, aggregated once."""
    paired, censored = common_pairs(rows)
    summaries = []
    for horizon in R.EVAL_T:
        for band, depths in (('all', range(10)), ('mid', range(4, 7)), ('deep', range(7, 10))):
            data = [r for r in paired if r['T'] == horizon and r['k'] in depths]
            if not data:
                continue
            y = np.array([r['y'] for r in data])
            prob = np.array([[r['p_' + m] for m in MODELS] for r in data])
            loss = (prob - y[:, None]) ** 2
            base = float(loss[:, 1].mean())
            clusters = sorted({r['cluster'] for r in data})
            blocks = sorted({r['block182'] for r in data})
            ci = {c: i for i, c in enumerate(clusters)}
            bi = {b: i for i, b in enumerate(blocks)}
            counts = np.zeros((len(clusters), len(blocks)))
            differences = np.zeros((len(MODELS), len(clusters), len(blocks)))
            # One aggregation per cluster/block; bootstrap never scans raw rows.
            for row, delta in zip(data, loss - loss[:, 1, None]):
                ix = ci[row['cluster']], bi[row['block182']]
                counts[ix] += 1
                differences[:, ix[0], ix[1]] += delta
            rng = np.random.default_rng(seed)
            boot = []
            for _ in range(bootstrap):
                cw = rng.multinomial(len(clusters), np.full(len(clusters), 1 / len(clusters)))
                bw = rng.multinomial(len(blocks), np.full(len(blocks), 1 / len(blocks)))
                denom = float(cw @ counts @ bw)
                if denom:
                    boot.append(np.array([cw @ matrix @ bw / denom for matrix in differences]))
            deltas = (loss - loss[:, 1, None]).mean(axis=0)
            boot = np.asarray(boot)
            summaries.append(dict(horizon=horizon, primary=horizon in (72, 168), band=band,
                n_rows=len(data), n_origins=len({(r['series'], r['i0']) for r in data}),
                n_series=len({r['series'] for r in data}), n_clusters=len(clusters), n_blocks=len(blocks),
                base_rate=float(y.mean()), bss_denominator_stored_fH=base,
                models={m: dict(Brier=float(loss[:, j].mean()),
                                BSS_vs_fH=float(1 - loss[:, j].mean() / base) if base else None,
                                R=float(prob[:, j].sum() / y.sum()) if y.sum() else None)
                        for j, m in enumerate(MODELS)},
                paired_vs_fH={m: dict(delta=float(deltas[j]),
                    delta_ci90=[float(x) for x in np.quantile(boot[:, j], [.05, .95])] if len(boot) else None,
                    bootstrap_sd=float(np.std(boot[:, j], ddof=1)) if len(boot) > 1 else None,
                    z=float(deltas[j] / np.std(boot[:, j], ddof=1)) if len(boot) > 1 and np.std(boot[:, j], ddof=1) > 0 else None)
                    for j, m in enumerate(MODELS)},
                bootstrap_successful=len(boot), bootstrap_requested=bootstrap))
    return dict(paired_rows=len(paired), censored_pairs=len(rows) - len(paired),
                censor_reasons=censored, summaries=summaries)


def series_review(key, ser, folds, input_path, paths=1000, origin_every=28):
    with np.load(input_path, allow_pickle=False) as z:
        if str(z['name']) != key or int(z['base_ts']) != ser.base_ts:
            raise ValueError('stored row identity does not match pinned input')
        stored = {k: z[k] for k in ('t0_i', 'T_h', 'k_i', 'y', 'p_fH', 'p_rec12')}
        levels = z['levels'].astype(float)
    origins = sorted(int(o) for o in np.unique(stored['t0_i'])
                     if ((ser.base_ts + 3600 * int(o)) // 86400) % origin_every == 0)
    si = R.SeriesInputs(ser.close, ser.high, ser.low, ser.start_i, steps=(12,))
    lnk = np.log1p(levels)
    sid = R.series_seed(key)
    har_cache, gjr_cache = {}, {}
    outputs, reasons = [], Counter()
    maxdiff = 0.
    baseline_pairs_compared = 0
    baseline_pairs_beyond_float16 = 0
    censored_origins = []
    for origin in origins:
        fold = next((f for f in folds if f['qs_i'] <= origin < f['qe_i']), None)
        if fold is None:
            reasons['origin_no_fold'] += 1
            censored_origins.append(dict(i0=origin, reason='no_fold', stored_rows=int(np.sum(stored['t0_i'] == origin))))
            continue
        quarter = int(fold['qs_i'])
        if quarter not in har_cache:
            har_cache[quarter] = R.StepModel(si, 12, quarter)
        baseline = R.simulate_fast(har_cache[quarter], si, origin, lnk, paths,
                                   [R.SEED, sid, origin, 12], modes=('rec',))
        indexes = np.flatnonzero(stored['t0_i'] == origin)
        if baseline is None:
            reasons['origin_no_HAR_prediction'] += 1
            censored_origins.append(dict(i0=origin, reason='no_HAR_prediction', stored_rows=len(indexes)))
            continue
        # Reconcile every available stored rec12 pair before computing new model.
        for ix in indexes:
            horizon, depth = int(stored['T_h'][ix]), int(stored['k_i'][ix])
            if horizon not in R.EVAL_T:
                continue
            old = float(stored['p_rec12'][ix])
            new = float(baseline['rec'][R.EVAL_T.index(horizon), depth])
            if np.isfinite(old):
                if not np.isfinite(new):
                    raise ValueError(f'baseline instrument mismatch {key}: finite stored, nonfinite rebuilt')
                difference = abs(old - new)
                baseline_pairs_compared += 1
                baseline_pairs_beyond_float16 += int(difference > .00025)
                maxdiff = max(maxdiff, difference)
        if maxdiff > .001:
            raise ValueError(f'baseline instrument mismatch {key}: maxdiff={maxdiff:.8f} > .001')
        error = None
        try:
            fitted, h0, pool, diagnostics = G.asof_state(ser.close, ser.low, origin, quarter, cache=gjr_cache)
            predictions = G.simulate_hourly(fitted, h0, lnk, R.EVAL_T, paths, [9, sid, origin], pool=pool)
        except ValueError as exc:
            predictions = None
            error = str(exc)
            reasons['origin_GJR_unavailable:' + error] += 1
        for ix in indexes:
            horizon, depth = int(stored['T_h'][ix]), int(stored['k_i'][ix])
            if horizon not in R.EVAL_T:
                continue
            ti = R.EVAL_T.index(horizon)
            timestamp = ser.base_ts + 3600 * origin
            ticker = key.rsplit('-', 1)[-1].upper()
            cluster = ticker[:-4] if ticker in ('ETHUSDT', 'BTCUSDT') else key
            def probability(value):
                return float(value) if np.isfinite(value) else None
            outputs.append(dict(series=key, cluster=cluster, i0=origin, T=horizon, k=depth,
                block182=int((timestamp // 86400 - 17532) // 182), y=probability(stored['y'][ix]),
                p_fH=probability(stored['p_fH'][ix]), p_rec12=probability(stored['p_rec12'][ix]),
                p_base12=probability(baseline['rec'][ti, depth]),
                p_garch=probability(predictions[ti, depth]) if predictions is not None else None,
                unavailable_reason=error))
    return dict(series=key, selected_origins=origins, n_selected_origins=len(origins),
                rows=outputs, origin_reasons=dict(reasons), censored_origins=censored_origins, baseline_maxdiff=maxdiff,
                float16_expected_maxdiff=.00025, baseline_failure_gate=.001,
                baseline_pairs_compared=baseline_pairs_compared,
                baseline_pairs_beyond_float16=baseline_pairs_beyond_float16,
                baseline_warning='Differences beyond .00025 need reconciliation; .001 is an instrument-stop threshold, not a parity tolerance.'
                    if baseline_pairs_beyond_float16 else None, quarter_fits=len(gjr_cache))


def run(datasets, out_dir, only_series=None, paths=1000, origin_every=28, workers=1, bootstrap=2000):
    if paths != 1000 or origin_every != 28 or workers != 1 or bootstrap <= 0:
        raise ValueError('original fixed plan requires paths=1000, origin_every=28, workers=1; bootstrap positive')
    datasets, out_dir = Path(datasets).resolve(), Path(out_dir).resolve()
    stored_dir = datasets / 'history-forecasts/r16/r164-dev-63d4700f/rows'
    # Only this pinned, already-seen collection; never call build_all/build_series.
    series, folds, metadata = R.M6.build_blind_dir(str(datasets), R.M6.BLIND5_DIR,
                                                  R.BLIND5_COMMIT, 'blind5:', verify=True)
    if len(series) != 42:
        raise ValueError('expected exact verified 42-series blind5 universe')
    selected = sorted(series)
    if only_series:
        selected = [k for k in selected if k.startswith(only_series)]
    if not selected:
        raise ValueError('alphabetical series prefix selected no instruments')
    sources = {name: file_sha(HERE / name) for name in SOURCE_FILES}
    checksums_path = stored_dir.parent / 'SHA256SUMS'
    expected = {}
    with checksums_path.open() as stream:
        for line in stream:
            digest, relative = line.strip().split(maxsplit=1)
            expected[relative.lstrip('*').removeprefix('./')] = digest
    input_hashes = {}
    for key in sorted(series):
        name = key.replace(':', '-') + '.npz'
        actual = file_sha(stored_dir / name)
        if expected.get('rows/' + name) != actual:
            raise ValueError('published row SHA256 mismatch: ' + name)
        input_hashes[key] = actual
    config = dict(pin=R.BLIND5_COMMIT, collection=R.M6.BLIND5_DIR, paths=paths,
                  origin_every=origin_every, workers=workers, bootstrap=bootstrap,
                  sources=sources, runtime=runtime_identity(), inputs=input_hashes, selected_series=selected,
                  verification='M6.build_blind_dir verify=True plus all42 stored row SHA256 digests')
    run_signature = signature(config)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / 'manifest.json'
    if manifest.exists():
        with manifest.open() as stream:
            previous = json.load(stream)
        if previous.get('signature') != run_signature:
            raise ValueError('run manifest source/input/config mismatch; choose new output directory')
    atomic_json(manifest, dict(signature=run_signature, config=config, complete=False))
    all_rows, reports = [], []
    for index, key in enumerate(selected):
        target = out_dir / (key.replace(':', '-') + '.json')
        checkpoint = read_checkpoint(target, run_signature)
        if checkpoint is None:
            result = series_review(key, series[key], folds[key],
                                   stored_dir / (key.replace(':', '-') + '.npz'), paths, origin_every)
            checkpoint = dict(signature=run_signature, complete=True, result=result)
            atomic_json(target, checkpoint)
        result = checkpoint['result']
        all_rows.extend(result['rows'])
        reports.append({k: v for k, v in result.items() if k != 'rows'})
        R.M6._clear(series[key])
        print(f'{index + 1}/{len(selected)} {key}: {len(result["rows"])} rows baseline maxdiff={result["baseline_maxdiff"]:.7f}', flush=True)
    report = summarize(all_rows, bootstrap=bootstrap)
    report['censored_origin_rows'] = sum(item['stored_rows'] for r in reports for item in r['censored_origins'])
    report['total_censored_pairs_including_origins'] = report['censored_pairs'] + report['censored_origin_rows']
    report.update(signature=run_signature, config=config, series=reports,
                  verified_universe_series=42, selected_series=len(selected), prediction_rows=len(all_rows),
                  selected_origins=sum(r['n_selected_origins'] for r in reports),
                  scope='Already-seen pinned42 report only; GJR step bundle does not isolate an exclusive causal mechanism.')
    atomic_json(out_dir / 'report.json', report)
    atomic_json(manifest, dict(signature=run_signature, config=config, complete=True))
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--datasets', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--only-series', help='Fixed alphabetical instrument-name prefix, never outcome selected')
    ap.add_argument('--workers', type=int, default=1, choices=(1,))
    ap.add_argument('--paths', type=int, default=1000)
    ap.add_argument('--origin-every', type=int, default=28)
    ap.add_argument('--bootstrap', type=int, default=2000)
    args = ap.parse_args()
    run(args.datasets, args.out_dir, args.only_series, args.paths, args.origin_every, args.workers, args.bootstrap)


if __name__ == '__main__':
    main()
