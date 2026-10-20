"""Pure measured-getter research admission; original full-qualified path unchanged.
Derived from base admission8496/c8e4e471d0d8960d5549943ac927cdb000407218f3334c75bd20296940842474.
Caller authenticates bound raw receipts; this consumer verifies declared exact
state/getter/runtime/unit/accounting joins. It does not independently reconstruct
RPC provenance, compile source, qualify holder exits or establish blindness.
"""
VENUE = {'chainId': 1, 'pool': '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
         'asset': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
         'aToken': '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'}
UNITS = {'cashAndClaims': 'USDC_raw_6_decimals',
         'claimsKind': 'nominal_aToken_totalSupply_at_feature_block'}


def need(value, code):
    if not value:
        raise ValueError(code)


def uintstr(value):
    need(type(value) is str and value.isascii() and value.isdecimal()
         and str(int(value)) == value and 0 <= int(value) < 2**256, 'uint_string')
    return int(value)


def h32(value):
    return (type(value) is str and len(value) == 66 and value.startswith('0x')
            and all(c in '0123456789abcdef' for c in value[2:]))


def sha64(value):
    return (type(value) is str and len(value) == 64
            and all(c in '0123456789abcdef' for c in value))


def venue(value):
    return type(value) is dict and type(value.get('chainId')) is int and value == VENUE


def descriptor(value):
    need(type(value) is dict and set(value) == {'path', 'bytes', 'sha256'}
         and type(value['path']) is str and bool(value['path'])
         and type(value['bytes']) is int and value['bytes'] >= 0
         and sha64(value['sha256']), 'descriptor_shape')


def expected_times(times, phaseSeconds):
    need(type(phaseSeconds) is int and phaseSeconds in (0, 21600, 43200, 64800), 'phase')
    need(type(times) in (tuple, frozenset) and 0 < len(times) <= 118, 'immutable_origin_times')
    need(all(type(t) is int and t >= 0 and t % 86400 == phaseSeconds for t in times)
         and len(set(times)) == len(times), 'origin_times')
    return frozenset(times)


def feature(row, T, proof, phaseSeconds):
    need(type(row) is dict and type(T) is int and row.get('issueAt') == T
         and T % 86400 == phaseSeconds, 'feature_issue')
    need(row.get('availability') == 'measured', 'feature_unqualified')
    need(row.get('sourceEpochID') in proof['measuredEpochs'], 'source_epoch')
    epoch = proof['measuredEpochs'][row['sourceEpochID']]
    need(epoch.get('runtimeIdentitiesMeasured') is True and epoch.get('nominalClaimsGetterMeasured') is True, 'measurement_epoch')
    need(all(sha64(epoch[k]) for k in ('poolRuntimeSHA256', 'aTokenRuntimeSHA256')), 'epoch_pins')
    block, ts, nextts = row['blockNumber'], row['blockTimestamp'], row['nextBlockTimestamp']
    need(all(type(v) is int for v in (block, ts, nextts, row['nextBlockNumber']))
         and block >= 0 and row['nextBlockNumber'] == block + 1, 'feature_blocks')
    need(0 <= ts < T <= nextts and h32(row['blockHash']) and h32(row['nextBlockHash'])
         and row['nextBlockParentHash'] == row['blockHash'], 'strict_preT_pair')
    need(row.get('canonicalHeaderProofPassed') is True
         and row.get('sameHashStateViewsPassed') is True, 'canonical_state')
    start, end = epoch['effectiveFromBlock'], epoch['effectiveToExclusiveBlock']
    need(type(start) is int and 0 <= start <= block
         and (end is None or type(end) is int and start < end and block < end), 'epoch_range')
    claims = uintstr(row['nominalClaimsRaw'])
    need(claims > 0, 'nonpositive_preT_claims')
    return {'claims': claims, 'featureCash': uintstr(row['physicalCashRaw']),
            'lagSeconds': T - ts, 'block': block, 'hash': row['blockHash']}


def qualified_features(bundle, proof, featureDescriptor, expectedTimes, phaseSeconds):
    """Validate declarations; caller must bind featureDescriptor to actual raw bytes."""
    times = expected_times(expectedTimes, phaseSeconds)
    need(type(proof) is dict and proof.get('measurementProfile') == PROFILE and proof.get('sourceQualificationClaim') == 'NOT_ESTABLISHED'
         and exact_limits(proof.get('limits')), 'research_profile')
    descriptor(featureDescriptor)
    need(type(proof) is dict and proof.get('schema') == 'root-measured-aave-usdc-base-features-v1'
         and proof.get('status') == 'MEASURED_GETTER_EXACT_STATES', 'qualification_missing')
    need(proof.get('units') == UNITS, 'feature_units')
    need(venue(proof.get('venue')) and proof.get('featureFileSHA256') == featureDescriptor['sha256']
         and proof.get('clockRule') == 'B.ts<T<=B1.ts', 'qualification_binding')
    need(type(proof.get('measuredEpochs')) is dict
         and 0 < len(proof['measuredEpochs']) <= 8, 'epochs_missing')
    need(type(bundle) is dict and bundle.get('schema') == 'aave-usdc-measured-base-features-v1'
         and venue(bundle.get('venue')), 'feature_schema')
    rows = bundle.get('rows')
    need(type(rows) is list and len(rows) <= 118 and all(type(r) is dict for r in rows), 'feature_row_cap')
    listed = proof.get('exactObservedStates')
    need(type(listed) is list and len(listed) == len(rows), 'exact_states')
    need(all(type(r) is dict and type(r.get('blockNumber')) is int and r['blockNumber'] >= 0
             and h32(r.get('blockHash')) for r in listed), 'exact_states_shape')
    whitelist = [(r['blockNumber'], r['blockHash']) for r in listed]
    states = [(r.get('blockNumber'), r.get('blockHash')) for r in rows]
    need(all(type(b) is int and b >= 0 and h32(h) for b, h in states), 'feature_state_shape')
    need(len(set(whitelist)) == len(whitelist) and len(set(states)) == len(states)
         and set(whitelist) == set(states), 'exact_states_membership')
    measurements = proof.get('measurements')
    need(type(measurements) is list and len(measurements) == len(rows), 'measurement_membership')
    mmap = {}
    for measurement in measurements:
        need(type(measurement) is dict and type(measurement.get('issueAt')) is int
             and measurement['issueAt'] in times and measurement['issueAt'] not in mmap, 'measurement_membership')
        mmap[measurement['issueAt']] = measurement
    out, exceptions = {}, {}
    for row in rows:
        T = row.get('issueAt')
        need(type(T) is int and T in times and T not in out and T not in exceptions,
             'unexpected_or_duplicate_feature')
        try:
            admitted = feature(row, T, proof, phaseSeconds)
            verify_measurement(row, mmap[T], proof['measuredEpochs'][row['sourceEpochID']])
            out[T] = admitted
        except ValueError as error:
            exceptions[T] = str(error)
        except (KeyError, TypeError, AttributeError):
            exceptions[T] = 'invalid_feature_structure'
    for T in times:
        if T not in out and T not in exceptions:
            exceptions[T] = 'missing_feature'
    return out, exceptions


def audited_states(audit, qualified, expectedTimes, phaseSeconds, expectedPins, kernel):
    """Join exact admitted origins to declared audited lags; no raw-log reconstruction.

    expectedPins must identify caller-verified cache/features/proof raw byte inputs.
    A caller must require no qualification exceptions before invoking this join.
    """
    times = expected_times(expectedTimes, phaseSeconds)
    need(type(expectedPins) is dict and set(expectedPins) == {'cache', 'features', 'proof'}, 'audit_expected_pins')
    for pin in expectedPins.values():
        descriptor(pin)
    need(type(audit) is dict and audit.get('measurementProfile') == PROFILE
         and exact_limits(audit.get('limits')) and audit.get('schema') == 'aave-usdc-audited-measured-base-features-v1'
         and type(audit.get('inputPins')) is dict and set(audit['inputPins']) == set(expectedPins), 'audit_input_binding')
    for pin in audit['inputPins'].values():
        descriptor(pin)
    need(audit['inputPins'] == expectedPins, 'audit_input_binding')
    need(type(qualified) is dict and set(qualified) == times
         and all(type(t) is int for t in qualified), 'qualified_origin_membership')
    rows = audit.get('rows')
    need(type(rows) is list and len(rows) == len(times), 'audit_row_count')
    out = {}
    for row in rows:
        need(type(row) is dict and type(row.get('issueAt')) is int
             and row['issueAt'] in times and row['issueAt'] not in out, 'audit_origin_membership')
        T = row['issueAt']; f = qualified[T]
        need(uintstr(row['physicalCashRaw']) == f['featureCash']
             and uintstr(row['nominalClaimsRaw']) == f['claims'], 'audit_cash_claims_join')
        need(type(row.get('featureBlock')) is int and row['featureBlock'] == f['block']
             and h32(row.get('featureHash')) and row['featureHash'] == f['hash']
             and type(row.get('featureLagSeconds')) is int and row['featureLagSeconds'] == f['lagSeconds'],
             'audit_feature_join')
        try:
            kernel.coordinates(row)
        except (KeyError, TypeError, AttributeError, OverflowError) as error:
            raise ValueError('invalid_audited_lags') from error
        out[T] = row
    need(set(out) == times, 'audit_missing_origins')
    return out

PROFILE = 'same_hash_totalSupply_physical_cash_research_v1'
LIMITS = {'physicalCashResearchOnly': True, 'sourceCompilationEstablished': False,
          'nativeHolderExitQualified': False, 'historicalBlindnessEstablished': False,
          'recordedCashHistoryConditional': True}
RAY = 10**27


def address(value):
    return (type(value) is str and len(value) == 42 and value.startswith('0x')
            and all(c in '0123456789abcdef' for c in value[2:]) and value != '0x' + '0' * 40)


def raw_word(value):
    need(type(value) is str and len(value) == 66 and value.startswith('0x')
         and all(c in '0123456789abcdef' for c in value[2:]), 'getter_raw32')
    return int(value, 16)


def verify_measurement(row, measurement, epoch):
    """Root authenticates raw receipt descriptors; never infer source policy here."""
    need(measurement.get('issueAt') == row['issueAt']
         and type(measurement.get('blockNumber')) is int
         and measurement['blockNumber'] == row['blockNumber']
         and measurement.get('stateTag') == {'blockHash': row['blockHash'], 'requireCanonical': True}
         and measurement['stateTag']['requireCanonical'] is True, 'measurement_same_hash')
    need(measurement.get('identity') == {'underlyingAsset': VENUE['asset'], 'pool': VENUE['pool'],
                                       'assetDecimals': 6, 'aTokenDecimals': 6}
         and type(measurement['identity']['assetDecimals']) is int
         and type(measurement['identity']['aTokenDecimals']) is int, 'measurement_units_identity')
    proofs = measurement.get('evidenceDescriptors')
    need(type(proofs) is dict and set(proofs) == {'candidate', 'canonicalWitness', 'getterWitness', 'executionReceipt'}, 'measurement_evidence')
    for d in proofs.values():
        descriptor(d)
        need(d['bytes'] > 0 and d['path'].startswith('/'), 'measurement_evidence')
    roles = measurement.get('runtimeIdentities')
    need(type(roles) is dict and set(roles) == {'pool', 'aToken'} and roles == epoch['runtimeIdentities'], 'runtime_identity_join')
    for role, hashkey in (('pool', 'poolRuntimeSHA256'), ('aToken', 'aTokenRuntimeSHA256')):
        identity = roles[role]
        need(identity.get('proxyAddress') == VENUE[role] and address(identity.get('codeAddress'))
             and identity['codeAddress'] != VENUE[role]
             and identity.get('runtimeSHA256') == epoch[hashkey] and sha64(identity['runtimeSHA256'])
             and sha64(identity.get('proxyRuntimeSHA256')), 'runtime_roles')
    calls = measurement.get('calls')
    expected = {'physicalCashRaw': (VENUE['asset'], 'balanceOf(address)', VENUE['aToken']),
                'nominalClaimsRaw': (VENUE['aToken'], 'totalSupply()', None),
                'scaledClaimsRaw': (VENUE['aToken'], 'scaledTotalSupply()', None),
                'normalizedIncomeRay': (VENUE['pool'], 'getReserveNormalizedIncome(address)', VENUE['asset'])}
    need(type(calls) is dict and set(calls) == set(expected), 'measurement_getters')
    values = {}
    for key, (target, signature, arg) in expected.items():
        call = calls[key]
        need(type(call) is dict and call.get('to') == target and call.get('signature') == signature
             and call.get('argument') == arg and call.get('stateTag') == measurement['stateTag']
             and call['stateTag']['requireCanonical'] is True, 'getter_binding')
        values[key] = raw_word(call.get('returnData'))
    need(values['physicalCashRaw'] == uintstr(row['physicalCashRaw'])
         and values['nominalClaimsRaw'] == uintstr(row['nominalClaimsRaw'])
         and values['nominalClaimsRaw'] > 0 and values['normalizedIncomeRay'] > 0, 'measured_stock_join')
    product = values['scaledClaimsRaw'] * values['normalizedIncomeRay']
    floor, half = product // RAY, (product + RAY // 2) // RAY
    nominal = values['nominalClaimsRaw']
    expected_diag = {'floorCandidateRaw': floor, 'halfUpCandidateRaw': half,
                     'nominalMinusFloorRaw': nominal - floor, 'nominalMinusHalfUpRaw': nominal - half,
                     'floorMatches': nominal == floor, 'halfUpMatches': nominal == half}
    diag = measurement.get('roundingDiagnostics')
    need(type(diag) is dict and diag == expected_diag
         and all(type(diag[k]) is type(v) for k, v in expected_diag.items())
         and nominal in (floor, half), 'rounding_diagnostics')


def exact_limits(value):
    return type(value) is dict and value == LIMITS and all(type(value[k]) is bool for k in LIMITS)
