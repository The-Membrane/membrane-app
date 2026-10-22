"""Tiny synthetic subprocess and mechanical containment tests; no research inputs."""
import importlib.util,json,os,signal,subprocess,sys,tempfile,unittest
from pathlib import Path
S=importlib.util.spec_from_file_location('primary_pair_observer',str(Path(__file__).with_name('q26-weighted-causal-primary-pair-observer.py')))
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)
class ObserverTests(unittest.TestCase):
 def fixture(self,root,action='pass',wall=1.5,kind='producer'):
  root=Path(root).resolve();script=root/'synthetic.py';out=root/'output'
  script.write_text("from pathlib import Path\nimport sys,time\np=Path(sys.argv[-1]);p.mkdir(mode=0o700)\n(p/'synthetic.txt').write_text('fixture only')\n"+action+'\n')
  sp=M.pin(script);inner=root/'inner.json';inner.write_text(json.dumps(dict(schema='q26-weighted-causal-primary-pair-'+('run' if kind=='producer' else 'saved')+'-request-v1',parent_admitted=True,saved_only=kind=='saved_check',out=str(out),invocation_python=sys.executable,resolved_python=str(Path(sys.executable).resolve()),pins=dict(implementation=sp))))
  ip=M.pin(inner);outer=root/'observer.json';outer.write_text(json.dumps(dict(schema='q26-weighted-causal-primary-pair-observer-request-v1',fixture_only=True,kind=kind,inner_request=ip,runner=sp,source_pins=[sp],argv=[sys.executable,'-B',str(script),'--request',str(inner),'--sha256',ip['sha256'],'--out',str(out)],output=str(out),policy=dict(M.POLICY,wall_seconds=wall))))
  return outer,M.pin(outer)['sha256'],root/'terminal.json'
 def test_actual_synthetic_positive_is_saved_and_reaped(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d);v=M.observe(*args)
   self.assertTrue(v['complete']);self.assertEqual(v['tool_terminal_exit'],0);self.assertTrue(v['process_terminal']);self.assertTrue(v['containment']['no_live_members_remaining'])
   self.assertEqual(json.loads(args[2].read_bytes()),v);self.assertEqual(args[2].stat().st_mode&0o777,0o600)
 def test_actual_synthetic_nonzero_preserves_exit_status(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   v=M.observe(*self.fixture(d,'raise SystemExit(7)'))
   self.assertFalse(v['complete']);self.assertEqual(v['tool_terminal_exit'],7);self.assertEqual(v['reason'],'child_nonzero_exit');self.assertTrue(v['process_terminal'])
 def test_actual_synthetic_timeout_is_terminated_and_terminal_persisted(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d,'time.sleep(5)',.2);v=M.observe(*args)
   self.assertTrue(v['observer_timeout']);self.assertFalse(v['complete']);self.assertTrue(v['process_terminal']);self.assertIn(v['tool_terminal_exit'],(-signal.SIGTERM,-signal.SIGKILL));self.assertTrue(args[2].is_file())
 def test_preexisting_output_and_source_drift_refuse_before_start(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d);p=Path(d)/'output';p.mkdir();sentinel=p/'sentinel';sentinel.write_text('keep')
   with self.assertRaisesRegex(ValueError,'fresh exclusive'):M.observe(*args)
   self.assertEqual(sentinel.read_text(),'keep');self.assertFalse(Path(str(args[2])+'.start.json').exists())
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d);(Path(d)/'synthetic.py').write_text('changed')
   with self.assertRaisesRegex(ValueError,'pin mismatch'):M.observe(*args)
   self.assertFalse(Path(str(args[2])+'.start.json').exists())
 def test_saved_consumer_exact_command_tamper_refused_before_start(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d,kind='saved_check');M.preflight(*args)
   outer=json.loads(args[0].read_bytes());outer['argv'][-1]=str(Path(d)/'substituted-output')
   args[0].write_text(json.dumps(outer));sha=M.pin(args[0])['sha256']
   with self.assertRaisesRegex(ValueError,'exact request/SHA/output command binding'):M.observe(args[0],sha,args[2])
   self.assertFalse(Path(str(args[2])+'.start.json').exists());self.assertFalse((Path(d)/'output').exists())
 def test_signal_permission_failure_retains_explicit_unreaped_terminal(self):
  class Fake:
   pid=999999
   def poll(self):return None
   def wait(self,timeout):raise subprocess.TimeoutExpired('fake',timeout)
  def denied(*_):raise PermissionError('synthetic signal refusal')
  def live(*_,**__):return dict(rss_bytes=0,live_members=[999999])
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d,wall=.01);v=M.observe(*args,factory=lambda *a,**k:Fake(),sample=live,kill=denied)
   self.assertFalse(v['process_terminal']);self.assertIsNone(v['tool_terminal_exit']);self.assertFalse(v['containment']['reaped']);self.assertTrue(any('PermissionError'in e for e in v['errors']));self.assertTrue(args[2].is_file())
 def test_sigterm_during_constructor_defers_until_pid_retained(self):
  class Fake:
   pid=999998
   def poll(self):return 0
   def wait(self,timeout):return 0
  def construct(*a,**k):os.kill(os.getpid(),signal.SIGTERM);return Fake()
  signals=[]
  with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
   args=self.fixture(d);v=M.observe(*args,factory=construct,sample=lambda *a,**k:dict(rss_bytes=0,live_members=[]),kill=lambda pid,sig:signals.append((pid,sig)))
   self.assertEqual(v['child_pid'],999998);self.assertEqual(v['reason'],'InterruptedError');self.assertTrue(v['process_terminal']);self.assertFalse(v['complete']);self.assertTrue(signals);self.assertTrue(args[2].is_file())
if __name__=='__main__':unittest.main()
