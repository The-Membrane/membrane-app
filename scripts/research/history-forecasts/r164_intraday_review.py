#!/usr/bin/env python3
"""Recovered intraday-RV feature probe, not a new research family.

All variants retain the 12-hour simulation step. h3 adds a 3-hour RV feature;
its name does not mean a 3-hour step. Prototype float64 pool normalization
followed by float32 storage deliberately differs from R.StepModel's float32
normalizer. rec/fix use common draws and identical paired 12-bar pools.
"""
from __future__ import annotations
import argparse
import csv
import gzip
import json
from pathlib import Path
import numpy as np
import r164_recursive as R
import r164_step_real_review as S

VARIANTS = {'base12': (24, 168, 720), 'h12': (12, 24, 168, 720),
            'h3': (3, 24, 168, 720), 'h1': (1, 24, 168, 720)}


class Inputs:
    def __init__(self, close, high, low, start_i, windows):
        self.N, self.start_i, self.windows = len(close), start_i, tuple(windows)
        if not self.windows or any(w <= 0 or w > R.HISTW for w in self.windows):
            raise ValueError('RV windows must be in 1..720')
        self.v = R.M6.parkinson_v(high, low)
        components = np.column_stack([R.ANNUAL * R.M6.window_mean_null_rule(self.v, w, start_i)
                                      for w in self.windows])
        components[components <= 0] = np.nan
        with np.errstate(divide='ignore', invalid='ignore'):
            self.LX = np.log(components)
            self.lsf = np.log(R.M6.sigma_fut(close, 12, start_i))
        self.okX = np.isfinite(self.LX).all(axis=1)
        self.blk = R.raw_blocks(close, high, low, 12)
        self.okb = np.isfinite(self.blk).all(axis=(1, 2))


class Model:
    def __init__(self, si, quarter):
        self.ok = False
        self.s = 12
        j = np.arange(si.N + 1)
        train = (j <= quarter - 12) & si.okX & np.isfinite(si.lsf)
        pool = (j <= quarter - 12) & si.okX & si.okb
        if train.sum() < 200 or pool.sum() < 200:
            return
        self.coef = np.linalg.lstsq(np.column_stack((np.ones(train.sum()), si.LX[train])),
                                    si.lsf[train], rcond=None)[0]
        scale = np.exp(np.column_stack((np.ones(pool.sum()), si.LX[pool])) @ self.coef) / R.SQA
        # Faithful fast.py prototype: float64 division, then float32 storage.
        self.U = np.ascontiguousarray(si.blk[pool] / scale[:, None, None], np.float32)
        self.n_pool = len(self.U)
        self.ok = np.isfinite(self.U).all()


def simulate(model, si, origin, levels, paths, seed, modes=('rec', 'fix'), horizons=R.EVAL_T):
    if paths <= 0 or not horizons or any(t <= 0 or t % 12 or t > R.HMAX for t in horizons):
        raise ValueError('positive paths and horizons divisible by 12 within 720 required')
    if any(mode not in ('rec', 'fix') for mode in modes):
        raise ValueError('only recovered rec/fix modes supported')
    if not 0 <= origin <= si.N:
        raise ValueError('origin outside observed input')
    if not model.ok or not si.okX[origin]:
        return None
    draws = np.random.default_rng(seed).random((R.HMAX // 12, paths))
    ch, cn = R.hist_buffers(si, origin)
    initial = model.coef[0] + si.LX[origin] @ model.coef[1:]
    result = {}
    for mode in modes:
        price = np.zeros(paths)
        minimum = np.full(paths, np.inf)
        cumulative = np.zeros((paths, R.HMAX + 1))
        output = np.zeros((len(horizons), len(levels)))
        lsig = np.full(paths, initial)
        for step in range(R.HMAX // 12):
            t = step * 12
            if step and mode == 'rec':
                features = []
                for w in si.windows:
                    a = t - w
                    if a >= 0:
                        total, count = cumulative[:, t] - cumulative[:, a], w
                    else:
                        total = cumulative[:, t] + ch[R.HISTW] - ch[R.HISTW + a]
                        count = t + cn[R.HISTW] - cn[R.HISTW + a]
                    features.append(np.log(np.maximum(R.ANNUAL * total / count, 1e-300)))
                lsig = model.coef[0] + sum(c * x for c, x in zip(model.coef[1:], features))
            indexes = np.minimum((draws[step] * model.n_pool).astype(np.int64), model.n_pool - 1)
            block = model.U[indexes].astype(float) * (np.exp(lsig) / R.SQA)[:, None, None]
            minimum = np.minimum(minimum, (price[:, None] + block[:, :, 2]).min(axis=1))
            variance = (block[:, :, 1] - block[:, :, 2]) ** 2 * R.PARK
            cumulative[:, t + 1:t + 13] = cumulative[:, t:t + 1] + np.cumsum(variance, axis=1)
            price += block[:, -1, 0]
            for ti, horizon in enumerate(horizons):
                if t + 12 == horizon:
                    output[ti] = (minimum[:, None] <= np.asarray(levels)[None, :]).mean(axis=0)
        result[mode] = output
    return result


def synthetic(baseline_rows, n_series=12, n_orig=60, paths=2000):
    opener = gzip.open if str(baseline_rows).endswith('.gz') else open
    with opener(baseline_rows, 'rt') as stream:
        source = list(csv.DictReader(stream))
    if min(n_series, n_orig, paths) <= 0:
        raise ValueError('positive budgets required')
    ids = sorted({int(r['series']) for r in source})[:n_series]
    support = {sid: sorted({int(r['i0']) for r in source if int(r['series']) == sid})[:n_orig] for sid in ids}
    rows, predictions = [], {}
    p, levels = R.syn_params(), np.log1p(np.asarray(R.A.LEVELS['ETH'], float))
    for sid in ids:
        close, high, low, _ = R.syn_series(52000, np.random.default_rng([R.SEED, 11, sid]), p)
        for name, windows in VARIANTS.items():
            si, models = Inputs(close, high, low, 0, windows), {}
            for origin in support[sid]:
                from r164_step_review import quarter_start_index
                quarter = quarter_start_index(R.A.quarter_start(2018, 1), origin)
                if quarter not in models:
                    models[quarter] = Model(si, quarter)
                predictions[(sid, origin, name)] = simulate(models[quarter], si, origin, levels, paths,
                                                             [R.SEED, 14, sid, origin, 12])
    for raw in source:
        sid, origin = int(raw['series']), int(raw['i0'])
        if sid not in support or origin not in support[sid]:
            continue
        row = {k: int(v) if k in ('series', 'i0', 'T', 'k') else float(v) for k, v in raw.items()}
        for name in VARIANTS:
            prediction = predictions[(sid, origin, name)]
            for mode in ('rec', 'fix'):
                row[f'p_{name}_{mode}'] = float(prediction[mode][R.EVAL_T.index(row['T']), row['k']]) if prediction else None
        rows.append(row)
    metrics = []
    names = [f'{name}_{mode}' for name in VARIANTS for mode in ('rec', 'fix')] + ['fH', 'rec12']
    for horizon in R.EVAL_T:
        for band, ks in (('all', range(10)), ('mid', range(4, 7)), ('deep', range(7, 10))):
            common = [r for r in rows if r['T'] == horizon and r['k'] in ks and all(r.get('p_' + n) is not None for n in names)]
            if not common:
                continue
            truth = np.array([r['p_true'] for r in common])
            metrics.append(dict(horizon=horizon, band=band, n_rows=len(common), models={
                name: dict(R=float(sum(r['p_' + name] for r in common) / truth.sum()) if truth.sum() else None,
                           MAE=float(np.mean(np.abs(np.array([r['p_' + name] for r in common]) - truth)))) for name in names}))
    return dict(scope='published synthetic origins and frozen published20k MC truth',
                support=support, paths=paths, variants=VARIANTS, rows=rows, metrics=metrics,
                baseline_sha256=S.file_sha(baseline_rows), source_sha256=S.file_sha(__file__),
                runtime=S.runtime_identity(), selected_origins=sum(map(len, support.values())),
                caveat='Dependent origins; MC truth and forecast noise; prototype float64 normalization retained, no outcome tuning.')


def real(datasets, prior_dir, out_dir, only_series=None):
    prior_dir, out_dir = Path(prior_dir), Path(out_dir)
    with (prior_dir / 'manifest.json').open() as stream:
        prior = json.load(stream)
    if prior.get('complete') is not True:
        raise ValueError('completed GJR review required')
    old_config = prior.get('config', {})
    if old_config.get('pin') != R.BLIND5_COMMIT or old_config.get('paths') != 1000 or old_config.get('origin_every') != 28:
        raise ValueError('prior review must use original pinned42 fixed plan')
    for name, digest in old_config.get('sources', {}).items():
        if Path(name).name != name or S.file_sha(Path(__file__).parent / name) != digest:
            raise ValueError('prior source identity changed: ' + name)
    if old_config.get('runtime') != S.runtime_identity():
        raise ValueError('prior numerical runtime identity changed')
    series, folds, _ = R.M6.build_blind_dir(datasets, R.M6.BLIND5_DIR, R.BLIND5_COMMIT, 'blind5:', verify=True)
    if len(series) != 42:
        raise ValueError('expected exact pinned42')
    keys = sorted(k for k in series if not only_series or k.startswith(only_series))
    if not keys:
        raise ValueError('no alphabetical prefix match')
    prior_inputs = {k: S.file_sha(prior_dir / (k.replace(':', '-') + '.json')) for k in keys}
    config = dict(pin=R.BLIND5_COMMIT, paths=1000, origin_every=28, windows=VARIANTS['h3'],
                  prior_signature=prior['signature'], prior_inputs=prior_inputs, selected_series=keys,
                  sources={p: S.file_sha(Path(__file__).parent / p) for p in (*S.SOURCE_FILES, 'r164_intraday_review.py')},
                  runtime=S.runtime_identity())
    digest = S.signature(config)
    manifest = out_dir / 'manifest.json'
    if manifest.exists():
        with manifest.open() as stream:
            if json.load(stream).get('signature') != digest:
                raise ValueError('stale intraday run source/input/config mismatch')
    S.atomic_json(manifest, dict(signature=digest, config=config, complete=False))
    all_rows, censored = [], []
    for index, key in enumerate(keys):
        target = out_dir / (key.replace(':', '-') + '.json')
        checkpoint = S.read_checkpoint(target, digest)
        if checkpoint is None:
            old = S.read_checkpoint(prior_dir / target.name, prior['signature'])['result']
            ser = series[key]
            si, models = Inputs(ser.close, ser.high, ser.low, ser.start_i, VARIANTS['h3']), {}
            predictions, missing_reasons = {}, {}
            for origin in sorted({r['i0'] for r in old['rows']}):
                fold = next((f for f in folds[key] if f['qs_i'] <= origin < f['qe_i']), None)
                if fold is None:
                    predictions[origin] = None
                    missing_reasons[origin] = 'no_fold'
                    continue
                quarter = fold['qs_i']
                if quarter not in models:
                    models[quarter] = Model(si, quarter)
                predictions[origin] = simulate(models[quarter], si, origin, np.log1p(ser.levels), 1000,
                                               [R.SEED, R.series_seed(key), origin, 12], modes=('rec',))
                if predictions[origin] is None:
                    missing_reasons[origin] = 'insufficient_training_or_pool' if not models[quarter].ok else 'missing_origin_features'
            joined = []
            for row in old['rows']:
                prediction = predictions[row['i0']]
                joined.append(dict(row, p_h3=float(prediction['rec'][R.EVAL_T.index(row['T']), row['k']]) if prediction else None,
                                   h3_unavailable_reason=missing_reasons.get(row['i0'])))
            checkpoint = dict(signature=digest, complete=True, result=dict(rows=joined,
                              inherited_censored_origins=old['censored_origins']))
            S.atomic_json(target, checkpoint)
        all_rows.extend(checkpoint['result']['rows'])
        censored.extend(checkpoint['result']['inherited_censored_origins'])
        R.M6._clear(series[key])
        print(f'{index+1}/{len(keys)} {key}', flush=True)
    # Both summaries use exactly the same complete support for all five models.
    common = [r for r in all_rows if r.get('p_h3') is not None and np.isfinite(r['p_h3'])
              and 0 <= r['p_h3'] <= 1 and S.common_pairs([r])[0]]
    h3 = S.summarize([dict(r, p_garch=r['p_h3']) for r in common])
    for cell in h3['summaries']:
        cell['models']['h3'] = cell['models'].pop('garch')
        cell['paired_vs_fH']['h3'] = cell['paired_vs_fH'].pop('garch')
    report = dict(signature=digest, config=config, rows=all_rows, prediction_rows=len(all_rows),
                  paired_rows=len(common), excluded_rows=len(all_rows)-len(common),
                  inherited_censored_origins=censored, h3=h3, garch=S.summarize(common),
                  caveat='Recovered h3 feature bundle at12h step; not exclusive attribution to volatility. No GJR rerun.')
    S.atomic_json(out_dir / 'report.json', report)
    S.atomic_json(manifest, dict(signature=digest, config=config, complete=True))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('synthetic', 'real'), default='synthetic')
    parser.add_argument('--baseline-rows')
    parser.add_argument('--datasets')
    parser.add_argument('--prior-dir')
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--only-series')
    parser.add_argument('--n-series', type=int, default=12)
    parser.add_argument('--n-orig', type=int, default=60)
    parser.add_argument('--paths', type=int, default=2000, help='Synthetic budget; real is fixed at1000')
    args = parser.parse_args()
    if args.phase == 'synthetic':
        if not args.baseline_rows:
            parser.error('synthetic requires --baseline-rows')
        result = synthetic(args.baseline_rows, args.n_series, args.n_orig, args.paths)
        S.atomic_json(Path(args.out_dir) / 'synthetic.json', result)
    else:
        if not args.datasets or not args.prior_dir:
            parser.error('real requires --datasets and --prior-dir')
        real(args.datasets, args.prior_dir, args.out_dir, args.only_series)


if __name__ == '__main__':
    main()
