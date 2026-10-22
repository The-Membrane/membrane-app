"""Unchanged fixed-C evaluation seams — CODEX CONTINUATION.

No CLI/admission. Exact science and prepared inputs come from authenticated
transport. This component never stages baselines or estimates HAR coefficients.
"""
import hashlib
import json
import os
from pathlib import Path
import numpy as np

SCOPE='FULL277_UNCHANGED_FIXED_C_EVALUATION'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FULL277_FIXED_C_EVALUATION'
PAIR_CAP=64*1024
SUMMARY_CAP=256*1024
RECEIPT_CAP=64*1024
REPORT_CAP=64*1024**2
NATIVE_CAP=16*1024**2
MANIFEST_CAP=8*1024**2


def need(ok,message):
    if not ok:raise ValueError(message)


def admission_flags(status):
    need(status in (READY,ADMITTED),'DRAFT: fixed-C evaluation not admitted')
    return dict(empirical_admission_status='NOT_ADMITTED' if status==READY else
                'ADMITTED_SEEN_DEVELOPMENT_FIXED_C_EVALUATION_ONLY',
                source_synthetic_component=status==READY,
                candidate_evaluation_status='SYNTHETIC_ONLY' if status==READY else 'EVALUATED_UNCHANGED_C',
                forecast_promotion_status='NOT_ADMITTED',unseen_validation=False)


def canonical(path):
    p=Path(path)
    need(p.is_absolute() and str(p.resolve())==str(p) and not p.is_symlink(),'canonical evaluation path')
    return p


def pin(path):
    p=canonical(path);h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''):h.update(block)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def checked(record,cap):
    need(set(record)=={'path','size','sha256'} and type(record['size'])is int and
         0<=record['size']<=cap and canonical(record['path']).stat().st_size==record['size'] and pin(record['path'])==record,'evaluation file pin/cap')
    return canonical(record['path'])


def read(record,cap):
    path=checked(record,cap)
    def pairs(items):
        result={}
        for key,value in items:need(key not in result,'duplicate evaluation JSON');result[key]=value
        return result
    def bad(_):raise ValueError('nonfinite evaluation JSON')
    def finite(value):
        result=float(value);need(np.isfinite(result),'nonfinite evaluation JSON');return result
    return json.loads(path.read_bytes(),object_pairs_hook=pairs,parse_constant=bad,parse_float=finite)


def write(path,value,cap):
    raw=json.dumps(value,allow_nan=False,separators=(',',':')).encode();need(len(raw)<=cap,'evaluation output cap')
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:
        f.write(raw);f.flush();os.fsync(f.fileno())
    result=pin(path);need(read(result,cap)==value,'evaluation JSON readback');return result


def evaluate_one(adapter,science,prep_checker,A6,M2,D,ser,sid,key,prepared_receipt_pin,out,*,
                 status='DRAFT',checkpoint=lambda:None):
    flags=admission_flags(status)
    root=canonical(out);need(root.is_dir() and root.stat().st_mode&0o777==0o700,'private0700 evaluation root')
    destination=root/('sid-'+str(sid));need(not destination.exists(),'exclusive evaluation SID')
    # Authentication/schema only. O166 already performed scientific preparation replay.
    _,archives,metadata=prep_checker.authenticated_series(prepared_receipt_pin,sid=sid,key=key)
    saved,ledger=adapter.attach_joint(science,archives);del archives
    destination.mkdir(mode=0o700);quarter_root=destination/'quarters';quarter_root.mkdir(mode=0o700)
    result=adapter.evaluate_series(science,A6,M2,D,ser,sid,metadata[24],saved,ledger,quarter_root,checkpoint)
    need(len(result.quarters)<=8 and len(result.persistence)==2*len(result.quarters),'eight-calendar evaluation inventory')
    for record in result.persistence:checked(record,PAIR_CAP)
    summary=dict(schema='q26-full277-fixed-c-series-summary-v1',sid=sid,key=key,
        prepared_receipt=prepared_receipt_pin,status=result.status,source_rows=len(saved['sid']),
        joint_ledger=result.joint_ledger,quarter_records=result.quarters)
    summary_pin=write(destination/'summary.json',summary,SUMMARY_CAP)
    receipt=dict(schema='q26-full277-fixed-c-series-receipt-v1',scope=SCOPE,sid=sid,key=key,
        prepared_receipt=prepared_receipt_pin,summary=summary_pin,quarters=result.persistence,complete=True,**flags)
    receipt_pin=write(destination/'receipt.json',receipt,RECEIPT_CAP)
    # Readback binds ALL original state arrays, not only their compressed files.
    restored=read_one(adapter,science,prep_checker,receipt_pin,status=status)
    need(set(restored.predictions)==set(result.predictions),'prediction readback fields')
    for name,a in result.predictions.items():
        b=restored.predictions[name]
        need(a.dtype==b.dtype and a.shape==b.shape and a.tobytes()==b.tobytes(),'exact prediction readback')
    return receipt_pin


def read_one(adapter,science,prep_checker,receipt_pin,*,status='DRAFT'):
    flags=admission_flags(status);receipt=read(receipt_pin,RECEIPT_CAP)
    need(set(receipt)=={'schema','scope','sid','key','prepared_receipt','summary','quarters','complete',*flags} and
         receipt['schema']=='q26-full277-fixed-c-series-receipt-v1' and receipt['scope']==SCOPE and
         receipt['complete'] is True and all(type(receipt[k])is type(v) and receipt[k]==v for k,v in flags.items()),'fixed-C receipt scope')
    sid,key=receipt['sid'],receipt['key'];need(type(sid)is int and 0<=sid<277 and isinstance(key,str),'fixed-C ID/key')
    root=canonical(receipt_pin['path']).parent
    need(root.name=='sid-'+str(sid) and Path(receipt_pin['path']).name=='receipt.json','fixed-C receipt location')
    need(receipt['summary']['path']==str(root/'summary.json'),'fixed-C summary location')
    summary=read(receipt['summary'],SUMMARY_CAP);records=summary['quarter_records'];pairs=receipt['quarters']
    need(set(summary)=={'schema','sid','key','prepared_receipt','status','source_rows','joint_ledger','quarter_records'} and
         summary['schema']=='q26-full277-fixed-c-series-summary-v1' and summary['sid']==sid and summary['key']==key and
         summary['prepared_receipt']==receipt['prepared_receipt'],'fixed-C summary identity')
    need(len(records)<=8 and len(pairs)==2*len(records),'fixed-C calendar pair inventory')
    # Every signed file authenticates before the first private prediction decode.
    for record in pairs:checked(record,PAIR_CAP)
    need({p.name for p in root.iterdir()}=={'summary.json','receipt.json','quarters'},'fixed-C exact SID files')
    expected={}
    for i,q in enumerate(records):
        stem='sid-%d-q-%d.private'%(sid,q['quarter_cutoff'])
        need(q['sid']==sid and stem not in expected,'unique fixed-C quarter record');expected[stem]=q
        need(pairs[2*i]['path']==str(root/'quarters'/(stem+'.npz')) and
             pairs[2*i+1]['path']==str(root/'quarters'/(stem+'.json')),'ordered exact quarter pair paths')
    need({p.name for p in (root/'quarters').iterdir()}=={stem+ext for stem in expected for ext in ('.npz','.json')},'fixed-C exact quarter files')
    _,archives,metadata=prep_checker.authenticated_series(receipt['prepared_receipt'],sid=sid,key=key)
    saved,ledger=adapter.attach_joint(science,archives);del archives
    prep_checker.C.exact(ledger,summary['joint_ledger'],'fixed-C five-H ledger')
    need(summary['source_rows']==len(saved['sid']),'fixed-C full H24 source rows')
    evaluation=[q['quarter_cutoff'] for q in metadata[24]['quarters'] if science.runner.EVAL0<=q['quarter_cutoff']<science.runner.END]
    need([q['quarter_cutoff'] for q in records]==evaluation,'every evaluation quarter retained')
    expected_status='CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE' if evaluation else 'NO_EVALUATION_QUARTERS_ZERO_J'
    need(summary['status']==expected_status,'fixed-C series status')
    parts=[]
    for i,q in enumerate(records):
        npin,jpin=pairs[2*i:2*i+2];private=read(jpin,PAIR_CAP)
        need(private['sid']==sid and private['quarter_cutoff']==q['quarter_cutoff'] and
             private['rows']==q['J_n'] and private['forecasts_only_on_original_J'] is True and
             private['file']==Path(npin['path']).name and private['size']==npin['size'] and private['sha256']==npin['sha256'],'fixed-C private receipt binding')
        a=prep_checker.C.read_archive(npin['path']);n=q['J_n']
        need(set(a)=={'sid','ts','on_J','candidate_prediction_valid','fH_fallback','issuance_state',*science.runner.ARMS},'fixed-C original state fields')
        need(a['sid'].dtype==np.int32 and a['ts'].dtype==np.int64 and a['sid'].shape==a['ts'].shape==(n,) and
             np.all(a['sid']==sid),'fixed-C state exact keys')
        for flag in ('on_J','candidate_prediction_valid'):
            need(a[flag].dtype==bool and a[flag].shape==(n,) and a[flag].all(),'fixed-C valid J flags')
        need(a['fH_fallback'].dtype==bool and a['fH_fallback'].shape==(n,) and
             a['issuance_state'].dtype==np.int8 and a['issuance_state'].shape==(n,) and
             np.isin(a['issuance_state'],[-1,0,1]).all(),'fixed-C auxiliary state schema')
        own=(saved['quarter_cutoff']==q['quarter_cutoff'])&saved['on_J']
        need(a['ts'].tobytes()==saved['ts'][own].tobytes() and
             a['fH_fallback'].tobytes()==saved['fH_fallback'][own].tobytes(),'fixed-C own-quarter keys/fallback')
        for arm in science.runner.ARMS:
            need(a[arm].dtype==np.float64 and a[arm].shape==(n,5) and np.isfinite(a[arm]).all() and
                 np.all((a[arm]>=0)&(a[arm]<=1)) and np.all(np.diff(a[arm],axis=1)>=0),'fixed-C probabilities/order')
        parts.append(a)
    names=('sid','ts',*science.runner.ARMS)
    predictions={name:np.concatenate([p[name] for p in parts]) if parts else
        np.empty((0,5),np.float64) if name in science.runner.ARMS else np.empty(0,np.int32 if name=='sid' else np.int64)
        for name in names}
    expected_keys=list(zip(saved['sid'][saved['on_J']].tolist(),saved['ts'][saved['on_J']].tolist()))
    actual_keys=list(zip(predictions['sid'].tolist(),predictions['ts'].tolist()))
    need(actual_keys==expected_keys and len(actual_keys)==len(set(actual_keys)),'all and only original five-H J in source order')
    need(np.array_equal(predictions['A_raw_fH'],saved['p_fH'][saved['on_J']]),'unchanged raw baseline')
    return adapter.SeriesResult(saved,predictions,records,pairs,ledger,summary['status'])


def finalize(adapter,control,science,prep_checker,mapping,selected24,receipts,cuts,
             original_private_pins,original_canonical_report,root,*,status='DRAFT',checkpoint=lambda:None):
    flags=admission_flags(status);root=canonical(root)
    need(len(mapping)==277 and mapping==[[i,key] for i,(sid,key) in enumerate(mapping)] and
         len({key for sid,key in mapping})==277,'canonical277 fixed-C universe')
    need(len(selected24)==24 and len({s for s,k in selected24})==24 and
         all(type(s)is int and 0<=s<277 and mapping[s]==[s,k] for s,k in selected24),'original24 regression map')
    need(len(receipts)==277,'complete277 fixed-C receipt inventory')
    results=[]
    for sid,(key,record) in enumerate(zip((k for s,k in mapping),receipts)):
        checkpoint();need(Path(record['path'])==root/('sid-'+str(sid))/'receipt.json','canonical fixed-C receipt order')
        result=read_one(adapter,science,prep_checker,record,status=status)
        r=read(record,RECEIPT_CAP);need(r['sid']==sid and r['key']==key,'fixed-C receipt canonical identity')
        results.append(result)
    need({p.name for p in root.iterdir()}=={'sid-'+str(s) for s in range(277)},'fixed-C exact global SID inventory')
    old_ids={s for s,k in selected24};old=[results[s] for s in range(277) if s in old_ids]
    old_saved={k:np.concatenate([r.saved[k] for r in old]) for k in old[0].saved}
    old_records=[q for r in old for q in r.quarters]
    need(len(old_records)==191,'mandatory original191 calendar controls')
    fresh_private=[p for r in old for p in r.persistence]
    control.compare_quarters(adapter,fresh_private,original_private_pins,old_records)
    predictions=control.align_predictions(science,old_saved,old)
    # Compare ONLY original24 canonical native54 against the accepted O163 control.
    native=control.original_report_control(science,old_saved,cuts,selected24,predictions,old_records,original_canonical_report)
    component=adapter.report(science,results,cuts,mapping)
    control_status=dict(private_pairs='EXACT',canonical_native54='EXACT')
    wrapper=dict(schema='q26-full277-fixed-c-report-v1',scope=SCOPE,label='CODEX CONTINUATION',complete=True,
        component=component,original24_control=control_status,**flags)
    report_pin=write(root/'report.json',wrapper,REPORT_CAP)
    native_pin=write(root/'original24-canonical-native-report.json',native,NATIVE_CAP)
    for record in receipts:
        r=read(record,RECEIPT_CAP);checked(r['summary'],SUMMARY_CAP)
        for quarter in r['quarters']:checked(quarter,PAIR_CAP)
    manifest=dict(schema='q26-full277-fixed-c-manifest-v1',scope=SCOPE,label='CODEX CONTINUATION',complete=True,
        canonical_mapping=mapping,series_receipts=receipts,reports=dict(component=report_pin,original24_canonical_native=native_pin),
        original24_control=control_status,**flags)
    return write(root/'manifest.json',manifest,MANIFEST_CAP)
