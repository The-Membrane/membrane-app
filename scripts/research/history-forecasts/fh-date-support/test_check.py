"""Synthetic only: no real pilot arrays, source imports or model execution.

Run orchestration tests mock admission and reconstruction deliberately; they test
saved-artifact checks, not the original loader arithmetic or real runtime closure.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import numpy as np

spec = importlib.util.spec_from_file_location('independent_date_check', Path(__file__).with_name('check.py'))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


def sha(p):
    p = Path(p)
    return {'path': str(p), 'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}


def write(p, data):
    Path(p).write_text(json.dumps(data, allow_nan=False))
    return sha(p)


def fixture(states=(-1, -1, -1, -1)):
    q = 1711929600  # 2024-04-01; immediate predecessor 2024-01-01.
    p = C.predecessor(q)
    ends = np.array([p - 3600, p, p + 3600, q], dtype='<i8')
    base = p - 100 * 3600
    index = ((ends - base) // 3600 - 24).astype('<i8')
    values = np.array([np.nan if s == -1 else (-0.2 if s == 0 else 0.2) for s in states], dtype='<f4')
    parts = np.array([(-1 if s != -1 else 0 if e < p else 1 if e == p else 2)
                      for s, e in zip(states, ends)], dtype='i1')
    witness = {'main_index': index, 'main_label_end': ends,
               'main_state': np.array(states, dtype='i1'), 'D_original': values,
               'unknown_partition': parts}
    pilot = {'sid': 7, 'key': 'blind6:SYNTHETIC', 'current_cutoff': q, 'previous_cutoff': p}
    plan = {'pilot': pilot, 'row_capacity': 200000}
    summary = C.recount(witness, pilot, base, 0.0, 200000)
    result = {'schema': 'q26-fh-date-support-result-v1', 'complete': True,
              'reconstruction': True, 'historical_bridge_parity': 'UNAVAILABLE',
              'summary': summary, 'membership_sha256': summary['array_sha256']['main_index']}
    cohort = {k: v.copy() for k, v in witness.items() if k != 'unknown_partition'}
    return plan, witness, cohort, base, result


class ScalarCheck(unittest.TestCase):
    def test_hand_boundaries_and_full_equality(self):
        plan, w, cohort, base, result = fixture()
        summary = C.verify_saved(plan, result, w, cohort, base, 0.0)
        self.assertEqual(summary['unknown']['before']['count'], 1)
        self.assertEqual(summary['unknown']['equal']['count'], 1)
        self.assertEqual(summary['unknown']['after']['count'], 2)
        self.assertEqual(summary['unknown']['all']['max'], plan['pilot']['current_cutoff'])
        self.assertEqual(summary['state_counts'], {'0': 0, '1': 0, '-1': 4})

    def test_unknown_absent_or_one_partition(self):
        for states in ((0, 1, 0, 1), (-1, 0, 0, 1), (0, -1, 0, 1), (0, 0, -1, 1)):
            with self.subTest(states=states):
                plan, w, cohort, base, result = fixture(states)
                s = C.verify_saved(plan, result, w, cohort, base, 0.0)
                self.assertEqual(s['unknown']['total'], states.count(-1))
                for name in ('before', 'equal', 'after', 'all'):
                    b = s['unknown'][name]
                    if b['count'] == 0:
                        self.assertIsNone(b['min'])
                        self.assertIsNone(b['max'])

    def test_january_and_leap_year(self):
        self.assertEqual(C.predecessor(1704067200), 1696118400)
        self.assertEqual(C.predecessor(1711929600), 1704067200)
        self.assertEqual((1711929600 - 1704067200) // 86400, 91)
        for q in (1711929601, 1711933200, 1706745600, 1704067200.0, True):
            with self.subTest(q=q), self.assertRaises((ValueError, TypeError)):
                C.predecessor(q)

    def test_float32_rounding_and_signed_zero(self):
        plan, w, _, base, _ = fixture((0, 0, 1, -1))
        cut = 0.1000000001
        w['D_original'][:] = [np.float32(0.0), np.float32(-0.0), np.float32(cut), np.nan]
        # float32(0.1000000001) is above the float64 cut; no re-rounding cut.
        self.assertGreater(float(w['D_original'][2]), cut)
        s = C.recount(w, plan['pilot'], base, cut, 200000)
        self.assertEqual(s['state_counts'], {'0': 2, '1': 1, '-1': 1})
        changed = {k: v.copy() for k, v in w.items()}
        changed['D_original'][1] = np.float32(0.0)
        self.assertNotEqual(s['array_sha256']['D_original'], C.recount(changed, plan['pilot'], base, cut, 200000)['array_sha256']['D_original'])

    def test_inf_and_state_tamper(self):
        for value in (np.inf, -np.inf):
            plan, w, _, base, _ = fixture()
            w['D_original'][0] = value
            with self.assertRaises(ValueError):
                C.recount(w, plan['pilot'], base, 0.0, 200000)
        plan, w, _, base, _ = fixture()
        w['main_state'][0] = 0
        with self.assertRaises(ValueError):
            C.recount(w, plan['pilot'], base, 0.0, 200000)

    def test_schema_order_and_maturity_refusals(self):
        def run_mutation(mutate):
            plan, w, cohort, base, result = fixture()
            mutate(plan, w)
            with self.assertRaises(ValueError):
                C.verify_saved(plan, result, w, cohort, base, 0.0)
        cases = [lambda p, w: w['main_index'].__setitem__(1, w['main_index'][0]),
                 lambda p, w: w['main_label_end'].__setitem__(0, w['main_label_end'][0] + 1),
                 lambda p, w: w['main_label_end'].__setitem__(-1, p['pilot']['current_cutoff'] + 3600),
                 lambda p, w: w['unknown_partition'].__setitem__(1, 0),
                 lambda p, w: p['pilot'].__setitem__('previous_cutoff', p['pilot']['previous_cutoff'] - 3600),
                 lambda p, w: w.__setitem__('main_index', w['main_index'].astype('<i4')),
                 lambda p, w: w.__setitem__('extra', np.array([], dtype='i1')),
                 lambda p, w: p.__setitem__('row_capacity', 3)]
        for mutate in cases:
            run_mutation(mutate)

    def test_dropped_reordered_changed_bits_and_summary(self):
        for kind in ('drop', 'reorder', 'bits', 'count', 'extrema', 'hash'):
            plan, w, cohort, base, result = fixture()
            if kind == 'drop':
                w = {k: v[:-1] for k, v in w.items()}
            elif kind == 'reorder':
                w = {k: v[::-1] for k, v in w.items()}
            elif kind == 'bits':
                w['D_original'].view('<u4')[0] = 0x7fc00001
            elif kind == 'count':
                result['summary']['rows'] += 1
            elif kind == 'extrema':
                result['summary']['unknown']['all']['min'] += 3600
            else:
                result['membership_sha256'] = '0' * 64
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                C.verify_saved(plan, result, w, cohort, base, 0.0)

    def test_known_sentinel_and_unknown_domain(self):
        plan, w, _, base, _ = fixture((0, 1, 0, 1))
        w['unknown_partition'][0] = 0
        with self.assertRaises(ValueError):
            C.recount(w, plan['pilot'], base, 0.0, 200000)
        w['unknown_partition'][0] = -1
        w['main_state'][0] = 3
        with self.assertRaises(ValueError):
            C.recount(w, plan['pilot'], base, 0.0, 200000)

    def test_guards_install_restore_and_refuse(self):
        class P:
            def har_coef(self): return 'not called'
            def fh_w(self): return 'not called'
        a = types.SimpleNamespace(Prep6=P)
        b = types.SimpleNamespace(fhs_predict=lambda: 'not called')
        original = P.har_coef
        with C.prohibit_models(a, b):
            for func in (P.har_coef, P.fh_w, b.fhs_predict, np.linalg.solve, np.linalg.lstsq):
                with self.assertRaises(RuntimeError): func()
        self.assertIs(P.har_coef, original)


class SavedFileCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_pin_corruption_and_symlinks(self):
        p = self.root / 'p'
        p.write_bytes(b'abc')
        pin = sha(p)
        C.pin_bytes(pin)
        p.write_bytes(b'abd')
        with self.assertRaises(ValueError): C.pin_bytes(pin)
        link = self.root / 'link'
        link.symlink_to(p)
        with self.assertRaises(ValueError): C.pin_bytes(sha(link))

    def test_duplicate_json_keys(self):
        p = self.root / 'p.json'
        p.write_text('{"a":1,"a":2}')
        with self.assertRaises(ValueError): C.read_json(p)

    def test_typed_archive_header(self):
        _, w, _, _, _ = fixture()
        p = self.root / 'w.npz'
        np.savez_compressed(p, **w)
        C.witness_header_check(p, 200000)
        with self.assertRaises(ValueError): C.witness_header_check(p, 3)
        w['D_original'] = w['D_original'].astype('f8')
        np.savez_compressed(p, **w)
        with self.assertRaises(ValueError): C.witness_header_check(p, 200000)

    def make_saved(self):
        plan, w, cohort, base, result = fixture()
        out = self.root / 'out'
        out.mkdir()
        plan.update(out=str(out), roles={'audit': {'example': 'source'}, 'checker': {'example': 'checker'}}, files=[])
        planfile = self.root / 'plan.json'
        planpin = write(planfile, plan)
        started = write(out / 'started.json', {'schema': 'q26-fh-date-support-started-v1',
                        'plan_sha256': planpin['sha256'], 'reconstruction': True})
        np.savez_compressed(out / 'witness.npz', **w)
        result.update(plan_sha256=planpin['sha256'], source=plan['roles']['audit'],
                      started=started, witness=sha(out / 'witness.npz'))
        write(out / 'result.json', result)
        return planfile, planpin['sha256'], out, cohort, base

    def test_mocked_pipeline_saves_exclusive_receipt(self):
        p, h, out, cohort, base = self.make_saved()
        receipt = self.root / 'receipt.json'
        with mock.patch.object(C, 'authenticate', return_value='metadata') as auth, mock.patch.object(C, 'reconstruct', return_value=(cohort, base, 0.0)):
            answer = C.run(p, h, out / 'result.json', receipt)
            self.assertTrue(answer['complete'])
            auth.assert_called_once()
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError): C.run(p, h, out / 'result.json', receipt)
        self.assertEqual(set(x.name for x in out.iterdir()), {'started.json', 'witness.npz', 'result.json'})

    def test_wrong_plan_extra_missing_output_or_receipt_location(self):
        for kind in ('plan', 'extra', 'missing', 'receipt_in', 'witness_symlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as tmp:
                original = self.root
                self.root = Path(tmp)
                p, h, out, cohort, base = self.make_saved()
                receipt = self.root / 'receipt.json'
                if kind == 'plan': h = '0' * 64
                elif kind == 'extra': (out / 'extra').write_text('stale')
                elif kind == 'missing': (out / 'started.json').unlink()
                elif kind == 'receipt_in': receipt = out / 'receipt.json'
                else:
                    destination = self.root / 'elsewhere.npz'
                    (out / 'witness.npz').rename(destination)
                    (out / 'witness.npz').symlink_to(destination)
                with mock.patch.object(C, 'authenticate', return_value='metadata'), mock.patch.object(C, 'reconstruct', return_value=(cohort, base, 0.0)), self.assertRaises(ValueError):
                    C.run(p, h, out / 'result.json', receipt)
                self.assertFalse(receipt.exists())
                self.root = original

    def authority_fixture(self, raw_change=None):
        roles = {}
        def role(name, data):
            roles[name] = write(self.root / (name + '.json'), data)
            return roles[name]
        archive = role('archive', {'no': 'real array'})
        helper = role('staging_producer', {'no': 'executed source'})
        census = role('census', {'no': 'executed source'})
        audit = role('audit', {'no': 'executed source'})
        executable = role('synthetic_executable', {'no': 'execution'})
        rawpin = role('rawfile', {'no': 'real grid'})
        rawpins = [rawpin] + [role('rawfile' + str(i), {'no': 'real grid'}) for i in range(29)]
        native = role('native', {'no': 'library load'})
        legacy = role('legacy', {'no': 'source load'})
        legacypins = {'legacy.py': legacy, **{'legacy' + str(i) + '.py': role('legacy' + str(i), {'no': 'source load'}) for i in range(29)}}
        pilot = fixture()[0]['pilot']
        role('private_lineage', {'private_pilot': {'sid': pilot['sid'], 'key': pilot['key'],
             'current_cutoff': pilot['current_cutoff'], 'predecessor_cutoff': pilot['previous_cutoff']}})
        raw_records = [dict(p, relative=Path(p['path']).name) for p in rawpins]
        if raw_change is not None:
            raw_records[0].update(raw_change)
        role('raw_authority', {'base_scope': {'price_inputs': raw_records, 'auxiliary_inputs': [],
              'datasets': str(self.root), 'canonical_keys': [pilot['key']]}})
        role('fit_scope', {'source_sha256': {k: v['sha256'] for k, v in legacypins.items()}, 'runtime_native_pins': [native]})
        role('staging_request', {'schema': 'codex-r17-staging-request-v1', 'pins': {'fit_scope': roles['fit_scope'], 'raw_scope': roles['raw_authority'], 'helper': helper},
             'status': 'READY_PARENT_REVIEWED', 'source_commit': 'SYNTHETIC', 'selected': [[pilot['sid'], pilot['key']]],
             'required_raw_paths': [p['path'] for p in rawpins], 'protocol': 'SYNTHETIC'})
        role('manifest', {'schema': 'codex-r17-staged-inputs-v1', 'complete': True, 'canonical_mapping': [[pilot['sid'], pilot['key']]],
             'outputs': [archive], 'request_protocol': 'SYNTHETIC'})
        role('cuts', {'schema': 'r17-conditional-depth-cuts-v1', 'complete': True, 'phase': 'cuts',
             'input_pins': {'24': archive}, 'request_pins': {'manifest': roles['manifest']},
             'horizons': {'24': {'downside_imbalance_D': {'cut': 0.0}}}})
        ancestry = {'archive': archive, 'manifest': roles['manifest'], 'staging_request': roles['staging_request'], 'producer': helper}
        role('ancestor_request', {'schema': 'q26-fh-state-census-request-v1', 'pins': {**ancestry, 'cuts': roles['cuts'], 'runner': census}})
        role('trial_request', {'schema': 'q26-fh-missingness-trial-request-v1', 'pins': {**ancestry, 'cuts': roles['cuts'], 'census_source': census}})
        roles['checker'] = sha(Path(C.__file__).absolute())
        plan = {'schema': 'q26-fh-date-support-plan-v1', 'parent_admitted': True,
                'mode': C.MODE, 'row_capacity': 200000, 'pilot': pilot, 'roles': roles,
                'files': list(roles.values()), 'source_commit': 'a' * 40, 'out': str(self.root / 'out'),
                'legacy_sources': legacypins, 'runtime': {'executable': executable}}
        return plan

    def test_real_authentication_metadata_without_private_decode(self):
        plan = self.authority_fixture()
        with mock.patch.object(C, 'runtime_check'), mock.patch.object(C.np, 'load') as decode:
            metadata = C.authenticate(plan, 'a' * 64)
            self.assertEqual(metadata[-1], 0.0)
            self.assertIn('relative', metadata[1]['price_inputs'][0])
            self.assertEqual(set(metadata[1]['price_inputs'][0]), {'path', 'relative', 'size', 'sha256'})
        decode.assert_not_called()

    def test_raw_authority_wrong_hash_or_path_refused(self):
        for change in ({'sha256': '0' * 64}, {'path': str(self.root / 'wrong-grid.json')}):
            plan = self.authority_fixture(raw_change=change)
            with self.subTest(change=change), mock.patch.object(C, 'runtime_check'), mock.patch.object(C.np, 'load') as decode, self.assertRaisesRegex(ValueError, 'required raw closure'):
                C.authenticate(plan, 'a' * 64)
            decode.assert_not_called()

    def test_authority_closure_refusals_before_decode(self):
        plan = self.authority_fixture()
        for kind in ('native', 'source', 'pilot', 'role', 'unadmitted'):
            changed = copy.deepcopy(plan)
            if kind == 'native':
                changed['files'] = [p for p in changed['files'] if p != changed['roles']['native']]
                # Keep nonrequired alias out of roles to exercise native closure itself.
                changed['roles'].pop('native')
            elif kind == 'source':
                changed['legacy_sources'] = {}
            elif kind == 'pilot':
                changed['pilot']['previous_cutoff'] -= 3600
            elif kind == 'role':
                changed['roles']['archive'] = dict(changed['roles']['archive'], sha256='0' * 64)
            else:
                changed['parent_admitted'] = False
            with self.subTest(kind=kind), mock.patch.object(C, 'runtime_check'), mock.patch.object(C.np, 'load') as decode, self.assertRaises(ValueError):
                C.authenticate(changed, 'a' * 64)
            decode.assert_not_called()

    def test_auth_failure_before_private_decode(self):
        p, h, out, _, _ = self.make_saved()
        with mock.patch.object(C, 'authenticate', side_effect=ValueError('pin closure')), mock.patch.object(C.np, 'load') as decode, self.assertRaises(ValueError):
            C.run(p, h, out / 'result.json', self.root / 'receipt.json')
        decode.assert_not_called()


if __name__ == '__main__':
    unittest.main()
