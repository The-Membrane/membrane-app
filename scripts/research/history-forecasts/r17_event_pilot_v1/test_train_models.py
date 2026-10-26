import copy,datetime as dt,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import train_models as M

def stamp(y,m,d):return int(dt.datetime(y,m,d,tzinfo=dt.timezone.utc).timestamp())
def fixture(n=12,year=2023):
 ts=np.array([stamp(year,1,1)+i*86400 for i in range(n)],dtype=np.int64)
 p=np.tile([.01,.03,.1,.2,.4],(n,1)).astype(np.float64);y=np.zeros((n,5),np.uint8);y[::2,3:]=1;y[::3,2:]=1
 x=np.arange(n*12,dtype=np.float32).reshape(n,12)/100;x[::3,1]=np.nan
 return dict(sid=np.array(['s'+str(i%3) for i in range(n)]),ts=ts,p_fH=p,y=y,label_valid=np.ones(n,bool),Xbase=x,Xshape=np.ones((n,6),np.float32),quarter_cutoff=np.array([M.quarter(t) for t in ts],dtype=np.int64),issue_eligible=np.ones(n,bool),p_fH_valid=np.ones(n,bool),base_margin=M.margin(p),Xbase_missing=np.isnan(x),Xshape_missing=np.zeros((n,6),bool),base_margin_clipped=np.zeros((n,5),bool),future_missing_hours=np.zeros(n,np.int64),legacy_label_valid=np.ones(n,bool),fH_fallback=np.zeros(n,bool))
class TestPilot(unittest.TestCase):
 def test_schema_and_margin(self):
  d=fixture();self.assertEqual(M.validate(d),12);d['base_margin'][0,0]+=.01
  with self.assertRaises(AssertionError):M.validate(d)
 def test_complete_not_legacy(self):
  d=fixture();d['future_missing_hours'][0]=1
  with self.assertRaises(AssertionError):M.validate(d)
  d['label_valid'][0]=False;M.validate(d)
 def test_invalid_labels_not_zero(self):
  d=fixture();d['y'][0]=255;d['label_valid'][0]=False;M.validate(d)
  d['label_valid'][0]=True
  with self.assertRaises(AssertionError):M.validate(d)
 def test_quarter_no_rewrite(self):
  d=fixture();d['quarter_cutoff'][0]+=1
  with self.assertRaises(AssertionError):M.validate(d)
 def test_monotonicity(self):
  d=fixture();d['p_fH'][0,0]=.9;d['base_margin']=M.margin(d['p_fH'])
  with self.assertRaises(AssertionError):M.validate(d)
 def test_cap_before_expansion(self):
  d=fixture(30);ids=M.train_indices(d,24,stamp(2024,1,1),cap=7);self.assertEqual(len(ids),7);self.assertEqual(len(set(ids)),7)
  x,y,m=M.expand(d,ids);self.assertEqual(len(y),35);self.assertEqual(x.shape,(35,13));self.assertEqual(len(m),35);np.testing.assert_array_equal(x[:5,-1],np.log1p(M.BARRIERS))
  reverse=np.arange(30)[::-1];r={k:v[reverse] for k,v in d.items()};ids2=M.train_indices(r,24,stamp(2024,1,1),cap=7)
  self.assertEqual([(str(d['sid'][i]),int(d['ts'][i])) for i in ids],[(str(r['sid'][i]),int(r['ts'][i])) for i in ids2])
 def test_mature_strict_past(self):
  d=fixture(4);start=int(d['ts'][2]);ids=M.train_indices(d,24,start);self.assertTrue((d['ts'][ids]+86400<=start).all());self.assertNotIn(2,ids);self.assertIn(1,ids)
  d['issue_eligible'][1]=False;self.assertNotIn(1,M.train_indices(d,24,start))
 def test_gradient_and_unpenalized_intercept(self):
  rng=np.random.default_rng(17);x=rng.normal(size=(31,4));y=rng.integers(0,2,31);m=rng.normal(size=31);b=rng.normal(size=5);loss,g=M.objective(b,x,y,m);num=[]
  for j in range(5):
   step=np.zeros(5);step[j]=1e-6;num.append((M.objective(b+step,x,y,m)[0]-M.objective(b-step,x,y,m)[0])/2e-6)
  np.testing.assert_allclose(g,num,atol=1e-8,rtol=1e-6);self.assertTrue(np.isfinite(loss))
 def test_training_only_imputation(self):
  train=np.array([[1,np.nan],[3,np.nan]],float);med=M.impute_fit(train);np.testing.assert_array_equal(med,[2,0]);eval=np.array([[100,np.nan]]);np.testing.assert_array_equal(M.impute(eval,med),[[100,0,0,1]])
 def test_pav_direction_and_brier(self):
  rng=np.random.default_rng(33);p=rng.random((100,5));y=np.sort(rng.integers(0,2,(100,5)),axis=1);q=M.pav(p)
  self.assertTrue((np.diff(q,axis=1)>=-1e-15).all());self.assertTrue((((q-y)**2).sum(axis=1)<=((p-y)**2).sum(axis=1)+1e-12).all());np.testing.assert_array_equal(M.pav(np.array([[.1,.2,.3,.4,.5]])),[[.1,.2,.3,.4,.5]])
 def test_metrics_zeros_and_bounds(self):
  r=M.metrics(np.zeros(3),np.zeros(3),np.zeros(3),np.array(['a']*3),np.arange(3));self.assertIsNone(r['bss']);self.assertIsNone(r['observed_over_expected']);self.assertIsNone(r['expected_over_observed']);self.assertTrue(np.isfinite(r['bounded_logloss']));self.assertEqual(r['logloss_clipped_predictions'],3)
 def test_fallback_retains_labels_and_empty_quarters(self):
  d=fixture(12,2024);d['label_valid'][0]=False;d['legacy_label_valid'][0]=True
  with tempfile.TemporaryDirectory() as t:
   with patch.object(M,'bounded_fit',side_effect=AssertionError('must not fit')):r=M.run_horizon(d,24,Path(t)/'p.npz')
   self.assertEqual(len(r['folds']),8);self.assertEqual(r['scored_common_origins'],11);self.assertEqual(r['evaluation_legacy_label_origins'],12)
   with np.load(Path(t)/'p.npz',allow_pickle=False) as a:np.testing.assert_array_equal(a['linear_raw'],d['p_fH'])
   self.assertEqual(len(r['scores']),6*8*5) # all+two years+three assets
 def test_cross_horizon_join_and_violation(self):
  with tempfile.TemporaryDirectory() as t:
   a=Path(t)/'a.npz';b=Path(t)/'b.npz';np.savez(a,sid=np.array(['a','b']),ts=np.array([1,2]),y=np.zeros((2,5)),label_valid=np.ones(2,bool),baseline_raw=np.full((2,5),.8));np.savez(b,sid=np.array(['b','a']),ts=np.array([2,1]),y=np.zeros((2,5)),label_valid=np.ones(2,bool),baseline_raw=np.full((2,5),.2));r=M.cross_horizon({6:a,24:b});self.assertEqual(len(r),5);self.assertTrue(all(x['violations']==2 for x in r))
 def test_missing_label_known_bounds(self):
  y=np.array([1,255,255],np.uint8);p=np.array([.8,.9,.1]);b=np.array([.4,.2,.8]);valid=np.array([1,0,0],bool);r=M.missing_bounds(y,p,b,valid)
  candidates=[]
  for a in [0,1]:
   for c in [0,1]:
    truth=np.array([1,a,c]);candidates.append(float(np.mean((p-truth)**2-(b-truth)**2)))
  self.assertAlmostEqual(r['mean_d_lower'],min(candidates));self.assertAlmostEqual(r['mean_d_upper'],max(candidates));self.assertEqual(r['unknown_rows'],2)
  zero=M.missing_bounds(y,b,b,valid);self.assertEqual(zero['mean_d_lower'],0);self.assertEqual(zero['mean_d_upper'],0)
 def test_linear_actual_synthetic_fit(self):
  rng=np.random.default_rng(170);x=rng.normal(size=(150,4));y=rng.integers(0,2,150);m=np.full(150,-.7);p,details=M.fit_predict('linear',x,y,m,x[:8],m[:8]);self.assertTrue(details['success']);self.assertEqual(p.shape,(8,))
 def test_xgb_synthetic_prediction_margin(self):
  x=np.zeros((100,3));y=np.tile([0,1],50);m=np.zeros(100);xe=np.zeros((4,3));me=np.array([-2.,-1.,1.,2.]);p,r=M.fit_predict('xgb_base',x,y,m,xe,me)
  self.assertTrue(r['base_margin_at_train_and_predict']);self.assertTrue((np.diff(p)>0).all());np.testing.assert_allclose(p,1/(1+np.exp(-me)),rtol=2e-6)
 def test_later_failure_preserves_first_checkpoint(self):
  import json
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);inputs=root/'inputs';inputs.mkdir();first=inputs/'horizon-6.npz';np.savez(first,**fixture(12,2024));request={'input_sha256':{'6':M.sha(first)}}
   with self.assertRaises(FileNotFoundError):M.run_admitted(request,inputs,root/'output')
   progress=json.loads((root/'output/progress.json').read_text());failure=json.loads((root/'output/failure.json').read_text());self.assertFalse(progress['complete']);self.assertEqual(progress['completed_horizons'],[6]);self.assertEqual(progress['horizons'][0]['horizon_hours'],6);self.assertTrue(progress['horizons'][0]['scores']);self.assertEqual(failure['horizon_hours'],12);self.assertEqual(failure['stage'],'input_hash');self.assertTrue((root/'output/predictions-6.npz').exists());self.assertFalse((root/'output/result.json').exists())
 def test_atomic_json_replaces_and_no_temporary(self):
  import json
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'progress.json';M.atomic_json(p,{'done':[6]});M.atomic_json(p,{'done':[6,12]});self.assertEqual(json.loads(p.read_text()),{'done':[6,12]});self.assertFalse(Path(str(p)+'.tmp').exists())
 def test_rss_probe_fail_closed(self):
  from types import SimpleNamespace
  with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='10 100\n20 200\n')) as run:
   self.assertEqual(M.sampled_rss(10,20,.3),300*1024);self.assertEqual(run.call_args.kwargs['timeout'],.3)
  for code,output,error in [(1,'',RuntimeError),(0,'junk',RuntimeError),(0,'10 100\n',LookupError),(0,'20 200\n',RuntimeError),(0,'10 100\n20 0\n',RuntimeError)]:
   with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=output)):
    with self.assertRaises(error):M.sampled_rss(10,20,.2)
 def test_child_timeout_is_failure(self):
  x=np.zeros((100,3));y=np.tile([0,1],50)
  with self.assertRaises(TimeoutError):M.bounded_fit('xgb_shape',x,y,np.zeros(100),x[:2],np.array([-1.,1.]),seconds=0)
 def test_synthetic_child_execution(self):
  x=np.zeros((100,3));y=np.tile([0,1],50);p,r=M.bounded_fit('xgb_shape',x,y,np.zeros(100),x[:2],np.array([-1.,1.]),seconds=30);self.assertEqual(p.shape,(2,));self.assertTrue(r['elapsed_seconds']<30)
if __name__=='__main__':unittest.main()
