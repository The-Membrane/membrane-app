"""Independent saved unchanged-C verification. No producer/adapter oracle or fits.

Caller owns authenticated sources/raw/runtime and explicit observer admission.
Default DRAFT refuses before bytes are read. Imports are authenticated source
aliases installed by the transport, never authority to run an empirical job.
"""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import numpy as np
import control_check as C
import preparation_check as P

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FULL277_FIXED_C_EVALUATION'
SCOPE='FULL277_UNCHANGED_FIXED_C_EVALUATION'
HORIZONS=(6,12,24,72,168)
ARMS=('A_raw_fH','B_common_shape','C_conditional')
FIELDS=('sid','ts','y','label_valid','issue_eligible','p_fH_valid','fH_fallback','p_fH','Xbase','Xshape','on_J')


def admission_flags(status):
    C.require(status in (READY,ADMITTED),'DRAFT: fixed-C evaluation not admitted')
    return dict(empirical_admission_status='NOT_ADMITTED' if status==READY else
                'ADMITTED_SEEN_DEVELOPMENT_FIXED_C_EVALUATION_ONLY',source_synthetic_component=status==READY,
                candidate_evaluation_status='SYNTHETIC_ONLY' if status==READY else 'EVALUATED_UNCHANGED_C',
                forecast_promotion_status='NOT_ADMITTED',unseen_validation=False)


def bounded(pin,cap):
    C.require(type(pin) is dict and type(pin.get('size')) is int and 0<=pin['size']<=cap,'bounded artifact metadata')
    return C.checked(pin)


def read(pin,cap):return C.decode(bounded(pin,cap).read_bytes())


def summary(sid,ts,mask):
    ids=np.column_stack((sid[mask],ts[mask])).astype('<i8')
    order=np.lexsort((ids[:,1],ids[:,0]))
    return dict(n=int(mask.sum()),membership_sha256=hashlib.sha256(ids[order].tobytes()).hexdigest())


def derive_joint(science,archives):
    """Own label-independent five-way membership, including empty intersections."""
    C.require(set(archives)==set(HORIZONS),'five horizon closure')
    maps={};keys={}
    for h,a in archives.items():
        science.joint_driver.validate_archive(a)
        keys[h]=[(int(s),int(t)) for s,t in zip(a['sid'],a['ts'])]
        C.require(len(keys[h])==len(set(keys[h])),'unique prepared keys')
        maps[h]={key:i for i,key in enumerate(keys[h])}
    for i,h in enumerate(HORIZONS):
        for longer in HORIZONS[i+1:]:
            for key in maps[h].keys()&maps[longer].keys():
                C.require(not archives[longer]['label_valid'][maps[longer][key]] or
                          archives[h]['label_valid'][maps[h][key]],'complete longer path contradicts incomplete prefix')
    common=sorted(set.intersection(*(set(m) for m in maps.values())))
    sid=np.asarray([s for s,t in common],np.int32);ts=np.asarray([t for s,t in common],np.int64)
    available=np.asarray([all(bool(archives[h]['issue_eligible'][maps[h][key]]) and
                  bool(archives[h]['p_fH_valid'][maps[h][key]]) for h in HORIZONS) for key in common],bool)
    complete=np.asarray([all(bool(archives[h]['label_valid'][maps[h][key]]) for h in HORIZONS) for key in common],bool)
    J=available&(ts>=science.runner.EVAL0)&(ts<science.runner.END);L=J&complete
    jkeys={common[i] for i in np.flatnonzero(J)};commonset=set(common)
    ledger={}
    for h,a in archives.items():
        inc=np.asarray([k in commonset for k in keys[h]],bool);inj=np.asarray([k in jkeys for k in keys[h]],bool)
        issue=a['issue_eligible'];valid=a['p_fH_valid'];known=a['label_valid'];av=issue&valid
        scopes={};calendar=(a['ts']>=science.runner.EVAL0)&(a['ts']<science.runner.END)
        for name,base in (('all_history',np.ones(len(issue),bool)),('evaluation',calendar)):
            masks=dict(rows=base,issued=base&issue,baseline_unavailable=base&issue&~valid,
                available=base&av,label_unknown=base&issue&~known,available_label_unknown=base&av&~known,
                scored=base&av&known,not_in_common=base&~inc,issued_outside_J=base&issue&~inj,
                scored_outside_J=base&av&known&~inj)
            scopes[name]={k:summary(a['sid'],a['ts'],v) for k,v in masks.items()}
        ledger[str(h)]=scopes
    saved={k:v for k,v in archives[24].items()}
    saved['on_J']=np.asarray([k in jkeys for k in keys[24]],bool)
    diagnostic={name:summary(sid,ts,mask) for name,mask in
        dict(common=np.ones(len(ts),bool),available=available,complete=complete,J=J,L=L,J_unknown=J&~complete).items()}
    return saved,dict(J_n=len(jkeys),L24_n=int(np.sum(saved['on_J']&saved['label_valid'])),L5_n=int(L.sum()),
                      original_joint_ledger=diagnostic,per_horizon=ledger)


@dataclass
class VerifiedSeries:
    sid:int
    key:str
    saved:dict
    predictions:dict
    quarters:list
    persistence:list
    joint_ledger:dict
    status:str
    check:dict


def check_one(science,A6,M2,D,ser,sid,key,prepared_receipt_pin,evaluation_receipt_pin,*,status='DRAFT',checkpoint=lambda:None):
    flags=admission_flags(status)
    receipt=read(evaluation_receipt_pin,65536)
    C.require(set(receipt)=={'schema','scope','sid','key','prepared_receipt','summary','quarters','complete',*flags} and
              receipt['schema']=='q26-full277-fixed-c-series-receipt-v1' and receipt['scope']==SCOPE and
              type(receipt['sid']) is int and receipt['sid']==sid and receipt['key']==key and
              receipt['prepared_receipt']==prepared_receipt_pin and receipt['complete'] is True,'evaluation receipt identity')
    for k,v in flags.items():C.exact(receipt[k],v,'series evaluation flags/'+k)
    root=Path(evaluation_receipt_pin['path']).parent
    C.require(root.name=='sid-'+str(sid) and Path(evaluation_receipt_pin['path']).name=='receipt.json','evaluation SID root')
    C.require(receipt['summary']['path']==str(root/'summary.json') and len(receipt['quarters'])<=16 and
              len(receipt['quarters'])%2==0,'bounded quarter inventory')
    bounded(receipt['summary'],256*1024)
    names=[]
    for pin in receipt['quarters']:
        bounded(pin,65536)
        C.require(Path(pin['path']).parent==root/'quarters','private quarter root');names.append(Path(pin['path']).name)
    C.require(len(names)==len(set(names)) and {p.name for p in root.iterdir()}=={'quarters','summary.json','receipt.json'} and
              {p.name for p in (root/'quarters').iterdir()}==set(names),'exact per-SID evaluation inventory')
    prepared,archives,metadata=P.authenticated_series(prepared_receipt_pin,sid=sid,key=key)
    saved,ledger=derive_joint(science,archives);del archives
    expected=[q for q in metadata[24]['quarters'] if science.runner.EVAL0<=q['quarter_cutoff']<science.runner.END]
    expected_names=[f'sid-{sid}-q-{q["quarter_cutoff"]}.private'+suffix for q in expected for suffix in ('.npz','.json')]
    C.require(names==expected_names,'all evaluation quarters in source order')
    count=[0]
    def compare(s,qa,state,support):
        checkpoint();i=count[0];C.require(i<len(expected) and s==sid and qa==expected[i]['quarter_cutoff'],'reconstructed quarter identity')
        npin,jpin=receipt['quarters'][2*i:2*i+2]
        actual=C.read_archive(npin['path']);C.exact_arrays(actual,state)
        claim=read(jpin,65536)
        truth=dict(sid=s,quarter_cutoff=qa,rows=len(state['ts']),forecasts_only_on_original_J=True,
                   file=Path(npin['path']).name,size=npin['size'],sha256=npin['sha256'],support=support)
        C.exact(claim,truth,'reconstructed scientific quarter receipt');count[0]+=1
        return dict(persisted_and_read_back=True,rows=len(state['ts']))
    if expected:
        C.require(ser is not None,'raw series required for evaluation-quarter replay')
        predictions,records=science.runner.trial_series(science.reference_runner,science.core,science.census_source,
            science.mixture,science.inverse,A6,M2,D,science.producer,ser,sid,metadata[24],saved,
            science.runner.CUT,compare,checkpoint)
        state='CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE'
    else:
        C.require(not saved['on_J'].any(),'no evaluation quarters cannot have J')
        predictions=dict(sid=np.empty(0,np.int32),ts=np.empty(0,np.int64),**{a:np.empty((0,5),np.float64) for a in ARMS})
        records=[];state='NO_EVALUATION_QUARTERS_ZERO_J'
    C.require(count[0]==len(expected),'complete reconstructed quarter coverage')
    truth=dict(schema='q26-full277-fixed-c-series-summary-v1',sid=sid,key=key,prepared_receipt=prepared_receipt_pin,
               status=state,source_rows=len(saved['sid']),joint_ledger=ledger,quarter_records=records)
    C.exact(read(receipt['summary'],256*1024),truth,'independent series summary')
    C.checked(prepared_receipt_pin);C.checked(evaluation_receipt_pin)
    for pin in [receipt['summary'],*receipt['quarters']]:C.checked(pin)
    result=dict(schema='q26-full277-fixed-c-series-check-v1',sid=sid,key=key,complete=True,
                prepared_receipt=prepared_receipt_pin,evaluation_receipt=evaluation_receipt_pin,
                no_refit=True,**flags)
    return VerifiedSeries(sid,key,saved,predictions,records,receipt['quarters'],ledger,state,result)


def concatenate(series):
    saved={k:np.concatenate([v.saved[k] for v in series]) for k in FIELDS}
    expected=[(int(s),int(t)) for s,t in zip(saved['sid'][saved['on_J']],saved['ts'][saved['on_J']])]
    C.require(len(expected)==len(set(expected)),'unique complete report J')
    output={}
    for arm in ARMS:
        keyed={}
        for v in series:
            for i,k in enumerate(zip(v.predictions['sid'],v.predictions['ts'])):
                key=(int(k[0]),int(k[1]));C.require(key not in keyed,'duplicate saved prediction key')
                keyed[key]=v.predictions[arm][i]
        C.require(set(keyed)==set(expected),'all and only independent report J keys')
        output[arm]=np.asarray([keyed[k] for k in expected],np.float64).reshape(-1,5)
    C.exact_arrays({'baseline':output['A_raw_fH']},{'baseline':saved['p_fH'][saved['on_J']]})
    return saved,output


def reference_report(science,series,cuts,mapping):
    """Independent mask/report orchestration; original proper-score primitives."""
    C.require(len(mapping)==len(series)==277 and mapping==[[i,k] for i,(_,k) in enumerate(mapping)] and
              [(v.sid,v.key) for v in series]==[(s,k) for s,k in mapping],'canonical complete277 sequence')
    C.require(cuts['downside_imbalance_D']['cut']==science.runner.CUT,'unchanged frozen reporting cuts')
    saved,pred=concatenate(series);J=saved['on_J'];known=saved['label_valid'][J];y=saved['y'][J].astype(float)
    masks=science.reporter.views(saved,cuts,[s for s,k in mapping]);C.require(len(masks)==307,'dynamic307 views')
    rows=[]
    for kind,name,mask in masks:
        at=mask[J];observed=at&known
        arms={a:science.reporter.metric(pred[a][observed],y[observed]) for a in ARMS}
        if kind=='calendar':
            for a in ARMS:arms[a]['calibration_bins']=science.reporter.calibration(pred[a][observed],y[observed])
        paired={left+'_minus_'+right:science.reporter.paired(pred[left][at],pred[right][at],y[at],known[at]) for left,right in science.runner.PAIRS}
        rows.append(dict(view_type=kind,view=name,issued_n=int(mask.sum()),forecast_J_n=int(at.sum()),scored_L24_n=int(observed.sum()),
            J_unknown_label_n=int(np.sum(at&~known)),issued_outside_J_n=int(mask.sum())-int(at.sum()),
            source_baseline_unavailable_n=int(np.sum(mask&~saved['p_fH_valid'])),
            source_available_unknown_label_n=int(np.sum(mask&saved['p_fH_valid']&~saved['label_valid'])),
            source_fallback_n=int(np.sum(mask&saved['p_fH_valid']&saved['fH_fallback'])),arms=arms,paired=paired))
    calendar={r['view']:r for r in rows if r['view_type']=='calendar'}
    passed=all(calendar[year]['arms']['C_conditional'][loss][2] is not None and
               calendar[year]['arms']['C_conditional'][loss][2]<calendar[year]['arms']['A_raw_fH'][loss][2]
               for year in ('2024','2025') for loss in ('brier','bounded_logloss'))
    return dict(schema='q26-full277-fixed-C-report-v1',label='CODEX CONTINUATION',calculations_complete=True,
        primary='H24/-10%; observed both proper losses both years',primary_candidate_passed=passed,
        original24_regression_status='NOT_ESTABLISHED_BY_THIS_COMPONENT',empirical_admission_status='NOT_ADMITTED',source_synthetic_component=True,
        J_n=int(J.sum()),L24_n=int(known.sum()),L5_n=sum(v.joint_ledger['L5_n'] for v in series),views=rows,
        series_ledger=[dict(sid=v.sid,source_rows=len(v.saved['sid']),evaluation_quarters=len(v.quarters),status=v.status,**v.joint_ledger) for v in series],
        quarter_records=[q for v in series for q in v.quarters],unseen_validation=False,
        bounds='Original binary endpoint bounds over all J. Not confidence intervals, MAR or imputed-zero scores.',
        qualification='Source/synthetic seams only. Full277 metadata/raw/runtime admission, original24 regression and independent checking remain required.')


def original24_control(science,series,selected24,old_result_pin,old_canonical_pin,cuts):
    old=read(old_result_pin,8*1024*1024)
    C.require(old['schema']=='q26-original24-control-result-v1' and old['complete'] is True and
              old_canonical_pin in old['outputs'] and Path(old_canonical_pin['path']).name=='canonical-native-report.json','frozen original24 authority')
    for pin in old['outputs']:C.checked(pin)
    originals={Path(p['path']).name:p for p in old['outputs'] if '.private.' in Path(p['path']).name}
    subset=[v for v in series if v.sid in dict(selected24)]
    C.require(len(subset)==24,'original24 subset complete')
    fresh={Path(p['path']).name:p for v in subset for p in v.persistence}
    C.require(len(originals)==len(fresh)==382 and set(originals)==set(fresh),'original191 private pair coverage')
    for name,pin in originals.items():
        other=fresh[name]
        if name.endswith('.npz'):C.exact_arrays(C.read_archive(other['path']),C.read_archive(pin['path']))
        else:
            a,b=read(pin,65536),read(other,65536)
            for d,table in ((a,originals),(b,fresh)):
                npin=table[d['file']]
                C.require(d['size']==npin['size'] and d['sha256']==npin['sha256'],'old24 own ZIP receipt binding')
            C.exact({k:v for k,v in b.items() if k not in ('size','sha256')},
                    {k:v for k,v in a.items() if k not in ('size','sha256')},'original24 private science')
    saved,pred=concatenate(subset)
    native=science.runner.build_report(science.reporter,saved,saved['on_J'],cuts,[s for s,k in selected24],pred,[q for v in subset for q in v.quarters])
    C.exact(native,read(old_canonical_pin,16*1024*1024),'original24 canonical native54 control')
    return native


def check_manifest(science,manifest_pin,mapping,selected24,series,cuts,old_result_pin,old_canonical_pin,*,status='DRAFT',checkpoint=lambda:None):
    flags=admission_flags(status);manifest=read(manifest_pin,8*1024*1024);root=Path(manifest_pin['path']).parent
    fields={'schema','scope','label','complete','canonical_mapping','series_receipts','reports','original24_control',*flags}
    C.require(set(manifest)==fields and manifest['schema']=='q26-full277-fixed-c-manifest-v1' and manifest['scope']==SCOPE and
              manifest['label']=='CODEX CONTINUATION' and manifest['complete'] is True,'global evaluation manifest schema')
    C.exact(manifest['canonical_mapping'],mapping,'manifest complete universe')
    for k,v in flags.items():C.exact(manifest[k],v,'manifest admission/'+k)
    C.require(len(series)==len(manifest['series_receipts'])==277 and [v.sid for v in series]==list(range(277)),'complete verified277')
    for sid,(v,pin) in enumerate(zip(series,manifest['series_receipts'])):
        C.require(v.check['evaluation_receipt']==pin and v.key==mapping[sid][1] and
                  Path(pin['path'])==root/('sid-'+str(sid))/'receipt.json','manifest per-series numerical binding')
        C.require(v.check.get('schema')=='q26-full277-fixed-c-series-check-v1' and
                  v.check.get('sid')==sid and v.check.get('key')==v.key and v.check.get('complete') is True and
                  v.check.get('no_refit') is True,'complete independent series check')
        for k,value in flags.items():C.exact(v.check[k],value,'per-series admission/'+k)
        C.checked(pin)
    reports=manifest['reports'];C.require(set(reports)=={'component','original24_canonical_native'},'two exact global reports')
    C.require(reports['component']['path']==str(root/'report.json') and
              reports['original24_canonical_native']['path']==str(root/'original24-canonical-native-report.json'),'global report paths')
    wrapper=read(reports['component'],64*1024*1024);native_claim=read(reports['original24_canonical_native'],16*1024*1024)
    C.require(set(wrapper)=={'schema','scope','label','complete','component','original24_control',*flags} and
              wrapper['schema']=='q26-full277-fixed-c-report-v1' and wrapper['scope']==SCOPE and
              wrapper['label']=='CODEX CONTINUATION' and wrapper['complete'] is True,'actual report wrapper')
    for k,v in flags.items():C.exact(wrapper[k],v,'report admission/'+k)
    checkpoint();reference=reference_report(science,series,cuts,mapping)
    C.exact(wrapper['component'],reference,'independent307 numerical report')
    native=original24_control(science,series,selected24,old_result_pin,old_canonical_pin,cuts)
    C.exact(native_claim,native,'persisted original24 native54')
    verdict=dict(private_pairs='EXACT',canonical_native54='EXACT')
    C.exact(wrapper['original24_control'],verdict,'verified report old24 control')
    C.exact(manifest['original24_control'],verdict,'verified manifest old24 control')
    C.require({p.name for p in root.iterdir()}=={'manifest.json','report.json','original24-canonical-native-report.json',
              *('sid-'+str(s) for s in range(277))},'exact complete global evaluation root')
    for v in series:
        C.checked(v.check['evaluation_receipt']);C.checked(v.check['prepared_receipt'])
        receipt=read(v.check['evaluation_receipt'],65536)
        for k,value in flags.items():C.exact(receipt[k],value,'final receipt admission/'+k)
        for pin in [receipt['summary'],*receipt['quarters']]:C.checked(pin)
    for pin in reports.values():C.checked(pin)
    C.checked(manifest_pin)
    return dict(schema='q26-full277-fixed-c-independent-check-v1',scope=SCOPE,complete=True,series=277,views=307,
        original24_control=verdict,no_refit=True,observed_primary_pass=reference['primary_candidate_passed'],
        J_n=reference['J_n'],L24_n=reference['L24_n'],L5_n=reference['L5_n'],**flags)
