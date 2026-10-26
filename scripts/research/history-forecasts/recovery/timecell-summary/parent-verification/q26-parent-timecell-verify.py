import json,hashlib,math
from pathlib import Path
from decimal import Decimal,localcontext
E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def near(a,b):
 if a is None or b is None:assert a is b,(a,b)
 else:assert math.isclose(a,float(b),rel_tol=1e-11,abs_tol=1e-13),(a,b)
def dec(x):return Decimal(str(x))
p=E/'r16-timecell-summaries-v1/result.json';v=json.loads(p.read_text());d=json.loads((E/'parent-neural-descriptive-v2.json').read_text())
assert digest(E/'parent-neural-descriptive-v2.json')=='4d97868a55511e536d98dabd1e6ab6370b363c0003341c39cd62a7fc3f4f7703'
assert v['complete'] and len(d['cells'])==len(v['raw_cell_projection'])==240
assert 'evidence_pins' not in v and len(v['artifacts'])==8
cells={tuple(c[k] for k in ('model','hash_half','time_half','horizon_hours','barrier')):c for c in d['cells']}
for c in v['raw_cell_projection']:
 key=tuple(c[k] for k in ('model','hash_half','time_half','horizon_hours','barrier'))
 assert {k:x for k,x in c.items() if k not in ('derived_BSS','BSS_status')}==cells[key]
 near(c['derived_BSS'],1-dec(c['brier_model'])/dec(c['brier_fH']) if c['brier_fH'] else None)
assert len(v['hash_merged_labels'])==120 and len(v['model_time_summaries'])==10
with localcontext() as ctx:
 ctx.prec=60
 for r in v['hash_merged_labels']:
  pair=[cells[(r['model'],h,r['time_half'],r['horizon_hours'],r['barrier'])] for h in (0,1)]
  n=sum(c['n'] for c in pair);y=sum(c['observed_count'] for c in pair)
  sums={name:sum(dec(c['n'])*dec(c[src]) for c in pair) for name,src in [('model_SSE','brier_model'),('fH_SSE','brier_fH'),('model_prediction_sum','predicted_mean'),('fH_prediction_sum','reference_predicted_mean')]}
  assert (r['n'],r['observed_count'])==(n,y)
  for k,s in sums.items():near(r[k],s)
  for name,num in [('brier_model','model_SSE'),('brier_fH','fH_SSE'),('predicted_mean','model_prediction_sum'),('reference_predicted_mean','fH_prediction_sum')]:near(r[name],sums[num]/n)
  near(r['brier_difference'],(sums['model_SSE']-sums['fH_SSE'])/n);near(r['observed_rate'],dec(y)/n)
  near(r['BSS'],1-sums['model_SSE']/sums['fH_SSE'] if sums['fH_SSE'] else None)
  for name,num in [('model_calibration_ratio','model_prediction_sum'),('fH_calibration_ratio','fH_prediction_sum')]:near(r[name],sums[num]/y if y else None)
 for s in v['model_time_summaries']:
  rows=[r for r in v['hash_merged_labels'] if (r['model'],r['time_half'])==(s['model'],s['time_half'])];assert len(rows)==s['labels_retained']==s['defined_BSS_labels']==12
  near(s['mean12_label_BSS'],sum(dec(r['BSS']) for r in rows)/12)
  near(s['exposure_pooled_BSS'],1-sum(dec(r['model_SSE']) for r in rows)/sum(dec(r['fH_SSE']) for r in rows))
  assert s['label_exposures']==sum(r['n'] for r in rows)
  for name,op in [('positive_BSS_labels',lambda x:x>0),('negative_BSS_labels',lambda x:x<0),('zero_BSS_labels',lambda x:x==0)]:assert s[name]==sum(op(r['BSS']) for r in rows)
  mn=min(r['BSS'] for r in rows);assert s['weakest_defined_labels']==[{k:r[k] for k in ('horizon_hours','barrier','BSS')} for r in rows if r['BSS']==mn]
assert v['all_12h_minus10pct_original_cells']==[c for c in v['raw_cell_projection'] if c['horizon_hours']==12 and c['barrier']==-.1]
assert len(v['all_12h_minus10pct_original_cells'])==20
for pin in list(v['artifacts'].values())+[v['request']]:
 f=Path(pin['path']);assert f.stat().st_size==pin['size'] and digest(f)==pin['sha256']
print(json.dumps(dict(complete=True,result_sha256=digest(p),raw_cells=240,merged_labels=120,summaries=10,rare_label_cells=20,method='independent Decimal arithmetic; original descriptor exact projection; final pins verified'),sort_keys=True))
for s in v['model_time_summaries']:
 rare=next(r for r in v['hash_merged_labels'] if r['model']==s['model'] and r['time_half']==s['time_half'] and r['horizon_hours']==12 and r['barrier']==-.1)
 print(s['model'],s['time_half'],'mean12',round(s['mean12_label_BSS'],6),'pooled',round(s['exposure_pooled_BSS'],6),'positive',s['positive_BSS_labels'],'rareBSS',round(rare['BSS'],6),'rareR',round(rare['model_calibration_ratio'],6),'rareRefR',round(rare['fH_calibration_ratio'],6))
