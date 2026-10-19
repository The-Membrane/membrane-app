#!/usr/bin/env python3
"""Recovered R16.4 reviewer hourly GJR step: synthetic instrument review only.

No real/reserved observations are read. QMLE fits and paired residual pools end
strictly before the origin's calendar quarter; variance filters end at origin-1.
This reconstruction is not the unpublished Claude scratch source. Synthetic
oracle/fitted/fixed-scale engines all use simulate_hourly below. Real-development
support must be identified separately before any comparison can be authorized.
"""
from __future__ import annotations

import argparse
import csv
import gzip
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math

import numpy as np
from numba import njit
from scipy.optimize import minimize
import r164_recursive as R


@dataclass(frozen=True)
class GJR:
    w: float
    alpha: float
    gamma: float
    beta: float

    def __post_init__(self):
        values = (self.w, self.alpha, self.gamma, self.beta)
        if not all(np.isfinite(values)) or min(values) < 0 or self.w <= 0:
            raise ValueError('GJR parameters must be finite and nonnegative, w positive')
        if self.persistence >= .9995:
            raise ValueError('GJR persistence must be below .9995')

    @property
    def persistence(self):
        return self.alpha + .5 * self.gamma + self.beta


def update(h, residual, model):
    """Missing returns get the expected variance update (symmetric innovation)."""
    residual = np.asarray(residual)
    return model.w + np.where(np.isfinite(residual),
        (model.alpha + model.gamma * (residual < 0)) * residual ** 2 + model.beta * h,
        model.persistence * h)


@njit(cache=True)
def _filter(returns, w, a, g, b, initial):
    h = np.empty(len(returns) + 1)
    h[0] = initial
    for t in range(len(returns)):
        r = returns[t]
        h[t + 1] = w + ((a + g * (r < 0)) * r * r + b * h[t] if np.isfinite(r)
                        else (a + .5 * g + b) * h[t])
    return h


def filter_variance(returns, model, initial):
    if not np.isfinite(initial) or initial <= 0:
        raise ValueError('initial variance must be positive and finite')
    return _filter(np.asarray(returns, dtype=float), model.w, model.alpha,
                   model.gamma, model.beta, initial)


@njit(cache=True)
def _loss(theta, returns, variance):
    a, g, b = theta
    persistence = a + .5 * g + b
    if a < 0 or g < 0 or b < 0 or persistence >= .9995:
        return 1e100
    w = variance * (1 - persistence)
    h = variance
    value = 0.
    for r in returns:
        if np.isfinite(r):
            value += math.log(h) + r * r / h
            h = w + (a + g * (r < 0)) * r * r + b * h
        else:
            h = w + persistence * h
    return .5 * value


def fit_gjr(returns):
    returns = np.asarray(returns, dtype=float)
    finite = returns[np.isfinite(returns)]
    if len(finite) < 2000:
        raise ValueError('QMLE requires at least 2000 finite hourly returns')
    variance = float(np.var(finite))
    if not np.isfinite(variance) or variance <= 0:
        raise ValueError('training variance must be positive')
    fits = [minimize(_loss, start, args=(returns, variance), method='Nelder-Mead',
                     options={'maxiter': 800, 'xatol': 1e-5, 'fatol': 1e-3})
            for start in ((.05, .03, .9), (.1, .05, .8), (.03, .02, .94))]
    valid = [f for f in fits if np.isfinite(f.fun) and f.fun < 1e99]
    if not valid:
        raise ValueError('no admissible QMLE fit')
    best = min(valid, key=lambda f: f.fun)
    a, g, b = best.x
    return GJR(variance * (1 - a - .5 * g - b), a, g, b), variance, {
        'optimizer_success': bool(best.success), 'objective': float(best.fun),
        'finite_training_returns': int(len(finite))}


def quarter_start_index(base_ts, origin):
    dt = datetime.fromtimestamp(base_ts + origin * 3600, timezone.utc)
    start = datetime(dt.year, 1 + 3 * ((dt.month - 1) // 3), 1, tzinfo=timezone.utc)
    return max(0, int((start.timestamp() - base_ts) // 3600))


def asof_state(close, low, origin, quarter, cache=None):
    """Return fitted parameters, h_origin, and prequarter paired residual pool."""
    if not 1 <= quarter <= origin <= len(close) or len(close) != len(low):
        raise ValueError('require aligned bars and 1 <= quarter <= origin <= n')
    # Filter the observed prefix from its beginning, as recovered garch.py did;
    # never inspect a future suffix even though a causal full filter would agree.
    start = max(1, quarter - 26280)
    c = np.asarray(close[:origin], dtype=float)
    l = np.asarray(low[:origin], dtype=float)
    returns = np.full(origin, np.nan)
    lows = np.full(origin, np.nan)
    with np.errstate(divide='ignore', invalid='ignore'):
        returns[1:] = np.where((c[1:] > 0) & (c[:-1] > 0), np.log(c[1:] / c[:-1]), np.nan)
        lows[1:] = np.where((l[1:] > 0) & (c[:-1] > 0), np.log(l[1:] / c[:-1]), np.nan)
    if cache is not None and quarter in cache:
        model, paired, diagnostics, h_quarter = cache[quarter]
        state = filter_variance(returns[quarter:origin], model, h_quarter)[-1]
        return model, float(state), paired, dict(diagnostics, state_end_exclusive=int(origin))
    model, variance, diagnostics = fit_gjr(returns[start:quarter])
    h = filter_variance(returns, model, variance)
    paired = np.column_stack((returns[start:quarter], lows[start:quarter])) / np.sqrt(h[start:quarter, None])
    # Preserve recovered source validity check before constraining wick geometry.
    valid = np.isfinite(paired).all(axis=1) & (paired[:, 1] <= np.maximum(paired[:, 0], 0) + 1e-12)
    paired = paired[valid]
    if len(paired) <= 1000:
        raise ValueError('residual pool requires more than 1000 finite pairs')
    paired[:, 1] = np.minimum(paired[:, 1], np.minimum(paired[:, 0], 0))
    diagnostics.update(pool_pairs=int(len(paired)), training_end_exclusive=int(quarter),
                       state_end_exclusive=int(origin))
    if cache is not None:
        cache[quarter] = (model, paired, dict(diagnostics), float(h[quarter]))
    return model, float(h[-1]), paired, diagnostics


def true_residual_pool(close, low, true_h, quarter):
    """Original paired prequarter bars standardized by known latent variance."""
    start = max(1, quarter - 26280)
    c = np.asarray(close[:quarter], dtype=float)
    l = np.asarray(low[:quarter], dtype=float)
    h = np.asarray(true_h[:quarter], dtype=float)
    with np.errstate(divide='ignore', invalid='ignore'):
        pairs = np.column_stack((np.log(c[start:] / c[start - 1:-1]),
                                 np.log(l[start:] / c[start - 1:-1]))) / np.sqrt(h[start:, None])
    valid = np.isfinite(pairs).all(axis=1) & (pairs[:, 1] <= np.maximum(pairs[:, 0], 0) + 1e-12)
    pairs = pairs[valid]
    if len(pairs) <= 1000:
        raise ValueError('known-variance pool requires more than 1000 pairs')
    pairs[:, 1] = np.minimum(pairs[:, 1], np.minimum(pairs[:, 0], 0))
    return pairs


def simulate_hourly(model, h0, levels, horizons, n_paths, seed, pool=None,
                    exact_innovations=None, fixed_scale=False):
    """Shared fitted/oracle loop; exact innovations use the known GJR-t law.

    levels are negative log-price barriers; returned values are touch frequencies.
    Empirical close/low residuals are always sampled as pairs, never independently.
    """
    levels = np.asarray(levels, dtype=float)
    horizons = tuple(horizons)
    if not n_paths > 0 or int(n_paths) != n_paths or not horizons or any(
            int(t) != t or t <= 0 for t in horizons):
        raise ValueError('positive integer paths and horizons required')
    if not np.isfinite(h0) or h0 <= 0 or levels.ndim != 1 or not len(levels) or not np.isfinite(levels).all() or np.any(levels >= 0):
        raise ValueError('positive finite h0 and finite negative log barriers required')
    if (pool is None) == (exact_innovations is None):
        raise ValueError('choose exactly one empirical pool or exact innovation law')
    if pool is not None:
        pool = np.asarray(pool, dtype=float)
        if pool.ndim != 2 or pool.shape[1] != 2 or not len(pool) or not np.isfinite(pool).all():
            raise ValueError('pool must contain finite close/low pairs')
        if np.any(pool[:, 1] > np.minimum(pool[:, 0], 0)):
            raise ValueError('pool lows must be at or below both endpoints')
    elif not np.isfinite(exact_innovations['nu']) or exact_innovations['nu'] <= 2:
        raise ValueError('exact t innovation degrees of freedom must exceed two')
    n_paths = int(n_paths)
    rng = np.random.default_rng(seed)
    h = np.full(n_paths, h0)
    price = np.zeros(n_paths)
    minimum = np.full(n_paths, np.inf)
    out = np.zeros((len(horizons), len(levels)))
    for t in range(1, max(horizons) + 1):
        sig = np.sqrt(h)
        if pool is None:
            p = exact_innovations
            residual = sig * rng.standard_t(p['nu'], n_paths) * math.sqrt((p['nu'] - 2) / p['nu'])
            low = R.bb_min(residual, sig, rng.random(n_paths))
        else:
            pairs = pool[rng.integers(0, len(pool), n_paths)]
            residual, low = sig * pairs[:, 0], sig * pairs[:, 1]
        minimum = np.minimum(minimum, price + low)
        price += residual
        if not fixed_scale:
            h = update(h, residual, model)
        for ti, horizon in enumerate(horizons):
            if t == horizon:
                out[ti] = (minimum[:, None] <= levels[None, :]).mean(axis=0)
    return out


def run_synthetic(baseline_rows, n_hours=52000, n_orig=4, n_paths=500, n_true=0, n_series=1, published_truth_paths=20000):
    """Use deterministic subsets of published synthetic origins, never new support.

    Published fH/HARrec12 and primary p_true stay untouched. A separate truth
    recheck uses the explicit n_true MC budget and never changes primary scores. Exact GJR oracle agreement
    validates this engine, not the distinct production HAR simulation kernel.
    """
    opener = gzip.open if str(baseline_rows).endswith('.gz') else open
    with opener(baseline_rows, 'rt') as stream:
        source = list(csv.DictReader(stream))
    if n_orig <= 0 or n_series <= 0 or n_true < 0 or n_paths <= 0 or published_truth_paths <= 0:
        raise ValueError('positive origins, series, forecast/published paths; nonnegative recheck paths required')
    series_ids = sorted({int(r['series']) for r in source})[:n_series]
    support = {sid: sorted({int(r['i0']) for r in source if int(r['series']) == sid})[:n_orig]
               for sid in series_ids}
    rows = []
    for raw in source:
        sid, origin = int(raw['series']), int(raw['i0'])
        if sid in support and origin in support[sid]:
            rows.append({k: int(v) if k in ('series', 'i0', 'T', 'k') else float(v)
                         for k, v in raw.items()})
    if not rows:
        raise ValueError('baseline has no synthetic rows')
    p = R.syn_params()
    model = GJR(p['w'], p['alpha'], p['gamma'], p['beta'])
    levels = np.log1p(np.asarray(R.A.LEVELS['ETH'], dtype=float))
    predictions = {}
    quarter_fit_counts = {}
    for sid in series_ids:
        close, high, low, hh = R.syn_series(n_hours, np.random.default_rng([R.SEED, 11, sid]), p)
        fit_cache, oracle_pool_cache = {}, {}
        for origin in support[sid]:
            if origin >= n_hours:
                raise ValueError('synthetic generation must reach every published origin')
            quarter = quarter_start_index(R.A.quarter_start(2018, 1), origin)
            fitted, h0, pool, diag = asof_state(close, low, origin, quarter, cache=fit_cache)
            if quarter not in oracle_pool_cache:
                oracle_pool_cache[quarter] = true_residual_pool(close, low, hh, quarter)
            kwargs = dict(levels=levels, horizons=R.EVAL_T, n_paths=n_paths, seed=[7, sid, origin])
            truth = (R.syn_true(hh[origin], levels, n_true,
                               np.random.default_rng([R.SEED, 13, sid, origin]), p) if n_true else None)
            predictions[(sid, origin)] = (dict(
                fitted=simulate_hourly(fitted, h0, pool=pool, **kwargs),
                fixed_scale=simulate_hourly(fitted, h0, pool=pool, fixed_scale=True, **kwargs),
                known_empirical=simulate_hourly(model, hh[origin], pool=oracle_pool_cache[quarter], **kwargs),
                exact=simulate_hourly(model, hh[origin], exact_innovations=p, **kwargs)), diag, truth)
        quarter_fit_counts[sid] = len(fit_cache)
    for row in rows:
        preds, diag, truth_array = predictions[(row['series'], row['i0'])]
        ti, ki = R.EVAL_T.index(row['T']), row['k']
        for name, values in preds.items():
            estimate = float(values[ti, ki])
            row['p_' + name] = estimate
            row['mc_se_' + name] = math.sqrt(estimate * (1 - estimate) / n_paths)
            row['zero_hit_upper95_' + name] = float(1 - .05 ** (1 / n_paths)) if estimate == 0 else None
        row['published_p_true'] = row['p_true']
        row['p_true_recheck'] = float(truth_array[ti, ki]) if truth_array is not None else None
        row['truth_recheck_difference'] = row['p_true_recheck'] - row['p_true'] if n_true else None
        truth = row['p_true']
        row['truth_mc_se'] = math.sqrt(truth * (1 - truth) / published_truth_paths)
        row['truth_expected_hits'] = truth * published_truth_paths
        row['truth_zero_hit_upper95'] = float(1 - .05 ** (1 / published_truth_paths)) if truth == 0 else None
        row['truth_recheck_mc_se'] = math.sqrt(row['p_true_recheck'] * (1 - row['p_true_recheck']) / n_true) if n_true else None
        row['diagnostics'] = diag
    summaries = []
    for horizon in R.EVAL_T:
        for depth in sorted({row['k'] for row in rows}):
            selected = [row for row in rows if row['T'] == horizon and row['k'] == depth]
            if not selected:
                continue
            summaries.append(dict(horizon=horizon, depth_index=depth, n_origins=len(selected),
                mse_to_mc_truth={name: float(np.mean([(r['p_' + name] - r['p_true']) ** 2 for r in selected]))
                    for name in ('fitted', 'fixed_scale', 'known_empirical', 'exact', 'rec12', 'fH')}))
    band_summaries = []
    for horizon in R.EVAL_T:
        for band, ks in (('shallow', range(4)), ('mid', range(4, 7)), ('deep', range(7, 10))):
            selected = [r for r in rows if r['T'] == horizon and r['k'] in ks]
            if not selected:
                continue
            truth = np.array([r['p_true'] for r in selected])
            metrics = {}
            for name in ('fitted', 'fixed_scale', 'known_empirical', 'exact', 'rec12', 'fH'):
                pred = np.array([r['p_' + name] for r in selected])
                metrics[name] = dict(R=float(pred.sum() / truth.sum()) if truth.sum() else None,
                                     MAE=float(np.mean(np.abs(pred - truth))), MSE=float(np.mean((pred - truth) ** 2)))
            band_summaries.append(dict(horizon=horizon, band=band, n_rows=len(selected),
                                       truth_mean=float(truth.mean()), metrics=metrics))
    return dict(scope='synthetic_only_reconstruction', n_paths=n_paths, n_true=n_true,
                caveat='Truth is Monte Carlo, not exact probabilities; rare/zero hits cannot establish tail calibration. '
                       'Origins within one series are dependent; this smoke is not an empirical acceptance test.',
                baseline_rows=str(baseline_rows), primary_truth='published_p_true',
                published_truth_paths=published_truth_paths, truth_recheck_paths=n_true,
                selected_series=series_ids, selected_origins=support,
                n_selected_origins=sum(map(len, support.values())), n_selected_rows=len(rows),
                quarter_fit_counts=quarter_fit_counts, band_summaries=band_summaries,
                engine_scope='Exact GJR known-answer tests validate this shared hourly engine; not the separate production HAR kernel.',
                rows=rows, summaries=summaries)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', required=True)
    ap.add_argument('--baseline-rows', required=True, help='Published synthetic known-rows[-oracle].csv.gz only')
    ap.add_argument('--n-hours', type=int, default=52000)
    ap.add_argument('--n-series', type=int, default=1)
    ap.add_argument('--n-orig', type=int, default=4)
    ap.add_argument('--n-paths', type=int, default=500)
    ap.add_argument('--n-true', type=int, default=0, help='Separate truth recheck paths; primary truth remains published')
    ap.add_argument('--published-truth-paths', type=int, default=20000)
    args = ap.parse_args()
    result = run_synthetic(args.baseline_rows, args.n_hours, args.n_orig, args.n_paths, args.n_true, args.n_series, args.published_truth_paths)
    with open(args.out, 'w') as stream:
        json.dump(result, stream, indent=2, allow_nan=False)


if __name__ == '__main__':
    main()
