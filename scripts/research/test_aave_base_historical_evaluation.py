"""Synthetic-only in-memory integration; never loads real history or outcomes."""
import copy
import importlib.util
from pathlib import Path
from fractions import Fraction as F
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E = load('aave-base-historical-evaluation')
A = load('aave-base-admission')
K = load('aave-base-kernel')


def fixture():
    calendar = E.frozen_calendar()
    pins = {key: {'path': key, 'bytes': 10, 'sha256': char * 64}
            for key, char in zip(('cache', 'features', 'proof'), ('a', 'b', 'c'))}
    epoch = {'sourceAndRuntimeMatched': True, 'nominalClaimsQualified': True,
             'poolRuntimeSHA256': 'd' * 64, 'aTokenRuntimeSHA256': 'e' * 64,
             'sourceClosureSHA256': 'f' * 64, 'effectiveFromBlock': 0,
             'effectiveToExclusiveBlock': 10000}
    bundle = {'schema': 'aave-usdc-qualified-base-features-v1', 'venue': copy.deepcopy(A.VENUE), 'rows': []}
    audit = {'schema': 'aave-usdc-audited-base-features-v1', 'inputPins': copy.deepcopy(pins), 'rows': []}
    synthetic = {}
    for i, origin in enumerate(calendar, 1):
        T = origin['issueAt']; block = 10 * i; h = '0x' + format(block, '064x')
        cash, claims = 10**15 + i * 101, 10**16 + i * 131
        row = {'issueAt': T, 'availability': 'qualified', 'sourceEpochID': 'epoch',
               'blockNumber': block, 'blockTimestamp': T - 5, 'nextBlockTimestamp': T + 7,
               'nextBlockNumber': block + 1, 'blockHash': h,
               'nextBlockHash': '0x' + format(block + 1, '064x'), 'nextBlockParentHash': h,
               'canonicalHeaderProofPassed': True, 'sameHashStateViewsPassed': True,
               'physicalCashRaw': str(cash), 'nominalClaimsRaw': str(claims)}
        bundle['rows'].append(row)
        ar = {'issueAt': T, 'physicalCashRaw': str(cash), 'nominalClaimsRaw': str(claims),
              'featureBlock': block, 'featureHash': h, 'featureLagSeconds': 5, 'lags': {}}
        for j, w in enumerate((3600, 21600, 86400, 604800), 1):
            ar['lags'][str(w)] = {'incomingRaw': str(j * (20 + i)), 'outgoingRaw': str(j * (10 + i)),
                                  'netRaw': str(10 * j), 'incomingEventCount': j * i,
                                  'outgoingEventCount': j, 'zeroNetEventCount': j,
                                  'totalEventCount': j * (i + 2)}
        audit['rows'].append(ar)
        for horizon in K.H:
            terminal = cash + (i % 5 - 2) * horizon
            minimum = max(0, min(cash, terminal, cash - i * horizon))
            synthetic[T, horizon] = SimpleNamespace(base=cash, terminal=terminal, minimum=minimum,
                                                    h=horizon, fullWindow=True, observedSeconds=horizon)
    proof = {'schema': 'root-qualified-aave-usdc-base-features-v1', 'status': 'QUALIFIED_EXACT_STATES',
             'units': copy.deepcopy(A.UNITS), 'venue': copy.deepcopy(A.VENUE),
             'featureFileSHA256': pins['features']['sha256'], 'clockRule': 'B.ts<T<=B1.ts',
             'qualifiedEpochs': {'epoch': epoch}, 'exactObservedStates': [
                 {'blockNumber': r['blockNumber'], 'blockHash': r['blockHash']} for r in bundle['rows']]}
    return bundle, proof, audit, pins, synthetic


class EvaluationTests(unittest.TestCase):
    def test_complete_actual_cv_synthetic_evaluation(self):
        b, p, a, pins, paths = fixture(); snapshot = copy.deepcopy((b, p, a, pins, paths))
        calls, cv_origins = [], []
        original_cv = K.cv_select
        def counted_index(t, h):
            calls.append((t, h)); return paths[t, h]
        def actual_cv(train, index):
            cv_origins.extend(r['T'] for r in train)
            self.assertEqual({r['split'] for r in train}, {'TRAIN'})
            return original_cv(train, index)
        with patch.object(K, 'cv_select', side_effect=actual_cv):
            report = E.evaluate(A, K, b, p, a, pins, counted_index)
        self.assertEqual(len(calls), 472)
        self.assertEqual(len(set(calls)), 472)
        self.assertEqual(report['CV']['CVOriginCount'], 30)
        self.assertEqual(report['frozenTrainingPreprocessing']['donorCount'], 59)
        calendar = E.frozen_calendar(); train = calendar[:59]
        self.assertEqual(cv_origins, [r['issueAt'] for r in train])
        self.assertEqual(tuple(cv_origins), report['donorIssueTimes'])
        train_x = [K.coordinates(a['rows'][i]) for i in range(59)]
        self.assertEqual(K.preprocessing(train_x), report['frozenTrainingPreprocessing'])
        self.assertEqual(report['counts'], {'TRAIN': 59, 'CAL': 29, 'DEV': 30})
        self.assertEqual(len(report['outcomes']), 59)
        first = report['outcomes'][0]; h = 86400; cell = first['horizons'][h]
        truth = paths[first['issueAt'], h]
        self.assertEqual(cell['zeroMinimumCRPSOverClaims'], F(truth.minimum, first['claims']))
        donor_values = []
        target_cash = paths[first['issueAt'], h].base
        for donor in train:
            donor_t = donor['issueAt']; donor_ix = paths[donor_t, h]
            donor_claims = int(b['rows'][cv_origins.index(donor_t)]['nominalClaimsRaw'])
            donor_values.append(max(F(0), F(target_cash) + F(first['claims'], donor_claims) * (donor_ix.minimum - donor_ix.base)))
        # Direct pairwise CRPS formula, independent of kernel.crps implementation.
        n = len(donor_values)
        expected = (sum((abs(x - truth.minimum) for x in donor_values), F(0)) / n
                    - sum((abs(x - y) for x in donor_values for y in donor_values), F(0)) / (2 * n * n)) / first['claims']
        self.assertEqual(cell['methods']['bounded_uniform']['minimumCRPSOverClaims'], expected)
        self.assertEqual(cell['methods']['bounded_uniform']['minimumSamples'], tuple(donor_values))
        self.assertEqual(report['primary24hMinimum']['CAL']['n'], 29)
        self.assertEqual(report['primary24hMinimum']['DEV']['n'], 30)
        self.assertEqual(report['primary24hMinimum']['POOLED_CAL_DEV']['n'], 59)
        self.assertEqual((b, p, a, pins, paths), snapshot)
        self.assertEqual(set(cell['methods']), {'kernel_base', 'bounded_uniform'})
        self.assertNotIn('zero', cell['methods'])
        self.assertEqual(set(cell['methods']['kernel_base']['amountMarginals']), set(K.Q))

    def test_bad_calendar_rejected_before_cv(self):
        b, p, a, pins, paths = fixture()
        for kind in ('duplicate', 'wrong_split', 'wrong_phase', 'boolean_slot'):
            calendar = E.frozen_calendar()
            if kind == 'duplicate': calendar[1] = calendar[0].copy()
            if kind == 'wrong_split': calendar[0]['split'] = 'DEV'
            if kind == 'wrong_phase': calendar[0]['issueAt'] += 1
            if kind == 'boolean_slot': calendar[0]['slot'] = True
            with patch.object(K, 'cv_select', side_effect=AssertionError('CV must not run')):
                with self.assertRaises(ValueError): E.evaluate(A, K, b, p, a, pins, lambda t, h: paths[t, h], calendar)

    def test_bad_paths_and_zero_origin_rejected_before_cv(self):
        for kind in ('missing', 'censored', 'bad_base', 'negative', 'minimum_above_terminal', 'increasing_minimum', 'zero_origin'):
            b, p, a, pins, paths = fixture()
            t = E.frozen_calendar()[0]['issueAt']; path = paths[t, 900]
            if kind == 'missing': del paths[t, 900]
            if kind == 'censored': path.fullWindow = False
            if kind == 'bad_base': path.base += 1
            if kind == 'negative': path.minimum = -1
            if kind == 'minimum_above_terminal': path.minimum = path.terminal + 1
            if kind == 'increasing_minimum': paths[t, 3600].minimum = path.base
            if kind == 'zero_origin': b['rows'][0]['physicalCashRaw'] = a['rows'][0]['physicalCashRaw'] = '0'
            with patch.object(K, 'cv_select', side_effect=AssertionError('CV must not run')):
                with self.assertRaises(ValueError, msg=kind): E.evaluate(A, K, b, p, a, pins, lambda t, h: paths[t, h])


if __name__ == '__main__':
    unittest.main()
