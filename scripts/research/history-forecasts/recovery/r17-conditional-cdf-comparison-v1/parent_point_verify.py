"""Parent direct primary-horizon replay; imports no subject helper."""
import json,hashlib,signal,time,shutil,resource,sys
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
ROOT=Path(__file__).resolve().parent
started=time.monotonic();signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(TimeoutError('parent60s')));signal.alarm(60)
assert shutil.disk_usage(ROOT).free>=2147483648
rp=ROOT/'result-v1/result.json';assert hashlib.sha256(rp.read_bytes()).hexdigest()=='d55a37fe60f5aa7d31d25a631fd664acabb80ce6803cc577e29dbc18fc6d7cb7';result=json.loads(rp.read_text())
r=json.loads((ROOT/'request.parent.json').read_text());base=json.loads(Path(r['base_request_pin']['path']).read_text());cuts=json.loads(Path(r['cuts_pin']['path']).read_text());p=Path(base['inputs']['24']['path']);assert hashlib.sha256(p.read_bytes()).hexdigest()==base['inputs']['24']['sha256']
with np.load(p,allow_pickle=False) as f:d={k:f[k] for k in ['sid','ts','issue_eligible','p_fH_valid','label_valid','fH_fallback','Xbase','Xshape','future_log_min','p_fH','y','quarter_cutoff']}
ell=np.where(d['fH_fallback'],d['Xbase'][:,1],d['Xbase'][:,0]).astype(float)
with np.errstate(over='ignore',invalid='ignore',divide='ignore'):scale=np.exp(ell)*np.sqrt(24/8760);z=d['future_log_min']/scale
state=np.where(np.isfinite(d['Xshape'][:,3]),(d['Xshape'][:,3]>cuts['horizons']['24']['downside_imbalance_D']['cut']).astype(int),-1)
validscale=np.isfinite(scale)&(scale>0);trainbase=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&validscale&np.isfinite(z)&(state>=0)
BARS=np.array([-.4,-.2,-.1,-.05,-.02]);pred=np.repeat(d['p_fH'][None,:,:],4,axis=0);folds=0
quarters=[int(datetime(y,m,1,tzinfo=timezone.utc).timestamp()) for y in [2024,2025] for m in [1,4,7,10]]+[1767225600]
for sid in base['sids']:
 for q,qe in zip(quarters[:-1],quarters[1:]):
  te=np.flatnonzero((d['sid']==sid)&d['issue_eligible']&(d['ts']>=q)&(d['ts']<qe));tr=np.flatnonzero((d['sid']==sid)&trainbase&(d['ts']>=1640995200)&(d['ts']+24*3600<=q))
  if not len(te):continue
  folds+=1;assert np.all(d['quarter_cutoff'][te]==q)
  with np.errstate(over='ignore',divide='ignore',invalid='ignore'):query=np.log1p(BARS)[None,:]/scale[te,None]
  okay=np.isfinite(query).all(1)&validscale[te]
  if not len(tr):continue
  pred[1,te[okay]]=(z[tr,None,None]<=query[None,okay,:]).mean(0)
  pred[2,te]=pred[1,te];pred[3,te]=pred[1,te]
  groups=[tr[state[tr]==g] for g in [0,1]]
  if any(not len(g) for g in groups):continue
  med=np.array([np.median(np.abs(z[g])) for g in groups])
  if not np.all(np.isfinite(med)&(med>0)):continue
  with np.errstate(over='ignore',invalid='ignore',divide='ignore'):w=z[tr]/med[state[tr]]
  if not np.isfinite(w).all():continue
  for g in [0,1]:
   at=np.flatnonzero(okay&(state[te]==g))
   with np.errstate(over='ignore',invalid='ignore',divide='ignore'):t=query[at]/med[g]
   good=np.isfinite(t).all(1);at=at[good];t=t[good]
   pred[2,te[at]]=(w[:,None,None]<=t[None,:,:]).mean(0)
   pred[3,te[at]]=(z[groups[g],None,None]<=query[None,at,:]).mean(0)
mask=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']>=1704067200)&(d['ts']<1767225600);checks=0;report=[]
for yr,ym in [('pooled',mask),('2024',mask&(d['ts']<1735689600)),('2025',mask&(d['ts']>=1735689600))]:
 row=next(x for x in result['horizons']['24']['point_views'] if x['view_type']=='calendar' and x['view']==yr);y=d['y'][ym].astype(float);assert row['scored_n']==int(ym.sum())
 for j,arm in enumerate(['raw_fH','A_pooled_Z','B_pooled_W','C_state_Z']):
  pp=pred[j,ym];pc=np.clip(pp,1e-6,1-1e-6);brier=((pp-y)**2).mean(0);ll=(-y*np.log(pc)-(1-y)*np.log1p(-pc)).mean(0)
  for k,v in [('brier',brier),('bounded_logloss',ll),('mean_probability',pp.mean(0))]:np.testing.assert_allclose(v,row['arms'][arm][k],atol=2e-12,rtol=2e-13);checks+=5
 diff=((pred[3,ym,2]-y[:,2])**2-(pred[2,ym,2]-y[:,2])**2).mean();assert abs(diff-row['paired_brier_difference']['C_minus_B'][2])<2e-12;report.append({'year':yr,'n':int(ym.sum()),'C_minus_B':float(diff)})
rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);assert rss<1000000000 and shutil.disk_usage(ROOT).free>=2147483648
out=dict(passed=True,scope='Direct boolean-CDF primaryH24 replay, all5barriers/4mainarms/3calendarviews; no subject imports or new model selection.',folds=folds,metric_values_checked=checks,primary=report,elapsed=time.monotonic()-started,peak_rss_bytes=rss,result_sha256=hashlib.sha256(rp.read_bytes()).hexdigest())
(ROOT/'parent-point-verification.json').write_text(json.dumps(out,indent=2)+'\n');signal.alarm(0);print(json.dumps(out))
