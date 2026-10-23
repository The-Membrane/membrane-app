"""Generated-only original-source parity and strict clock tests."""
import importlib.util,unittest,copy
from pathlib import Path
import numpy as np

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
C=load('daily',Path(__file__).with_name('q26-daily-clock-core.py'))
R=load('original',Path(__file__).resolve().parents[1]/'weighted-causal-primary-pair'/'q26-weighted-causal-primary-pair.py')
def fixture(H=24,k=5):
 vals=[(g,b,t,j) for g in range(5) for b in range(5) for t in (0,1,3,90,180,181) for j in range(5)]
 g,b,t,j=np.array(vals).T;p=np.array([.0,1e-15,.03,.15,.6])[j];day=C.ORIGIN+182*b+t;y=((g+b+t+j)%4==0).astype(np.uint8)
 old=R.cell(p,y,g,day,horizon=H,level_index=k);z=old['private_arrays'];a={f:z[f] for f in ('p','y','sg','day','block','past_bins','clock_target')};a.update(F_lower=z['bounds']['F'][0],F_upper=z['bounds']['F'][1],F_eligible=z['arm_eligible']['F'])
 return a,old['folds']
class Tests(unittest.TestCase):
 def test_daily_slow_original_parity_both_cells(self):
  for H,k in C.CELLS:
   a,folds=fixture(H,k);r=C.cell(R,a,folds,horizon=H,level_index=k);self.assertTrue(r['baseline_reconstructed']);self.assertTrue(r['primary_comparison_admissible'])
   lp=np.log(np.clip(a['p'],1e-5,1-1e-5));expected=np.full(len(lp),np.nan)
   for f in folds:
    if f['edges'] is None:continue
    bins=np.searchsorted(f['edges'],lp);hold=(a['sg']==f['sg'])&(a['block']==f['block'])
    for d in np.unique(a['day'][hold]):
     tr=(a['sg']!=f['sg'])&(a['day']+H//24<d);rat,w=R._ratios(a['p'],a['y'],a['sg'],a['block'],bins,tr)
     if len(rat)>=10:
      q=R.wquant(rat,w,[(1-.9)/2,1-(1-.9)/2]);use=hold&(a['day']==d);expected[use]=np.clip(a['p'][use]*q[1],0,1)
   np.testing.assert_array_equal(r['private_arrays']['DAILY_upper'],expected)
   for v in r['views']:
    for arm in ('F','DAILY'):
     comp=v['components'][arm];metric=v['arms'][arm]
     if comp['groups']:self.assertAlmostEqual(comp['total_pp'],metric['interval_score_pp'],places=11)
 def test_fast_floor_ties_and_empty(self):
  p=np.array([0.,1e-15,1e-15,.1,.1]);y=np.array([1,0,1,0,1.],float);sg=np.array([0,1,1,2,2]);b=np.array([0,0,0,1,1]);bins=np.zeros(5,int);gid,n=C.prepared_counts(p,y,sg,b,bins)
  for tr in (np.ones(5,bool),np.zeros(5,bool),np.array([1,0,1,1,0],bool)):
   x,w=C.fast_ratios(p,y,gid,n,tr);u,v=R._ratios(p,y,sg,b,bins,tr);np.testing.assert_array_equal(x,u);np.testing.assert_array_equal(w,v)
  self.assertEqual(R.wquant(np.array([1.,1.,2.]),np.array([1.,2.,1.]),[.05,.95])[0],1.)
 def test_clock_strict_maturity_and_exclusion(self):
  a,f=fixture(72,7);r=C.cell(R,a,f,horizon=72,level_index=7)
  for fold in r['folds']:
   for d in fold['days']:
    exact=((a['sg']!=fold['sg'])&(a['day']+3<d['day'])).sum();self.assertEqual(d['training_rows'],exact)
    boundary=(a['sg']!=fold['sg'])&(a['day']+3==d['day']);self.assertTrue(not np.any(boundary&((a['sg']!=fold['sg'])&(a['day']+3<d['day']))))
 def test_no_eligible_retains_unavailability(self):
  a={ 'p':np.array([.2,.3]),'y':np.array([0,1]),'sg':np.array([0,1]),'day':np.array([C.ORIGIN,C.ORIGIN])}
  old=R.cell(**a,horizon=24,level_index=5);z=old['private_arrays'];a.update({k:z[k] for k in ('block','past_bins','clock_target')});a.update(F_lower=z['bounds']['F'][0],F_upper=z['bounds']['F'][1],F_eligible=z['arm_eligible']['F'])
  out=C.cell(R,a,old['folds'],horizon=24,level_index=5);self.assertFalse(out['primary_comparison_admissible']);self.assertIsNone(out['views'][0]['primary_delta_pp'])
 def test_tamper_schema_and_baseline_refuse(self):
  a,f=fixture()
  mutations=[('block',lambda x:x+1),('past_bins',lambda x:x+1),('clock_target',lambda x:~x),('F_eligible',lambda x:~x),('p',lambda x:np.full_like(x,np.nan)),('y',lambda x:np.full_like(x,2))]
  for k,fn in mutations:
   bad=dict(a);bad[k]=fn(a[k])
   with self.assertRaises(ValueError):C.cell(R,bad,f,horizon=24,level_index=5)
  bad=dict(a);bad['F_lower']=a['F_lower'].copy();i=np.flatnonzero(a['F_eligible'])[0];bad['F_lower'][i]+=.01
  with self.assertRaisesRegex(ValueError,'endpoint'):C.cell(R,bad,f,horizon=24,level_index=5)
  edge_tamper=copy.deepcopy(f)
  first=next(x for x in edge_tamper if x['edges'] is not None);first['edges'][0]-=1e-10
  for ff in (edge_tamper,f[:-1],f+[f[0]], [dict(x,edges=[1.,0.]) for x in f]):
   with self.assertRaises(ValueError):C.cell(R,a,ff,horizon=24,level_index=5)
 def test_fixed_pair_inventory(self):
  with self.assertRaises(ValueError):C.primary_pair(R,{})
if __name__=='__main__':unittest.main()
