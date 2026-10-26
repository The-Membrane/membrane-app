#!/usr/bin/env python3
"""Deterministic known-answer checks of pinned original fh_boot; no market data."""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import time
import unittest
from types import SimpleNamespace

# Set before NumPy loads; never import the source module (Torch/Numba side effects).
for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[name] = '1'
import numpy as np

HERE = Path(__file__).resolve().parent
SOURCE_ROOT = Path('/Users/EBmic/research-workspaces/history-forecasts-continuation')
SOURCE_REL = 'scripts/research/history-forecasts/r164_recursive.py'
H = np.array([[1, 1, 1, 1], [1, 1, -1, -1],
              [1, -1, 1, -1], [1, -1, -1, 1]], dtype=float)


def load_subject():
    pins = json.loads((HERE / 'source-pins.json').read_text())
    head = subprocess.check_output(['git', '-C', str(SOURCE_ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    assert head == pins['commit'], (head, pins['commit'])
    raw = (SOURCE_ROOT / SOURCE_REL).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == pins['source_sha256']
    tree = ast.parse(raw)
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'fh_boot')
    # Keep the exact parsed source function, including its default argument expression.
    segment = ast.get_source_segment(raw.decode(), node).encode()
    assert hashlib.sha256(segment).hexdigest() == pins['function_sha256']
    assert hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest() == pins['function_ast_sha256']
    constants = {}
    for n in tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            if n.targets[0].id in ('BOOT_B', 'BOOT_BLOCK_H'):
                constants[n.targets[0].id] = ast.literal_eval(n.value)
    assert constants == {'BOOT_B': 20, 'BOOT_BLOCK_H': 720}
    scope = {'np': np, '__builtins__': __builtins__, **constants}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE_ROOT / SOURCE_REL), 'exec'), scope)
    return scope['fh_boot']


class Thresholds:
    def __init__(self, depth):
        self.depth = depth
        self.scale = 0.5
        self.barriers = np.array([-2., -.875, -.25, -.0625, 0.])

    def thresholds(self, sigma):
        return self.barriers[None, :] / (np.asarray(sigma)[:, None] * self.scale)


def fixture():
    # 32 *calendar* blocks, only 64 valid rows per 720-hour block.
    # Each block has one exact Hadamard state, all four states occur eight times.
    last = 31 * 720 + 63
    qs = last + 24
    n = qs + 16
    X = np.zeros((n, 4))
    y = np.zeros(n)
    dep = np.full(n, np.nan)
    valid = np.zeros(n, bool)
    for b in range(32):
        rows = b * 720 + np.arange(64)
        X[rows] = H[b % 4]
        y[rows] = H[b % 4] @ np.array([-.125, .0625, -.03125, .015625]) + (b - 15) / 128
        dep[rows] = -(1 + np.arange(64) % 13 + b % 7) / 16
        valid[rows] = True
    # Deliberately valid future training candidates, excluded by maturity cutoff.
    future = np.arange(last + 1, n)
    X[future] = H[np.arange(len(future)) % 4]
    y[future] = 3.
    dep[future] = -8.
    valid[future] = True
    te = np.arange(qs + 1, qs + 6)
    X[te[:4]] = H
    okX = valid.copy()
    okX[te[-1]] = False
    P6 = SimpleNamespace(P=Thresholds(dep), T_h=24, n=n, X=X,
                         lfut=y, okH=valid, okX=okX, K=5)
    return P6, qs, te


def draws():
    values = [np.ones(32, dtype=int)]
    for b in range(1, 20):
        w = np.zeros(32, dtype=int)
        # Four selected consecutive blocks retain full rank, with unequal weights.
        start = (b * 3) % 29
        w[start:start + 4] = [2, 6, 10, 14]
        values.append(w)
    return values


class ScriptedRNG:
    def __init__(self, weights):
        self.weights = [np.array(w, dtype=int) for w in weights]
        self.calls = 0

    def multinomial(self, n, p):
        assert n == 32, n
        np.testing.assert_array_equal(p, np.full(32, 1 / 32))
        w = self.weights[self.calls]
        self.calls += 1
        assert w.shape == (32,) and np.all(w >= 0) and w.sum() == n
        return w.copy()


def oracle(P6, qs, te, weights):
    # Independently select eligible origins and literally materialize duplicates.
    eligible = [i for i in range(P6.n) if P6.okH[i] and i + P6.T_h <= qs]
    if len(eligible) < 50:
        return None
    first = eligible[0]
    out = np.full((len(weights), len(te), P6.K), np.nan)
    for b, w in enumerate(weights):
        duplicated = []
        for block, count in enumerate(w):
            block_rows = [i for i in eligible if first + block * 720 <= i < first + (block + 1) * 720]
            for _ in range(int(count)):
                duplicated.extend(block_rows)
        rows = np.array(duplicated, dtype=int)
        coef, _, rank, _ = np.linalg.lstsq(P6.X[rows], P6.lfut[rows], rcond=None)
        if rank < 4:
            continue
        depths = P6.P.depth[rows] / (np.exp(P6.X[rows] @ coef) * P6.P.scale)
        depths = depths[np.isfinite(depths)]
        for j, origin in enumerate(te):
            if not P6.okX[origin]:
                continue
            sigma = np.exp(P6.X[origin] @ coef)
            for k, barrier in enumerate(P6.P.barriers):
                threshold = barrier / (sigma * P6.P.scale)
                out[b, j, k] = sum(float(z <= threshold) for z in depths) / len(depths)
    return out


class KnownAnswer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.subject = staticmethod(load_subject())

    def test_all_default_replicates_states_barriers(self):
        p, qs, te = fixture()
        rng = ScriptedRNG(draws())
        actual = self.subject(p, qs, te, rng)  # Exercise original default B=20.
        expected = oracle(p, qs, te, draws())
        self.assertEqual(actual.shape, (20, 5, 5))
        self.assertEqual(rng.calls, 20)
        np.testing.assert_allclose(actual, expected, atol=1e-14, rtol=0, equal_nan=True)
        self.assertTrue(np.isnan(actual[:, -1]).all())
        self.assertTrue(np.isfinite(actual[:, :4]).all())
        self.assertGreater(np.ptp(actual[:, :4], axis=0).max(), .01)

    def test_singular_draw_is_nan_and_next_draw_survives(self):
        p, qs, te = fixture()
        singular = np.zeros(32, dtype=int)
        singular[0] = 32
        weights = [singular, np.ones(32, dtype=int)]
        actual = self.subject(p, qs, te, ScriptedRNG(weights), B=2)
        self.assertTrue(np.isnan(actual[0]).all())
        self.assertTrue(np.isfinite(actual[1, :4]).all())
        np.testing.assert_allclose(actual, oracle(p, qs, te, weights), atol=1e-14, rtol=0, equal_nan=True)

    def test_less_than_50_returns_none_without_rng(self):
        p, qs, te = fixture()
        p.okH[:] = False
        p.okH[:49] = True
        rng = ScriptedRNG([])
        self.assertIsNone(self.subject(p, qs, te, rng))
        self.assertEqual(rng.calls, 0)

    def test_post_maturity_cutoff_mutations_do_not_leak(self):
        p, qs, te = fixture()
        mutated = copy.deepcopy(p)
        future = np.arange(p.n) > qs - p.T_h
        mutated.P.depth[future] = -12345.
        mutated.lfut[future] = -5678.
        np.testing.assert_array_equal(mutated.X[te], p.X[te])
        actual = self.subject(p, qs, te, ScriptedRNG(draws()))
        changed = self.subject(mutated, qs, te, ScriptedRNG(draws()))
        np.testing.assert_array_equal(actual, changed)

    def test_mature_cutoff_is_inclusive_and_boundary_is_sensitive(self):
        p, qs, te = fixture()
        cutoff = qs - p.T_h
        self.assertTrue(p.okH[cutoff])
        weights = [np.ones(32, dtype=int)]
        baseline = self.subject(p, qs, te, ScriptedRNG(weights), B=1)
        p.P.depth[cutoff] = -12345.
        actual = self.subject(p, qs, te, ScriptedRNG(weights), B=1)
        np.testing.assert_allclose(actual, oracle(p, qs, te, weights), atol=1e-14, rtol=0, equal_nan=True)
        self.assertTrue(np.any(actual[:, :4] != baseline[:, :4]))

    def test_empirical_cdf_includes_exact_ties(self):
        p, qs, te = fixture()
        p.lfut[:] = 0.  # Exact zero OLS coefficient => sigma=1 in both solvers.
        p.P.depth[p.okH] = -.25
        weights = [np.ones(32, dtype=int)]
        actual = self.subject(p, qs, te, ScriptedRNG(weights), B=1)
        np.testing.assert_allclose(actual, oracle(p, qs, te, weights), atol=0, rtol=0, equal_nan=True)
        np.testing.assert_array_equal(actual[0, :4, 2], np.ones(4))
        np.testing.assert_array_equal(actual[0, :4, 1], np.zeros(4))


if __name__ == '__main__':
    start = time.monotonic()
    assert shutil.disk_usage(HERE).free >= 2 * 1024**3, 'Need 2 GiB free reserve'
    # macOS ru_maxrss is bytes; limit CPU to 30 seconds without constraining NumPy mappings.
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(KnownAnswer))
    elapsed = time.monotonic() - start
    rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if os.uname().sysname != 'Darwin':
        rss_bytes *= 1024
    print(json.dumps({'elapsed_seconds': round(elapsed, 3), 'peak_rss_bytes': rss_bytes,
                      'tests_run': result.testsRun, 'success': result.wasSuccessful()}, sort_keys=True))
    assert elapsed < 30, elapsed
    assert rss_bytes < 500 * 1024**2, rss_bytes
    raise SystemExit(0 if result.wasSuccessful() else 1)
