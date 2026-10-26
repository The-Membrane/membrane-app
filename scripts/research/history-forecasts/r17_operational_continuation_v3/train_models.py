"""R17 fixed four-arm retrospective pilot. Real runs require a parent-admitted request."""
import argparse, datetime as dt, hashlib, json, multiprocessing as mp, os, subprocess, sys, time
from pathlib import Path
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
BARRIERS=np.array([-.40,-.20,-.10,-.05,-.02],dtype=np.float64)
HORIZONS=(6,12,24,72,168)
EPS=1e-6
ARMS=('linear','xgb_base','xgb_shape')
XGB=dict(objective='binary:logistic',tree_method='hist',max_depth=3,eta=.05,min_child_weight=20,reg_lambda=5,gamma=0,subsample=1,colsample_bytree=1,max_bin=128,nthread=1,seed=1701,base_score=.5)
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def quarter(t):
 d=dt.datetime.fromtimestamp(int(t),dt.timezone.utc)
 return int(dt.datetime(d.year,1+3*((d.month-1)//3),1,tzinfo=dt.timezone.utc).timestamp())
def margin(p): return np.log(np.clip(p,EPS,1-EPS))-np.log1p(-np.clip(p,EPS,1-EPS))
def pav(a):
 """Equal-weight projection onto nondecreasing threshold probabilities."""
 z=np.asarray(a,dtype=np.float64);out=np.empty_like(z)
 for i,row in enumerate(z):
  means=[];weights=[]
  for value in row:
   means.append(float(value));weights.append(1)
   while len(means)>1 and means[-2]>means[-1]:
    w=weights[-2]+weights[-1];v=(means[-2]*weights[-2]+means[-1]*weights[-1])/w
    means[-2:]=[v];weights[-2:]=[w]
  out[i]=np.repeat(means,weights)
 return out

def validate(d):
 n=len(d['ts']);required={'sid','ts','p_fH','y','label_valid','Xbase','Xshape','quarter_cutoff','issue_eligible','p_fH_valid','base_margin'}
 assert required<=set(d),required-set(d)
 for k in ['sid','ts','quarter_cutoff','label_valid','issue_eligible','p_fH_valid']: assert d[k].shape==(n,),k
 for k,w in [('p_fH',5),('y',5),('base_margin',5),('Xbase',12),('Xshape',6)]:assert d[k].shape==(n,w),k
 assert d['ts'].dtype==np.int64 and d['quarter_cutoff'].dtype==np.int64
 assert d['y'].dtype==np.uint8 and d['p_fH'].dtype==np.float64
 for k in ['label_valid','issue_eligible','p_fH_valid']:assert d[k].dtype==np.bool_,k
 for k in ['Xbase','Xshape']:assert d[k].dtype==np.float32 and not np.isinf(d[k]).any(),k
 assert len(set(zip(d['sid'].astype(str),d['ts'].tolist())))==n,'duplicate origins'
 assert np.array_equal(d['quarter_cutoff'],np.array([quarter(t) for t in d['ts']],dtype=np.int64)),'quarter provenance rewrite'
 assert (d['quarter_cutoff']<=d['ts']).all()
 valid=d['label_valid'];assert np.isin(d['y'][valid],[0,1]).all()
 assert (np.diff(d['y'][valid].astype(int),axis=1)>=0).all(),'nonmonotone labels'
 pv=d['p_fH_valid'];p=d['p_fH'][pv]
 assert np.isfinite(p).all() and ((p>=0)&(p<=1)).all()
 assert (np.diff(p,axis=1)>=0).all(),'nonmonotone raw baseline'
 assert np.allclose(d['base_margin'][pv],margin(p),rtol=0,atol=1e-12),'producer base margin mismatch'
 if 'Xbase_missing' in d:assert np.array_equal(d['Xbase_missing'],np.isnan(d['Xbase']))
 if 'Xshape_missing' in d:assert np.array_equal(d['Xshape_missing'],np.isnan(d['Xshape']))
 if 'base_margin_clipped' in d:assert np.array_equal(d['base_margin_clipped'][pv],(p<EPS)|(p>1-EPS))
 if 'future_missing_hours' in d:assert (d['future_missing_hours'][valid]==0).all(),'incomplete labelled window'
 if 'legacy_label_valid' in d:assert (d['legacy_label_valid'][valid]).all()
 return n

def train_indices(d,h,start,cap=40000):
 eligible=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']+h*3600<=start)&(d['quarter_cutoff']<=d['ts'])&(d['ts']>=int(dt.datetime(2022,1,1,tzinfo=dt.timezone.utc).timestamp()))
 ids=np.flatnonzero(eligible)
 ordered=sorted(ids,key=lambda i:(hashlib.sha256(f"Q26-R17-TRAIN:{d['sid'][i]}:{int(d['ts'][i])}".encode()).digest(),str(d['sid'][i]),int(d['ts'][i])))
 return np.array(ordered[:cap],dtype=np.int64)

def expand(d,ids,shape=False):
 base=d['Xbase'][ids].astype(np.float64)
 if shape:base=np.column_stack((base,d['Xshape'][ids].astype(np.float64)))
 x=np.column_stack((np.repeat(base,5,axis=0),np.tile(np.log1p(BARRIERS),len(ids))))
 return x,d['y'][ids].reshape(-1).astype(np.float64),margin(d['p_fH'][ids]).reshape(-1)
def impute_fit(x):
 med=np.array([np.median(c[np.isfinite(c)]) if np.isfinite(c).any() else 0. for c in x.T]);return med
def impute(x,med):
 missing=~np.isfinite(x);return np.column_stack((np.where(missing,med,x),missing.astype(float)))
def objective(beta,x,y,offset):
 z=offset+beta[0]+x@beta[1:]
 penalty=.005*np.dot(beta[1:],beta[1:]);loss=np.mean(np.logaddexp(0,z)-y*z)+penalty
 err=expit(z)-y
 grad=np.r_[err.mean(),x.T@err/len(y)+.01*beta[1:]]
 return float(loss),grad

def fit_predict(arm,xt,yt,mt,xe,me):
 med=impute_fit(xt);a=impute(xt,med);b=impute(xe,med)
 if arm=='linear':
  mean=a.mean(axis=0);std=a.std(axis=0);std[std==0]=1.;a=(a-mean)/std;b=(b-mean)/std
  opt=minimize(objective,np.zeros(a.shape[1]+1),args=(a,yt,mt),jac=True,method='L-BFGS-B',options={'maxiter':300,'ftol':1e-12,'gtol':1e-7})
  if not opt.success:raise RuntimeError('linear optimization failed: '+str(opt.message))
  pred=expit(me+opt.x[0]+b@opt.x[1:]);details={'iterations':int(opt.nit),'objective':float(opt.fun),'success':True}
 else:
  import xgboost as xgb
  assert xgb.__version__=='3.4.1'
  model=xgb.train(XGB,xgb.DMatrix(a,label=yt,base_margin=mt),num_boost_round=128)
  pred=model.predict(xgb.DMatrix(b,base_margin=me)).astype(np.float64);details={'rounds':128,'base_margin_at_train_and_predict':True}
 assert np.isfinite(pred).all() and ((pred>=0)&(pred<=1)).all()
 return pred,details

def _worker(conn,*args):
 try:conn.send(('ok',fit_predict(*args)))
 except BaseException as e:conn.send(('error',type(e).__name__+': '+str(e)))
 finally:conn.close()
def sampled_rss(parent_pid,child_pid,timeout):
 if timeout<=0:raise TimeoutError('per-fit boundary before RSS probe')
 r=subprocess.run(['/bin/ps','-o','pid=,rss=','-p',str(parent_pid)+','+str(child_pid)],capture_output=True,text=True,timeout=timeout)
 if r.returncode!=0:raise RuntimeError('RSS probe nonzero status')
 rows={}
 for line in r.stdout.splitlines():
  fields=line.split()
  if len(fields)!=2:raise RuntimeError('malformed RSS probe')
  try:pid,rss=map(int,fields)
  except ValueError:raise RuntimeError('nonnumeric RSS probe')
  if pid in rows or pid not in (parent_pid,child_pid) or rss<=0:raise RuntimeError('invalid RSS probe row')
  rows[pid]=rss
 if parent_pid not in rows:raise RuntimeError('parent RSS unavailable')
 if child_pid not in rows:raise LookupError('child RSS unavailable')
 return sum(rows.values())*1024

def bounded_fit(arm,xt,yt,mt,xe,me,seconds=120,rss_limit=1073741824):
 ctx=mp.get_context('spawn');recv,send=ctx.Pipe(False);p=ctx.Process(target=_worker,args=(send,arm,xt,yt,mt,xe,me));p.start();send.close();start=time.monotonic();peak=0
 try:
  while not recv.poll(.15):
   if time.monotonic()-start>seconds:raise TimeoutError('per-fit boundary')
   if not p.is_alive():
    if recv.poll(0):break
    raise RuntimeError('fit child exited without result')
   remaining=seconds-(time.monotonic()-start)
   try:sample=sampled_rss(os.getpid(),p.pid,min(1.,remaining))
   except LookupError:
    if recv.poll(0):break
    raise RuntimeError('child RSS missing before result')
   peak=max(peak,sample)
   if peak>rss_limit:raise MemoryError('combined parent/fit RSS boundary')
  remaining=seconds-(time.monotonic()-start)
  if remaining<=0:raise TimeoutError('per-fit result boundary')
  tag,value=recv.recv();p.join(timeout=min(5,remaining))
  if p.is_alive():raise RuntimeError('fit child failed to terminate')
  if p.exitcode!=0:raise RuntimeError('fit child nonzero terminal status')
  if tag!='ok':raise RuntimeError(value)
  pred,details=value;details.update(elapsed_seconds=time.monotonic()-start,combined_sampled_peak_rss_bytes=peak);return pred,details
 finally:
  if p.is_alive():
   p.terminate();p.join(timeout=5)
   if p.is_alive():p.kill();p.join(timeout=5)
   if p.is_alive():raise RuntimeError('fit child survived kill')
  recv.close()

def metrics(y,p,rawbaseline,sid,ts):
 n=len(y)
 if not n:return {'status':'no_scored_rows','n':0}
 y=y.astype(float);p=p.astype(float);epsp=np.clip(p,EPS,1-EPS);brier=float(np.mean((p-y)**2));ref=float(np.mean((rawbaseline-y)**2));events=int(y.sum());expected=float(p.sum())
 return {'status':'scored','n':n,'series':len(np.unique(sid)),'utc_epoch_weeks':len(np.unique(ts//604800)),'events':events,'sum_probability':expected,'brier':brier,'baseline_raw_brier':ref,'bss':None if ref==0 else 1-brier/ref,'bss_status':'undefined_zero_baseline_loss' if ref==0 else 'defined','bounded_logloss':float(np.mean(-y*np.log(epsp)-(1-y)*np.log1p(-epsp))),'logloss_clipped_predictions':int(((p<EPS)|(p>1-EPS)).sum()),'observed_over_expected':None if expected==0 else events/expected,'observed_over_expected_status':'undefined_zero_expected' if expected==0 else 'defined','expected_over_observed':None if events==0 else expected/events,'expected_over_observed_status':'undefined_zero_events' if events==0 else 'defined'}
def missing_bounds(y,p,baseline,valid):
 n=len(y);known=valid.astype(bool);unknown=~known
 if not n:return {'status':'no_issued_rows','n':0,'unknown_rows':0,'mean_d_lower':None,'mean_d_upper':None,'scope':'missing-label sensitivity bounds, not confidence intervals'}
 d0=p*p-baseline*baseline;d1=(p-1)**2-(baseline-1)**2
 known_sum=float(np.where(y[known]==1,d1[known],d0[known]).sum())
 return {'status':'bounded','n':n,'known_rows':int(known.sum()),'unknown_rows':int(unknown.sum()),'known_sum_d':known_sum,'mean_d_lower':(known_sum+float(np.minimum(d0[unknown],d1[unknown]).sum()))/n,'mean_d_upper':(known_sum+float(np.maximum(d0[unknown],d1[unknown]).sum()))/n,'scope':'missing-label sensitivity bounds, not confidence intervals'}
def summarize_missing(d,indices,predictions,h):
 sid=d['sid'][indices];ts=d['ts'][indices];y=d['y'][indices];base=d['p_fH'][indices];valid=d['label_valid'][indices];years=np.array([dt.datetime.fromtimestamp(int(t),dt.timezone.utc).year for t in ts])
 groups=[('all','all',np.ones(len(indices),bool))]+[('year',str(v),years==v) for v in [2024,2025]]+[('asset',str(v),sid==v) for v in np.unique(sid)];rows=[]
 for kind,key,mask in groups:
  for name,p in predictions.items():
   for j,barrier in enumerate(BARRIERS):rows.append({'horizon_hours':h,'group_type':kind,'group':key,'prediction':name,'barrier':float(barrier),**missing_bounds(y[mask,j],p[mask,j],base[mask,j],valid[mask])})
 return rows

def summarize(d,indices,predictions,h):
 rows=[];sid=d['sid'][indices];ts=d['ts'][indices];y=d['y'][indices];base=d['p_fH'][indices];years=np.array([dt.datetime.fromtimestamp(int(t),dt.timezone.utc).year for t in ts])
 groups=[('all','all',np.ones(len(indices),bool))]+[('year',str(v),years==v) for v in [2024,2025]]+[('asset',str(v),sid==v) for v in np.unique(sid)]
 for kind,key,mask in groups:
  for name,p in predictions.items():
   for j,barrier in enumerate(BARRIERS):rows.append({'horizon_hours':h,'group_type':kind,'group':key,'prediction':name,'barrier':float(barrier),**metrics(y[mask,j],p[mask,j],base[mask,j],sid[mask],ts[mask])})
 return rows

def run_horizon(d,h,out,cap=40000,min_origins=100,full_deadline=None):
 validate(d);n=len(d['ts']);issue=d['issue_eligible']&d['p_fH_valid'];evalmask=issue&(d['ts']>=int(dt.datetime(2024,1,1,tzinfo=dt.timezone.utc).timestamp()))&(d['ts']<int(dt.datetime(2026,1,1,tzinfo=dt.timezone.utc).timestamp()));all_eval=np.flatnonzero(evalmask)
 raw={a:np.full((n,5),np.nan) for a in ARMS};folds=[]
 for start in [int(dt.datetime(y,m,1,tzinfo=dt.timezone.utc).timestamp()) for y in [2024,2025] for m in [1,4,7,10]]:
  if full_deadline and time.monotonic()>full_deadline:raise TimeoutError('full-run boundary')
  ids=np.flatnonzero(evalmask&(d['quarter_cutoff']==start));train=train_indices(d,h,start,cap);labels=d['y'][train].reshape(-1);status=('NOT_FIT_no_issuance' if not len(ids) else ('fit' if len(train)>=min_origins and len(np.unique(labels))==2 else 'NOT_FIT_baseline_fallback'))
  f={'quarter_start_utc':dt.datetime.fromtimestamp(int(start),dt.timezone.utc).isoformat(),'train_origins':len(train),'train_expanded_rows':len(train)*5,'train_events':int(labels.sum()),'issued_origins':len(ids),'scored_origins':int(d['label_valid'][ids].sum()),'status':status,'train_origin_identity_sha256':hashlib.sha256('\n'.join(f'{d["sid"][i]}:{int(d["ts"][i])}' for i in train).encode()).hexdigest(),'arms':{}}
  for arm in ARMS:
   if status!='fit':raw[arm][ids]=d['p_fH'][ids];f['arms'][arm]={'status':'unchanged_raw_baseline_fallback'};continue
   xt,yt,mt=expand(d,train,arm=='xgb_shape');xe,_,me=expand(d,ids,arm=='xgb_shape')
   remaining=120 if full_deadline is None else min(120,max(0,full_deadline-time.monotonic()))
   if remaining<=0:raise TimeoutError('full-run boundary')
   print(f'R17 horizon={h} quarter={f["quarter_start_utc"]} arm={arm} train_origins={len(train)} issued_origins={len(ids)}',file=sys.stderr,flush=True)
   pred,details=bounded_fit(arm,xt,yt,mt,xe,me,seconds=remaining);raw[arm][ids]=pred.reshape(-1,5);f['arms'][arm]=details
  folds.append(f)
 scored=all_eval[d['label_valid'][all_eval]];preds={'baseline_raw':d['p_fH'][scored],'baseline_clipped_control':np.clip(d['p_fH'][scored],EPS,1-EPS)}
 local={'sid':d['sid'][all_eval],'ts':d['ts'][all_eval],'y':d['y'][all_eval],'label_valid':d['label_valid'][all_eval],'baseline_raw':d['p_fH'][all_eval],'baseline_clipped_control':np.clip(d['p_fH'][all_eval],EPS,1-EPS)}
 for arm in ARMS:
  assert np.isfinite(raw[arm][all_eval]).all();projected=pav(raw[arm][all_eval]);local[arm+'_raw']=raw[arm][all_eval];local[arm+'_projected']=projected;preds[arm+'_raw']=raw[arm][scored];preds[arm+'_projected']=pav(raw[arm][scored])
 np.savez_compressed(out,**local)
 sensitivity=summarize_missing(d,all_eval,{k:v for k,v in local.items() if k not in ('sid','ts','y','label_valid')},h)
 return {'horizon_hours':h,'issue_eligible_origins':int(d['issue_eligible'].sum()),'issue_eligible_invalid_baseline':int((d['issue_eligible']&~d['p_fH_valid']).sum()),'evaluation_issued_origins':len(all_eval),'evaluation_unlabelled_origins':int((~d['label_valid'][all_eval]).sum()),'evaluation_issue_eligible_origins':int((d['issue_eligible']&(d['ts']>=int(dt.datetime(2024,1,1,tzinfo=dt.timezone.utc).timestamp()))&(d['ts']<int(dt.datetime(2026,1,1,tzinfo=dt.timezone.utc).timestamp()))).sum()),'evaluation_complete_label_origins':int(d['label_valid'][all_eval].sum()),'evaluation_legacy_label_origins':None if 'legacy_label_valid' not in d else int(d['legacy_label_valid'][all_eval].sum()),'evaluation_fH_fallback_origins':None if 'fH_fallback' not in d else int(np.asarray(d['fH_fallback'][all_eval]).reshape(len(all_eval),-1).any(axis=1).sum()) if len(all_eval) else 0,'scored_common_origins':len(scored),'missing_label_sensitivity':sensitivity,'missing_label_sensitivity_population':'All issued forecasts with valid baseline probability, including incomplete future paths. Issue-eligible invalid-baseline origins remain explicitly unavailable and outside paired prediction bounds.','folds':folds,'scores':summarize(d,scored,preds,h),'local_predictions_sha256':sha(out)}

def cross_horizon(paths,tolerance=1e-12):
 """Diagnostic only, no horizon projection or row selection by outcome."""
 loaded={}
 for h,path in paths.items():
  with np.load(path,allow_pickle=False) as f:
   keys=[k for k in f.files if k not in ('sid','ts','y','label_valid')]
   loaded[h]=({(str(s),int(t)):i for i,(s,t) in enumerate(zip(f['sid'],f['ts']))},{k:f[k] for k in keys})
 out=[]
 hs=sorted(loaded)
 for i,h1 in enumerate(hs):
  for h2 in hs[i+1:]:
   m1,p1=loaded[h1];m2,p2=loaded[h2];common=sorted(set(m1)&set(m2));i1=[m1[k] for k in common];i2=[m2[k] for k in common]
   assert set(p1)==set(p2)
   for name in sorted(p1):
    diff=p1[name][i1]-p2[name][i2]
    for j,b in enumerate(BARRIERS):
     delta=diff[:,j];out.append({'short_hours':h1,'long_hours':h2,'prediction':name,'barrier':float(b),'common_origins':len(common),'status':'compared' if common else 'no_common_origins','violations':int((delta>tolerance).sum()),'maximum_short_minus_long':None if not len(common) else float(delta.max()),'maximum_positive_violation':None if not len(common) else float(max(0,delta.max())),'tolerance':tolerance})
 return out

def atomic_json(path,value):
 temporary=path.with_name(path.name+'.tmp')
 with open(temporary,'w') as f:
  json.dump(value,f,indent=2,sort_keys=True,allow_nan=False);f.flush();os.fsync(f.fileno())
 os.replace(temporary,path)

def run_admitted(req,inputs_dir,output_dir):
 import shutil
 out=Path(output_dir);out.mkdir(exist_ok=False)
 start=time.monotonic();stage='initial_resource_check';h=None
 result={'schema':'r17-event-pilot-results-v1','complete':False,'scope':'Already-seen exploratory development only; no formal inference, eligibility, power, promotion or actual-liquidation claim.','horizons':[]}
 try:
  assert shutil.disk_usage(out).free>=2147483648+100000000
  for h in HORIZONS:
   stage='input_hash';p=Path(inputs_dir)/f'horizon-{h}.npz';assert sha(p)==req['input_sha256'][str(h)]
   stage='input_load'
   with np.load(p,allow_pickle=False) as f:d={k:f[k] for k in f.files}
   stage='horizon_fit_and_score'
   result['horizons'].append(run_horizon(d,h,out/f'predictions-{h}.npz',full_deadline=start+1200))
   stage='aggregate_checkpoint'
   atomic_json(out/'progress.json',{**result,'completed_horizons':[v['horizon_hours'] for v in result['horizons']],'elapsed_seconds':time.monotonic()-start})
   stage='post_horizon_resource_check';assert shutil.disk_usage(out).free>=2147483648
  stage='cross_horizon_diagnostic'
  result['cross_horizon_diagnostic']=cross_horizon({h:out/f'predictions-{h}.npz' for h in HORIZONS});result['barrier_projection_scope']='Per-horizon barrier order only; not a jointly coherent time-to-hit model.'
  stage='final_serialization';result['complete']=True;result['elapsed_seconds']=time.monotonic()-start;atomic_json(out/'result.json',result)
  return result
 except BaseException as exc:
  atomic_json(out/'failure.json',{'schema':'r17-event-pilot-failure-v1','complete':False,'stage':stage,'horizon_hours':h,'completed_horizons':[v['horizon_hours'] for v in result['horizons']],'error_class':type(exc).__name__,'error_message':str(exc)[:1500],'elapsed_seconds':time.monotonic()-start,'partial_evidence':'Existing prediction files and progress.json are preserved. A missing checkpoint is not a successful result.'})
  raise

BASE_TRAINER_SHA256='2caf33ddc9dd06e529de5a36ebba18a8ff64d83f9b18bfb1c88a1a04c94e5172'
BASE_V2_TRAINER_SHA256='80bc9ad0d8c225e2d1a5e8386e145974ef15a747522ef60bc92f84fbb664dc62'
PREFIX_HORIZONS=(6,12)
REMAINING_HORIZONS=(24,72,168)
def metadata_pin(path):
 p=Path(path).resolve();return {'path':str(p),'size':p.stat().st_size,'sha256':sha(p)}
def check_metadata_pin(expected):
 if metadata_pin(expected['path'])!=expected:raise ValueError('resume metadata identity mismatch')
def validate_resume(req,inputs_dir):
 import math
 r=req['resume'];account={'original_budget_seconds':1200,'prior_attempt_charged_seconds':125,'remaining_seconds':1075}
 if r['time_accounting']!=account:raise ValueError('resume time accounting mismatch')
 required=['original_trainer','original_model_request','original_launch_request','original_monitor_receipt','parent_prefix_audit','prefix_progress','second_trainer','second_model_request','second_launch_request','second_monitor_receipt','second_progress','second_prefix_progress']
 for name in required:check_metadata_pin(r[name])
 if r['original_trainer']['sha256']!=BASE_TRAINER_SHA256:raise ValueError('unapproved original trainer')
 original=json.loads(Path(r['original_model_request']['path']).read_text())
 if original['status']!='READY_PARENT_ADMITTED' or original['trainer_sha256']!=BASE_TRAINER_SHA256:raise ValueError('original model admission')
 operational={'files','trainer_sha256','output_directory','parent_admitted_utc','max_full_seconds','execution_amendment_board_commit','resume'}
 for key,value in original.items():
  if key not in operational and req.get(key)!=value:raise ValueError('scientific protocol changed: '+key)
 if req['max_full_seconds']!=1075 or original['max_full_seconds']!=1200:raise ValueError('full-run budget changed')
 if Path(inputs_dir).resolve()!=Path(original['input_directory']).resolve():raise ValueError('input directory changed')
 launch=json.loads(Path(r['original_launch_request']['path']).read_text());receipt=json.loads(Path(r['original_monitor_receipt']['path']).read_text())
 if receipt['request']!=r['original_launch_request'] or receipt['complete'] is not False:raise ValueError('prior monitor identity/status')
 if launch['policy']['wall_seconds']!=1200 or math.ceil(receipt['elapsed_seconds'])!=122:raise ValueError('prior elapsed-time charge')
 if receipt['changed_pin_paths'] or not receipt['containment']['no_live_members_remaining']:raise ValueError('prior pin/containment audit')
 if r['original_model_request'] not in launch['pins'] or r['original_trainer'] not in launch['pins']:raise ValueError('original launch source closure')
 audit=json.loads(Path(r['parent_prefix_audit']['path']).read_text())
 if audit['accepted'] is not True:raise ValueError('prefix parent admission missing')
 if audit.get('monitor')!=r['original_monitor_receipt'] or audit.get('result')!=r['prefix_progress']:raise ValueError('prefix parent audit identity mismatch')
 for h in HORIZONS:
  path=Path(inputs_dir)/f'horizon-{h}.npz';actual=metadata_pin(path)
  if actual['sha256']!=req['input_sha256'][str(h)] or actual not in launch['pins']:raise ValueError('original input identity changed')
 progress=json.loads(Path(r['prefix_progress']['path']).read_text())
 if progress['complete'] is not False or progress['completed_horizons']!=list(PREFIX_HORIZONS):raise ValueError('prefix completion list')
 if [v['horizon_hours'] for v in progress['horizons']]!=list(PREFIX_HORIZONS):raise ValueError('prefix horizon records')
 if set(r['prefix_predictions'])!={'6','12'}:raise ValueError('prefix prediction set')
 for item in progress['horizons']:
  h=item['horizon_hours'];expected=r['prefix_predictions'][str(h)];check_metadata_pin(expected)
  if item['local_predictions_sha256']!=expected['sha256'] or len(item['folds'])!=8 or not isinstance(item['scores'],list) or not isinstance(item['missing_label_sensitivity'],list):raise ValueError('prefix structural identity')
 second=json.loads(Path(r['second_model_request']['path']).read_text())
 if second['status']!='READY_PARENT_ADMITTED' or second['trainer_sha256']!=BASE_V2_TRAINER_SHA256 or r['second_trainer']['sha256']!=BASE_V2_TRAINER_SHA256 or second['max_full_seconds']!=1078:raise ValueError('second model admission identity')
 for key,value in original.items():
  if key not in operational and second.get(key)!=value:raise ValueError('second scientific protocol changed: '+key)
 for key in ['original_trainer','original_model_request','original_launch_request','original_monitor_receipt','parent_prefix_audit','prefix_progress','prefix_predictions']:
  if second['resume'][key]!=r[key]:raise ValueError('second attempt prefix provenance mismatch')
 if second['resume']['time_accounting']!={'original_budget_seconds':1200,'prior_attempt_charged_seconds':122,'remaining_seconds':1078}:raise ValueError('second attempt prior time accounting')
 second_launch=json.loads(Path(r['second_launch_request']['path']).read_text());second_receipt=json.loads(Path(r['second_monitor_receipt']['path']).read_text())
 if second_receipt['request']!=r['second_launch_request'] or second_receipt['complete'] is not False or second_receipt['changed_pin_paths'] or not second_receipt['containment']['no_live_members_remaining']:raise ValueError('second monitor identity/status')
 if second_launch['policy']['wall_seconds']!=1078 or math.ceil(second_receipt['elapsed_seconds'])!=3 or math.ceil(receipt['elapsed_seconds'])+math.ceil(second_receipt['elapsed_seconds'])!=125:raise ValueError('two-attempt time charge')
 for entry in [r['second_model_request'],r['second_trainer'],*[metadata_pin(Path(inputs_dir)/f'horizon-{h}.npz') for h in HORIZONS]]:
  if entry not in second_launch['pins']:raise ValueError('second launch source/input closure')
 check_launch_binding(launch,r['original_model_request'],r['original_trainer'],original)
 check_launch_binding(second_launch,r['second_model_request'],r['second_trainer'],second)
 second_out=Path(second['output_directory']).resolve()
 if Path(r['second_progress']['path']).resolve()!=second_out/'progress.json' or Path(r['second_prefix_progress']['path']).resolve()!=second_out/'prefix-progress.v1.json':raise ValueError('second checkpoint paths')
 second_progress=json.loads(Path(r['second_progress']['path']).read_text())
 if second_progress['complete'] is not False or second_progress['completed_horizons']!=list(PREFIX_HORIZONS) or second_progress['horizons']!=progress['horizons']:raise ValueError('second attempt new/mismatched horizon')
 if r['second_prefix_progress']['sha256']!=r['prefix_progress']['sha256'] or r['second_prefix_progress']['size']!=r['prefix_progress']['size']:raise ValueError('second copied prefix progress identity')
 if set(r['second_prefix_predictions'])!={'6','12'}:raise ValueError('second prefix prediction set')
 for h in PREFIX_HORIZONS:
  expected=r['second_prefix_predictions'][str(h)];check_metadata_pin(expected);prior=r['prefix_predictions'][str(h)]
  if Path(expected['path']).resolve()!=second_out/f'predictions-{h}.npz' or expected['sha256']!=prior['sha256'] or expected['size']!=prior['size']:raise ValueError('second copied prefix prediction identity')
 if (second_out/'result.json').exists() or any((second_out/f'predictions-{h}.npz').exists() for h in REMAINING_HORIZONS):raise ValueError('second attempt new result exists')
 return progress

def check_launch_binding(launch,model_pin,trainer_pin,model):
 argv=launch['argv']
 if len(argv)<2 or Path(argv[1]).resolve()!=Path(trainer_pin['path']).resolve():raise ValueError('launch trainer binding')
 for flag,value in [('--admitted-request',model_pin['path']),('--inputs-dir',model['input_directory']),('--output-dir',model['output_directory'])]:
  if argv.count(flag)!=1 or argv.index(flag)+1>=len(argv) or Path(argv[argv.index(flag)+1]).resolve()!=Path(value).resolve():raise ValueError('launch argument binding '+flag)

def run_resume_admitted(req,inputs_dir,output_dir):
 import shutil
 start=time.monotonic();stage='resume_identity_validation';h=None
 # Identity failure creates no new output directory and cannot alter the prefix.
 prefix=validate_resume(req,inputs_dir)
 out=Path(output_dir);out.mkdir(exist_ok=False)
 result={'schema':'r17-event-pilot-results-v1','complete':False,'scope':prefix['scope'],'horizons':list(prefix['horizons']),'continuation':{'independent_repeat':False,'reused_prefix_horizons':list(PREFIX_HORIZONS),'recomputed_horizons':list(REMAINING_HORIZONS),'time_accounting':req['resume']['time_accounting'],'prefix_progress':req['resume']['prefix_progress'],'parent_prefix_audit':req['resume']['parent_prefix_audit'],'prior_attempt_receipts':[req['resume']['original_monitor_receipt'],req['resume']['second_monitor_receipt']]}}
 try:
  stage='copy_immutable_prefix';assert shutil.disk_usage(out).free>=2147483648+100000000
  for h in PREFIX_HORIZONS:
   expected=req['resume']['prefix_predictions'][str(h)];dest=out/f'predictions-{h}.npz';shutil.copyfile(expected['path'],dest)
   if dest.stat().st_size!=expected['size'] or sha(dest)!=expected['sha256']:raise ValueError('prefix copy identity')
  for key,name in [('prefix_progress','prefix-progress.v1.json'),('original_monitor_receipt','prefix-monitor.v1.json'),('parent_prefix_audit','prefix-parent-audit.v1.json'),('original_model_request','prefix-model-request.v1.json'),('original_launch_request','prefix-launch.v1.json'),('second_monitor_receipt','prior-monitor.v2.json'),('second_launch_request','prior-launch.v2.json'),('second_progress','prior-progress.v2.json')]:
   expected=req['resume'][key];dest=out/name;shutil.copyfile(expected['path'],dest)
   if sha(dest)!=expected['sha256']:raise ValueError('prefix evidence copy identity')
  atomic_json(out/'progress.json',{**result,'completed_horizons':list(PREFIX_HORIZONS),'elapsed_seconds':time.monotonic()-start})
  for h in REMAINING_HORIZONS:
   stage='input_hash';p=Path(inputs_dir)/f'horizon-{h}.npz';assert sha(p)==req['input_sha256'][str(h)]
   stage='input_load'
   with np.load(p,allow_pickle=False) as f:d={k:f[k] for k in f.files}
   stage='horizon_fit_and_score';result['horizons'].append(run_horizon(d,h,out/f'predictions-{h}.npz',full_deadline=start+1075))
   stage='aggregate_checkpoint';atomic_json(out/'progress.json',{**result,'completed_horizons':[v['horizon_hours'] for v in result['horizons']],'elapsed_seconds':time.monotonic()-start})
   stage='post_horizon_resource_check';assert shutil.disk_usage(out).free>=2147483648
  stage='cross_horizon_diagnostic';result['cross_horizon_diagnostic']=cross_horizon({h:out/f'predictions-{h}.npz' for h in HORIZONS});result['barrier_projection_scope']='Per-horizon barrier order only; not a jointly coherent time-to-hit model.'
  if time.monotonic()-start>1075:raise TimeoutError('remaining original run budget exhausted')
  result['complete']=True;result['elapsed_seconds']=time.monotonic()-start;result['original_budget_charged_seconds']=125+result['elapsed_seconds'];atomic_json(out/'result.json',result);return result
 except BaseException as exc:
  atomic_json(out/'failure.json',{'schema':'r17-event-pilot-failure-v1','complete':False,'stage':stage,'horizon_hours':h,'completed_horizons':[v['horizon_hours'] for v in result['horizons']],'error_class':type(exc).__name__,'error_message':str(exc)[:1500],'elapsed_seconds':time.monotonic()-start,'time_accounting':req['resume']['time_accounting'],'partial_evidence':'Prefix copies and completed new-horizon progress remain local; this is not an independent repeat.'});raise

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--admitted-request',required=True);ap.add_argument('--inputs-dir',required=True);ap.add_argument('--output-dir',required=True);a=ap.parse_args();req=json.loads(Path(a.admitted_request).read_text())
 assert req['status']=='READY_PARENT_ADMITTED';assert req['trainer_sha256']==sha(__file__)
 if Path(a.output_dir).resolve()!=Path(req['output_directory']).resolve():raise ValueError('signed output directory mismatch')
 run_resume_admitted(req,a.inputs_dir,a.output_dir)
if __name__=='__main__':main()
