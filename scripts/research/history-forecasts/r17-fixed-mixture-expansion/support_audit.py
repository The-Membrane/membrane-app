"""Replay retained-library support on fixed saved cases only; never fit a model."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import types
from fractions import Fraction
import numpy as np

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FIXED_C_SUPPORT_AUDIT'
PLAN_SHA='ab2b8e8497672857d8e2b570b3629e0f82f73c0ff442b682efe2591ce139d846'
DIAG_SHA='af5e3e5d283ac38eb71e637aa66874a210687b22db7e1862ded40d3d16e1f123'

def need(ok,msg):
    if not ok:raise ValueError(msg)

def count(library,u):return int(np.searchsorted(np.sort(library),u,side='right'))

def prepared_counts(z,states):
    return {g:np.sort(np.asarray(z,np.float64)[np.asarray(states)==g]) for g in(-1,0,1)}

def support(z,states,u,current,raw,*,fallback=False,cache=None):
    """Exact original C target arithmetic; unknown historical rows never dropped."""
    z=np.asarray(z,np.float64);states=np.asarray(states,np.int8)
    need(z.ndim==1 and z.shape==states.shape and len(z)>0 and np.isfinite(z).all() and np.isfinite(u),'valid library/query')
    need(np.isin(states,[-1,0,1]).all() and current in(-1,0,1),'states')
    groups=prepared_counts(z,states) if cache is None else cache
    ns={g:len(v) for g,v in groups.items()};cs={g:int(np.searchsorted(v,u,side='right')) for g,v in groups.items()}
    n=len(z);k=sum(cs.values());need(sum(ns.values())==n and k/n==raw,'exact saved A inclusive parity')
    if not fallback:
        need(ns[0]>0 and ns[1]>0,'original strict state support')
        for g in (0,1):
            # Exact positivity of the mathematical abs median; no rounding needed.
            need(np.count_nonzero(groups[g])>=(ns[g]+1)//2,'positive original state magnitude median')
    c=raw
    if not fallback and current!=-1:
        second=Fraction(cs[-1],n)+Fraction((ns[0]+ns[1])*cs[current],n*ns[current])
        c=.5*raw+.5*float(second)
    minimum=float(np.min(z));maximum=float(np.max(z))
    return dict(N=n,minZ=minimum,maxZ=maximum,inclusive_count=k,unknown_N=ns[-1],unknown_count=cs[-1],
                state0_N=ns[0],state0_count=cs[0],state1_N=ns[1],state1_count=cs[1],
                own_N=None if current==-1 else ns[current],own_count=None if current==-1 else cs[current],
                query_minus_min=u-minimum,query_min_ratio=None if minimum==0 else u/minimum,
                query_below_min=bool(u<minimum),A=raw,C=c)

def selected(main,fallback,main_query,fallback_query,predict):
    """Original fallback depends on all FIVE probabilities, not only target."""
    ph=predict(main,np.asarray(main_query,np.float64).reshape(1,5));fb=not bool(np.isfinite(ph).all())
    pf=predict(fallback,np.asarray(fallback_query,np.float64).reshape(1,5)) if fb else None
    return fb,(pf if fb else ph)[0]

def series(science,A6,M2,D,ser,metadata,cases,archive,states_saved,*,status='DRAFT'):
    need(status in(READY,ADMITTED),'DRAFT')
    realized=D.realized(ser);feature=science.census_source.downside_feature(realized,science.producer.sanitize);del realized
    states=science.census_source.states_of(feature,science.runner.CUT);rows=[]
    index={int(t):i for i,t in enumerate(archive['ts'])};need(len(index)==len(archive['ts']),'unique saved keys')
    with science.reference_runner.no_regression(A6.Prep6):
        prep=A6.Prep6(ser,24,with_fbL=False);P=prep.P;all_i=np.arange(prep.n)
        # Independent finite-positive full-window check is descriptive ONLY.
        bad=(~np.isfinite(ser.low))|(ser.low<=0);prefix=np.r_[0,np.cumsum(bad)];full=all_i+24<=len(ser.low)
        complete=np.zeros(prep.n,bool);ix=all_i[full]
        complete[ix]=(prefix[ix+24]-prefix[ix]==0)&np.isfinite(ser.spot[ix])&(ser.spot[ix]>0)
        for record in metadata['quarters']:
            group=[c for c in cases if c['quarter_cutoff']==record['quarter_cutoff']]
            if not group:continue
            qa=record['quarter_cutoff'];qs=(qa-ser.base_ts)//3600;mature=all_i+24<=qs
            reg=np.flatnonzero(prep.okH&mature);coef=record['coef']
            need(record['n_reg']==len(reg) and (coef is None)==(len(reg)<4),'retained regression support')
            if coef is not None:need(np.asarray(coef).shape==(4,) and np.isfinite(coef).all(),'retained coefficient')
            sigma=prep.sigma_H(None if coef is None else np.asarray(coef,np.float64));z,valid=prep.z_of(sigma)
            mi=np.flatnonzero(valid&mature);fi=np.flatnonzero(P.valid[1.0]&mature)
            end=lambda ix:None if not len(ix) else int(ser.base_ts+3600*(int(ix[-1])+24))
            for key,ix in [('har_label_end_max',reg),('library_label_end_max',mi),('fallback_library_label_end_max',fi)]:
                need(record[key]==end(ix) and (end(ix)is None or end(ix)<=qa),'maturity endpoint')
            need(record['har_label_end_min']==(None if not len(reg) else int(ser.base_ts+3600*(int(reg[0])+24))),'regression minimum maturity')
            main=z[mi];fall=np.asarray(P.z[1.0])[fi];support_cache={}
            for case in group:
                ts=case['ts'];need(ts in index and (ts-ser.base_ts)%3600==0,'saved case exact grid');j=index[ts];i=(ts-ser.base_ts)//3600
                need(i>=0 and i<prep.n and np.array_equal(feature[i:i+1],archive['Xshape'][j:j+1,3],equal_nan=True),'saved feature parity')
                with np.errstate(divide='ignore',invalid='ignore',over='ignore'):
                    mq=np.log1p(science.core.BARRIERS)/(sigma[i]*P.scale);fq=np.log1p(science.core.BARRIERS)/(ser.sigma[i]*P.scale)
                fb,probs=selected(main,fall,mq,fq,M2.fhs_predict)
                need(fb==bool(archive['fH_fallback'][j]) and np.array_equal(probs,archive['p_fH'][j]),'allfive saved raw parity')
                saved=states_saved[(case['sid'],ts)];current=int(states[i]);need(current==saved['issuance_state'] and fb==saved['fallback'],'saved private state parity')
                ix=fi if fb else mi;lib=fall if fb else main;u=float((fq if fb else mq)[2]);
                if fb not in support_cache:support_cache[fb]=prepared_counts(lib,states[ix])
                v=support(lib,states[ix],u,current,float(probs[2]),fallback=fb,cache=support_cache[fb])
                need(v['A']==saved['A'] and v['C']==saved['C'],'exact saved A/C parity')
                scale=float(ser.sigma[i] if fb else sigma[i]);reason='MAIN_FINITE_ALL_FIVE'
                if fb:reason='EMPTY_MATURE_MAIN_LIBRARY' if not len(main) else 'NONFINITE_MAIN_ALL_FIVE_QUERY' if not np.isfinite(mq).all() else 'NONFINITE_MAIN_PROBABILITY'
                finite=lambda x:float(x) if np.isfinite(x) else None
                rows.append(dict(sid=case['sid'],ts=ts,kind=case['kind'],year=1970+int(np.datetime64(ts,'s').astype('datetime64[Y]').astype(int)),
                    fallback=fb,branch_reason=reason,coef_none=coef is None,issuance_state=current,u=u,
                    HARsigma=finite(sigma[i]),EWMAsigma=finite(ser.sigma[i]),HAR_EWMA_ratio=finite(sigma[i]/ser.sigma[i]),
                    selected_scale=finite(scale*P.scale),P_scale=float(P.scale),main_N=len(main),fallback_N=len(fall),
                    selected_library_end=end(ix),quarter_cutoff=qa,original_library_incomplete_positive_window=int(np.sum(~complete[ix])),
                    raw_parity=True,C_parity=True,**v))
    need(len(rows)==len(cases),'all selected cases covered');return rows

def legacy_sources(R,old):
    fit=R.read(old['pins']['legacy_scope']);pins=[]
    for relative,digest in fit['source_sha256'].items():
        matches=[p for p in old['files'] if p['path'].endswith('/'+relative) and p['sha256']==digest]
        need(len(matches)==1,'unique original legacy source');R.checked(matches[0]);pins.append(matches[0])
    return pins

def run(path,sha,*,status='DRAFT'):
    need(status==ADMITTED,'DRAFT: no input access')
    b=Path(path).read_bytes();need(len(b)<=65536 and hashlib.sha256(b).hexdigest()==sha,'external request')
    q=json.loads(b);need(q['schema']=='q26-fixed-c-support-audit-request-v1' and q['status']==ADMITTED,'admission')
    # Parent seals this new source and accepted immutable transport before exec.
    p=q['pins']['fixed_c_run'];raw=Path(p['path']).read_bytes();need(len(raw)==p['size'] and hashlib.sha256(raw).hexdigest()==p['sha256'],'accepted transport pin')
    R=types.ModuleType('_support_transport');R.__file__=p['path'];exec(compile(raw,p['path'],'exec'),vars(R))
    need(R.pin(Path(__file__).resolve())==q['pins']['source'],'current support source')
    dp=q['pins']['diagnostic_source'];need(dp['sha256']==DIAG_SHA,'frozen archive helper');DG=R.load(dp,'_support_archive_helper')
    plan=R.read(q['pins']['plan'],1024**2);need(q['pins']['plan']['sha256']==PLAN_SHA,'fixed case plan')
    diag=R.read(q['pins']['diagnostic'],1024**2);need(plan['diagnostic_inventory_pin']==q['pins']['diagnostic'],'same diagnostic')
    acceptance=R.read(q['pins']['parent_acceptance']);need(diag['private_data']['accepted_evidence']['parent_acceptance']==q['pins']['parent_acceptance'] and acceptance['public_data']['complete']is True and acceptance['public_data']['phase_closed']is True,'accepted closed C')
    request=acceptance['private_evidence']['request'];oldq=R.read(request,2*1024**2)
    prep=R.read(oldq['pins']['preparation_request'],2*1024**2);old=R.read(prep['pins']['original_control_request'],2*1024**2)
    need(oldq['runtime']==prep['runtime']==old['runtime'] and oldq['canonical_mapping']==prep['canonical_mapping'],'same accepted context')
    runtime=oldq['runtime'];need(sys.executable==runtime['invocation_path'] and sys.dont_write_bytecode and sys.flags.optimize==0 and sys.version==runtime['version'] and np.__version__==runtime['packages']['numpy'],'accepted runtime')
    need(str(Path(sys.executable).resolve())==runtime['executable']['path'] and all(os.environ.get(k)==v for k,v in runtime['environment'].items()),'accepted runtime environment')
    for pin in [runtime['executable'],*runtime['native_pins']]:R.checked(pin)
    C=R.load(prep['pins']['control_check'],'_support_old_checker');rawscope=R.read(old['pins']['raw_scope'])['base_scope']
    files={p['path']:p for p in oldq['files']};need(len(files)==len(oldq['files']),'unique sealed accepted pin metadata')
    need(acceptance['private_evidence']['manifest']==diag['private_data']['accepted_evidence']['manifest'],'same accepted manifest')
    cases=diag['private_data']['case_inventory'];need(len(cases)==377 and len({(c['sid'],c['ts']) for c in cases})==377,'all377 uniquecases')
    need([{k:c[k] for k in plan['cases'][0]} for c in cases]==plan['cases'],'exact frozen membership')
    sourcepins=legacy_sources(R,old)
    A,science,R12,A6,M2,D,specs,finder=R.P.science_context(prep,old,rawscope)
    try:
        sys.modules['control_check']=C;used=[];PC=R.load(oldq['pins']['preparation_check'],'preparation_check');results=[]
        for sid in sorted({c['sid'] for c in cases}):
            cc=[c for c in cases if c['sid']==sid];ref=diag['private_data']['source_refs'][str(sid)];key=ref['key']
            need(oldq['canonical_mapping'][sid]==[sid,key] and specs[key]['kind']=='grid' and 'slice'not in specs[key],'canonical unsliced grid')
            rawpin=files.get(specs[key]['path']);need(rawpin is not None,'selected raw pinned');R.checked(rawpin);used.append(rawpin)
            pr=R.read(ref['prepared_receipt'],65536);need(pr['outputs']['24']==ref['H24'],'H24 authority');used.extend([ref['prepared_receipt'],*pr['outputs'].values()])
            _,archives,meta=PC.authenticated_series(ref['prepared_receipt'],sid=sid,key=key);h=archives[24];private={}
            for case in cc:
                pp=case['private_quarter'];used.append(pp);z=DG.archive(pp,rows=92,cap=65536)
                j=case['private_row'];need(int(z['sid'][j])==sid and int(z['ts'][j])==case['ts'],'private keyed row')
                private[(sid,case['ts'])]=dict(A=float(z['A_raw_fH'][j,2]),C=float(z['C_conditional'][j,2]),fallback=bool(z['fH_fallback'][j]),issuance_state=int(z['issuance_state'][j]))
            ser,_,_=R12.load_series(specs[key]);results.extend(series(science,A6,M2,D,ser,meta[24],cc,h,private,status=status));del ser,archives,h;R12._CHAIN.clear()
        need(len(results)==377,'complete results')
        for p in [*used,*sourcepins,*old['science'].values(),runtime['executable'],*runtime['native_pins']]:R.checked(p)
        for p in q['pins'].values():R.checked(p)
        groups={}
        for v in results:
            key=v['kind']+':'+str(v['year']);g=groups.setdefault(key,dict(cases=0,fallback=0,below_library_min=0,incomplete_library_rows=0))
            g['cases']+=1;g['fallback']+=int(v['fallback']);g['below_library_min']+=int(v['query_below_min']);g['incomplete_library_rows']+=v['original_library_incomplete_positive_window']
        result=dict(public_data=dict(schema='q26-fixed-c-support-audit-v1',label='CODEX CONTINUATION',complete=True,cases=377,series=32,groups=groups,all_A_C_exact=True,regression_calls=0,forecast_promotion_status='NOT_ADMITTED'),private_data=dict(cases=results,request_sha256=sha))
        data=(json.dumps(result,sort_keys=True,allow_nan=False)+'\n').encode();need(len(data)<=1024**2,'output cap');out=Path(q['out']);need(out.parent==Path(path).parent and str(out.resolve())==str(out) and not out.exists(),'fresh output')
        fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        need(json.loads(out.read_bytes())==result,'output readback');return R.pin(out)
    finally:
        if finder in sys.meta_path:sys.meta_path.remove(finder)

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--admitted',action='store_true');a=p.parse_args()
    print(json.dumps(run(a.request,a.request_sha256,status=ADMITTED if a.admitted else 'DRAFT')))
