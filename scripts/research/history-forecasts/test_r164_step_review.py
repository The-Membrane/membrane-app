"""Synthetic known-answer and causality tests; no dataset reads."""
import unittest
import csv
from pathlib import Path
import tempfile
from unittest.mock import patch
import numpy as np
import r164_step_review as S
import r164_recursive as R


class HourlyReviewerTests(unittest.TestCase):
    def setUp(self):
        self.p = R.syn_params()
        self.model = S.GJR(self.p['w'], self.p['alpha'], self.p['gamma'], self.p['beta'])

    def test_same_engine_exact_law_matches_existing_known_answer(self):
        levels = np.log1p(np.array([-.02, -.1, -.25]))
        expected = R.syn_true(self.p['h_bar'], levels, 500, np.random.default_rng(42), self.p, Ts=(24, 72))
        actual = S.simulate_hourly(self.model, self.p['h_bar'], levels, (24, 72), 500, 42,
                                   exact_innovations=self.p)
        np.testing.assert_array_equal(actual, expected)

    def test_one_pair_recursion_and_fixed_ablation(self):
        # h starts at 1; r=-1 => low=-1, next h=.1+.2+.1+.3=.7.
        model = S.GJR(.1, .2, .1, .3)
        levels = np.array([-1.5, -2.])
        recursive = S.simulate_hourly(model, 1., levels, (1, 2), 3, 0, pool=np.array([[-1., -1.]]))
        fixed = S.simulate_hourly(model, 1., levels, (1, 2), 3, 0,
                                  pool=np.array([[-1., -1.]]), fixed_scale=True)
        np.testing.assert_array_equal(recursive, [[0, 0], [1, 0]])
        np.testing.assert_array_equal(fixed, [[0, 0], [1, 1]])

    def test_missing_return_expected_update(self):
        h = S.filter_variance([np.nan, -.1], self.model, .2)
        expected = self.model.w + self.model.persistence * .2
        self.assertAlmostEqual(h[1], expected)
        self.assertAlmostEqual(h[2], S.update(expected, -.1, self.model))

    def test_asof_state_ignores_future_suffix_and_pool_ignores_current_quarter(self):
        close, _, low, _ = R.syn_series(2600, np.random.default_rng(31), self.p)
        quarter, origin = 2200, 2400
        full = S.asof_state(close, low, origin, quarter)
        prefix = S.asof_state(close[:origin], low[:origin], origin, quarter)
        altered_close, altered_low = close.copy(), low.copy()
        altered_close[origin:] = np.nan
        altered_low[origin:] = 1e100
        altered = S.asof_state(altered_close, altered_low, origin, quarter)
        for comparison in (prefix, altered):
            self.assertEqual(full[0], comparison[0])
            self.assertEqual(full[1], comparison[1])
            np.testing.assert_array_equal(full[2], comparison[2])
        # Changing observed current-quarter bars may change h_origin but cannot
        # change the quarterly fit or the prequarter residual pool.
        altered_close[quarter:origin] *= 1.001
        changed = S.asof_state(altered_close, low, origin, quarter)
        self.assertEqual(full[0], changed[0])
        np.testing.assert_array_equal(full[2], changed[2])
        self.assertTrue(np.all(full[2][:, 1] <= np.minimum(full[2][:, 0], 0)))

    def test_quarter_fit_cache_preserves_causal_state(self):
        close, _, low, _ = R.syn_series(2600, np.random.default_rng(31), self.p)
        cache = {}
        with patch.object(S, 'fit_gjr', wraps=S.fit_gjr) as fit:
            S.asof_state(close, low, 2300, 2200, cache=cache)
            cached = S.asof_state(close[:2400], low[:2400], 2400, 2200, cache=cache)
            self.assertEqual(fit.call_count, 1)
        direct = S.asof_state(close, low, 2400, 2200)
        self.assertEqual(cached[0], direct[0])
        self.assertAlmostEqual(cached[1], direct[1], places=15)
        np.testing.assert_array_equal(cached[2], direct[2])

    def test_true_empirical_pool_preserves_original_pairs(self):
        close, _, low, h = R.syn_series(1300, np.random.default_rng(31), self.p)
        pool = S.true_residual_pool(close, low, h, 1200)
        expected = np.column_stack((np.log(close[1:1200] / close[:1199]),
                                    np.log(low[1:1200] / close[:1199]))) / np.sqrt(h[1:1200, None])
        np.testing.assert_array_equal(pool, expected)
        altered_c, altered_l = close.copy(), low.copy()
        altered_c[1200:], altered_l[1200:] = 1e20, 1e-20
        np.testing.assert_array_equal(S.true_residual_pool(altered_c, altered_l, h, 1200), pool)

    def test_harness_preserves_published_truth_with_optional_recheck(self):
        fields = ['series', 'i0', 'T', 'k', 'y', 'p_true', 'p_fH', 'p_rec12']
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / 'synthetic.csv'
            with baseline.open('w') as stream:
                writer = csv.writer(stream)
                writer.writerow(fields)
                writer.writerow([0, 2400, 24, 0, 1, .12345, .2, .15])
            with patch.object(S, 'quarter_start_index', return_value=2200):
                for recheck_paths in (0, 5):
                    result = S.run_synthetic(baseline, n_hours=2500, n_orig=1,
                                             n_paths=5, n_true=recheck_paths)
                    row = result['rows'][0]
                    self.assertEqual(row['p_true'], .12345)
                    self.assertEqual(row['published_p_true'], .12345)
                    self.assertEqual(row['p_fH'], .2)
                    self.assertEqual(result['selected_origins'], {0: [2400]})
                    self.assertEqual(result['n_selected_origins'], 1)
                    self.assertEqual(result['quarter_fit_counts'], {0: 1})
                    self.assertEqual(result['band_summaries'][0]['metrics']['fH']['R'], .2 / .12345)
                    self.assertEqual(row['p_true_recheck'] is None, recheck_paths == 0)

    def test_quarter_index_is_calendar_not_fixed_days(self):
        base = R.A.quarter_start(2020, 1)
        self.assertEqual(S.quarter_start_index(base, 24 * 100), 24 * 91)

    def test_fit_rejects_insufficient_or_zero_variance(self):
        for returns in (np.ones(1999), np.zeros(2200), np.full(2200, np.nan)):
            with self.assertRaises(ValueError):
                S.fit_gjr(returns)

    def test_invalid_simulation_inputs(self):
        kwargs = dict(model=self.model, h0=.1, levels=[-.1], horizons=(1,),
                      n_paths=10, seed=2, pool=np.array([[0., -.1]]))
        for replacement in ({'n_paths': 0}, {'h0': 0}, {'h0': np.nan}, {'levels': [0]},
                            {'horizons': ()}, {'horizons': (1.2,)}, {'pool': np.empty((0, 2))},
                            {'pool': np.array([[-1., -.2]])}, {'pool': None}):
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                S.simulate_hourly(**(kwargs | replacement))
        with self.assertRaises(ValueError):
            S.GJR(.1, .5, 0, .5)
        with self.assertRaises(ValueError):
            S.filter_variance([0], self.model, 0)


if __name__ == '__main__':
    unittest.main()
