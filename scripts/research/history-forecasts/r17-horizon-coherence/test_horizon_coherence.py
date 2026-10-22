"""Synthetic-only qualification; no market inputs or historical model imports."""
from fractions import Fraction as F
import itertools
import math
import unittest

import numpy as np

from horizon_coherence import project_column, project_grid


def oracle(values):
    """Independent slow max-min interval-mean characterization, not PAV."""
    x = tuple(F.from_float(float(v)) for v in values)
    n = len(x)
    return tuple(max(min(sum(x[a:b + 1], F(0)) / (b - a + 1)
                         for b in range(i, n)) for a in range(i + 1))
                 for i in range(n))


def loss(values, labels):
    return sum(((x - y) ** 2 for x, y in zip(values, labels)), F(0))


class ProjectionTests(unittest.TestCase):
    def test_multiple_blocks_and_exact_certificate(self):
        p = [0.75, 0.25, 0.875, 0.125, 1.0]
        r = project_column(p)
        self.assertEqual(r.exact_values, (F(1, 2),) * 4 + (F(1),))
        self.assertEqual([(b.start, b.stop, b.mean) for b in r.blocks],
                         [(0, 2, F(1, 2)), (2, 4, F(1, 2)), (4, 5, F(1))])
        self.assertEqual(r.quantization_bound, 0)

    def test_identity_equal_endpoints_and_ties(self):
        for p in ([0., 0., .5, 1., 1.], [0.] * 5, [1.] * 5, [.5] * 5):
            r = project_column(p)
            self.assertEqual(r.exact_values, tuple(F.from_float(v) for v in p))
            self.assertEqual(r.quantization_bound, 0)
            self.assertEqual(len(r.blocks), 5)

    def test_max_min_oracle_deterministic_small_cases(self):
        for p in itertools.product((0., .25, .5, 1.), repeat=5):
            self.assertEqual(project_column(p).exact_values, oracle(p), p)

    def test_grid_preserves_severity_and_inputs(self):
        grid = np.array([[.2, .3, .5, .8, 1.], [.1, .2, .6, .7, .9],
                         [.3, .4, .4, .9, .9], [0., .3, .5, .6, .8],
                         [.4, .5, .7, .7, 1.]], dtype=np.float64)
        before = grid.tobytes()
        r = project_grid(grid)
        self.assertEqual(grid.tobytes(), before)
        self.assertFalse(np.shares_memory(grid, r.probabilities))
        self.assertTrue(np.all(r.probabilities[1:] >= r.probabilities[:-1]))
        self.assertTrue(np.all(r.probabilities[:, 1:] >= r.probabilities[:, :-1]))
        for j, col in enumerate(r.columns):
            self.assertEqual(col.exact_values, oracle(grid[:, j]))
            self.assertEqual(r.probabilities[:, j].tolist(), [float(v) for v in col.exact_values])
        r.probabilities[0, 0] = .99
        self.assertEqual(grid.tobytes(), before)

    def test_reject_shape_dtype_nonfinite_range_and_barrier_order(self):
        for bad in (np.zeros((5, 4)), np.zeros((4, 5)), np.zeros((5, 5), dtype=np.float32),
                    np.zeros((5, 5), dtype=int), [[0.] * 5] * 5):
            with self.assertRaises(ValueError): project_grid(bad)
        for value in (np.nan, np.inf, -np.inf, -math.ulp(0.), 1.0000000000000002):
            bad = np.full((5, 5), .5); bad[2, 2] = value
            with self.assertRaises(ValueError): project_grid(bad)
        bad = np.full((5, 5), .5); bad[2, 2] = np.nextafter(.5, 0.)
        with self.assertRaises(ValueError): project_grid(bad)

    def test_primary_h24_can_harm_while_total_improves(self):
        # Nested binary labels do not protect the original primary horizon.
        p = [0., 0., .25, 0., 0.]
        q = project_column(p).exact_values
        # H24 y=1 requires both later labels to be 1 as well.
        y = [F(0), F(0), F(1), F(1), F(1)]
        self.assertGreater((q[2] - y[2]) ** 2, (F(1, 4) - y[2]) ** 2)
        self.assertLess(loss(q, y), loss(tuple(map(F.from_float, p)), y))

    def test_ideal_projection_theorem_nested_binary_labels(self):
        for p in itertools.product((0., .5, 1.), repeat=5):
            original = tuple(map(F.from_float, p)); q = project_column(p).exact_values
            displacement = loss(original, q)
            for first_one in range(6):
                y = tuple(F(i >= first_one) for i in range(5))
                self.assertLessEqual(loss(q, y), loss(original, y) - displacement)

    def test_rounding_counterexample_and_exact_bound_without_clamp(self):
        u = math.ulp(.5); a = .5 + 2 * u; b = .5 + u
        p = [a, b, 1., 1., 1.]; r = project_column(p)
        original = tuple(map(F.from_float, p)); represented = tuple(F.from_float(float(v)) for v in r.exact_values)
        y = (F(0),) * 5
        self.assertLess(loss(r.exact_values, y), loss(original, y))
        deterioration = loss(represented, y) - loss(original, y)
        self.assertEqual(deterioration, F.from_float(a) ** 2 - F.from_float(b) ** 2)
        self.assertGreater(deterioration, 0)
        errors = tuple(v - q for v, q in zip(represented, r.exact_values))
        bound = sum((2 * abs(e) + e * e for e in errors), F(0))
        self.assertEqual(r.quantization_bound, bound)
        self.assertGreater(bound, 0)
        for first_one in range(6):
            labels = tuple(F(i >= first_one) for i in range(5))
            self.assertLessEqual(abs(loss(represented, labels) - loss(r.exact_values, labels)), bound)


if __name__ == '__main__':
    unittest.main()
