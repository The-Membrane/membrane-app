"""Saved-array score algebra only: no loading, calibration, fitting or resampling.
O140 equal-group interval score = width + lower-miss + upper-miss penalties.
The row-median width is a DISTINCT diagnostic. Source arithmetic: original
r164_ranges.py:80-98; qualified weighted-causal kernel _metric/scopes.
"""
import math

ARMS=('F','Rclock','Roriginal')
CELLS=((24,5),(72,7))
PARTS=('width_component_pp','lower_miss_component_pp','upper_miss_component_pp')


def need(ok,message):
    if not ok:raise ValueError(message)


def tolerance(np,*values):
    # Fixed numerical verification allowance for separately reduced components,
    # not a statistical interval or a proved worst-case floating error bound.
    return float(64*np.finfo(np.float64).eps*max(1.,*(abs(float(v)) for v in values)))


def close(np,a,b,message):
    need(type(a) in (float,int) and type(b) in (float,int) and math.isfinite(a) and math.isfinite(b),message+' finite')
    need(abs(a-b)<=tolerance(np,a,b),message)


def components(np,y,sg,block,bins,lower,upper,scope,declared=None):
    args=(y,sg,block,bins,lower,upper,scope)
    need(all(isinstance(a,np.ndarray) and a.ndim==1 for a in args),'one-dimensional ndarray schema')
    n=len(y);need(all(len(a)==n for a in args),'aligned vectors')
    need(y.dtype==lower.dtype==upper.dtype==np.dtype('float64'),'float64 score arrays')
    need(all(a.dtype.kind in 'iu' for a in (sg,block,bins)) and scope.dtype==np.dtype(bool),'group/mask dtypes')
    need(np.isin(y,(0.,1.)).all() and np.isin(sg,range(5)).all() and (bins>=-1).all(),'outcome/group domains')
    if declared is None:declared=np.ones(n,bool)
    need(isinstance(declared,np.ndarray) and declared.shape==(n,) and declared.dtype==np.dtype(bool),'declared bool support')
    partitioned=scope&(bins>=0);eligible=partitioned&declared
    # Do not manufacture a finite endpoint intersection: declared rows must all
    # have valid bounds, and unavailable rows remain separately accounted for.
    need(np.isfinite(lower[eligible]).all() and np.isfinite(upper[eligible]).all(),'missing declared endpoints')
    need(((0<=lower[eligible])&(lower[eligible]<=upper[eligible])&(upper[eligible]<=1)).all(),'endpoint domain/order')
    r=dict(native_rows=int(scope.sum()),partitioned_rows=int(partitioned.sum()),eligible_rows=int(eligible.sum()),
        evaluated_rows=int(eligible.sum()),available_rows=int(eligible.sum()),unavailable_rows=int((scope&~eligible).sum()),
        groups=0,coverage=None,below=0,above=0,row_median_width_pp=None,
        width_component_pp=None,lower_miss_component_pp=None,upper_miss_component_pp=None,
        component_sum_pp=None,original_interval_score_pp=None,rounding_tolerance_pp=None)
    if not eligible.any():return r
    _,gid=np.unique(np.column_stack((bins[eligible],sg[eligible],block[eligible])),axis=0,return_inverse=True)
    count=np.bincount(gid);freq=np.bincount(gid,weights=y[eligible])/count
    lo=np.bincount(gid,weights=lower[eligible])/count;hi=np.bincount(gid,weights=upper[eligible])/count
    width=hi-lo;lm=np.maximum(lo-freq,0);um=np.maximum(freq-hi,0)
    coefficient=2/(1-.9)  # mathematical20, original binary64 expression retained
    w=float(width.mean()*100);l=float(coefficient*lm.mean()*100);u=float(coefficient*um.mean()*100)
    total=math.fsum((w,l,u));original=float((width+2/(1-.9)*(lm+um)).mean()*100)
    allowance=tolerance(np,original,math.fsum((abs(w),abs(l),abs(u))));need(abs(total-original)<=allowance,'component reduction identity')
    r.update(groups=len(count),coverage=float(((freq>=lo-1e-12)&(freq<=hi+1e-12)).mean()),
        below=int((freq<lo-1e-12).sum()),above=int((freq>hi+1e-12).sum()),
        row_median_width_pp=float(np.median(upper[eligible]-lower[eligible])*100),
        width_component_pp=w,lower_miss_component_pp=l,upper_miss_component_pp=u,
        component_sum_pp=total,original_interval_score_pp=original,rounding_tolerance_pp=allowance)
    return r


def check_metric(np,r,accepted):
    for k in ('native_rows','partitioned_rows','eligible_rows','evaluated_rows','available_rows','unavailable_rows','groups','below','above','coverage','row_median_width_pp'):
        need(k in accepted and r[k]==accepted[k],'accepted metric drift: '+k)
    if r['groups']==0:need(accepted['interval_score_pp'] is None and r['original_interval_score_pp'] is None,'empty score must be None')
    else:
        need(r['original_interval_score_pp']==accepted['interval_score_pp'],'unchanged original interval-score drift')
        close(np,r['component_sum_pp'],accepted['interval_score_pp'],'accepted interval-score reconstruction')


def _arrays(np,a):
    base={'p','y','sg','day','block','past_bins','original_bins','clock_target','series','cluster','row_index'}
    fields=base|{arm+tail for arm in ARMS for tail in ('_lower','_upper','_eligible')}
    need(type(a) is dict and set(a)==fields,'exact saved array schema')
    n=len(a['y']);need(n>0 and all(isinstance(v,np.ndarray) and v.shape==(n,) for v in a.values()),'saved array shapes')
    for k in ('p','y',*(arm+t for arm in ARMS for t in ('_lower','_upper'))):need(a[k].dtype==np.dtype('float64'),'saved float64 '+k)
    for k in ('sg','day','block','past_bins','original_bins','row_index'):need(a[k].dtype==np.dtype('int64'),'saved int64 '+k)
    for k in ('series','cluster'):need(a[k].dtype==np.dtype('int16'),'saved int16 '+k)
    for k in ('clock_target',*(arm+'_eligible' for arm in ARMS)):need(a[k].dtype==np.dtype(bool),'saved bool '+k)
    need(np.isfinite(a['p']).all() and ((a['p']>=0)&(a['p']<=1)).all(),'saved p domain')
    need(np.array_equal(a['block'],(a['day']-17532)//182),'raw calendar blocks')
    need(np.array_equal(a['past_bins']>=0,a['clock_target']) and (a['original_bins']>=0).all(),'partition/clock alignment')
    for g,b in np.unique(np.column_stack((a['sg'],a['block'])),axis=0):
        m=(a['sg']==g)&(a['block']==b)
        for k in ('clock_target',*(arm+'_eligible' for arm in ARMS)):
            need(np.unique(a[k][m]).size==1,'partial-fold declared support')
    for arm in ARMS:
        e=a[arm+'_eligible'];lo=a[arm+'_lower'];hi=a[arm+'_upper']
        need(np.isfinite(lo[e]).all() and np.isfinite(hi[e]).all() and np.isnan(lo[~e]).all() and np.isnan(hi[~e]).all(),'saved availability/bounds')
        if arm!='Roriginal':need(not (e&~a['clock_target']).any(),'eligible without past bins')
    return n


def decompose_cell(np,a,accepted,*,expected_views=99):
    n=_arrays(np,a);need(accepted['schema']=='q26-weighted-causal-primary-cell-v1' and accepted['cell'][:2] in [list(k) for k in CELLS],'accepted fixed cell')
    need(accepted['native_rows']==n and accepted['clock_target_rows']==int(a['clock_target'].sum()),'accepted native/target rows')
    sg,block,bins=a['sg'],a['block'],a['past_bins'];allrows=np.ones(n,bool)
    scopes=[('all',allrows)]+[(f'SG{int(g)}',sg==g) for g in range(5)]+[(f'block{int(b)}',block==b) for b in np.unique(block)]
    scopes += [(f'SG{int(g)}/block{int(b)}',(sg==g)&(block==b)) for g,b in np.unique(np.column_stack((sg,block)),axis=0)]
    need(len(scopes)==expected_views and [v['view'] for v in accepted['views']]==[k for k,_ in scopes],'fixed view order/count')
    def metric(arm,scope,declared=None,partition=bins):
        return components(np,a['y'],sg,block,partition,a[arm+'_lower'],a[arm+'_upper'],scope,
                          a[arm+'_eligible'] if declared is None else declared)
    views=[]
    for (name,scope),old in zip(scopes,accepted['views']):
        arms={arm:metric(arm,scope) for arm in ARMS}
        for arm in ARMS:check_metric(np,arms[arm],old['arms'][arm])
        pairs={}
        for ref in ('Rclock','Roriginal'):
            selected=scope&a['clock_target']&a['F_eligible']&a[ref+'_eligible']
            prev=old['pairs'][ref]
            need(prev['native_rows']==int(scope.sum()) and prev['prespecified_clock_rows']==int((scope&a['clock_target']).sum()) and prev['comparable_rows']==int(selected.sum()) and prev['excluded_clock_rows']==int((scope&a['clock_target']&~selected).sum()),'accepted paired support drift')
            fm=metric('F',selected);rm=metric(ref,selected)
            check_metric(np,fm,prev['F']);check_metric(np,rm,prev['reference'])
            delta={k:None if fm[k] is None else fm[k]-rm[k] for k in PARTS}
            total=None if fm['groups']==0 else math.fsum(delta.values())
            if total is None:need(prev['interval_score_delta_pp'] is None,'empty paired delta')
            else:
                allowance=tolerance(np,fm['original_interval_score_pp'],rm['original_interval_score_pp'],math.fsum(abs(v) for v in delta.values()))
                need(abs(total-prev['interval_score_delta_pp'])<=allowance,'paired component delta identity')
            pairs[ref]=dict(comparable_rows=int(selected.sum()),prespecified_clock_rows=int((scope&a['clock_target']).sum()),
                F=fm,reference=rm,component_deltas_pp=delta,component_delta_sum_pp=total,
                accepted_interval_score_delta_pp=prev['interval_score_delta_pp'],
                rounding_tolerance_pp=None if total is None else allowance)
        views.append(dict(view=name,arms=arms,pairs=pairs))
    native=metric('Roriginal',allrows,partition=a['original_bins']);check_metric(np,native,accepted['original_reference_native'])
    return dict(cell=accepted['cell'],views=views,original_reference_native=native,
                interpretation='Fixed saved-support algebra; equal-group width/lower/upper score terms, no new forecasts or causal attribution.')


def analyze(np,payloads,accepted_public):
    need(type(payloads) is dict and set(payloads)==set(CELLS),'both saved primary cells')
    need(accepted_public['schema']=='q26-weighted-causal-primary-pair-summary-v1' and [c['cell'][:2] for c in accepted_public['cells']]==[list(k) for k in CELLS],'accepted pair order')
    return dict(schema='q26-range-score-components-v1',cells=[decompose_cell(np,payloads[key],old) for key,old in zip(CELLS,accepted_public['cells'])],
                new_fits=0,new_forecasts=0,bootstrap_draws=0)
