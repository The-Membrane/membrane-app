"""Original-recipe preparation seams — CODEX CONTINUATION, generated inputs only.

No CLI or empirical admission. Caller authenticates exact adapter/original science.
Original24 cached arrays/coefficients are reused, never fitted by this component.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import numpy as np

HORIZONS=(6,12,24,72,168)
MODES=('REUSED_ORIGINAL24','PREPARED_ADDITIONAL_SERIES')
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FULL277_PREPARATION'
FIELDS={
    'sid':('int32',()),'ts':('int64',()),'p_fH':('float64',(5,)),
    'y':('uint8',(5,)),'label_valid':('bool',()),'legacy_label_valid':('bool',()),
    'future_missing_hours':('int32',()),'future_log_min':('float64',()),
    'Xbase':('float32',(12,)),'Xshape':('float32',(6,)),
    'quarter_cutoff':('int64',()),'p_fH_valid':('bool',()),'issue_eligible':('bool',()),
    'Xbase_missing':('bool',(12,)),'Xshape_missing':('bool',(6,)),
    'base_margin':('float64',(5,)),'base_margin_clipped':('bool',(5,)),'fH_fallback':('bool',())}
VOLUME={'volume_loader_returned_none','volume_length_mismatch'}


def need(ok,message):
    if not ok:raise ValueError(message)


def canonical(path):
    p=Path(path)
    need(p.is_absolute() and str(p.resolve())==str(p) and not p.is_symlink(),'canonical path')
    return p


def pin(path):
    p=canonical(path);h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def checked(record):
    need(set(record)=={'path','size','sha256'} and pin(record['path'])==record,'file pin mismatch')
    return canonical(record['path'])


def ready(status):
    need(status in (READY,ADMITTED),'DRAFT: preparation not admitted')


def admission_flags(status):
    # ADMITTED is meaningful only after the separate transport authenticates its
    # frozen parent request. Calling this pure seam is never an admission itself.
    ready(status)
    return dict(empirical_admission_status='NOT_ADMITTED' if status==READY else
                'ADMITTED_BASELINE_PREPARATION_ONLY',source_synthetic_component=status==READY,
                candidate_evaluation_status='NOT_RUN',forecast_promotion_status='NOT_ADMITTED')


def write_json(path,value):
    raw=json.dumps(value,allow_nan=False,separators=(',',':')).encode()
    need(len(raw)<=2*1024**2,'per-series JSON cap')
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:
        f.write(raw);f.flush();os.fsync(f.fileno())


def array_identity(arrays):
    return {name:dict(dtype=a.dtype.str,shape=list(a.shape),sha256=hashlib.sha256(a.tobytes()).hexdigest())
            for name,a in arrays.items()}


def exact_arrays(actual,expected):
    need(set(actual)==set(expected),'exact saved field inventory')
    for key,a in actual.items():
        b=expected[key]
        need(a.dtype==b.dtype and a.shape==b.shape and a.tobytes()==b.tobytes(),'exact saved array: '+key)


def validate(science,sid,h,arrays,metadata):
    need(set(arrays)==set(FIELDS),'original eighteen-field schema')
    n=len(arrays['sid']);need(0<=n<=1461,'daily calendar row cap')
    for name,(dtype,tail) in FIELDS.items():
        a=arrays[name]
        need(a.dtype==np.dtype(dtype) and a.shape==(n,)+tail,'original field dtype/shape: '+name)
        need(not np.isinf(a).any(),'infinite original field: '+name)
    ts=arrays['ts'];need(np.all(arrays['sid']==sid),'canonical series ID')
    need(np.all((ts>=science.producer.START)&(ts<science.producer.END)&(ts%86400==0)) and
         (n<2 or np.all(np.diff(ts)>0)),'original sorted daily calendar')
    need(metadata['sid']==sid and metadata['horizon']==h and metadata['counts']['rows']==n,'source metadata identity')
    need(VOLUME<=set(metadata) and all(type(metadata[k]) is bool for k in VOLUME),'original flat volume diagnostics')
    quarters=metadata['quarters'];cuts=[q['quarter_cutoff'] for q in quarters]
    need(cuts==sorted(set(cuts)) and set(cuts)==set(arrays['quarter_cutoff'].tolist()),'all original quarter metadata')
    boundaries=np.asarray(science.producer.quarters(),np.int64)
    if n:
        own=boundaries[np.searchsorted(boundaries,ts,side='right')-1]
        need(np.array_equal(own,arrays['quarter_cutoff']),'own-quarter row assignment')
    for q in quarters:
        at=arrays['quarter_cutoff']==q['quarter_cutoff'];qa=q['quarter_cutoff']
        need(q['n_rows']==int(at.sum()) and type(q['n_reg']) is int and q['n_reg']>=0,'quarter rows/mature support')
        need(q['fallback_rows']==int(arrays['fH_fallback'][at].sum()),'original fallback count')
        for name in ('har_label_end_max','library_label_end_max','fallback_library_label_end_max'):
            need(q[name] is None or (type(q[name]) is int and q[name]<=qa),'future library/regression label')
        need(q['har_label_end_min'] is None or q['har_label_end_min']<=qa,'future earliest regression label')
        coef=q['coef']
        need(coef is None or (type(coef)is list and len(coef)==4 and np.isfinite(coef).all()),'original retained coefficient schema')
        if coef is None:need(q['fallback_rows']==q['n_rows'],'None coefficient original fallback rule')
    valid=arrays['p_fH_valid'];p=arrays['p_fH'][valid]
    need(np.isfinite(p).all() and np.all((p>=0)&(p<=1)) and np.all(np.diff(p,axis=1)>=0),'declared baseline domain/order')
    known=arrays['label_valid'];y=arrays['y'][known]
    need(np.isin(y,[0,1]).all() and np.all(np.diff(y.astype(np.int8),axis=1)>=0),'known binary nested labels')
    need(np.array_equal(arrays['Xbase_missing'],~np.isfinite(arrays['Xbase'])) and
         np.array_equal(arrays['Xshape_missing'],~np.isfinite(arrays['Xshape'])),'unchanged missing-feature masks')
    counts=metadata['counts']
    scalar=dict(issue_eligible=int(arrays['issue_eligible'].sum()),label_valid=int(known.sum()),
        label_missing=int((~known).sum()),legacy_label_valid=int(arrays['legacy_label_valid'].sum()),
        p_fH_valid=int(valid.sum()),fallback_rows=int(arrays['fH_fallback'].sum()),
        future_missing_hours=int(arrays['future_missing_hours'].sum()),dropped_future_label_rows=0)
    need(all(counts[k]==v for k,v in scalar.items()),'source metadata count identity')
    need(counts['Xbase_missing']==arrays['Xbase_missing'].sum(0).tolist() and
         counts['Xshape_missing']==arrays['Xshape_missing'].sum(0).tolist(),'source feature count identity')


def prepare_one(adapter,science,sid,key,selected24,original_archives,original_metadata,root,*,
                ser=None,features=None,shape=None,feature_metadata=None,A6=None,M2=None,
                status='DRAFT',checkpoint=lambda:None):
    """Serial one-series stage. Inputs are authenticated by future transport, not here."""
    ready(status)
    need(type(sid)is int and 0<=sid<277 and isinstance(key,str),'canonical ID/key')
    need(len(selected24)==24 and len({s for s,k in selected24})==len({k for s,k in selected24})==24,'retained original24 selection')
    old=dict(selected24);need(sid not in old or old[sid]==key,'retained canonical identity')
    root=canonical(root);need(root.is_dir() and root.stat().st_mode&0o777==0o700,'private0700 preparation root')
    destination=root/('sid-'+str(sid));need(not destination.exists(),'exclusive per-SID preparation')
    if sid in old:
        mode=MODES[0];need(set(original_archives)==set(HORIZONS) and set(original_metadata)==set(HORIZONS),'original five-H cache closure')
        arrays={h:{k:v[v_sid] for k,v in original_archives[h].items()}
                for h in HORIZONS for v_sid in [original_archives[h]['sid']==sid]}
        metadata={h:copy.deepcopy(original_metadata[h][sid]) for h in HORIZONS}
    else:
        mode=MODES[1]
        need(ser is not None and features is not None and shape is not None and A6 is not None and M2 is not None,'additional series original-science inputs')
        need(set(feature_metadata or {})==VOLUME and all(type(v)is bool for v in feature_metadata.values()),'original raw_features diagnostics')
        arrays,metadata=adapter.stage_series(science,ser,sid,features,shape,A6,M2,checkpoint)
        for h in HORIZONS:metadata[h].update(copy.deepcopy(feature_metadata))
    for h in HORIZONS:validate(science,sid,h,arrays[h],metadata[h])
    destination.mkdir(mode=0o700);outputs={};identities={};rows={};logical=0
    for h in HORIZONS:
        checkpoint();a=arrays[h];before=array_identity(a)
        path=destination/('horizon-'+str(h)+'.npz')
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:
            np.savez_compressed(f,**a);f.flush();os.fsync(f.fileno())
        with np.load(path,allow_pickle=False) as z:restored={k:z[k] for k in z.files}
        exact_arrays(restored,a);need(array_identity(restored)==before,'readback array identity')
        outputs[str(h)]=pin(path);identities[str(h)]=before;rows[str(h)]=len(a['sid'])
        logical+=sum(v.nbytes for v in a.values());del restored
    meta=dict(schema='q26-full277-preparation-series-metadata-v1',sid=sid,key=key,mode=mode,
              series_horizons=[metadata[h] for h in HORIZONS])
    path=destination/'quarter-metadata.json';write_json(path,meta)
    need(json.loads(path.read_bytes())==meta,'exact quarter metadata readback');outputs['metadata']=pin(path)
    receipt=dict(schema='q26-full277-preparation-series-receipt-v1',sid=sid,key=key,mode=mode,complete=True,
        outputs=outputs,arrays=identities,rows=rows,logical_array_bytes=logical)
    for record in outputs.values():checked(record)
    write_json(destination/'receipt.json',receipt)
    need({p.name for p in destination.iterdir()}=={'horizon-'+str(h)+'.npz' for h in HORIZONS}|
         {'quarter-metadata.json','receipt.json'},'exact seven-file series inventory')
    return pin(destination/'receipt.json')


def finalize(mapping,selected24,receipts,root,*,status='DRAFT'):
    """Only all277 completed receipts can form a source/synthetic manifest."""
    ready(status);root=canonical(root)
    need(len(mapping)==277 and mapping==[[i,key] for i,(sid,key) in enumerate(mapping)] and
         len({key for sid,key in mapping})==277,'complete canonical277 mapping')
    need(len(selected24)==24 and len({sid for sid,key in selected24})==24 and
         all(type(sid)is int and 0<=sid<277 and mapping[sid]==[sid,key] for sid,key in selected24),'original24 regression map')
    need(len(receipts)==277,'all277 preparation receipts')
    indexed={}
    for record in receipts:
        path=checked(record);data=json.loads(path.read_bytes());sid=data['sid']
        need(type(sid)is int and sid not in indexed and 0<=sid<277 and data['key']==mapping[sid][1] and data['complete'] is True,'complete unique prepared SID')
        need(data['mode']==(MODES[0] if sid in dict(selected24) else MODES[1]),'reuse/new preparation policy')
        need(path==root/('sid-'+str(sid))/'receipt.json','canonical receipt location')
        need(set(data['outputs'])=={str(h) for h in HORIZONS}|{'metadata'},'six pinned series outputs')
        expected_files={'receipt.json','quarter-metadata.json'}|{'horizon-'+str(h)+'.npz' for h in HORIZONS}
        need({p.name for p in path.parent.iterdir()}==expected_files,'exact per-SID file inventory')
        for role,pin_record in data['outputs'].items():
            target=checked(pin_record)
            expected=path.parent/('quarter-metadata.json' if role=='metadata' else 'horizon-'+role+'.npz')
            need(target==expected,'per-SID output containment')
        indexed[sid]=record
    need(set(indexed)==set(range(277)) and {p.name for p in root.iterdir()}=={'sid-'+str(s) for s in range(277)},'no missing/extra preparation outputs')
    result=dict(schema='q26-full277-preparation-manifest-v1',scope='FULL277_ORIGINAL_RECIPE_PREPARATION',
        label='CODEX CONTINUATION',canonical_mapping=mapping,series_receipts=[indexed[s] for s in range(277)],
        original24_mode='REUSED_EXACT_SAVED',**admission_flags(status))
    write_json(root/'manifest.json',result)
    return pin(root/'manifest.json')
