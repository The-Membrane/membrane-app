"""Synthetic saved-row and serialization fixtures only; no historical inputs."""
import copy
import hashlib
import json
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np

import saved_repair as S
from horizon_coherence import project_grid


MAPPING = [[7, 'synthetic:a'], [9, 'synthetic:b']]


def fixture():
    archives = {}
    for i, h in enumerate(S.HORIZONS):
        p = np.array([[.1, .2, .3, .5, .8], [.2, .3, .4, .6, .9], [.05, .1, .2, .4, .7]], dtype='float64')
        if h == 12:
            p *= .5
        data = dict(sid=np.array([7, 9, 7], dtype='int32'),
                    ts=np.array([S.START, S.YEAR25, S.START+86400], dtype='int64'),
                    y=np.zeros((3, 5), dtype='uint8'), label_valid=np.ones(3, bool))
        data.update({a: p.copy() for a in S.CONTROLS})
        archives[h] = data
    return archives


def references(archives):
    return {h: dict(**S.summarize(d, {a: d[a] for a in S.CONTROLS}, h, [7, 9]),
                    evaluation_issued_origins=len(d['sid']),
                    evaluation_complete_label_origins=int(d['label_valid'].sum()),
                    evaluation_fH_fallback_origins=0,
                    issue_eligible_invalid_baseline=4) for h, d in archives.items()}


class SavedReducerTests(unittest.TestCase):
    def test_join_by_keys_not_position_and_input_preserved(self):
        original = fixture(); data = copy.deepcopy(original)
        for h in S.HORIZONS[1:]:
            data[h] = {k: v[[2, 0, 1]].copy() for k, v in data[h].items()}
        out, report = S.reduce_saved(data, MAPPING, project_grid)
        baseline_out, _ = S.reduce_saved(original, MAPPING, project_grid)
        for h in S.HORIZONS:
            for name in S.FIELDS:
                np.testing.assert_array_equal(data[h][name], original[h][name] if h == 6 else original[h][name][[2, 0, 1]])
            index = {(int(s), int(t)): i for i, (s, t) in enumerate(zip(out[h]['sid'], out[h]['ts']))}
            for i, key in enumerate(zip(baseline_out[h]['sid'], baseline_out[h]['ts'])):
                for arm in S.ARMS:
                    self.assertEqual(out[h][arm][index[key]].tobytes(), baseline_out[h][arm][i].tobytes())
        self.assertEqual(report['common_prediction_only_J']['rows'], 3)

    def test_partial_grid_unchanged_all_arms(self):
        d = fixture(); absent = (7, S.START+86400)
        d[168] = {k: v[:2].copy() for k, v in d[168].items()}
        out, report = S.reduce_saved(d, MAPPING, project_grid)
        self.assertEqual(report['partial_grid_rows'], 1)
        for h in S.HORIZONS[:-1]:
            self.assertFalse(out[h]['projected'][2])
            for arm in S.ARMS: self.assertEqual(out[h][arm][2].tobytes(), d[h][arm][2].tobytes())
        self.assertNotIn(absent, zip(out[168]['sid'], out[168]['ts']))

    def test_labels_do_not_select_projection_and_invalid_placeholders_not_scored(self):
        d = fixture(); out0, r0 = S.reduce_saved(d, MAPPING, project_grid)
        for h in S.HORIZONS:
            d[h]['label_valid'][2] = False; d[h]['y'][2] = 255
        out, report = S.reduce_saved(d, MAPPING, project_grid)
        self.assertEqual(r0['common_prediction_only_J'], report['common_prediction_only_J'])
        for h in S.HORIZONS:
            for arm in S.ARMS: np.testing.assert_array_equal(out[h][arm], out0[h][arm])
        score = report['horizons'][0]['candidate']['scores'][0]
        self.assertEqual(score['n'], 2); self.assertEqual(score['events'], 0)
        self.assertEqual(report['horizons'][0]['candidate']['missing_label_sensitivity'][0]['unknown_rows'], 1)

    def test_duplicate_unknown_key_invalid_probability_barrier_and_labels_refused(self):
        cases = []
        d = fixture(); d[6]['ts'][2] = d[6]['ts'][0]; cases.append(d)
        d = fixture(); d[6]['sid'][0] = 100; cases.append(d)
        for value in (np.nan, np.inf, -1., 1.01):
            d = fixture(); d[6]['linear_projected'][0, 0] = value; cases.append(d)
        d = fixture(); d[6]['baseline_raw'][0, 0] = .9; cases.append(d)
        d = fixture(); d[6]['y'][0, 0] = 2; cases.append(d)
        d = fixture(); d[6]['y'][0, 0] = 1; cases.append(d)
        d = fixture(); d[6]['y'][0] = 1; cases.append(d)
        for d in cases:
            with self.assertRaises(ValueError): S.reduce_saved(d, MAPPING, project_grid)

    def test_native_views_parity_and_copied_provenance(self):
        d = fixture(); refs = references(d)
        _, report = S.reduce_saved(d, MAPPING, project_grid, refs)
        self.assertEqual(report['native_metric_parity'], 'PASS')
        self.assertEqual(len(report['horizons'][0]['native']['scores']), 5*8*5)
        self.assertEqual(report['horizons'][0]['original_provenance']['issue_eligible_invalid_baseline'], 4)
        refs[24]['scores'][0]['events'] += 1
        with self.assertRaisesRegex(ValueError, 'native point metric parity'):
            S.reduce_saved(d, MAPPING, project_grid, refs)

    def test_metric_and_missing_bound_small_hand_case(self):
        y = np.array([0, 1], dtype='uint8'); p = np.array([.25, .75])
        m = S.metrics(y, p, np.array([.5, .5]), np.array([7, 9]), np.array([S.START, S.YEAR25]))
        self.assertEqual(m['brier'], 1/16); self.assertEqual(m['bss'], .75)
        self.assertEqual(m['sum_probability'], 1.); self.assertEqual(m['events'], 1)
        b = S.missing_bounds(y, p, np.array([.5, .5]), np.array([True, False]))
        self.assertEqual(b['mean_d_lower'], -3/16); self.assertEqual(b['mean_d_upper'], 1/16)

    def test_native_asset_support_contract(self):
        d = fixture(); d[6]['label_valid'][1] = False
        with self.assertRaisesRegex(ValueError, 'asset sets'): S.reduce_saved(d, MAPPING, project_grid)

    def test_paired_deltas_avoid_aggregate_cancellation(self):
        original = np.full(10000, .5); candidate = original.copy()
        candidate[0] = np.nextafter(.5, 1.)
        y = np.zeros(10000, dtype='uint8')
        self.assertEqual(float(candidate.sum())-float(original.sum()), 0.)
        d = S.paired_delta(y, candidate, original)
        self.assertEqual(d['sum_probability'], float(candidate[0]-original[0]))
        self.assertGreater(d['brier'], 0.); self.assertGreater(d['bounded_logloss'], 0.)
        q, p = Fraction.from_float(float(candidate[0])), Fraction(1, 2)
        self.assertEqual(d['exact_brier'], S.fraction_record((q*q-p*p)/10000))
        self.assertEqual(d['exact_sum_probability'], S.fraction_record(q-p))
        self.assertEqual(d['brier_direction'], 'positive')
        self.assertEqual(S.paired_delta(y, original, original),
                         dict(brier=0., bounded_logloss=0., sum_probability=0., exact_brier=['0', '1'],
                              exact_sum_probability=['0', '1'], brier_direction='zero', sum_probability_direction='zero'))
        self.assertTrue(all(v is None for v in S.paired_delta(y[:0], original[:0], original[:0]).values()))
        reverse = S.paired_delta(y, original, candidate)
        self.assertEqual(reverse['brier_direction'], 'negative')
        self.assertEqual(reverse['sum_probability_direction'], 'negative')
        self.assertEqual(reverse['brier'], -d['brier'])

    def test_frozen_historical_float_compatibility_and_exact_keys_counts(self):
        d = fixture()[6]; observed = S.summarize(d, {a: d[a] for a in S.CONTROLS}, 6, [7, 9])
        accepted = copy.deepcopy(observed); accepted['scores'][0]['brier'] += 1e-13
        S.reconcile_native(observed, accepted)
        accepted['scores'][0]['brier'] += 1e-5
        with self.assertRaises(ValueError): S.reconcile_native(observed, accepted)
        accepted = copy.deepcopy(observed); accepted['scores'][0]['barrier'] += 1e-14
        with self.assertRaises(ValueError): S.reconcile_native(observed, accepted)
        accepted = copy.deepcopy(observed); accepted['scores'][0]['n'] = float(accepted['scores'][0]['n'])
        with self.assertRaises(ValueError): S.reconcile_native(observed, accepted)

    def test_exact_dyadic_direction_survives_display_underflow(self):
        tiny = np.array([np.nextafter(0., 1.)]); zero = np.zeros(1)
        delta = S.paired_delta(np.zeros(1, dtype='uint8'), tiny, zero)
        self.assertEqual(delta['brier'], 0.)
        self.assertEqual(delta['brier_direction'], 'positive')
        self.assertEqual(delta['exact_brier'], ['1', str(1 << 2148)])
        reverse = S.paired_delta(np.zeros(1, dtype='uint8'), zero, tiny)
        self.assertEqual(reverse['brier_direction'], 'negative')
        self.assertEqual(reverse['exact_brier'], ['-1', str(1 << 2148)])


class SerializedTests(unittest.TestCase):
    def setup_run(self, root):
        d = fixture(); refs = references(d); pins = {}
        for h, arrays in d.items():
            path = root/f'input-{h}.npz'; np.savez_compressed(path, **arrays)
            pins[f'archive_{h}'] = S.pin(path)
        pins['source'] = S.pin(Path(S.__file__).resolve())
        pins['kernel'] = S.pin(Path(S.__file__).resolve().with_name('horizon_coherence.py'))
        authority = root/'authority.json'; authority.write_text('{}\n'); closure = [S.pin(authority)]
        reqpath = root/'request.json'; reqpath.write_text('{}\n')
        request = dict(pins=pins); sha = hashlib.sha256(reqpath.read_bytes()).hexdigest()
        return request, reqpath, sha, refs, closure, authority

    def test_actual_serialization_positive_inventory_and_bindings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); req, path, sha, refs, closure, _ = self.setup_run(root)
            with mock.patch.object(S, 'authenticate', return_value=(req, MAPPING, refs, closure)):
                result = S.run(str(path), sha, str(root/'out'))
            self.assertEqual({p.name for p in (root/'out').iterdir()}, {'started.json', 'result.json'} | {f'candidate-{h}.npz' for h in S.HORIZONS})
            saved = json.loads((root/'out/result.json').read_text())
            self.assertEqual(saved, result); self.assertTrue(saved['complete'])
            self.assertEqual((root/'out').stat().st_mode & 0o777, 0o700)
            self.assertEqual(saved['started'], S.pin(root/'out/started.json'))
            self.assertEqual(json.loads((root/'out/started.json').read_text())['request_sha256'], sha)
            for h in S.HORIZONS:
                with np.load(root/f'out/candidate-{h}.npz', allow_pickle=False) as z:
                    self.assertEqual(set(z.files), {'sid', 'ts', 'y', 'label_valid', 'projected'} | set(S.ARMS))
                    self.assertEqual(z['projected'].dtype, np.dtype('bool'))
                    self.assertEqual(z['baseline_raw'].dtype, np.dtype('float64'))
                self.assertEqual(saved['candidates'][str(h)], S.pin(root/f'out/candidate-{h}.npz'))

    def test_final_authority_mutation_preserves_failure_no_complete_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); req, path, sha, refs, closure, authority = self.setup_run(root)
            def mutate(record):
                authority.write_text('{"changed":true}\n'); return project_grid
            with mock.patch.object(S, 'authenticate', return_value=(req, MAPPING, refs, closure)), mock.patch.object(S, 'load_kernel', side_effect=mutate):
                with self.assertRaisesRegex(ValueError, 'pin changed'): S.run(str(path), sha, str(root/'out'))
            self.assertTrue((root/'out/started.json').exists()); self.assertFalse((root/'out/result.json').exists())

    def test_bounded_headers_accept_synthetic_and_refuse_dtype_or_extra_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); d = fixture()[6]
            good = root/'good.npz'; np.savez_compressed(good, **d)
            with mock.patch.object(np, 'load', side_effect=AssertionError('no decode')):
                self.assertEqual(len(S.archive_headers(good)), 12)
            d['sid'] = d['sid'].astype('int64'); bad = root/'bad.npz'; np.savez_compressed(bad, **d)
            with self.assertRaises(ValueError): S.archive_headers(bad)
            extra = root/'extra.npz'; np.savez_compressed(extra, **fixture()[6], extra=np.zeros(1))
            with self.assertRaises(ValueError): S.archive_headers(extra)

    def test_external_digest_refused_before_parse_or_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); path = root/'request'; path.write_text('not json')
            with self.assertRaisesRegex(ValueError, 'external request digest'):
                S.authenticate(str(path), '0'*64, str(root/'out'))

    def test_strict_json_and_request_bounds_before_decode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); path = root/'request'
            for payload in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e400}'):
                path.write_text(payload); sha = hashlib.sha256(path.read_bytes()).hexdigest()
                with self.assertRaises(ValueError): S.authenticate(str(path), sha, str(root/'out'))
            path.write_bytes(b' '*(1024**2+1))
            with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('oversize read')):
                with self.assertRaisesRegex(ValueError, 'request byte cap'):
                    S.authenticate(str(path), '0'*64, str(root/'out'))
            link = root/'link'; link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'canonical request'):
                S.authenticate(str(link), '0'*64, str(root/'out'))
            with mock.patch.object(S, 'checked', side_effect=AssertionError('oversize metadata read')):
                with self.assertRaisesRegex(ValueError, 'JSON byte cap'): S.read_json({'size': S.JSON_CAP+1})

    def test_json_and_total_output_caps_exclusive_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with mock.patch.object(S, 'JSON_CAP', 10):
                with self.assertRaisesRegex(ValueError, 'byte cap'): S.write_json(root/'large.json', {'value': 'too large'})
            self.assertFalse((root/'large.json').exists())
            S.write_json(root/'first.json', {})
            with self.assertRaises(FileExistsError): S.write_json(root/'first.json', {})
            with mock.patch.object(S, 'OUTPUT_CAP', 4):
                with self.assertRaisesRegex(ValueError, 'byte cap'): S.write_json(root/'second.json', {})
            self.assertFalse((root/'second.json').exists())

    def test_compact_full_synthetic_report_preserves_fixed_cap_and_values(self):
        # The original small fixture hides repeated native/control-view whitespace.
        mapping = [[i, f'synthetic:{i}'] for i in range(24)]
        archives = {}
        for h, old in fixture().items():
            data = {k: np.tile(v[:2], (24, 1)) if v.ndim == 2 else np.tile(v[:2], 24)
                    for k, v in old.items()}
            data['sid'] = np.repeat(np.arange(24, dtype='int32'), 2)
            archives[h] = data
        _, report = S.reduce_saved(archives, mapping, project_grid)
        payload = dict(schema='synthetic-report-serialization-regression', analysis=report, padding='')
        compact_size = len((json.dumps(payload, separators=(',', ':'), allow_nan=False)+'\n').encode())
        self.assertLess(compact_size, S.JSON_CAP)
        # Padding is synthetic transport metadata, not omitted scientific fields.
        payload['padding'] = 'x' * (S.JSON_CAP-compact_size-1)
        self.assertGreater(len((json.dumps(payload, indent=2, allow_nan=False)+'\n').encode()), S.JSON_CAP)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve()/'report.json'
            S.write_json(path, payload)
            self.assertEqual(path.stat().st_size, S.JSON_CAP-1)
            self.assertEqual(S.strict_json(path.read_bytes()), payload)
            with self.assertRaises(FileExistsError): S.write_json(path, payload)
            payload['padding'] += 'xx'
            with self.assertRaisesRegex(ValueError, 'byte cap'): S.write_json(path.with_name('oversize.json'), payload)
            self.assertFalse(path.with_name('oversize.json').exists())


if __name__ == '__main__':
    unittest.main()
