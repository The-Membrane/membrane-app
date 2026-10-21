import importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('outer',Path(__file__).with_name('outer_guard.py'));g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class GuardTests(unittest.TestCase):
 def test_syntax_unknown_separate(self):
  self.assertEqual(g.rows('12 1 12 0 ?\n')[0][4],'?')
  for t in ['12 1 12 -1 S\n','12 x 12 1 S\n','12 1 12 1 S extra\n']:
   with self.assertRaises(ValueError):g.rows(t)
 def test_nested_sessions_and_observer_exclusion(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   j=Path(t)/'journal';j.write_text(json.dumps({'pid':20,'pgid':20})+'\n');pids=set();groups={10}
   selected=g.ownership(g.rows('1 0 1 30 S\n10 1 10 100 S\n20 10 20 200 S\n21 20 20 10 S\n30 1 1 5 R\n'),1,10,pids,groups,j,30)
   self.assertEqual({r[0] for r in selected},{1,10,20,21});self.assertIn(20,groups)
 def test_pin_mismatch(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   p=Path(t)/'a';p.write_text('before');v=g.pin(p);p.write_text('after')
   with self.assertRaises(ValueError):g.verify([v])
 def test_census_deadline(self):
  with self.assertRaises(TimeoutError):g.census(time.monotonic()-1)
 def request(self,t,code):
  p=Path(t);return {'output':str(p/'guard'),'pins':[],'libomp_directory':'','command':[sys.executable,'-c',code],'result':str(p/'result.json')}
 def test_blocked_child_timeout_and_receipt(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   with patch.object(g,'WALL',.15):r=g.execute(self.request(t,'import time;time.sleep(30)'))
   self.assertEqual(r['status'],'FAILED');self.assertIn('wall_time',r['stop_reason']);self.assertEqual(r['cleanup']['live_pids'],[]);self.assertTrue((Path(t)/'guard/receipt.json').is_file())
 def test_leader_exit_new_session_child_cleanup(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   result=Path(t)/'result.json'
   code="import os,subprocess,sys,json;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True);Path(os.environ['Q26_BENCH_OWNERSHIP_JOURNAL']).write_text(json.dumps({'pid':p.pid,'pgid':p.pid})+'\\n');Path("+repr(str(result))+").write_text(json.dumps({'status':'COMPLETE'}))"
   r=g.execute(self.request(t,code));self.assertEqual(r['status'],'COMPLETE');self.assertEqual(r['cleanup']['live_pids'],[])
 def test_disk_failure_no_spawn_preserved(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
   with patch.object(g.shutil,'disk_usage',return_value=type('D',(),{'free':0})()):r=g.execute(self.request(t,'raise RuntimeError()'))
   self.assertEqual(r['status'],'FAILED');self.assertIn('disk_reserve',r['stop_reason']);self.assertTrue((Path(t)/'guard/receipt.json').exists())
if __name__=='__main__':unittest.main()
