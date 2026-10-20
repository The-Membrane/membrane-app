"""Pure deterministic compact-table assembler. No I/O, execution or endorsement.
Caller must authenticate the explicit Root review against the real archived
journal audit. Derived ABI words below are not raw HTTP response captures.
"""
import hashlib
import json

COLUMNS = ['issueAt','blockNumber','blockTimestamp','blockHash','nextBlockTimestamp','nextBlockHash',
           'physicalCashRaw','nominalClaimsRaw','scaledClaimsRaw','normalizedIncomeRay','identityIndex']
PROFILE_SCOPE = 'ARCHIVE_JOURNAL_AUDIT_BOUND_MEASURED_GETTERS_ONLY'
CAL_PIN = {'bytes':5548,'sha256':'e6afd0620e250690fae98101910b5818bfe82b260367dbe06a71cce09b82e2f6'}


def need(value, code):
    if not value: raise ValueError(code)


def pin(body):
    return {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def assemble(table_bytes, receipt_bytes, manifest_bytes, calendar_bytes, bindings, root_review, output_paths, A):
    """Return byte-pinned files and an INERT join-config template; write nothing."""
    need(type(bindings) is dict and set(bindings) == {'table','journalAudit','originalManifest','calendar','raw','cache'}, 'bindings')
    for d in bindings.values():
        A.descriptor(d); need(d['path'].startswith('/'), 'absolute_descriptor')
    for key, body in [('table',table_bytes),('journalAudit',receipt_bytes),('originalManifest',manifest_bytes),('calendar',calendar_bytes)]:
        need(pin(body) == {k: bindings[key][k] for k in ('bytes','sha256')}, 'served_input_pin')
    need(type(root_review) is dict and root_review.get('status') == 'ROOT_ENDORSED_MEASURED_GETTERS'
         and root_review.get('scope') == PROFILE_SCOPE and root_review.get('bindings') == bindings
         and root_review.get('limits') == A.LIMITS and A.exact_limits(root_review['limits']), 'pending_root_endorsement')
    need(pin(calendar_bytes) == CAL_PIN, 'frozen_calendar')
    table, audit, manifest, calendar = [json.loads(b) for b in (table_bytes,receipt_bytes,manifest_bytes,calendar_bytes)]
    need(table['schema'] == 'q9-compact-measured-stock-table/v1' and table['columns'] == COLUMNS
         and table['sourceQualified'] is False and table['scientificAdmission'] is False, 'compact_table_contract')
    need(table['originalManifestPin'] == {k: bindings['originalManifest'][k] for k in ('bytes','sha256')}, 'original_manifest_binding')
    need(audit['schema'] == 'saved118journal-authenticity-audit/v1' and audit['status'] == 'PASS'
         and audit['failures'] == [] and audit['counts']['origins'] == 118
         and audit['counts']['getterValues'] == 472 and audit['sourceQualified'] is False
         and audit['networkRPC'] == 0 and audit['allOriginalEvidencePinsAndStatsUnchanged'] is True, 'journal_audit_not_passed')
    need(manifest['schema'] == 'frozen-original-record-manifest/v1', 'manifest_schema')
    need(audit['provenance']['membershipPin'] == table['membershipPin'], 'audit_membership_binding')
    times = tuple(c['issueAt'] for c in calendar)
    need(len(times) == 118 and len(set(times)) == 118 and all(c['slot'] == 3 and type(c['slot']) is int for c in calendar), 'calendar')
    A.expected_times(times,64800)
    records = manifest['records']; origin_map = audit['provenance']['originDescriptors']
    need(type(records) is dict and len(records) == 118 and set(origin_map) == set(map(str,times)), 'audit_origin_membership')
    candidates = {}
    for path, entry in records.items():
        T = entry['issueAt']; need(type(T) is int and T in times and T not in candidates, 'manifest_membership')
        d = {'path':path, **entry['pin']}; A.descriptor(d)
        need(path.startswith('/') and origin_map[str(T)]['recordPin'] == entry['pin'], 'audit_candidate_pin')
        candidates[T] = d
    rows = table['rows']; catalog = table['identityCatalogue']
    need(type(rows) is list and len(rows) == 118 and all(type(r) is list and len(r) == 11 for r in rows)
         and [r[0] for r in rows] == list(times) and type(catalog) is list and 0 < len(catalog) <= 8, 'table_membership')
    need(all(type(r[10]) is int and 0 <= r[10] < len(catalog) for r in rows)
         and set(r[10] for r in rows) == set(range(len(catalog))), 'identity_membership')
    epochs = {}
    for i, identities in enumerate(catalog):
        need(set(identities) == {'pool','aToken'}, 'runtime_roles')
        blocks = [r[1] for r in rows if r[10] == i]
        roles = {role: {k: identities[role][k] for k in ('proxyAddress','codeAddress','runtimeSHA256','proxyRuntimeSHA256')}
                 for role in ('pool','aToken')}
        for role in roles:
            need(identities[role]['implementationSlot'] == '0x'+'0'*24+roles[role]['codeAddress'][2:], 'implementation_slot')
        epochs['measured-pair-'+str(i)] = {'runtimeIdentitiesMeasured':True,'nominalClaimsGetterMeasured':True,
            'runtimeIdentities':roles, 'poolRuntimeSHA256':roles['pool']['runtimeSHA256'],
            'aTokenRuntimeSHA256':roles['aToken']['runtimeSHA256'], 'effectiveFromBlock':min(blocks),
            'effectiveToExclusiveBlock':max(blocks)+1, 'scope':'EXACT_LISTED_STATES_NO_CONTINUOUS_EPOCH_CLAIM'}
    feature_rows, measurements = [], []
    equality = 0
    for values in rows:
        r = dict(zip(COLUMNS,values)); T = r['issueAt']; B = r['blockNumber']; H = r['blockHash']
        need(all(type(r[k]) is int and 0 <= r[k] < 2**256 for k in COLUMNS if k not in ('blockHash','nextBlockHash')), 'integer_fields')
        epoch_id = 'measured-pair-'+str(r['identityIndex']); epoch = epochs[epoch_id]
        feature_rows.append({'issueAt':T,'availability':'measured','sourceEpochID':epoch_id,
            'blockNumber':B,'blockTimestamp':r['blockTimestamp'],'blockHash':H,
            'nextBlockNumber':B+1,'nextBlockTimestamp':r['nextBlockTimestamp'],'nextBlockHash':r['nextBlockHash'],
            'nextBlockParentHash':H,'physicalCashRaw':str(r['physicalCashRaw']),
            'nominalClaimsRaw':str(r['nominalClaimsRaw']),'canonicalHeaderProofPassed':True,'sameHashStateViewsPassed':True})
        tag = {'blockHash':H,'requireCanonical':True}; calls = {}
        for key,to,sig,arg in [('physicalCashRaw',A.VENUE['asset'],'balanceOf(address)',A.VENUE['aToken']),
            ('nominalClaimsRaw',A.VENUE['aToken'],'totalSupply()',None),
            ('scaledClaimsRaw',A.VENUE['aToken'],'scaledTotalSupply()',None),
            ('normalizedIncomeRay',A.VENUE['pool'],'getReserveNormalizedIncome(address)',A.VENUE['asset'])]:
            calls[key] = {'to':to,'signature':sig,'argument':arg,'stateTag':dict(tag),'returnData':'0x'+format(r[key],'064x')}
        floor = r['scaledClaimsRaw']*r['normalizedIncomeRay']//10**27
        half = (r['scaledClaimsRaw']*r['normalizedIncomeRay']+10**27//2)//10**27; S = r['nominalClaimsRaw']
        measurements.append({'issueAt':T,'blockNumber':B,'stateTag':tag,'calls':calls,
            'identity':{'underlyingAsset':A.VENUE['asset'],'pool':A.VENUE['pool'],'assetDecimals':6,'aTokenDecimals':6},
            'runtimeIdentities':epoch['runtimeIdentities'],
            'evidenceDescriptors':{'candidate':candidates[T], **{k:bindings['journalAudit'] for k in ('canonicalWitness','getterWitness','executionReceipt')}},
            'roundingDiagnostics':{'floorCandidateRaw':floor,'halfUpCandidateRaw':half,'nominalMinusFloorRaw':S-floor,
                'nominalMinusHalfUpRaw':S-half,'floorMatches':S==floor,'halfUpMatches':S==half},
            'returnEncoding':'DERIVED_ABI_WORDS_FROM_COMPACT_VALUES_NOT_RAW_RESPONSE_CAPTURE',
            'journalAuditOriginDescriptor':origin_map[str(T)]})
        equality += int(T == r['nextBlockTimestamp'])
    need(equality == table['boundaryEqualityCount'] == 0, 'unprovided_boundary_cash_witness')
    need(set(output_paths) == {'features','proof','witness','authority'} and all(type(p) is str and p.startswith('/') for p in output_paths.values()), 'output_paths')
    need(root_review.get('finalPathBindingsApproved') is not True or root_review.get('outputPaths') == output_paths, 'root_output_path_binding')
    feature_bytes = encode({'schema':'aave-usdc-measured-base-features-v1','venue':A.VENUE,'rows':feature_rows})
    feature_desc = {'path':output_paths['features'], **pin(feature_bytes)}
    proof_bytes = encode({'schema':'root-measured-aave-usdc-base-features-v1','status':'MEASURED_GETTER_EXACT_STATES',
        'measurementProfile':A.PROFILE,'sourceQualificationClaim':'NOT_ESTABLISHED','limits':A.LIMITS,
        'units':A.UNITS,'venue':A.VENUE,'clockRule':'B.ts<T<=B1.ts','featureFileSHA256':feature_desc['sha256'],
        'measuredEpochs':epochs,'measurements':measurements,
        'exactObservedStates':[{'blockNumber':r['blockNumber'],'blockHash':r['blockHash']} for r in feature_rows]})
    q, ex = A.qualified_features(json.loads(feature_bytes),json.loads(proof_bytes),feature_desc,times,64800)
    need(not ex and len(q) == 118, 'assembled_measurements_rejected')
    global_proofs = {'candidate':bindings['originalManifest'], **{k:bindings['journalAudit'] for k in ('canonicalWitness','getterWitness','executionReceipt')}}
    witness_bytes = encode({'rows':measurements,'measurementProofDescriptors':global_proofs})
    files = {'features':feature_bytes,'proof':proof_bytes,'witness':witness_bytes}
    ds = {k:{'path':output_paths[k], **pin(b)} for k,b in files.items()}
    bound = {k:bindings[k] for k in ('raw','calendar','cache')}; bound.update(ds)
    files['authority'] = encode({'schema':'q9-root-measured-base-stock-join-authority-v1','status':('ROOT_MEASURED_EXACT_STATES' if root_review.get('finalPathBindingsApproved') is True else 'PENDING_ROOT_FINAL_PATH_BINDING'),
        'measurementProfile':A.PROFILE,'limits':A.LIMITS,'boundInputs':bound,'calendarPin':pin(calendar_bytes),'originCount':118,
        'measurementProofDescriptors':global_proofs,'measurementProofRoles':['candidate','canonicalWitness','executionReceipt','getterWitness'],
        'rootReview':root_review,'tableDescriptor':bindings['table']})
    ds['authority'] = {'path':output_paths['authority'], **pin(files['authority'])}
    bound.update({'authority':ds['authority']})
    return {'files':files,'descriptors':ds,'joinConfigTemplate':{'executionAuthorized':False,'inputs':bound,
        'dependencies':None,'launcher':None,'output':None},'profile':A.PROFILE,'limits':dict(A.LIMITS)}
