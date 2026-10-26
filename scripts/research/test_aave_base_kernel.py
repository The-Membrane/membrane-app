"""Synthetic-only parity checks; no historical outcomes read.

Run: python3 -B scripts/research/test_aave_base_kernel.py
After reference migration:
AAVE_REFERENCE_KERNEL=/path/to/retained/kernel.py python3 -B scripts/research/test_aave_base_kernel.py
The reference must retain the exact SHA256 below at either location.
"""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from fractions import Fraction as F

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REFERENCE = ROOT / 'data/research/venue-signals/aave-cash-contemporaneous-flow-2026-10-13/long-history-parent-review-r2-2026-10-14/learned-path-kernel-source-evidence-2026-10-18/kernel.py'
ORIGINAL = Path(os.environ.get('AAVE_REFERENCE_KERNEL', str(DEFAULT_REFERENCE)))
PIN = '485c0b2c9586262a0e0f8fadcb57fd32af038b31ccbb742a2b26b9b6e8ee63eb'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


assert hashlib.sha256(ORIGINAL.read_bytes()).hexdigest() == PIN
OLD = load(ORIGINAL, 'frozen_a_b_kernel')
NEW = load(Path(__file__).with_name('aave-base-kernel.py'), 'base_kernel')


def row(i):
    scale = 10**30 + 17 * i
    result = {'physicalCashRaw': str(scale // (3 + i % 3)),
              'nominalClaimsRaw': str(scale),
              'officialBorrowUsageRay': str(OLD.RAY // 2 + i), 'lags': {}}
    for j, window in enumerate((3600, 21600, 86400, 604800), 1):
        incoming = j * (10**20 + i * 113)
        outgoing = j * (10**19 + i * 71)
        result['lags'][str(window)] = {
            'incomingRaw': str(incoming), 'outgoingRaw': str(outgoing),
            'netRaw': str(incoming - outgoing),
            'incomingEventCount': j * (i + 1), 'outgoingEventCount': j,
            'zeroNetEventCount': j * 2, 'totalEventCount': j * (i + 4)}
    return result


def train_rows(module):
    rows = []
    for i in range(59):
        raw = row(i)
        coords = module.coordinates(raw)
        rows.append({'T': i * OLD.DAY, 'split': 'TRAIN',
                     'C': int(raw['physicalCashRaw']), 'S': int(raw['nominalClaimsRaw']),
                     'x': coords[0] if module is OLD else coords})
    return rows


def synthetic_index(t, h):
    i = t // OLD.DAY
    c = int(row(i)['physicalCashRaw'])
    terminal = c + (i % 5 - 2) * h * 10**20
    minimum = max(0, min(c, terminal, c - (i % 7) * h * 10**20))
    assert 0 <= minimum <= min(c, terminal)
    return SimpleNamespace(base=c, terminal=terminal, minimum=minimum, h=h)


class BaseParity(unittest.TestCase):
    def test_vectors_scalers_weights_and_no_u_access(self):
        raw = [row(i) for i in range(9)]
        a = [OLD.coordinates(r)[0] for r in raw]
        b = [NEW.coordinates(r) for r in raw]
        self.assertEqual([x[:14] for x in a], b)
        for r, expected in zip(raw, b):
            del r['officialBorrowUsageRay']
            self.assertEqual(NEW.coordinates(r), expected)
        op, np = OLD.preprocessing(a), NEW.preprocessing(b)
        for key in ('means', 'populationSD'):
            self.assertEqual(op[key][:14], np[key])
        self.assertEqual([k for k in op['zeroSDColumns'] if k < 14], np['zeroSDColumns'])
        for bw in NEW.BANDWIDTHS:
            ow = OLD.weights(a[:-1], a[-1], op, 'A', bw)
            nw = NEW.weights(b[:-1], b[-1], np, bw)
            self.assertEqual(ow, nw)
            self.assertEqual(OLD.ess(ow), NEW.ess(nw))

    def test_scenarios_exact_large_integer_rounding_and_floor(self):
        donor = {'C': 10**35 + 7, 'S': 10**36 + 11}
        target = {'C': 19, 'S': 10**35 + 3}
        ix = SimpleNamespace(base=donor['C'], terminal=donor['C'] + 2,
                             minimum=donor['C'] - 10**20)
        kinds = ('claims_bounded', 'claims_unbounded', 'raw_bounded',
                 'raw_unbounded', 'empirical90_change_bounded',
                 'native_same_slot', 'empirical90_level', 'persistence')
        for kind in kinds:
            self.assertEqual(OLD.scenario_values(ix, donor, target, kind),
                             NEW.scenario_values(ix, donor, target, kind))
        terminal, minimum, negative = NEW.scenario_values(ix, donor, target, 'claims_bounded')
        self.assertIsInstance(terminal, F)
        self.assertEqual(minimum, 0)
        self.assertTrue(negative[0])
        self.assertEqual(terminal, F(19) + F(2 * target['S'], donor['S']))

    def test_complete_cv_scores_selection_and_strict_resolution(self):
        a = OLD.cv_select(train_rows(OLD), synthetic_index)
        b = NEW.cv_select(train_rows(NEW), synthetic_index)
        self.assertEqual(a['scoresExact']['A'], b['scoresExact'])
        self.assertEqual(a['selected']['A'], b['selected'])
        expected_audit = copy.deepcopy(a['rollingSupport'])
        for fold in expected_audit:
            fold['zeroSD'] = [k for k in fold['zeroSD'] if k < 14]
        self.assertEqual(expected_audit, b['rollingSupport'])
        self.assertEqual(b['CVOriginCount'], 30)
        self.assertEqual(b['endpointMinimumCellsPerOrigin'], 8)
        self.assertEqual(b['rollingSupport'][0]['donors'], 28)
        for fold in b['rollingSupport']:
            self.assertLess(fold['lastDonorEndpoint'], fold['issueAt'])

    def test_zero_sd_infinity_tie(self):
        vectors = [[0.0] * 14 for _ in range(3)]
        prep = NEW.preprocessing(vectors)
        self.assertEqual(prep['zeroSDColumns'], list(range(14)))
        self.assertEqual(NEW.zscore(vectors[0], prep), vectors[0])
        for bw in NEW.BANDWIDTHS:
            actual = NEW.weights(vectors, vectors[0], prep, bw)
            self.assertEqual(actual, [1 if bw == 'infinity' else 2**40] * 3)
        tied = {bw: F(1) for bw in NEW.BANDWIDTHS}
        self.assertEqual(NEW.choose_bandwidth(tied), 'infinity')
        tied['infinity'] += F(1, 10**12)
        self.assertEqual(NEW.choose_bandwidth(tied), 'infinity')
        tied['infinity'] += F(1, 10**20)
        self.assertEqual(NEW.choose_bandwidth(tied), 2.0)

    def test_invalid_inputs(self):
        cases = []
        for value in ('0', '-1', '01', '1.0', 'nan'):
            r = row(0); r['nominalClaimsRaw'] = value; cases.append(r)
        r = row(0); r['physicalCashRaw'] = '-1'; cases.append(r)
        for field, value in (('incomingEventCount', True), ('outgoingEventCount', -1),
                             ('zeroNetEventCount', float('nan')), ('netRaw', '1'),
                             ('totalEventCount', True)):
            r = row(0); r['lags']['3600'][field] = value; cases.append(r)
        r = row(0); r['lags']['21600'] = copy.deepcopy(r['lags']['3600'])
        r['lags']['21600']['incomingRaw'] = '0'
        r['lags']['21600']['netRaw'] = str(-int(r['lags']['21600']['outgoingRaw'])); cases.append(r)
        for r in cases:
            with self.assertRaises(ValueError):
                NEW.coordinates(r)
        for vectors in ([[float('inf')] * 14], [[float('nan')] * 14], [[0] * 15], []):
            with self.assertRaises(ValueError):
                NEW.preprocessing(vectors)
        for edit in ('short', 'wrong_split', 'duplicate'):
            rows = train_rows(NEW)
            if edit == 'short': rows.pop()
            if edit == 'wrong_split': rows[0]['split'] = 'CAL'
            if edit == 'duplicate': rows[1]['T'] = rows[0]['T']
            with self.assertRaises(ValueError):
                NEW.cv_select(rows, synthetic_index)


if __name__ == '__main__':
    unittest.main()
