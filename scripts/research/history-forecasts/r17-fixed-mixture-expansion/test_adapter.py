"""Generated synthetic inputs only. Exact private source bodies load by pinned manifest.

Run with pinned source-manifest and legacy-source-scope environment variables.
No market archives, retained market coefficient arrays or reserve inputs are read.
"""
import copy
import datetime as dt
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import numpy as np
import adapter as A


def sources():
    path = Path(os.environ['Q26_FIXED_C_SOURCE_MANIFEST']); raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != os.environ['Q26_FIXED_C_SOURCE_MANIFEST_SHA256']:
        raise ValueError('external source restoration manifest digest')
    pins = json.loads(raw)['science_roles']
    return A.load_science(dict(schema='q26-fixed-mixture-expansion-source-v1',
                              status='READY_SYNTHETIC_SOURCE_QUALIFICATION', science=pins)), pins


def legacy(science):
    # This reads original SOURCE METADATA only, then verifies each source before import.
    original = Path(science.producer.SOURCE)
    fit_path = Path(os.environ['Q26_FIXED_C_LEGACY_SOURCE_SCOPE'])
    need_sha = os.environ['Q26_FIXED_C_LEGACY_SOURCE_SCOPE_SHA256']
    raw = fit_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != need_sha: raise ValueError('original source metadata')
    fit = json.loads(raw); paths = []
    for rel, sha in fit['source_sha256'].items():
        p = original/rel
        if hashlib.sha256(p.read_bytes()).hexdigest() != sha: raise ValueError('legacy source changed')
        paths.append(str(p))
    finder = science.producer.FrozenSources(paths); sys.meta_path.insert(0, finder)
    for path in paths: sys.modules.pop(Path(path).stem, None)
    try:
        return tuple(importlib.import_module(n) for n in ('a3_touch', 'a6_touch', 'a2_touch', 'r16_dev'))
    finally: sys.meta_path.remove(finder)


def generated_series(science, M3, A6, D, sid):
    base = int(dt.datetime(2023, 11, 15, tzinfo=dt.timezone.utc).timestamp())
    n = 425*24; i = np.arange(n)
    returns = .018*np.sin(i/3.1+sid) + .009*np.cos(i/19.7+sid)
    close = 100*np.exp(np.cumsum(returns)); q = (science.runner.EVAL0-base)//3600
    close[q-25:q] = close[q-25]  # Exact zero past-day RV, but positive range volatility.
    low = close*.94; high = close*1.03
    fallback = (science.runner.YEAR25-base)//3600+24
    low[fallback-720:fallback] = close[fallback-720:fallback]
    high[fallback-720:fallback] = close[fallback-720:fallback]
    low[-30] = np.nan  # Genuine incomplete labels, never selection of forecast J.
    ser = M3.S3('synthetic:'+str(sid), 'ETH', 'synthetic', close, low,
                science.core.BARRIERS.copy(), base, base)
    A6.attach_high(ser, high)
    measures = D.realized(ser)
    with np.errstate(divide='ignore', invalid='ignore'):
        shape = science.producer.sanitize(np.column_stack(
            [np.where(measures['RV'+w]>0, measures['J'+w]/measures['RV'+w], np.nan) for w in 'DWM']+
            [np.where(measures['RV'+w]>0, (measures['RSm'+w]-measures['RSp'+w])/measures['RV'+w], np.nan) for w in 'DWM']))
    features = {k: np.zeros(len(ser.spot)) for k in science.producer.BASE[2:]}
    return ser, features, shape


class ActualScienceIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.science, cls.pins = sources(); cls.M3, cls.A6, cls.M2, cls.D = legacy(cls.science)
        cls.mapping = [[i, 'synthetic:'+str(i)] for i in range(277)]
        cls.tmp = tempfile.TemporaryDirectory(dir='/private/tmp'); cls.root = Path(cls.tmp.name).resolve()
        cls.private = cls.root/'quarters'; cls.private.mkdir(mode=0o700)
        cls.results = []; cls.populated = {}; cls.nontrivial = False
        for sid in (0, 1):
            ser, features, shape = generated_series(cls.science, cls.M3, cls.A6, cls.D, sid)
            arrays, metadata = A.stage_series(cls.science, ser, sid, features, shape, cls.A6, cls.M2)
            # Remove another horizon's keys in one calendar quarter, retaining ALL H24 rows.
            if sid == 1:
                cut = int(dt.datetime(2024, 4, 1, tzinfo=dt.timezone.utc).timestamp())
                keep = arrays[168]['quarter_cutoff'] != cut
                arrays[168] = {k: v[keep] for k, v in arrays[168].items()}
            # Full five-H synthetic serialization is part of the actual path.
            for h in A.HORIZONS:
                archive = cls.root/f'synthetic-sid-{sid}-h-{h}.npz'
                np.savez_compressed(archive, **arrays[h])
                with np.load(archive, allow_pickle=False) as restored:
                    readback = {k: restored[k] for k in restored.files}
                A.require_exact_regression(readback, arrays[h]); arrays[h] = readback
            saved, ledger = A.attach_joint(cls.science, arrays)
            result = A.evaluate_series(cls.science, cls.A6, cls.M2, cls.D, ser, sid,
                                       metadata[24], saved, ledger, cls.private)
            cls.nontrivial |= np.any(result.predictions['A_raw_fH'] != result.predictions['C_conditional'])
            cls.results.append(result); cls.populated[sid] = (arrays, metadata, saved, ser)
        template = cls.populated[0][0]
        for sid in range(2, 277):
            empty = {h: {k: v[:0].copy() for k, v in template[h].items()} for h in A.HORIZONS}
            saved, ledger = A.attach_joint(cls.science, empty)
            cls.results.append(A.evaluate_series(cls.science, cls.A6, cls.M2, cls.D, None, sid,
                dict(sid=sid, horizon=24, counts=dict(rows=0), quarters=[]), saved, ledger, cls.private))
        cls.cuts = {name: {'cut': cls.science.runner.CUT if name == 'downside_imbalance_D' else 0.}
                    for name in cls.science.reporter.AXES}

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def test_actual_five_horizon_to_private_C_to_full_report(self):
        A.validate_universe(self.science, self.mapping, [k for s, k in self.mapping], [list(v) for v in self.science.producer.choose([k for s, k in self.mapping])])
        self.assertTrue(self.nontrivial)
        report = A.report(self.science, self.results, self.cuts, self.mapping)
        self.assertEqual(len(report['views']), 307)
        self.assertGreater(report['J_n'], report['L24_n']); self.assertGreater(report['L24_n'], report['L5_n'])
        self.assertTrue(any(q['J_unknown_issuance_n'] for s in self.results for q in s.quarters))
        self.assertTrue(any(q['J_fallback_n'] for s in self.results for q in s.quarters))
        self.assertTrue(any(q['J_n'] == 0 for q in self.results[1].quarters))
        self.assertEqual(self.results[-1].status, 'NO_EVALUATION_QUARTERS_ZERO_J')
        path = self.root/'synthetic-report.json'; path.write_text(json.dumps(report, allow_nan=False))
        self.assertEqual(json.loads(path.read_text()), report)
        pooled = next(v for v in report['views'] if v['view_type']=='calendar' and v['view']=='pooled')
        for pair in pooled['paired'].values():
            bounds = pair['all_common_issued_bounds']
            self.assertEqual(bounds['n'], report['J_n'])
            self.assertIn('bounded_logloss', bounds); self.assertGreater(bounds['unknown_n'], 0)

    def test_no_offJ_candidate_placeholders_and_zeroJ_quarter_persisted(self):
        arrays, metadata, saved, ser = self.populated[1]
        self.assertEqual(len(saved['sid']), len(arrays[24]['sid']))
        self.assertLess(saved['on_J'].sum(), len(saved['sid']))
        keys = set(zip(saved['sid'][saved['on_J']], saved['ts'][saved['on_J']]))
        result = self.results[1]
        self.assertEqual(set(zip(result.predictions['sid'], result.predictions['ts'])), keys)
        self.assertEqual(len(result.persistence), 2*len(result.quarters))
        self.assertTrue(all(Path(p['path']).stat().st_mode & 0o777 == 0o600 for p in result.persistence))

    def test_draft_tamper_and_regression_refuse(self):
        with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('DRAFT must not read')):
            with self.assertRaisesRegex(ValueError, 'DRAFT'): A.load_science({})
        pins = copy.deepcopy(self.pins); pins['runner']['size'] += 1
        with self.assertRaisesRegex(ValueError, 'science pin mismatch'):
            A.load_science(dict(status='READY_SYNTHETIC_SOURCE_QUALIFICATION',
                               schema='q26-fixed-mixture-expansion-source-v1', science=pins))
        fresh = dict(a=np.array([.1], dtype=np.float64)); retained = dict(a=fresh['a'].copy())
        A.require_exact_regression(fresh, retained); retained['a'][0] = np.nextafter(.1, 1.)
        with self.assertRaises(ValueError): A.require_exact_regression(fresh, retained)

    def test_unknown_only_nonfallback_still_has_strict_historical_support(self):
        mixture = self.science.mixture
        with self.assertRaisesRegex(ValueError, 'empty historical state'):
            mixture.missingness_mixture(np.array([-1., -2.]), np.array([0, -1], np.int8),
                np.full((1, 5), -1.5), np.array([-1], np.int8), np.full((1, 5), .5))

    def test_empty_horizon_keeps_full_H24_ledger_and_rejects_extra_horizon(self):
        arrays = {h: {k: v.copy() for k, v in self.populated[0][0][h].items()} for h in A.HORIZONS}
        arrays[168] = {k: v[:0] for k, v in arrays[168].items()}
        saved, ledger = A.attach_joint(self.science, arrays)
        self.assertEqual(len(saved['sid']), len(arrays[24]['sid']))
        self.assertFalse(saved['on_J'].any()); self.assertEqual(ledger['J_n'], 0)
        self.assertEqual(set(ledger['per_horizon']), {'6', '12', '24', '72', '168'})
        empty = {h: {k: v[:0] for k, v in arrays[h].items()} for h in A.HORIZONS}
        with self.assertRaisesRegex(ValueError, 'five-horizon'):
            A.attach_joint(self.science, dict(empty, extra=empty[24]))

    def test_actual_allfallback_quarter_skips_state_support(self):
        base = int(dt.datetime(2023, 1, 1, tzinfo=dt.timezone.utc).timestamp())
        close = 100*np.exp(.01*np.sin(np.arange(10000)/3.1))
        ser = self.M3.S3('synthetic:fallback', 'ETH', 'synthetic', close, close.copy(),
                         self.science.core.BARRIERS.copy(), base, base)
        self.A6.attach_high(ser, close.copy())
        features = {k: np.zeros(len(ser.spot)) for k in self.science.producer.BASE[2:]}
        shape = np.full((len(ser.spot), 6), np.nan, np.float32)
        shape[:, 3] = self.science.census_source.downside_feature(self.D.realized(ser), self.science.producer.sanitize)
        arrays, metadata = A.stage_series(self.science, ser, 999, features, shape, self.A6, self.M2)
        saved, ledger = A.attach_joint(self.science, arrays)
        result = A.evaluate_series(self.science, self.A6, self.M2, self.D, ser, 999,
                                   metadata[24], saved, ledger, self.private)
        self.assertGreater(len(result.predictions['ts']), 0)
        self.assertTrue(all(q['original_all_fallback'] for q in result.quarters))
        self.assertTrue(all(q['library_n'] is None for q in result.quarters))
        for arm in self.science.runner.ARMS:
            np.testing.assert_array_equal(result.predictions[arm], result.predictions['A_raw_fH'])

    def test_live_candidate_mutation_and_short_universe_refuse(self):
        live = self.results[0].predictions['C_conditional']; old = live[0].copy()
        try:
            live[0] = .01
            with self.assertRaisesRegex(ValueError, 'persisted candidate byte binding'):
                A.report(self.science, self.results, self.cuts, self.mapping)
        finally: live[0] = old
        with self.assertRaisesRegex(ValueError, 'canonical277'):
            A.report(self.science, self.results[:1], self.cuts, self.mapping[:1])

    def test_persistence_tamper_refuses_before_scores(self):
        record = self.results[0].persistence[0]; path = Path(record['path']); original = path.read_bytes()
        try:
            path.write_bytes(original+b'tamper')
            with mock.patch.object(self.science.reporter, 'metric', side_effect=AssertionError('no scores')):
                with self.assertRaisesRegex(ValueError, 'quarter changed'):
                    A.report(self.science, self.results, self.cuts, self.mapping)
        finally: path.write_bytes(original)


if __name__ == '__main__': unittest.main()
