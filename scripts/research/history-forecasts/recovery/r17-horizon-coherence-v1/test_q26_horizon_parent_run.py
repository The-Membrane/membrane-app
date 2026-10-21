"""Synthetic wrapper refutation. No child process or scientific payload is run."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

WRAPPER = Path('/private/tmp/q26-horizon-parent-run.py')

class GuardTests(unittest.TestCase):
    def test_authenticated_symlink_path_preserved_and_content_hashed(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
            target=Path(t)/'python-real';target.write_bytes(b'pinned interpreter bytes')
            link=Path(t)/'python-link';link.symlink_to(target)
            spec=importlib.util.spec_from_file_location('symlink_guard',WRAPPER)
            g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
            result=g.pin(link)
            self.assertEqual(result,dict(path=str(link),size=24,sha256=hashlib.sha256(target.read_bytes()).hexdigest()))
            target.write_bytes(b'changed interpreter bytes')
            self.assertNotEqual(g.pin(link),result)
            with self.assertRaises(ValueError):g.pin(Path('relative-python'))

    def setUp(self):
        spec = importlib.util.spec_from_file_location('horizon_guard_test_subject', WRAPPER)
        self.g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.g)
        self.tmp = tempfile.TemporaryDirectory(prefix='q26-guard-unit-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.clock = 0.0
        self.g.SUPERVISOR_START = 0.0
        self.out = self.root / 'out'
        self.request = self.root / 'request.json'
        dummy = self.root / 'synthetic.py'
        dummy.write_text('# never executed\n')
        pin = self.g.pin(dummy)
        self.request.write_text(json.dumps(dict(
            intended_output=str(self.out), admission_status='parent_accepted',
            policy=dict(wall_seconds=120, rss_bytes=1000000000,
                        disk_reserve_bytes=2147483648, output_bytes=10000000),
            source_pins={'implementation': pin}, original_request=pin, original_result=pin,
            original_outer=pin, original_review=pin, runtime_identity_audit=pin, runtime_pins=[],
            threads={}, invocation_python='/not/executed')))
        self.started = 0

    def invoke(self, *, child_seconds=.2, resources=True, pre_free=3*2**30,
               final_free=3*2**30, write_delay=0., pin_delay_call=None, extra_output_bytes=0, child_policy_bad=False):
        g, owner = self.g, self
        original_write, original_pin = Path.write_text, g.pin
        calls = [0]
        def pin(path):
            if Path(path).resolve() == owner.request.resolve():
                calls[0] += 1
                if calls[0] == pin_delay_call:
                    owner.clock = 121.0
            return original_pin(path)
        class Child:
            pid = 999999
            def __init__(self, *args, **kwargs):
                owner.started += 1
                owner.last_cli=args[0]
                owner.out.mkdir()
                (owner.out / 'result.json').write_text('{}')
                if extra_output_bytes:
                    (owner.out/'nested').mkdir()
                    with (owner.out/'nested'/'oversized.bin').open('wb') as f:f.truncate(extra_output_bytes)
                if resources:
                    (owner.out / 'resource-receipt.json').write_text(json.dumps(dict(
                        observations=[dict(peak_rss_bytes=10000, free_bytes=3*2**30)],
                        policy={} if child_policy_bad else json.loads(owner.request.read_text())['policy'])))
                owner.clock = max(owner.clock, child_seconds)
            def poll(self): return 0
            def wait(self, **kwargs): return 0
        def write(path, text, *args, **kwargs):
            value = original_write(path, text, *args, **kwargs)
            if path.name == 'result-v1.outer-receipt.json':
                owner.clock += write_delay
            return value
        free = mock.Mock(side_effect=[types.SimpleNamespace(free=pre_free),
                                      types.SimpleNamespace(free=final_free)])
        error = None
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(g.time, 'monotonic', side_effect=lambda: owner.clock))
            stack.enter_context(mock.patch.object(g.subprocess, 'Popen', Child))
            stack.enter_context(mock.patch.object(g.subprocess, 'run', side_effect=AssertionError('no real ps permitted')))
            stack.enter_context(mock.patch.object(g.shutil, 'disk_usage', free))
            stack.enter_context(mock.patch.object(g, 'pin', side_effect=pin))
            stack.enter_context(mock.patch.object(Path, 'write_text', write))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            try: g.main(str(self.request))
            except (SystemExit, ValueError, TimeoutError) as exc: error = exc
        receipt = self.root / 'result-v1.outer-receipt.json'
        return error, json.loads(receipt.read_text()) if receipt.exists() else None

    def test_quick_complete_requires_child_resources(self):
        error, receipt = self.invoke(resources=False)
        self.assertIsInstance(error, SystemExit)
        self.assertFalse(receipt['execution_complete'])
        self.assertEqual(receipt['stop_reason'], 'missing_child_resource_receipt')

    def test_quick_complete_valid_resource_receipt(self):
        error, receipt = self.invoke()
        self.assertIsNone(error)
        self.assertTrue(receipt['execution_complete'])
        self.assertIn('--sha256',self.last_cli)
        self.assertNotIn('--request-sha256',self.last_cli)
        self.assertEqual(receipt['observations'], [])
        self.assertEqual(receipt['final_free_bytes'], 3*2**30)

    def test_prelaunch_disk_shortfall(self):
        error, receipt = self.invoke(pre_free=0)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(self.started, 0)
        self.assertIsNone(receipt)

    def test_final_disk_shortfall(self):
        error, receipt = self.invoke(final_free=0)
        self.assertIsInstance(error, SystemExit)
        self.assertEqual(receipt['stop_reason'], 'final_disk_reserve')

    def test_old_119_9_then_write_121_counterexample_rejected(self):
        error, receipt = self.invoke(child_seconds=119.9, write_delay=1.1)
        self.assertIsInstance(error, SystemExit)
        self.assertFalse(receipt['execution_complete'])

    def test_quick_child_slow_receipt_rejected(self):
        error, receipt = self.invoke(write_delay=121)
        self.assertIsInstance(error, SystemExit)
        self.assertFalse(receipt['execution_complete'])

    def test_prelaunch_pin_deadline_no_child(self):
        error, receipt = self.invoke(pin_delay_call=2)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(self.started, 0)

    def test_last_argument_pin_deadline_no_child(self):
        # Third request hash occurs inside Popen argument evaluation after the last deadline check.
        error, receipt = self.invoke(pin_delay_call=3)
        self.assertEqual(self.started, 0, 'child launched after the 120s budget expired during the final request hash')

    def set_prior_charge(self, value):
        request = json.loads(self.request.read_text())
        request['prior_wall_charged_seconds'] = value
        self.request.write_text(json.dumps(request))

    def test_prior_charge_included_in_receipt_elapsed(self):
        self.set_prior_charge(1)
        error, receipt = self.invoke()
        self.assertIsNone(error)
        self.assertAlmostEqual(receipt['outer_elapsed_seconds'], 1.2)
        self.assertEqual(receipt['prior_wall_charged_seconds'], 1)

    def test_prior_charge_reduces_available_wall(self):
        self.set_prior_charge(1)
        error, receipt = self.invoke(child_seconds=118.2)
        self.assertIsInstance(error, SystemExit)
        self.assertFalse(receipt['execution_complete'])
        self.assertAlmostEqual(receipt['outer_elapsed_seconds'], 119.2)

    def test_exhausted_prior_refuses_before_child(self):
        self.set_prior_charge(120)
        error, receipt = self.invoke()
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(self.started, 0)
        self.assertIsNone(receipt)

    def test_invalid_prior_charge_refuses_before_child(self):
        for value in (-1, float('nan'), float('inf'), True, '1', 10**400):
            with self.subTest(value=value):
                self.set_prior_charge(value)
                error, receipt = self.invoke()
                self.assertIsInstance(error, ValueError)
                self.assertEqual(self.started, 0)
                self.assertIsNone(receipt)

    def test_original_pin_mismatch_refused_before_launch(self):
        request=json.loads(self.request.read_text())
        request['original_outer']['sha256']='0'*64
        self.request.write_text(json.dumps(request))
        error,receipt=self.invoke()
        self.assertIsInstance(error,ValueError)
        self.assertEqual(self.started,0)
        self.assertIsNone(receipt)

    def test_child_policy_mismatch_rejected(self):
        error,receipt=self.invoke(child_policy_bad=True)
        self.assertIsInstance(error,SystemExit)
        self.assertEqual(receipt['stop_reason'],'child_resource_policy_mismatch')

    def test_recursive_owned_output_limit(self):
        error,receipt=self.invoke(extra_output_bytes=10000001)
        self.assertIsInstance(error,SystemExit)
        self.assertFalse(receipt['execution_complete'])
        self.assertEqual(receipt['stop_reason'],'owned_output_limit')

    def test_receipt_itself_counts_toward_output_limit(self):
        error,receipt=self.invoke(extra_output_bytes=9999600)
        self.assertIsInstance(error,SystemExit)
        self.assertFalse(receipt['execution_complete'])
        self.assertEqual(receipt['stop_reason'],'owned_output_limit')

    def test_final_output_accounting_time_is_charged(self):
        original=self.g.owned_bytes
        calls=[0]
        def delayed(root,out):
            result=original(root,out)
            calls[0]+=1
            if calls[0]==2:self.clock=121
            return result
        with mock.patch.object(self.g,'owned_bytes',side_effect=delayed):
            error,receipt=self.invoke()
        self.assertIsInstance(error,SystemExit)
        self.assertFalse(receipt['execution_complete'])
        self.assertEqual(receipt['stop_reason'],'final_receipt_deadline')

    def test_owned_file_vanishing_before_single_stat_is_skipped(self):
        self.out.mkdir()
        gone=self.out/'result.pending'
        gone.write_bytes(b'retired pending output')
        kept=self.out/'result.json'
        kept.write_bytes(b'{}')
        original=Path.lstat
        calls=[]
        def vanishing(path,*args,**kwargs):
            if path==gone:
                calls.append(path)
                raise FileNotFoundError(str(path))
            return original(path,*args,**kwargs)
        with mock.patch.object(Path,'lstat',vanishing):
            self.assertEqual(self.g.owned_bytes(self.root,self.out),2)
        self.assertEqual(calls,[gone])

    def test_owned_output_symlink_refused(self):
        self.out.mkdir()
        target=self.root/'not-owned'
        target.write_bytes(b'outside output')
        (self.out/'linked').symlink_to(target)
        with self.assertRaisesRegex(ValueError,'owned output symlink refused'):
            self.g.owned_bytes(self.root,self.out)

if __name__ == '__main__':
    print('wrapper SHA256', hashlib.sha256(WRAPPER.read_bytes()).hexdigest())
    unittest.main()
