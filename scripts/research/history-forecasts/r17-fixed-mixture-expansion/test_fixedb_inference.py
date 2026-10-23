import importlib.util,math,unittest,copy
from pathlib import Path
from fractions import Fraction
p=Path(__file__).with_name('fixedb_inference.py')
if not p.exists():p=Path(__file__).with_name('q26-o186-fixedb-core.py')
s=importlib.util.spec_from_file_location('fixedb',p);M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
class Tests(unittest.TestCase):
 def test_published_table_and_interpolation(self):
  self.assertEqual(M.interpolate(.06),1.772);self.assertEqual(M.interpolate(.08),1.813)
  for T in (365,366):
   c=M.critical_value(T);b=Fraction(29,T)
   exact=Fraction(1772,1000)+(b-Fraction(6,100))/Fraction(2,100)*Fraction(41,1000)
   self.assertAlmostEqual(c['critical_right_95'],float(exact),places=14)
   self.assertEqual(c['critical_rounding_sensitivity'],[c['critical_right_95']-.0005,c['critical_right_95']+.0005])
   self.assertEqual(c['M'],29);self.assertNotEqual(c['b'],28/T)
   self.assertGreater(c['critical_right_95'],M.interpolate(28/T))
 def test_no_variants(self):
  for T,L in ((364,28),(367,28),(365,27),(365,29),(True,28)):
   with self.assertRaises(ValueError):M.critical_value(T,L)
  for b in (.059,.081,float('nan'),True):
   with self.assertRaises(ValueError):M.interpolate(b)
 def test_tail_and_ties(self):
  c=M.critical_value(365)['critical_right_95']
  self.assertTrue(M.compare(-1.,-c,c));self.assertFalse(M.compare(-1.,math.nextafter(-c,math.inf),c))
  self.assertFalse(M.compare(1.,c,c));self.assertFalse(M.compare(0.,-c,c))
  with self.assertRaises(ValueError):M.compare(-1,float('nan'),c)
 def test_unchanged_ratio_and_refusal(self):
  p=Path(__file__).with_name('hac_inference.py')
  if not p.exists():p=Path(__file__).with_name('q26-U-hac-core.py')
  core=M.load_core(p);n=[1+(i%3) for i in range(366)];s=[[n[i]*(-.2+.1*(i%2))]*2 for i in range(366)]
  with self.assertRaises(ValueError):M.evaluate(core,n,s)
  r=M.evaluate(core,n,s,status=M.READY);raw=core.ratio_hac(n,s)
  for loss in core.LOSSES:
   for a,b in (('mean_U','mean_U'),('se','se'),('t','z')):self.assertEqual(r['components'][loss][a],raw['components'][loss][b])
  with self.assertRaises(ValueError):M.evaluate(core,[0]*366,[[0,0]]*366,status=M.READY)
  with self.assertRaises(ValueError):M.evaluate(core,[1]*366,[[.1,.1]]*366,status=M.READY)
 def test_iut_dependence_no_inverse(self):
  def year(T):
   c=M.critical_value(T);v={'mean_U':-2.,'se':1.,'t':-2.,'reject':True}
   return {'critical':c,'components':{'brier':dict(v),'bounded_logloss':dict(v)},'scope':'FIXED_B_SOURCE_QUALIFICATION_ONLY','empirical_admission':'NOT_ADMITTED'}
  y={'2024':year(366),'2025':year(365)}
  self.assertTrue(M.iut4(y)['joint_reject'])
  # Identical loss tests allowed; each possible single component failure blocks IUT.
  for year in y:
   for loss in y[year]['components']:
    z=copy.deepcopy(y);z[year]['components'][loss].update(mean_U=2.,t=2.,reject=False)
    self.assertFalse(M.iut4(z)['joint_reject'])
  z=copy.deepcopy(y);z['2024']['components']['brier']['se']=0
  with self.assertRaises(ValueError):M.iut4(z)
if __name__=='__main__':unittest.main()
