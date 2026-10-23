import importlib.util,math,unittest
from pathlib import Path
from fractions import Fraction as Q
s=importlib.util.spec_from_file_location('g',Path(__file__).with_name('properloss_generator.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
class Tests(unittest.TestCase):
 def test_binary_loss_knownanswers(self):
  self.assertEqual(g.D1,tuple(-x for x in g.D0));self.assertAlmostEqual(g.D0[0],.2,places=15);self.assertAlmostEqual(g.D0[1],math.log(1.5),places=15)
 def test_clipping_and_uint8(self):
  import numpy as np
  for y in (0,1):
   self.assertEqual(g.proper_losses(.4,np.uint8(y)),g.proper_losses(.4,y));self.assertTrue(all(math.isfinite(x)for x in g.proper_losses(y,1-y)))
 def test_complete_exact_boundary(self):
  p=g.parameters('complete','boundary');self.assertEqual(p['q'],Q(1,2));self.assertEqual(p['upper_normalized_mean'],0);self.assertEqual(p['actual_normalized_mean'],0)
 def test_independent_missing_exact_boundary(self):
  p=g.parameters('independent','boundary');self.assertEqual(p['q'],Q(5,8));self.assertEqual(p['upper_normalized_mean'],0);self.assertEqual(p['actual_normalized_mean'],Q(-1,4));self.assertEqual(p['marginal_unknown'],Q(1,5))
 def test_markov_stationarity_and_eigenvalue(self):
  for q in (Q(1,2),Q(5,8),Q(9,10)):
   for rho in (Q(0),Q(1,2),Q(9,10)):
    p01=(1-rho)*q;p10=(1-rho)*(1-q);self.assertEqual((1-q)*p01,q*p10);self.assertEqual(1-p01-p10,rho)
 def test_missing_upper_known_and_unknown(self):
  self.assertEqual(g.upper(1,False),g.D1);self.assertEqual(g.upper(1,True),g.D0);self.assertEqual(g.upper(0,True),g.D0)
 def test_count_independent_mean_and_boundary(self):
  self.assertEqual(sum(map(Q,g.COUNT_VALUES))/4,Q(11,4));self.assertEqual(g.parameters('independent','boundary')['upper_normalized_mean']*Q(11,4),0)
 def test_exact_configs_and_family(self):
  self.assertEqual(len(g.CONFIGS),8);cells=g.null_diagnostic_cells();self.assertEqual(len(cells),72);self.assertEqual(len({(x['method'],x['configuration'],x['cell'])for x in cells}),72)
  for cfg in g.CONFIGS:
   for y,role in cfg['roles'].items():
    if role=='alternative':self.assertFalse(any(x['configuration']==cfg['id']and x['cell'].startswith(str(y))for x in cells))
 def test_calendar_and_actual_row_realizability(self):
  y=g.generate_year(2024,'9/10','independent','boundary',314,status=g.READY);self.assertEqual(len(y['days']),366);self.assertEqual(y['days'][59],'2024-02-29');self.assertEqual(y['days'][-1],'2024-12-31')
  for n,z,unknown,sums,actual in zip(y['counts'],y['latent_y'],y['unknown'],y['sums'],y['actual_difference_sums']):
   u=g.upper(z,unknown);d=g.paired(z);self.assertEqual(sums,[math.fsum([x]*n)for x in u]);self.assertEqual(actual,[math.fsum([x]*n)for x in d]);self.assertTrue(all(abs(sums[i])<=n*g.frozen_core().BOUNDS[i]for i in (0,1)))
 def test_separate_streams_MNAR_pathwise(self):
  a=g.generate_year(2025,'9/10','complete','boundary',2718,status=g.READY);m=g.generate_year(2025,'9/10','mnar_tight','boundary',2718,status=g.READY);self.assertEqual(a['latent_y'],m['latent_y']);self.assertEqual(a['counts'],m['counts']);self.assertEqual(a['sums'],m['sums']);self.assertTrue(any(m['unknown']));self.assertFalse(any(u and y for u,y in zip(m['unknown'],m['latent_y'])))
 def test_MNAR_exact_marginal_and_null(self):
  p=g.parameters('mnar_tight','boundary');self.assertEqual((1-p['q'])*p['unknown_given_y0']+p['q']*p['unknown_given_y1'],Q(1,5));self.assertEqual(p['upper_normalized_mean'],0);self.assertEqual(p['actual_normalized_mean'],0)
 def test_alternative_strict_negative(self):
  p=g.parameters('complete','alternative');self.assertEqual(p['q'],Q(9,10));self.assertEqual(p['upper_normalized_mean'],Q(-4,5))
 def test_each_year_uses_own_stationary_parameters(self):
  cfg=g.CONFIGS[6];x=g.generate_replicate(cfg['id'],0,status=g.READY);self.assertEqual(x[2024]['design']['q'],'1/2');self.assertEqual(x[2025]['design']['q'],'9/10');self.assertTrue(x[2024]['design']['stationary_start']);self.assertTrue(x[2025]['design']['stationary_start'])
 def test_singular_two_score_core_no_inverse(self):
  x=g.generate_year(2025,'1/2','complete','boundary',99,status=g.READY);core=g.frozen_core();r=core.ratio_hac(x['counts'],x['sums'],L=g.HAC_L);self.assertEqual(r['bandwidth'],28);self.assertTrue(all(v['se']>0 for v in r['components'].values()));a,b=r['omega'][0];d=r['omega'][1][1];self.assertLess(abs(a*d-b*b),1e-12*max(1,a*d))
 def test_no_favorable_seed_or_config_expansion(self):
  self.assertNotEqual(g.seed_for(g.CONFIGS[0]['id'],0),g.seed_for(g.CONFIGS[0]['id'],1))
  for rep in (-1,1000):
   with self.assertRaises(ValueError):g.seed_for(g.CONFIGS[0]['id'],rep)
 def test_DRAFT_and_unfrozen_refusal(self):
  with self.assertRaises(ValueError):g.generate_year(2024,'9/10','complete','boundary',1)
  with self.assertRaises(ValueError):g.generate_year(2024,'99/100','complete','boundary',1,status=g.READY)
  with self.assertRaises(ValueError):g.parameters('independent','alternative')
if __name__=='__main__':unittest.main()
