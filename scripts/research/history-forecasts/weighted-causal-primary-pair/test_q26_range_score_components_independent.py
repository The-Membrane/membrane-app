"""Independent invented accounting fixtures. No saved research arrays are read.

Staged for parent execution. Rational expected values use Python scalars and
the ORIGINAL binary64 coefficient 2/(1-.9), not the decomposition implementation.
The registered 64-epsilon allowance is a comparison policy, not an error proof.
"""
import importlib.util
import hashlib
import json
import math
from pathlib import Path
import sys
import types
import tempfile
import unittest

import numpy as np

SOURCE = str(Path(__file__).with_name('q26-range-score-components.py'))
M = types.ModuleType('q26_score_components_independent_subject')
M.__file__ = SOURCE
sys.modules[M.__name__] = M
exec(compile(Path(SOURCE).read_bytes(), SOURCE, 'exec'), vars(M))
COEF = 2/(1-.9)


def run(y, lower, upper, *, sg=None, block=None, bins=None, scope=None):
    n = len(y)
    return M.components(np, np.asarray(y, dtype=np.float64),
                        np.asarray(sg if sg is not None else [0]*n, dtype=np.int64),
                        np.asarray(block if block is not None else [0]*n, dtype=np.int64),
                        np.asarray(bins if bins is not None else [0]*n, dtype=np.int64),
                        np.asarray(lower, dtype=np.float64), np.asarray(upper, dtype=np.float64),
                        np.asarray(scope if scope is not None else [True]*n, dtype=bool))


class Independent(unittest.TestCase):
    def check_identity(self, r):
        parts = [r[k] for k in ('width_component_pp', 'lower_miss_component_pp', 'upper_miss_component_pp')]
        expected_allowance = 64*np.finfo(np.float64).eps*max(
            1., abs(r['original_interval_score_pp']), math.fsum(abs(x) for x in parts))
        self.assertEqual(r['rounding_tolerance_pp'], expected_allowance)
        self.assertLessEqual(abs(math.fsum(parts)-r['original_interval_score_pp']), expected_allowance)
        self.assertLessEqual(abs(r['component_sum_pp']-r['original_interval_score_pp']), expected_allowance)

    def test_hand_rational_unequal_group_sizes_equal_group_accounting(self):
        # One below group has one row; one above group has three. Equal-group
        # accounting assigns equal lower/upper contributions despite row counts.
        r = run([0, 1, 1, 1], [.25, .5, .5, .5], [.5, .75, .75, .75],
                sg=[0, 4, 4, 4], block=[2, 9, 9, 9])
        self.assertEqual(r['groups'], 2)
        self.assertEqual(r['width_component_pp'], 25.)
        self.assertEqual(r['lower_miss_component_pp'], COEF*.25/2*100)
        self.assertEqual(r['upper_miss_component_pp'], COEF*.25/2*100)
        self.assertEqual(r['coverage'], 0.)
        self.assertEqual((r['below'], r['above']), (1, 1))
        self.check_identity(r)

    def test_original_binary64_coefficient_not_literal_twenty(self):
        r = run([0], [.25], [.5])
        self.assertEqual(r['lower_miss_component_pp'], COEF*.25*100)
        self.assertNotEqual(r['lower_miss_component_pp'], 20*.25*100)
        self.check_identity(r)

    def test_width_and_each_side_can_dominate_without_changing_estimand(self):
        width = run([0, 1], [0, 0], [1, 1])
        low = run([0], [.875], [.9375])
        high = run([1], [.0625], [.125])
        self.assertEqual(width['width_component_pp'], 100.)
        self.assertEqual(width['lower_miss_component_pp']+width['upper_miss_component_pp'], 0.)
        self.assertGreater(low['lower_miss_component_pp'], low['width_component_pp'])
        self.assertEqual(low['upper_miss_component_pp'], 0.)
        self.assertGreater(high['upper_miss_component_pp'], high['width_component_pp'])
        self.assertEqual(high['lower_miss_component_pp'], 0.)
        for r in (width, low, high): self.check_identity(r)

    def test_coverage_tolerance_does_not_zero_real_score_penalty(self):
        low = math.nextafter(1e-12, 0.)
        r = run([0], [low], [.5])
        self.assertEqual(r['coverage'], 1.)
        self.assertEqual((r['below'], r['above']), (0, 0))
        self.assertGreater(r['lower_miss_component_pp'], 0.)
        self.assertEqual(r['lower_miss_component_pp'], COEF*low*100)
        self.check_identity(r)

    def test_offsetting_width_and_lower_penalty_deltas_are_not_rescue(self):
        a = run([0], [.25], [.75])
        b = run([0], [.265625], [.453125])
        self.assertEqual(b['width_component_pp']-a['width_component_pp'], -31.25)
        self.assertAlmostEqual(b['lower_miss_component_pp']-a['lower_miss_component_pp'], 31.25, places=11)
        total_delta = b['original_interval_score_pp']-a['original_interval_score_pp']
        component_delta = math.fsum(b[k]-a[k] for k in
            ('width_component_pp', 'lower_miss_component_pp', 'upper_miss_component_pp'))
        self.assertLessEqual(abs(total_delta-component_delta),
                             a['rounding_tolerance_pp']+b['rounding_tolerance_pp'])
        self.check_identity(a); self.check_identity(b)

    def test_noncontiguous_group_ids_scope_and_zero_endpoints(self):
        args = dict(y=[1, 0, 0, 1], lower=[0, 0, 0, 0], upper=[0, 1, 1, 0],
                    sg=[0, 4, 4, 0], block=[2, 9, 9, 50], bins=[0, 3, 3, 0])
        r = run(**args, scope=[True, False, False, True])
        self.assertEqual(r['groups'], 2)
        self.assertEqual(r['width_component_pp'], 0.)
        self.assertEqual(r['lower_miss_component_pp'], 0.)
        self.assertEqual(r['upper_miss_component_pp'], COEF*100)
        self.assertEqual(r['above'], 2)
        relabeled = dict(args, sg=[1, 0, 0, 1], block=[0, 1, 1, 2], bins=[1, 0, 0, 1])
        q = run(**relabeled, scope=[True, False, False, True])
        for k in ('groups', 'coverage', 'below', 'above', 'width_component_pp',
                  'lower_miss_component_pp', 'upper_miss_component_pp', 'original_interval_score_pp'):
            self.assertEqual(r[k], q[k])
        self.check_identity(r)

    def test_empty_scope_preserves_none_and_missing_declared_is_refused(self):
        r = run([0, 1], [0, 0], [1, 1], scope=[False, False])
        self.assertEqual((r['native_rows'], r['groups']), (0, 0))
        for k in ('width_component_pp', 'lower_miss_component_pp',
                  'upper_miss_component_pp', 'original_interval_score_pp',
                  'component_sum_pp', 'rounding_tolerance_pp'):
            self.assertIsNone(r[k])
        with self.assertRaisesRegex(ValueError, 'missing declared endpoints'):
            run([0, 1], [math.nan, 0], [math.nan, 1])

    def driver(self):
        path = str(Path(__file__).with_name('q26-range-score-components-run.py'))
        d = types.ModuleType('q26_accounting_driver_independent_subject'); d.__file__ = path
        exec(compile(Path(path).read_bytes(), path, 'exec'), vars(d))
        return d

    def test_driver_draft_refuses_before_any_sources_or_saved_arrays(self):
        d = self.driver()
        with tempfile.TemporaryDirectory(prefix='q26-accounting-draft-toy-') as tmp:
            root = Path(tmp).resolve(); p = root/'request.json'; out = str(root/'receipt.json')
            p.write_text(json.dumps(dict(schema='q26-weighted-causal-primary-pair-saved-request-v1',
                purpose='fixed_interval_score_accounting', parent_admitted=False, saved_only=True)))
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, 'fixed saved accounting scope'):
                d.run(str(p), sha, out)
            self.assertFalse(Path(out).exists())

    def test_driver_receipt_path_and_executing_source_bind_before_saved_context(self):
        d = self.driver()
        with tempfile.TemporaryDirectory(prefix='q26-accounting-bind-toy-') as tmp:
            root = Path(tmp).resolve(); p = root/'request.json'; out = str(root/'receipt.json')
            r = dict(schema='q26-weighted-causal-primary-pair-saved-request-v1',
                purpose='fixed_interval_score_accounting', parent_admitted=True, saved_only=True,
                policy=d.POLICY, out=out+'-other', pins={})
            def invoke():
                p.write_text(json.dumps(r)); sha=hashlib.sha256(p.read_bytes()).hexdigest()
                return d.run(str(p), sha, out)
            with self.assertRaisesRegex(ValueError, 'fixed bound output/policy'): invoke()
            r['out'] = out; r['pins'] = {'implementation':dict(path='/invented/scientific-source.py',size=0,sha256='0'*64)}
            with self.assertRaisesRegex(ValueError, 'actual implementation'): invoke()
            self.assertFalse(Path(out).exists())


if __name__ == '__main__':
    unittest.main()
