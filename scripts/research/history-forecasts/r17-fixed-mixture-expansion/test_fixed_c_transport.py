"""Generated fixed-C admission/actual qualified subprocess tests; no market launch."""
import copy
import importlib.util
import json
import os
import py_compile
from pathlib import Path
import sys
import tempfile
import time
import unittest
import types
from unittest import mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('_test_fixed_c_observer',HERE/'fixed_c_observer.py')
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)
spec=importlib.util.spec_from_file_location('_test_fixed_c_run',HERE/'fixed_c_run.py')
R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R)


class Transport(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='q26-full277-transport-');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.inputs=self.root/'inputs';self.inputs.mkdir()
        self.lib=self.inputs/'native-lib';self.lib.mkdir()
        self.worker=self.inputs/'generated_worker.py'
        self.worker.write_text('import json,sys,pathlib,hashlib,os\n'
            'q=json.load(open(sys.argv[sys.argv.index("--request")+1]));assert all(os.environ.get(k)==v for k,v in q["runtime"]["environment"].items())\n'
            'mode=sys.argv[sys.argv.index("--mode")+1]\n'
            'if mode=="produce":\n'
            ' o=pathlib.Path(q["out"]);o.mkdir();(o/"manifest.json").write_text(json.dumps(dict(schema="q26-full277-fixed-c-transport-fixture-result-v1",complete=True,fixture_only=True,request_sha256=sys.argv[sys.argv.index("--request-sha256")+1])))\n'
            'else:\n'
            ' p=pathlib.Path(sys.argv[sys.argv.index("--manifest")+1]);assert hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[sys.argv.index("--manifest-sha256")+1];assert json.loads(p.read_bytes())["fixture_only"] is True;print(json.dumps(dict(complete=True,fixture_only=True)))\n')
        self.innerpath=self.inputs/'inner.json';self.outerpath=self.root/'outer.json'
        self.receipt=self.root/'terminal.json';self.output=self.root/'generated-output'
        self.refresh()

    def write(self,path,value):path.write_text(json.dumps(value,allow_nan=False));return D.O.pin(path)
    def save(self):self.sha=self.write(self.outerpath,self.outer)['sha256']

    def refresh(self):
        python=D.O.pin(Path(sys.executable).resolve())
        sources=[D.O.pin(p.resolve()) for p in (Path(D.__file__),D.OLD_PATH,D.P.OLD_PATH,D.M.Q_PATH,Path(D.Q.S.__file__),Path(D.O.__file__),HERE/'fixed_c_run.py',self.worker)]
        self.inner=dict(schema='q26-full277-fixed-c-transport-fixture-v1',status='READY_SYNTHETIC_OBSERVER_FIXTURE',scope='FIXTURE_ONLY',
            files=[*sources,python],runtime=dict(executable=python,native_pins=[],environment=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',DYLD_LIBRARY_PATH=str(self.lib))),out=str(self.output))
        inner=self.write(self.innerpath,self.inner)
        start=time.time();self.phase=dict(schema='q26-full277-fixed-c-phase-v1',status='ADMITTED_PARENT_REVIEWED',scope=D.SCOPE,
            **D.BUDGET,started_unix=start,deadline_unix=start+3720)
        phase=self.write(self.inputs/'phase.json',self.phase)
        self.outer=dict(schema=D.SCHEMA,kind='producer',fixture_only=True,policy=dict(D.POLICY,wall_seconds=2),
            invocation_python=sys.executable,resolved_python=python['path'],python_pin=python,source_pins=sources,runtime_pins=[python],
            phase=phase,inner_request=inner,runner=D.O.pin(self.worker),output=str(self.output))
        self.outer['argv']=D.runner_argv(self.outer,'produce');self.save()

    def test_real_scope_paths_allow_historical_receipt_siblings(self):
        # Historical observer receipts live beside future job directories. Their
        # exact paths are immutable, while the shared evidence parent is writable.
        old_receipt=self.root/'original24.observer.json'
        old_receipt.write_text('immutable historical terminal')
        frozen=self.inputs/'source.py';frozen.write_text('# authenticated source')
        files=[D.O.pin(old_receipt),D.O.pin(frozen)]
        fresh=self.root/'new-full277'
        R.protect_targets([fresh,self.root/'new-full277.observer.json'],files,{self.inputs})
        for target in (old_receipt,self.root,self.inputs/'new-output'):
            with self.subTest(target=target.name),self.assertRaises(ValueError):
                R.protect_targets([target],files,{self.inputs})
        self.assertEqual(old_receipt.read_text(),'immutable historical terminal')

    def test_frozen_finder_lifetime_covers_numerical_body_and_failure(self):
        finder=object();sys.meta_path.insert(0,finder)
        def component_load(*args):
            self.assertIn(finder,sys.meta_path)
            raise RuntimeError('generated authenticated component failure')
        q={'pins':{'preparation_check':{}}}
        alias=sys.modules.get('control_check')
        with mock.patch.object(R,'authenticate',return_value=(q,None,None,None,None,{})), \
             mock.patch.object(R.P,'science_context',return_value=(None,None,None,None,None,None,None,finder)), \
             mock.patch.object(R,'load',side_effect=component_load):
            with self.assertRaisesRegex(RuntimeError,'generated authenticated component failure'):
                R.execute('unused','unused',mode='produce')
        if alias is None:sys.modules.pop('control_check',None)
        else:sys.modules['control_check']=alias
        self.assertNotIn(finder,sys.meta_path)

    def test_real_checker_output_contract_rejects_a_different_sibling(self):
        # Isolate the path contract after mocked scientific metadata admission;
        # this is not a full277 fixture or an empirical execution.
        evidence=self.write(self.inputs/'generated-parent-evidence.json',{'fixture_only':True})
        phase=dict(self.phase,producer_terminal=evidence,producer_manifest=evidence,producer_stdout=evidence)
        self.outer.update(kind='saved_check',fixture_only=False,
            policy=dict(D.POLICY,wall_seconds=1800),runner=D.O.pin(HERE/'fixed_c_run.py'),
            producer_observer_terminal=evidence,producer_manifest=evidence,producer_stdout=evidence,
            phase=self.write(self.inputs/'check-phase.json',phase),output=str(self.root/'WRONG-check-sibling'))
        self.outer['argv']=D.runner_argv(self.outer,'check');self.save()
        metadata=types.SimpleNamespace(CHECK_ROOT=self.root/'correct-check-sibling',
            authenticate=lambda *a,**k:(self.inner,None,None,None,None,None),
            protected_roots=lambda *a:{self.inputs},protect_targets=R.protect_targets)
        with mock.patch.object(D,'load_run',return_value=metadata), \
             mock.patch.object(D,'producer_binding',return_value=self.output):
            with self.assertRaisesRegex(ValueError,'fixed saved-check write/resource-accounting root'):
                D.preflight(self.outerpath,self.sha,self.receipt)
        self.assertFalse(self.receipt.exists())

    def test_zeroJ_unknown_and_strict_support_are_not_loading_filters(self):
        self.assertFalse(R.needs_raw_series({'rows':{'24':0}}))
        for markers in ({'J_n':0},{'unknown_n':1,'known_n':0},{'historical_support':0}):
            self.assertTrue(R.needs_raw_series(dict(rows={'24':1},**markers)))
        for bad in (True,-1,1462):
            with self.assertRaises(ValueError):R.needs_raw_series({'rows':{'24':bad}})

    def test_actual_strict_support_failure_cannot_become_successful_manifest(self):
        self.worker.write_text('raise ValueError("empty historical state")\n');self.refresh()
        result=D.observe(self.outerpath,self.sha,self.receipt)
        self.assertFalse(result['complete']);self.assertNotEqual(result['tool_terminal_exit'],0)
        self.assertFalse((self.output/'manifest.json').exists())
        self.assertIn('empty historical state',Path(str(self.receipt)+'.stderr.log').read_text())

    def test_metadata_only_admission(self):
        D.preflight(self.outerpath,self.sha,self.receipt)
        self.assertFalse(self.output.exists());self.assertFalse(self.receipt.exists())

    def test_draft_production_request_refuses_before_any_science_load(self):
        q=self.write(self.inputs/'real-draft.json',dict(schema='q26-full277-fixed-c-request-v1',status='DRAFT'))
        with mock.patch.object(R,'load',side_effect=AssertionError('no science load')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):R.authenticate(q['path'],q['sha256'],mode='produce')

    def test_phase_draft_expired_cleanup_and_old_budget_refuse(self):
        for kind in ('draft','expired','cleanup','old_budget'):
            phase=copy.deepcopy(self.phase)
            if kind=='draft':phase['status']='DRAFT'
            elif kind=='old_budget':phase['total_seconds']=600
            else:
                phase['started_unix']=time.time()-(3721 if kind=='expired' else 3600)
                phase['deadline_unix']=phase['started_unix']+3720
            self.outer['phase']=self.write(self.inputs/'phase.json',phase);self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outerpath,self.sha,self.receipt)

    def test_outer_sha_runtime_source_and_exact_argv_refuse(self):
        with self.assertRaises(ValueError):D.preflight(self.outerpath,'0'*64,self.receipt)
        base=copy.deepcopy(self.outer)
        for kind in ('source','binary','argv','policy','fixture'):
            self.outer=copy.deepcopy(base)
            if kind=='source':self.outer['source_pins']=self.outer['source_pins'][1:]
            elif kind=='binary':self.outer['python_pin']['sha256']='0'*64
            elif kind=='argv':self.outer['argv']+=['--out',str(self.output)]
            elif kind=='policy':self.outer['policy']['output_bytes']+=1
            else:self.outer['fixture_only']=False;self.outer['policy']['wall_seconds']=1800
            self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outerpath,self.sha,self.receipt)

    def test_seven_exclusive_destinations(self):
        targets=[self.output,self.receipt,*[Path(str(self.receipt)+s) for s in ('.start.json','.stdout.log','.stderr.log','.sampling.json','.post-containment.json')]]
        for target in targets:
            target.write_text('stale')
            with self.subTest(target=target.name),self.assertRaises(ValueError):D.preflight(self.outerpath,self.sha,self.receipt)
            target.unlink()

    def test_actual_q_s_o_producer_and_sealed_environment(self):
        old=D.Q.preflight;result=D.observe(self.outerpath,self.sha,self.receipt)
        self.assertTrue(result['complete'],result);self.assertIs(D.Q.preflight,old)
        self.assertTrue(result['containment']['reaped']);self.assertTrue(result['containment']['no_live_members_remaining'])
        self.assertTrue(Path(str(self.receipt)+'.sampling.json').exists())
        self.assertTrue((self.output/'manifest.json').exists())

    def checker(self):
        result=D.observe(self.outerpath,self.sha,self.receipt);self.assertTrue(result['complete'],result)
        self.producer_outer=copy.deepcopy(self.outer)
        terminal=D.O.pin(self.receipt);manifest=D.O.pin(self.output/'manifest.json')
        stdout=D.O.pin(Path(str(self.receipt)+'.stdout.log'))
        self.checkphase=dict(self.phase,producer_terminal=terminal,producer_manifest=manifest,producer_stdout=stdout)
        self.outer.update(kind='saved_check',producer_observer_terminal=terminal,producer_manifest=manifest,producer_stdout=stdout,
            phase=self.write(self.inputs/'check-phase.json',self.checkphase),output=str(self.root/'unused-check-output'))
        self.outer['argv']=D.runner_argv(self.outer,'check')
        self.outerpath=self.root/'check-outer.json';self.receipt=self.root/'check-terminal.json';self.save()

    def test_actual_checker_conditional_on_parent_pinned_completed_producer(self):
        self.checker();result=D.observe(self.outerpath,self.sha,self.receipt)
        self.assertTrue(result['complete'],result)
        self.assertIn('fixture_only',Path(str(self.receipt)+'.stdout.log').read_text())

    def test_checker_rejects_reset_clock_nonclean_or_unbound_evidence(self):
        self.checker();base=copy.deepcopy(self.outer)
        for kind in ('clock','notclean','manifest','argv','budget'):
            self.outer=copy.deepcopy(base);phase=copy.deepcopy(self.checkphase)
            if kind=='clock':phase['started_unix']-=1;phase['deadline_unix']-=1
            elif kind=='manifest':phase['producer_manifest']['sha256']='0'*64
            else:
                terminal=json.loads(Path(base['producer_observer_terminal']['path']).read_bytes())
                if kind=='notclean':terminal['containment']['reaped']=False
                else:
                    original=copy.deepcopy(self.producer_outer)
                    if kind=='argv':original['argv']+=['--extra']
                    else:original['policy']['wall_seconds']=5
                    terminal['request']=self.write(self.inputs/'bad-producer.json',original)
                tp=self.write(self.inputs/'bad-terminal.json',terminal)
                self.outer['producer_observer_terminal']=tp;phase['producer_terminal']=tp
            self.outer['phase']=self.write(self.inputs/'modified-check-phase.json',phase);self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outerpath,self.sha,self.receipt)

    def test_actual_timeout_failure_receipt_and_containment(self):
        self.worker.write_text('import time;time.sleep(30)\n');self.refresh();self.outer['policy']['wall_seconds']=0.5;self.save()
        result=D.observe(self.outerpath,self.sha,self.receipt);self.assertFalse(result['complete'])
        raw=self.receipt.read_bytes()
        if result['containment']['no_live_members_remaining'] is not True:
            post=json.loads(Path(str(self.receipt)+'.post-containment.json').read_bytes())
            self.assertTrue(post['reaped']);self.assertTrue(post['no_live_members_remaining'])
        else:self.assertTrue(result['containment']['reaped'])
        self.assertEqual(self.receipt.read_bytes(),raw);self.assertFalse(json.loads(raw)['complete'])

    def test_preflight_override_restored_on_error(self):
        old=D.Q.preflight
        with mock.patch.object(D.Q,'observe',side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError):D.observe(self.outerpath,self.sha,self.receipt)
        self.assertIs(D.Q.preflight,old)

    def test_authenticated_loader_ignores_stale_bytecode(self):
        p=self.inputs/'module.py'
        stale=('answer="STALE"').ljust(100)+'\n'
        fresh=('answer="AUTHENTICATED_FRESH"').ljust(100)+'\n'
        p.write_text(stale);stamp=p.stat().st_mtime_ns
        py_compile.compile(str(p),doraise=True)
        p.write_text(fresh);os.utime(p,ns=(stamp,stamp))
        module=R.load(D.O.pin(p),'_q26_generated_byte_load')
        self.assertEqual(module.answer,'AUTHENTICATED_FRESH')
        self.assertEqual(module.__file__,str(p))


if __name__=='__main__':unittest.main()
