"""Synthetic qualification only; no private inputs or original scientific code.

The acceptance-chain fixture uses the real pure checker only for header/calendar
validation, with wholly synthetic witness values and synthetic saved receipts.
"""
from fractions import Fraction
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import numpy as np

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('support_width_under_test', HERE / 'support_bounds.py')
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


def pin(path):
    p = Path(path)
    return {'path': str(p), 'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}


def write(path, data):
    Path(path).write_text(json.dumps(data, allow_nan=False))
    return pin(path)


def arrays_and_summary():
    p, q = 1704067200, 1711929600
    ends = np.array([p - 7200, p - 3600, p, p + 3600, p + 7200, p + 10800, p + 14400], dtype='<i8')
    states = np.array([-1, 0, 1, 0, 0, 1, 1], dtype='i1')
    summary = {'rows': 7, 'state_counts': {'0': 3, '1': 3, '-1': 1},
               'unknown': {'total': 1,
                    'before': {'count': 1, 'min': p - 7200, 'max': p - 7200},
                    'equal': {'count': 0, 'min': None, 'max': None},
                    'after': {'count': 0, 'min': None, 'max': None},
                    'all': {'count': 1, 'min': p - 7200, 'max': p - 7200}},
               'array_sha256': {k: hashlib.sha256(a.tobytes()).hexdigest()
                                 for k, a in [('main_label_end', ends), ('main_state', states)]}}
    plan = {'pilot': {'current_cutoff': q, 'previous_cutoff': p}}
    return ends, states, plan, {'summary': summary}


def update_summary(ends, states, result, p):
    # Tests changing support must provide a self-consistent accepted fixture,
    # so refusals reach the support invariant rather than a stale digest.
    out = copy.deepcopy(result)
    recount = S.counts_loop(ends, states, p)
    out['summary']['rows'] = len(ends)
    out['summary']['state_counts'] = {s: sum(row.values()) for s, row in recount['cells'].items()}
    out['summary']['unknown'] = recount['unknown']
    out['summary']['array_sha256'] = {k: hashlib.sha256(a.tobytes()).hexdigest()
                                      for k, a in [('main_label_end', ends), ('main_state', states)]}
    return out


class CountAndAlgebra(unittest.TestCase):
    def test_unequal_group_denominator_and_exact_width(self):
        e, s, p, r = arrays_and_summary()
        value = S.count_and_width(e, s, p, r)
        self.assertEqual(value['date_rows'], {'older': 3, 'recent': 4})
        self.assertEqual(value['cells'], {'0': {'older': 1, 'recent': 2},
                                         '1': {'older': 1, 'recent': 2},
                                         '-1': {'older': 1, 'recent': 0}})
        self.assertEqual(value['alpha_older_unknown_over_older_all'], {'numerator': '1', 'denominator': '3'})
        self.assertEqual(value['each_symmetric_allocation_pointwise_width'], {'numerator': '1', 'denominator': '6'})
        self.assertEqual(value['full_original_decomposition'], 'UNAVAILABLE')
        self.assertNotIn('CDF', value)

    def test_both_absent_known_category_allowed(self):
        e, s, p, r = arrays_and_summary()
        s[s == 1] = 0
        r = update_summary(e, s, r, p['pilot']['previous_cutoff'])
        value = S.count_and_width(e, s, p, r)
        self.assertEqual(value['cells']['1'], {'older': 0, 'recent': 0})

    def test_other_one_sided_category_refused(self):
        e, s, p, r = arrays_and_summary()
        s[2] = 0  # known state1 now only recent.
        r = update_summary(e, s, r, p['pilot']['previous_cutoff'])
        with self.assertRaisesRegex(ValueError, 'other one-sided'):
            S.count_and_width(e, s, p, r)

    def test_unknown_absent_recent_or_equal_refused(self):
        for kind in ('absent', 'recent', 'equal'):
            e, s, p, r = arrays_and_summary()
            if kind == 'absent': s[0] = 0
            elif kind == 'recent': s[-1] = -1
            else: s[0], s[2] = s[2], s[0]
            r = update_summary(e, s, r, p['pilot']['previous_cutoff'])
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'unknown state'):
                S.count_and_width(e, s, p, r)

    def test_empty_date_group_refused(self):
        e, s, p, r = arrays_and_summary()
        e = e[:3]; s = s[:3]
        r = update_summary(e, s, r, p['pilot']['previous_cutoff'])
        with self.assertRaisesRegex(ValueError, 'two nonempty'):
            S.count_and_width(e, s, p, r)

    def test_type_domain_schema_digest_and_summary_refusals(self):
        for kind in ('dtype', 'shape', 'state', 'offgrid', 'future', 'order', 'rows', 'boolcount', 'count', 'extent', 'digest'):
            e, s, p, r = arrays_and_summary()
            if kind == 'dtype': e = e.astype('f8')
            elif kind == 'shape': s = s.reshape(1, -1)
            elif kind == 'state': s[0] = 2
            elif kind == 'offgrid': e[0] += 1
            elif kind == 'future': e[-1] = p['pilot']['current_cutoff'] + 3600
            elif kind == 'order': e[1] = e[0]
            elif kind == 'rows': r['summary']['rows'] = 6
            elif kind == 'boolcount': r['summary']['state_counts']['-1'] = True
            elif kind == 'count': r['summary']['state_counts']['0'] += 1
            elif kind == 'extent': r['summary']['unknown']['all']['min'] += 3600
            else: r['summary']['array_sha256']['main_state'] = '0' * 64
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                S.count_and_width(e, s, p, r)

    def test_reducers_are_separate_and_disagreement_refuses(self):
        e, s, p, r = arrays_and_summary()
        self.assertEqual(S.counts_numpy(e, s, p['pilot']['previous_cutoff']), S.counts_loop(e, s, p['pilot']['previous_cutoff']))
        with mock.patch.object(S, 'counts_loop', return_value={}), self.assertRaisesRegex(ValueError, 'independent count'):
            S.count_and_width(e, s, p, r)

    def test_fraction_cancellation_sharp_endpoint_width_and_linkage(self):
        alpha, unknown_f = Fraction(1, 3), Fraction(2, 5)
        common_c, common_w = Fraction(1, 7), Fraction(-1, 11)
        points = []
        for x in (Fraction(0), Fraction(1, 4), Fraction(1)):
            c = common_c - alpha * (x + unknown_f) / 2
            w = common_w + alpha * (x - unknown_f) / 2
            self.assertEqual(c + w, common_c + common_w - alpha * unknown_f)
            points.append((c, w))
        self.assertEqual(points[0][0] - points[-1][0], alpha / 2)
        self.assertEqual(points[-1][1] - points[0][1], alpha / 2)
        # Component interval maxima use different x values: adding them is invalid.
        self.assertNotEqual(points[0][0] + points[-1][1], common_c + common_w - alpha * unknown_f)


class SavedAncestry(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def fixture(self):
        e, s, plan, result = arrays_and_summary()
        outdir = self.root / 'original'
        outdir.mkdir()
        checker = pin((HERE / 'check.py').absolute())
        implementation = pin((HERE / 'support_bounds.py').absolute())
        python = pin(Path(sys.executable).resolve())
        auditfile = self.root / 'fake-audit.txt'
        auditfile.write_text('SYNTHETIC - NEVER EXECUTED')
        audit = pin(auditfile)
        plan.update(schema='q26-fh-date-support-plan-v1', parent_admitted=True,
                    mode='NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT', row_capacity=200000,
                    out=str(outdir), roles={'checker': checker, 'audit': audit}, files=[checker, audit],
                    runtime={'executable': python, 'python_version': sys.version.split()[0], 'packages': {'numpy': np.__version__}})
        planpin = write(self.root / 'plan.json', plan)
        started = write(outdir / 'started.json', {'schema': 'q26-fh-date-support-started-v1', 'plan_sha256': planpin['sha256'], 'reconstruction': True})
        extra = {'main_index': np.arange(len(e), dtype='<i8'), 'D_original': np.where(s == -1, np.nan, 0).astype('<f4'),
                 'unknown_partition': np.where(s == -1, 0, -1).astype('i1')}
        np.savez_compressed(outdir / 'witness.npz', main_label_end=e, main_state=s, **extra)
        witness = pin(outdir / 'witness.npz')
        result.update(schema='q26-fh-date-support-result-v1', complete=True, reconstruction=True,
                      historical_bridge_parity='UNAVAILABLE', plan_sha256=planpin['sha256'],
                      source=audit, witness=witness, started=started)
        resultpin = write(outdir / 'result.json', result)
        acceptance = write(self.root / 'acceptance.json', {'schema': 'q26-fh-date-support-acceptance-v1', 'complete': True,
                           'reconstruction': True, 'historical_bridge_parity': 'UNAVAILABLE',
                           'plan_sha256': planpin['sha256'], 'result_sha256': resultpin['sha256'],
                           'checker_source': checker, 'summary': result['summary']})
        request = {'schema': 'q26-fh-support-width-request-v1',
                   'pins': {'plan': planpin, 'result': resultpin, 'acceptance': acceptance,
                            'witness': witness, 'started': started, 'implementation': implementation, 'python': python},
                   'out': str(self.root / 'width.json')}
        reqpin = write(self.root / 'request.json', request)
        return request, reqpin

    def test_positive_metadata_authentication_does_not_decode(self):
        request, reqpin = self.fixture()
        with mock.patch.object(S.np, 'load') as decode:
            _, plan, result = S.authenticate(reqpin['path'], reqpin['sha256'])
        decode.assert_not_called()
        self.assertEqual(result['summary']['rows'], 7)
        self.assertEqual(plan['row_capacity'], 200000)

    def test_saved_run_decodes_only_two_fields_and_writes_private_exclusive(self):
        request, reqpin = self.fixture()
        original_load = np.load
        fields = []
        class LimitedArchive:
            def __init__(self, archive): self.archive = archive
            def __enter__(self): return self
            def __exit__(self, *args): self.archive.close()
            def __getitem__(self, key):
                fields.append(key)
                if key not in ('main_label_end', 'main_state'):
                    raise AssertionError('feature/depth/index decode forbidden')
                return self.archive[key]
        with mock.patch.object(S.np, 'load', side_effect=lambda *a, **k: LimitedArchive(original_load(*a, **k))):
            result = S.run(reqpin['path'], reqpin['sha256'], request['out'])
        self.assertEqual(fields, ['main_label_end', 'main_state'])
        self.assertEqual(result['each_symmetric_allocation_pointwise_width']['denominator'], '6')
        self.assertEqual(Path(request['out']).stat().st_mode & 0o777, 0o600)
        self.assertLess(Path(request['out']).stat().st_size, S.MAX_OUTPUT)
        with self.assertRaisesRegex(ValueError, 'exclusive'):
            S.run(reqpin['path'], reqpin['sha256'], request['out'])

    def test_wrong_binding_or_pin_refuses_before_decode(self):
        for kind in ('requestsha', 'resultsha', 'witnesspin', 'acceptance', 'inventory', 'output'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as d:
                oldroot = self.root
                self.root = Path(d)
                request, reqpin = self.fixture()
                expected = reqpin['sha256']
                if kind == 'requestsha': expected = '0' * 64
                elif kind == 'resultsha':
                    body = json.loads(Path(request['pins']['result']['path']).read_text())
                    body['plan_sha256'] = '0' * 64
                    request['pins']['result'] = write(request['pins']['result']['path'], body)
                elif kind == 'witnesspin':
                    request['pins']['witness']['sha256'] = '0' * 64
                elif kind == 'acceptance':
                    body = json.loads(Path(request['pins']['acceptance']['path']).read_text())
                    body['complete'] = False
                    request['pins']['acceptance'] = write(request['pins']['acceptance']['path'], body)
                elif kind == 'inventory':
                    (Path(request['pins']['result']['path']).parent / 'extra').write_text('stale')
                else: request['out'] = str(self.root / 'different.json')
                if kind != 'requestsha':
                    reqpin = write(reqpin['path'], request)
                    expected = reqpin['sha256']
                with mock.patch.object(S.np, 'load') as decode, self.assertRaises(ValueError):
                    S.run(reqpin['path'], expected, self.root / 'width.json')
                decode.assert_not_called()
                self.root = oldroot

    def test_signed_dotdot_output_alias_refused_before_decode(self):
        for kind in ('sibling', 'inside'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as d:
                oldroot = self.root
                self.root = Path(d)
                request, reqpin = self.fixture()
                original = Path(request['pins']['result']['path']).parent
                before = {p.name: p.read_bytes() for p in original.iterdir()}
                if kind == 'sibling':
                    (self.root / 'existing').mkdir()
                    alias = self.root / 'existing' / '..' / 'original' / 'new.json'
                else:
                    # The absent subdirectory is intentional: lexical checks must
                    # reject the alias without relying on filesystem traversal.
                    alias = original / 'sub' / '..' / 'new.json'
                request['out'] = str(alias)
                reqpin = write(reqpin['path'], request)
                with mock.patch.object(S.np, 'load') as decode, self.assertRaisesRegex(ValueError, 'canonical absolute'):
                    S.run(reqpin['path'], reqpin['sha256'], alias)
                decode.assert_not_called()
                self.assertEqual({p.name: p.read_bytes() for p in original.iterdir()}, before)
                self.assertFalse((original / 'new.json').exists())
                self.root = oldroot

    def test_symlink_input_or_output_refused(self):
        request, reqpin = self.fixture()
        alias = self.root / 'alias.json'
        alias.symlink_to(reqpin['path'])
        with self.assertRaises(ValueError): S.authenticate(alias, reqpin['sha256'])
        outlink = self.root / 'outlink'
        outlink.symlink_to(self.root)
        with self.assertRaises(ValueError): S.run(reqpin['path'], reqpin['sha256'], outlink / 'width.json')


if __name__ == '__main__':
    unittest.main()
