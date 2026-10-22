"""Pure independent full277 saved-preparation verifier; no empirical transport.

No import of preparation.py or the expansion adapter. Scientific reference is
ONLY the authenticated original builder/legacy objects supplied by the caller.
Fits are forbidden: retained quarter coefficients are replayed, not estimated.
"""
import hashlib
from pathlib import Path
import types
import numpy as np
import control_check as C

HORIZONS=(6,12,24,72,168)
MODES={'REUSED_ORIGINAL24','PREPARED_ADDITIONAL_SERIES'}
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FULL277_PREPARATION'
FIXTURE='SYNTHETIC_TYPED_ZERO_INVENTORY_FIXTURE_ONLY'


def admission_flags(status):
    C.require(status in (READY,ADMITTED),'DRAFT: preparation verification not admitted')
    return dict(source_synthetic_component=status==READY,
                empirical_admission_status='NOT_ADMITTED' if status==READY else 'ADMITTED_BASELINE_PREPARATION_ONLY',
                candidate_evaluation_status='NOT_RUN',forecast_promotion_status='NOT_ADMITTED')
FIELDS={'sid':('int32',()),'ts':('int64',()),'p_fH':('float64',(5,)),
        'y':('uint8',(5,)),'label_valid':('bool',()),'legacy_label_valid':('bool',()),
        'future_missing_hours':('int32',()),'future_log_min':('float64',()),
        'Xbase':('float32',(12,)),'Xshape':('float32',(6,)),
        'quarter_cutoff':('int64',()),'p_fH_valid':('bool',()),'issue_eligible':('bool',()),
        'Xbase_missing':('bool',(12,)),'Xshape_missing':('bool',(6,)),
        'base_margin':('float64',(5,)),'base_margin_clipped':('bool',(5,)),
        'fH_fallback':('bool',())}


def array_digest(value):
    return hashlib.sha256(value.tobytes(order='C')).hexdigest()


def array_record(value):
    return dict(dtype=value.dtype.str,shape=list(value.shape),sha256=array_digest(value))


def require_schema(a,sid):
    C.require(set(a)==set(FIELDS),'original preparation field inventory')
    n=len(a['sid']);C.require(n<=1461,'daily original calendar bound')
    for field,(dtype,tail) in FIELDS.items():
        value=a[field]
        C.require(value.dtype==np.dtype(dtype) and value.shape==(n,*tail),'saved field schema: '+field)
        if value.dtype.kind=='f':C.require(not np.isinf(value).any(),'infinite saved field')
    C.require(np.all(a['sid']==sid) and np.all(a['ts']%86400==0) and np.all(np.diff(a['ts'])>0) and
              np.all((a['ts']>=1640995200)&(a['ts']<1767225600)),'saved daily keys')
    C.require(np.array_equal(a['Xbase_missing'],~np.isfinite(a['Xbase'])) and
              np.array_equal(a['Xshape_missing'],~np.isfinite(a['Xshape'])),'feature missingness masks')
    valid=np.all(np.isfinite(a['p_fH'])&(a['p_fH']>=0)&(a['p_fH']<=1),axis=1)
    C.require(np.array_equal(valid,a['p_fH_valid']) and np.all(np.diff(a['p_fH'][valid],axis=1)>=0),'saved baseline validity/order')
    C.require(np.all((a['y']==0)|(a['y']==1)) and np.all(a['y'][~a['label_valid']]==0) and
              np.all((a['future_missing_hours']>=0)),'label domain and unknown placeholders')
    C.require(np.array_equal(np.isfinite(a['future_log_min']),a['label_valid']),'label depth validity')
    import datetime as dt
    own=np.array([int(dt.datetime(d.year,3*((d.month-1)//3)+1,1,tzinfo=dt.timezone.utc).timestamp())
                  for d in (dt.datetime.fromtimestamp(int(t),dt.timezone.utc) for t in a['ts'])],dtype=np.int64)
    C.require(np.array_equal(own,a['quarter_cutoff']),'own quarter vintage')


def authenticated_series(receipt_pin,*,sid,key):
    """Hash exactly seven saved files before the first numeric payload decode."""
    receipt=C.decode(C.checked(receipt_pin).read_bytes())
    C.require(set(receipt)=={'schema','sid','key','mode','complete','outputs','arrays','rows','logical_array_bytes'} and
              receipt['schema']=='q26-full277-preparation-series-receipt-v1' and
              type(receipt['sid']) is int and receipt['sid']==sid and receipt['key']==key and
              receipt['mode'] in MODES and receipt['complete'] is True,'series receipt identity')
    outputs=receipt['outputs'];C.require(set(outputs)=={*(str(h) for h in HORIZONS),'metadata'},'five shard and metadata closure')
    root=Path(receipt_pin['path']).parent
    C.require(root.name=='sid-'+str(sid) and Path(receipt_pin['path']).name=='receipt.json','series output root')
    for role,pin in outputs.items():
        C.checked(pin)
        name='quarter-metadata.json' if role=='metadata' else 'horizon-'+role+'.npz'
        C.require(Path(pin['path'])==root/name,'exact series shard path')
    C.require({p.name for p in root.iterdir()}=={'receipt.json','quarter-metadata.json',*(f'horizon-{h}.npz' for h in HORIZONS)},'exact seven series files')
    metadata=C.decode(Path(outputs['metadata']['path']).read_bytes())
    C.require(set(metadata)=={'schema','sid','key','mode','series_horizons'} and
              metadata['schema']=='q26-full277-preparation-series-metadata-v1' and
              metadata['sid']==sid and metadata['key']==key and metadata['mode']==receipt['mode'],'series metadata identity')
    records=metadata['series_horizons']
    C.require(len(records)==5 and [m['horizon'] for m in records]==list(HORIZONS) and all(m['sid']==sid for m in records),'five exact horizon metadata records')
    arrays={h:C.read_archive(outputs[str(h)]['path']) for h in HORIZONS}
    C.require(set(receipt['arrays'])==set(receipt['rows'])=={str(h) for h in HORIZONS},'receipt horizon inventories')
    logical=0
    for h,a in arrays.items():
        require_schema(a,sid)
        C.exact(receipt['arrays'][str(h)],{k:array_record(v) for k,v in a.items()},'saved field receipt')
        C.require(type(receipt['rows'][str(h)]) is int and receipt['rows'][str(h)]==len(a['sid']),'saved row receipt')
        logical+=sum(v.nbytes for v in a.values())
    C.require(type(receipt['logical_array_bytes']) is int and receipt['logical_array_bytes']==logical,'logical array byte count')
    return receipt,arrays,{m['horizon']:m for m in records}


def replay_retained(science,A6,M2,ser,sid,horizon,features,shape,metadata,checkpoint=lambda:None):
    """Independent original-recipe replay with no regression or new selection."""
    records=metadata['quarters'];by_cut={m['quarter_cutoff']:m for m in records}
    C.require(len(by_cut)==len(records),'unique retained quarters')
    class RetainedPrep:
        def __init__(self,prepared):self.prepared=prepared
        def __getattr__(self,name):return getattr(self.prepared,name)
        def har_coef(self,qs):
            qa=ser.base_ts+3600*qs
            C.require(qa in by_cut,'requested own-quarter retained coefficient')
            record=by_cut[qa];p=self.prepared
            mature=np.arange(p.n)+horizon<=qs
            n=int(np.sum(p.okH&mature))
            C.require(type(record['n_reg']) is int and record['n_reg']==n,'independent mature regression count')
            coef=record['coef']
            C.require((coef is None)==(n<4),'original retained None coefficient rule')
            if coef is not None:
                coef=np.asarray(coef,dtype=np.float64)
                C.require(coef.shape==(4,) and np.isfinite(coef).all(),'retained coefficient schema')
            return coef,dict(n_reg=n)
    def factory(series,h,with_fbL=False):
        C.require(series is ser and h==horizon and with_fbL is False,'prepared horizon identity')
        return RetainedPrep(A6.Prep6(series,h,with_fbL=False))
    with science.reference_runner.no_regression(A6.Prep6):
        return science.producer.build_horizon(ser,horizon,sid,features,shape,types.SimpleNamespace(Prep6=factory),M2,checkpoint)


def check_series(science,A6,M2,D,ser,spec,receipt_pin,*,sid,key,
                 original_archives=None,original_metadata=None,status='DRAFT',checkpoint=lambda:None):
    """Pure seam: caller owns authenticated raw/runtime admission and scope."""
    flags=admission_flags(status)
    receipt,arrays,metadata=authenticated_series(receipt_pin,sid=sid,key=key)
    if receipt['mode']=='REUSED_ORIGINAL24':
        C.require(original_archives is not None and original_metadata is not None and
                  set(original_archives)==set(original_metadata)==set(HORIZONS),'original24 golden closure')
        for h in HORIZONS:
            C.exact_arrays(arrays[h],original_archives[h]);C.exact(metadata[h],original_metadata[h],'original24 exact metadata')
        basis='EXACT_ORIGINAL_SAVED_ARRAYS_AND_METADATA'
    else:
        C.require(original_archives is None and original_metadata is None and ser is not None and
                  spec['key']==key,'new series authenticated raw identity')
        features,shape,vmeta=science.producer.raw_features(ser,spec,D,A6)
        for h in HORIZONS:
            checkpoint()
            rebuilt,record=replay_retained(science,A6,M2,ser,sid,h,features,shape,metadata[h],checkpoint)
            record.update(vmeta)
            C.exact_arrays(arrays[h],rebuilt);C.exact(metadata[h],record,'retained-coefficient original-recipe metadata')
        basis='ALL_FIVE_HORIZONS_REPLAYED_WITH_RETAINED_COEFFICIENTS_NO_REFIT'
    # Rehash every saved byte after numerical verification.
    C.checked(receipt_pin)
    for pin in receipt['outputs'].values():C.checked(pin)
    return dict(schema='q26-full277-preparation-series-check-v1',sid=sid,key=key,mode=receipt['mode'],complete=True,
                receipt_pin=receipt_pin,verification_basis=basis,checker_regression_calls=0,
                fit_origin_independently_refit=False,**flags,C_candidate_evaluated=False)


def check_manifest(manifest_pin,mapping,selected24,checks,*,status='DRAFT'):
    """Bind all277 individual numerical results to the exact saved manifest."""
    flags=admission_flags(status)
    manifest=C.decode(C.checked(manifest_pin).read_bytes());root=Path(manifest_pin['path']).parent
    C.require(set(manifest)=={'schema','scope','label','canonical_mapping','series_receipts','original24_mode',
              'empirical_admission_status','source_synthetic_component','candidate_evaluation_status','forecast_promotion_status'} and
              manifest['schema']=='q26-full277-preparation-manifest-v1' and
              manifest['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and manifest['label']=='CODEX CONTINUATION' and
              all(type(manifest[k]) is type(v) and manifest[k]==v for k,v in flags.items()) and
              manifest['original24_mode']=='REUSED_EXACT_SAVED','preparation manifest scope')
    C.require(len(mapping)==277 and mapping==[[i,k] for i,(_,k) in enumerate(mapping)] and
              len({key for sid,key in mapping})==277,'canonical277 universe')
    C.exact(manifest['canonical_mapping'],mapping,'manifest canonical universe')
    old=dict(selected24)
    C.require(len(selected24)==len(old)==24 and all(mapping[s]==[s,k] for s,k in selected24),'original24 mapping')
    receipts=manifest['series_receipts'];C.require(len(receipts)==len(checks)==277,'all277 checks and receipts')
    C.require([c['sid'] for c in checks]==list(range(277)),'canonical per-series check order')
    for sid,(pin,result) in enumerate(zip(receipts,checks)):
        C.checked(pin)
        C.require(Path(pin['path'])==root/('sid-'+str(sid))/'receipt.json' and
                  result['complete'] is True and result['receipt_pin']==pin and result['key']==mapping[sid][1] and
                  result['mode']==('REUSED_ORIGINAL24' if sid in old else 'PREPARED_ADDITIONAL_SERIES') and
                  result['checker_regression_calls']==0 and result['fit_origin_independently_refit'] is False and
                  result['C_candidate_evaluated'] is False,'exact per-series numerical check binding')
        C.require(all(type(result[k]) is type(v) and result[k]==v for k,v in flags.items()),'per-series admission scope drift')
        expected_basis='EXACT_ORIGINAL_SAVED_ARRAYS_AND_METADATA' if sid in old else 'ALL_FIVE_HORIZONS_REPLAYED_WITH_RETAINED_COEFFICIENTS_NO_REFIT'
        C.require(result['verification_basis']==expected_basis or (status==READY and result['verification_basis']==FIXTURE), 'numeric verification basis or explicit synthetic inventory fixture')
        receipt=C.decode(Path(pin['path']).read_bytes())
        for output in receipt['outputs'].values():C.checked(output)
    C.require({p.name for p in root.iterdir()}=={'manifest.json',*('sid-'+str(s) for s in range(277))},'exact277 root inventory')
    C.checked(manifest_pin)
    replayed=sum(c['mode']=='PREPARED_ADDITIONAL_SERIES' and c['verification_basis']=='ALL_FIVE_HORIZONS_REPLAYED_WITH_RETAINED_COEFFICIENTS_NO_REFIT' for c in checks)
    fixtures=sum(c['verification_basis']==FIXTURE for c in checks)
    return dict(schema='q26-full277-preparation-check-v1',complete=True,series=277,horizons_per_series=5,
                original24_reused_exact=all(c['verification_basis']=='EXACT_ORIGINAL_SAVED_ARRAYS_AND_METADATA' for c in checks if c['sid'] in old),
                additional253_retained_coefficient_replay=replayed==253,scientifically_replayed_additional_series=replayed,
                synthetic_inventory_fixture_series=fixtures,checker_regression_calls=0,
                fit_origin_evidence='AUTHENTICATED_ORIGINAL_RECIPE_AND_CLEAN_PRODUCER_RUN_NOT_INDEPENDENT_REFIT',
                **flags,C_candidate_evaluated=False)
