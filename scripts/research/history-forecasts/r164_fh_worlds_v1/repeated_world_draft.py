#!/usr/bin/env python3
"""UNEXECUTED DRAFT. Explicit parent-approved spec hash required to run."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import platform
import sys
import shutil
import signal
import time
from types import SimpleNamespace

for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[key] = '1'
import numpy as np
from validate_fh_boot import H, HERE, SOURCE_ROOT, SOURCE_REL, load_subject


class Barriers:
    def __init__(self, depth, scale, levels):
        self.depth, self.scale = depth, scale
        self.barriers = np.log1p(levels)

    def thresholds(self, sigma):
        return self.barriers[None, :] / (np.asarray(sigma)[:, None] * self.scale)


class FixedWeights:
    def __init__(self, weights):
        self.weights, self.calls = weights, 0

    def multinomial(self, nb, p):
        assert nb == 32
        np.testing.assert_array_equal(p, np.full(32, 1 / 32))
        w = self.weights[self.calls]
        self.calls += 1
        return w.copy()


def build_world(spec, j):
    rng = np.random.Generator(np.random.PCG64(spec['world_seed_base'] + j))
    beta = np.asarray(spec['beta'])
    rows = (np.arange(32)[:, None] * 720 + np.arange(64)).reshape(-1)
    cutoff = int(rows[-1])
    qs = cutoff + spec['T_h']
    te = np.arange(qs + 1, qs + 5)
    n = int(te[-1]) + 1
    X, lfut, depth = np.zeros((n, 4)), np.zeros(n), np.full(n, np.nan)
    okH, okX = np.zeros(n, bool), np.zeros(n, bool)
    design = np.tile(H, (16, 1))
    shocks = rng.normal(0, spec['shock_component_sd'], (32, 4))
    # Distinct RNG draws: depth innovations independent of shocks conditional on X.
    exp_innovations = rng.exponential(1, (32, 64))
    for b in range(32):
        ix = rows[b * 64:(b + 1) * 64]
        X[ix] = design
        lfut[ix] = design @ (beta + shocks[b])
        depth[ix] = -np.exp(design @ beta) * spec['scale'] * exp_innovations[b]
        okH[ix], okX[ix] = True, True
    X[te], okX[te] = H, True
    P = Barriers(depth, spec['scale'], spec['levels'])
    p6 = SimpleNamespace(P=P, T_h=spec['T_h'], n=n, X=X, lfut=lfut,
                         okH=okH, okX=okX, K=3)
    truth = np.exp(P.barriers[None, :] / (np.exp(H @ beta)[:, None] * spec['scale']))
    return p6, qs, te, truth, shocks, exp_innovations


def package(raw, quantiles):
    # Exact original caller operations/order; do not silently drop invalid worlds.
    monotone = np.minimum.accumulate(raw, axis=-1)
    return np.nanquantile(monotone, quantiles, axis=0), np.nanstd(monotone, axis=0)


def metric_summary(values):
    """Independent sampling unit is WORLD, never its 12 state/barrier cells."""
    x = np.asarray(values)
    w = len(x)
    return {'mean': np.mean(x, axis=0).tolist(),
            'world_se': (np.std(x, axis=0, ddof=1) / np.sqrt(w)).tolist() if w > 1 else None}


def summarize(records):
    summary = {'completed_worlds': len(records), 'uncertainty_unit': 'independent world', 'by_B': {}}
    if not records:
        return summary
    error = np.stack([r['point'] - r['truth'] for r in records])
    summary['point_bias'] = metric_summary(error)
    summary['point_mse'] = metric_summary(error ** 2)
    summary['point_rmse'] = np.sqrt(np.mean(error ** 2, axis=0)).tolist()
    rmse = np.sqrt(np.mean(error ** 2, axis=0))
    summary['point_rmse_delta_world_se'] = (np.std(error ** 2, axis=0, ddof=1) /
        np.sqrt(len(records)) / (2 * rmse)).tolist() if len(records) > 1 else None
    for B in (20, 200):
        qs = np.stack([r[f'q{B}'] for r in records])
        truth = np.stack([r['truth'] for r in records])
        valid = np.isfinite(qs[:, 0]) & np.isfinite(qs[:, -1])
        covered = valid & (qs[:, 0] <= truth) & (truth <= qs[:, -1])
        width = np.where(valid, qs[:, -1] - qs[:, 0], np.nan)
        summary['by_B'][str(B)] = {
            'interval_available_world_count': valid.sum(axis=0).tolist(),
            'interval_available': metric_summary(valid.astype(float)),
            'interval_inclusion_all_worlds_unavailable_counts_as_no': metric_summary(covered.astype(float)),
            'interval_width_nan_if_unavailable': metric_summary(width),
            'world_mean_inclusion_over_12_fixed_cells': metric_summary(covered.mean(axis=(1, 2))),
            'world_mean_width_over_12_fixed_cells': metric_summary(width.mean(axis=(1, 2))),
            'invalid_replicates_by_world': [int(np.any(~np.isfinite(r[f'raw{B}']), axis=(1, 2)).sum()) for r in records]}
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=int, choices=(8, 64), required=True)
    parser.add_argument('--approved-freeze-sha256', required=True,
                        help='Exact spec hash reviewed and explicitly frozen by parent')
    args = parser.parse_args()
    spec_bytes = (HERE / 'repeated-world-spec.json').read_bytes()
    spec_sha = hashlib.sha256(spec_bytes).hexdigest()
    if args.approved_freeze_sha256 != spec_sha:
        parser.error('Approved freeze hash does not match current spec')
    spec = json.loads(spec_bytes)
    out = HERE / f'worlds-stage-{args.stage}-{spec_sha[:12]}'
    out.mkdir(exist_ok=False)  # Never overwrite evidence or hide a previous abort.
    start = time.monotonic()
    records = []
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {'spec_sha256': spec_sha, 'stage': args.stage, 'status': 'started',
                'hashes': {
                    'source': sha(SOURCE_ROOT / SOURCE_REL),
                    'script': sha(Path(__file__).resolve()),
                    'spec': spec_sha,
                    'helper': sha(HERE / 'validate_fh_boot.py'),
                    'source_pins': sha(HERE / 'source-pins.json'),
                    'caller_pins': sha(HERE / 'caller-pins.json'),
                    'seed_plan': sha(HERE / 'seed-plan.json')},
                'runtime': {'python': sys.version, 'numpy': np.__version__,
                            'platform': platform.platform(), 'executable': sys.executable,
                            'threads': {k: os.environ[k] for k in
                                        ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS')}},
                'timing_scope': 'Internal elapsed begins after imports; parent outer wrapper receipt includes startup/imports and all final writes and supplies gate t8.',
                'resource_observations': [],
                'world_seeds': [spec['world_seed_base'] + j for j in range(64)],
                'bootstrap_seeds': [spec['bootstrap_seed_base'] + j for j in range(64)]}
    def observe_resources(label):
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if os.uname().sysname != 'Darwin':
            rss *= 1024
        free = shutil.disk_usage(HERE).free
        manifest['resource_observations'].append(
            {'label': label, 'internal_elapsed_seconds': time.monotonic() - start,
             'peak_rss_bytes': rss, 'free_disk_bytes': free})
        manifest['peak_rss_bytes'] = max(r['peak_rss_bytes'] for r in manifest['resource_observations'])
        manifest['min_observed_free_disk_bytes'] = min(r['free_disk_bytes'] for r in manifest['resource_observations'])
        return rss, free
    def alarm_handler(*_):
        raise TimeoutError('120-second invocation wall budget reached')
    signal.signal(signal.SIGALRM, alarm_handler)
    signal.alarm(spec['wall_seconds_per_invocation'])
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    try:
        rss, free = observe_resources('before_source_load')
        assert rss < spec['rss_bytes'] and free >= spec['disk_reserve_bytes']
        subject = load_subject()
        caller_pins = json.loads((HERE / 'caller-pins.json').read_text())
        source_lines = (SOURCE_ROOT / SOURCE_REL).read_bytes().splitlines(keepends=True)
        lo, hi = caller_pins['inclusive_lines']
        assert hashlib.sha256(b''.join(source_lines[lo - 1:hi])).hexdigest() == caller_pins['sha256']
        for j in range(args.stage):
            rss, free = observe_resources(f'world-{j:02d}-before')
            assert rss < spec['rss_bytes'] and free >= spec['disk_reserve_bytes']
            p6, qs, te, truth, shocks, exp_innovations = build_world(spec, j)
            weight_rng = np.random.Generator(np.random.PCG64(spec['bootstrap_seed_base'] + j))
            weights = weight_rng.multinomial(32, np.full(32, 1 / 32), size=200)
            # Save inputs before execution so a mid-world abort preserves its realization.
            np.savez(out / f'world-{j:02d}-inputs.npz', shocks=shocks, exponential=exp_innovations,
                     weights=weights, truth=truth, states=H, test_origins=te, qs=qs)
            raw20 = subject(p6, qs, te, FixedWeights(weights[:20]))  # Original default B20.
            np.save(out / f'world-{j:02d}-raw20.npy', raw20)
            raw200 = subject(p6, qs, te, FixedWeights(weights), B=200)
            np.save(out / f'world-{j:02d}-raw200.npy', raw200)
            np.testing.assert_array_equal(raw20, raw200[:20])
            point = subject(p6, qs, te, FixedWeights(np.ones((1, 32), dtype=int)), B=1)[0]
            q20, sd20 = package(raw20, spec['quantiles'])
            q200, sd200 = package(raw200, spec['quantiles'])
            record = dict(point=point, truth=truth, raw20=raw20, raw200=raw200,
                          q20=q20, q200=q200, sd20=sd20, sd200=sd200)
            np.savez(out / f'world-{j:02d}-outputs.npz', **record)
            records.append(record)
            rss, free = observe_resources(f'world-{j:02d}-after')
            assert rss < spec['rss_bytes'], f'RSS budget exceeded: {rss}'
            assert free >= spec['disk_reserve_bytes'], f'Disk reserve exceeded: {free}'
        manifest['status'] = 'complete'
    except BaseException as exc:
        manifest.update(status='aborted_partial_evidence', error=repr(exc))
        raise
    finally:
        signal.alarm(0)
        manifest.update(completed_worlds=len(records), elapsed_seconds=time.monotonic() - start)
        # NaNs remain explicit NaN tokens in this Python-readable summary; NPZ is authoritative.
        (out / 'summary.json').write_text(json.dumps(summarize(records), indent=2) + '\n')
        observe_resources('after_summary_before_manifest_write')
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
