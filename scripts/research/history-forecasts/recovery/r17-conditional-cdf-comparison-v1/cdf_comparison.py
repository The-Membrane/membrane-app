#!/usr/bin/env python3
"""DRAFT own-asset nested conditional-CDF comparison; no real run before admission."""
import argparse,hashlib,importlib.util,json,os,resource,shutil,signal,sys,time
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='1'
import numpy as np
HORIZONS=(6,12,24,72,168);BARRIERS=np.array([-.4,-.2,-.1,-.05,-.02]);EPS=1e-6
START=1640995200;EVAL=1704067200;YEAR25=1735689600;END=1767225600
ARMS=('raw_fH','A_pooled_Z','B_pooled_W','C_state_Z','hash_B','hash_C')
PAIRS={'C_minus_B':(3,2),'C_minus_A':(3,1),'hash_C_minus_hash_B':(5,4),'A_minus_raw_fH':(1,0),'B_minus_raw_fH':(2,0),'C_minus_raw_fH':(3,0)}
MEMBERS=('sid','ts','quarter_cutoff','issue_eligible','p_fH_valid','fH_fallback','Xbase','Xshape','future_log_min','label_valid','y','p_fH','future_missing_hours','legacy_label_valid')

def ecdf(x,t):
 x=np.sort(np.asarray(x,dtype=float))
 if not len(x) or not np.all(np.isfinite(x)):return np.full(np.shape(t),np.nan)
 return np.searchsorted(x,t,side='right')/len(x)
def state_of(x,cut):return np.where(np.isfinite(x),np.where(x<=cut,0,1),-1)
def hash_states(sid,ts):return np.array([hashlib.sha256(f'Q26-R17-COND-NEGATIVE-v1:{int(a)}:{int(b)}'.encode('utf-8')).digest()[0]&1 for a,b in zip(sid,ts)],np.int8)
def issued_scale(d,h):
 ell=np.where(d['fH_fallback'],d['Xbase'][:,1],d['Xbase'][:,0]).astype(float)
 with np.errstate(over='ignore',under='ignore',invalid='ignore'):s=np.exp(ell)*np.sqrt(h/8760)
 return s,np.isfinite(s)&(s>0)
def standardized(depth,scale):
 with np.errstate(over='ignore',divide='ignore',invalid='ignore'):return np.asarray(depth,dtype=float)/scale

def fit_libraries(z,states):
 """Shared eligible row IDs; B transforms each row by its own state BEFORE pooling."""
 z=np.asarray(z,dtype=float);states=np.asarray(states)
 if not (np.isfinite(z)&np.isin(states,[0,1])).all():raise ValueError('invalid base library')
 with np.errstate(over='ignore',invalid='ignore',divide='ignore'):
  med=np.array([np.quantile(np.abs(z[states==g]),.5,method='linear') if np.any(states==g) else np.nan for g in [0,1]])
  if not np.all(np.isfinite(med)&(med>0)):return None,med,'missing_state_or_invalid_median'
  w=z/med[states]
 if not np.isfinite(w).all():return None,med,'nonfinite_W'
 return dict(z=z,w=w,state=states,median=med),med,'none'

def predict_fold(z,states,t,current,raw,return_masks=False):
 """Fallback independent of evaluation labels. C's canonical computation cancels M exactly in definition."""
 t=np.asarray(t,float);raw=np.asarray(raw,float);current=np.asarray(current);states=np.asarray(states);A=ecdf(z,t);valid_query=np.isfinite(t).all(1);bridge=~valid_query|~np.isfinite(A).all(1);A[bridge]=raw[bridge];B=A.copy();C=A.copy()
 lib,med,reason=fit_libraries(z,states);transformed_ties=np.zeros(t.shape[1],np.int64);conditional_fallback=np.ones(len(current),bool) if lib is None else (current<0)|bridge
 if lib is not None:
  for g in [0,1]:
   ix=(current==g)&~bridge
   with np.errstate(over='ignore',invalid='ignore',divide='ignore'):q=t[ix]/med[g]
   safe=np.isfinite(q).all(1);conditional_fallback[np.flatnonzero(ix)[~safe]]=True;indices=np.flatnonzero(ix)[safe];q=q[safe]
   B[indices]=ecdf(lib['w'],q);C[indices]=ecdf(lib['z'][lib['state']==g],t[indices])
   wsort=np.sort(lib['w']);transformed_ties+=np.sum(np.searchsorted(wsort,q,side='right')-np.searchsorted(wsort,q,side='left'),axis=0)
 # Any rowwise numerical query failure keeps both B/C at the same A fallback.
 common=np.isfinite(raw).all(1)&np.all((raw>=0)&(raw<=1),axis=1)
 out=np.stack([A,B,C]);out[:,~common]=np.nan
 meta=dict(median=med.tolist(),conditional_fallback_reason=reason,bridge_raw_fallback_n=int(bridge.sum()),unknown_state_n=int(np.sum(current<0)),B_transformed_query_ties=transformed_ties.tolist(),state_n=[int(np.sum(states==g)) for g in [0,1]],state_unique_Z=[int(len(np.unique(np.asarray(z)[states==g]))) for g in [0,1]],B_C_equal_A_fallback_n=int(conditional_fallback.sum()),conditional_query_invalid_n=int(np.sum(conditional_fallback&(current>=0)&~bridge)) if lib is not None else 0,W_distinct_Z_collapses=[int(len(np.unique(np.asarray(z)[states==g]))-len(np.unique(lib['w'][states==g]))) if lib is not None else None for g in [0,1]])
 return (out,meta,bridge,conditional_fallback) if return_masks else (out,meta)

def mature_mask(ts,h,q):return (ts>=START)&(ts+h*3600<=q)
def quarter_starts():return np.array([np.datetime64(f'{y}-{m:02d}-01T00:00:00','s').astype(np.int64) for y in [2024,2025] for m in [1,4,7,10]]+[END],np.int64)
def make_predictions(d,h,cut,checkpoint=lambda:None,return_support=False):
 n=len(d['ts']);scale,sv=issued_scale(d,h);z=standardized(d['future_log_min'],scale);state=state_of(d['Xshape'][:,3],cut);hs=hash_states(d['sid'],d['ts']);pred=np.full((6,n,5),np.nan);pred[0]=d['p_fH'];folds=[];q=quarter_starts();nonfallback=np.zeros(n,bool)
 if np.any(d['issue_eligible']&(d['quarter_cutoff']>d['ts'])):raise ValueError('future feature quarter')
 evaluation=d['issue_eligible']&(d['ts']>=EVAL)&(d['ts']<END);qi=np.searchsorted(q,d['ts'][evaluation],side='right')-1
 if not np.array_equal(d['quarter_cutoff'][evaluation],q[qi]):raise ValueError('not own evaluation quarter')
 eligible=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&sv&np.isfinite(z)&(state>=0)&(d['quarter_cutoff']<=d['ts'])
 for sid in np.unique(d['sid']):
  for qa,qb in zip(q[:-1],q[1:]):
   checkpoint();te=np.flatnonzero((d['sid']==sid)&d['issue_eligible']&(d['ts']>=qa)&(d['ts']<qb))
   if not len(te):continue
   tr=np.flatnonzero((d['sid']==sid)&eligible&mature_mask(d['ts'],h,qa))
   with np.errstate(over='ignore',divide='ignore',invalid='ignore'):t=np.log1p(BARRIERS)[None,:]/scale[te,None]
   invalid=~sv[te];t[invalid]=np.nan
   main,info,bridge,conditional=predict_fold(z[tr],state[tr],t,state[te],pred[0,te],return_masks=True);nonfallback[te]=~(bridge|conditional)&d['p_fH_valid'][te];neg,ni=predict_fold(z[tr],hs[tr],t,hs[te],pred[0,te]);pred[1:4,te]=main;pred[4:6,te]=neg[1:3]
   past=(d['sid']==sid)&d['issue_eligible']&mature_mask(d['ts'],h,qa);excluded=dict(raw_fH_unavailable=int(np.sum(past&~d['p_fH_valid'])),incomplete_label=int(np.sum(past&~d['label_valid'])),invalid_scale=int(np.sum(past&~sv)),nonfinite_Z=int(np.sum(past&d['label_valid']&sv&~np.isfinite(z))),unknown_D_state=int(np.sum(past&(state<0))),future_feature_quarter=int(np.sum(past&(d['quarter_cutoff']>d['ts']))));ends=d['ts'][tr]+h*3600
   if len(ends) and ends.max()>qa:raise ValueError('future training label')
   folds.append(dict(sid=int(sid),quarter_start=int(qa),quarter_end=int(qb),issued_n=len(te),mature_issued_n=int(past.sum()),training_exclusions_overlapping=excluded,library_unique_Z=int(len(np.unique(z[tr]))),state_historical_events=[np.sum(d['y'][tr][state[tr]==g],axis=0).astype(int).tolist() for g in [0,1]],library_n=len(tr),library_dates=int(len(np.unique(d['ts'][tr]))),library_blocks=int(len(np.unique(d['ts'][tr]//86400//28))),library_label_end_max=int(ends.max()) if len(tr) else None,library_label_end_min=int(ends.min()) if len(tr) else None,library_membership_sha256=hashlib.sha256(np.column_stack([d['sid'][tr],d['ts'][tr]]).astype('<i8').tobytes()).hexdigest(),historical_events=np.sum(d['y'][tr],axis=0).astype(int).tolist(),main=info,negative_control=ni))
 known=d['issue_eligible']&(d['ts']>=EVAL)&(d['ts']<END)&d['p_fH_valid']
 if np.any(~np.isfinite(pred[:,known])) or np.any((pred[:,known]<0)|(pred[:,known]>1)) or np.any(np.diff(pred[:,known],axis=2)<0):raise ValueError('prediction contract')
 return (pred,state,folds,nonfallback) if return_support else (pred,state,folds)

def score(y,p):
 y=np.asarray(y,dtype=float);p=np.asarray(p,dtype=float);n=len(y);pc=np.clip(p,EPS,1-EPS)
 if y.shape!=p.shape or not np.isin(y,[0,1]).all() or not np.all(np.isfinite(p)&(p>=0)&(p<=1)):raise ValueError('score support')
 mean=lambda x:x.mean(0).tolist() if n else [None]*5;ps=p.sum(0)
 return dict(n=n,events=y.sum(0).astype(int).tolist(),mean_probability=mean(p),observed_frequency=mean(y),brier=mean((p-y)**2),bounded_logloss=mean(-y*np.log(pc)-(1-y)*np.log1p(-pc)),logloss_clipped=np.sum(pc!=p,axis=0).tolist(),observed_over_expected=np.divide(y.sum(0),ps,out=np.full(5,np.nan),where=ps>0).tolist())
def pair_bounds(y,valid,p,q):
 a=p*p-q*q;b=a-2*(p-q);known=np.where(valid[:,None],a-2*y.astype(float)*(p-q),0).sum(0);n=len(y)
 return dict(n=n,unknown_n=int(np.sum(~valid)),lower=((known+np.where(valid[:,None],0,np.minimum(a,b)).sum(0))/n).tolist() if n else [None]*5,upper=((known+np.where(valid[:,None],0,np.maximum(a,b)).sum(0))/n).tolist() if n else [None]*5)
def summarize_views(d,pred,cuts,sids,helper):
 rows=[]
 for kind,name,view in helper.views(d,cuts,sids):
  avail=view&d['p_fH_valid'];take=avail&d['label_valid'];y=d['y'][take].astype(float);arms={name:score(y,pred[j,take]) for j,name in enumerate(ARMS)};pairs={};bounds={}
  for pairname,(a,b) in PAIRS.items():
   pairs[pairname]=np.mean((pred[a,take]-y)**2-(pred[b,take]-y)**2,axis=0).tolist() if take.any() else [None]*5;bounds[pairname]=pair_bounds(d['y'][avail],d['label_valid'][avail],pred[a,avail],pred[b,avail])
  rows.append(dict(view_type=kind,view=name,issued_n=int(view.sum()),baseline_unavailable_n=int(np.sum(view&~d['p_fH_valid'])),scored_n=int(take.sum()),unknown_label_n=int(np.sum(avail&~d['label_valid'])),unknown_state_issued_n=int(np.sum(view&~np.isfinite(d['Xshape'][:,3]))),future_missing_hours=int(d['future_missing_hours'][view].sum()),legacy_label_n=int(np.sum(view&d['legacy_label_valid'])),arms=arms,paired_brier_difference=pairs,all_available_paired_bounds=bounds))
 return rows

def nonfallback_views(d,pred,mask):
 out=[];base=mask&d['issue_eligible']&d['p_fH_valid']
 for name,ym in [('pooled',(d['ts']>=EVAL)&(d['ts']<END)),('2024',(d['ts']>=EVAL)&(d['ts']<YEAR25)),('2025',(d['ts']>=YEAR25)&(d['ts']<END))]:
  available=base&ym;take=available&d['label_valid'];y=d['y'][take].astype(float)
  out.append(dict(view=name,issued_no_fallback_n=int(available.sum()),scored_n=int(take.sum()),unknown_label_n=int(np.sum(available&~d['label_valid'])),arms={ARMS[j]:score(y,pred[j,take]) for j in [1,2,3]},paired_brier_difference={name:np.mean((pred[a,take]-y)**2-(pred[b,take]-y)**2,0).tolist() if take.any() else [None]*5 for name,(a,b) in PAIRS.items() if name in ['C_minus_B','C_minus_A']},all_available_paired_bounds={name:pair_bounds(d['y'][available],d['label_valid'][available],pred[a,available],pred[b,available]) for name,(a,b) in PAIRS.items() if name in ['C_minus_B','C_minus_A']}))
 return out

def reference_check(rows,h,reference):
 original=next(x for x in reference['horizons'] if x['horizon_hours']==h);lookup={(x['group_type'],x['group'],float(x['barrier'])):x for x in original['scores'] if x['prediction']=='baseline_raw'};checks=0
 for r in rows:
  if r['view_type'] not in ('calendar','asset'):continue
  kind='all' if r['view']=='pooled' else ('year' if r['view_type']=='calendar' else 'asset');group='all' if kind=='all' else r['view'];s=r['arms']['raw_fH']
  for j,b in enumerate(BARRIERS):
   x=lookup.pop((kind,group,float(b)))
   if s['n']!=x['n'] or s['events'][j]!=x['events']:raise ValueError('reference support')
   if s['n']:
    for a,z in [(s['brier'][j],x['brier']),(s['bounded_logloss'][j],x['bounded_logloss']),(s['mean_probability'][j],x['sum_probability']/x['n'])]:
     if not np.isclose(a,z,rtol=2e-13,atol=2e-12):raise ValueError('reference mean')
     checks+=1
 if lookup:raise ValueError('reference closure')
 return checks

def primary_sensitivity(d,pred,helper):
 keys,w=helper.draw_plan();out=[];evalmask=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']>=EVAL)&(d['ts']<END);y=d['y'].astype(float)
 for year,mask in [('pooled',evalmask),('2024',evalmask&(d['ts']<YEAR25)),('2025',evalmask&(d['ts']>=YEAR25))]:
  bi=np.searchsorted(keys,helper.block_keys(d['ts'][mask]));cnt=np.bincount(bi,minlength=len(keys));den=w@cnt
  for name in ['C_minus_B','C_minus_A']:
   a,b=PAIRS[name];loss=(pred[a,mask,2]-y[mask,2])**2-(pred[b,mask,2]-y[mask,2])**2;s=np.bincount(bi,weights=loss,minlength=len(keys));v=np.divide(w@s,den,out=np.full(500,np.nan),where=den>0);out.append(dict(year=year,contrast=name,n=int(mask.sum()),point=float(loss.mean()) if len(loss) else None,sensitivity=helper.sensitivity(v[:,None],den)))
 return dict(targets=out,draws=500,seed=2026106000,weight_sha256=hashlib.sha256(w.tobytes()).hexdigest(),interpretation='Fixed-prediction conditional block-resampling sensitivity; no refitting, validatedCI or pvalue.')
def leave_one_out(d,pred,sids):
 out=[];base=d['issue_eligible']&d['p_fH_valid']&d['label_valid'];y=d['y'].astype(float)
 for year,ym in [('pooled',(d['ts']>=EVAL)&(d['ts']<END)),('2024',(d['ts']>=EVAL)&(d['ts']<YEAR25)),('2025',(d['ts']>=YEAR25)&(d['ts']<END))]:
  for sid in sids:
   mask=base&ym&(d['sid']!=sid);out.append(dict(year=year,omitted_sid=sid,n=int(mask.sum()),contrasts={name:float(np.mean((pred[a,mask,2]-y[mask,2])**2-(pred[b,mask,2]-y[mask,2])**2)) if mask.any() else None for name,(a,b) in PAIRS.items() if name in ['C_minus_B','C_minus_A','hash_C_minus_hash_B']}))
 return out

def cross_horizon(retained):
 out=[]
 for i,h in enumerate(HORIZONS):
  a=retained[h]
  for k in HORIZONS[i+1:]:
   b=retained[k];ka=np.rec.fromarrays([a['sid'],a['ts']],names='sid,ts');kb=np.rec.fromarrays([b['sid'],b['ts']],names='sid,ts');_,ia,ib=np.intersect1d(ka[a['available']],kb[b['available']],return_indices=True);ix=np.flatnonzero(a['available'])[ia];iy=np.flatnonzero(b['available'])[ib]
   for j,name in enumerate(ARMS):
    delta=a['pred'][j,ix]-b['pred'][j,iy];out.append(dict(short_h=h,long_h=k,arm=name,common_origins=len(ix),repeated_barrier_exposures=delta.size,violations=int(np.sum(delta>1e-12)),max_positive_violation=float(max(0,delta.max())) if delta.size else None))
 return out

def pin(p):
 p=Path(p);h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())
def check(p):
 if pin(p['path'])!=p:raise ValueError('changed pin')
def admission(r):
 for k in ['source_pin','tests_pin','design_pin','base_request_pin','cuts_pin']:check(r[k])
 if Path(__file__).resolve()!=Path(r['source_pin']['path']).resolve():raise ValueError('execution identity')
 base=json.loads(Path(r['base_request_pin']['path']).read_text());p=base['execution_source_pin'];check(p);sp=importlib.util.spec_from_file_location('accepted_o86_admission',p['path']);helper=importlib.util.module_from_spec(sp);sp.loader.exec_module(helper);helper.authenticate(base);helper.validate_cut_pin(base,r['cuts_pin'])
 cuts=json.loads(Path(r['cuts_pin']['path']).read_text())
 if not cuts['complete'] or cuts['input_pins']!=base['inputs'] or cuts['request_pins']!=base['pins']:raise ValueError('cut closure')
 return base,cuts,helper

def clean(x):
 if isinstance(x,float) and not np.isfinite(x):return None
 if isinstance(x,dict):return {k:clean(v) for k,v in x.items()}
 if isinstance(x,list):return [clean(v) for v in x]
 return x
def write(p,x):Path(p).write_text(json.dumps(clean(x),separators=(',',':'),allow_nan=False)+'\n')
def run(r,out):
 if r['status']!='PARENT_FROZEN_COMPARISON':raise ValueError('draft not admitted')
 out=Path(out);out.mkdir(exist_ok=False);started=time.monotonic();stage='admission';obs=[];result={'complete':False,'schema':'r17-conditional-cdf-comparison-v1','horizons':{}}
 def observe(enforce=True):
  rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);free=shutil.disk_usage(out).free;elapsed=time.monotonic()-started;size=sum(p.stat().st_size for p in out.iterdir() if p.is_file());obs.append(dict(stage=stage,elapsed=elapsed,peak_rss_bytes=rss,free_bytes=free,output_bytes=size))
  if enforce and (elapsed>120 or rss>=1000000000 or free<2147483648 or size>10000000):raise RuntimeError('resource cap')
 def timeout(*_):raise TimeoutError('120seconds')
 signal.signal(signal.SIGALRM,timeout);signal.alarm(120)
 try:
  base,cuts,helper=admission(r);observe();reference=json.loads(Path(base['pins']['reference_result']['path']).read_text());audit=json.loads(Path(base['pins']['reference_audit']['path']).read_text())
  if not audit['accepted'] or audit['result']!=base['pins']['reference_result'] or audit['monitor']!=base['pins']['reference_monitor']:raise ValueError('reference admission')
  retained={}
  for h in HORIZONS:
   stage='horizon-'+str(h);observe()
   with np.load(base['inputs'][str(h)]['path'],allow_pickle=False) as z:d={k:z[k] for k in MEMBERS}
   helper.metadata(d,base['sids']);valid=d['label_valid']
   if not np.array_equal(np.isfinite(d['future_log_min']),valid) or not np.array_equal(d['y'][valid],(d['future_log_min'][valid,None]<=np.log1p(BARRIERS)).astype(np.uint8)):raise ValueError('complete label contract')
   expected=np.all(np.isfinite(d['p_fH'])&(d['p_fH']>=0)&(d['p_fH']<=1),axis=1)
   if not np.array_equal(expected,d['p_fH_valid']):raise ValueError('baseline availability')
   hc=cuts['horizons'][str(h)];pred,state,folds,nf=make_predictions(d,h,hc['downside_imbalance_D']['cut'],observe,return_support=True);rows=summarize_views(d,pred,hc,base['sids'],helper);result['horizons'][str(h)]=dict(point_views=rows,main_nonfallback_point_sensitivity=nonfallback_views(d,pred,nf),folds=folds,reference_metric_checks=reference_check(rows,h,reference))
   if h==24:result['primary_sensitivity']=primary_sensitivity(d,pred,helper);result['primary_leave_one_asset_out']=leave_one_out(d,pred,base['sids'])
   available=d['issue_eligible']&d['p_fH_valid']&(d['ts']>=EVAL)&(d['ts']<END);retained[h]=dict(sid=d['sid'],ts=d['ts'],available=available,pred=pred);del d;observe();write(out/'partial.json',result)
  stage='cross_horizon';result['cross_horizon']=cross_horizon(retained);admission(r);result.update(complete=True,source_pin=r['source_pin'],cuts_pin=r['cuts_pin'],base_request_pin=r['base_request_pin'],interpretation='Exploratory spent-development restriction comparison. No latent/cause/CI/marketwinner/blind/promotion claim. RawfH external anchor, not matched estimator library.');write(out/'result.pending.json',result);observe();os.replace(out/'result.pending.json',out/'result.json');(out/'partial.json').unlink();observe()
 except BaseException as ex:write(out/'failure.json',dict(complete=False,stage=stage,error_class=type(ex).__name__,elapsed=time.monotonic()-started));raise
 finally:
  signal.alarm(0);observe(False);write(out/'resource-receipt.json',dict(observations=obs,peak_rss_bytes=max(x['peak_rss_bytes'] for x in obs),min_free_bytes=min(x['free_bytes'] for x in obs),elapsed=time.monotonic()-started))
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--request',required=True);p.add_argument('--sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();raw=Path(a.request).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=a.sha256:raise ValueError('request pin')
 run(json.loads(raw),a.out)
if __name__=='__main__':main()
