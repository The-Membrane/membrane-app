"""Mechanical invented observer requests only; no research payload or actual child."""
import importlib.util,json,signal,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('step_sampling_adapter',Path(__file__).with_name('q26-step-error-accounting-observer.py'))
A=importlib.util.module_from_spec(s);s.loader.exec_module(A)

class FakeChild:
 pid=999997
 def __init__(self):self.code=None
 def poll(self):return self.code
 def wait(self,timeout):
  if self.code is None:raise subprocess.TimeoutExpired('invented child',timeout)
  return self.code

class Sampling(unittest.TestCase):
 def fixture(self,root):
  root=Path(root).resolve();runner=root/'synthetic.py';runner.write_text('# invented; never executed\n')
  rp=A.pin(runner);out=root/'output.json';inner=root/'inner.json'
  A.O.exclusive(inner,dict(schema='q26-weighted-causal-primary-pair-saved-request-v1',parent_admitted=True,saved_only=True,out=str(out),invocation_python=sys.executable,resolved_python=str(Path(sys.executable).resolve()),pins=dict(implementation=rp)))
  ip=A.pin(inner);outer=root/'outer.json'
  A.O.exclusive(outer,dict(schema='q26-weighted-causal-primary-pair-observer-request-v1',kind='saved_check',fixture_only=True,inner_request=ip,runner=rp,source_pins=[rp],argv=[sys.executable,'-B',str(runner),'--request',str(inner),'--sha256',ip['sha256'],'--out',str(out)],output=str(out),policy=dict(A.POLICY,wall_seconds=2)))
  return outer,A.pin(outer)['sha256'],root/'terminal.json'

 def test_sample_timeout_propagates_to_failed_terminal_and_reaps(self):
  with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as root:
   args=self.fixture(root);child=FakeChild();calls=[]
   def sample(pid,timeout):
    calls.append(timeout)
    if len(calls)==1:raise subprocess.TimeoutExpired('/bin/ps',timeout)
    return dict(rss_bytes=0,live_members=[])
   def kill(pid,sig):child.code=-sig
   result=A.observe(*args,factory=lambda *a,**k:child,sample=sample,kill=kill)
   self.assertFalse(result['complete']);self.assertEqual(result['reason'],'TimeoutExpired');self.assertTrue(result['process_terminal']);self.assertTrue(result['containment']['reaped'])
   self.assertGreater(calls[0],.5);self.assertLessEqual(calls[0],2)
   original=args[2].read_bytes();tele=json.loads(Path(str(args[2])+'.sampling.json').read_bytes())
   self.assertEqual(tele['terminal'],A.pin(args[2]));self.assertEqual(args[2].read_bytes(),original)
   self.assertEqual(tele['sampling_failures'],1);self.assertEqual(tele['retries'],0);self.assertEqual(tele['cached_or_substituted_samples'],0)
   self.assertEqual(tele['samples'][0]['error_type'],'TimeoutExpired');self.assertFalse(tele['samples'][0]['success']);self.assertTrue(tele['samples'][1]['success'])
   self.assertEqual(Path(str(args[2])+'.sampling.json').stat().st_mode&0o777,0o600)

 def test_persistent_sampling_failure_never_claims_no_live_members(self):
  with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as root:
   args=self.fixture(root);child=FakeChild()
   def sample(pid,timeout):raise subprocess.TimeoutExpired('/bin/ps',timeout)
   result=A.observe(*args,factory=lambda *a,**k:child,sample=sample,kill=lambda pid,sig:setattr(child,'code',-sig))
   self.assertFalse(result['complete']);self.assertTrue(result['containment']['reaped']);self.assertFalse(result['containment']['no_live_members_remaining'])
   self.assertTrue(result['errors']);tele=json.loads(Path(str(args[2])+'.sampling.json').read_bytes());self.assertTrue(all(not r['success'] for r in tele['samples']))

 def test_expired_deadline_raises_without_observation_or_zero_fallback(self):
  calls=[];sampler=A._Sampler(10.,lambda *a,**k:calls.append(a))
  with patch.object(A.time,'monotonic',side_effect=[11.,11.1]):
   with self.assertRaises(subprocess.TimeoutExpired):sampler(7)
  self.assertEqual(calls,[]);self.assertEqual(sampler.records[0]['timeout_seconds'],0);self.assertFalse(sampler.records[0]['success'])

 def test_existing_addendum_refuses_before_child_start(self):
  with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as root:
   args=self.fixture(root);dest=Path(str(args[2])+'.sampling.json');dest.write_text('preserve')
   with self.assertRaisesRegex(ValueError,'fresh exclusive sampling addendum'):A.observe(*args,factory=lambda *a,**k:self.fail('child started'))
   self.assertEqual(dest.read_text(),'preserve');self.assertFalse(args[2].exists())

if __name__=='__main__':unittest.main()
