import tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import monitor as M
import test_monitor as helpers

def sample(rows,outside=0):return {'members':M.parse_ps('\n'.join(rows),9),'unknown_outside_group_count':outside}
class UnknownObservationTests(unittest.TestCase):
 def test_unknown_is_live_and_rss_none(self):
  rows=M.parse_ps('1 0 9 0 ?\n2 1 9 0 Z',9);self.assertIsNone(rows[0]['rss_bytes']);self.assertFalse(rows[0]['rss_qualified']);self.assertEqual(len(M.live(rows)),1)
  for bad in ['1 0 9 bad ?','1 0 9 0 ??','1 0 9 0 ?123']:
   with self.assertRaises(ValueError):M.parse_ps(bad,9)
 def test_fresh_recovery_no_stale_merge(self):
  a=sample(['1 0 9 100 S','2 1 9 0 ?']);b=sample(['1 0 9 200 S','2 1 9 300 S'])
  with patch.object(M,'census',side_effect=[a,b]) as f:members=M.observe(9,1)
  self.assertEqual(sum(x['rss_bytes'] for x in members),500*1024);self.assertEqual(f.call_count,2);meta=members.observation_metadata;self.assertTrue(meta['recovered_unknown']);self.assertIsNone(meta['attempts'][0]['total_rss_bytes']);self.assertEqual(meta['attempts'][0]['known_rss_subtotal_lower_bound'],100*1024)
 def test_unknown_disappearance_fresh_group(self):
  with patch.object(M,'census',side_effect=[sample(['1 0 9 100 S','2 1 9 0 ?']),sample(['1 0 9 200 S'])]):members=M.observe(9,1)
  self.assertEqual([m['pid'] for m in members],[1]);self.assertEqual(sum(m['rss_bytes'] for m in members),200*1024)
 def test_max3_including_initial(self):
  with patch.object(M,'census',return_value=sample(['1 0 9 100 S','2 1 9 0 ?'])) as f:
   with self.assertRaises(M.ObservationError) as raised:M.observe(9,1)
  self.assertEqual(f.call_count,3);self.assertEqual(len(raised.exception.diagnostic['attempts']),3);self.assertIsNone(raised.exception.diagnostic['total_rss_bytes'])
 def test_unknown_outside_does_not_retry(self):
  with patch.object(M,'census',return_value=sample(['1 0 9 100 S'],outside=3)) as f:members=M.observe(9,1)
  self.assertEqual(f.call_count,1);self.assertEqual(members.observation_metadata['attempts'][0]['unknown_outside_group_count'],3)
 def test_other_failure_not_retried(self):
  with patch.object(M,'census',side_effect=M.ObservationError('bad numeric',{'ps_return_code':0})) as f:
   with self.assertRaises(M.ObservationError):M.observe(9,1)
  self.assertEqual(f.call_count,1)
 def test_shared_deadline_includes_pause(self):
  with patch.object(M,'census',return_value=sample(['1 0 9 0 ?'])) as f:
   with self.assertRaises(M.ObservationError):M.observe(9,.002)
  self.assertEqual(f.call_count,1);self.assertLessEqual(f.call_args.args[1],.002)
 def test_lower_bound_cap_stops_before_later_low(self):
  high=sample(['1 0 9 1000001 S','2 1 9 0 ?']);low=sample(['1 0 9 1 S'])
  with patch.object(M,'census',side_effect=[high,low]) as f:
   with self.assertRaises(M.ObservationError) as raised:M.observe(9,1)
  self.assertEqual(f.call_count,1);self.assertEqual(raised.exception.diagnostic['reason'],'known_rss_lower_bound_exceeded');self.assertIsNone(raised.exception.diagnostic['total_rss_bytes']);self.assertGreater(raised.exception.diagnostic['attempts'][0]['known_rss_subtotal_lower_bound'],M.POLICY['rss_bytes'])
 def test_cap_breach_survives_terminal_leader(self):
  from unittest.mock import MagicMock
  helper=helpers.MonitorTests()
  with tempfile.TemporaryDirectory() as t:
   r,p=helper.fixture(t,'not executed');child=MagicMock();child.pid=123;child.returncode=0;child.poll.side_effect=[None,0,0]
   def created(*a,**kw):
    out=Path(r['output']);out.mkdir();(out/'result.json').write_text('{}');return child
   attempt={'unknown_owned_count':1,'unknown_owned_metadata':[],'unknown_outside_group_count':0,'known_rss_subtotal_lower_bound':1000000001,'total_rss_bytes':None}
   error=M.ObservationError('known high',{'reason':'known_rss_lower_bound_exceeded','attempts':[attempt],'attempted_ps_probes':1})
   cleanup={'no_live_members_remaining':True,'remaining_live_members':[],'remaining_zombies':[],'errors':[]}
   with patch.object(M.subprocess,'Popen',side_effect=created),patch.object(M,'observe',side_effect=error),patch.object(M,'cleanup',return_value=cleanup):v=M.execute(r,p,Path(t),helper.policy())
   self.assertFalse(v['complete']);self.assertEqual(v['exit_code'],0);self.assertEqual(v['stop_reason'],'sampled_process_group_rss_lower_bound_exceeded');self.assertEqual(v['peak_sampled_known_rss_lower_bound_bytes'],1000000001);self.assertEqual(v['peak_sampled_process_group_rss_bytes'],0);self.assertEqual(v['complete_census_count'],0);self.assertIsNone(v['peak_complete_census_rss_bytes']);self.assertIsNone(v['unknown_observation_summary']['peak_complete_census_rss_bytes'])
 def test_owned_child_runtime_recovery_fixture(self):
  # Actual group/child census, with only the first state/RSS deliberately made unknown.
  helper=helpers.MonitorTests();original=M.census;seen=[False];counts=[]
  with tempfile.TemporaryDirectory() as t:
   r,p=helper.fixture(t,"import pathlib,subprocess,sys,time\np=pathlib.Path(sys.argv[1]);p.mkdir();c=subprocess.Popen(['/bin/sleep','2']);(p/'result.json').write_text('{}');time.sleep(.25)\n")
   def injected(group,timeout):
    value=original(group,timeout);counts.append(len(value['members']))
    if not seen[0] and value['members']:
     seen[0]=True;first=value['members'][0];first.update(state='?',rss_bytes=None,rss_qualified=False,reported_rss_bytes=0)
    return value
   with patch.object(M,'census',side_effect=injected):v=M.execute(r,p,Path(t),helper.policy())
   self.assertTrue(v['complete'],v);self.assertTrue(v['containment']['no_live_members_remaining']);self.assertTrue(seen[0]);self.assertGreaterEqual(max(counts),2);self.assertGreaterEqual(v['unknown_observation_summary']['recovered_samples'],1)
if __name__=='__main__':unittest.main()
