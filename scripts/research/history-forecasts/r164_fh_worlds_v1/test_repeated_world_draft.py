"""Bounded UNIT fixtures only: never use the registered 64-world seed set."""
import copy
import json
import unittest
import numpy as np
from repeated_world_draft import HERE, H, FixedWeights, build_world, package


class DraftUnits(unittest.TestCase):
    def spec(self):
        s = json.loads((HERE / 'repeated-world-spec.json').read_text())
        # Outside both registered ranges; this is an explicit unit fixture.
        s['world_seed_base'] = 991001
        s['bootstrap_seed_base'] = 992001
        return s

    def test_analytic_truth_and_depth_independent_of_regression_noise(self):
        s = self.spec()
        noisy, _, _, truth, _, _ = build_world(s, 0)
        noiseless_spec = copy.deepcopy(s)
        noiseless_spec['shock_component_sd'] = 0
        noiseless, _, _, truth0, _, _ = build_world(noiseless_spec, 0)
        expected = np.exp(np.log1p(s['levels'])[None, :] /
                          (np.exp(H @ np.array(s['beta']))[:, None] * s['scale']))
        np.testing.assert_array_equal(truth, expected)
        np.testing.assert_array_equal(truth, truth0)
        np.testing.assert_array_equal(noisy.P.depth, noiseless.P.depth)
        self.assertGreater(np.max(np.abs(noisy.lfut - noiseless.lfut)), 0)
        self.assertTrue(np.all(np.diff(truth, axis=1) < 0))
        self.assertAlmostEqual(s['beta'][0], np.log(.08))

    def test_scale_enters_depth_threshold_and_truth(self):
        s = self.spec()
        p, _, _, truth, _, _ = build_world(s, 0)
        doubled = copy.deepcopy(s)
        doubled['scale'] *= 2
        p2, _, _, truth2, _, _ = build_world(doubled, 0)
        np.testing.assert_array_equal(p2.P.depth, 2 * p.P.depth)
        np.testing.assert_array_equal(p2.P.thresholds(np.ones(4)), p.P.thresholds(np.ones(4)) / 2)
        np.testing.assert_allclose(truth2 ** 2, truth, rtol=1e-14, atol=0)
        np.testing.assert_array_equal(p.P.barriers, np.log1p([-.02, -.10, -.20]))

    def test_paired_weight_prefix_without_subject_calls(self):
        weights = np.random.Generator(np.random.PCG64(992001)).multinomial(
            32, np.full(32, 1 / 32), size=200)
        small, large = FixedWeights(weights[:20]), FixedWeights(weights)
        for _ in range(20):
            np.testing.assert_array_equal(small.multinomial(32, np.full(32, 1 / 32)),
                                          large.multinomial(32, np.full(32, 1 / 32)))
        self.assertTrue(np.all(weights.sum(axis=1) == 32))
        self.assertEqual(small.calls, 20)
        self.assertEqual(large.calls, 20)

    def test_exact_caller_packaging_scope_and_no_input_mutation(self):
        raw = np.array([[[.8, .9, .1], [.7, .4, .2]],
                        [[.6, .3, .5], [.5, np.nan, .1]],
                        [[.9, .7, .3], [.6, .2, .1]]])
        original = raw.copy()
        quantiles = [.05, .25, .5, .75, .95]
        q, sd = package(raw, quantiles)
        caller_arr = np.minimum.accumulate(raw, axis=-1)
        np.testing.assert_array_equal(q, np.nanquantile(caller_arr, quantiles, axis=0))
        np.testing.assert_array_equal(sd, np.nanstd(caller_arr, axis=0))
        np.testing.assert_array_equal(raw, original)
        self.assertEqual(q.shape, (5, 2, 3))
        self.assertTrue(np.isnan(caller_arr[1, 1, 2]))  # Original propagation retained.


if __name__ == '__main__':
    unittest.main(verbosity=2)
