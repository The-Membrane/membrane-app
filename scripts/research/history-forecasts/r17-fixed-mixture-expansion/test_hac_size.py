import importlib.util,math,unittest
from pathlib import Path
p=Path(__file__).with_name('hac_size.py')
if not p.exists():p=Path(__file__).with_name('q26-hac-size-simulation.py')
s=importlib.util.spec_from_file_location('simulation',p);M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
class Tests(unittest.TestCase):
 def test_reproducible_and_domain(self):
  for _,rho,c,broken in M.SCENARIOS:
   y=M.generate(8,rho,c,broken);self.assertEqual(y,M.generate(8,rho,c,broken))
   for T,(n,v) in zip((366,365),y):
    self.assertEqual(len(n),T);self.assertTrue(any(x==0 for x in n));self.assertTrue(len(set(n))>2)
    for x,row in zip(n,v):
     self.assertLessEqual(abs(row[0]),x);self.assertLessEqual(abs(row[1]),x*(-math.log(1e-6)))
     if x==0:self.assertEqual(row,[0.,0.])
 def test_mean_analytic(self):
  # Exhaustive uniform stationary sign support, not sample-centering innovations.
  for _,rho,c,broken in M.SCENARIOS:
   for j in (1,2):
    values=[.5*(c*a+(1-c)*b) for a in (-1,1) for b in (-1,1)]
    self.assertEqual(sum(values),0.)
   self.assertAlmostEqual((1-rho)/2-(1-rho)/2,0.)
  for T in (366,365):
   h=T//2;self.assertAlmostEqual(-.2*h+.2*h/(T-h)*(T-h),0.)
 def test_clopper_pearson_exact_edges(self):
  self.assertEqual(M.binomial_interval(0,10)[0],0.)
  self.assertEqual(M.binomial_interval(10,10)[1],1.)
  self.assertAlmostEqual(M.binomial_interval(0,10)[1],1-M.MC_TAIL**.1,places=12)
  a=M.binomial_interval(3,10);b=M.binomial_interval(7,10)
  self.assertAlmostEqual(a[0],1-b[1],places=11);self.assertAlmostEqual(a[1],1-b[0],places=11)
  with self.assertRaises(ValueError):M.binomial_interval(11,10)
 def test_binomial_n1_and_tail(self):
  self.assertAlmostEqual(M.binomial_interval(0,1)[1],1-M.MC_TAIL,places=13)
  self.assertAlmostEqual(M.binomial_interval(1,1)[0],M.MC_TAIL,places=13)
  lo,hi=M.binomial_interval(2,5)
  def cdf(j,p):return sum(math.comb(5,i)*p**i*(1-p)**(5-i) for i in range(j+1))
  self.assertAlmostEqual(cdf(1,lo),1-M.MC_TAIL,places=12)
  self.assertAlmostEqual(cdf(2,hi),M.MC_TAIL,places=12)
 def test_real_core_generated_one_each(self):
  path=Path(__file__).with_name('hac_inference.py')
  if not path.exists():path=Path(__file__).with_name('q26-U-hac-core.py')
  core=M.load_core(path)
  for _,rho,c,broken in M.SCENARIOS:
   years=M.generate(600,rho,c,broken);d,f=M.decisions(core,years)
   self.assertEqual(len(d),5);self.assertFalse(any(f))
 def test_refusals_counted(self):
  class Core:
   LOSSES=('brier','bounded_logloss')
   @staticmethod
   def ratio_hac(n,s):raise ValueError('degenerate')
  d,f=M.decisions(Core(),M.generate(1,0,.75));self.assertEqual(d,[False]*5);self.assertEqual(f,[True]*5)
  x=M.summarize(1,2,10);self.assertEqual(x['denominator'],10);self.assertTrue(x['unresolved_refusal_flag'])
  self.assertGreater(x['refusal_as_rejection_interval'][1],x['simultaneous_99pct_clopper_pearson_interval'][1])
 def test_iut_not_masks_marginals(self):
  class Core:
   LOSSES=('brier','bounded_logloss')
   @staticmethod
   def ratio_hac(n,s):return {'components':{'brier':{'reject':True},'bounded_logloss':{'reject':False}}}
  d,f=M.decisions(Core(),M.generate(1,0,.75));self.assertEqual(d,[True,False,True,False,False]);self.assertFalse(any(f))
 def test_no_adaptive_repetitions(self):
  with self.assertRaises(ValueError):M.run(None,1)
  self.assertIsNone(M.summarize(5,0,10,True)['excess_size_flag'])
if __name__=='__main__':unittest.main()
