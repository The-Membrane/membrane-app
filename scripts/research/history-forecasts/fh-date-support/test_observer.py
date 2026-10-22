"""Admission failures and real cold containment, using synthetic children only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('fh_date_observer_tests', Path(__file__).with_name('observer.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class Admission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='q26-fh-observer-')
        self.root = Path(self.tmp.name).resolve()
        self.runner = self.root / 'audit.py'
        self.runner.write_text('import sys,json,pathlib\np=json.load(open(sys.argv[sys.argv.index("--plan")+1]))\npathlib.Path(p["out"]).mkdir()\n')
        self.out = self.root / 'out'
        self.terminal = self.root / 'terminal.json'
        self.plan = self.root / 'plan.json'
        self.request = self.root / 'request.json'
        self.freeze()

    def tearDown(self):
        self.tmp.cleanup()

    def freeze(self):
        sources = [M.O.pin(p.resolve()) for p in (Path(M.__file__), M.Q_PATH, Path(M.Q.S.__file__), Path(M.O.__file__), self.runner)]
        py = M.O.pin(Path(sys.executable).resolve())
        self.plan.write_text(json.dumps(dict(schema='q26-fh-date-support-plan-v1', parent_admitted=True,
            mode='NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT', files=sources+[py], roles=dict(audit=sources[-1]), out=str(self.out))))
        self.value = dict(schema=M.SCHEMA, kind='producer', fixture_only=True,
            policy=dict(M.POLICY,wall_seconds=2),invocation_python=sys.executable,
            resolved_python=str(Path(sys.executable).resolve()),python_pin=py,source_pins=sources,
            plan=M.O.pin(self.plan),runner=sources[-1],output=str(self.out))
        self.value['argv']=[sys.executable,'-B',str(self.runner),'--plan',str(self.plan),'--plan-sha256',self.value['plan']['sha256']]
        self.save()

    def save(self):
        self.request.write_text(json.dumps(self.value))
        self.sha = M.O.pin(self.request)['sha256']

    def preflight(self):
        return M.preflight(self.request,self.sha,self.terminal)

    def test_valid_admission_does_not_launch(self):
        self.preflight()
        self.assertFalse(self.out.exists())
        self.assertFalse(self.terminal.exists())

    def test_policy_argv_and_source_rejections(self):
        original=copy.deepcopy(self.value)
        for change in ('wall','rss','argv','source','kind','python'):
            self.value=copy.deepcopy(original)
            if change=='wall':self.value['fixture_only']=False;self.value['policy']['wall_seconds']=61
            if change=='rss':self.value['policy']['rss_bytes']+=1
            if change=='argv':self.value['argv']+=['--extra']
            if change=='source':self.value['source_pins']=self.value['source_pins'][1:]
            if change=='kind':self.value['kind']='alternate'
            if change=='python':self.value['resolved_python']='/not/the/python'
            self.save()
            with self.assertRaises((ValueError,KeyError)):
                self.preflight()
        self.assertFalse(self.out.exists())

    def test_changed_runner_and_stale_or_symlink_destination(self):
        self.runner.write_text('changed')
        with self.assertRaises(ValueError):self.preflight()
        self.freeze()
        self.out.mkdir()
        with self.assertRaises(ValueError):self.preflight()
        self.out.rmdir();self.out.symlink_to(self.root/'missing')
        with self.assertRaises(ValueError):self.preflight()

    def test_external_request_hash(self):
        self.request.write_text(self.request.read_text()+' ')
        with self.assertRaises(ValueError):self.preflight()

    def test_completed_producer_frozen_identity_and_fixture_cannot_substitute(self):
        plan=json.loads(self.plan.read_text())
        plan['roles']['checker']=plan['roles']['audit']
        self.plan.write_text(json.dumps(plan));self.value['plan']=M.O.pin(self.plan)
        self.value['argv'][-1]=self.value['plan']['sha256']
        producer=copy.deepcopy(self.value)
        self.out.mkdir()
        result=self.out/'result.json'
        result.write_text(json.dumps(dict(complete=True,plan_sha256=self.value['plan']['sha256'])))
        original_path=self.root/'producer-request.json'
        terminal_path=self.root/'producer-terminal.json'
        saved=copy.deepcopy(producer)
        saved.update(kind='saved_check',output=str(self.root/'acceptance.json'),
                     producer_root=str(self.out),producer_result=M.O.pin(result))
        saved['argv']+=['--result',str(result),'--receipt',saved['output']]
        def bind(original,terminal_changes=None,current_changes=None):
            original_path.write_text(json.dumps(original))
            terminal=dict(schema='q26-weighted-causal-primary-pair-observer-terminal-v1',
                request=M.O.pin(original_path),complete=True,tool_terminal_exit=0,process_terminal=True,
                observer_timeout=False,reason=None,errors=[],fixture_only=True,runner=producer['runner'],
                containment=dict(reaped=True,no_live_members_remaining=True))
            terminal.update(terminal_changes or {})
            terminal_path.write_text(json.dumps(terminal))
            self.value=copy.deepcopy(saved);self.value['producer_terminal']=M.O.pin(terminal_path)
            self.value.update(current_changes or {});self.save()
        bind(producer);self.preflight()
        for field,value in [('schema','other'),('fixture_only',False),('argv',['wrong']),('source_pins',[]),
                            ('policy',dict(M.POLICY,wall_seconds=61)),('runner',dict(producer['runner'],sha256='0'*64))]:
            with self.subTest(field=field):
                bad=copy.deepcopy(producer);bad[field]=value;bind(bad)
                with self.assertRaises(ValueError):self.preflight()
        for changes in ({'fixture_only':False},{'errors':['observation failed']},{'observer_timeout':True},
                        {'process_terminal':False},{'runner':{}},{'schema':'other'}):
            bind(producer,changes)
            with self.assertRaises(ValueError):self.preflight()
        # Regression: a tiny fixture producer cannot admit a real saved checker.
        bind(producer,current_changes=dict(fixture_only=False,policy=dict(M.POLICY,wall_seconds=30)))
        with self.assertRaises(ValueError):self.preflight()

    def test_cold_success(self):
        result=M.observe(self.request,self.sha,self.terminal)
        self.assertTrue(result['complete'],result)
        self.assertEqual(result['tool_terminal_exit'],0)
        self.assertTrue(result['containment']['reaped'])
        self.assertTrue(result['containment']['no_live_members_remaining'])
        self.assertTrue(Path(str(self.terminal)+'.sampling.json').is_file())

    def test_cold_descendant_deadline_or_observation_failure_is_contained(self):
        self.runner.write_text('import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\ntime.sleep(30)\n')
        self.freeze();self.value['policy']['wall_seconds']=1.2;self.save()
        result=M.observe(self.request,self.sha,self.terminal)
        self.assertFalse(result['complete'])
        self.assertIn(result['reason'],('wall_timeout','TimeoutExpired'))
        if result['reason']=='TimeoutExpired':
            self.assertIn('observer:TimeoutExpired',result['errors'])
        terminal_bytes=self.terminal.read_bytes()
        # A separate post-containment appendix can establish cleanup without rewriting failure.
        self.assertEqual(json.loads(terminal_bytes)['complete'],False)
        appendix=Path(str(self.terminal)+'.post-containment.json')
        if not (result['containment']['reaped'] is True and result['containment']['no_live_members_remaining'] is True):
            self.assertTrue(appendix.is_file())
            post=json.loads(appendix.read_text())
            self.assertTrue(post['reaped'])
            self.assertTrue(post['no_live_members_remaining'])
            self.assertIsNone(post['error_type'])
        self.assertEqual(self.terminal.read_bytes(),terminal_bytes)


if __name__=='__main__':
    unittest.main()
