import hashlib,importlib.util,json,math,tempfile,unittest
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('component_audit',HERE/'audit_r164_power_components.py');A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
class Contracts(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='r164-component-test-',dir=HERE);self.w=Path(self.tmp.name);self.o=A.load_original()
 def tearDown(self):self.tmp.cleanup()
 def test_fixed_grid_99_and_declared_null_boundaries(self):
  cases=A.grid();self.assertEqual(len(cases),99);self.assertEqual(len({tuple(x.values()) for x in cases}),99)
  for x in cases:
   truth,pos=A.coverage_class(x['coverage_mean']);self.assertEqual(truth,'alternative' if x['coverage_mean']==.90 else 'null')
   self.assertEqual(pos,'boundary' if x['coverage_mean'] in (.85,.95) else 'interior' if x['coverage_mean']==.90 else 'outside')
   c,s=x['coverage_mean'],x['known_SE'];self.assertTrue(0<=c-3.29*s/2<c+3.29*s/2<=1)
 def test_actual_original_zeroSE_and_binary_boundary_edge(self):
  for c in [.85,.90,.95]:
   case=dict(case_id=0,coverage_mean=c,known_SE=0.,width_median=10.,rho=0.);out=A.original_b(self.o,case,self.w)
   self.assertEqual(out['tost_power'],float(abs(c-.90)<.05))
  self.assertEqual(self.o.tost_power(.90,0.,.90,.05),1.)
  self.assertEqual(self.o.tost_power(.85,0.,.90,.05),0.)
  self.assertEqual(self.o.tost_power(.95,0.,.90,.05),1.) # original binary-float edge, not ideal null classification
 def test_actual_original_width_inclusive_and_stochastic_reference(self):
  case=dict(case_id=0,coverage_mean=.90,known_SE=.01,width_median=10.,rho=0.);v=A.original_b(self.o,case,self.w);r=A.law(.90,.01,10.,0.)
  self.assertEqual(v['width_leg'],1.);self.assertEqual(r['width'],.5);self.assertGreater(v['joint'],r['joint'])
 def test_positive_width_required(self):
  for w in [0.,-1.]:
   with self.assertRaises(ValueError):A.law(.90,.01,w,0.)
 def test_empty_TOST_alternative_control(self):
  x=dict(case_id=0,coverage_mean=.90,known_SE=.04,width_median=8.,rho=.8);v=A.evaluate_case(self.o,x,self.w,n=64)
  self.assertEqual(v['coverage_truth'],'alternative');self.assertEqual(v['analytic']['coverage'],0.);self.assertEqual(v['analytic']['joint'],0.);self.assertEqual(v['original_part_b']['tost_power'],0.);self.assertEqual(v['monte_carlo']['joint']['successes'],0)
 def test_rho_zero_product_identity(self):
  for c in [.85,.90,.95]:
   r=A.law(c,.02,8.,0.);self.assertAlmostEqual(r['joint'],r['coverage']*r['width'],places=12)
 def test_quadrature_duality_nonzero_correlations(self):
  for rho in [-.8,.8]:
   r=A.law(.85,.01,12.,rho);self.assertLess(abs(r['joint']-r['joint_reverse']),1e-9)
 def test_exact_counterexample_and_actual_original_partA(self):
  v=A.part_a_exact(self.o,self.w);self.assertEqual(v['draw_tuples'],6912)
  expected=np.var([-.03,-.01,.01,.03])/4+np.var([-.002,0,.002])/3
  self.assertAlmostEqual(v['components']['combined']['bootstrap_variance'],expected,places=18)
  self.assertLess(v['components']['combined']['original_part_a']['joint'],v['components']['series_fixed_time_only']['original_part_a']['joint'])
  self.assertGreater(v['components']['combined']['bootstrap_SD'],v['components']['series_fixed_time_only']['bootstrap_SD'])
 def test_actual_original_functions_are_loaded_unchanged(self):
  self.assertEqual(Path(self.o.__file__),A.ORIGINAL);x=.90;s=.02;r=A.law(x,s,8.,.8);self.assertAlmostEqual(self.o.tost_power(x,s,.90,.05),r['coverage'],places=12)
 def test_source_pin_tamper(self):
  f=self.w/'source.py';f.write_text('original');p=A.pin(f);f.write_text('changed')
  with self.assertRaisesRegex(ValueError,'pin changed'):A.check_pin(p)
 def test_request_hash_tamper(self):
  f=self.w/'request.json';f.write_text('{}');h=A.sha(f);f.write_text('{"tampered":true}')
  with self.assertRaisesRegex(ValueError,'request hash'):A.load_request(f,h)
 def test_pointwise_binomial_intervals_and_predeclared_bound(self):
  for k in [0,10,20]:
   v=A.binomial(k,20,.5);self.assertTrue(0<=v['pointwise_binomial_CI95'][0]<=v['rate']<=v['pointwise_binomial_CI95'][1]<=1)
   self.assertAlmostEqual(v['predeclared_discrepancy_bound'],6*math.sqrt(.5*.5/20)+1/20)
 def test_all_cases_retained_smallN_only(self):
  results=[A.evaluate_case(self.o,x,self.w,n=16) for x in A.grid()]
  self.assertEqual([x['case_id'] for x in results],list(range(99)));self.assertEqual(sum(x['coverage_truth']=='alternative' for x in results),27)
  self.assertTrue(all(x['monte_carlo']['joint']['worlds']==16 for x in results))
 def test_seed_reproduction_and_rho_dependence_reference(self):
  x=A.grid()[0];a=A.evaluate_case(self.o,x,self.w,n=128);b=A.evaluate_case(self.o,x,self.w,n=128);self.assertEqual(a,b)
  self.assertNotEqual(A.law(.85,.02,10.,-.8)['joint'],A.law(.85,.02,10.,.8)['joint'])
if __name__=='__main__':unittest.main()
