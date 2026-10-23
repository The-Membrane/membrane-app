"""Source-qualified H24 pure-HAR/EWMA comparison. No loader, fitting or CLI."""
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
import numpy as np
DRAFT='DRAFT'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_RETAINED_VOL_BENCHMARK'

def gate(status):
    if status not in (READY,ADMITTED): raise ValueError('DRAFT: not admitted')

@contextmanager
def no_fit(A6):
    def forbidden(*args,**kwargs): raise RuntimeError('regression forbidden')
    with patch.object(np.linalg,'solve',forbidden),patch.object(np.linalg,'lstsq',forbidden),patch.object(A6.Prep6,'har_coef',forbidden):
        yield

def typed(a,dtype,name):
    a=np.asarray(a)
    if a.dtype!=np.dtype(dtype) or a.ndim!=1: raise ValueError('dtype/shape '+name)
    return a

def reconstruct(A6,ser,prepared_ts,prepared_cutoff,prepared_fallback,quarter_records,j_ts,*,status=DRAFT):
    """Caller authenticates sources/raw/preparation and five-H J before this seam.
    Prepared ts/cutoff include the complete H24 shard, not merely J. All raw
    features and scales are float64; retained coefficients are never estimated.
    """
    gate(status)
    pt=typed(prepared_ts,'int64','prepared_ts'); pc=typed(prepared_cutoff,'int64','cutoff')
    fb=typed(prepared_fallback,'bool','fallback'); jt=typed(j_ts,'int64','J')
    if len(pt)!=len(pc) or len(pt)!=len(fb) or np.any(np.diff(pt)<=0) or np.any(np.diff(jt)<=0): raise ValueError('inventory/order')
    if np.any((pt-int(ser.base_ts))%3600) or np.any((jt-int(ser.base_ts))%3600): raise ValueError('off-hour')
    ix=(pt-int(ser.base_ts))//3600
    if np.any(ix<0) or np.any(ix>=len(ser.sigma)): raise ValueError('origin range')
    loc=np.searchsorted(pt,jt)
    if np.any(loc>=len(pt)) or not np.array_equal(pt[loc],jt): raise ValueError('J not exact H24 subset')
    rec={}
    for q in quarter_records:
        c=q['quarter_cutoff']
        if type(c)is not int or c in rec: raise ValueError('duplicate/invalid quarter')
        dt=datetime.fromtimestamp(c,timezone.utc)
        if (dt.month not in (1,4,7,10) or dt.day!=1 or dt.hour or dt.minute or dt.second): raise ValueError('quarter clock')
        if (c-int(ser.base_ts))%3600: raise ValueError('quarter off grid')
        if type(q['n_reg'])is not int or q['n_reg']<0: raise ValueError('regression count')
        if (q['coef'] is None)!=(q['n_reg']<4): raise ValueError('coefficient availability')
        for key in ('har_label_end_max','library_label_end_max','fallback_library_label_end_max'):
            if q[key] is not None and (type(q[key])is not int or q[key]>c): raise ValueError('future retained label')
        at=pc==c
        if type(q['n_rows'])is not int or q['n_rows']!=int(at.sum()) or not at.any(): raise ValueError('quarter row count')
        for t in pt[at]:
            d=datetime.fromtimestamp(int(t),timezone.utc)
            qc=datetime(d.year,3*((d.month-1)//3)+1,1,tzinfo=timezone.utc).timestamp()
            if qc!=c: raise ValueError('not own quarter')
        rec[c]=q
    if set(map(int,np.unique(pc)))!=set(rec): raise ValueError('quarter coverage')
    with no_fit(A6):
        components=np.asarray(A6.har_components(ser.high,ser.low,ser.start_i))
        if components.dtype!=np.float64 or components.shape!=(len(ser.close)+1,3): raise ValueError('raw feature schema')
        with np.errstate(divide='ignore',invalid='ignore'): logs=np.log(components)
        X=np.column_stack((np.ones(len(logs)),logs)); ok=np.all(np.isfinite(logs),axis=1)
        har=np.full(len(pt),np.nan)
        for c,q in rec.items():
            coef=None if q['coef'] is None else np.asarray(q['coef'],dtype=np.float64)
            if coef is not None and (coef.shape!=(4,) or not np.all(np.isfinite(coef))): raise ValueError('coefficient schema')
            at=pc==c
            # Exact original sigma_H implementation, no Prep6 constructor or solver.
            h=A6.Prep6.sigma_H(None,coef,X=X,okX=ok)
            har[at]=h[ix[at]]
        target=np.asarray(A6.sigma_fut(ser.close,24,ser.start_i),dtype=np.float64)[ix]
    close=np.asarray(ser.close,dtype=np.float64); n=len(close)
    r=np.full(n,np.nan)
    with np.errstate(divide='ignore',invalid='ignore'): r[1:]=np.log(close[1:]/close[:-1])
    cnt=np.r_[0,np.cumsum(np.isfinite(r))]
    strict=np.zeros(len(pt),bool); fit=(ix>=1)&(ix+24<=n)
    strict[fit]=(cnt[ix[fit]+24]-cnt[ix[fit]])==24
    ewma=np.asarray(ser.sigma)
    if ewma.dtype!=np.float64 or ewma.ndim!=1: raise ValueError('EWMA fullprecision schema')
    return dict(ts=jt.copy(),har=har[loc],ewma=ewma[ix[loc]].copy(),target=target[loc],strict_future=strict[loc],operational_fallback=fb[loc].copy())

def score(ts,har,ewma,target,strict_future,operational_fallback,*,status=DRAFT):
    gate(status)
    ts=typed(ts,'int64','ts'); h=typed(har,'float64','HAR'); e=typed(ewma,'float64','EWMA'); y=typed(target,'float64','target')
    st=typed(strict_future,'bool','strict'); fb=typed(operational_fallback,'bool','fallback')
    if any(len(a)!=len(ts) for a in (h,e,y,st,fb)) or np.any(np.diff(ts)<=0): raise ValueError('row inventory')
    hp=np.isfinite(h)&(h>0); ep=np.isfinite(e)&(e>0); yp=np.isfinite(y)&(y>0)
    years=np.array([datetime.fromtimestamp(int(t),timezone.utc).year for t in ts])
    views={}
    for name,period in [('pooled_2024_2025',np.isin(years,[2024,2025])),('2024',years==2024),('2025',years==2025)]:
        paired=period&hp&ep&yp
        def loss(mask):
            if not mask.any(): return {'n':0,'HAR':None,'EWMA':None,'HAR_minus_EWMA':None}
            a=(np.log(h[mask])-np.log(y[mask]))**2; b=(np.log(e[mask])-np.log(y[mask]))**2
            return {'n':int(mask.sum()),'HAR':float(a.mean()),'EWMA':float(b.mean()),'HAR_minus_EWMA':float((a-b).mean())}
        views[name]={'J':int(period.sum()),'HAR_unavailable':int((period&~hp).sum()),'EWMA_unavailable':int((period&~ep).sum()),'target_unavailable':int((period&~yp).sum()),'operational_fallback':int((period&fb).sum()),'paired_positive_scales':int((period&hp&ep).sum()),'target_excluded_with_paired_scales':int((period&hp&ep&~yp).sum()),'incomplete_future_with_valid_pair_target':int((paired&~st).sum()),'original_target_paired':loss(paired),'complete_future_paired':loss(paired&st)}
    return {'schema':'q26-retained-vol-benchmark-v1','H':24,'loss':'squared_log_annual_sigma','difference':'HAR_minus_EWMA','all_J':len(ts),'out_of_period_J':int((~np.isin(years,[2024,2025])).sum()),'views':views,'pure_HAR_not_operational_fH':True,'target_selection_outcome_dependent':True,'unavailable_counts_overlap':True,'unseen_validation':False,'promotion':'NOT_ADMITTED'}
