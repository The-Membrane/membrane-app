"""Synthetic admission only; the qualified delegated observer retains process tests."""
import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().with_name('q26-baseline-replay-observer.py')
spec = importlib.util.spec_from_file_location('baseline_observer_test', SOURCE)
B = importlib.util.module_from_spec(spec)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), vars(B))


class Admission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.output = self.root / 'output'
        self.receipt = self.root / 'terminal.json'
        self.request = self.root / 'request.json'
        self.plan_path = self.root / 'plan.json'
        source_paths = []
        for name in B.SOURCES:
            path = self.root / name
            path.write_text('# synthetic never launched\n')
            source_paths.append(path)
        self.runner = self.root / B.SOURCES[0]
        self.sources = [B.pin(p) for p in source_paths + [SOURCE, Path(B.A.__file__), Path(B.A.S.__file__), Path(B.O.__file__)]]
        self.runtime = {'synthetic': True}
        state = dict(pin='f9389b68ee1a4a94417a9311bc42dc974b4613fd', horizons=[24, 72, 168, 720], runtime=self.runtime, files={q['path']: q['sha256'] for q in self.sources})
        self.state_path = self.root / 'state-plan.json'
        self.write(self.state_path, state)
        state_root = self.root / 'states'
        state_root.mkdir()
        outputs = {}
        state_records = []
        for i in range(42):
            path = state_root / ('blind5-synthetic-%d.json' % i)
            self.write(path, {'synthetic': i})
            q = B.pin(path)
            state_records.append(q)
            outputs[path.name] = q['sha256']
        self.manifest_path = state_root / 'manifest.json'
        self.write(self.manifest_path, dict(complete=True, plan=state, plan_sha256=B.pin(self.state_path)['sha256'], n_quarters=806, n_origins=2619, output_sha256=outputs))
        self.accept_path = self.root / 'acceptance.json'
        self.write(self.accept_path, dict(complete=True, plan_sha256=B.pin(self.state_path)['sha256'], manifest_sha256=B.pin(self.manifest_path)['sha256'], series=42, quarters=806, origins=2619, historical_rows=104310))
        self.config_path = self.root / 'config.json'
        self.write(self.config_path, dict(config=dict(paths=1000, origin_every=28, pin='f9389b6', collection='blind5-prices')))
        authorities = {name: B.pin(path) for name, path in [('state_plan', self.state_path), ('state_manifest', self.manifest_path), ('state_acceptance', self.accept_path), ('original_config', self.config_path)]}
        self.plan = dict(schema=B.PLAN_SCHEMA, authorities=authorities, files=self.sources + state_records + list(authorities.values()), source_commit='a' * 40, runtime=self.runtime, constants=copy.deepcopy(B.CONSTANTS), output_dir=str(self.output))
        self.write(self.plan_path, self.plan)
        self.r = dict(schema=B.SCHEMA, kind='producer', fixture_only=False, policy=dict(B.POLICY), invocation_python=sys.executable,
                      resolved_python=str(Path(sys.executable).resolve()), python_pin=B.pin(Path(sys.executable).resolve()),
                      source_pins=self.sources, plan=B.pin(self.plan_path), runner=B.pin(self.runner), output=str(self.output))
        self.argv()
        self.disk = patch.object(B.O.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 10 * 1024**3})())
        self.disk.start()
        self.addCleanup(self.disk.stop)

    def write(self, path, value): path.write_text(json.dumps(value))
    def argv(self):
        self.r['argv'] = [self.r['invocation_python'], '-B', self.r['runner']['path'], '--plan', self.r['plan']['path']]
        if self.r['kind'] == 'producer':
            self.r['argv'] += ['--plan-sha256', self.r['plan']['sha256'], '--output-dir', self.r['output']]
        else:
            self.r['argv'] += ['--output-dir', self.r['producer_root'], '--plan-sha256', self.r['plan']['sha256'], '--manifest-sha256', self.r['producer_manifest']['sha256'], '--out', self.r['output']]
    def update_plan(self):
        self.write(self.plan_path, self.plan)
        self.r['plan'] = B.pin(self.plan_path)
        self.argv()
    def admit(self):
        self.write(self.request, self.r)
        return B.preflight(str(self.request), B.pin(self.request)['sha256'], str(self.receipt))
    def reject(self, mutate):
        mutate()
        with self.assertRaises((ValueError, TypeError, KeyError)): self.admit()
    def reject_plan(self, mutate):
        mutate()
        self.update_plan()
        with self.assertRaises((ValueError, TypeError, KeyError)): self.admit()
    def saved(self):
        self.producer_request_path = self.root / 'producer-request.json'
        self.write(self.producer_request_path, self.r)
        self.terminal_path = self.root / 'producer-terminal.json'
        self.terminal = dict(complete=True, tool_terminal_exit=0, errors=[], process_terminal=True,
            observer_timeout=False, reason=None, containment=dict(reaped=True,
            no_live_members_remaining=True, remaining_live_members=[]), request=B.pin(self.producer_request_path), runner=self.r['runner'])
        self.write(self.terminal_path, self.terminal)
        self.output.mkdir()
        path = self.output / 'manifest.json'
        self.write(path, dict(schema='q26-r164-baseline-replay-manifest-v1', complete=True, plan_sha256=self.r['plan']['sha256'], series=42, quarters=806, origins=2619, historical_rows=104310))
        self.r.update(kind='saved_check', producer_root=str(self.output), producer_manifest=B.pin(path), producer_terminal=B.pin(self.terminal_path), runner=B.pin(self.root / B.SOURCES[1]), output=str(self.root / 'check.json'))
        self.r['policy']['wall_seconds'] = 180
        self.argv()

    def test_producer(self): self.assertEqual(self.admit()[2], self.output)
    def test_saved_checker(self):
        self.saved()
        self.admit()
    def test_unknown_field(self): self.reject(lambda: self.r.update(extra=True))
    def test_schema(self): self.reject(lambda: self.r.update(schema='other'))
    def test_kind(self): self.reject(lambda: self.r.update(kind='cap'))
    def test_fixture_explicit(self): self.reject(lambda: self.r.pop('fixture_only'))
    def test_fixture_boolean(self): self.reject(lambda: self.r.update(fixture_only=1))
    def test_python_pin(self): self.reject(lambda: self.r['python_pin'].update(sha256='0' * 64))
    def test_python_resolution(self): self.reject(lambda: self.r.update(resolved_python='/wrong/python'))
    def test_runner_pin(self): self.reject(lambda: self.r['runner'].update(size=1))
    def test_plan_pin(self): self.reject(lambda: self.r['plan'].update(sha256='0' * 64))
    def test_source_pin(self): self.reject(lambda: self.r['source_pins'][0].update(sha256='0' * 64))
    def test_missing_adapter_pin(self): self.reject(lambda: self.r['source_pins'].pop(-3))
    def test_duplicate_source(self): self.reject(lambda: self.r['source_pins'].append(self.r['source_pins'][0]))
    def test_argv_extra(self): self.reject(lambda: self.r['argv'].append('--cap'))
    def test_argv_hash(self): self.reject(lambda: self.r['argv'].__setitem__(6, '0' * 64))
    def test_argv_order(self): self.reject(lambda: self.r['argv'].reverse())
    def test_output_binding(self): self.reject(lambda: self.r.update(output=str(self.root / 'other')))
    def test_policy_extension(self): self.reject(lambda: self.r['policy'].update(extra=1))
    def test_policy_wall(self): self.reject(lambda: self.r['policy'].update(wall_seconds=1201))
    def test_policy_boolean(self): self.reject(lambda: self.r['policy'].update(output_bytes=True))
    def test_policy_rss(self): self.reject(lambda: self.r['policy'].update(rss_bytes=1024**3))
    def test_tiny_fixture(self):
        self.r.update(fixture_only=True)
        self.r['policy']['wall_seconds'] = .1
        self.admit()
    def test_fixture_big_wall(self): self.reject(lambda: (self.r.update(fixture_only=True), self.r['policy'].update(wall_seconds=3)))
    def test_fixture_cannot_raise_memory(self): self.reject(lambda: (self.r.update(fixture_only=True), self.r['policy'].update(wall_seconds=1, rss_bytes=1024**3)))
    def test_plan_list_required(self): self.reject_plan(lambda: self.plan.update(files={q['path']: q['sha256'] for q in self.plan['files']}))
    def test_plan_schema(self): self.reject_plan(lambda: self.plan.update(schema='old'))
    def test_plan_extra(self): self.reject_plan(lambda: self.plan.update(extra=True))
    def test_plan_scope(self): self.reject_plan(lambda: self.plan['constants'].update(expected_rows=1))
    def test_plan_boolean(self): self.reject_plan(lambda: self.plan['constants'].update(paths=True))
    def test_plan_duplicate(self): self.reject_plan(lambda: self.plan['files'].append(self.plan['files'][0]))
    def test_plan_missing_source(self): self.reject_plan(lambda: self.plan['files'].pop(1))
    def test_plan_missing_authority(self): self.reject_plan(lambda: self.plan['files'].pop(-1))
    def test_plan_input_hash(self): self.reject_plan(lambda: self.plan['files'][-1].update(sha256='0' * 64))
    def test_plan_authority_role(self): self.reject_plan(lambda: self.plan['authorities'].pop('original_config'))
    def test_plan_missing_state_output(self): self.reject_plan(lambda: self.plan['files'].pop(len(self.sources)))
    def test_plan_commit(self): self.reject_plan(lambda: self.plan.update(source_commit='z' * 40))
    def test_stale_output(self):
        self.output.mkdir()
        with self.assertRaises(ValueError): self.admit()
    def test_each_stale_evidence(self):
        for suffix in ('', '.start.json', '.stdout.log', '.stderr.log', '.sampling.json', '.post-containment.json'):
            with self.subTest(suffix=suffix):
                p = Path(str(self.receipt) + suffix)
                p.touch()
                with self.assertRaises(ValueError): self.admit()
                p.unlink()
    def test_output_symlink(self):
        self.output.symlink_to(self.root / 'missing')
        with self.assertRaises(ValueError): self.admit()
    def test_wrong_parent(self):
        self.receipt = self.root.parent / 'terminal.json'
        with self.assertRaises(ValueError): self.admit()
    def test_disk_reserve(self):
        with patch.object(B.O.shutil, 'disk_usage', return_value=type('Disk', (), {'free': B.POLICY['disk_reserve_bytes'] - 1})()):
            with self.assertRaises(ValueError): self.admit()
    def test_request_hash(self):
        self.write(self.request, self.r)
        with self.assertRaises(ValueError): B.preflight(str(self.request), '0' * 64, str(self.receipt))
    def test_saved_root_readonly(self):
        self.saved()
        self.r['output'] = str(self.output / 'checker.json')
        self.receipt = self.output / 'terminal.json'
        self.argv()
        with self.assertRaises(ValueError): self.admit()
    def test_saved_manifest_binding(self):
        self.saved()
        other = self.root / 'other.json'
        self.write(other, {'complete': True, 'plan_sha256': self.r['plan']['sha256']})
        self.reject(lambda: self.r.update(producer_manifest=B.pin(other)))
    def test_saved_partial_rejected(self):
        self.saved()
        path = Path(self.r['producer_manifest']['path'])
        self.write(path, {'complete': False, 'plan_sha256': self.r['plan']['sha256']})
        self.r['producer_manifest'] = B.pin(path)
        self.argv()
        with self.assertRaises(ValueError): self.admit()
    def terminal_change(self, mutate):
        self.saved()
        mutate(self.terminal)
        self.write(self.terminal_path, self.terminal)
        self.r['producer_terminal'] = B.pin(self.terminal_path)
        with self.assertRaises((ValueError, KeyError)): self.admit()
    def test_saved_missing_terminal(self):
        self.saved()
        self.reject(lambda: self.r.pop('producer_terminal'))
    def test_saved_terminal_failed(self): self.terminal_change(lambda t: t.update(complete=False))
    def test_saved_terminal_exit(self): self.terminal_change(lambda t: t.update(tool_terminal_exit=1))
    def test_saved_terminal_errors(self): self.terminal_change(lambda t: t.update(errors=['sample']))
    def test_saved_terminal_unreaped(self): self.terminal_change(lambda t: t['containment'].update(reaped=False))
    def test_saved_terminal_unknown_live(self): self.terminal_change(lambda t: t['containment'].update(no_live_members_remaining=None))
    def test_saved_terminal_live(self): self.terminal_change(lambda t: t['containment'].update(remaining_live_members=[1]))
    def test_saved_terminal_timeout(self): self.terminal_change(lambda t: t.update(observer_timeout=True))
    def previous_change(self, mutate):
        self.saved()
        previous = json.loads(self.producer_request_path.read_text())
        mutate(previous)
        self.write(self.producer_request_path, previous)
        self.terminal['request'] = B.pin(self.producer_request_path)
        self.write(self.terminal_path, self.terminal)
        self.r['producer_terminal'] = B.pin(self.terminal_path)
        with self.assertRaises((ValueError, KeyError)): self.admit()
    def test_saved_wrong_producer_plan(self): self.previous_change(lambda p: p['plan'].update(sha256='0'*64))
    def test_saved_wrong_producer_output(self): self.previous_change(lambda p: p.update(output=str(self.root/'other')))
    def test_saved_wrong_producer_argv(self): self.previous_change(lambda p: p['argv'].append('--cap'))
    def test_saved_wrong_producer_policy(self): self.previous_change(lambda p: p['policy'].update(wall_seconds=1201))
    def test_saved_manifest_support(self):
        self.saved()
        path=Path(self.r['producer_manifest']['path'])
        value=json.loads(path.read_text())
        value['historical_rows']=1
        self.write(path,value)
        self.r['producer_manifest']=B.pin(path)
        self.argv()
        with self.assertRaises(ValueError): self.admit()
    def test_delegate_restore_success(self):
        original = B.A.preflight
        def delegate(*args, **kwargs):
            self.assertIs(B.A.preflight, B.preflight)
            return {'complete': True}
        with patch.object(B.A, 'observe', side_effect=delegate) as fake:
            self.assertEqual(B.observe('/unused', '0' * 64, '/unused'), {'complete': True})
            fake.assert_called_once()
        self.assertIs(B.A.preflight, original)
    def test_delegate_restore_failure(self):
        original = B.A.preflight
        with patch.object(B.A, 'observe', side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError): B.observe('/unused', '0' * 64, '/unused')
        self.assertIs(B.A.preflight, original)


if __name__ == '__main__': unittest.main()
