"""Pure selected-row diagnostic; no input loading, authentication or execution authority.
Caller must establish original joint mask/catalogue and provide BOTH primary cells.
Original arithmetic: r164_ranges.py:56-60,80-98,177-203. Chronological
bins/training are explicit amendments. Available-support scores are descriptive.
"""
import numpy as np

ARMS=('F','Rclock','Roriginal')
CELLS=((24,5),(72,7))
ORIGIN=17532


def need(ok,message):
    if not ok: raise ValueError(message)


def wquant(x,w,q):
    o=np.argsort(x); x,w=x[o],w[o]
    return np.interp(q,np.cumsum(w)/w.sum(),x)


def _ratios(p,y,sg,block,bins,train):
    keys,gid=np.unique(np.column_stack((bins[train],sg[train],block[train])),axis=0,return_inverse=True)
    n=np.bincount(gid,minlength=len(keys))
    sy=np.bincount(gid,weights=y[train],minlength=len(keys))
    sp=np.bincount(gid,weights=p[train],minlength=len(keys))
    rho=np.full(len(keys),np.nan); pos=sp>0
    rho[pos]=sy[pos]/np.maximum(sp[pos],1e-12)
    valid=pos
    need(np.isfinite(rho[valid]).all(),'nonfinite ratio on predeclared support')
    return rho[valid],n[valid].astype(float)


def _metric(p,y,sg,block,bins,lo,hi,scope,declared=None):
    # All native denominators retained; only method-available rows are scored.
    partitioned=scope&(bins>=0)
    eligible=partitioned if declared is None else partitioned&declared
    available=eligible&np.isfinite(lo)&np.isfinite(hi)
    result=dict(native_rows=int(scope.sum()),partitioned_rows=int(partitioned.sum()),
                eligible_rows=int(eligible.sum()),evaluated_rows=int(available.sum()),
                available_rows=int(available.sum()),unavailable_rows=int((scope&~available).sum()),
                groups=0,coverage=None,row_median_width_pp=None,interval_score_pp=None,
                below=0,above=0)
    if not available.any():return result
    keys,gid=np.unique(np.column_stack((bins[available],sg[available],block[available])),axis=0,return_inverse=True)
    n=np.bincount(gid,minlength=len(keys))
    freq=np.bincount(gid,weights=y[available],minlength=len(keys))/n
    lower=np.bincount(gid,weights=lo[available],minlength=len(keys))/n
    upper=np.bincount(gid,weights=hi[available],minlength=len(keys))/n
    covered=(freq>=lower-1e-12)&(freq<=upper+1e-12)
    score=upper-lower+2/(1-.9)*(np.maximum(lower-freq,0)+np.maximum(freq-upper,0))
    result.update(groups=len(keys),coverage=float(covered.mean()),
                  row_median_width_pp=float(np.median(hi[available]-lo[available])*100),
                  interval_score_pp=float(score.mean()*100),below=int((freq<lower-1e-12).sum()),
                  above=int((freq>upper+1e-12).sum()))
    return result


def cell(p,y,sg,day,*,horizon,level_index):
    """Inputs are one authenticated selected altcoin cell in original row order.
    Returns private arrays/fold receipts and aggregate available-support readout.
    No endpoint support intersection changes the native target. Explicit paired
    comparable-support summaries use p/group-count-declared eligibility only.
    """
    need(type(horizon) is int and type(level_index) is int and (horizon,level_index) in CELLS,'original primary cell required')
    p,y,sg,day=map(np.asarray,(p,y,sg,day))
    need(all(a.ndim==1 for a in (p,y,sg,day)) and len(p)>0 and all(len(a)==len(p) for a in (y,sg,day)),'aligned nonempty vectors')
    need(p.dtype.kind=='f' and y.dtype.kind in 'fiu' and sg.dtype.kind in 'iu' and day.dtype.kind in 'iu','numeric dtype schema')
    need(np.isfinite(p).all() and ((p>=0)&(p<=1)).all() and np.isin(y,(0,1)).all(),'probabilities/outcomes')
    need(np.isin(sg,range(5)).all() and ((day>=0)&(day<=10**8)).all(),'SG/day domain')
    p=p.astype(float,copy=True); y=y.astype(float,copy=True); sg=sg.astype(np.int64,copy=True); day=day.astype(np.int64,copy=True)
    n=len(p); block=(day-ORIGIN)//182; lp=np.log(np.clip(p,1e-5,1-1e-5)); h=horizon//24
    global_edges=np.unique(np.quantile(lp,np.linspace(0,1,6)[1:-1]))
    global_bins=np.searchsorted(global_edges,lp)
    bins=np.full(n,-1,np.int64); target=np.zeros(n,bool)
    bounds={a:(np.full(n,np.nan),np.full(n,np.nan)) for a in ARMS}
    eligible={a:np.zeros(n,bool) for a in ARMS}; folds=[]
    for g,b in np.unique(np.column_stack((sg,block)),axis=0):
        hold=(sg==g)&(block==b); start=ORIGIN+182*int(b)
        past=(sg!=g)&(day+h<start)
        purge=(day<start)&(day+h>=start)
        retrospective=(sg!=g)&(block!=b)
        f=dict(sg=int(g),block=int(b),native_rows=int(hold.sum()),past_rows=int(past.sum()),
               max_past_label_day=int((day[past]+h).max()) if past.any() else None,
               block_start_day=start,edges=None,clock_target=bool(past.any()),arms={})
        if past.any():
            edges=np.unique(np.quantile(lp[past],np.linspace(0,1,6)[1:-1])); fb=np.searchsorted(edges,lp)
            bins[hold]=fb[hold]; target[hold]=True; f['edges']=edges.tolist()
        else:fb=None
        for a,tr,ab in (('F',past,fb),('Rclock',retrospective&~purge,fb),('Roriginal',retrospective,global_bins)):
            meta=dict(training_rows=int(tr.sum()),positive_groups=0,available=False,reason=None,quantiles=None)
            if ab is None:meta['reason']='no_eligible_past_for_edges'
            else:
                ratios,weights=_ratios(p,y,sg,block,ab,tr); meta['positive_groups']=len(ratios)
                if len(ratios)<10:meta['reason']='fewer_than10_positive_groups'
                else:
                    eligible[a][hold]=True  # predeclared from p/group counts, never endpoint success
                    q=wquant(ratios,weights,[(1-.9)/2,1-(1-.9)/2])
                    lower,upper=np.clip(p[hold]*q[0],0,1),np.clip(p[hold]*q[1],0,1)
                    need(np.isfinite(lower).all() and np.isfinite(upper).all() and (lower<=upper).all(),'invalid calibrated endpoints')
                    bounds[a][0][hold]=lower; bounds[a][1][hold]=upper
                    meta.update(available=True,quantiles=q.tolist())
            f['arms'][a]=meta
        folds.append(f)
    scopes=[('all',np.ones(n,bool))]+[(f'SG{int(g)}',sg==g) for g in range(5)]+[(f'block{int(b)}',block==b) for b in np.unique(block)]
    scopes += [(f'SG{int(g)}/block{int(b)}',(sg==g)&(block==b))
               for g,b in np.unique(np.column_stack((sg,block)),axis=0)]
    views=[]
    for name,mask in scopes:
        arms={a:_metric(p,y,sg,block,bins,*bounds[a],mask,eligible[a]) for a in ARMS}
        pairs={}
        for ref in ('Rclock','Roriginal'):
            comparable=mask&target&eligible['F']&eligible[ref]
            fm=_metric(p,y,sg,block,bins,*bounds['F'],comparable); rm=_metric(p,y,sg,block,bins,*bounds[ref],comparable)
            pairs[ref]=dict(native_rows=int(mask.sum()),prespecified_clock_rows=int((mask&target).sum()),
                comparable_rows=int(comparable.sum()),excluded_clock_rows=int((mask&target&~comparable).sum()),
                support_label='predeclared positive-p group support; no endpoint-success intersection',
                full_clock_target=bool((mask&target).any() and not (mask&target&~comparable).any()),
                completeness='FULL_CLOCK_TARGET' if (mask&target).any() and not (mask&target&~comparable).any() else 'PARTIAL_OR_EMPTY_CLOCK_TARGET',F=fm,reference=rm,
                interval_score_delta_pp=None if fm['interval_score_pp'] is None else fm['interval_score_pp']-rm['interval_score_pp'],
                coverage_delta=None if fm['coverage'] is None else fm['coverage']-rm['coverage'],
                row_median_width_delta_pp=None if fm['row_median_width_pp'] is None else fm['row_median_width_pp']-rm['row_median_width_pp'])
        views.append(dict(view=name,arms=arms,pairs=pairs))
    return dict(schema='q26-weighted-causal-primary-cell-v1',cell=[horizon,level_index,'alts'],
        native_rows=n,original_native_below500=bool(n<500),
        support_policy='All native rows retained; arm-specific and predeclared complete-fold paired summaries may be partial; no acceptance.',clock_target_rows=int(target.sum()),warmup_rows=int((~target).sum()),
        original_reference_native=_metric(p,y,sg,block,global_bins,*bounds['Roriginal'],np.ones(n,bool),eligible['Roriginal']),
        full_clock_target_available={a:bool(target.any() and np.isfinite(bounds[a][0][target]).all()) for a in ARMS},
        views=views,folds=folds,private_arrays=dict(p=p,y=y,sg=sg,day=day,block=block,past_bins=bins,
        original_bins=global_bins,clock_target=target,arm_eligible=eligible,bounds=bounds),
        interpretation='Descriptive historical diagnostic; no power, promotion, causal leakage or original primary acceptance.')


def primary_pair(cells):
    """Mapping {(24,5):{p,y,sg,day}, (72,7):...}; no cell selection."""
    need(type(cells) is dict and set(cells)==set(CELLS),'both fixed primary cells required')
    return [cell(**cells[key],horizon=key[0],level_index=key[1]) for key in CELLS]
