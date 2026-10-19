#!/usr/bin/env python3
"""CODEX CONTINUATION: original RefuteR16.4(b-e), seen-row diagnostics only.
No refits, reserves, deconvolution, latent probability CI claim, or frozen gate change.
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import numpy as np
from scipy.stats import binom, norm
from r164_ranges import sg_of, wquant, clipped_calibration_range
from r164_score import MAJOR, BLOCK_ORIGIN_DAY
from r164_power import tost_power

SEED = 20261644
Z90 = float(norm.ppf(.95))
CELLS = ((24, 4, 'alts'), (72, 4, 'alts'), (168, 4, 'alts'),
         (24, 5, 'alts'), (72, 7, 'alts'), (168, 4, 'majors'))


def load_selected(path):
    """Read published rows, retaining only requested cells and the original joint mask."""
    parts = {}
    files = sorted(glob.glob(os.path.join(path, '*.npz')))
    clusters = {}
    for si, filename in enumerate(files):
        with np.load(filename) as z:
            name = str(z['name'])
            cid = clusters.setdefault(MAJOR.get(name, name), len(clusters))
            major = name in MAJOR
            selected = np.zeros(len(z['y']), dtype=bool)
            for T, k, tier in CELLS:
                if major == (tier == 'majors'):
                    selected |= (z['T_h'] == T) & (z['k_i'] == k)
            for key in ('p_fH', 'p_rec12', 'p_a', 'p_f', 'p_fbL'):
                selected &= np.isfinite(z[key])
            selected &= np.all(np.isfinite(z['boot_q']), axis=1)
            n = int(selected.sum())
            d = {k: z[k][selected] for k in ('y', 'day', 'T_h', 'k_i', 'p_fH',
                 'p_rec12', 'p_a', 'p_f', 'p_fbL', 'boot_q')}
            d.update(series=np.full(n, si), cluster=np.full(n, cid), major=np.full(n, major))
            for key, value in d.items():
                parts.setdefault(key, []).append(value)
    if not files:
        raise ValueError('no published NPZ rows found')
    return {k: np.concatenate(v) for k, v in parts.items()}, clusters


def grouping(p, sg, day):
    block = (day.astype(np.int64) - BLOCK_ORIGIN_DAY) // 182
    edges = np.unique(np.quantile(np.log(np.clip(p, 1e-5, 1-1e-5)), np.linspace(0, 1, 6)[1:-1]))
    bins = np.searchsorted(edges, np.log(np.clip(p, 1e-5, 1-1e-5)))
    keys, gid = np.unique(np.column_stack((bins, sg, block)), axis=0, return_inverse=True)
    return keys, gid


def cal_intervals(p, y, gid, keys, equal_groups=False, numpy_quantile=False):
    """Exactly original fold exclusions; equal-group variant changes only weights."""
    count = np.bincount(gid, minlength=len(keys))
    sy = np.bincount(gid, weights=y, minlength=len(keys))
    sp = np.bincount(gid, weights=p, minlength=len(keys))
    rho = sy / np.maximum(sp, 1e-12)
    lower, upper = np.full(len(p), np.nan), np.full(len(p), np.nan)
    for sg, block in np.unique(keys[:, 1:], axis=0):
        hold = (keys[gid, 1] == sg) & (keys[gid, 2] == block)
        train = (keys[:, 1] != sg) & (keys[:, 2] != block) & np.isfinite(rho) & (sp > 0)
        if train.sum() < 10:
            continue
        weights = np.ones(train.sum()) if equal_groups else count[train]
        qlo, qhi = (np.quantile(rho[train], [.05, .95]) if numpy_quantile else
                    wquant(rho[train], weights, [.05, .95]))
        lower[hold], upper[hold] = clipped_calibration_range(p[hold], qlo, qhi)
    return lower, upper


def cgm_variance(residual, series, window, centered=True):
    """Uncorrected two-way CGM mean variance; negative estimates kept for diagnostics."""
    r = np.asarray(residual, dtype=float)
    if centered and (len(np.unique(series)) < 2 or len(np.unique(window)) < 2):
        return np.nan
    u = (r - r.mean() if centered else r) / len(r)
    a = np.unique(series, return_inverse=True)[1]
    b = np.unique(window, return_inverse=True)[1]
    ab = np.unique(np.column_stack((series, window)), axis=0, return_inverse=True)[1]
    return float(sum(sign * np.square(np.bincount(g, weights=u)).sum()
                     for g, sign in ((a, 1), (b, 1), (ab, -1))))


def independent_variance(p):
    return float(np.sum(p * (1-p)) / len(p)**2)


def centered_time_variance(residual, window):
    ids = np.unique(window, return_inverse=True)[1]
    n_time = int(ids.max()) + 1
    if n_time < 2:
        return np.nan
    sums = np.bincount(ids, weights=residual-np.mean(residual))
    return float(n_time/(n_time-1) * np.square(sums).sum() / len(residual)**2)


def summary(x):
    x = np.asarray(x)
    x = x[np.isfinite(x)]
    return [float(v) for v in np.quantile(x, [.1, .5, .9])] if len(x) else None


def compatibility_bounds(lower, upper, variance):
    """Observed-target compatibility sensitivity, never a forecast or latent CI."""
    if not np.all(np.isfinite((lower, upper, variance))) or variance < 0:
        return np.nan, np.nan
    half = Z90 * np.sqrt(variance)
    return max(0., lower-half), min(1., upper+half)


def coverage(ybar, lower, upper, count):
    valid = np.isfinite(lower) & np.isfinite(upper)
    if not valid.any():
        return {'groups': 0, 'rows': 0, 'coverage_groups': None, 'coverage_rows': None}
    covered = (ybar[valid] >= lower[valid]-1e-12) & (ybar[valid] <= upper[valid]+1e-12)
    return {'groups': int(valid.sum()), 'rows': int(count[valid].sum()),
            'coverage_groups': float(covered.mean()),
            'coverage_rows': float(np.average(covered, weights=count[valid])),
            'group_width_pts_q10_50_90': summary(100*(upper-lower)[valid])}


def split_half(residual, series, day, gid, n_groups):
    """Covariance across group half-means: heuristic, not identified latent variance."""
    out = {}
    for name, half in (('time', (day-BLOCK_ORIGIN_DAY) % 182 >= 91),
                       ('series', series % 2 == 1)):
        means = []
        for side in (False, True):
            m = half == side
            n = np.bincount(gid[m], minlength=n_groups)
            means.append(np.divide(np.bincount(gid[m], weights=residual[m], minlength=n_groups),
                                   n, out=np.full(n_groups, np.nan), where=n > 0))
        valid = np.isfinite(means[0]) & np.isfinite(means[1])
        out[name] = {'paired_groups': int(valid.sum()),
                     'covariance': float(np.cov(means[0][valid], means[1][valid], ddof=1)[0, 1])
                     if valid.sum() > 1 else None}
    return out


def coverage_power_sensitivity(covered, keys, row_width, n_rep=2000):
    """Post-hoc fixed-prediction development sensitivity, not a validated range claim.

    Pigeonhole SG x 182-day block resampling keeps every forecast bin in each
    intersection together. Reset seed deliberately pairs resamples across CAL variants.
    """
    covered = np.asarray(covered, dtype=float)
    sg = np.unique(keys[:, 1], return_inverse=True)[1]
    block = np.unique(keys[:, 2], return_inverse=True)[1]
    S, B = int(sg.max())+1, int(block.max())+1
    flat = sg*B+block
    num = np.bincount(flat, weights=covered, minlength=S*B).reshape(S, B)
    den = np.bincount(flat, minlength=S*B).reshape(S, B)
    rng = np.random.default_rng(SEED+41)
    ws = rng.multinomial(S, np.full(S, 1/S), size=n_rep)
    wb = rng.multinomial(B, np.full(B, 1/B), size=n_rep)
    count = np.einsum('rs,sb,rb->r', ws, den, wb)
    total = np.einsum('rs,sb,rb->r', ws, num, wb)
    draws = total[count > 0]/count[count > 0]
    mean, sd = float(covered.mean()), float(np.std(draws, ddof=1))
    width = float(np.median(row_width)*100)
    lower_power = {str(q): float(norm.cdf((mean-q)/sd-Z90)) if sd > 0 else float(mean > q)
                   for q in (.85, .90)}
    return {'status': 'POSTHOC conditional-development normal-approximation sensitivity only',
            'fixed_predictions': True, 'fresh_calendar_or_fresh_data': False,
            'bootstrap': 'series-group x 182-day block; forecast bins co-resampled within intersection',
            'seed': SEED+41, 'replicates': n_rep, 'valid_replicates': int(len(draws)),
            'series_groups': S, 'blocks182': B, 'coverage_groups': mean, 'coverage_bootstrap_sd': sd,
            'coverage_bootstrap_ci90': [float(v) for v in np.quantile(draws, [.05, .95])],
            'normal_TOST_power_nominal90_tol5pp': float(tost_power(mean, sd, .90, .05)),
            'exploratory_one_sided_minimum_coverage_power': lower_power,
            'row_median_width_pts': width, 'deterministic_width_le10pts_indicator': int(width <= 10),
            'width_caveat': 'Width is an observed deterministic indicator as in original power code; no joint width uncertainty or validated joint claim.'}


def review_cell(rows, clusters, T, k, tier):
    m = (rows['T_h'] == T) & (rows['k_i'] == k) & (rows['major'] == (tier == 'majors'))
    d = {key: value[m] for key, value in rows.items()}
    p, y, day = d['p_fH'].astype(float), d['y'].astype(float), d['day']
    sgmap = sg_of(clusters, None)
    sg = np.array([sgmap[c] for c in d['cluster']])
    keys, gid = grouping(p, sg, day)
    count = np.bincount(gid)
    ng = len(count)
    ybar = np.bincount(gid, weights=y) / count
    pbar = np.bincount(gid, weights=p) / count
    constructors = {'CAL_row_weighted': cal_intervals(p, y, gid, keys),
                    'CAL_equal_group_CDF_control': cal_intervals(p, y, gid, keys, True),
                    'CAL_equal_group_quantile': cal_intervals(p, y, gid, keys, True, True),
                    'POINT': (p, p), 'PU': (d['boot_q'][:, 0], d['boot_q'][:, 4])}
    ds = np.stack([d['p_'+v] for v in ('a', 'f', 'fbL', 'fH', 'rec12')])
    constructors['DIS'] = ds.min(0), ds.max(0)
    l, u = constructors['CAL_row_weighted']
    for name in ('DIS', 'PU'):
        ll, uu = constructors[name]
        constructors['H_CAL_'+name] = np.minimum(l, ll), np.maximum(u, uu)
    variance = {key: [] for key in ('binomial_plugin', 'cgm_original_uncentered',
                                   'cgm_centered', 'time_centered')}
    support = {'rows': count.tolist(), 'series': [], 'asset_clusters': [], 'days': [], 'Tday_windows': [], 'calendar_span_days': []}
    degenerate_file_cgm_groups = 0
    for group in range(ng):
        mm = gid == group
        e = y[mm]-p[mm]
        window = day[mm] // max(1, T//24)
        support['series'].append(len(np.unique(d['series'][mm])))
        support['asset_clusters'].append(len(np.unique(d['cluster'][mm])))
        degenerate_file_cgm_groups += int(len(np.unique(d['series'][mm])) < 2 or len(np.unique(window)) < 2)
        support['days'].append(len(np.unique(day[mm])))
        support['Tday_windows'].append(len(np.unique(window)))
        support['calendar_span_days'].append(int(np.ptp(day[mm]))+1)
        variance['binomial_plugin'].append(independent_variance(p[mm]))
        variance['cgm_original_uncentered'].append(cgm_variance(e, d['series'][mm], window, False))
        variance['cgm_centered'].append(cgm_variance(e, d['cluster'][mm], window))
        variance['time_centered'].append(centered_time_variance(e, window))
    variance = {key: np.array(value) for key, value in variance.items()}
    constructions = {}
    for name, (lower, upper) in constructors.items():
        valid = np.isfinite(lower) & np.isfinite(upper)
        n = np.bincount(gid[valid], minlength=ng)
        lg = np.divide(np.bincount(gid[valid], weights=lower[valid], minlength=ng), n,
                       out=np.full(ng, np.nan), where=n > 0)
        ug = np.divide(np.bincount(gid[valid], weights=upper[valid], minlength=ng), n,
                       out=np.full(ng, np.nan), where=n > 0)
        result = {'original_realized_frequency': coverage(ybar, lg, ug, count),
                  'row_width_pts_q10_50_90': summary(100*(upper-lower)[valid]), 'compatibility_only': {}}
        for key, var in variance.items():
            widened = np.array([compatibility_bounds(a, b, v) for a, b, v in zip(lg, ug, var)])
            metric = coverage(ybar, widened[:, 0], widened[:, 1], count)
            matched = np.isfinite(widened[:, 0]) & np.isfinite(widened[:, 1])
            metric['original_on_same_support'] = coverage(ybar, np.where(matched, lg, np.nan),
                                                        np.where(matched, ug, np.nan), count)
            result['compatibility_only'][key] = metric
        if (T, k, tier) in ((24, 5, 'alts'), (72, 7, 'alts')) and name in (
                'CAL_row_weighted', 'CAL_equal_group_quantile'):
            ok = np.isfinite(lg) & np.isfinite(ug)
            covered = (ybar[ok] >= lg[ok]-1e-12) & (ybar[ok] <= ug[ok]+1e-12)
            result['posthoc_power_sensitivity'] = coverage_power_sensitivity(
                covered, keys[ok], (upper-lower)[valid])
        constructions[name] = result
    err2 = float(np.mean((ybar-pbar)**2))
    return {'horizon_hours': T, 'level_index': k, 'tier': tier,
            'support': {'rows': int(len(p)), 'groups': ng, 'series': int(len(np.unique(d['series']))),
                        'blocks182': int(len(np.unique(keys[:, 2]))),
                        'day_min_max': [int(day.min()), int(day.max())],
                        'original_uncentered_venue_file_CGM_degenerate_groups': degenerate_file_cgm_groups,
                        'group_q10_50_90': {key: summary(value) for key, value in support.items()}},
            'group_residual_rms_pts': float(100*np.sqrt(err2)),
            'noise_diagnostics': {key: {'se_pts_q10_50_90': summary(100*np.sqrt(np.maximum(v, 0))),
                'negative_variances': int((v < 0).sum()), 'unavailable_variances': int((~np.isfinite(v)).sum()),
                'mean_variance_over_mean_squared_group_error_descriptive_only': float(np.nanmean(v)/err2) if np.isfinite(v).any() and err2 > 0 else None}
                for key, v in variance.items()},
            'split_half_heuristics': split_half(y-p, d['series'], day, gid, ng),
            'constructions': constructions}


def synthetic():
    rng = np.random.default_rng(SEED)
    s, days, reps = 20, 50, 1000
    series, window = np.repeat(np.arange(s), days), np.tile(np.arange(days), s)
    diagnostic = {}
    for common in (False, True):
        estimates, means = [], []
        for _ in range(reps):
            y = (np.tile(rng.binomial(1, .5, days), s) if common else rng.binomial(1, .5, s*days))
            means.append(y.mean())
            estimates.append(cgm_variance(y-.5, series, window))
        diagnostic['common_day' if common else 'IID'] = {
            'known_mean_variance': .25/days if common else .25/(s*days),
            'empirical_mean_variance': float(np.var(means, ddof=1)),
            'mean_centered_cgm_variance': float(np.mean(estimates)),
            'binomial_plugin_variance': .25/(s*days)}
    n = 101
    half = Z90*np.sqrt(.25/n)
    exact = float(binom.cdf(np.floor((.5+half)*n), n, .5)-binom.cdf(np.ceil((.5-half)*n)-1, n, .5))
    return {'odd_n_correct_latent_p': {'n': n, 'p': .5, 'latent_point_interval_coverage': 1.,
               'realized_frequency_point_interval_coverage': 0., 'normal_widened_exact_frequency_coverage': exact},
            'noise_controls': diagnostic,
            'exploratory_gate_contrast': {str(c): {
                'minimum_90_coverage_power_at_se01': float(norm.cdf((c-.9)/.01-Z90)),
                'TOST_90_plusminus5pp_power_at_se01': float(max(0., norm.cdf((.95-c)/.01-Z90)-norm.cdf((.85-c)/.01+Z90)))}
                for c in (.9, .95, .99)}}


def run(path, output):
    rows, clusters = load_selected(path)
    result = {'attribution': 'CODEX CONTINUATION of original Claude RefuteR16.4(b-e)', 'seed': SEED,
        'estimands': {'original': 'coverage of realized finite-group frequency by mean row endpoints',
            'binomial': 'conditional independent Bernoulli variance sum p(1-p)/n^2 using model p',
            'centered_CGM': 'economic asset cluster x common nonoverlapping T-day windows; group residual mean removed; unavailable with fewer than two clusters on either axis',
            'uncentered_CGM': 'original venue-file x window raw e=y-p sums; includes calibration bias, not pure noise; duplicate venues are not independent assets'},
        'caveats': ['All rows were already seen; report-only, no refits or reserve access.',
            'Original mask, forecast-only bins, series hash groups, 182-day blocks and fold exclusions preserved.',
            'CAL_equal_group_CDF_control isolates weights using original wquant; CAL_equal_group_quantile faithfully uses reviewer numpy.quantile.',
            'Centered CGM uses economic assets, not duplicate venue files; fewer than two assets or windows makes it unavailable, not zero noise.',
            'SE-widening uses heldout outcomes: diagnostic compatibility only, never latent CI validation or deployable ranges.',
            'Negative CGM variances make compatibility unavailable; SE summaries clip them to zero and report counts.',
            'Centered residual covariance still includes model error and temporal effects; it is not identified aleatoric variance.',
            'Nonoverlapping origin windows do not ensure independent outcomes: forecast horizons can cross window boundaries.',
            'Split-half covariance is descriptive, not an identified latent share; no outcome-dependent deconvolution.',
            'One-sided minimum coverage contrast is exploratory; original equivalence gate and frozen claims unchanged.'],
        'synthetic': synthetic(), 'cells': []}
    for args in CELLS:
        cell = review_cell(rows, clusters, *args)
        result['cells'].append(cell)
        print(args, cell['support']['rows'], cell['support']['groups'], flush=True)
    with open(output, 'w') as f:
        json.dump(result, f, indent=2, allow_nan=False)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows-dir', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    run(args.rows_dir, args.out)
