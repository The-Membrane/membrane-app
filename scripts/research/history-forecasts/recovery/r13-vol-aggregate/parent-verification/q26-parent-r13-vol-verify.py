from pathlib import Path
from decimal import Decimal as D,localcontext
import json,math,hashlib
E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence');p=E/'r13-vol-aggregate-review-v1/result.json';v=json.loads(p.read_text());d=json.loads((E/'vol-summary-recovery-v1/dev-r131.json').read_text());assert v['complete'] and len(v['comparisons'])==30
hs={'1h':1,'3h':3,'12h':12,'1d':24,'3d':72};keys={(h,c,w) for h in hs for c in ('pooled','b12','b13a') for w in ('lsQ','lsW')};assert {(r['horizon'],r['cohort'],r['variant']) for r in v['comparisons']}==keys
near=lambda a,b:math.isclose(a,float(b),rel_tol=1e-12,abs_tol=1e-13)
with localcontext() as ctx:
 ctx.prec=60
 for r in v['comparisons']:
  h,c,w=r['horizon'],r['cohort'],r['variant'];orig=d['vol'][h][w] if c=='pooled' else d['vol'][h][c][w]
  assert r['horizon_hours']==hs[h] and r['comparator']=='fH' and r['model']=={'lsQ':'fHQ','lsW':'fHW'}[w]
  for a,b in [('rows','rows'),('weeks','weeks'),('mean_squared_log_sigma_fH','mse_fH'),('mean_squared_log_sigma_model','mse_new'),('median_squared_log_sigma_fH','median_sq_fH'),('median_squared_log_sigma_model','median_sq_new')]:assert r[a]==orig[b]
  assert r['legacy_descriptive_UNVALIDATED']=={f:orig[f] for f in ('mean_diff','se','p_one_sided','weeks_to_80')}
  base=D(str(orig['mse_fH']));new=D(str(orig['mse_new']));assert near(r['derived_mean_loss_difference'],new-base)
  if base:assert near(r['derived_loss_ratio'],new/base) and near(r['derived_fractional_loss_reduction'],1-new/base)
  else:assert r['derived_loss_ratio'] is None and r['derived_fractional_loss_reduction'] is None
 for h in hs:
  for w in ('lsQ','lsW'):
   pool=d['vol'][h][w];parts=[d['vol'][h][c][w] for c in ('b12','b13a')];n=sum(c['rows'] for c in parts);assert pool['rows']==n
   for f in ('mse_fH','mse_new'):assert near(pool[f],sum(D(c['rows'])*D(str(c[f])) for c in parts)/D(n))
for q in list(v['pins'].values())+[v['request']]:
 f=Path(q['path']);assert f.stat().st_size==q['size'] and hashlib.sha256(f.read_bytes()).hexdigest()==q['sha256']
assert (E/'r13-vol-aggregate-parent-stderr-v1.txt').stat().st_size==0
print(json.dumps(dict(complete=True,result_sha256=hashlib.sha256(p.read_bytes()).hexdigest(),result_bytes=p.stat().st_size,comparisons=30,pooled_mean_conservation_pairs=10,arithmetic='60-digit Decimal, exact original projection/legacy fields, all11 final pins; no producer import'),sort_keys=True))
for h in hs:
 for c in ('pooled','b12','b13a'):
  rs=[r for r in v['comparisons'] if r['horizon']==h and r['cohort']==c]
  print(h,c,[(r['model'],r['rows'],round(r['mean_squared_log_sigma_fH'],6),round(r['mean_squared_log_sigma_model'],6),round(r['derived_fractional_loss_reduction']*100,3),round(r['median_squared_log_sigma_fH'],6),round(r['median_squared_log_sigma_model'],6)) for r in rs])
