"""Synthetic fixtures only for recovered intraday features and shared engine."""
import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import r164_intraday_review as I
import r164_recursive as R


class IntradayInstrumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.close, cls.high, cls.low, _ = R.syn_series(3500, np.random.default_rng(19), R.syn_params())

    def test_default_windows_match_production_python_engine(self):
        old_si = R.SeriesInputs(self.close, self.high, self.low, 0, steps=(12,))
        new_si = I.Inputs(self.close, self.high, self.low, 0, I.VARIANTS['base12'])
        old, new = R.StepModel(old_si, 12, 2600), I.Model(new_si, 2600)
        np.testing.assert_allclose(old.coef, new.coef, rtol=1e-12, atol=1e-12)
        np.testing.assert_allclose(old.U, new.U, rtol=3e-7, atol=1e-6)
        levels = np.log1p([-.02, -.1, -.25])
        a = R.simulate(old, old_si, 2800, levels, 500, 13, modes=('rec', 'fix'))
        b = I.simulate(new, new_si, 2800, levels, 500, 13)
        for mode in ('rec', 'fix'):
            np.testing.assert_allclose(a[mode], b[mode], atol=1/500, rtol=0)

    def test_prefix_causality_and_pool_geometry(self):
        full = I.Inputs(self.close, self.high, self.low, 0, I.VARIANTS['h3'])
        prefix = I.Inputs(self.close[:2800], self.high[:2800], self.low[:2800], 0, I.VARIANTS['h3'])
        a, b = I.Model(full, 2600), I.Model(prefix, 2600)
        np.testing.assert_array_equal(a.coef, b.coef)
        np.testing.assert_array_equal(a.U, b.U)
        levels = np.log1p([-.05, -.2])
        x = I.simulate(a, full, 2800, levels, 50, 2)
        y = I.simulate(b, prefix, 2800, levels, 50, 2)
        for mode in ('rec', 'fix'):
            np.testing.assert_array_equal(x[mode], y[mode])
        self.assertTrue(np.all(a.U[:, :, 2] <= a.U[:, :, 0]))
        self.assertTrue(np.all(a.U[:, :, 0] <= a.U[:, :, 1]))
        # Entire ordered bars are carried into one pool, never shuffled by field.
        pool = np.flatnonzero((np.arange(full.N + 1) <= 2588) & full.okX & full.okb)
        scale = np.exp(np.column_stack((np.ones(len(pool)), full.LX[pool])) @ a.coef) / R.SQA
        np.testing.assert_array_equal(a.U, (full.blk[pool] / scale[:, None, None]).astype(np.float32))

    def test_nan_features_and_insufficient_training_are_unavailable(self):
        missing = np.full(2500, np.nan)
        with np.errstate(invalid='ignore', divide='ignore'):
            si = I.Inputs(missing, missing, missing, 0, I.VARIANTS['h1'])
            model = I.Model(si, 2200)
            self.assertFalse(model.ok)
            self.assertIsNone(I.simulate(model, si, 2300, [-.1], 10, 2))
        with self.assertRaises(ValueError):
            I.Inputs(self.close, self.high, self.low, 0, [721])
        with self.assertRaises(ValueError):
            I.simulate(model, si, 2300, [-.1], 0, 2)

    def test_real_rejects_changed_runtime_before_input_build(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = dict(complete=True, signature='old', config=dict(pin=R.BLIND5_COMMIT,
                paths=1000, origin_every=28, sources={}, runtime={'changed': True}))
            (Path(directory) / 'manifest.json').write_text(json.dumps(prior))
            with patch.object(R.M6, 'build_blind_dir') as build:
                with self.assertRaisesRegex(ValueError, 'runtime identity changed'):
                    I.real('unused', directory, str(Path(directory) / 'output'))
                build.assert_not_called()

    def test_synthetic_fixture_preserves_published_support_truth(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic.csv'
            with path.open('w') as stream:
                writer = csv.writer(stream)
                writer.writerow(['series','i0','T','k','y','p_true','p_fH','p_rec12'])
                writer.writerow([0,2800,72,7,1,.12345,.2,.15])
            with patch.object(R, 'syn_series', return_value=(self.close, self.high, self.low, None)), \
                    patch('r164_step_review.quarter_start_index', return_value=2600):
                result = I.synthetic(path, n_series=1, n_orig=1, paths=10)
            self.assertEqual(result['support'], {0:[2800]})
            self.assertEqual(result['rows'][0]['p_true'], .12345)
            self.assertEqual(result['rows'][0]['p_fH'], .2)
            self.assertEqual(set(result['variants']), {'base12','h12','h3','h1'})
            self.assertTrue(all(result['rows'][0]['p_'+name+'_'+mode] is not None
                                for name in result['variants'] for mode in ('rec','fix')))


if __name__ == '__main__':
    unittest.main()
