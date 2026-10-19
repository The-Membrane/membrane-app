"""Instrument checks for report-only range noise review; no real rows needed."""
import unittest
import numpy as np
import r164_range_noise_review as R


class RangeNoiseReviewTests(unittest.TestCase):
    def test_centered_constant_residual_is_zero(self):
        a = np.repeat(np.arange(3), 4)
        b = np.tile(np.arange(4), 3)
        self.assertAlmostEqual(R.cgm_variance(np.full(12, .1), a, b), 0., places=15)
        self.assertGreater(R.cgm_variance(np.full(12, .1), a, b, False), 0.)

    def test_single_axis_cluster_unavailable(self):
        r = np.array([1., -1., 2., -2.])
        one = np.zeros(4, dtype=int)
        many = np.arange(4)
        self.assertTrue(np.isnan(R.cgm_variance(r, one, many)))
        self.assertTrue(np.isnan(R.cgm_variance(r, many, one)))
        self.assertTrue(np.isfinite(R.cgm_variance(r, one, many, False)))

    def test_known_two_way_cluster_formula(self):
        r = np.array([1., -1., 2., -2.])
        a = np.array([0, 0, 1, 1])
        b = np.array([0, 1, 0, 1])
        expected = (0**2+0**2+3**2+(-3)**2-(1+1+4+4))/16
        self.assertAlmostEqual(R.cgm_variance(r, a, b), expected)

    def test_independent_variance_and_bounds(self):
        self.assertAlmostEqual(R.independent_variance(np.full(101, .5)), .25/101)
        lower, upper = R.compatibility_bounds(.01, .99, .01)
        self.assertEqual((lower, upper), (0., 1.))
        self.assertTrue(np.isnan(R.compatibility_bounds(.1, .2, -.01)[0]))
        self.assertTrue(np.isnan(R.compatibility_bounds(np.nan, np.nan, .01)[0]))
        self.assertTrue(np.isnan(R.compatibility_bounds(.1, np.nan, .01)[0]))
        self.assertEqual(R.compatibility_bounds(.1, .2, 0), (.1, .2))

    def test_fold_excludes_held_sg_AND_block(self):
        keys = np.array([[0, s, b] for s in range(5) for b in range(5)])
        gid = np.repeat(np.arange(25), 3)
        p = np.full(75, .2)
        y = np.linspace(0., 1., 75)
        changed = y.copy()
        excluded = (keys[gid, 1] == 0) | (keys[gid, 2] == 0)
        changed[excluded] = 1-changed[excluded]
        hold = (keys[gid, 1] == 0) & (keys[gid, 2] == 0)
        for equal in (False, True):
            before = R.cal_intervals(p, y, gid, keys, equal)
            after = R.cal_intervals(p, changed, gid, keys, equal)
            for old, new in zip(before, after):
                np.testing.assert_array_equal(old[hold], new[hold])

    def test_constant_coverage_bootstrap(self):
        keys = np.array([[bin_, s, b] for bin_ in range(2) for s in range(5) for b in range(4)])
        result = R.coverage_power_sensitivity(np.ones(len(keys)), keys, np.full(100, .05))
        self.assertEqual(result['coverage_groups'], 1.)
        self.assertEqual(result['coverage_bootstrap_sd'], 0.)
        self.assertEqual(result['coverage_bootstrap_ci90'], [1., 1.])
        self.assertEqual(result['valid_replicates'], 2000)
        self.assertEqual(result['normal_TOST_power_nominal90_tol5pp'], 0.)
        self.assertEqual(result['deterministic_width_le10pts_indicator'], 1)

    def test_synthetic_known_latent_and_day_dependence(self):
        s = R.synthetic()
        odd = s['odd_n_correct_latent_p']
        self.assertEqual(odd['realized_frequency_point_interval_coverage'], 0)
        self.assertAlmostEqual(odd['normal_widened_exact_frequency_coverage'], .8890816503393596)
        iid, day = s['noise_controls']['IID'], s['noise_controls']['common_day']
        self.assertGreater(day['empirical_mean_variance']/iid['empirical_mean_variance'], 15)
        for case in (iid, day):
            self.assertLess(abs(case['mean_centered_cgm_variance']/case['known_mean_variance']-1), .12)
        gate = s['exploratory_gate_contrast']['0.99']
        self.assertGreater(gate['minimum_90_coverage_power_at_se01'], .999)
        self.assertLess(gate['TOST_90_plusminus5pp_power_at_se01'], .0001)


if __name__ == '__main__':
    unittest.main()
