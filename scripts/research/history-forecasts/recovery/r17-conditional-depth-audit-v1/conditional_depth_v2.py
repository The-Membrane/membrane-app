#!/usr/bin/env python3
"""DRAFT: separate feature-only CUTS and parent-pinned descriptive ANALYZE."""
import argparse,hashlib,json,math,os,resource,shutil,signal,sys,time
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='1'
import numpy as np
HORIZONS=(6,12,24,72,168);BARRIERS=np.array([-.4,-.2,-.1,-.05,-.02]);Q=np.array([.01,.05,.1,.25,.5,.75,.9,.95,.99]);EPS=1e-6
TRAIN0=1640995200;EVAL0=1704067200;YEAR25=1735689600;END=1767225600
CUT_KEYS=('sid','ts','issue_eligible','fH_fallback','Xbase','Xshape')
LABEL_KEYS=('p_fH','p_fH_valid','label_valid','legacy_label_valid','future_missing_hours','future_log_min','y')
AXES=('issued_log_sigma','downside_imbalance_D','jump_share_D')

def pin(p):
 p=Path(p);h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())
def check(p):
 if pin(p['path'])!=p:raise ValueError('changed pin: '+p['path'])
def read_columns(path,phase):
 keys=CUT_KEYS if phase=='cuts' else CUT_KEYS+LABEL_KEYS
 if phase not in ('cuts','analyze'):raise ValueError('invalid phase')
 with np.load(path,allow_pickle=False) as z:return {k:z[k] for k in keys}
def effective(d):
 return np.where(d['fH_fallback'],d['Xbase'][:,1],d['Xbase'][:,0]).astype(float)
def axes(d):return (effective(d),d['Xshape'][:,3].astype(float),d['Xshape'][:,0].astype(float))
def cut_table(d):
 take=d['issue_eligible']&(d['ts']>=TRAIN0)&(d['ts']<EVAL0);out={}
 for name,x in zip(AXES,axes(d)):
  v=x[take&np.isfinite(x)];out[name]={'cut':float(np.quantile(v,.5,method='linear')) if len(v) else None,'training_n':int(len(v)),'training_unknown_n':int(np.sum(take&~np.isfinite(x)))}
 return out

def metadata(d,sids):
 n=len(d['ts'])
 if d['sid'].shape!=(n,) or d['Xbase'].shape!=(n,12) or d['Xshape'].shape!=(n,6):raise ValueError('feature geometry')
 if d['issue_eligible'].dtype!=bool or d['fH_fallback'].dtype!=bool or not set(np.unique(d['sid']))<=set(sids):raise ValueError('metadata identity')
 if np.any(d['ts']%86400) or np.any((d['ts']<TRAIN0)|(d['ts']>=END)):raise ValueError('issuance clock')
 if len(set(zip(d['sid'].tolist(),d['ts'].tolist())))!=n:raise ValueError('duplicate origin')

def validate_launch(mon,launch,pins):
 if not mon['complete'] or mon['exit_code']!=0 or mon['changed_pin_paths'] or mon['request']!=pins['build_launch']:raise ValueError('monitor launch binding')
 if pins['manifest'] not in mon['result_pins']:raise ValueError('monitor manifest binding')
 argv=launch['argv']
 if argv.count('--request')!=1 or argv.count('--sha256')!=1 or argv[argv.index('--request')+1]!=pins['staging_request']['path'] or argv[argv.index('--sha256')+1]!=pins['staging_request']['sha256'] or pins['staging_request'] not in launch['pins']:raise ValueError('launch request binding')

def execution_identity(r):
 source=r['execution_source_pin'];tests=r['execution_tests_pin']
 if Path(__file__).resolve()!=Path(source['path']).resolve():raise ValueError('execution source path')
 check(source);check(tests)
 for p in r['operational_amendment']['failed_v1_evidence']:check(p)

def validate_predecessor(r):
 amendment=r['operational_amendment'];files={Path(p['path']).name:p for p in amendment['failed_v1_evidence']}
 oldpin=files['analyze.request.parent.json'];old=json.loads(Path(oldpin['path']).read_text());outer=json.loads(Path(files['analysis-v1.outer-receipt.json']['path']).read_text());failure=json.loads(Path(files['failure.json']['path']).read_text())
 if old['pins']!=r['pins'] or old['inputs']!=r['inputs'] or old['parent_frozen_cuts_pin']!=r['parent_frozen_cuts_pin']:raise ValueError('historical closure changed')
 if outer['phase']!='analyze' or outer['returncode']!=1 or outer['timed_out'] or outer['expected_pins']!=outer['post_pins']:raise ValueError('failed predecessor receipt')
 expected=outer['expected_pins'];cut=r['parent_frozen_cuts_pin'];cutpath=str((Path(__file__).parent/cut['path']).resolve())
 if expected.get(oldpin['path'])!=oldpin['sha256'] or expected.get(r['pins']['source']['path'])!=r['pins']['source']['sha256'] or expected.get(cutpath)!=cut['sha256']:raise ValueError('failed predecessor identities')
 if failure['complete'] or failure['phase']!='analyze' or failure['stage']!='horizon-6' or failure['error_class']!='ValueError':raise ValueError('failed predecessor stage')
 b=amendment['budget'];charged=math.ceil(outer['outer_elapsed_seconds'])
 if charged!=4 or b['charged_failed_seconds']!=charged or b['original_analysis_seconds']!=120 or b['remaining_seconds']!=116 or 120-charged!=116 or b['old_outer_elapsed_seconds']!=outer['outer_elapsed_seconds'] or r['policy']['wall_seconds']!=116:raise ValueError('continuation budget')
def validate_cut_pin(r,p):
 expected=dict(r['parent_frozen_cuts_pin']);expected['path']=str((Path(__file__).parent/expected['path']).resolve());actual=dict(p);actual['path']=str(Path(actual['path']).resolve())
 if actual!=expected:raise ValueError('historical frozen cuts changed')

def authenticate(r):
 execution_identity(r);validate_predecessor(r)
 if sys.executable!=r['python'] or sys.version.split()[0]!=r['python_version'] or np.__version__!=r['numpy_version']:raise ValueError('runtime identity')
 for p in list(r['pins'].values())+list(r['inputs'].values())+r['closure_pins']:check(p)
 a=json.loads(Path(r['pins']['admission']['path']).read_text());m=json.loads(Path(r['pins']['manifest']['path']).read_text());mon=json.loads(Path(r['pins']['monitor']['path']).read_text());req=json.loads(Path(r['pins']['staging_request']['path']).read_text())
 if not a['accepted'] or not m['complete'] or a['manifest']!=r['pins']['manifest'] or a['monitor']!=r['pins']['monitor']:raise ValueError('admission chain')
 launch=json.loads(Path(r['pins']['build_launch']['path']).read_text());validate_launch(mon,launch,r['pins'])
 if sorted(a['input_pins'],key=lambda p:p['path'])!=sorted(r['inputs'].values(),key=lambda p:p['path']):raise ValueError('input closure')
 if sorted(m['outputs'],key=lambda p:p['path'])!=sorted(r['inputs'].values(),key=lambda p:p['path']):raise ValueError('manifest closure')
 if sorted(x[0] for x in m['canonical_mapping'])!=r['sids'] or m['canonical_mapping']!=req['selected']:raise ValueError('cohort identity')
 if m['barriers']!=BARRIERS.tolist() or m['feature_names']['Xbase'][:2]!=['lsH','lsf'] or m['feature_names']['Xshape']!=['jump_share_D','jump_share_W','jump_share_M','semivariance_imbalance_D','semivariance_imbalance_W','semivariance_imbalance_M']:raise ValueError('feature schema')
 if set(r['inputs'])!={str(h) for h in HORIZONS}:raise ValueError('horizon closure')
 return m

def weighted_quantile(x,w,q,presorted=False):
 order=np.arange(len(x)) if presorted else np.argsort(x,kind='stable');x=np.asarray(x)[order];w=np.asarray(w,dtype=np.int64)[order]
 if np.any(w<0):raise ValueError('negative weight')
 keep=w>0;x=x[keep];w=w[keep];n=int(w.sum())
 if not n:return np.full(len(np.atleast_1d(q)),np.nan)
 ranks=(n-1)*np.atleast_1d(q);lo=np.floor(ranks).astype(np.int64);hi=np.ceil(ranks).astype(np.int64);cum=np.cumsum(w)
 a=x[np.searchsorted(cum,lo,side='right')];b=x[np.searchsorted(cum,hi,side='right')]
 return a+(b-a)*(ranks-lo)
def shape_stats(x):
 if not len(x):return dict(n=0,mean=None,sd=None,quantiles=[None]*9,nonnegative_n=0,ratios=[None,None])
 q=np.quantile(x,Q,method='linear');den=q[5]-q[3]
 return dict(n=len(x),mean=float(np.mean(x)),sd=float(np.std(x)),quantiles=q.tolist(),nonnegative_n=int(np.sum(x>=0)),ratios=[float((q[4]-q[j])/den) if den>0 else None for j in [1,0]])
def block_keys(ts):return np.where(ts<YEAR25,2024,2025)*1000000+(ts//86400//28)
def draw_plan():
 days=np.arange(EVAL0,END,86400);keys=np.unique(block_keys(days));weights=np.zeros((500,len(keys)),np.int64)
 for rng,year in zip([np.random.default_rng(s) for s in np.random.SeedSequence(2026106000).spawn(2)],[2024,2025]):
  idx=np.where(keys//1000000==year)[0];weights[:,idx]=rng.multinomial(len(idx),np.full(len(idx),1/len(idx)),size=500)
 return keys,weights
def sensitivity(values,denoms):
 x=np.asarray(values);valid=np.isfinite(x);count=valid.sum(axis=0);mean=np.divide(np.where(valid,x,0).sum(0),count,out=np.full(x.shape[1:],np.nan),where=count>0)
 sd=np.sqrt(np.divide(np.where(valid,(x-mean)**2,0).sum(0),count-1,out=np.full(x.shape[1:],np.nan),where=count>1))
 qs=np.array([np.quantile(x[:,j][valid[:,j]],[.05,.95],method='linear') if count[j] else [np.nan,np.nan] for j in range(x.shape[1])])
 return dict(defined_replicates=count.tolist(),undefined_replicates=(500-count).tolist(),sd=sd.tolist(),quantiles05_95=qs.tolist(),weighted_denominators=denoms.tolist())
def bootstrap(d,mask,z,keys,weights):
 ix=np.flatnonzero(mask);bi=np.searchsorted(keys,block_keys(d['ts'][ix]));bc=np.bincount(bi,minlength=len(keys));den=weights@bc
 errors=d['p_fH'][ix]-d['y'][ix];sums=np.zeros((len(keys),5));np.add.at(sums,bi,errors)
 vals=np.divide(weights@sums,den[:,None],out=np.full((500,5),np.nan),where=den[:,None]>0)
 out={'event_error':sensitivity(vals,den)}
 ratios=np.full((500,2),np.nan);order=np.argsort(z,kind='stable');zs=z[order];bis=bi[order]
 for j,w in enumerate(weights):
  q=weighted_quantile(zs,w[bis],[.01,.05,.25,.5,.75],presorted=True);spread=q[4]-q[2]
  if spread>0:ratios[j]=[(q[3]-q[1])/spread,(q[3]-q[0])/spread]
 out['shape_ratios']=sensitivity(ratios,den);return out

def views(d,cuts,sids):
 evaluation=d['issue_eligible']&(d['ts']>=EVAL0)&(d['ts']<END)
 years=[('pooled',np.ones(len(evaluation),bool)),('2024',d['ts']<YEAR25),('2025',d['ts']>=YEAR25)]
 out=[('calendar',y,evaluation&m) for y,m in years]+[('asset',str(s),evaluation&(d['sid']==s)) for s in sids]
 for axis,x in zip(AXES,axes(d)):
  t=cuts[axis]['cut'];finite=np.isfinite(x);groups={'unknown':~finite if t is not None else np.ones(len(x),bool),'low':finite&(x<=t) if t is not None else np.zeros(len(x),bool),'high':finite&(x>t) if t is not None else np.zeros(len(x),bool)}
  for state,sel in groups.items():
   for year,m in years:out.append((axis,state+'/'+year,evaluation&sel&m))
 return out

def normalize(depth,logscale,h):
 with np.errstate(over='ignore',under='ignore',invalid='ignore',divide='ignore'):
  den=np.exp(logscale)*np.sqrt(h/8760);valid=np.isfinite(den)&(den>0);z=np.divide(depth,den,out=np.full(len(depth),np.nan),where=valid)
 return z,valid,np.isfinite(depth)&valid&~np.isfinite(z)

def analyze_horizon(d,h,cuts,sids,keys,weights):
 metadata(d,sids);n=len(d['ts']);p=d['p_fH'];lv=d['label_valid'];depth=d['future_log_min']
 if p.shape!=(n,5) or d['y'].shape!=(n,5) or lv.dtype!=bool or not np.array_equal(np.isfinite(depth),lv):raise ValueError('label schema')
 if not np.array_equal(d['y'][lv],(depth[lv,None]<=np.log1p(BARRIERS)).astype(np.uint8)):raise ValueError('depth label mismatch')
 pv=np.all(np.isfinite(p)&(p>=0)&(p<=1),axis=1)
 if not np.array_equal(pv,d['p_fH_valid']):raise ValueError('baseline availability')
 z,valid,badz=normalize(depth,effective(d),h);zh,hv,badh=normalize(depth,d['Xbase'][:,0].astype(float),h)
 output=[]
 for kind,name,v in views(d,cuts,sids):
  available=v&pv;scored=available&lv;unknown=available&~lv;matched=scored&valid&np.isfinite(z);hm=scored&hv&np.isfinite(zh);N=int(available.sum());nn=int(scored.sum());pos=d['y'][scored].sum(0).astype(int);pp=p[available].sum(0)
  y=d['y'][scored].astype(float);pr=p[scored];pc=np.clip(pr,EPS,1-EPS)
  r=dict(view_type=kind,view=name,issued_n=int(v.sum()),baseline_unavailable_n=int(np.sum(v&~pv)),scored_n=nn,unknown_label_n=int(unknown.sum()),legacy_label_n=int(np.sum(v&d['legacy_label_valid'])),future_missing_hours=int(d['future_missing_hours'][v].sum()),fallback_n=int(np.sum(available&d['fH_fallback'])),positive_labels=pos.tolist(),mean_probability=(pr.mean(0) if nn else np.full(5,np.nan)).tolist(),all_available_mean_probability=(pp/N if N else np.full(5,np.nan)).tolist(),observed_frequency=(pos/nn if nn else np.full(5,np.nan)).tolist(),predicted_minus_observed=((pr-y).mean(0) if nn else np.full(5,np.nan)).tolist(),observed_over_expected=np.divide(pos,pr.sum(0),out=np.full(5,np.nan),where=pr.sum(0)>0).tolist(),brier=(np.mean((pr-y)**2,axis=0) if nn else np.full(5,np.nan)).tolist(),bounded_logloss=(np.mean(-y*np.log(pc)-(1-y)*np.log1p(-pc),axis=0) if nn else np.full(5,np.nan)).tolist(),logloss_clipped_n=np.sum(pr!=pc,axis=0).tolist(),all_available_event_frequency_bounds=(np.array([pos/N,(pos+unknown.sum())/N]) if N else np.full((2,5),np.nan)).tolist(),distinct_assets=int(len(np.unique(d['sid'][v]))),distinct_origins=int(len(np.unique(d['ts'][v]))),year_calendar_blocks=int(len(np.unique(block_keys(d['ts'][v])))))
  r['all_complete_raw_depth']=shape_stats(depth[v&lv]);r['matched_effective_raw_depth']=shape_stats(depth[matched]);r['matched_effective_standardized_depth']=shape_stats(z[matched]);r['matched_har_raw_depth']=shape_stats(depth[hm]);r['matched_har_standardized_depth']=shape_stats(zh[hm]);r['scale_unavailable_scored_n']=int(np.sum(scored&~valid));r['har_scale_unavailable_scored_n']=int(np.sum(scored&~hv))
  r['matched_effective_n']=int(matched.sum());r['matched_effective_predicted_minus_observed']=((p[matched]-d['y'][matched]).mean(0) if matched.any() else np.full(5,np.nan)).tolist();r['nonfinite_effective_quotient_scored_n']=int(np.sum(scored&badz));r['nonfinite_har_quotient_scored_n']=int(np.sum(scored&badh))
  # Resampling uses matched rows for both event errors and shape; primary scores above keep all complete baseline-available rows.
  r['matched_effective_sensitivity']=bootstrap(d,matched,z[matched],keys,weights);output.append(r)
 return output

def reconcile(rows,h,reference):
 original=next(x for x in reference['horizons'] if x['horizon_hours']==h);lookup={}
 for x in original['scores']:
  if x['prediction']=='baseline_raw':
   key=(x['group_type'],x['group'],float(x['barrier']))
   if key in lookup:raise ValueError('duplicate reference')
   lookup[key]=x
 checks=0
 for row in rows:
  if row['view_type'] not in ('calendar','asset'):continue
  kind='all' if row['view']=='pooled' else ('year' if row['view_type']=='calendar' else 'asset');group='all' if kind=='all' else row['view']
  for j,b in enumerate(BARRIERS):
   x=lookup.pop((kind,group,float(b)))
   if row['scored_n']!=x['n'] or row['positive_labels'][j]!=x['events']:raise ValueError('reference support mismatch')
   if x['n']:
    for actual,expected in [(row['brier'][j],x['brier']),(row['bounded_logloss'][j],x['bounded_logloss']),(row['mean_probability'][j],x['sum_probability']/x['n'])]:
     if not np.isclose(actual,expected,rtol=2e-13,atol=2e-12):raise ValueError('reference metric mismatch')
     checks+=1
 if lookup:raise ValueError('unmatched reference cells')
 return checks

def nulls(x):
 if isinstance(x,float) and not np.isfinite(x):return None
 if isinstance(x,dict):return {k:nulls(v) for k,v in x.items()}
 if isinstance(x,list):return [nulls(v) for v in x]
 return x
def write_json(p,r):Path(p).write_text(json.dumps(nulls(r),separators=(',',':'),allow_nan=False)+'\n')
def execute(r,phase,out,cuts_pin=None):
 if r['status']!='PARENT_FROZEN_'+phase.upper():raise ValueError('request not admitted')
 out=Path(out);out.mkdir(exist_ok=False);start=time.monotonic();stage='admission';read=[];observations=[]
 def observe(enforce=True):
  rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);free=shutil.disk_usage(out).free;elapsed=time.monotonic()-start;size=sum(p.stat().st_size for p in out.iterdir() if p.is_file())
  observations.append(dict(stage=stage,elapsed=elapsed,peak_rss_bytes=rss,free_bytes=free,output_bytes=size))
  if enforce and (elapsed>116 or rss>=1_000_000_000 or free<2_147_483_648 or size>10_000_000):raise RuntimeError('resource cap')
 def timeout(*_):raise TimeoutError('116seconds')
 signal.signal(signal.SIGALRM,timeout);signal.alarm(116)
 try:
  authenticate(r);observe();result={'schema':'r17-conditional-depth-'+phase+'-v1','complete':False,'phase':phase,'input_pins':r['inputs'],'request_pins':r['pins'],'horizons':{},'interpretation':'Descriptive seen-data conditional distributions; no latent truth/causality/CI validation/model selection.'}
  if phase=='analyze':
   check(cuts_pin);validate_cut_pin(r,cuts_pin);cuts=json.loads(Path(cuts_pin['path']).read_text())
   if not cuts['complete'] or cuts['phase']!='cuts' or cuts['input_pins']!=r['inputs'] or cuts['request_pins']!=r['pins']:raise ValueError('cut artifact chain')
   reference=json.loads(Path(r['pins']['reference_result']['path']).read_text());audit=json.loads(Path(r['pins']['reference_audit']['path']).read_text())
   if not audit['accepted'] or audit['result']!=r['pins']['reference_result'] or audit['monitor']!=r['pins']['reference_monitor']:raise ValueError('reference audit chain')
   keys,weights=draw_plan();result['cuts_pin']=cuts_pin;result['resampling']={'unit':'year × epoch-aligned28dayglobalcalendarblock;splitatyearboundary','draws':500,'seed':2026106000,'keys':keys.tolist(),'weights_sha256':hashlib.sha256(weights.tobytes()).hexdigest(),'interpretation':'Conditional resampling sensitivity, not validated confidence intervals.'}
  for h in HORIZONS:
   stage='horizon-'+str(h);observe();d=read_columns(r['inputs'][str(h)]['path'],phase);read.append({'horizon':h,'columns':list(d)});metadata(d,r['sids'])
   result['horizons'][str(h)]=cut_table(d) if phase=='cuts' else analyze_horizon(d,h,cuts['horizons'][str(h)],r['sids'],keys,weights)
   if phase=='analyze':result.setdefault('reference_metric_checks',{})[str(h)]=reconcile(result['horizons'][str(h)],h,reference)
   del d;observe()
  authenticate(r);result['complete']=True;result['columns_read']=read;write_json(out/'result.pending.json',result);observe();os.replace(out/'result.pending.json',out/'result.json');observe()
 except BaseException as ex:
  write_json(out/'failure.json',{'complete':False,'phase':phase,'stage':stage,'error_class':type(ex).__name__,'elapsed':time.monotonic()-start,'columns_read':read});raise
 finally:
  signal.alarm(0);observe(False);write_json(out/'resource-receipt.json',dict(phase=phase,observations=observations,peak_rss_bytes=max(x['peak_rss_bytes'] for x in observations),min_free_bytes=min(x['free_bytes'] for x in observations),elapsed=time.monotonic()-start))
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('phase',choices=('cuts','analyze'));p.add_argument('--request',required=True);p.add_argument('--sha256',required=True);p.add_argument('--out',required=True);p.add_argument('--cuts');p.add_argument('--cuts-sha256');a=p.parse_args();raw=Path(a.request).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=a.sha256:raise ValueError('request pin')
 cp=None
 if a.phase=='analyze':
  if not a.cuts or not a.cuts_sha256:raise ValueError('parent-frozen cuts required')
  cp=pin(a.cuts)
  if cp['sha256']!=a.cuts_sha256:raise ValueError('cut pin')
 execute(json.loads(raw),a.phase,a.out,cp)
if __name__=='__main__':main()
