"""Synthetic-only adversarial qualification for saved baseline replay checks."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

_SPEC = importlib.util.spec_from_file_location('baseline_checker', Path(__file__).with_name('r164_baseline_replay_check.py'))
C = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(C)


def small():
    key = 'blind5:synthetic'
    rows = [dict(i0=10, T=24, k=k, p_garch=.25 + k * .125) for k in range(2)]
    old = dict(series=key, rows=rows, quarter_fits=1)
    new = dict(series=key, rows=[dict(series=key, i0=r['i0'], T=r['T'], k=r['k'], p_replay=r['p_garch']) for r in rows])
    state = dict(series=key, complete=True, quarters=[dict(quarter=5)], origins=[dict(origin=10, quarter=5)])
    return key, new, old, state


class SeriesTests(unittest.TestCase):
    def setUp(self):
        self.key, self.new, self.old, self.state = small()

    def rejects(self):
        with self.assertRaises((ValueError, KeyError, TypeError)):
            C.check_series(self.key, self.new, self.old, self.state)

    def test_exact_success(self):
        self.assertEqual(C.check_series(self.key, self.new, self.old, self.state),
                         dict(quarters=1, origins=1, historical_rows=2))

    def test_one_ulp_rejected(self):
        import math
        self.new['rows'][0]['p_replay'] = math.nextafter(.25, 1.)
        self.rejects()

    def test_nonfinite_null_boolean_and_integer_rejected(self):
        for value in (float('nan'), float('inf'), None, True, 0, -.01, 1.01):
            with self.subTest(value=value):
                self.new['rows'][0]['p_replay'] = value
                self.rejects()

    def test_historical_invalid_rejected(self):
        self.old['rows'][0]['p_garch'] = None
        self.rejects()

    def test_duplicate_rejected(self):
        self.new['rows'][1] = copy.deepcopy(self.new['rows'][0])
        self.old['rows'][1] = copy.deepcopy(self.old['rows'][0])
        self.rejects()

    def test_missing_extra_rejected(self):
        self.new['rows'].pop()
        self.rejects()
        self.new['rows'] += [self.new['rows'][0], self.new['rows'][0]]
        self.rejects()

    def test_extra_and_missing_fields_rejected(self):
        self.new['rows'][0]['epsilon'] = 1e-12
        self.rejects()
        del self.new['rows'][0]['epsilon']
        del self.new['rows'][0]['k']
        self.rejects()

    def test_wrong_horizon_depth_origin_and_identity_rejected(self):
        for field, value in [('T', 72), ('T', 3), ('k', 2), ('k', -1), ('k', True), ('i0', 11), ('series', 'other')]:
            with self.subTest(field=field, value=value):
                _, self.new, _, _ = small()
                self.new['rows'][0][field] = value
                self.rejects()

    def test_reordered_rows_rejected(self):
        self.new['rows'].reverse()
        self.rejects()

    def test_state_support_rejected(self):
        for mutate in (lambda s: s['origins'].clear(), lambda s: s['quarters'].append(dict(quarter=6)),
                       lambda s: s['origins'][0].update(quarter=6), lambda s: s.update(series='wrong')):
            with self.subTest(mutate=mutate):
                _, _, _, self.state = small()
                mutate(self.state)
                self.rejects()


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def save(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, allow_nan=False))
        return dict(path=str(path), sha256=C.digest(path), size=path.stat().st_size)

    def fixture(self):
        raw = self.root / 'datasets/blind5-prices'
        historical = self.root / 'historical'
        states = self.root / 'states'
        outputs = self.root / 'outputs'
        pins, state_hashes, entries = [], {}, []
        quarter_total = origin_total = row_total = 0
        for index in range(42):
            key = 'blind5:synthetic%02d' % index
            name = key.replace(':', '-') + '.json'
            nq = 20 if index < 8 else 19
            no = 63 if index < 15 else 62
            origins = []
            rows = []
            for j in range(no):
                origin = 100 + j
                quarter = 100 + (j * nq // no)
                origins.append(dict(origin=origin, quarter=quarter))
                count = 40 if origin_total < 2169 else 39
                origin_total += 1
                for k in range(count):
                    rows.append(dict(i0=origin, T=24, k=k, p_garch=.25))
            quarter_total += nq
            row_total += len(rows)
            old_record = self.save(historical / name, dict(result=dict(series=key, rows=rows, quarter_fits=nq)))
            pins.append(old_record)
            state_record = self.save(states / name, dict(series=key, complete=True, origins=origins,
                quarters=[dict(quarter=q) for q in sorted({s['quarter'] for s in origins})],
                historical_checkpoint_sha256=old_record['sha256']))
            pins.append(state_record)
            state_hashes[name] = state_record['sha256']
            replay_record = self.save(outputs / name, dict(series=key, rows=[dict(series=key,
                i0=r['i0'], T=r['T'], k=r['k'], p_replay=r['p_garch']) for r in rows]))
            entries.append(dict(series=key, path=name, sha256=replay_record['sha256'], size=replay_record['size']))
            pins.append(self.save(raw / (name + '.raw'), {'synthetic': True}))
            pins.append(self.save(self.root / 'datasets/history-forecasts/r16/r164-dev-63d4700f/rows' / (Path(name).stem + '.npz'), {'synthetic_npz_pin_only': True}))
        self.assertEqual((quarter_total, origin_total, row_total), (806, 2619, 104310))
        runtime = {'synthetic': True}
        state_plan = dict(pin=C.PIN, horizons=C.CONSTANTS['horizons'], runtime=runtime,
                          files={r['path']: r['sha256'] for r in pins if '/states/' not in r['path']},
                          datasets=str(self.root / 'datasets'), historical=str(historical))
        sp = self.save(self.root / 'state-plan.json', state_plan)
        sm = self.save(states / 'manifest.json', dict(complete=True, plan=state_plan, plan_sha256=sp['sha256'],
                            n_quarters=806, n_origins=2619, output_sha256=state_hashes))
        sa = self.save(self.root / 'acceptance.json', dict(complete=True, plan_sha256=sp['sha256'],
                        manifest_sha256=sm['sha256'], series=42, quarters=806, origins=2619, historical_rows=104310))
        oc = self.save(self.root / 'original-config.json', dict(config=dict(paths=1000, origin_every=28,
            pin='f9389b6', collection='blind5-prices', selected_series=[e['series'] for e in entries],
            inputs={e['series']: next(p['sha256'] for p in pins if p['path'].endswith(Path(e['path']).stem + '.npz')) for e in entries}, sources={})))
        authorities = dict(state_plan=sp, state_manifest=sm, state_acceptance=sa, original_config=oc)
        pins.extend(authorities.values())
        source = Path(C.__file__).resolve()
        pins.append(dict(path=str(source), sha256=C.digest(source), size=source.stat().st_size))
        producer = source.with_name('r164_baseline_replay.py')
        pins.append(dict(path=str(producer), sha256=C.digest(producer), size=producer.stat().st_size))
        plan = dict(schema='q26-r164-baseline-replay-plan-v1', constants=C.CONSTANTS, runtime=runtime,
                    source_commit='a' * 40, output_dir=str(outputs), files=pins, authorities=authorities)
        pp = self.save(self.root / 'plan.json', plan)
        manifest = dict(schema='q26-r164-baseline-replay-manifest-v1', complete=True, plan_sha256=pp['sha256'],
                        series=42, quarters=806, origins=2619, historical_rows=104310, series_files=entries)
        started = self.save(outputs / 'started.json', dict(schema=manifest['schema'], complete=False, plan_sha256=pp['sha256']))
        manifest['started_file'] = dict(path='started.json', sha256=started['sha256'], size=started['size'])
        mp = self.save(outputs / 'manifest.json', manifest)
        self.save(outputs / 'started.json', dict(schema=manifest['schema'], complete=False, plan_sha256=pp['sha256']))
        return pp, mp, plan, manifest

    def execute(self, pp, mp):
        with mock.patch.object(C, 'runtime_identity', return_value={'synthetic': True}):
            return C.check(pp['path'], Path(mp['path']).parent, pp['sha256'], mp['sha256'])

    def test_full_104310_synthetic_support_and_receipt(self):
        pp, mp, _, _ = self.fixture()
        out = self.root / 'receipt.json'
        with mock.patch.object(C, 'runtime_identity', return_value={'synthetic': True}):
            result = C.run_to_receipt(pp['path'], Path(mp['path']).parent, pp['sha256'], mp['sha256'], out)
        self.assertTrue(result['exact_probability_parity_verified'])
        self.assertEqual(result['historical_rows'], 104310)
        self.assertEqual(result['original_blind_a'], 'NOT RUN')
        self.assertLess(out.stat().st_size, 65536)
        self.assertFalse(result['simulation_independently_reexecuted'])

    def test_plan_hash_before_decode(self):
        path = self.root / 'invalid.json'
        path.write_text('not json')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            C.check(path, self.root, '0' * 64, '0' * 64)

    def test_manifest_hash_before_decode(self):
        pp, mp, _, _ = self.fixture()
        Path(mp['path']).write_text('not json')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.execute(pp, mp)

    def test_stale_input_hash(self):
        pp, mp, plan, _ = self.fixture()
        Path(plan['files'][0]['path']).write_text('{}')
        with self.assertRaises(ValueError):
            self.execute(pp, mp)

    def test_authority_drift(self):
        pp, mp, plan, _ = self.fixture()
        Path(plan['authorities']['state_acceptance']['path']).write_text('{}')
        with self.assertRaises(ValueError):
            self.execute(pp, mp)

    def test_final_recheck_catches_mutation(self):
        pp, mp, plan, _ = self.fixture()
        original = C.check_series
        once = []
        def mutate(*args):
            result = original(*args)
            if not once:
                once.append(True)
                Path(plan['authorities']['original_config']['path']).write_text('{}')
            return result
        with mock.patch.object(C, 'check_series', side_effect=mutate):
            with self.assertRaises(ValueError):
                self.execute(pp, mp)

    def test_extra_inventory_rejected(self):
        pp, mp, _, _ = self.fixture()
        (Path(mp['path']).parent / 'extra.json').write_text('{}')
        with self.assertRaises(ValueError):
            self.execute(pp, mp)

    def test_executing_checker_pin_required(self):
        pp, mp, plan, _ = self.fixture()
        plan['files'] = [r for r in plan['files'] if r['path'] != str(Path(C.__file__).resolve())]
        pp = self.save(Path(pp['path']), plan)
        with self.assertRaisesRegex(ValueError, 'executing checker'):
            self.execute(pp, mp)

    def test_sibling_producer_pin_required(self):
        pp, mp, plan, _ = self.fixture()
        producer = str(Path(C.__file__).resolve().with_name('r164_baseline_replay.py'))
        plan['files'] = [r for r in plan['files'] if r['path'] != producer]
        pp = self.save(Path(pp['path']), plan)
        with self.assertRaisesRegex(ValueError, 'sibling replay producer'):
            self.execute(pp, mp)

    def test_started_marker_hash_required(self):
        pp, mp, _, _ = self.fixture()
        (Path(mp['path']).parent / 'started.json').write_text('{}')
        with self.assertRaises(ValueError):
            self.execute(pp, mp)

    def test_final_plan_mutation_rejected(self):
        pp, mp, _, _ = self.fixture()
        original = C.check_series
        once = []
        def mutate(*args):
            result = original(*args)
            if not once:
                once.append(True)
                Path(pp['path']).write_text('{}')
            return result
        with mock.patch.object(C, 'check_series', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'authority changed'):
                self.execute(pp, mp)

    def test_final_output_mutation_rejected(self):
        pp, mp, _, manifest = self.fixture()
        original = C.check_series
        once = []
        def mutate(*args):
            result = original(*args)
            if not once:
                once.append(True)
                (Path(mp['path']).parent / manifest['series_files'][0]['path']).write_text('{}')
            return result
        with mock.patch.object(C, 'check_series', side_effect=mutate):
            with self.assertRaises(ValueError):
                self.execute(pp, mp)

    def test_duplicate_json_key_rejected(self):
        path = self.root / 'duplicate.json'
        path.write_text('{"x":1,"x":2}')
        with self.assertRaisesRegex(ValueError, 'duplicate JSON'):
            C.read_json(path, C.digest(path))

    def test_symlink_rejected(self):
        path = self.root / 'real'
        path.write_text('{}')
        link = self.root / 'link'
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            C.digest(link)

    def test_existing_receipt_refused_before_reads(self):
        out = self.root / 'receipt.json'
        out.write_text('keep')
        with mock.patch.object(C, 'check', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(ValueError, 'already exists'):
                C.run_to_receipt('missing', self.root, 'x', 'y', out)
        self.assertEqual(out.read_text(), 'keep')

    def test_receipt_inside_producer_refused_before_reads(self):
        with mock.patch.object(C, 'check', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(ValueError, 'outside producer'):
                C.run_to_receipt('missing', self.root, 'x', 'y', self.root / 'receipt.json')


if __name__ == '__main__':
    unittest.main()
