"""Synthetic base-admission checks; read source only, never historical records."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT = ROOT / 'data/research/venue-signals/aave-cash-contemporaneous-flow-2026-10-13/long-history-parent-review-r2-2026-10-14/midnight-claims-utilization-cloud-native-source-v2-evidence-2026-10-18/companion.py'
REFERENCE = Path(os.environ.get('AAVE_REFERENCE_COMPANION', str(DEFAULT)))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


assert hashlib.sha256(REFERENCE.read_bytes()).hexdigest() == 'b8f5ee02d8346c09ac3c040640623debb626edbbf904231cd15e15510406e407'
OLD = load(REFERENCE, 'original_companion')
BASE = load(HERE / 'aave-base-admission.py', 'base_admission')
KERNEL = load(HERE / 'aave-base-kernel.py', 'base_kernel')


def fixture(phase=64800):
    times = (86400 + phase, 172800 + phase)
    pins = {key: {'path': key, 'bytes': 10, 'sha256': char * 64}
            for key, char in zip(('cache', 'features', 'proof'), ('a', 'b', 'c'))}
    epoch = {'sourceAndRuntimeMatched': True, 'nominalClaimsQualified': True,
             'poolRuntimeSHA256': 'd' * 64, 'aTokenRuntimeSHA256': 'e' * 64,
             'sourceClosureSHA256': 'f' * 64, 'effectiveFromBlock': 0,
             'effectiveToExclusiveBlock': 100}
    bundle = {'schema': 'aave-usdc-qualified-base-features-v1', 'venue': copy.deepcopy(BASE.VENUE), 'rows': []}
    audit = {'schema': 'aave-usdc-audited-base-features-v1', 'inputPins': copy.deepcopy(pins), 'rows': []}
    for i, T in enumerate(times, 1):
        h = '0x' + str(i) * 64
        row = {'issueAt': T, 'availability': 'qualified', 'sourceEpochID': 'epoch',
               'blockNumber': 10 * i, 'blockTimestamp': T - 5, 'nextBlockTimestamp': T + 7,
               'nextBlockNumber': 10 * i + 1, 'blockHash': h, 'nextBlockHash': '0x' + str(i + 5) * 64,
               'nextBlockParentHash': h, 'canonicalHeaderProofPassed': True,
               'sameHashStateViewsPassed': True, 'physicalCashRaw': '500', 'nominalClaimsRaw': '1000'}
        bundle['rows'].append(row)
        a = {'issueAt': T, 'physicalCashRaw': '500', 'nominalClaimsRaw': '1000',
             'featureBlock': 10 * i, 'featureHash': h, 'featureLagSeconds': 5, 'lags': {}}
        for j, w in enumerate((3600, 21600, 86400, 604800), 1):
            a['lags'][str(w)] = {'incomingRaw': str(20 * j), 'outgoingRaw': str(10 * j),
                                'netRaw': str(10 * j), 'incomingEventCount': j,
                                'outgoingEventCount': j, 'zeroNetEventCount': j,
                                'totalEventCount': 3 * j}
        audit['rows'].append(a)
    proof = {'schema': 'root-qualified-aave-usdc-base-features-v1', 'status': 'QUALIFIED_EXACT_STATES',
             'units': copy.deepcopy(BASE.UNITS), 'venue': copy.deepcopy(BASE.VENUE),
             'featureFileSHA256': pins['features']['sha256'], 'clockRule': 'B.ts<T<=B1.ts',
             'qualifiedEpochs': {'epoch': epoch},
             'exactObservedStates': [{'blockNumber': r['blockNumber'], 'blockHash': r['blockHash']}
                                     for r in bundle['rows']]}
    return bundle, proof, pins, audit, times


def qualify(bundle, proof, pins, times, phase=64800):
    return BASE.qualified_features(bundle, proof, pins['features'], times, phase)


class AdmissionTests(unittest.TestCase):
    def test_valid_phase_missing_u_and_no_mutation(self):
        args = fixture(); snapshot = copy.deepcopy(args)
        bundle, proof, pins, audit, times = args
        qualified, exceptions = qualify(bundle, proof, pins, times)
        self.assertEqual(exceptions, {})
        joined = BASE.audited_states(audit, qualified, times, 64800, pins, KERNEL)
        self.assertEqual(set(joined), set(times))
        self.assertEqual(args, snapshot)
        for f in qualified.values(): self.assertNotIn('u', f)
        for phase in (0, 21600, 43200):
            b, p, pins, a, t = fixture(phase)
            self.assertEqual(qualify(b, p, pins, t, phase)[1], {})

    def test_original_midnight_parity(self):
        bundle, proof, pins, _, times = fixture(0)
        original_bundle, original_proof = copy.deepcopy(bundle), copy.deepcopy(proof)
        original_bundle['schema'] = 'aave-usdc-qualified-pre-midnight-features-v1'
        original_proof['schema'] = 'root-qualified-aave-usdc-features-v1'
        original_proof['units']['borrowUsage'] = 'RAY_1e27'
        epoch = original_proof['qualifiedEpochs']['epoch']
        epoch.update(officialBorrowUsageFormulaQualified=True, strategyRuntimeSHA256='1' * 64)
        for row in original_bundle['rows']:
            row.update(borrowUsageKind='source_bound_official_borrow_usage_RAY', borrowUsageRay=str(10**27 // 2))
        old, exceptions = OLD.qualified_features(original_bundle, original_proof, pins['features'], times)
        new, new_exceptions = qualify(bundle, proof, pins, times, 0)
        self.assertEqual(exceptions, new_exceptions)
        for value in old.values(): value.pop('u')
        self.assertEqual(old, new)
        with self.assertRaises(ValueError): qualify(original_bundle, original_proof, pins, times, 0)

    def test_invalid_row_fields_are_exceptions(self):
        edits = [('nominalClaimsRaw', '0'), ('nominalClaimsRaw', '01'), ('physicalCashRaw', '-1'),
                 ('blockTimestamp', 151200), ('nextBlockTimestamp', 1), ('nextBlockNumber', 999),
                 ('nextBlockParentHash', '0x' + '8' * 64), ('sameHashStateViewsPassed', False),
                 ('canonicalHeaderProofPassed', False), ('sourceEpochID', 'absent')]
        for field, value in edits:
            b, p, pins, _, times = fixture(); b['rows'][0][field] = value
            _, exceptions = qualify(b, p, pins, times)
            self.assertIn(times[0], exceptions, field)
        for field, value in [('sourceAndRuntimeMatched', False), ('nominalClaimsQualified', False),
                             ('effectiveFromBlock', 11), ('effectiveToExclusiveBlock', 10),
                             ('poolRuntimeSHA256', 'bad'), ('aTokenRuntimeSHA256', None),
                             ('sourceClosureSHA256', '')]:
            b, p, pins, _, times = fixture(); p['qualifiedEpochs']['epoch'][field] = value
            self.assertIn(times[0], qualify(b, p, pins, times)[1], field)
        b, p, pins, _, times = fixture(); del p['qualifiedEpochs']['epoch']['sourceClosureSHA256']
        self.assertIn(times[0], qualify(b, p, pins, times)[1])

    def test_binding_membership_schema_and_missing(self):
        for which in ('schema', 'units', 'venue', 'pin', 'whitelist', 'duplicate_state', 'duplicate_time'):
            b, p, pins, _, times = fixture()
            if which == 'schema': b['schema'] = 'aave-usdc-qualified-pre-midnight-features-v1'
            if which == 'units': p['units']['borrowUsage'] = 'RAY_1e27'
            if which == 'venue': p['venue']['chainId'] = 2
            if which == 'pin': p['featureFileSHA256'] = '0' * 64
            if which == 'whitelist': p['exactObservedStates'][0]['blockHash'] = '0x' + '0' * 64
            if which == 'duplicate_state': p['exactObservedStates'][1] = copy.deepcopy(p['exactObservedStates'][0])
            if which == 'duplicate_time': b['rows'][1]['issueAt'] = times[0]
            with self.assertRaises(ValueError, msg=which): qualify(b, p, pins, times)
        b, p, pins, _, times = fixture(); b['rows'].pop(); p['exactObservedStates'].pop()
        self.assertEqual(qualify(b, p, pins, times)[1], {times[1]: 'missing_feature'})
        with self.assertRaises(ValueError): qualify(b, p, pins, list(times))
        with self.assertRaises(ValueError): qualify(b, p, pins, times, 1)

    def test_boolean_aliases_rejected(self):
        for side in ('proof', 'bundle'):
            b, p, pins, _, times = fixture()
            (p if side == 'proof' else b)['venue']['chainId'] = True
            with self.assertRaises(ValueError): qualify(b, p, pins, times)
        b, p, pins, a, times = fixture(); q, _ = qualify(b, p, pins, times)
        pins['cache']['bytes'] = 1
        a['inputPins']['cache']['bytes'] = True
        with self.assertRaises(ValueError): BASE.audited_states(a, q, times, 64800, pins, KERNEL)

    def test_audit_rejects_join_lags_pins_duplicates_missing_extras(self):
        for which in ('cash', 'claims', 'hash', 'block', 'lag', 'net', 'band', 'pins', 'duplicate', 'missing', 'extra', 'schema'):
            b, p, pins, a, times = fixture(); q, ex = qualify(b, p, pins, times); self.assertFalse(ex)
            r = a['rows'][0]
            if which == 'cash': r['physicalCashRaw'] = '501'
            if which == 'claims': r['nominalClaimsRaw'] = '1001'
            if which == 'hash': r['featureHash'] = '0x' + '0' * 64
            if which == 'block': r['featureBlock'] = 9
            if which == 'lag': r['featureLagSeconds'] = 6
            if which == 'net': r['lags']['3600']['netRaw'] = '11'
            if which == 'band':
                r['lags']['21600']['incomingRaw'] = '0'; r['lags']['21600']['netRaw'] = '-20'
            if which == 'pins': a['inputPins']['cache']['sha256'] = '0' * 64
            if which == 'duplicate': a['rows'][1] = copy.deepcopy(r)
            if which == 'missing': a['rows'].pop()
            if which == 'extra': a['rows'].append(copy.deepcopy(r))
            if which == 'schema': a['schema'] = 'old-audit'
            with self.assertRaises(ValueError, msg=which): BASE.audited_states(a, q, times, 64800, pins, KERNEL)
        b, p, pins, a, times = fixture(); q, _ = qualify(b, p, pins, times)
        del pins['features']['sha256']
        with self.assertRaises(ValueError): BASE.audited_states(a, q, times, 64800, pins, KERNEL)


if __name__ == '__main__':
    unittest.main()
