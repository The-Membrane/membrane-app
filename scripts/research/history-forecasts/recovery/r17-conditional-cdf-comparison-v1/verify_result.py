#!/usr/bin/env python3
"""Independent output oracle. Imports no subject/admission helper. No model refit trial."""
import argparse,hashlib,json,math,os,resource,shutil,signal,sys,time
from pathlib import Path
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[key]='1'
import numpy as np
H=(6,12,24,72,168);B=np.array([-.4,-.2,-.1,-.05,-.02]);T0=1640995200;T1=1704067200;T2=1735689600;T3=1767225600
ARMS=('raw_fH','A_pooled_Z','B_pooled_W','C_state_Z','hash_B','hash_C');PAIRS={'C_minus_B':(3,2),'C_minus_A':(3,1),'hash_C_minus_hash_B':(5,4),'A_minus_raw_fH':(1,0),'B_minus_raw_fH':(2,0),'C_minus_raw_fH':(3,0)}
EXPECTED_RESULT_SHA='d55a37fe60f5aa7d31d25a631fd664acabb80ce6803cc577e29dbc18fc6d7cb7'
MEMBERS=('sid','ts','quarter_cutoff','issue_eligible','p_fH_valid','fH_fallback','Xbase','Xshape','future_log_min','label_valid','y','p_fH','future_missing_hours','legacy_label_valid')

def pin(path):
 p=Path(path);digest=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):digest.update(chunk)
 return dict(path=str(p),size=p.stat().st_size,sha256=digest.hexdigest())
def check(p):
 if pin(p['path'])!=p:raise ValueError('pin mismatch '+p['path'])
def compare(actual,expected,path='value'):
 if isinstance(expected,dict):
  for k,v in expected.items():
   if k not in actual:raise AssertionError(path+': missing '+k)
   compare(actual[k],v,path+'.'+k)
 elif isinstance(expected,(list,tuple,np.ndarray)):
  if len(actual)!=len(expected):raise AssertionError(path+': length')
  for i,(a,b) in enumerate(zip(actual,expected)):compare(a,b,path+f'[{i}]')
 elif expected is None or isinstance(expected,(float,np.floating)) and not np.isfinite(expected):
  if actual is not None:raise AssertionError(path+': expected null')
 elif isinstance(expected,(str,bool,int,np.integer)):
  if actual!=expected:raise AssertionError(path+': exact mismatch')
 elif not np.isclose(actual,expected,rtol=2e-13,atol=2e-12):raise AssertionError(path+': numerical mismatch')

def direct_cdf(library,queries):
 # Literal boolean counts, no sorting/searchsorted or subject helper.
 if len(library)==0:return np.full(queries.shape,np.nan)
 return np.count_nonzero(np.asarray(library)[:,None,None]<=queries[None,:,:],axis=0)/len(library)
def classify(values,cut):
 out=np.full(len(values),-1,np.int8);finite=np.isfinite(values);out[finite]=(values[finite]>cut).astype(np.int8);return out

def historical_median(x):
 # Independent order-statistic construction of the registered linear0.5 quantile.
 x=np.abs(np.asarray(x,float));n=len(x)
 if not n:return np.nan
 mid=n//2
 if n%2:return float(np.partition(x,mid)[mid])
 central=np.partition(x,[mid-1,mid]);low,high=central[mid-1],central[mid]
 return float(high-(high-low)*.5)

def oracle_fold(z,group,query,current,raw):
 med=np.array([historical_median(z[group==g]) for g in (0,1)])
 common=direct_cdf(z,query);bridge=~np.isfinite(query).all(1)|~np.isfinite(common).all(1);common[bridge]=raw[bridge]
 normalized=common.copy();conditional=common.copy();reason='none';w=None
 if np.any(~np.isfinite(med)|(med<=0)):reason='missing_state_or_invalid_median'
 else:
  with np.errstate(all='ignore'):w=z/med[group]
  if not np.isfinite(w).all():reason='nonfinite_W';w=None
 fallback=np.ones(len(current),bool) if w is None else (current<0)|bridge;ties=np.zeros(5,np.int64)
 if w is not None:
  for g in (0,1):
   ix=np.flatnonzero((current==g)&~bridge)
   with np.errstate(all='ignore'):q=query[ix]/med[g]
   good=np.isfinite(q).all(1);fallback[ix[~good]]=True;ix=ix[good];q=q[good]
   normalized[ix]=direct_cdf(w,q);conditional[ix]=direct_cdf(z[group==g],query[ix]);ties+=np.sum(w[:,None,None]==q[None,:,:],axis=(0,1))
 pred=np.array([common,normalized,conditional]);rawok=np.isfinite(raw).all(1)&((raw>=0)&(raw<=1)).all(1);pred[:,~rawok]=np.nan
 meta=dict(median=med.tolist(),conditional_fallback_reason=reason,bridge_raw_fallback_n=int(bridge.sum()),unknown_state_n=int((current<0).sum()),B_transformed_query_ties=ties.tolist(),state_n=[int((group==g).sum()) for g in (0,1)],state_unique_Z=[int(len(set(z[group==g]))) for g in (0,1)],B_C_equal_A_fallback_n=int(fallback.sum()),conditional_query_invalid_n=int(np.sum(fallback&(current>=0)&~bridge)) if w is not None else 0,W_distinct_Z_collapses=[int(len(set(z[group==g]))-len(set(w[group==g]))) if w is not None else None for g in (0,1)])
 return pred,meta,bridge,fallback

def predict(d,h,cut,watch):
 n=len(d['ts'])
 if np.any(d['issue_eligible']&(d['quarter_cutoff']>d['ts'])):raise AssertionError('future feature quarter')
 logscale=np.array([d['Xbase'][i,1 if d['fH_fallback'][i] else 0] for i in range(n)],dtype=float)
 with np.errstate(all='ignore'):scale=np.exp(logscale)*math.sqrt(h/8760);z=d['future_log_min']/scale
 good=np.isfinite(scale)&(scale>0);state=classify(d['Xshape'][:,3],cut);hashed=np.array([hashlib.sha256(('Q26-R17-COND-NEGATIVE-v1:'+str(int(a))+':'+str(int(t))).encode()).digest()[0]%2 for a,t in zip(d['sid'],d['ts'])],np.int8)
 p=np.full((6,n,5),np.nan);p[0]=d['p_fH'];nf=np.zeros(n,bool);folds=[]
 quarter=np.array([int(np.datetime64(f'{y}-{m:02d}-01','s').astype('int64')) for y in (2024,2025) for m in (1,4,7,10)]+[T3])
 eligible=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&good&np.isfinite(z)&(state>=0)&(d['quarter_cutoff']<=d['ts'])
 for sid in np.unique(d['sid']):
  for qa,qb in zip(quarter[:-1],quarter[1:]):
   watch();same=d['sid']==sid;te=np.flatnonzero(same&d['issue_eligible']&(d['ts']>=qa)&(d['ts']<qb))
   if not len(te):continue
   if np.any(d['quarter_cutoff'][te]!=qa):raise AssertionError('own quarter changed')
   past=same&d['issue_eligible']&(d['ts']>=T0)&(d['ts']+h*3600<=qa);tr=np.flatnonzero(past&eligible)
   with np.errstate(all='ignore'):query=np.log1p(B)[None,:]/scale[te,None]
   query[~good[te]]=np.nan
   main,mi,bridge,fallback=oracle_fold(z[tr],state[tr],query,state[te],p[0,te]);negative,ni,_,_=oracle_fold(z[tr],hashed[tr],query,hashed[te],p[0,te]);p[1:4,te]=main;p[4:6,te]=negative[1:3];nf[te]=~(bridge|fallback)&d['p_fH_valid'][te]
   ends=d['ts'][tr]+h*3600
   info=dict(sid=int(sid),quarter_start=int(qa),quarter_end=int(qb),issued_n=len(te),mature_issued_n=int(past.sum()),training_exclusions_overlapping=dict(raw_fH_unavailable=int(np.sum(past&~d['p_fH_valid'])),incomplete_label=int(np.sum(past&~d['label_valid'])),invalid_scale=int(np.sum(past&~good)),nonfinite_Z=int(np.sum(past&d['label_valid']&good&~np.isfinite(z))),unknown_D_state=int(np.sum(past&(state<0))),future_feature_quarter=int(np.sum(past&(d['quarter_cutoff']>d['ts'])))),library_unique_Z=len(set(z[tr])),state_historical_events=[d['y'][tr][state[tr]==g].sum(0).astype(int).tolist() for g in (0,1)],library_n=len(tr),library_dates=len(set(d['ts'][tr])),library_blocks=len(set(d['ts'][tr]//86400//28)),library_label_end_max=int(max(ends)) if len(tr) else None,library_label_end_min=int(min(ends)) if len(tr) else None,library_membership_sha256=hashlib.sha256(np.column_stack((d['sid'][tr],d['ts'][tr])).astype('<i8').tobytes()).hexdigest(),historical_events=d['y'][tr].sum(0).astype(int).tolist(),main=mi,negative_control=ni)
   folds.append(info)
 return p,folds,nf

def scores(y,p):
 y=y.astype(float);n=len(y);pc=np.clip(p,1e-6,1-1e-6);total=p.sum(0)
 def mean(a):return a.mean(0).tolist() if n else [None]*5
 return dict(n=n,events=y.sum(0).astype(int).tolist(),mean_probability=mean(p),observed_frequency=mean(y),brier=mean(np.square(p-y)),bounded_logloss=mean(-(y*np.log(pc)+(1-y)*np.log1p(-pc))),logloss_clipped=np.count_nonzero(pc!=p,axis=0).tolist(),observed_over_expected=np.divide(y.sum(0),total,out=np.full(5,np.nan),where=total>0).tolist())
def bounds(y,valid,p,q):
 # Difference is affine in unknown binary y; independently form both endpoints.
 n=len(y);d0=np.square(p)-np.square(q);d1=np.square(p-1)-np.square(q-1);known=np.square(p-y.astype(float))-np.square(q-y.astype(float))
 return dict(n=n,unknown_n=int((~valid).sum()),lower=np.where(valid[:,None],known,np.minimum(d0,d1)).mean(0).tolist() if n else [None]*5,upper=np.where(valid[:,None],known,np.maximum(d0,d1)).mean(0).tolist() if n else [None]*5)
def views(d,cuts,sids):
 ev=d['issue_eligible']&(d['ts']>=T1)&(d['ts']<T3);cal=[('pooled',np.ones(len(ev),bool)),('2024',d['ts']<T2),('2025',d['ts']>=T2)]
 out=[('calendar',name,ev&mask) for name,mask in cal]+[('asset',str(s),ev&(d['sid']==s)) for s in sids]
 effective=np.where(d['fH_fallback'],d['Xbase'][:,1],d['Xbase'][:,0]).astype(float)
 for name,x in [('issued_log_sigma',effective),('downside_imbalance_D',d['Xshape'][:,3]),('jump_share_D',d['Xshape'][:,0])]:
  group=classify(x,cuts[name]['cut'])
  for state,g in [('unknown',-1),('low',0),('high',1)]:
   for year,mask in cal:out.append((name,state+'/'+year,ev&(group==g)&mask))
 return out

def row(d,p,kind,name,view):
 available=view&d['p_fH_valid'];take=available&d['label_valid'];y=d['y'][take];pair={};bd={}
 for name2,(a,b) in PAIRS.items():
  pair[name2]=(np.square(p[a,take]-y.astype(float))-np.square(p[b,take]-y.astype(float))).mean(0).tolist() if take.any() else [None]*5;bd[name2]=bounds(d['y'][available],d['label_valid'][available],p[a,available],p[b,available])
 return dict(view_type=kind,view=name,issued_n=int(view.sum()),baseline_unavailable_n=int(np.sum(view&~d['p_fH_valid'])),scored_n=int(take.sum()),unknown_label_n=int(np.sum(available&~d['label_valid'])),unknown_state_issued_n=int(np.sum(view&~np.isfinite(d['Xshape'][:,3]))),future_missing_hours=int(d['future_missing_hours'][view].sum()),legacy_label_n=int(np.sum(view&d['legacy_label_valid'])),arms={name2:scores(y,p[j,take]) for j,name2 in enumerate(ARMS)},paired_brier_difference=pair,all_available_paired_bounds=bd)

def block_plan():
 days=np.arange(T1,T3,86400);key=lambda t:np.where(t<T2,2024,2025)*1000000+(t//86400//28);keys=np.unique(key(days));w=np.zeros((500,len(keys)),np.int64)
 for seed,year in zip(np.random.SeedSequence(2026106000).spawn(2),(2024,2025)):
  ix=np.flatnonzero(keys//1000000==year);w[:,ix]=np.random.default_rng(seed).multinomial(len(ix),np.repeat(1/len(ix),len(ix)),size=500)
 return keys,w,key

def sensitivity(values,den):
 defined=np.isfinite(values);v=values[defined]
 return dict(defined_replicates=[int(defined.sum())],undefined_replicates=[int((~defined).sum())],sd=[float(np.std(v,ddof=1)) if len(v)>1 else None],quantiles05_95=[np.quantile(v,[.05,.95]).tolist() if len(v) else [None,None]],weighted_denominators=den.tolist())
def primary(d,p,actual,omissions,sids,watch):
 keys,w,key=block_plan();compare(actual['weight_sha256'],hashlib.sha256(w.tobytes()).hexdigest());base=d['issue_eligible']&d['p_fH_valid']&d['label_valid'];targets=[];loo=[]
 for year,ym in [('pooled',(d['ts']>=T1)&(d['ts']<T3)),('2024',(d['ts']>=T1)&(d['ts']<T2)),('2025',(d['ts']>=T2)&(d['ts']<T3))]:
  ix=np.flatnonzero(base&ym);bi=np.searchsorted(keys,key(d['ts'][ix]));y=d['y'][ix,2].astype(float)
  for name in ('C_minus_B','C_minus_A'):
   a,b=PAIRS[name];loss=(p[a,ix,2]-y)**2-(p[b,ix,2]-y)**2;v=[];den=[]
   for j in range(500):
    if j%20==0:watch()
    # Literal repeated observation rows: no subject block-sum shortcut.
    repeated=np.repeat(np.arange(len(ix)),w[j,bi]);den.append(len(repeated));v.append(float(loss[repeated].mean()) if len(repeated) else np.nan)
   targets.append(dict(year=year,contrast=name,n=len(ix),point=float(loss.mean()) if len(ix) else None,sensitivity=sensitivity(np.array(v),np.array(den))))
  for sid in sids:
   use=ix[d['sid'][ix]!=sid];yf=d['y'][use,2].astype(float);values={}
   for name in ('C_minus_B','C_minus_A','hash_C_minus_hash_B'):
    a,b=PAIRS[name];values[name]=float(((p[a,use,2]-yf)**2-(p[b,use,2]-yf)**2).mean()) if len(use) else None
   loo.append(dict(year=year,omitted_sid=sid,n=len(use),contrasts=values))
 compare(actual['targets'],targets,'primary');compare(omissions,loo,'omissions');return len(targets),len(loo)

def authentication(request):
 for k in ('source_pin','tests_pin','design_pin','base_request_pin','cuts_pin'):check(request[k])
 if request['status']!='PARENT_FROZEN_COMPARISON':raise ValueError('unadmitted comparison request')
 base=json.loads(Path(request['base_request_pin']['path']).read_text())
 for item in base['operational_amendment']['failed_v1_evidence']:check(item)
 frozen=dict(base['parent_frozen_cuts_pin']);frozen['path']=str((Path(base['execution_source_pin']['path']).parent/frozen['path']).resolve());compare(request['cuts_pin'],frozen,'frozen_cut_identity')
 for p in list(base['pins'].values())+list(base['inputs'].values())+base['closure_pins']+[base['execution_source_pin'],base['execution_tests_pin']]:check(p)
 admission=json.loads(Path(base['pins']['admission']['path']).read_text());manifest=json.loads(Path(base['pins']['manifest']['path']).read_text());monitor=json.loads(Path(base['pins']['monitor']['path']).read_text());launch=json.loads(Path(base['pins']['build_launch']['path']).read_text());stage=json.loads(Path(base['pins']['staging_request']['path']).read_text());cuts=json.loads(Path(request['cuts_pin']['path']).read_text())
 compare(admission['accepted'],True);compare(admission['manifest'],base['pins']['manifest']);compare(admission['monitor'],base['pins']['monitor']);compare(monitor['request'],base['pins']['build_launch']);compare(monitor['complete'],True);compare(monitor['exit_code'],0);compare(monitor['changed_pin_paths'],[])
 if base['pins']['manifest'] not in monitor['result_pins'] or base['pins']['staging_request'] not in launch['pins']:raise ValueError('launch closure')
 argv=launch['argv'];compare(argv[argv.index('--request')+1],base['pins']['staging_request']['path']);compare(argv[argv.index('--sha256')+1],base['pins']['staging_request']['sha256']);compare(stage['selected'],manifest['canonical_mapping']);compare(sorted(admission['input_pins'],key=lambda p:p['path']),sorted(base['inputs'].values(),key=lambda p:p['path']));compare(cuts['input_pins'],base['inputs']);compare(cuts['request_pins'],base['pins']);compare(cuts['complete'],True)
 reference_audit=json.loads(Path(base['pins']['reference_audit']['path']).read_text());compare(reference_audit['accepted'],True);compare(reference_audit['result'],base['pins']['reference_result']);compare(reference_audit['monitor'],base['pins']['reference_monitor'])
 return base,cuts

def verify(request,result,watch):
 base,cuts=authentication(request);compare(result['complete'],True);compare(result['source_pin'],request['source_pin']);compare(result['base_request_pin'],request['base_request_pin']);compare(result['cuts_pin'],request['cuts_pin']);reference=json.loads(Path(base['pins']['reference_result']['path']).read_text());counts=dict(point_views=0,folds=0,nonfallback_views=0,reference_cells=0,primary_sensitivities=0,omissions=0,cross_horizon_records=0);saved={}
 for h in H:
  watch()
  with np.load(base['inputs'][str(h)]['path'],allow_pickle=False) as archive:d={k:archive[k] for k in MEMBERS}
  if not np.array_equal(d['y'][d['label_valid']],(d['future_log_min'][d['label_valid'],None]<=np.log1p(B)).astype(np.uint8)):raise AssertionError('labels')
  hc=cuts['horizons'][str(h)];p,folds,nf=predict(d,h,hc['downside_imbalance_D']['cut'],watch);record=result['horizons'][str(h)];compare(record['folds'],folds,'folds');counts['folds']+=len(folds)
  expectedrows=[row(d,p,*v) for v in views(d,hc,base['sids'])];compare(record['point_views'],expectedrows,'points');counts['point_views']+=len(expectedrows)
  for expected in expectedrows:
   if expected['view_type'] not in ('calendar','asset'):continue
   kind='all' if expected['view']=='pooled' else 'year' if expected['view_type']=='calendar' else 'asset';group='all' if kind=='all' else expected['view'];source=next(x for x in reference['horizons'] if x['horizon_hours']==h)['scores'];metrics=expected['arms']['raw_fH']
   for j,b in enumerate(B):
    ref=[x for x in source if x['prediction']=='baseline_raw' and (x['group_type'],x['group'],x['barrier'])==(kind,group,float(b))]
    if len(ref)!=1:raise AssertionError('reference cell identity')
    compare(metrics['n'],ref[0]['n']);compare(metrics['events'][j],ref[0]['events']);compare(metrics['brier'][j],ref[0]['brier']);compare(metrics['bounded_logloss'][j],ref[0]['bounded_logloss']);compare(metrics['mean_probability'][j],ref[0]['sum_probability']/ref[0]['n'] if ref[0]['n'] else None);counts['reference_cells']+=1
  nofallback=[]
  for name,ym in [('pooled',(d['ts']>=T1)&(d['ts']<T3)),('2024',(d['ts']>=T1)&(d['ts']<T2)),('2025',(d['ts']>=T2)&(d['ts']<T3))]:
   avail=nf&d['issue_eligible']&d['p_fH_valid']&ym;take=avail&d['label_valid'];y=d['y'][take].astype(float)
   nofallback.append(dict(view=name,issued_no_fallback_n=int(avail.sum()),scored_n=int(take.sum()),unknown_label_n=int(np.sum(avail&~d['label_valid'])),arms={ARMS[j]:scores(y,p[j,take]) for j in (1,2,3)},paired_brier_difference={name2:((p[a,take]-y)**2-(p[b,take]-y)**2).mean(0).tolist() if take.any() else [None]*5 for name2,(a,b) in PAIRS.items() if name2 in ('C_minus_B','C_minus_A')},all_available_paired_bounds={name2:bounds(d['y'][avail],d['label_valid'][avail],p[a,avail],p[b,avail]) for name2,(a,b) in PAIRS.items() if name2 in ('C_minus_B','C_minus_A')}))
  compare(record['main_nonfallback_point_sensitivity'],nofallback);counts['nonfallback_views']+=len(nofallback)
  if h==24:counts['primary_sensitivities'],counts['omissions']=primary(d,p,result['primary_sensitivity'],result['primary_leave_one_asset_out'],base['sids'],watch)
  available=d['issue_eligible']&d['p_fH_valid']&(d['ts']>=T1)&(d['ts']<T3);saved[h]={(int(s),int(t)):p[:,i] for i,(s,t) in enumerate(zip(d['sid'],d['ts'])) if available[i]}
  del d,p;watch()
 cross=[]
 for i,h in enumerate(H):
  for k in H[i+1:]:
   common=sorted(set(saved[h])&set(saved[k]));delta=np.array([saved[h][key]-saved[k][key] for key in common])
   for arm,name in enumerate(ARMS):
    diff=delta[:,arm,:] if len(common) else np.empty((0,5));cross.append(dict(short_h=h,long_h=k,arm=name,common_origins=len(common),repeated_barrier_exposures=diff.size,violations=int((diff>1e-12).sum()),max_positive_violation=float(max(0,diff.max())) if diff.size else None))
 compare(result['cross_horizon'],cross,'cross_horizon');counts['cross_horizon_records']=len(cross);authentication(request);return counts

def selfcheck():
 for x in [np.array([.1,.3]),np.array([1.,2.,8.]),np.array([0.,1.,2.,4.])]:compare(historical_median(x),float(np.quantile(np.abs(x),.5,method='linear')))
 x=np.array([-2.,-1.,-1.,0.]);q=np.tile(np.array([-3.,-2.,-1.,0.,1.]),(2,1));compare(direct_cdf(x,q),[[0,.25,.75,1,1]]*2)
 group=np.array([0,0,1,1]);z=np.array([-1.,-2.,-2.,-4.]);q=np.tile(np.array([-.5,-1.,-2.,-3.,-4.]),(2,1));pred,meta,_,_=oracle_fold(z,group,q,np.array([0,1]),np.full((2,5),.2));assert np.isfinite(pred).all();np.testing.assert_array_equal(pred[1],pred[2]);compare(scores(np.ones((1,5),np.uint8),np.full((1,5),.5))['bounded_logloss'],[math.log(2)]*5)
 a=-np.array([1,1,1,1,2,2,2,2.]);b=-np.array([.5,.5,1,1,2,2,4,4]);p2,_,_,_=oracle_fold(np.r_[a,b],np.r_[np.zeros(8,int),np.ones(8,int)],q,np.array([0,1]),np.full((2,5),.2));compare(p2[1,:,3],[.125,.125]);compare(p2[2,:,3],[0.,.25])
 empty,_,bridge,_=oracle_fold(np.array([]),np.array([],int),q,np.array([0,1]),np.full((2,5),.2));assert bridge.all();compare(empty,np.full((3,2,5),.2))
 compare(bounds(np.zeros((1,5),np.uint8),np.array([False]),np.full((1,5),.8),np.full((1,5),.2))['lower'],[-.6]*5);print('synthetic selfcheck PASS; no actual input/result opened')
def main():
 a=argparse.ArgumentParser();a.add_argument('--self-check',action='store_true');a.add_argument('--request');a.add_argument('--request-sha256');a.add_argument('--result');a.add_argument('--result-sha256');a.add_argument('--out');args=a.parse_args()
 if args.self_check:selfcheck();return
 if not all([args.request,args.request_sha256,args.result,args.result_sha256,args.out]):raise ValueError('explicit request/result pins and fresh audit path required')
 out=Path(args.out)
 if out.exists():raise FileExistsError('fresh audit path required')
 started=time.monotonic();samples=[]
 def watch():
  elapsed=time.monotonic()-started;rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);free=shutil.disk_usage(out.parent).free;samples.append(dict(elapsed=elapsed,peak_rss_bytes=rss,free_bytes=free))
  if elapsed>120 or rss>=1000000000 or free<2147483648:raise RuntimeError('verifier resource cap')
 signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(TimeoutError('120seconds')));signal.alarm(120);report={'accepted':False,'scope':'Independent boolean-CDF/median output oracle, not a new model trial'}
 try:
  watch()
  if args.result_sha256!=EXPECTED_RESULT_SHA:raise ValueError('unexpected result identity; source review required for another result')
  if pin(args.request)['sha256']!=args.request_sha256 or pin(args.result)['sha256']!=args.result_sha256:raise ValueError('request/result hash mismatch')
  request=json.loads(Path(args.request).read_text());result=json.loads(Path(args.result).read_text());report['verified']=verify(request,result,watch);watch();report.update(accepted=True,request_pin=pin(args.request),result_pin=pin(args.result),verifier_pin=pin(__file__),numeric_tolerance={'rtol':2e-13,'atol':2e-12},bootstrap_scope='all6primary500draws literal repeated rows; no subject helper imported')
 except BaseException as e:report.update(error_class=type(e).__name__,error=str(e)[:500]);raise
 finally:
  signal.alarm(0);report.update(elapsed_seconds=time.monotonic()-started,resource_samples=samples)
  raw=json.dumps(report,indent=2,allow_nan=False)+'\n'
  if len(raw.encode())>10000000:raise RuntimeError('audit output cap')
  out.write_text(raw)
if __name__=='__main__':main()
