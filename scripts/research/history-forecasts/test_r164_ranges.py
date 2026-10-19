"""Synthetic instrument checks only; no research observations are loaded."""
import unittest
from unittest.mock import patch

import numpy as np

import r164_ranges as ranges


class RangeInstrumentTests(unittest.TestCase):
    def test_cgm_intersections_aggregate_bins(self):
        coverage = np.array([1, 1, 0, 0])
        series_group = np.array([0, 0, 1, 1])
        block = np.array([0, 1, 0, 1])
        self.assertAlmostEqual(ranges.cgm_coverage_variance(coverage, series_group, block), .0625)
        # Duplicating every bin adds observations within existing intersections,
        # not independent clusters; the variance must remain identical.
        for repeats in (2, 3, 7):
            self.assertAlmostEqual(ranges.cgm_coverage_variance(
                np.repeat(coverage, repeats), np.repeat(series_group, repeats),
                np.repeat(block, repeats)), .0625)

    def test_interval_score_uses_nominal(self):
        self.assertAlmostEqual(ranges.interval_score(.2, .4, .5, .8), 1.2)
        self.assertAlmostEqual(ranges.interval_score(.2, .4, .5, .9), 2.2)
        np.testing.assert_allclose(ranges.interval_score(
            np.array([.2, .2]), np.array([.4, .4]), np.array([.3, .5]), .8), [.2, 1.2])

    def test_nominal_is_validated_before_data_load(self):
        for nominal in (0, 1, -.1, 1.1, np.nan, np.inf, -np.inf):
            with self.subTest(nominal=nominal), patch.object(ranges, 'load_rows') as load:
                with self.assertRaisesRegex(ValueError, 'nominal'):
                    ranges.run('unused', 'unused', nominal=nominal)
                load.assert_not_called()

    def test_calibration_endpoints_both_clipped(self):
        lower, upper = ranges.clipped_calibration_range(.9, 1.2, 1.4)
        self.assertEqual((lower, upper), (1., 1.))
        lower, upper = ranges.clipped_calibration_range(
            np.array([.9, .5]), np.array([1.2, -.2]), np.array([1.4, .6]))
        np.testing.assert_allclose(lower, [1., 0.])
        np.testing.assert_allclose(upper, [1., .3])
        self.assertTrue(np.all((0 <= lower) & (lower <= upper) & (upper <= 1)))
        with self.assertRaisesRegex(ValueError, 'reversed'):
            ranges.clipped_calibration_range(.5, .8, .2)

    def test_unavailable_calibration_fold_stays_unavailable(self):
        lower, upper = ranges.clipped_calibration_range(.5, np.nan, np.nan)
        self.assertTrue(np.isnan(lower) and np.isnan(upper))

    def test_perfect_latent_range_does_not_cover_finite_odd_group(self):
        # Exact individual probabilities do not make the realized frequency
        # of three Bernoulli outcomes equal to .5.
        outcomes = np.array([1., 0., 1.])
        latent_probability = .5
        self.assertTrue(ranges.realized_group_coverage(latent_probability, .5, .5))
        self.assertFalse(ranges.realized_group_coverage(outcomes.mean(), .5, .5))

    def test_output_names_realized_targets(self):
        rows = {'cluster': np.array([], dtype=int)}
        with patch.object(ranges, 'load_rows', return_value=(rows, [], {})), \
                patch.object(ranges.M6, 'write_json') as write:
            ranges.run('unused', 'unused', horizons=())
        result = write.call_args.args[1]
        self.assertEqual(result['target'], 'realized_group_frequency')
        self.assertEqual(result['T2_target'], 'pooled_calibration_frequency')


if __name__ == '__main__':
    unittest.main()
