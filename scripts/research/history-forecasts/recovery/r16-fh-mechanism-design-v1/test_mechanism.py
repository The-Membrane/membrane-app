"""Synthetic fixture seeds only; no registered world or full stage execution."""
import copy,json,unittest,tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
import mechanism as M
class Units(unittest.TestCase):
 def spec(self):
  s=json.loads((M.HERE/'spec.json').read_text());s['world_seeds']=[991401+j for j in range(64)];s['bootstrap_seeds']=[992401+j for j in range(64)];return s
 def test_truth_and_correct_pooled_mixture(self):
  s=self.spec();a,p=M.truths(s,False);b,q=M.truths(s,True);t=-np.log1p(s['levels'])[None,:]/(np.exp(M.H@np.array(s['beta']))[:,None]*.5)
  np.testing.assert_allclose(a,np.exp(-t),rtol=1e-15);np.testing.assert_array_equal(a,p)
  np.testing.assert_allclose(b[[1,3]],(.5*np.exp(-t/.25)+.5*np.exp(-t/1.75))[[1,3]],rtol=1e-15)
  np.testing.assert_allclose(q,.5*np.exp(-t)+.25*np.exp(-t/.25)+.25*np.exp(-t/1.75),rtol=1e-15)
  self.assertGreater(q[0,2]-b[0,2],.009);self.assertLess(q[1,2]-b[1,2],-.01)
 def test_literal_pairing_noise_and_shape(self):
  s=self.spec();z,e,u,w=M.innovations(s,0);saved=[v.copy() for v in [z,e,u,w]];ps={c:M.build(s,z,e,u,c)[0] for c in M.CONDITIONS}
  np.testing.assert_array_equal(ps['common_zero'].P.depth,ps['common_noisy'].P.depth)
  np.testing.assert_array_equal(ps['heterogeneous_zero'].P.depth,ps['heterogeneous_noisy'].P.depth)
  for c in ['common_zero','heterogeneous_zero']:np.testing.assert_array_equal(ps[c].lfut,ps['common_zero'].lfut)
  self.assertGreater(np.max(abs(ps['common_noisy'].lfut-ps['common_zero'].lfut)),0)
  ix=np.where(ps['common_zero'].okH)[0];ratio=ps['heterogeneous_zero'].P.depth[ix]/ps['common_zero'].P.depth[ix]
  np.testing.assert_array_equal(ratio[np.arange(2048)%4==0],np.ones(512))
  np.testing.assert_allclose(ratio[np.isin(np.arange(2048)%4,[1,3])],np.where(u.ravel()[np.isin(np.arange(2048)%4,[1,3])]<.5,.25,1.75),rtol=1e-15)
  for a,b in zip([z,e,u,w],saved):np.testing.assert_array_equal(a,b)
 def test_cutoff_grid_and_known_zero_noise_coefficients(self):
  s=self.spec();z,e,u,w=M.innovations(s,0);p,qs,te=M.build(s,z,e,u,'common_zero');rows=np.where(p.okH)[0]
  self.assertEqual(len(rows),2048);self.assertEqual(rows[-1],qs-24);self.assertTrue(np.all(te>qs));self.assertEqual(np.unique(rows//720).size,32)
  np.testing.assert_allclose(np.linalg.lstsq(p.X[rows],p.lfut[rows],rcond=None)[0],s['beta'],rtol=1e-14,atol=1e-14)
 def test_weight_prefix_and_distinct_fixture_seed(self):
  s=self.spec();*_,w=M.innovations(s,0);a,b=M.Weights(w[:20]),M.Weights(w)
  for _ in range(20):np.testing.assert_array_equal(a.multinomial(32,np.full(32,1/32)),b.multinomial(32,np.full(32,1/32)))
  self.assertTrue(np.all(w.sum(1)==32));self.assertLess(s['world_seeds'][0],2026104000)
 def test_original_subject_point_matches_direct_ecdf_fixture(self):
  s=self.spec();subject=M.authenticate(s);z,e,u,w=M.innovations(s,0);p,qs,te=M.build(s,z,e,u,'heterogeneous_zero');r=subject(p,qs,te,M.Weights(np.ones((1,32),int)),B=1)[0]
  rows=np.where(p.okH)[0];beta=np.array(s['beta']);standard=p.P.depth[rows]/(np.exp(p.X[rows]@beta)*.5);threshold=p.P.thresholds(np.exp(M.H@beta));expected=np.array([[np.mean(standard<=t) for t in row] for row in threshold]);np.testing.assert_array_equal(r,expected)
 def test_packaging_nan_and_no_mutation(self):
  a=np.array([[[.8,.9,.1]],[[.6,np.nan,.3]],[[.9,.4,.2]]]);old=a.copy();q,sd=M.package(a);b=np.minimum.accumulate(a,axis=-1)
  np.testing.assert_array_equal(q,np.nanquantile(b,[.05,.25,.5,.75,.95],axis=0));np.testing.assert_array_equal(sd,np.nanstd(b,axis=0));np.testing.assert_array_equal(a,old)
 def test_world_unit_pair_contrasts_and_unavailable_interval(self):
  records=[]
  for j in range(2):
   record={}
   for i,c in enumerate(M.CONDITIONS):
    point=np.full((4,3),.2+.01*i+.02*j);q=np.stack([np.zeros((4,3)),np.zeros((4,3)),point,point,np.ones((4,3))]);q[:,0,0]=np.nan if j==0 else q[:,0,0]
    record[c]=dict(point=point,truth=np.full((4,3),.2),q20=q,q200=q.copy(),raw20=np.tile(point,(20,1,1)),raw200=np.tile(point,(200,1,1)))
   records.append(record)
  r=M.summarize(records);v=r['conditions']['common_zero']['20'];self.assertEqual(v['inclusion']['mean'][0][0],.5);self.assertAlmostEqual(v['inclusion']['world_se'][0][0],.5)
  self.assertAlmostEqual(r['paired_contrasts']['noise_common']['20']['point_error']['mean'][1][1],.01)
  self.assertAlmostEqual(r['paired_contrasts']['interaction']['20']['point_error']['mean'][1][1],0)
 def test_failed_stage_retains_current_realization(self):
  s=self.spec()
  def failure(*args,**kwargs):raise RuntimeError('fixture injected failure')
  with tempfile.TemporaryDirectory() as root,patch.object(M,'HERE',Path(root)),patch.object(M,'authenticate',return_value=failure):
   with self.assertRaisesRegex(RuntimeError,'fixture injected'):M.run(s,8,'fixture-hash')
   out=Path(root)/'worlds-stage-8-fixture-hash';r=json.loads((out/'manifest.json').read_text())
   self.assertEqual(r['status'],'failed_partial');self.assertEqual(r['completed_worlds'],0);self.assertEqual(r['current_world'],0);self.assertEqual(r['phase'],'common_zero')
   self.assertTrue((out/'world-00-inputs.npz').exists());self.assertTrue((out/'partial-summary.json').exists())
 def test_dependency_tamper_refuses(self):
  s=self.spec();s['dependency_pins'][0]['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'dependency pin'):M.authenticate(s)
if __name__=='__main__':unittest.main(verbosity=2)
