import importlib.util,unittest,types,copy,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('d',Path(__file__).with_name('properloss_size.py'));d=importlib.util.module_from_spec(s);s.loader.exec_module(d);g=d.load(d.pin(d.GEN),'g');f=d.load(d.pin(d.FIXED),'f')
def masks(reps=3):return [{'configuration':c['id'],'replicate':i,'gaussian_mask':31 if i in (0,1)else 0,'fixed_b_mask':31 if i==1 else 0,'refusal_mask':0}for c in g.CONFIGS for i in range(reps)]
class Tests(unittest.TestCase):
 def test_CP_matches_accepted_old_tail_without_mutation(self):
  old=d.load(d.pin(d.LEGACY),'legacy');tail=old.MC_TAIL
  for k,n in [(0,10),(1,10),(5,10),(10,10),(27,1000),(77,1000)]:self.assertEqual(d.binomial_interval(k,n,tail),old.binomial_interval(k,n))
  self.assertEqual(old.MC_TAIL,tail);self.assertEqual(tail,.01/(2*20));self.assertEqual(d.MC_TAIL,.01/(2*72))
 def test_CP_new_family_wider(self):
  a=d.binomial_interval(50,1000,.01/40);b=d.binomial_interval(50,1000);self.assertLess(b[0],a[0]);self.assertGreater(b[1],a[1])
 def test_CP_domains(self):
  for k,n in [(-1,10),(11,10),(0,0),(True,10)]:
   with self.assertRaises(ValueError):d.binomial_interval(k,n)
 def test_mask_counts_and_alt_exclusion(self):
  r=d.reduce_masks(g,masks(),3);self.assertEqual(r['true_null_family_size'],72);self.assertEqual(len(r['cells']),80);self.assertTrue(all(x['rejections']==(2 if x['method']=='gaussian_hac'else 1)and x['fixed_denominator']==3 for x in r['cells']));alts=[x for x in r['cells']if not x['true_upper_null_diagnostic']];self.assertEqual(len(alts),8);self.assertTrue(all(x['oversize_flag']is None for x in alts))
 def test_refusals_full_denominator_with_envelope(self):
  rows=masks();rows[0].update(gaussian_mask=0,fixed_b_mask=0,refusal_mask=19);r=d.reduce_masks(g,rows,3);self.assertFalse(r['complete_without_refusals']);self.assertTrue(all(x['interval']is not None and x['fixed_denominator']==3 and x['refusal_envelope_interval'][1]>=x['interval'][1]for x in r['cells']));self.assertTrue(r['execution_complete'])
 def test_refused_cell_cannot_reject(self):
  rows=masks();rows[0]['refusal_mask']=19
  with self.assertRaises(ValueError):d.reduce_masks(g,rows,3)
 def test_no_omission_duplicate_or_forged_IUT(self):
  for rows in [masks()[:-1],masks()+[masks()[0]],masks()]:
   if len(rows)==24:rows[0]['gaussian_mask']=16
   with self.assertRaises(ValueError):d.reduce_masks(g,rows,3)
 def test_shared_HAC_exactly_once_year(self):
  class Core:
   calls=0
   def ratio_hac(self,counts,sums,L):
    self.calls+=1;assert L==28
    return {'T':365 if self.calls==2 else 366,'N':5,'occupied_days':3,'bandwidth':28,'components':{loss:{'mean_U':-.1,'se':.05,'z':-2.,'reject':True}for loss in g.LOSSES}}
  core=Core();y={yr:{'counts':[1],'sums':[[0,0]]}for yr in (2024,2025)};r=d.evaluate_pair(g,core,f,y);self.assertEqual(core.calls,2);self.assertEqual(r['gaussian_mask'],31);self.assertEqual(r['fixed_b_mask'],31)
 def test_core_refusal_retained(self):
  class Core:
   def ratio_hac(self,*a,**k):raise ValueError('zero support')
  y={yr:{'counts':[0],'sums':[[0,0]]}for yr in (2024,2025)};r=d.evaluate_pair(g,Core(),f,y);self.assertEqual(r['refusal_mask'],31);self.assertEqual(r['gaussian_mask'],0);self.assertEqual(r['fixed_b_mask'],0)
 def test_DRAFT_before_source_or_output(self):
  with self.assertRaisesRegex(ValueError,'DRAFT'):d.run(None,None,None,False)
 def test_wrong_request_pin_refused(self):
  with tempfile.TemporaryDirectory(prefix='q26-o186-properloss-request-',dir='/private/tmp')as td:
   p=Path(td)/'q.json';p.write_text('{}')
   with self.assertRaisesRegex(ValueError,'external request hash'):d.authenticate(p,'0'*64,d.pin(d.__file__)['sha256'],True)
 def test_fixed_subset_guard(self):
  rows=masks();rows[2]['fixed_b_mask']=31
  with self.assertRaisesRegex(ValueError,'subset'):d.reduce_masks(g,rows,3)
 def test_runtime_random_source_pinned(self):
  runtime=d.runtime_snapshot();self.assertTrue(any(x['path'].endswith('/random.py')for x in runtime['used_file_pins']))
 def test_expected_degenerate_refusals_and_unexpected_errors(self):
  y={yr:{'counts':[0],'sums':[[0,0]]}for yr in (2024,2025)}
  for message in ('zero support','numerically degenerate HAC score: NOT TESTABLE','zero/negative HAC variance: NOT TESTABLE'):
   class Expected:
    def ratio_hac(self,*a,**k):raise ValueError(message)
   self.assertEqual(d.evaluate_pair(g,Expected(),f,y)['refusal_mask'],31)
  class Unexpected:
   def ratio_hac(self,*a,**k):raise ValueError('bounded U numerator')
  with self.assertRaisesRegex(ValueError,'bounded U numerator'):d.evaluate_pair(g,Unexpected(),f,y)
if __name__=='__main__':unittest.main()
