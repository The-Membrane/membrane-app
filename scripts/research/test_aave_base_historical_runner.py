"""Small tempfile/synthetic runner checks; never executes real historical inputs."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
from fractions import Fraction as F
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name('aave-base-historical-runner.py')
spec = importlib.util.spec_from_file_location('base_runner', PATH)
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)


def desc(path, body):
    return {'path': str(path), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


class MockSequence:
    def __init__(self, first, last): self.first, self.last = first, last
    def __len__(self): return 969263
    def __getitem__(self, key):
        if key == 0: return self.first
        if key in (-1, 969262): return self.last
        raise AssertionError('unexpected index')


class RunnerTests(unittest.TestCase):
    def test_small_verified_file_negative_pin_type_symlink_and_bookend(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            path = Path(directory) / 'small'; body = b'{"x":1}\n'; path.write_bytes(body)
            pin = desc(path, body); actual, before = R.read(pin, 64)
            self.assertEqual(actual, body); R.bookend(pin, before, 64)
            for key, value in [('bytes', True), ('sha256', '0' * 64), ('bytes', 65), ('path', 'relative')]:
                bad = pin.copy(); bad[key] = value
                with self.assertRaises(ValueError): R.read(bad, 64)
            link = Path(directory) / 'link'; link.symlink_to(path)
            with self.assertRaises(ValueError): R.read(desc(link, body), 64)
            path.write_bytes(b'{"x":2}\n')
            with self.assertRaises(ValueError): R.bookend(pin, before, 64)

    def test_strict_json_duplicate_nonfinite(self):
        self.assertEqual(R.strict_json(b'{"a":1}'), {'a': 1})
        for body in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}'):
            with self.assertRaises(ValueError): R.strict_json(body)

    def test_provider_checks_coverage_before_index(self):
        index_calls = []
        def index(points, h):
            index_calls.append((points, h))
            return SimpleNamespace(base=points[0][1], terminal=points[-1][1], minimum=min(c for _, c in points))
        p = SimpleNamespace(path=lambda *args: ([(0, 10), (5, 3)], 5, False))
        provider = R.make_path_provider(p, index, [], [])
        with self.assertRaises(ValueError): provider(100, 10)
        self.assertEqual(index_calls, [])
        p.path = lambda *args: ([(0, 10), (10, 3)], 10, True)
        result = provider(100, 10)
        self.assertEqual((result.base, result.terminal, result.minimum, result.observedSeconds), (10, 3, 3, 10))
        self.assertIs(result.fullWindow, True)
        p.path = lambda *args: ([(0, 10), (10, 3)], True, True)
        with self.assertRaises(ValueError): provider(100, 10)

    def test_inert_cli_and_authorization_before_source_reads(self):
        with patch.object(R, 'state', side_effect=AssertionError('must not read')):
            with self.assertRaises(ValueError): R.main([])
            with self.assertRaises(ValueError): R.main(['--config', '/missing', '--config-sha256', 'a' * 64])
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            path = Path(directory) / 'config'; body = b'{"executionAuthorized":false}'; path.write_bytes(body)
            with patch.object(R, 'module', side_effect=AssertionError('must not load')):
                with self.assertRaisesRegex(ValueError, 'execution_not_authorized'): R.execute(desc(path, body))

    def test_pure_orchestration_binds_inputs_and_one_loader(self):
        bodies = {name: json.dumps({'kind': name}).encode() for name in ('features', 'proof', 'audit')}
        pins = {name: desc('/private/tmp/' + name, body) for name, body in bodies.items()}
        pins['cache'] = {'path': '/private/tmp/cache', **R.CACHE}
        loads, evaluations = [], []
        def loader():
            loads.append(1)
            return MockSequence(1674808907, 1791932579), MockSequence(10, 3), {'synthetic': True}
        p = SimpleNamespace(path=lambda *args: ([(0, 10), (10, 3)], 10, True))
        index = lambda points, h: SimpleNamespace(base=10, terminal=3, minimum=3)
        def evaluate(admission, kernel, bundle, proof, audit, expected, provider):
            evaluations.append(expected)
            self.assertEqual((bundle, proof, audit), tuple({'kind': k} for k in ('features', 'proof', 'audit')))
            self.assertEqual(provider(100, 10).terminal, 3)
            return {'synthetic': True}
        result, metadata = R.run_evaluation(None, None, SimpleNamespace(evaluate=evaluate), p, index, bodies, pins, loader)
        self.assertEqual(result, {'synthetic': True}); self.assertEqual(loads, [1])
        self.assertEqual(evaluations, [{k: pins[k] for k in ('cache', 'features', 'proof')}])
        bad = bodies.copy(); bad['features'] = b'{}'
        with self.assertRaises(ValueError): R.run_evaluation(None, None, None, p, index, bad, pins, loader)
        self.assertEqual(loads, [1])

    def test_real_shaped_mixed_keys_and_collisions(self):
        shaped = {'CV': {'scoresExact': {0.5: F(1, 3), 1.0: F(2, 7),
                                        2.0: F(3, 11), 'infinity': F(4, 13)}},
                  'samples': (F(2, 3), [F(5, 7)]), 'Q': {10**12: F(1, 2)}}
        encoded = R.encode(shaped, 4096)
        self.assertEqual(encoded, R.encode(shaped, 4096))
        decoded = R.strict_json(encoded)
        self.assertEqual(set(decoded['CV']['scoresExact']), {'0.5', '1.0', '2.0', 'infinity'})
        self.assertEqual(decoded['CV']['scoresExact']['0.5'], {'numerator': '1', 'denominator': '3'})
        self.assertEqual(decoded['Q'][str(10**12)], {'numerator': '1', 'denominator': '2'})
        self.assertEqual(decoded['samples'][1][0], {'numerator': '5', 'denominator': '7'})
        for invalid in ({1: 'numeric', '1': 'string'}, {0.5: 1, '0.5': 2},
                        {True: 1}, {float('inf'): 1}, {None: 1}):
            with self.assertRaises(ValueError): R.encode(invalid, 4096)

    def test_fraction_serialization_caps_and_fresh_output(self):
        report = {'primary24hMinimum': {'CAL': {'score': F(1, 3)}}}
        compressed, summary = R.serialize_report(report)
        decoded = R.strict_json(gzip.decompress(compressed))
        self.assertEqual(decoded['primary24hMinimum']['CAL']['score'], {'numerator': '1', 'denominator': '3'})
        self.assertIn(b'physical_cash', summary)
        with self.assertRaises(ValueError): R.encode({'x': 'a' * 100}, 16)
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            out = Path(directory) / 'once'; self.assertEqual(R.output_directory(str(out)), out)
            with self.assertRaises(ValueError): R.output_directory(str(out))
            with self.assertRaises(ValueError): R.output_directory(str(out / '..' / 'other'))
            app = Path(directory) / 'membrane-app'
            (app / 'scripts').mkdir(parents=True); (app / 'data').mkdir()
            traversal = app / 'scripts' / '..' / 'data' / 'newdir'
            with self.assertRaises(ValueError): R.output_directory(str(traversal))
            self.assertFalse((app / 'data' / 'newdir').exists())


if __name__ == '__main__': unittest.main()
