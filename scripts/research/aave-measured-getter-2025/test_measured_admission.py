"""Synthetic-only measured profile checks; no cache/model/history execution."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
APP = Path(os.environ.get('BASE_REVIEWED_SOURCES', '/Users/EBmic/membrane-app/scripts/research'))

def load(path, name, pin=None):
    b = path.read_bytes()
    if pin: assert (len(b), hashlib.sha256(b).hexdigest()) == pin
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

M = load(HERE / 'measured_admission.py', 'measured')
A = load(APP / 'aave-base-admission.py', 'full_unchanged', (8496, 'c8e4e471d0d8960d5549943ac927cdb000407218f3334c75bd20296940842474'))
K = load(APP / 'aave-base-kernel.py', 'kernel_unchanged', (9515, 'e4ebd12b206e66c700c1065adbf56088fe1bb231c70f464975a078e4f56602f3'))

def fixture():
    times = (151200, 237600)
    pins = {k: {'path': '/synthetic/' + k, 'bytes': 1, 'sha256': c * 64}
            for k, c in zip(('cache', 'features', 'proof'), ('a', 'b', 'c'))}
    roles = {role: {'proxyAddress': M.VENUE[role], 'codeAddress': '0x' + n * 40,
                    'runtimeSHA256': c * 64, 'proxyRuntimeSHA256': d * 64}
             for role, n, c, d in (('pool', '1', 'd', 'e'), ('aToken', '2', 'f', 'a'))}
    epoch = {'runtimeIdentitiesMeasured': True, 'nominalClaimsGetterMeasured': True,
             'poolRuntimeSHA256': 'd' * 64, 'aTokenRuntimeSHA256': 'f' * 64,
             'runtimeIdentities': roles, 'effectiveFromBlock': 0, 'effectiveToExclusiveBlock': 100}
    bundle = {'schema': 'aave-usdc-measured-base-features-v1', 'venue': copy.deepcopy(M.VENUE), 'rows': []}
    audit = {'schema': 'aave-usdc-audited-measured-base-features-v1', 'measurementProfile': M.PROFILE,
             'limits': copy.deepcopy(M.LIMITS), 'inputPins': copy.deepcopy(pins), 'rows': []}
    measurements = []
    for i, T in enumerate(times, 1):
        B = i * 10; h = '0x' + format(B, '064x'); tag = {'blockHash': h, 'requireCanonical': True}
        row = {'issueAt': T, 'availability': 'measured', 'sourceEpochID': 'measured',
               'blockNumber': B, 'blockTimestamp': T-5, 'nextBlockNumber': B+1,
               'nextBlockTimestamp': T+7, 'blockHash': h, 'nextBlockHash': '0x' + format(B+1, '064x'),
               'nextBlockParentHash': h, 'canonicalHeaderProofPassed': True,
               'sameHashStateViewsPassed': True, 'physicalCashRaw': '10', 'nominalClaimsRaw': '2'}
        bundle['rows'].append(row)
        calls = {}
        for key, to, sig, arg, value in (
            ('physicalCashRaw', M.VENUE['asset'], 'balanceOf(address)', M.VENUE['aToken'], 10),
            ('nominalClaimsRaw', M.VENUE['aToken'], 'totalSupply()', None, 2),
            ('scaledClaimsRaw', M.VENUE['aToken'], 'scaledTotalSupply()', None, 1),
            ('normalizedIncomeRay', M.VENUE['pool'], 'getReserveNormalizedIncome(address)', M.VENUE['asset'], 15 * 10**26)):
            calls[key] = {'to': to, 'signature': sig, 'argument': arg, 'stateTag': copy.deepcopy(tag),
                          'returnData': '0x' + format(value, '064x')}
        measurements.append({'issueAt': T, 'blockNumber': B, 'stateTag': tag,
            'identity': {'underlyingAsset': M.VENUE['asset'], 'pool': M.VENUE['pool'], 'assetDecimals': 6, 'aTokenDecimals': 6},
            'runtimeIdentities': copy.deepcopy(roles), 'calls': calls,
            'evidenceDescriptors': {k: copy.deepcopy(pins['proof']) for k in ('candidate', 'canonicalWitness', 'getterWitness', 'executionReceipt')},
            'roundingDiagnostics': {'floorCandidateRaw': 1, 'halfUpCandidateRaw': 2, 'nominalMinusFloorRaw': 1,
                                    'nominalMinusHalfUpRaw': 0, 'floorMatches': False, 'halfUpMatches': True}})
        ar = {'issueAt': T, 'physicalCashRaw': '10', 'nominalClaimsRaw': '2', 'featureBlock': B,
              'featureHash': h, 'featureLagSeconds': 5, 'lags': {}}
        for j, w in enumerate((3600, 21600, 86400, 604800), 1):
            ar['lags'][str(w)] = {'incomingRaw': str(2*j), 'outgoingRaw': str(j), 'netRaw': str(j),
                                  'incomingEventCount': j, 'outgoingEventCount': j, 'zeroNetEventCount': j, 'totalEventCount': 3*j}
        audit['rows'].append(ar)
    proof = {'schema': 'root-measured-aave-usdc-base-features-v1', 'status': 'MEASURED_GETTER_EXACT_STATES',
             'measurementProfile': M.PROFILE, 'sourceQualificationClaim': 'NOT_ESTABLISHED',
             'limits': copy.deepcopy(M.LIMITS), 'units': copy.deepcopy(M.UNITS), 'venue': copy.deepcopy(M.VENUE),
             'featureFileSHA256': pins['features']['sha256'], 'clockRule': 'B.ts<T<=B1.ts',
             'measuredEpochs': {'measured': epoch}, 'measurements': measurements,
             'exactObservedStates': [{'blockNumber': r['blockNumber'], 'blockHash': r['blockHash']} for r in bundle['rows']]}
    return bundle, proof, pins, audit, times


def qualify(args):
    b, p, pins, a, ts = args
    return M.qualified_features(b, p, pins['features'], ts, 64800)


class MeasuredTests(unittest.TestCase):
    def test_positive_partial_profile_and_full_path_rejection(self):
        args = fixture(); snapshot = copy.deepcopy(args)
        q, ex = qualify(args); self.assertEqual(ex, {})
        b, p, pins, audit, times = args
        self.assertEqual(len(M.audited_states(audit, q, times, 64800, pins, K)), 2)
        self.assertEqual(args, snapshot)
        self.assertNotIn('sourceAndRuntimeMatched', p['measuredEpochs']['measured'])
        self.assertFalse(p['limits']['sourceCompilationEstablished'])
        with self.assertRaises(ValueError): A.qualified_features(b, p, pins['features'], times, 64800)

    def test_schema_profile_limits_mixing_rejected(self):
        for edit in ('old_schema', 'full_claim', 'wrong_profile', 'boolean_alias', 'old_audit'):
            args = fixture(); b, p, pins, audit, times = args
            if edit == 'old_schema': p['schema'] = 'root-qualified-aave-usdc-base-features-v1'
            if edit == 'full_claim': p['sourceQualificationClaim'] = 'QUALIFIED'
            if edit == 'wrong_profile': p['limits']['nativeHolderExitQualified'] = True
            if edit == 'boolean_alias': p['limits']['sourceCompilationEstablished'] = 0
            if edit == 'old_audit':
                q, ex = qualify(args); self.assertFalse(ex); audit['schema'] = 'aave-usdc-audited-base-features-v1'
                with self.assertRaises(ValueError): M.audited_states(audit, q, times, 64800, pins, K)
                continue
            with self.assertRaises(ValueError): qualify(args)

    def test_floor_and_both_diagnostics_preserve_measured_denominator(self):
        for income, half, half_matches in ((15 * 10**26, 2, False), (11 * 10**26, 1, True)):
            args = fixture(); b, p, pins, a, ts = args
            for row, measurement, ar in zip(b['rows'], p['measurements'], a['rows']):
                row['nominalClaimsRaw'] = ar['nominalClaimsRaw'] = '1'
                measurement['calls']['nominalClaimsRaw']['returnData'] = '0x' + format(1, '064x')
                measurement['calls']['normalizedIncomeRay']['returnData'] = '0x' + format(income, '064x')
                measurement['roundingDiagnostics'] = {'floorCandidateRaw': 1, 'halfUpCandidateRaw': half,
                    'nominalMinusFloorRaw': 0, 'nominalMinusHalfUpRaw': 1-half,
                    'floorMatches': True, 'halfUpMatches': half_matches}
            q, ex = qualify(args); self.assertFalse(ex)
            self.assertEqual({f['claims'] for f in q.values()}, {1})
            self.assertNotIn('nominalClaimsRounding', p['measuredEpochs']['measured'])

    def test_wrong_getter_hash_layout_units_and_values(self):
        for edit in ('hash', 'layout', 'units', 'runtime', 'value', 'getter_to', 'canonical', 'evidence', 'diagnostic'):
            args = fixture(); m = args[1]['measurements'][0]
            if edit == 'hash': m['calls']['nominalClaimsRaw']['stateTag']['blockHash'] = '0x' + '0'*64
            if edit == 'layout': m['calls']['nominalClaimsRaw']['returnData'] = '0x02'
            if edit == 'units': m['identity']['aTokenDecimals'] = 18
            if edit == 'runtime': m['runtimeIdentities']['pool']['codeAddress'] = M.VENUE['pool']
            if edit == 'value': m['calls']['physicalCashRaw']['returnData'] = '0x' + format(11, '064x')
            if edit == 'getter_to': m['calls']['nominalClaimsRaw']['to'] = M.VENUE['asset']
            if edit == 'canonical': m['stateTag']['requireCanonical'] = 1
            if edit == 'evidence': m['evidenceDescriptors']['candidate']['bytes'] = True
            if edit == 'diagnostic': m['roundingDiagnostics']['floorMatches'] = True
            self.assertIn(args[4][0], qualify(args)[1], edit)

    def test_clock_membership_and_accounting(self):
        for edit in ('clock', 'parent', 'duplicate', 'missing_measurement', 'pin', 'lag', 'cash'):
            args = fixture(); b, p, pins, a, ts = args
            if edit == 'clock': b['rows'][0]['blockTimestamp'] = ts[0]
            if edit == 'parent': b['rows'][0]['nextBlockParentHash'] = '0x' + '0'*64
            if edit == 'duplicate': p['exactObservedStates'][1] = copy.deepcopy(p['exactObservedStates'][0])
            if edit == 'missing_measurement': p['measurements'].pop()
            if edit == 'pin': pins['features']['sha256'] = '0'*64
            if edit in ('duplicate', 'missing_measurement', 'pin'):
                with self.assertRaises(ValueError): qualify(args)
            elif edit in ('clock', 'parent'):
                self.assertIn(ts[0], qualify(args)[1])
            else:
                q, ex = qualify(args); self.assertFalse(ex)
                if edit == 'lag': a['rows'][0]['lags']['3600']['netRaw'] = '2'
                if edit == 'cash': a['rows'][0]['physicalCashRaw'] = '11'
                with self.assertRaises(ValueError): M.audited_states(a, q, ts, 64800, pins, K)


if __name__ == '__main__': unittest.main()
