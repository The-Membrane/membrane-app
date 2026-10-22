"""Synthetic admission tests only: no scientific execution or process launch."""
import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().with_name('q26-state-reconstitution-observer.py')
spec = importlib.util.spec_from_file_location('state_observer_test_subject', SOURCE)
A = importlib.util.module_from_spec(spec)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), vars(A))


class Admission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.runner = self.root / 'r164_pool_moment_review.py'
        self.runner.write_text('# synthetic; never launched\n')
        self.plan = self.root / 'plan.json'
        self.plan.write_text(json.dumps({'files': {str(self.runner): A.pin(self.runner)['sha256']}}))
        self.request = self.root / 'request.json'
        self.receipt = self.root / 'receipt.json'
        self.output = self.root / 'out'
        self.r = dict(schema=A.SCHEMA, kind='producer', fixture_only=False, policy=dict(A.POLICY),
                      invocation_python=sys.executable, resolved_python=str(Path(sys.executable).resolve()),
                      python_pin=A.pin(str(Path(sys.executable).resolve())),
                      source_pins=[A.pin(self.runner), A.pin(A.__file__), A.pin(A.S.__file__), A.pin(A.O.__file__)],
                      plan=A.pin(self.plan), runner=A.pin(self.runner), output=str(self.output))
        self.r['argv'] = [sys.executable, '-B', str(self.runner), 'run', '--plan', str(self.plan), '--out', str(self.output)]
        self.disk = patch.object(A.O.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 10 * 1024**3})())
        self.disk.start()
        self.addCleanup(self.disk.stop)

    def admit(self, request=None):
        self.request.write_text(json.dumps(self.r if request is None else request))
        return A.preflight(str(self.request), A.pin(self.request)['sha256'], str(self.receipt))

    def rejects(self, mutate):
        r = copy.deepcopy(self.r)
        mutate(r)
        with self.assertRaises((ValueError, TypeError, KeyError)):
            self.admit(r)

    def test_producer(self):
        self.assertEqual(self.admit()[2], self.output)

    def saved(self):
        producer = self.root / 'producer'
        producer.mkdir()
        manifest = producer / 'manifest.json'
        manifest.write_text('{}')
        checker = self.root / 'r164_reconstituted_state_check.py'
        checker.write_text('# synthetic saved checker; never launched')
        self.r.update(kind='saved_check', producer_root=str(producer), producer_manifest=A.pin(manifest), runner=A.pin(checker))
        self.r['source_pins'].append(A.pin(checker))
        self.r['policy']['wall_seconds'] = 180
        self.r['argv'] = [sys.executable, '-B', str(checker), '--plan', str(self.plan), '--output-dir', str(producer), '--plan-sha256', self.r['plan']['sha256'], '--manifest-sha256', self.r['producer_manifest']['sha256'], '--out', str(self.output)]

    def test_saved_check(self):
        self.saved()
        self.admit()

    def test_saved_manifest_pin(self):
        self.saved()
        self.rejects(lambda r: r['producer_manifest'].update(sha256='0' * 64))

    def test_saved_manifest_binding(self):
        self.saved()
        other = self.root / 'other.json'
        other.write_text('{}')
        self.rejects(lambda r: r.update(producer_manifest=A.pin(other)))

    def test_saved_exact_hash_argument(self):
        self.saved()
        self.rejects(lambda r: r['argv'].__setitem__(10, '0' * 64))

    def test_saved_cannot_write_inside_producer(self):
        self.saved()
        self.output = Path(self.r['producer_root']) / 'check.json'
        self.receipt = Path(self.r['producer_root']) / 'receipt.json'
        self.r['output'] = str(self.output)
        self.r['argv'][-1] = str(self.output)
        with self.assertRaises(ValueError): self.admit()

    def test_unknown_field(self): self.rejects(lambda r: r.update(extra=True))
    def test_unknown_schema(self): self.rejects(lambda r: r.update(schema='old'))
    def test_unknown_kind(self): self.rejects(lambda r: r.update(kind='fit'))
    def test_missing_fixture(self): self.rejects(lambda r: r.pop('fixture_only'))
    def test_runtime_pin(self): self.rejects(lambda r: r['python_pin'].update(sha256='0' * 64))
    def test_runtime_resolution(self): self.rejects(lambda r: r.update(resolved_python='/wrong/python'))
    def test_runner_pin(self): self.rejects(lambda r: r['runner'].update(size=0))
    def test_plan_pin(self): self.rejects(lambda r: r['plan'].update(sha256='0' * 64))
    def test_source_pin(self): self.rejects(lambda r: r['source_pins'][0].update(sha256='0' * 64))
    def test_duplicate_source(self): self.rejects(lambda r: r['source_pins'].append(r['source_pins'][0]))
    def test_missing_adapter_source(self): self.rejects(lambda r: r['source_pins'].pop(1))
    def test_missing_runner_source(self): self.rejects(lambda r: r['source_pins'].pop(0))
    def test_wrong_argv(self): self.rejects(lambda r: r['argv'].append('--unsafe'))
    def test_wrong_mode(self): self.rejects(lambda r: r['argv'].__setitem__(3, 'plan'))
    def test_wrong_output_binding(self): self.rejects(lambda r: r.update(output=str(self.root / 'other')))
    def test_policy_extension(self): self.rejects(lambda r: r['policy'].update(extra=1))
    def test_policy_rss(self): self.rejects(lambda r: r['policy'].update(rss_bytes=1024**3))
    def test_policy_boolean(self): self.rejects(lambda r: r['policy'].update(output_bytes=True))
    def test_policy_wall(self): self.rejects(lambda r: r['policy'].update(wall_seconds=241))
    def test_tiny_fixture(self):
        self.r.update(fixture_only=True)
        self.r['policy']['wall_seconds'] = .1
        self.admit()
    def test_fixture_cannot_raise_resources(self):
        self.rejects(lambda r: (r.update(fixture_only=True), r['policy'].update(wall_seconds=1, output_bytes=10**9)))
    def test_fixture_wall_too_large(self):
        self.rejects(lambda r: (r.update(fixture_only=True), r['policy'].update(wall_seconds=3)))
    def test_stale_output(self):
        self.output.mkdir()
        with self.assertRaises(ValueError): self.admit()
    def test_stale_each_log(self):
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
        self.receipt = self.root.parent / 'other-receipt.json'
        with self.assertRaises(ValueError): self.admit()
    def test_disk_reserve(self):
        with patch.object(A.O.shutil, 'disk_usage', return_value=type('Disk', (), {'free': A.POLICY['disk_reserve_bytes'] - 1})()):
            with self.assertRaises(ValueError): self.admit()
    def test_request_hash(self):
        self.request.write_text(json.dumps(self.r))
        with self.assertRaises(ValueError): A.preflight(str(self.request), '0' * 64, str(self.receipt))
    def test_plan_source_missing(self):
        extra = self.root / 'dependency.md'
        extra.write_text('synthetic')
        self.plan.write_text(json.dumps({'files': {str(extra): A.pin(extra)['sha256']}}))
        self.r['plan'] = A.pin(self.plan)
        with self.assertRaises(ValueError): self.admit()
    def test_restore_preflight_after_failure(self):
        original = A.O.preflight
        with patch.object(A.S, 'observe', side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError): A.observe('/unused', '0' * 64, '/unused-receipt')
        self.assertIs(A.O.preflight, original)
    def test_restore_preflight_after_success(self):
        original = A.O.preflight
        with patch.object(A.S, 'observe', return_value={'complete': True}) as fake:
            self.assertEqual(A.observe('/unused', '0' * 64, '/unused-receipt'), {'complete': True})
            fake.assert_called_once()
        self.assertIs(A.O.preflight, original)

    def post_fixture(self, snapshot_error=False, addendum_error=False):
        class Proc:
            pid = 12345
            def poll(self): return -9
        proc = Proc()
        original = dict(complete=False, reason='wall_timeout', containment=dict(no_live_members_remaining=None))
        def original_observe(*args, **kwargs):
            kwargs['factory'](['synthetic'])
            A.O.exclusive(self.receipt, original)
            if addendum_error:
                raise RuntimeError('synthetic addendum failure')
            return original
        with patch.object(A.S, 'observe', side_effect=original_observe), patch.object(A.O, 'snapshot', side_effect=OSError('synthetic') if snapshot_error else None, return_value=dict(live_members=[], rss_bytes=0)) as snapshot:
            if addendum_error:
                with self.assertRaises(RuntimeError):
                    A.observe(str(self.request), '0' * 64, str(self.receipt), factory=lambda *a, **kw: proc)
            else:
                result = A.observe(str(self.request), '0' * 64, str(self.receipt), factory=lambda *a, **kw: proc)
                self.assertEqual(result, original)
            snapshot.assert_called_once_with(proc.pid, timeout=2)
        self.assertEqual(json.loads(self.receipt.read_text()), original)
        value = json.loads(Path(str(self.receipt) + '.post-containment.json').read_text())
        self.assertTrue(value['reaped'])
        self.assertTrue(value['original_job_success_not_revised'])
        self.assertEqual(value['no_live_members_remaining'], None if snapshot_error else True)
        self.assertEqual(value['error_type'], 'OSError' if snapshot_error else None)

    def test_post_timeout_fresh_no_live(self): self.post_fixture()
    def test_post_observation_failure_unknown(self): self.post_fixture(snapshot_error=True)
    def test_post_after_sampling_addendum_failure(self): self.post_fixture(addendum_error=True)


if __name__ == '__main__': unittest.main()
