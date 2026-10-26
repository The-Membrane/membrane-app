import hashlib,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import monitor as M
class MonitorTests(unittest.TestCase):
 def fixture(self,root,body):
  root=Path(root);helper=root/'child.py';helper.write_text(body);request=root/'request.json';r={'schema':'codex-r17-execution-request-v1','status':'READY_PARENT_REVIEWED','phase':'build','output':str(root/'out'),'receipt':str(root/'receipt.json'),'start_receipt':str(root/'start.json'),'stdout_log':str(root/'stdout.log'),'stderr_log':str(root/'stderr.log'),'expected_results':['result.json'],'argv':[sys.executable,str(helper),str(root/'out')],'pins':[M.pin(helper)]};request.write_text(json.dumps(r));return r,M.pin(request)
 def policy(self,**kw):return {**M.POLICY,'disk_reserve_bytes':0,'wall_seconds':8,'output_bytes':1000000,**kw}
 def test_success(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,"import pathlib,sys\np=pathlib.Path(sys.argv[1]);p.mkdir();(p/'result.json').write_text('{}')\n");v=M.execute(r,p,Path(t),self.policy());self.assertTrue(v['complete']);self.assertTrue(v['containment']['no_live_members_remaining']);self.assertEqual(v['exit_code'],0);self.assertTrue(v['result_pins'])
 def test_final_result_hashing_charged_to_deadline(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,"import pathlib,sys\np=pathlib.Path(sys.argv[1]);p.mkdir();(p/'result.json').write_text('{}')\n");original_pin=M.pin;original_clock=M.time.monotonic;extra=[0.]
   def delayed_pin(path):
    value=original_pin(path)
    if Path(path).resolve()==(Path(t)/'out/result.json').resolve():extra[0]=10.
    return value
   def clock():return original_clock()+extra[0]
   with patch.object(M,'pin',side_effect=delayed_pin),patch.object(M.time,'monotonic',side_effect=clock):v=M.execute(r,p,Path(t),self.policy())
   self.assertFalse(v['complete']);self.assertEqual(v['stop_reason'],'wall_time_exceeded');self.assertGreater(v['elapsed_seconds'],8)
 def test_result_hash_failure_retains_receipt(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,"import pathlib,sys\np=pathlib.Path(sys.argv[1]);p.mkdir();(p/'result.json').write_text('{}')\n");original=M.pin
   def fail_result(path):
    if Path(path).resolve()==(Path(t)/'out/result.json').resolve():raise OSError('synthetic output hash failure')
    return original(path)
   with patch.object(M,'pin',side_effect=fail_result):v=M.execute(r,p,Path(t),self.policy())
   self.assertFalse(v['complete']);self.assertEqual(v['stop_reason'],'result_metadata_failed:OSError');self.assertTrue(Path(t,'receipt.json').is_file());self.assertTrue(v['containment']['no_live_members_remaining'])
 def test_leader_exits_descendant_cleaned(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,"import pathlib,sys,subprocess\np=pathlib.Path(sys.argv[1]);p.mkdir();c=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);(p/'result.json').write_text(str(c.pid))\n");v=M.execute(r,p,Path(t),self.policy());self.assertTrue(v['complete'],v);self.assertTrue(v['containment']['no_live_members_remaining']);pid=int((Path(t)/'out/result.json').read_text());q=subprocess.run(['/bin/ps','-o','stat=','-p',str(pid)],capture_output=True,text=True,timeout=2);self.assertTrue(not q.stdout.strip() or q.stdout.strip().startswith('Z'),q.stdout)
 def test_timeout(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'import time;time.sleep(30)\n');v=M.execute(r,p,Path(t),self.policy(wall_seconds=.25));self.assertFalse(v['complete']);self.assertIn('wall_time',v['stop_reason']);self.assertTrue(v['containment']['no_live_members_remaining'])
 def test_process_probe_fail_closed(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'import time;time.sleep(30)\n')
   with patch.object(M,'observe',side_effect=ValueError('bad ps')):v=M.execute(r,p,Path(t),self.policy())
   self.assertFalse(v['complete']);self.assertEqual(v['stop_reason'],'process_group_observation_failed');self.assertTrue(v['containment']['no_live_members_remaining'])
 def test_group_rss_exceeded(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'import time;time.sleep(30)\n');original=M.observe;calls=[0]
   def observed(group,timeout):
    calls[0]+=1
    if calls[0]==1:return [{'pid':group,'ppid':os.getpid(),'pgid':group,'rss_bytes':2000000000,'state':'S'}]
    return original(group,timeout)
   with patch.object(M,'observe',side_effect=observed):v=M.execute(r,p,Path(t),self.policy())
   self.assertFalse(v['complete']);self.assertEqual(v['stop_reason'],'sampled_process_group_rss_exceeded');self.assertTrue(v['containment']['no_live_members_remaining'])
 def test_hash_mismatch_no_launch(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'raise AssertionError("must not launch")\n');r['pins'][0]['sha256']='0'*64;v=M.execute(r,p,Path(t),self.policy());self.assertFalse(v['complete']);self.assertIsNone(v['child_pid']);self.assertTrue(Path(t,'receipt.json').exists())
 def test_log_output_cap(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,"import pathlib,sys\np=pathlib.Path(sys.argv[1]);p.mkdir();(p/'result.json').write_text('{}');print('x'*10000)\n");v=M.execute(r,p,Path(t),self.policy(output_bytes=5000));self.assertFalse(v['complete']);self.assertIn('cap',v['stop_reason']);self.assertGreater(v['log_bytes']['stdout_log'],10000)
 def test_reserve_fails_before_launch(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'raise AssertionError("must not launch")\n')
   with patch.object(M.shutil,'disk_usage',return_value=SimpleNamespace(free=1)):v=M.execute(r,p,Path(t),self.policy(disk_reserve_bytes=2))
   self.assertFalse(v['complete']);self.assertIsNone(v['child_pid']);self.assertIn('reserve',v['stop_reason'])
 def test_parser_rss_and_zombie_separate(self):
  members=M.parse_ps('1 0 9 100 S\n2 1 9 0 Z\n3 1 8 200 S\n',9);self.assertEqual(sum(x['rss_bytes'] for x in members),102400);self.assertEqual(len(M.live(members)),1)
  for bad in ['oops','1 0 9 fail S','1 0 9 1 S\n1 0 9 1 S']:
   with self.assertRaises(ValueError):M.parse_ps(bad,9)
 def test_probe_deadline_and_nonzero(self):
  with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stderr='',stdout='1 0 1 1 S')) as f:M.observe(1,.2);self.assertGreater(f.call_args.kwargs['timeout'],0);self.assertLessEqual(f.call_args.kwargs['timeout'],.2)
  with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=1,stderr='',stdout='')):
   with self.assertRaises(ValueError):M.observe(1,.2)
 def test_transient_output_deleted(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'a').write_bytes(b'abc');self.assertEqual(M.output_size([p]),3)
 def test_structured_probe_failure(self):
  cases=[SimpleNamespace(returncode=7,stdout='',stderr='synthetic denied'),SimpleNamespace(returncode=0,stdout='1 0 1 nope S',stderr='')]
  for response in cases:
   with patch.object(M.subprocess,'run',return_value=response):
    with self.assertRaises(M.ObservationError) as raised:M.observe(1,.1)
   detail=raised.exception.diagnostic['failure'];self.assertEqual(detail['ps_return_code'],response.returncode);self.assertEqual(detail['ps_stderr'],response.stderr)
   if response.returncode==0:self.assertEqual(detail['first_invalid_metadata_row'],response.stdout)
 def test_observation_timeout_retains_type(self):
  with patch.object(M.subprocess,'run',side_effect=subprocess.TimeoutExpired('ps',.1,stderr='synthetic timeout')):
   with self.assertRaises(M.ObservationError) as raised:M.observe(1,.1)
  self.assertEqual(raised.exception.diagnostic['failure']['exception_type'],'TimeoutExpired')
 def test_output_freshness(self):
  with tempfile.TemporaryDirectory() as t:
   r,p=self.fixture(t,'');Path(r['output']).mkdir()
   with self.assertRaises(ValueError):M.paths_from_request(r,Path(t))
if __name__=='__main__':unittest.main()
