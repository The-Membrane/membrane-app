import importlib.util,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('v2guard',Path(__file__).with_name('outer_guard.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
def report():return dict(peak_known_rss_lower_bound_bytes=0,probe_count=0,complete_census_count=0,unknown_owned_snapshots=0,unknown_observations=[],unknown_observations_truncated=0,recovered_unknown_samples=0,sampled_peak_parent_and_owned_rss_bytes=None)
def sample(unknown=False,rss=100):return [(10,1,10,rss,'S'),(20,10,20,0 if unknown else 200,'?' if unknown else 'S')]
class QualificationTests(unittest.TestCase):
 def run_sample(self,values,r=None,deadline=None):
  r=report() if r is None else r
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   j=Path(t)/'journal';j.write_text(json.dumps({'pid':20,'pgid':20})+'\n')
   with patch.object(g,'census',side_effect=[(v,99) for v in values]),patch.object(g.time,'sleep'):
    selected=g.qualified_sample(10,20,set(),{20},j,time.monotonic()+3 if deadline is None else deadline,r)
  return selected,r
 def test_unknown_recovers_fresh_whole_sample(self):
  selected,r=self.run_sample([sample(True),sample(False)])
  self.assertEqual(r['probe_count'],2);self.assertEqual(r['recovered_unknown_samples'],1);self.assertEqual(r['unknown_observations'][0]['total_rss_bytes'],None);self.assertIsNone(r['unknown_observations'][0]['unknown_owned_metadata'][0]['rss_bytes']);self.assertEqual(r['unknown_observations'][0]['unknown_owned_metadata'][0]['reported_rss_bytes'],0);self.assertEqual(r['sampled_peak_parent_and_owned_rss_bytes'],300)
 def test_three_inclusive_maximum(self):
  r=report()
  with self.assertRaisesRegex(ValueError,'three_censuses'):self.run_sample([sample(True)]*4,r)
  self.assertEqual(r['probe_count'],3);self.assertIsNone(r['sampled_peak_parent_and_owned_rss_bytes']);self.assertEqual(r['complete_census_count'],0)
 def test_known_subtotal_cap_before_recovery(self):
  r=report()
  with self.assertRaises(MemoryError):self.run_sample([sample(True,g.RSS+1),sample(False)],r)
  self.assertEqual(r['probe_count'],1);self.assertGreater(r['peak_known_rss_lower_bound_bytes'],g.RSS)
 def test_unknown_disappears_in_fresh_census(self):
  selected,r=self.run_sample([sample(True),[(10,1,10,100,'S')]])
  self.assertEqual(len(selected),1);self.assertEqual(r['sampled_peak_parent_and_owned_rss_bytes'],100)
 def test_shared_absolute_deadline(self):
  captured=[];clock=[10.]
  def census(deadline):captured.append(deadline);clock[0]+=.6;return sample(True),99
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   j=Path(t)/'j';j.touch()
   with patch.object(g.time,'monotonic',side_effect=lambda:clock[0]),patch.object(g.time,'sleep'),patch.object(g,'census',side_effect=census):
    with self.assertRaises(ValueError):g.qualified_sample(10,20,set(),{20},j,11.5,report())
  self.assertTrue(all(x==11.5 for x in captured));self.assertLessEqual(len(captured),3)
 def test_census_exception_not_retried(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   j=Path(t)/'j';j.touch()
   with patch.object(g,'census',side_effect=ValueError('malformed')) as c:
    with self.assertRaisesRegex(ValueError,'malformed'):g.qualified_sample(10,20,set(),{20},j,time.monotonic()+3,report())
   self.assertEqual(c.call_count,1)
 def fixture_predecessor(self,root):
  root=Path(root);out=root/'oldout';out.mkdir();bench=root/'benchmark.py';bench.write_bytes(Path(__file__).with_name('benchmark.py').read_bytes())
  old={'status':'READY_PARENT_REVIEWED','output':str(out),'result':str(root/'missing.json'),'command':['python',str(bench)],'pins':[g.pin(bench)]};request=root/'request.json';request.write_text(json.dumps(old));receipt=out/'receipt.json';receipt.write_text(json.dumps({'status':'FAILED','stop_reason':'ValueError: owned_RSS_unknown','child_returncode':-15,'cleanup':{'live_pids':[]},'elapsed_seconds':5.530611540998507}))
  return {'predecessor':{'request':g.pin(request),'receipt':g.pin(receipt)},'prior_charged_seconds':6,'remaining_wall_seconds':54}
 def test_predecessor_binding_and_budget(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   r=self.fixture_predecessor(t);g.validate_predecessor(r);r['remaining_wall_seconds']=60
   with self.assertRaisesRegex(ValueError,'budget'):g.validate_predecessor(r)
 def test_predecessor_wrong_pin_rejected(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   r=self.fixture_predecessor(t);r['predecessor']['receipt']['sha256']='0'*64
   with self.assertRaises(ValueError):g.validate_predecessor(r)
if __name__=='__main__':unittest.main()
