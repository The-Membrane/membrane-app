"""Synthetic-only independent-check qualification; no optimizer imports/calls."""
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

import r164_reconstituted_state_check as C


def literal_filter(returns, model, initial):
    w, a, g, b = [model[k] for k in ('w', 'alpha', 'gamma', 'beta')]
    values = [initial]
    for raw in returns:
        r = float(raw)
        previous = values[-1]
        if math.isfinite(r):
            values.append(w + ((a + g * (r < 0)) * r * r + b * previous))
        else:
            values.append(w + (a + .5 * g + b) * previous)
    return np.array(values)


def literal_objective_filter(returns, model, initial):
    w, a, g, b = [model[k] for k in ('w', 'alpha', 'gamma', 'beta')]
    values = [initial]
    for raw in returns:
        r = float(raw)
        previous = values[-1]
        if math.isfinite(r):
            values.append(w + (a + g * (r < 0)) * r * r + b * previous)
        else:
            values.append(w + (a + .5 * g + b) * previous)
    return np.array(values)


def saved_horizons(model, h0, moments):
    # Serialization fixture from high-precision reference; corruption tests
    # exercise the independent log, ordinary and null representations separately.
    truth = C.decimal_moments(model, h0, moments)
    largest = Decimal.from_float(float(np.finfo(float).max))
    out = {}
    for horizon, fields in truth.items():
        out[horizon] = {k: None if v > largest else float(v) for k, (v, _) in fields.items()}
        out[horizon]['log10'] = {k: float(log) for k, (_, log) in fields.items()}
        out[horizon]['nonrepresentable_float64'] = [k for k, (v, _) in fields.items() if v > largest]
    return out


def series_fixture():
    q, origins = 2200, [2220, 2250]
    clock = np.arange(2300)
    close = 100 * np.exp(.01 * np.sin(clock / 7) + .002 * np.cos(clock / 3))
    low = close * .995
    close[100] = np.nan  # two missing returns exercise nominal updates
    low[110] = close[109] * 1.5  # original invalid paired geometry is excluded
    returns = np.full(max(origins), np.nan)
    wick = np.full(max(origins), np.nan)
    for i in range(1, max(origins)):
        if close[i] > 0 and close[i - 1] > 0:
            returns[i] = np.log(close[i] / close[i - 1])
        if low[i] > 0 and close[i - 1] > 0:
            wick[i] = np.log(low[i] / close[i - 1])
    training = returns[1:q]
    variance = float(np.var(training[np.isfinite(training)]))
    a, g, b = .1, .08, .7
    model = dict(w=variance * (1 - a - .5 * g - b), alpha=a, gamma=g, beta=b)
    h = literal_filter(returns, model, variance)
    pairs = []
    for i in range(1, q):
        z, k = returns[i] / math.sqrt(h[i]), wick[i] / math.sqrt(h[i])
        if math.isfinite(z) and math.isfinite(k) and k <= max(z, 0) + 1e-12:
            pairs.append((z, min(k, min(z, 0))))
    payload = struct.pack('<' + 'd' * (2 * len(pairs)), *(x for pair in pairs for x in pair))
    descriptor = dict(stored=False, sha256=hashlib.sha256(payload).hexdigest(), shape=[len(pairs), 2],
        dtype='<f8', order='C', hash_encoding='raw contiguous little-endian float64 payload; no header')
    z = np.array([p[0] for p in pairs]); square = z * z
    multiplier = b + (a + g * (z < 0)) * square
    moments = dict(z_mean=float(np.mean(z)), z2=float(np.mean(square)),
        z2_negative=float(np.mean(square * (z < 0))), z4=float(np.mean(square * square)),
        rho_emp=float(np.mean(multiplier)), mean_A2=float(np.mean(multiplier * multiplier)),
        rho_nominal=a + .5 * g + b, pool_pairs=len(pairs))
    moments.update(empirical_mean_stationary=moments['rho_emp'] < 1,
        empirical_h_second_moment_stationary=moments['mean_A2'] < 1)
    objective_model = dict(model, w=variance * (1 - (a + .5 * g + b)))
    objective_h = literal_objective_filter(training, objective_model, variance)
    components = [math.log(float(objective_h[i])) + float(r) * float(r) / float(objective_h[i])
                  for i, r in enumerate(training) if math.isfinite(r)]
    objective = .5 * math.fsum(components)
    def diagnostic(origin):
        return dict(optimizer_success=False, objective=objective,
            finite_training_returns=int(np.isfinite(training).sum()), pool_pairs=len(pairs),
            training_end_exclusive=q, state_end_exclusive=origin)
    quarter = dict(quarter=q, model=model, moments=moments, diagnostics=diagnostic(min(origins)),
        pool=descriptor, training_variance=variance, filter_initial_variance=variance,
        training_start_inclusive=1,
        reconstruction='reconstruct_pool(pinned_close,pinned_low,quarter,GJR(**model),training_variance)',
        reconstruction_verified_exact=True, quarter_h=float(h[q]))
    states = [dict(origin=o, quarter=q, h0=float(h[o]), diagnostics=diagnostic(o),
                   horizons=saved_horizons(model, float(h[o]), moments)) for o in origins]
    key = 'blind5:binance-SYNTHUSDT'
    saved = dict(complete=True, series=key, quarters=[quarter], origins=states)
    old = dict(quarter_fits=1, rows=[dict(i0=o, p_garch=.1) for o in origins for _ in range(2)])
    folds = [dict(qs_i=q, qe_i=2300)]
    return key, saved, old, close, low, folds


class IndependentStateCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = series_fixture()

    def test_numba_literal_operation_order_and_missing_update(self):
        model = dict(w=1., alpha=.1, gamma=.2, beta=.5)
        returns = np.array([2., -1., np.nan, 0., np.inf, -.25])
        result = C.filter_fixed(returns, 1., .1, .2, .5, 4.)
        self.assertTrue(np.array_equal(result, literal_filter(returns, model, 4.)))
        self.assertEqual(result[1], 1 + .1 * 2 * 2 + .5 * 4)

    def test_objective_left_associative_update_differs_from_state_filter(self):
        model = dict(w=1., alpha=.25, gamma=.1, beta=.5)
        returns = np.array([2., np.nan, -2., 0.])
        result = C.objective_filter(returns, 1., .25, .1, .5, 2e16)
        literal = literal_objective_filter(returns, model, 2e16)
        self.assertTrue(np.array_equal(result, literal))
        self.assertEqual(result[1], 10000000000000002.)
        grouped = C.filter_fixed(returns, 1., .25, .1, .5, 2e16)
        self.assertEqual(grouped[1], 10000000000000000.)
        self.assertNotEqual(result[1], grouped[1])

    def test_literal_discrete_moment_enumeration(self):
        # Equiprobable multipliers .5, 1.5 give rho=1, E[A^2]=1.25.
        model = dict(w=.125, alpha=.1, gamma=.2, beta=.3)
        values = C.decimal_moments(model, .5, dict(rho_emp=1., mean_A2=1.25), horizons=(1, 2))
        self.assertEqual(values['1']['expected_terminal_h'][0], Decimal('.625'))
        self.assertEqual(values['1']['expected_terminal_h2'][0], Decimal('.453125'))
        self.assertEqual(values['2']['expected_sum_h'][0], Decimal('1.125'))
        self.assertEqual(values['2']['expected_terminal_h'][0], Decimal('.750'))
        self.assertEqual(values['2']['expected_terminal_h2'][0], Decimal('.73828125'))

    def test_full_series_literal_pool_and_fixed_state_acceptance(self):
        result = C.check_series(*self.fixture)
        self.assertEqual((result['quarters'], result['origins'], result['historical_rows']), (1, 2, 4))
        # False optimizer status is retained; acceptance never certifies convergence.
        self.assertIs(self.fixture[1]['quarters'][0]['diagnostics']['optimizer_success'], False)

    def refuse(self, mutate):
        data = list(deepcopy(self.fixture))
        mutate(data)
        with self.assertRaises(ValueError):
            C.check_series(*data)

    def test_pool_hash_corruption(self):
        self.refuse(lambda d: d[1]['quarters'][0]['pool'].update(sha256='0' * 64))

    def test_training_variance_corruption(self):
        self.refuse(lambda d: d[1]['quarters'][0].update(training_variance=.5))

    def test_quarter_state_corruption(self):
        self.refuse(lambda d: d[1]['quarters'][0].update(quarter_h=.5))

    def test_origin_state_corruption(self):
        self.refuse(lambda d: d[1]['origins'][0].update(h0=.5))

    def test_objective_tolerance_refuses_material_corruption(self):
        self.refuse(lambda d: d[1]['origins'][0]['diagnostics'].update(objective=1e10))

    def test_diagnostic_boolean_and_count_corruption(self):
        self.refuse(lambda d: d[1]['origins'][0]['diagnostics'].update(optimizer_success=1))
        self.refuse(lambda d: d[1]['origins'][0]['diagnostics'].update(pool_pairs=2))

    def test_support_duplicate_missing_and_wrong_quarter(self):
        self.refuse(lambda d: d[1]['origins'].append(deepcopy(d[1]['origins'][0])))
        self.refuse(lambda d: d[1]['origins'].pop())
        self.refuse(lambda d: d[1]['origins'][0].update(quarter=2201))

    def test_pool_moment_and_stationarity_flag_corruption(self):
        self.refuse(lambda d: d[1]['quarters'][0]['moments'].update(z2=10.))
        self.refuse(lambda d: d[1]['quarters'][0]['moments'].update(empirical_mean_stationary=1))

    def test_horizon_log_and_ordinary_corruption(self):
        self.refuse(lambda d: d[1]['origins'][0]['horizons']['24']['log10'].update(expected_terminal_h=100.))
        self.refuse(lambda d: d[1]['origins'][0]['horizons']['24'].update(expected_terminal_h=1.))

    def test_overflow_null_semantics_and_large_decimal_exponent(self):
        model = dict(w=.125, alpha=.1, gamma=.2, beta=.3)
        moments = dict(rho_emp=2., mean_A2=100.)
        saved = saved_horizons(model, .5, moments)
        self.assertIsNone(saved['720']['expected_terminal_h2'])
        self.assertGreater(saved['720']['log10']['expected_terminal_h2'], 1000)
        C.check_horizons(saved, model, .5, moments)
        saved['720']['nonrepresentable_float64'] = []
        with self.assertRaisesRegex(ValueError, 'overflow flags'):
            C.check_horizons(saved, model, .5, moments)

    def test_false_null_and_unjustified_zero(self):
        q = self.fixture[1]['quarters'][0]
        h = self.fixture[1]['origins'][0]['h0']
        saved = saved_horizons(q['model'], h, q['moments'])
        saved['24']['expected_terminal_h'] = None
        with self.assertRaises(ValueError): C.check_horizons(saved, q['model'], h, q['moments'])
        saved['24']['expected_terminal_h'] = 0.
        with self.assertRaises(ValueError): C.check_horizons(saved, q['model'], h, q['moments'])

    def test_hash_before_json_decode_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'malformed.json'; p.write_text('not json')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                C.read_json(p, '0' * 64)
            link = Path(folder) / 'link'; link.symlink_to(p)
            with self.assertRaisesRegex(ValueError, 'nonsymlink'):
                C.digest(link)

    def test_pinned_input_corruption_refused_before_loader(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'input'; source.write_text('original')
            plan = dict(pin=C.PIN, horizons=list(C.HORIZONS), runtime={'synthetic': True},
                        files={str(source): C.digest(source)})
            p = root / 'plan.json'; p.write_text(json.dumps(plan)); pin = C.digest(p)
            source.write_text('mutated')
            loader = unittest.mock.Mock(side_effect=AssertionError('must not load'))
            with patch.object(C, 'runtime_identity', return_value={'synthetic': True}):
                with self.assertRaisesRegex(ValueError, 'input hash mismatch'):
                    C.check(p, root / 'outputs', pin, '0' * 64, loader=loader)
            loader.assert_not_called()

    def test_exclusive_receipt_before_any_input_read(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'receipt.json'; out.write_text('keeper')
            with patch.object(C, 'check', side_effect=AssertionError('must not read')):
                with self.assertRaisesRegex(ValueError, 'already exists'):
                    C.run_to_receipt('absent', 'absent', 'no', 'no', out)
            self.assertEqual(out.read_text(), 'keeper')

    def test_receipt_positive_and_size_refusal(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'receipt.json'
            with patch.object(C, 'check', return_value={'complete': True}):
                self.assertEqual(C.run_to_receipt('p', Path(folder) / 'producer', 'p', 'm', out), {'complete': True})
            self.assertEqual(json.loads(out.read_text()), {'complete': True})
            too_large = Path(folder) / 'large.json'
            with patch.object(C, 'check', return_value={'text': 'x' * 65536}):
                with self.assertRaisesRegex(ValueError, '64KiB'):
                    C.run_to_receipt('p', Path(folder) / 'producer', 'p', 'm', too_large)
            self.assertFalse(too_large.exists())

    def test_receipt_refuses_inside_producer_root(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(C, 'check', side_effect=AssertionError('must not read')):
                with self.assertRaisesRegex(ValueError, 'outside producer'):
                    C.run_to_receipt('p', folder, 'p', 'm', Path(folder) / 'out.json')

    def full_auth_fixture(self, root):
        raw = root / 'datasets/blind5-prices'; raw.mkdir(parents=True)
        stored = root / 'datasets/history-forecasts/r16/r164-dev-63d4700f/rows'; stored.mkdir(parents=True)
        historical = root / 'historical'; historical.mkdir()
        output = root / 'output'; output.mkdir()
        pins, outputs, loaded, folds, results = {}, {}, {}, {}, []
        for i in range(42):
            key = 'blind5:binance-SYNTH' + str(i)
            name = key.replace(':', '-') + '.json'
            path = raw / ('binance-SYNTH' + str(i) + '-1h.json'); path.write_text('synthetic raw bytes')
            pins[str(path)] = C.digest(path)
            path = stored / (Path(name).stem + '.npz'); path.write_bytes(b'synthetic opaque stored bytes')
            pins[str(path)] = C.digest(path)
            path = historical / name; path.write_text(json.dumps({'result': {'synthetic': True}}))
            pins[str(path)] = C.digest(path)
            state = dict(historical_checkpoint_sha256=pins[str(path)])
            path = output / name; path.write_text(json.dumps(state)); outputs[name] = C.digest(path)
            loaded[key] = SimpleNamespace(close=[], low=[]); folds[key] = []
            results.append(dict(quarters=19 + (i < 8), origins=62 + (i < 15),
                                historical_rows=2483 + (i < 24), max_log10_error=0.))
        plan = dict(pin=C.PIN, horizons=list(C.HORIZONS), runtime={'synthetic': True}, files=pins,
                    historical=str(historical), datasets=str(root / 'datasets'))
        plan_path = root / 'plan.json'; plan_path.write_text(json.dumps(plan)); plan_hash = C.digest(plan_path)
        manifest = dict(complete=True, plan=plan, plan_sha256=plan_hash,
                        n_origins=2619, n_quarters=806, output_sha256=outputs)
        path = output / 'manifest.json'; path.write_text(json.dumps(manifest))
        return plan_path, output, plan_hash, C.digest(path), (loaded, folds, {}), results

    def test_all42_authenticated_orchestration_positive(self):
        with tempfile.TemporaryDirectory() as folder:
            p, out, ph, mh, data, results = self.full_auth_fixture(Path(folder))
            with patch.object(C, 'runtime_identity', return_value={'synthetic': True}), \
                 patch.object(C, 'check_series', side_effect=results):
                receipt = C.check(p, out, ph, mh, loader=lambda *a, **k: data)
            self.assertEqual((receipt['series'], receipt['quarters'], receipt['origins'], receipt['historical_rows']), (42, 806, 2619, 104310))
            self.assertIs(receipt['optimizer_selection_verified'], False)
            self.assertIs(receipt['prediction_parity_verified'], False)

    def test_orchestration_refuses_wrong_final_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            p, out, ph, mh, data, results = self.full_auth_fixture(Path(folder))
            results[0]['origins'] -= 1
            with patch.object(C, 'runtime_identity', return_value={'synthetic': True}), \
                 patch.object(C, 'check_series', side_effect=results):
                with self.assertRaisesRegex(ValueError, 'support totals'):
                    C.check(p, out, ph, mh, loader=lambda *a, **k: data)

    def test_orchestration_rehash_detects_midcheck_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            p, out, ph, mh, data, results = self.full_auth_fixture(Path(folder))
            calls = iter(results)
            def mutated(*args):
                target = next(out.glob('blind5-*.json'))
                target.write_text('changed during checker')
                return next(calls)
            with patch.object(C, 'runtime_identity', return_value={'synthetic': True}), \
                 patch.object(C, 'check_series', side_effect=mutated):
                with self.assertRaisesRegex(ValueError, 'output changed'):
                    C.check(p, out, ph, mh, loader=lambda *a, **k: data)


if __name__ == '__main__':
    unittest.main()
