"""Synthetic fixtures only: scoring/checkpoint policy; no market collections."""
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import r164_step_real_review as S


class RealReviewInstrumentTests(unittest.TestCase):
    def rows(self, different=False):
        rows = []
        for cluster in ('a', 'b'):
            for block in (0, 1):
                for y in (0., 1.):
                    rows.append(dict(series=cluster, cluster=cluster, block182=block,
                        i0=block * 100 + int(y), T=72, k=7, y=y,
                        p_fH=.5, p_rec12=.5, p_base12=.5, p_garch=y if different else .5))
        return rows

    def test_zero_paired_difference_and_known_bss(self):
        same = S.summarize(self.rows(), bootstrap=50)
        for item in same['summaries']:
            self.assertEqual(item['paired_vs_fH']['garch']['delta'], 0)
            self.assertEqual(item['paired_vs_fH']['garch']['delta_ci90'], [0, 0])
            self.assertEqual(item['models']['garch']['BSS_vs_fH'], 0)
        better = S.summarize(self.rows(different=True), bootstrap=50)
        for item in better['summaries']:
            self.assertEqual(item['bss_denominator_stored_fH'], .25)
            self.assertEqual(item['models']['garch']['BSS_vs_fH'], 1)
            self.assertEqual(item['paired_vs_fH']['garch']['delta'], -.25)
            self.assertEqual(item['models']['garch']['R'], 1)

    def test_missing_predictions_use_same_pair_support(self):
        rows = self.rows()
        rows[0]['p_garch'] = None
        rows[1]['p_fH'] = np.nan
        rows[2]['y'] = None
        rows[3]['p_rec12'] = 1.1
        report = S.summarize(rows, bootstrap=20)
        self.assertEqual(report['paired_rows'], 4)
        self.assertEqual(report['censored_pairs'], 4)
        for item in report['summaries']:
            self.assertEqual(item['n_rows'], 4)
        json.dumps(report, allow_nan=False)

    def test_bootstrap_is_deterministic_and_uses_series_block_weights(self):
        rows = self.rows(different=True)
        rows[0]['p_garch'] = .9
        first = S.summarize(rows, bootstrap=100, seed=0)
        second = S.summarize(rows, bootstrap=100, seed=0)
        self.assertEqual(first, second)
        item = first['summaries'][0]
        self.assertEqual(item['n_clusters'], 2)
        self.assertEqual(item['n_blocks'], 2)
        self.assertGreater(item['paired_vs_fH']['garch']['bootstrap_sd'], 0)
        self.assertLess(item['paired_vs_fH']['garch']['z'], 0)

    def test_atomic_checkpoint_serialization_and_resume_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'checkpoint.json'
            self.assertIsNone(S.read_checkpoint(target, 'new'))
            value = dict(signature='new', complete=True, result={'rows': [{'p_garch': None}]})
            S.atomic_json(target, value)
            self.assertEqual(S.read_checkpoint(target, 'new'), value)
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                S.read_checkpoint(target, 'changed-input')
            S.atomic_json(target, dict(signature='new', complete=False))
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                S.read_checkpoint(target, 'new')
            self.assertFalse(list(Path(directory).glob('*.tmp')))

    def test_config_signature_tracks_source_input_and_plan(self):
        original = {'sources': {'engine': 'abc'}, 'inputs': {'a': 'def'}, 'runtime': {'numpy': '2'}, 'paths': 1000}
        self.assertEqual(S.signature(original), S.signature(dict(reversed(list(original.items())))))
        for changed in ({'sources': {'engine': 'different'}}, {'inputs': {'a': 'different'}}, {'runtime': {'numpy': 'changed'}}, {'paths': 2000}):
            self.assertNotEqual(S.signature(original), S.signature(original | changed))

    def test_baseline_instrument_gate_precedes_garch(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'rows.npz'
            key = 'blind5:fixture'
            np.savez(target, name=key, base_ts=0, t0_i=[0], T_h=[72], k_i=[7],
                     y=[1], p_fH=[.5], p_rec12=[.5], levels=np.linspace(-.02, -.4, 10))
            ser = SimpleNamespace(base_ts=0, close=np.ones(1), high=np.ones(1),
                                  low=np.ones(1), start_i=0)
            with patch.object(S.R, 'SeriesInputs'), patch.object(S.R, 'StepModel'), \
                    patch.object(S.R, 'simulate_fast', return_value={'rec': np.full((4, 10), .502)}), \
                    patch.object(S.G, 'asof_state') as fit:
                with self.assertRaisesRegex(ValueError, 'baseline instrument mismatch'):
                    S.series_review(key, ser, [{'qs_i': 0, 'qe_i': 1}], target)
                fit.assert_not_called()
            with patch.object(S.R, 'SeriesInputs'), patch.object(S.R, 'StepModel'), \
                    patch.object(S.R, 'simulate_fast', return_value={'rec': np.full((4, 10), np.nan)}), \
                    patch.object(S.G, 'asof_state') as fit:
                with self.assertRaisesRegex(ValueError, 'nonfinite rebuilt'):
                    S.series_review(key, ser, [{'qs_i': 0, 'qe_i': 1}], target)
                fit.assert_not_called()
            with patch.object(S.R, 'SeriesInputs'), patch.object(S.R, 'StepModel'), \
                    patch.object(S.R, 'simulate_fast', return_value=None):
                missing = S.series_review(key, ser, [{'qs_i': 0, 'qe_i': 1}], target)
                self.assertEqual(missing['censored_origins'], [dict(i0=0, reason='no_HAR_prediction', stored_rows=1)])

    def test_invalid_plan_stops_before_any_input_build(self):
        with patch.object(S.R.M6, 'build_blind_dir') as build:
            for kwargs in ({'paths': 2000}, {'origin_every': 7}, {'workers': 2}, {'bootstrap': 0}):
                with self.assertRaises(ValueError):
                    S.run('unused', 'unused', **kwargs)
            build.assert_not_called()


if __name__ == '__main__':
    unittest.main()
