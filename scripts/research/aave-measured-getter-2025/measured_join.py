"""INERT pure join of Root-admitted stocks to retained raw lags. No candidate normalizer."""
import hashlib,json
RAY=10**27
RAW_PIN={'bytes':448012,'sha256':'20171b1d3add80bf29d5c75632562616261b3dc1f06cbbf2bed51b8b2c9f2aae'}
CAL_PIN={'bytes':5548,'sha256':'e6afd0620e250690fae98101910b5818bfe82b260367dbe06a71cce09b82e2f6'}
DEPENDENCIES={'admission':(13722,'42263013ffa14b967c33a4c9e9c2ea7fac6ec6248af7c90acc711fccf266d8b6'),'kernel':(9698,'232c1e53907fe21056d74a1f5dc944d528a9166b0bc6899d57922eb730f39555')}
def need(x,c):
 if not x:raise ValueError(c)
def pin(b):return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def canonical(x):return (json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False)+chr(10)).encode()
def parse(b):
 def pairs(xs):
  d={}
  for k,v in xs:need(k not in d,'duplicate_key');d[k]=v
  return d
 return json.loads(b,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite')))
def descriptor(d,b):
 need(type(d)is dict and set(d)=={'path','bytes','sha256'} and type(d['path'])is str and d['path'].startswith('/') and type(d['bytes'])is int and pin(b)=={k:d[k] for k in ('bytes','sha256')},'descriptor_binding')
def checked_source_bytes(source_bytes):
 need(set(source_bytes)==set(DEPENDENCIES),'dependency_membership')
 for k,b in source_bytes.items():need((len(b),hashlib.sha256(b).hexdigest())==DEPENDENCIES[k],'dependency_pin')
 # Caller compiles/injects modules ONLY from these exact checked bytebuffers.
def verify_stock_witness(row,w,epoch,A):
 """Root-reviewed measured same-H getters, never source-policy qualification."""
 A.verify_measurement(row,w,epoch)
 return A.uintstr(row['physicalCashRaw']),A.uintstr(row['nominalClaimsRaw'])

def join_one(row,f,rawrow,offset,w,epoch,A):
 C,S=verify_stock_witness(row,w,epoch,A);need(C>0,'zero_origin_cash_requires_root_decision');T=row['issueAt'];p=rawrow['strictPreIssuePrefix']
 need(rawrow['status']=='RAW_LAGS_STOCK_JOIN_PENDING' and rawrow['issueAt']==T,'raw_origin')
 need(type(p['lastIncludedBlock'])is int and type(p['lastIncludedRecordedTs'])is int and p['lastIncludedBlock']<=row['blockNumber'] and p['lastIncludedRecordedTs']<=row['blockTimestamp']<T,'preT_block_clock')
 need(int(p['cumulativeNetRaw'])+offset==C==f['featureCash'],'prefix_cash_mismatch')
 boundary=T==row['nextBlockTimestamp']
 if boundary:
  # Evidence for B1 cash must itself be bound in the Root-reviewed witness file.
  q=w.get('issueBoundaryCash');need(type(q)is dict,'equality_boundary_evidence_missing')
  need((q['blockNumber'],q['blockHash'],q['timestamp'])==(row['nextBlockNumber'],row['nextBlockHash'],T),'equality_boundary_header')
  need(A.uintstr(q['physicalCashRaw'])==C,'equality_boundary_cash_changed')
 lags=rawrow['lags'];need(set(lags)==set(map(str,(3600,21600,86400,604800))),'four_windows');previous=[0]*5
 for window in (3600,21600,86400,604800):
  x=lags[str(window)];values=[A.uintstr(x[k]) for k in ('incomingRaw','outgoingRaw')]+[x[k] for k in ('incomingEventCount','outgoingEventCount','zeroNetEventCount')]
  need(all(type(v)is int and v>=0 for v in values) and x['totalEventCount']==sum(values[2:]) and int(x['netRaw'])==values[0]-values[1],'lag_arithmetic')
  need(all(v>=p for v,p in zip(values,previous)),'disjoint_bands');previous=values
  if x['totalEventCount']:
   need(type(x['maxIncludedEventBlock'])is int and x['maxIncludedEventBlock']<=row['blockNumber'] and type(x['maxIncludedRecordedTs'])is int and T-window<=x['maxIncludedRecordedTs']<=row['blockTimestamp']<T,'window_clock')
  else:need(x['maxIncludedEventBlock']is None and x['maxIncludedRecordedTs']is None,'empty_window')
  lower=rawrow['boundaryPrefixes'][str(window)];need(int(p['cumulativeNetRaw'])-int(lower['cumulativeNetRaw'])==int(x['netRaw']),'prefix_lag_net')
 result={'issueAt':T,'featureBlock':f['block'],'featureHash':f['hash'],'featureLagSeconds':f['lagSeconds'],'physicalCashRaw':row['physicalCashRaw'],'nominalClaimsRaw':row['nominalClaimsRaw'],'lags':{k:{n:v for n,v in x.items() if n not in ('maxIncludedEventBlock','maxIncludedRecordedTs')} for k,x in lags.items()}}
 return result,{'issueAt':T,'preTcashReconciled':True,'equalityBoundary':boundary,'boundaryCashEvidenceRequired':boundary,'inclusiveRecordedTAnchor':'future historical-runner checked_paths must still pass; not established by preT raw artifact'}

def join_admitted(raw_bytes,calendar_bytes,feature_bytes,proof_bytes,witness_bytes,authority_bytes,descriptors,A,K):
 """Pure; caller validates Root authority authenticity and compiles pinned A/K first.
 No flag/epoch/source proof is created or promoted. Root endorses compact measured fields against pinned raw journals.
 """
 need(pin(raw_bytes)==RAW_PIN and pin(calendar_bytes)==CAL_PIN,'frozen_raw_calendar')
 need(set(descriptors)=={'raw','calendar','features','proof','witness','authority','cache'},'descriptor_membership')
 for k,b in [('raw',raw_bytes),('calendar',calendar_bytes),('features',feature_bytes),('proof',proof_bytes),('witness',witness_bytes),('authority',authority_bytes)]:descriptor(descriptors[k],b)
 root=parse(authority_bytes);need(root['schema']=='q9-root-measured-base-stock-join-authority-v1' and root['status']=='ROOT_MEASURED_EXACT_STATES' and root.get('measurementProfile')==A.PROFILE and A.exact_limits(root.get('limits')),'explicit_root_admission')
 need(root['boundInputs']=={k:descriptors[k] for k in ('raw','calendar','features','proof','witness','cache')},'root_input_binding')
 raw=parse(raw_bytes);cal=parse(calendar_bytes);bundle=parse(feature_bytes);proof=parse(proof_bytes);witness=parse(witness_bytes)
 need(raw['status']=='RAW_LAGS_STOCK_JOIN_PENDING' and raw['inputPins']['cache']==descriptors['cache'],'raw_status_cache')
 need(type(cal)is list and len(cal)==118 and all(set(r)=={'issueAt','slot','split'} and r['slot']==3 for r in cal),'calendar')
 times=tuple(r['issueAt'] for r in cal);need(root['calendarPin']==CAL_PIN and root['originCount']==118,'root_calendar')
 qualified,exceptions=A.qualified_features(bundle,proof,descriptors['features'],times,64800);need(not exceptions and set(qualified)==set(times),'all118_admitted')
 expected=('candidate','canonicalWitness','executionReceipt','getterWitness')
 need(root.get('measurementProofRoles')==list(expected),'source_proof_roles')
 sp=root.get('measurementProofDescriptors')
 need(type(sp)is dict and set(sp)==set(expected),'source_proof_descriptors')
 for d in sp.values():
  need(type(d)is dict and set(d)=={'path','bytes','sha256'},'source_proof_descriptor_shape')
  need(type(d['path'])is str and 1<len(d['path'])<=4096 and d['path'].startswith('/') and '\x00' not in d['path'],'source_proof_descriptor_path')
  need(type(d['bytes'])is int and 0<d['bytes']<=64*2**20,'source_proof_descriptor_size')
  need(type(d['sha256'])is str and len(d['sha256'])==64 and all(c in '0123456789abcdef' for c in d['sha256']),'source_proof_descriptor_sha')
 need(witness['measurementProofDescriptors']==sp,'truthful_source_proof_binding')
 # Authenticity, fetched source contents, ABI semantics, role proofs and rounding
 # policy are external Root-review prerequisites, not established by these flags.
 rmap={r['issueAt']:r for r in raw['rows']};wmap={r['issueAt']:r for r in witness['rows']};bmap={r['issueAt']:r for r in bundle['rows']}
 need(len(rmap)==len(raw['rows'])==len(wmap)==len(witness['rows'])==len(bmap)==118 and set(rmap)==set(wmap)==set(bmap)==set(times),'exact118_join')
 offset=int(raw['conditionalReconstructionOffsetRawNotQualifiedStock']);rows=[];checks=[]
 for c in cal:
  T=c['issueAt'];r=rmap[T];need((r['slot'],r['split'])==(c['slot'],c['split']),'split_join');feature=bmap[T];epoch=proof['measuredEpochs'][feature['sourceEpochID']]
  x,check=join_one(feature,qualified[T],r,offset,wmap[T],epoch,A);K.coordinates(x);rows.append(x);checks.append(check)
 audit={'schema':'aave-usdc-audited-measured-base-features-v1','measurementProfile':A.PROFILE,'limits':dict(A.LIMITS),'rows':rows,'inputPins':{k:descriptors[k] for k in ('cache','features','proof')},'rawLagDescriptor':descriptors['raw'],'witnessDescriptor':descriptors['witness'],'authorityDescriptor':descriptors['authority'],'joinChecks':checks,'cashHistoryLimits':'conditional recorded BLOCK-NET; no conservation/asissued/holder claim; no U constructed'}
 A.audited_states(audit,qualified,times,64800,audit['inputPins'],K)
 return canonical(audit)
