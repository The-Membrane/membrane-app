"""Pure O189 source qualification. No input loading, fitting or execution authority.
Only CAL training cutoff advances daily; accepted O140 block edges remain fixed.
The caller authenticates inputs and passes the exact original reference module.
"""
import numpy as np
CELLS=((24,5),(72,7)); ORIGIN=17532; TOL=5e-13

def need(x,m):
 if not x:raise ValueError(m)

def prepared_counts(p,y,sg,block,bins):
 """Full-pool lexicographic group IDs. Empty groups are removed at each cutoff."""
 keys,gid=np.unique(np.column_stack((bins,sg,block)),axis=0,return_inverse=True)
 return gid,len(keys)

def fast_ratios(p,y,gid,nkeys,train):
 """Identical row addition order and lexicographic nonempty groups to _ratios."""
 n=np.bincount(gid[train],minlength=nkeys)
 sy=np.bincount(gid[train],weights=y[train],minlength=nkeys)
 sp=np.bincount(gid[train],weights=p[train],minlength=nkeys)
 pos=(n>0)&(sp>0)
 rho=sy[pos]/np.maximum(sp[pos],1e-12)
 need(np.isfinite(rho).all(),'nonfinite ratios')
 return rho,n[pos].astype(float)

def score_components(y,sg,block,bins,lo,hi,scope):
 available=scope&(bins>=0)&np.isfinite(lo)&np.isfinite(hi)
 if not available.any():return dict(groups=0,width_pp=None,lower_penalty_pp=None,upper_penalty_pp=None,total_pp=None)
 keys,gid=np.unique(np.column_stack((bins[available],sg[available],block[available])),axis=0,return_inverse=True)
 n=np.bincount(gid,minlength=len(keys));freq=np.bincount(gid,weights=y[available],minlength=len(keys))/n
 lower=np.bincount(gid,weights=lo[available],minlength=len(keys))/n;upper=np.bincount(gid,weights=hi[available],minlength=len(keys))/n
 w=float(np.mean(upper-lower)*100);l=float(np.mean(2/(1-.9)*np.maximum(lower-freq,0))*100);u=float(np.mean(2/(1-.9)*np.maximum(freq-upper,0))*100)
 return dict(groups=len(keys),width_pp=w,lower_penalty_pp=l,upper_penalty_pp=u,total_pp=w+l+u)

def cell(reference,a,folds,*,horizon,level_index):
 need((horizon,level_index) in CELLS and type(horizon) is int and type(level_index) is int,'fixed primary cell')
 fields=('p','y','sg','day','block','past_bins','clock_target','F_lower','F_upper','F_eligible')
 need(type(a) is dict and all(k in a for k in fields),'saved fields')
 p,y,sg,day,block,bins,target,flo,fhi,fe=(np.asarray(a[k]) for k in fields)
 n=len(p);need(n>0 and all(x.ndim==1 and len(x)==n for x in (p,y,sg,day,block,bins,target,flo,fhi,fe)),'aligned nonempty vectors')
 need(p.dtype.kind=='f' and y.dtype.kind in 'fiu' and all(x.dtype.kind in 'iu' for x in (sg,day,block,bins)) and all(x.dtype.kind=='b' for x in (target,fe)) and flo.dtype.kind==fhi.dtype.kind=='f','dtype schema')
 need(np.isfinite(p).all() and ((0<=p)&(p<=1)).all() and np.isin(y,(0,1)).all() and np.isin(sg,range(5)).all(),'probability/label/SG domain')
 need(((day>=0)&(day<=10**8)).all() and np.array_equal(block,(day-ORIGIN)//182),'calendar')
 p=p.astype(float);y=y.astype(float);lp=np.log(np.clip(p,1e-5,1-1e-5));h=horizon//24
 baseline_max_abs_error=0.;daily_updates=0
 pairs={tuple(map(int,x)) for x in np.unique(np.column_stack((sg,block)),axis=0)}
 need(type(folds) is list and len(folds)==len(pairs),'complete fold inventory')
 seen=set();bcheck=np.full(n,-1,np.int64);tcheck=np.zeros(n,bool);echeck=np.zeros(n,bool)
 flcheck=np.full(n,np.nan);fhcheck=np.full(n,np.nan);dlo=np.full(n,np.nan);dhi=np.full(n,np.nan);de=np.zeros(n,bool);receipts=[]
 for f in folds:
  need(type(f) is dict and type(f.get('sg')) is int and type(f.get('block')) is int,'fold types')
  g,b=f['sg'],f['block'];need((g,b) in pairs and (g,b) not in seen,'unknown/duplicate fold');seen.add((g,b))
  hold=(sg==g)&(block==b);start=ORIGIN+182*b;past=(sg!=g)&(day+h<start)
  edges=f.get('edges');need((edges is not None)==bool(past.any()),'edge/warmup lineage')
  if edges is None:
   receipts.append(dict(sg=g,block=b,days=[],reason='original_no_past_edges'));continue
  edges=np.asarray(edges);need(edges.ndim==1 and edges.dtype.kind in 'fiu' and len(edges)<=4 and np.isfinite(edges).all() and (np.diff(edges)>0).all(),'sealed edges')
  need(np.array_equal(edges,np.unique(np.quantile(lp[past],np.linspace(0,1,6)[1:-1]))),'sealed edges original past-p lineage')
  fb=np.searchsorted(edges,lp);bcheck[hold]=fb[hold];tcheck[hold]=True
  gid,nkeys=prepared_counts(p,y,sg,block,fb)
  slow,sw=reference._ratios(p,y,sg,block,fb,past);rat,w=fast_ratios(p,y,gid,nkeys,past)
  need(np.array_equal(rat,slow) and np.array_equal(w,sw),'optimized block count parity')
  if len(rat)>=10:
   q=reference.wquant(rat,w,[(1-.9)/2,1-(1-.9)/2]);flcheck[hold]=np.clip(p[hold]*q[0],0,1);fhcheck[hold]=np.clip(p[hold]*q[1],0,1);echeck[hold]=True
  days=[]
  for d in np.unique(day[hold]):
   use=hold&(day==d);train=(sg!=g)&(day+h<d)
   rat,w=fast_ratios(p,y,gid,nkeys,train);meta=dict(day=int(d),training_rows=int(train.sum()),positive_groups=len(rat),available=False)
   if len(rat)>=10:
    q=reference.wquant(rat,w,[(1-.9)/2,1-(1-.9)/2]);lo=np.clip(p[use]*q[0],0,1);hi=np.clip(p[use]*q[1],0,1)
    need(np.isfinite(lo).all() and np.isfinite(hi).all() and (lo<=hi).all(),'daily endpoints')
    dlo[use]=lo;dhi[use]=hi;de[use]=True;meta['available']=True;daily_updates+=1
   days.append(meta)
  receipts.append(dict(sg=g,block=b,days=days,reason=None))
 need(seen==pairs and np.array_equal(bins,bcheck) and np.array_equal(target,tcheck) and np.array_equal(fe,echeck),'saved partition/support baseline parity')
 for actual,expected in ((flo,flcheck),(fhi,fhcheck)):
  if fe.any():baseline_max_abs_error=max(baseline_max_abs_error,float(np.max(np.abs(actual[fe]-expected[fe]))))
  need(np.array_equal(np.isnan(actual),np.isnan(expected)) and np.isfinite(actual[fe]).all() and np.allclose(actual,expected,rtol=0,atol=TOL,equal_nan=True),'saved F endpoint baseline parity')
 primary=target&fe;available=de&np.isfinite(dlo)&np.isfinite(dhi);missing=primary&~available
 scopes=[('all',np.ones(n,bool))]+[(f'SG{g}',sg==g) for g in range(5)]+[(f'block{b}',block==b) for b in np.unique(block)]+[(f'SG{g}/block{b}',(sg==g)&(block==b)) for g,b in sorted(pairs)]
 views=[]
 for name,scope in scopes:
  declared=scope&primary;complete=bool(declared.any() and not (declared&~available).any())
  arms={};components={}
  for namearm,lo,hi in [('F',flo,fhi),('DAILY',dlo,dhi)]:
   arms[namearm]=reference._metric(p,y,sg,block,bins,lo,hi,declared)
   m=arms[namearm];m['descriptive_box']=None if not m['groups'] else dict(coverage_within_85_95=bool(.85<=m['coverage']<=.95),median_width_le10pp=bool(m['row_median_width_pp']<=10),coverage_distance_from_90=abs(m['coverage']-.9),both=bool(.85<=m['coverage']<=.95 and m['row_median_width_pp']<=10))
   components[namearm]=score_components(y,sg,block,bins,lo,hi,declared)
  deltas=None if not complete else {k:arms['DAILY'][k]-arms['F'][k] for k in ('coverage','row_median_width_pp','below','above')}
  views.append(dict(view=name,native_rows=int(scope.sum()),clock_target_rows=int((scope&target).sum()),warmup_rows=int((scope&~target).sum()),F_ineligible_target_rows=int((scope&target&~fe).sum()),primary_deltas=deltas,primary_rows=int(declared.sum()),daily_missing_primary_rows=int((declared&~available).sum()),full_primary_comparable=complete,arms=arms,components=components,primary_delta_pp=arms['DAILY']['interval_score_pp']-arms['F']['interval_score_pp'] if complete else None))
 return dict(schema='q26-o189-daily-clock-cell-v1',cell=[horizon,level_index,'alts'],native_rows=n,clock_target_rows=int(target.sum()),warmup_rows=int((~target).sum()),F_ineligible_target_rows=int((target&~fe).sum()),primary_rows=int(primary.sum()),daily_missing_primary_rows=int(missing.sum()),primary_comparison_admissible=bool(primary.any() and not missing.any()),extra_daily_available_outside_primary=int((available&~primary).sum()),baseline_reconstructed=True,baseline_tolerance=TOL,baseline_max_abs_error=baseline_max_abs_error,DAILY_CAL_update_estimates=daily_updates,DAILY_scalar_quantile_estimates=2*daily_updates,base_forecasting_model_fits=0,views=views,folds=receipts,private_arrays=dict(DAILY_lower=dlo,DAILY_upper=dhi,DAILY_eligible=de),model_fits=0,inference=False,promotion=False)

def primary_pair(reference,cells):
 need(type(cells) is dict and set(cells)==set(CELLS),'both fixed cells required')
 return [cell(reference,**cells[c],horizon=c[0],level_index=c[1]) for c in CELLS]
