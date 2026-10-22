import ast, importlib.util
from pathlib import Path
import numpy as np
R=Path(__file__).resolve().parents[1]
env={'np':np,'BLOCK_ORIGIN_DAY':17532}
for name, funcs in [('r164_ranges.py',{'wquant','clipped_calibration_range','interval_score','validate_nominal'}),('r164_range_noise_review.py',{'grouping','cal_intervals'})]:
 t=ast.parse((R/name).read_text()); selected=[n for n in t.body if isinstance(n,ast.FunctionDef) and n.name in funcs]
 assert len(selected)==len(funcs)
 exec(compile(ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[])),name,'exec'),env)
s=importlib.util.spec_from_file_location('new',str(Path(__file__).with_name('q26-weighted-causal-primary-pair.py')));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rng=np.random.default_rng(78412)
for case in range(4):
 n=1200;p=rng.choice(np.array([0,.01,.1,.1,.4,.99,1.]),n);y=rng.integers(0,2,n).astype(float)
 sg=rng.integers(0,5,n);day=17532+rng.integers(0,12,n)*182+rng.integers(0,182,n)
 if case==1:p[:]=.2
 if case==2:y[:]=0
 if case==3:p[:]=0
 keys,gid=env['grouping'](p,sg,day);lo,hi=env['cal_intervals'](p,y,gid,keys)
 result=m.cell(p,y,sg,day,horizon=72,level_index=7)
 # noise helper hardcodes .05,.95. Use original derived quantile in reference instead.
 count=np.bincount(gid);sy=np.bincount(gid,weights=y);sp=np.bincount(gid,weights=p)
 low=np.full(n,np.nan);high=low.copy();rho=sy/np.maximum(sp,1e-12)
 for g,b in np.unique(keys[:,1:],axis=0):
  hold=(sg==g)&(((day-17532)//182)==b)
  tr=(keys[:,1]!=g)&(keys[:,2]!=b)&(sp>0)
  if tr.sum()<10:continue
  q=env['wquant'](rho[tr],count[tr].astype(float),[(1-.9)/2,1-(1-.9)/2])
  low[hold],high[hold]=env['clipped_calibration_range'](p[hold],*q)
 for actual,expected in zip(result['private_arrays']['bounds']['Roriginal'],(low,high)):
  np.testing.assert_array_equal(actual,expected)
print('PASS4 independent synthetic original-reference differential cases, including ties/zero ratios/unavailable support.')
