import copy,importlib.util,math,unittest
from decimal import Decimal,localcontext
from pathlib import Path
import numpy as np
s=importlib.util.spec_from_file_location('Q',Path(__file__).resolve().with_name('variance_qlike.py'));Q=importlib.util.module_from_spec(s);s.loader.exec_module(Q)
def oracle(y,p):
 with localcontext() as c:
  c.prec=170;y=Decimal.from_float(float(y));p=Decimal.from_float(float(p));q=(y/p)**2;loss=q-q.ln()-1
  return None if loss==0 else float(loss.ln())
class Tests(unittest.TestCase):
 def test_variance_known_answer_and_asymmetry(self):
  a=Q.summarize_logs([Q.log_qlike_sigma(2.,1.)]);b=Q.summarize_logs([Q.log_qlike_sigma(1.,2.)])
  self.assertAlmostEqual(a['mean'],4-math.log(4)-1,14);self.assertAlmostEqual(b['mean'],.25-math.log(.25)-1,14);self.assertGreater(a['mean'],b['mean'])
 def test_adjacent_scales_not_false_zero(self):
  for p in (1.,1e100,1e-100,1e300,1e-300):
   for direction in (0.,math.inf):
    y=float(np.nextafter(p,direction));got=Q.log_qlike_sigma(y,p)
    self.assertTrue(math.isfinite(got));self.assertAlmostEqual(got,oracle(y,p),11)
 def test_decimal_sixhundred(self):
  rng=np.random.default_rng(188)
  for i in range(600):
   p=math.exp(float(rng.uniform(-600,600)));y=p*(1+float(rng.uniform(-.49,.49))) if i%2 else math.exp(float(rng.uniform(-600,600)))
   self.assertAlmostEqual(Q.log_qlike_sigma(y,p),oracle(y,p),10)
 def test_scale_units(self):
  for y,p in [(3.,2.),(1.,4.),(1.000000000000001,1.)]:
   expected=Q.log_qlike_sigma(y,p)
   for k in (-500,500):self.assertAlmostEqual(Q.log_qlike_sigma(math.ldexp(y,k),math.ldexp(p,k)),expected,12)
 def test_perfect_and_empty_and_zero(self):
  self.assertEqual(Q.log_qlike_sigma(2.,2.),-math.inf)
  self.assertEqual(Q.summarize_logs([-math.inf]*3)['status'],'EXACT_ZERO');self.assertEqual(Q.summarize_logs([])['status'],'EMPTY')
  for y,p in [(0,1),(1,0),(-1,1),(math.inf,1),(1,math.nan)]:
   with self.assertRaises(ValueError):Q.log_qlike_sigma(y,p)
 def test_extremes_retained_in_mean(self):
  logs=[Q.log_qlike_sigma(1e308,1e-308),-math.inf,Q.log_qlike_sigma(1.,1.)];r=Q.summarize_logs(logs)
  self.assertEqual(r['n'],3);self.assertEqual(r['ordinary_row_overflow'],1);self.assertEqual(r['perfect_zero_rows'],2)
  self.assertIsNone(r['mean']);self.assertEqual(r['status'],'ABOVE_FLOAT64_RANGE');self.assertAlmostEqual(r['log_mean'],oracle(1e308,1e-308)-math.log(3),11)
  reverse=Q.summarize_logs([Q.log_qlike_sigma(1e-308,1e308)])
  self.assertTrue(math.isfinite(reverse['mean']));self.assertGreater(reverse['mean'],2000)
 def test_exp_cancellation_and_extreme_logratio(self):
  with localcontext() as c:
   c.prec=150
   for x in (-1000.,-50.,-.5,-1e-8,1e-8,.5,50.,1000.):
    d=Decimal.from_float(x);expected=float((d.exp()-d-1).ln());self.assertAlmostEqual(Q.log_qlike_ratio(x),expected,11)
  r=Q.summarize_logs([Q.log_qlike_ratio(1e-300)]);self.assertEqual(r['status'],'BELOW_POSITIVE_FLOAT64_RANGE');self.assertNotEqual(r['status'],'EXACT_ZERO')
 def test_mean_not_mean_logs(self):
  a=Q.summarize_logs([math.log(1),math.log(9)]);self.assertAlmostEqual(a['mean'],5,14);self.assertAlmostEqual(a['log_mean'],math.log(5),14)
  b=Q.summarize_logs([1000.,1001.]);self.assertEqual(Q.comparison(a,b)['ordering'],'LEFT_LOWER');self.assertIsNone(Q.comparison(a,b)['mean_difference'])
 def test_fixed_pair_and_three_way_masks(self):
  t=np.array([1672531200,1704067200,1704153600,1704240000,1735689600,1735776000],np.int64)
  h=np.array([1.,2.,np.nan,2.,4.,1.]);e=np.array([1.,1.,1.,1.,2.,0.]);p=np.array([1.,1.,1.,0.,2.,1.]);y=np.array([1.,1.,1.,1.,2.,1.]);b=np.ones(6,bool)
  report=Q.score_scales(t,h,e,p,y,b,~b,status=Q.READY);self.assertEqual(report['out_of_period_J'],1)
  for name,yearmask in [('pooled_2024_2025',np.array([0,1,1,1,1,1],bool)),('2024',np.array([0,1,1,1,0,0],bool)),('2025',np.array([0,0,0,0,1,1],bool))]:
   for key,arms in [('HAR_EWMA',[h,e]),('HAR_PERSISTENCE',[h,p]),('EWMA_PERSISTENCE',[e,p]),('COMMON_THREE',[h,e,p])]:
    mask=yearmask.copy()
    for a in arms:mask&=np.isfinite(a)&(a>0)
    v=report['views'][name]['supports'][key];self.assertEqual(v['n'],int(mask.sum()))
    for arm,a in zip(key.split('_') if key!='COMMON_THREE' else ['HAR','EWMA','PERSISTENCE'],arms):
     expected=[math.exp(oracle(yy,pp)) if yy!=pp else 0. for yy,pp in zip(y[mask],a[mask])]
     if expected:self.assertAlmostEqual(v['original_target_paired']['QLIKE'][arm]['mean'],math.fsum(expected)/len(expected),12)
 def test_target_unavailability_not_overflow_exclusion(self):
  t=np.array([1704067200,1704153600,1704240000],np.int64);h=np.array([1e-308,1.,1.]);e=np.ones(3);p=np.ones(3);y=np.array([1e308,0.,np.nan]);b=np.ones(3,bool)
  v=Q.score_scales(t,h,e,p,y,b,b,status=Q.READY)['views']['2024'];self.assertEqual(v['target_unavailable'],2)
  q=v['supports']['COMMON_THREE'];self.assertEqual(q['n'],1);self.assertEqual(q['original_target_paired']['QLIKE']['HAR']['ordinary_row_overflow'],1)
 def test_complete_future_not_primary_replacement(self):
  t=np.array([1704067200,1704153600],np.int64);h=np.array([1.,10.]);e=np.ones(2);p=np.array([2.,1.]);y=np.ones(2);st=np.array([True,False]);fb=np.zeros(2,bool)
  r=Q.score_scales(t,h,e,p,y,st,fb,status=Q.READY)['views']['2024']['supports']
  for key in ('HAR_EWMA','HAR_PERSISTENCE','EWMA_PERSISTENCE','COMMON_THREE'):
   self.assertEqual(r[key]['original_target_paired']['n'],2);self.assertEqual(r[key]['complete_future_paired']['n'],1)
  self.assertNotEqual(r['HAR_EWMA']['original_target_paired']['QLIKE']['HAR']['mean'],r['HAR_EWMA']['complete_future_paired']['QLIKE']['HAR']['mean'])
  self.assertNotEqual(r['HAR_EWMA']['original_target_paired']['squared_log_sigma']['HAR'],r['HAR_EWMA']['complete_future_paired']['squared_log_sigma']['HAR'])
 def test_weighted_logmean_merge(self):
  a=Q.summarize_logs([math.log(1.)]);b=Q.summarize_logs([math.log(9.)]*3);z=Q.summarize_logs([-math.inf]*2);empty=Q.summarize_logs([])
  r=Q.merge_qlike([a,b,z,empty]);self.assertEqual(r['n'],6);self.assertAlmostEqual(r['mean'],28/6,13);self.assertEqual(r['perfect_zero_rows'],2)
  huge=Q.summarize_logs([1000.]*3);v=Q.merge_qlike([a,huge,z,empty]);self.assertEqual(v['status'],'ABOVE_FLOAT64_RANGE');self.assertAlmostEqual(v['log_mean'],1000+math.log(3/6),12);self.assertEqual(v['ordinary_row_overflow'],3)
  self.assertEqual(Q.merge_qlike([z,empty])['status'],'EXACT_ZERO');self.assertEqual(Q.merge_qlike([empty])['status'],'EMPTY')
 def test_global_merge_unequal_series_same_row_estimand(self):
  t=np.array([1704067200,1704153600,1704240000,1735689600],np.int64);h=np.array([1.,2.,3.,4.]);e=np.ones(4);p=np.array([2.,1.,2.,1.]);y=np.ones(4);st=np.array([True,False,True,True]);fb=~st
  args=[t,h,e,p,y,st,fb];r=Q.score_scales(*args,status=Q.READY);parts=[Q.score_scales(*(a[z] for a in args),status=Q.READY) for z in (slice(0,1),slice(1,4),slice(0,0))];merged=Q.merge_reports(parts)
  for view in r['views']:
   self.assertEqual(merged['views'][view]['J'],r['views'][view]['J'])
   for support in r['views'][view]['supports']:
    for block in ('original_target_paired','complete_future_paired'):
     expected=r['views'][view]['supports'][support][block];actual=merged['views'][view]['supports'][support][block];self.assertEqual(actual['n'],expected['n'])
     for arm in expected['QLIKE']:
      self.assertEqual(actual['QLIKE'][arm]['status'],expected['QLIKE'][arm]['status'])
      if expected['QLIKE'][arm]['mean'] is not None:self.assertAlmostEqual(actual['QLIKE'][arm]['mean'],expected['QLIKE'][arm]['mean'],12)
      if expected['squared_log_sigma'][arm] is not None:self.assertAlmostEqual(actual['squared_log_sigma'][arm],expected['squared_log_sigma'][arm],12)
 def test_merge_fixed_calendar_support_arm_inventory(self):
  t=np.array([1704067200],np.int64);a=np.ones(1);b=np.ones(1,bool);base=Q.score_scales(t,a,a,a,a,b,b,status=Q.READY)
  for kind in ('views','support','arm'):
   for first_only in (False,True):
    reports=[copy.deepcopy(base),copy.deepcopy(base)]
    for r in reports[:1] if first_only else reports:
     if kind=='views':r['views']={}
     elif kind=='support':r['views']['2024']['supports'].pop('HAR_PERSISTENCE')
     else:r['views']['2024']['supports']['COMMON_THREE']['original_target_paired']['QLIKE'].pop('PERSISTENCE')
    with self.subTest(kind=kind,first_only=first_only),self.assertRaises(ValueError):Q.merge_reports(reports)
 def test_draft_and_inventory_refusal(self):
  with self.assertRaises(ValueError):Q.score_scales(None,None,None,None,None,None,None)
  for values in ([math.inf],[math.nan]):
   with self.assertRaises(ArithmeticError):Q.summarize_logs(values)
if __name__=='__main__':unittest.main()
