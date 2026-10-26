"""Fixed ALL30 archived volatility comparisons; source-declared JSON projection only."""
import argparse,ast,hashlib,json,math,platform,resource,shutil,sys,time
from pathlib import Path
SCHEMA='codex-r13-vol-aggregate-review-v1'
INPUT_SHA='5d8bf5c9c57e719d5e93f6de0822851ffea27bdccfd426c955e5ed58bf7a5305'
POLICY=dict(rss_bytes=1000000000,wall_seconds=60,disk_reserve_bytes=2000000000,output_bytes=1000000)
FIELDS={'rows','weeks','mse_fH','mse_new','mean_diff','se','p_one_sided','median_sq_fH','median_sq_new','weeks_to_80'}
PINS={'summary','sidecar','recovery_acceptance','recal_source','devcheck_source','tail_source','vol_source','runtime_proof','implementation','tests'}
LIMITS='Archived seen-data aggregate squared error of natural-log annualized future realized-volatility proxy, not QLIKE, latent-volatility calibration, a price band, touch improvement or a fresh test. No rows/predictions/NPZ/fits. fH is the comparator; no EWMA/persistence standalone-skill comparison is available here. Legacy SE/p/power are archived descriptive UNVALIDATED statistics, not new gates. Median losses cannot be pooled from cohort medians. Source byte identity does not establish origin availability/split integrity/strict-forward validity. Existing reserve/LP/O14/NOT RUN holds remain.'


def need(ok,message):
 if not ok:raise ValueError(message)
def pin(p):
 p=Path(p).resolve();b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform())
def literals(path,name):
 for n in ast.parse(Path(path).read_text()).body:
  if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets):return ast.literal_eval(n.value)
 raise ValueError('source constant missing')
def source_horizons(pins):
 hs=literals(pins['recal_source']['path'],'HS');tl=literals(pins['tail_source']['path'],'TL')
 need(hs==(1,3,12,24,72),'source horizon closure');return {tl[h]:h for h in hs}
def close(a,b):return abs(a-b)<=64*sys.float_info.epsilon*max(1,abs(a),abs(b))
def finite(x):return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)
def project(data,horizons):
 need(data.get('schema')=='q26-r13.1-dev/1' and set(data['vol'])==set(horizons),'horizon/schema closure');rows=[]
 for key,h in horizons.items():
  root=data['vol'][key];need(set(root)=={'lsQ','lsW','b12','b13a'},'cohort/variant closure')
  for cohort in ('pooled','b12','b13a'):
   block={k:root[k] for k in ('lsQ','lsW')} if cohort=='pooled' else root[cohort]
   need(set(block)=={'lsQ','lsW'},'variant closure')
   for variant,model in (('lsQ','fHQ'),('lsW','fHW')):
    x=block[variant];need(set(x)==FIELDS,'volatility field closure')
    need(type(x['rows']) is int and type(x['weeks']) is int and 0<x['weeks']<=x['rows'],'positive counts')
    for f in ('mse_fH','mse_new','median_sq_fH','median_sq_new'):need(finite(x[f]) and x[f]>=0,'nonnegative finite loss')
    need(finite(x['mean_diff']) and close(x['mean_diff'],x['mse_new']-x['mse_fH']),'mean-loss difference mismatch')
    for f in ('se','p_one_sided','weeks_to_80'):need(x[f] is None or finite(x[f]),'legacy finite/null field')
    need(x['se'] is None or x['se']>0,'legacy SE sign');need(x['p_one_sided'] is None or 0<=x['p_one_sided']<=1,'legacy p bound');need(x['weeks_to_80'] is None or x['weeks_to_80']>0,'legacy power count')
    base=x['mse_fH'];ratio=x['mse_new']/base if base>0 else None
    rows.append(dict(horizon=key,horizon_hours=h,cohort=cohort,variant=variant,model=model,comparator='fH',rows=x['rows'],weeks=x['weeks'],mean_squared_log_sigma_fH=base,mean_squared_log_sigma_model=x['mse_new'],median_squared_log_sigma_fH=x['median_sq_fH'],median_squared_log_sigma_model=x['median_sq_new'],derived_mean_loss_difference=x['mse_new']-base,derived_loss_ratio=ratio,derived_fractional_loss_reduction=1-ratio if ratio is not None else None,ratio_status='defined' if ratio is not None else 'zero_reference',legacy_descriptive_UNVALIDATED={f:x[f] for f in ('mean_diff','se','p_one_sided','weeks_to_80')}))
  for variant in ('lsQ','lsW'):
   pool=root[variant];parts=[root[c][variant] for c in ('b12','b13a')];n=sum(p['rows'] for p in parts)
   need(pool['rows']==n and max(p['weeks'] for p in parts)<=pool['weeks']<=sum(p['weeks'] for p in parts),'pooled support conservation')
   for f in ('mse_fH','mse_new'):need(close(pool[f],math.fsum(p['rows']*p[f] for p in parts)/n),'pooled mean-loss conservation')
 need(len(rows)==30,'comparison closure');return rows

def authenticate(request,digest):
 need(pin(request)['sha256']==digest,'request changed');r=json.loads(Path(request).read_text());need(r['admission_status']=='parent_accepted','DRAFT not admitted')
 need(r['schema']==SCHEMA and r['policy']==POLICY and set(r['pins'])==PINS and r['runtime']==runtime() and 'torch' not in sys.modules,'protocol/runtime changed')
 for p in r['pins'].values():need(pin(p['path'])==p,'artifact changed')
 need(r['pins']['summary']['sha256']==INPUT_SHA and r['pins']['implementation']['path']==str(Path(__file__).resolve()),'summary/source identity')
 need(Path(r['pins']['sidecar']['path']).read_text().strip()==INPUT_SHA,'sidecar mismatch')
 a=json.loads(Path(r['pins']['recovery_acceptance']['path']).read_text());need(a['complete'] is True and a['receipt']['sidecar_verifies_json_sha256'] is True and any(p['name']=='dev-r131.json' and p['sha256']==INPUT_SHA and p['size']==r['pins']['summary']['size'] for p in a['receipt']['files']),'recovery not accepted')
 horizons=source_horizons(r['pins']);need(r['horizons']==horizons and r['cohorts']==['pooled','b12','b13a'] and r['variants']==['lsQ','lsW'],'fixed scope changed');return r,horizons

def execute(request,digest,out):
 r,hs=authenticate(request,digest);need(str(out.resolve())==r['output'] and not out.exists(),'fresh exact output');out.mkdir();start=time.monotonic();stage='input'
 try:
  data=json.loads(Path(r['pins']['summary']['path']).read_text());stage='projection';rows=project(data,hs)
  for p in r['pins'].values():need(pin(p['path'])==p,'artifact drift')
  need(pin(request)['sha256']==digest and runtime()==r['runtime'] and 'torch' not in sys.modules,'final request/runtime drift')
  rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);need(rss<=POLICY['rss_bytes'] and time.monotonic()-start<=60 and shutil.disk_usage(out).free>=2000000000,'resource policy')
  value=dict(schema=SCHEMA,complete=True,comparisons=rows,request=pin(request),pins=r['pins'],runtime=runtime(),target='Squared natural-log error of annualized future realized-volatility proxy; hourly check rows; variant-specific common-finite paired support.',legacy_status='UNVALIDATED archived descriptive SE/p/power only; no new test or eligibility gate',limitations=LIMITS,elapsed_seconds=time.monotonic()-start,peak_RSS_bytes=rss)
  b=(json.dumps(value,separators=(',',':'),allow_nan=False)+'\n').encode();need(len(b)<=POLICY['output_bytes'],'output cap')
  with (out/'result.json').open('xb') as f:f.write(b)
 except BaseException as e:
  with (out/'failure.json').open('x') as f:json.dump(dict(complete=False,stage=stage,exception_class=type(e).__name__,elapsed_seconds=time.monotonic()-start),f)
  raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True,type=Path);p.add_argument('--sha256',required=True);p.add_argument('--out',required=True,type=Path);a=p.parse_args();execute(a.request,a.sha256,a.out)
