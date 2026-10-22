"""Staged independent synthetic checks. No market inputs or automatic execution."""
import types
import unittest
from fractions import Fraction
from pathlib import Path

import numpy as np


SOURCE = Path(__file__).with_name('q26-weighted-causal-primary-pair.py')
M = types.ModuleType('weighted_causal_independent_subject')
M.__file__ = str(SOURCE)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), vars(M))


def panel():
    # Calendar holes and absent SG4 are intentional, not compressed away.
    rows = []
    for block in (0, 2, 5, 8):
        for sg in (0, 1, 2, 3):
            for j in range(10):
                rows.append((.025 + .065*j + .002*sg,
                             int((j + sg + block) % 3 == 0),
                             sg, M.ORIGIN + 182*block + 10 + j))
    a = np.asarray(rows)
    return dict(p=a[:, 0], y=a[:, 1], sg=a[:, 2].astype(np.int64),
                day=a[:, 3].astype(np.int64))


class IndependentChecks(unittest.TestCase):
    def test_future_predictions_do_not_change_earlier_forward_fits_or_bounds(self):
        original = panel()
        changed = {k: v.copy() for k, v in original.items()}
        future = changed['day'] >= M.ORIGIN + 182*8
        changed['p'][future] = .995
        for horizon, level in ((24, 5), (72, 7)):
            a = M.cell(**original, horizon=horizon, level_index=level)
            b = M.cell(**changed, horizon=horizon, level_index=level)
            old = {(f['sg'], f['block']): f for f in a['folds']}
            new = {(f['sg'], f['block']): f for f in b['folds']}
            checked_populated = 0
            for key, fold in old.items():
                if key[1] <= 5:
                    self.assertEqual(fold['edges'], new[key]['edges'])
                    self.assertEqual(fold['arms']['F'], new[key]['arms']['F'])
                    checked_populated += fold['arms']['F']['available']
            self.assertGreater(checked_populated, 0)
            earlier = original['day'] < M.ORIGIN + 182*8
            for endpoint in (0, 1):
                np.testing.assert_array_equal(
                    a['private_arrays']['bounds']['F'][endpoint][earlier],
                    b['private_arrays']['bounds']['F'][endpoint][earlier])
            # The mutation is substantial enough to alter the retrospective bins.
            self.assertFalse(np.array_equal(
                a['private_arrays']['original_bins'],
                b['private_arrays']['original_bins']))

    def test_raw_calendar_ids_and_missing_series_group_are_retained(self):
        data = panel()
        result = M.cell(**data, horizon=72, level_index=7)
        self.assertEqual(set(result['private_arrays']['block'].tolist()), {0, 2, 5, 8})
        for fold in result['folds']:
            start = M.ORIGIN + 182*fold['block']
            expected = (data['sg'] != fold['sg']) & (data['day'] + 3 < start)
            self.assertEqual(fold['block_start_day'], start)
            self.assertEqual(fold['past_rows'], int(expected.sum()))
            if expected.any():
                self.assertEqual(fold['max_past_label_day'], int((data['day'][expected] + 3).max()))
                self.assertLess(fold['max_past_label_day'], start)
        second = next(f for f in result['folds'] if f['block'] == 2 and f['sg'] == 0)
        self.assertEqual(second['block_start_day'], M.ORIGIN + 364)
        empty = next(v for v in result['views'] if v['view'] == 'SG4')
        for arm in M.ARMS:
            metric = empty['arms'][arm]
            self.assertEqual((metric['native_rows'], metric['available_rows'], metric['groups']), (0, 0, 0))
            self.assertIsNone(metric['coverage'])
            self.assertIsNone(metric['interval_score_pp'])
        for pair in empty['pairs'].values():
            self.assertEqual(pair['comparable_rows'], 0)

    def test_native_group_metrics_match_hand_rational_example(self):
        # Two unequal groups: frequency 1/2 inside [.4,.6], frequency 2/3 above [.1,.3].
        # Equal-group coverage=1/2; median row width=20pp; nominal-.9 score
        # mean = 1/5 + (20 * (2/3 - 3/10))/2 = 58/15, or 1160/3 pp.
        p = np.full(5, .25)
        y = np.array([0., 1., 1., 1., 0.])
        sg = np.zeros(5, np.int64)
        block = np.full(5, 5, np.int64)
        bins = np.array([0, 0, 1, 1, 1], np.int64)
        lower = np.array([.4, .4, .1, .1, .1])
        upper = np.array([.6, .6, .3, .3, .3])
        scope = np.ones(5, bool)
        result = M._metric(p, y, sg, block, bins, lower, upper, scope)
        self.assertEqual((result['native_rows'], result['available_rows'], result['groups']), (5, 5, 2))
        self.assertEqual(result['coverage'], .5)
        self.assertEqual((result['below'], result['above']), (0, 1))
        self.assertAlmostEqual(result['row_median_width_pp'], 20., places=11)
        self.assertAlmostEqual(result['interval_score_pp'], float(Fraction(1160, 3)), places=10)


if __name__ == '__main__':
    unittest.main()
