"""No-fit H24 persistence in original annualized close-return RMS units.

Original a6_touch.sigma_fut269-288 computes RMS of r[j:j+24], where
r[m]=log(close[m]/close[m-1]). Set j=i-24 for origin i: r[i-24:i]
uses last known close[i-1], never close[i] or a prior filtered J outcome.
Original null allowance, start_i and zero/invalid rules remain unchanged.
"""
import numpy as np
DRAFT='DRAFT'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_O188_PERSISTENCE_EXTENSION'

def persistence(A6,ser,ts,*,status=DRAFT):
    if status not in (READY,ADMITTED):raise ValueError('DRAFT: no input access')
    t=np.asarray(ts)
    close=np.asarray(ser.close)
    if t.dtype!=np.dtype('int64') or t.ndim!=1 or np.any(np.diff(t)<=0):raise ValueError('ordered unique int64 timestamps')
    if close.dtype!=np.dtype('float64') or close.ndim!=1:raise ValueError('original fullprecision close grid')
    if isinstance(ser.base_ts,(bool,np.bool_)) or not isinstance(ser.base_ts,(int,np.integer)):raise ValueError('integer hourly origin')
    if isinstance(ser.start_i,(bool,np.bool_)) or not isinstance(ser.start_i,(int,np.integer)) or not 0<=ser.start_i<=len(close):raise ValueError('original start index')
    offset=t-int(ser.base_ts)
    if np.any(offset%3600):raise ValueError('off-hour timestamp')
    idx=offset//3600
    if np.any(idx<0) or np.any(idx>len(close)):raise ValueError('timestamp outside original origins')
    # Full source grid is essential. Shifting a previous daily J target would
    # substitute a different window whenever that previous J row is missing.
    original=np.asarray(A6.sigma_fut(close,24,int(ser.start_i)))
    if original.dtype!=np.dtype('float64') or original.shape!=(len(close)+1,):raise ValueError('original sigma_fut schema')
    out=np.full(len(t),np.nan,np.float64);take=idx>=24
    out[take]=original[idx[take]-24]
    r=np.full(len(close),np.nan)
    with np.errstate(divide='ignore',invalid='ignore'):r[1:]=np.log(close[1:]/close[:-1])
    count=np.r_[0,np.cumsum(np.isfinite(r))]
    finite=np.zeros(len(t),np.int32)
    finite[take]=(count[idx[take]]-count[idx[take]-24]).astype(np.int32)
    strict=(idx-25>=int(ser.start_i))&(finite==24)
    return {'ts':t.copy(),'persistence':out,'strict_past':strict,'finite_past_returns':finite}

def support_masks(ts,har,ewma,persist,target,*,status=DRAFT):
    """Frozen same-row supports; no loss calculation or favorable-mask selection.

Pairwise comparison supports are distinct. Three-way common includes all three
positive finite forecasts and a positive finite observed target. Target support
is retrospective/outcome-dependent; it is not a forecast availability claim.
"""
    if status not in (READY,ADMITTED):raise ValueError('DRAFT: no input access')
    t=np.asarray(ts)
    if t.dtype!=np.dtype('int64') or t.ndim!=1 or np.any(np.diff(t)<=0):raise ValueError('single-series ordered int64 timestamps')
    data={}
    for key,value in [('HAR',har),('EWMA',ewma),('PERSISTENCE',persist),('TARGET',target)]:
        a=np.asarray(value)
        if a.dtype!=np.dtype('float64') or a.shape!=t.shape:raise ValueError('scale dtype/shape')
        data[key]=np.isfinite(a)&(a>0)
    observed=data['TARGET']
    return {'forecast_available':{k:data[k] for k in ('HAR','EWMA','PERSISTENCE')},
            'target_observed':observed,
            'paired_HAR_EWMA':data['HAR']&data['EWMA']&observed,
            'paired_HAR_PERSISTENCE':data['HAR']&data['PERSISTENCE']&observed,
            'paired_EWMA_PERSISTENCE':data['EWMA']&data['PERSISTENCE']&observed,
            'three_way_common':data['HAR']&data['EWMA']&data['PERSISTENCE']&observed}
