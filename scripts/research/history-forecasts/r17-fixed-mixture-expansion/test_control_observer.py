"""Synthetic metadata and actual qualified Q/S/O transport; no market archives."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('tested_original24_observer',Path(__file__).with_name('control_observer.py'))
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)


class Observer(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='q26-original24-observer-')
        self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
        self.inputs=self.root/'inputs';self.inputs.mkdir()
        self.runner=self.inputs/'fixture_producer.py'
        self.runner.write_text('import sys,json,pathlib,hashlib\n'
            'p=pathlib.Path(sys.argv[sys.argv.index("--request")+1]);q=json.loads(p.read_bytes())\n'
            'import os;assert all(os.environ.get(k)==v for k,v in q["runtime"]["environment"].items()), "sealed environment absent in actual child"\n'
            'o=pathlib.Path(q["out"]);o.mkdir()\n'
            'def pin(p):return dict(path=str(p),size=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())\n'
            'f=o/"synthetic.txt";f.write_text("opaque synthetic fixture")\n'
            '(o/"control-result.json").write_text(json.dumps(dict(schema="q26-original24-control-result-v1",complete=True,scope="ORIGINAL24_SAVED_REPLAY_CONTROL",request_sha256=sys.argv[sys.argv.index("--request-sha256")+1],source=pin(pathlib.Path(__file__)),full277_scientific_coverage=False,outputs=[pin(f)])))\n')
        self.checker=self.inputs/'fixture_checker.py'
        self.checker.write_text('import json;print(json.dumps(dict(complete=True,fixture_only=True)))\n')
        self.library=self.inputs/'fixture-native-library';self.library.mkdir()
        self.native=self.inputs/'synthetic-native.so';self.native.write_bytes(b'opaque byte closure only')
        self.inner_path=self.inputs/'inner.json';self.phase_path=self.inputs/'phase.json'
        self.outer_path=self.root/'outer.json';self.receipt=self.root/'receipt.json'
        self.output=self.root/'output'
        self.refresh()

    def write(self,path,value):
        path.write_text(json.dumps(value,allow_nan=False));return D.O.pin(path)

    def save(self):
        self.sha=self.write(self.outer_path,self.outer)['sha256']

    def refresh(self):
        python=D.O.pin(Path(sys.executable).resolve())
        sources=[D.O.pin(p.resolve()) for p in (Path(D.__file__),D.Q_PATH,Path(D.Q.S.__file__),Path(D.O.__file__),self.runner,self.checker)]
        runtime=[python,D.O.pin(self.native)]
        self.inner=dict(schema='q26-original24-control-observer-fixture-v1',status='READY_SYNTHETIC_OBSERVER_FIXTURE',
            scope='FIXTURE_ONLY',files=[*sources,*runtime],runtime=dict(executable=python,native_pins=runtime[1:],environment=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',DYLD_LIBRARY_PATH=str(self.library))),out=str(self.output))
        innerpin=self.write(self.inner_path,self.inner)
        self.phase=dict(schema='q26-original24-control-phase-v1',status='ADMITTED_PARENT_REVIEWED',scope=D.SCOPE,
            total_seconds=600,producer_seconds=240,checker_seconds=300,cleanup_seconds=60,started_unix=time.time())
        self.phase['deadline_unix']=self.phase['started_unix']+600
        phasepin=self.write(self.phase_path,self.phase)
        self.outer=dict(schema=D.SCHEMA,kind='producer',fixture_only=True,policy=dict(D.POLICY,wall_seconds=2),
            invocation_python=sys.executable,resolved_python=str(Path(sys.executable).resolve()),python_pin=python,
            source_pins=sources,runtime_pins=runtime,phase=phasepin,inner_request=innerpin,runner=D.O.pin(self.runner),
            argv=[sys.executable,'-B',str(self.runner),'--request',str(self.inner_path),'--request-sha256',innerpin['sha256']],output=str(self.output))
        self.save()

    def test_metadata_only_positive_preflight(self):
        D.preflight(self.outer_path,self.sha,self.receipt)
        self.assertFalse(self.output.exists());self.assertFalse(self.receipt.exists())

    def test_draft_phase_refuses_without_any_launch_artifact(self):
        self.phase['status']='DRAFT';self.outer['phase']=self.write(self.phase_path,self.phase);self.save()
        with mock.patch.object(D.subprocess,'Popen',side_effect=AssertionError('must not launch')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):D.observe(self.outer_path,self.sha,self.receipt)
        self.assertFalse(self.receipt.exists());self.assertFalse(self.output.exists())
        self.assertFalse(Path(str(self.receipt)+'.start.json').exists())

    def test_phase_deadline_cannot_reset_or_spend_cleanup(self):
        base=copy.deepcopy(self.phase)
        for age in (599,601):
            self.phase=copy.deepcopy(base);self.phase['started_unix']=time.time()-age
            self.phase['deadline_unix']=self.phase['started_unix']+600
            self.outer['phase']=self.write(self.phase_path,self.phase);self.save()
            with self.subTest(age=age),self.assertRaisesRegex(ValueError,'nonrenewable'):
                D.preflight(self.outer_path,self.sha,self.receipt)

    def test_external_sha_current_binary_native_and_self_pins(self):
        with self.assertRaises(ValueError):D.preflight(self.outer_path,'0'*64,self.receipt)
        base=copy.deepcopy(self.outer)
        for kind in ('binary','self','native','argv','runtime','fixed_wall','old_budget'):
            self.outer=copy.deepcopy(base)
            if kind=='binary':self.outer['python_pin']['sha256']='0'*64
            elif kind=='self':self.outer['source_pins']=self.outer['source_pins'][1:]
            elif kind=='native':self.outer['runtime_pins'][1]['sha256']='0'*64
            elif kind=='argv':self.outer['argv']+=['--out',str(self.output)]
            elif kind=='runtime':self.outer['resolved_python']='/wrong/current/python'
            elif kind=='fixed_wall':self.outer['policy']['wall_seconds']=240
            else:
                phase=copy.deepcopy(self.phase);phase['total_seconds']=1000
                self.outer['phase']=self.write(self.phase_path,phase)
            self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outer_path,self.sha,self.receipt)
        self.write(self.phase_path,self.phase)
        self.outer=base;self.save();self.native.write_bytes(b'changed native bytes')
        with self.assertRaises(ValueError):D.preflight(self.outer_path,self.sha,self.receipt)

    def test_inner_draft_fixture_flag_and_output_binding_refuse(self):
        base=copy.deepcopy(self.outer)
        for kind in ('draft','pretend_real','output'):
            self.outer=copy.deepcopy(base)
            if kind=='draft':
                inner=copy.deepcopy(self.inner);inner['status']='DRAFT'
                self.outer['inner_request']=self.write(self.inner_path,inner)
                self.outer['argv'][-1]=self.outer['inner_request']['sha256']
            elif kind=='pretend_real':
                self.outer['fixture_only']=False;self.outer['policy']['wall_seconds']=240
            else:self.outer['output']=str(self.root/'other-output')
            self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outer_path,self.sha,self.receipt)
            self.write(self.inner_path,self.inner)

    def test_seven_destinations_exclusive_and_input_roots_protected(self):
        targets=[self.output,self.receipt,*[Path(str(self.receipt)+s) for s in ('.start.json','.stdout.log','.stderr.log','.sampling.json','.post-containment.json')]]
        self.assertEqual(len(targets),7)
        for target in targets:
            target.write_text('stale')
            with self.subTest(target=target.name),self.assertRaises(ValueError):D.preflight(self.outer_path,self.sha,self.receipt)
            target.unlink()
        self.inner['out']=str(self.inputs/'illegal-output')
        self.outer['inner_request']=self.write(self.inner_path,self.inner)
        self.outer['argv'][-1]=self.outer['inner_request']['sha256'];self.outer['output']=self.inner['out'];self.save()
        with self.assertRaisesRegex(ValueError,'immutable'):D.preflight(self.outer_path,self.sha,self.inputs/'illegal-receipt')

    def test_preflight_override_restores_when_engine_raises(self):
        old=D.Q.preflight
        with mock.patch.object(D.Q,'observe',side_effect=RuntimeError('synthetic failure')):
            with self.assertRaises(RuntimeError):D.observe(self.outer_path,self.sha,self.receipt)
        self.assertIs(D.Q.preflight,old)

    def test_real_qualified_engine_success_and_sampling(self):
        old=D.Q.preflight;result=D.observe(self.outer_path,self.sha,self.receipt)
        self.assertTrue(result['complete'],result);self.assertEqual(result['tool_terminal_exit'],0)
        self.assertTrue(result['containment']['reaped']);self.assertTrue(result['containment']['no_live_members_remaining'])
        self.assertTrue(Path(str(self.receipt)+'.sampling.json').is_file());self.assertIs(D.Q.preflight,old)
        self.assertTrue((self.output/'control-result.json').is_file())

    def test_real_child_receives_sealed_native_environment(self):
        # O removes ambient DYLD; the narrow factory restores this exact pin-bound
        # value, and the actual generated producer asserts all declared values.
        seen=[]
        def factory(*args,**kwargs):
            seen.append(dict(kwargs['env']))
            return D.subprocess.Popen(*args,**kwargs)
        result=D.observe(self.outer_path,self.sha,self.receipt,factory=factory)
        self.assertTrue(result['complete'],result)
        self.assertEqual(seen[0]['DYLD_LIBRARY_PATH'],str(self.library))
        self.assertEqual(seen[0]['OMP_NUM_THREADS'],'1')

    def test_unrecognized_or_unthreaded_runtime_environment_refuses(self):
        base=copy.deepcopy(self.inner)
        for kind in ('injection','threads'):
            self.inner=copy.deepcopy(base)
            if kind=='injection':self.inner['runtime']['environment']['PYTHONPATH']='/unapproved'
            else:self.inner['runtime']['environment']['OMP_NUM_THREADS']='8'
            self.outer['inner_request']=self.write(self.inner_path,self.inner)
            self.outer['argv'][-1]=self.outer['inner_request']['sha256'];self.save()
            with self.subTest(kind=kind),self.assertRaisesRegex(ValueError,'runtime environment'):
                D.preflight(self.outer_path,self.sha,self.receipt)

    def saved_check(self):
        result=D.observe(self.outer_path,self.sha,self.receipt);self.assertTrue(result['complete'],result)
        self.producer_outer=copy.deepcopy(self.outer)
        terminal=D.O.pin(self.receipt);manifest=D.O.pin(self.output/'control-result.json')
        phase=dict(self.phase,producer_terminal=terminal,producer_manifest=manifest)
        self.outer=copy.deepcopy(self.outer)
        self.outer.update(kind='saved_check',runner=D.O.pin(self.checker),output=str(self.root/'unused-check-output'),
            phase=self.write(self.inputs/'check-phase.json',phase),producer_observer_terminal=terminal,producer_manifest=manifest,
            argv=[sys.executable,'-B',str(self.checker),'--request',str(self.inner_path),'--request-sha256',self.outer['inner_request']['sha256'],
                  '--result',manifest['path'],'--result-sha256',manifest['sha256']])
        self.outer_path=self.root/'check-outer.json';self.receipt=self.root/'check-receipt.json';self.save()
        return phase

    def test_real_saved_checker_requires_external_actual_producer(self):
        self.saved_check();D.preflight(self.outer_path,self.sha,self.receipt)
        result=D.observe(self.outer_path,self.sha,self.receipt)
        self.assertTrue(result['complete'],result)
        self.assertIn('fixture_only',Path(str(self.receipt)+'.stdout.log').read_text())

    def test_checker_rejects_reservation_instead_of_external_completed_producer(self):
        phase=self.saved_check();base=copy.deepcopy(self.outer)
        for kind in ('missing_phase_evidence','unbound_manifest','nonclean_terminal','charge','producer_argv','reset_clock','producer_policy'):
            self.outer=copy.deepcopy(base);ph=copy.deepcopy(phase)
            if kind=='missing_phase_evidence':ph.pop('producer_terminal')
            elif kind=='unbound_manifest':ph['producer_manifest']['sha256']='0'*64
            elif kind=='reset_clock':
                ph['started_unix']+=0.1;ph['deadline_unix']+=0.1
            else:
                term=json.loads(Path(base['producer_observer_terminal']['path']).read_bytes())
                if kind=='nonclean_terminal':term['containment']['no_live_members_remaining']=False
                elif kind=='charge':term['charged_seconds']=241
                else:
                    producer=copy.deepcopy(self.producer_outer)
                    if kind=='producer_policy':producer['policy']['rss_bytes']+=1
                    else:producer['argv']+=['--out','unexpected']
                    term['request']=self.write(self.inputs/'bad-producer-request.json',producer)
                pin=self.write(self.inputs/'bad-terminal.json',term)
                self.outer['producer_observer_terminal']=pin;ph['producer_terminal']=pin
            self.outer['phase']=self.write(self.inputs/'modified-check-phase.json',ph);self.save()
            with self.subTest(kind=kind),self.assertRaises(ValueError):D.preflight(self.outer_path,self.sha,self.receipt)

    def test_actual_deadline_failure_keeps_failed_terminal_and_reaps(self):
        self.runner.write_text('import time;time.sleep(30)\n');self.refresh()
        self.outer['policy']['wall_seconds']=0.5;self.save()
        old=D.Q.preflight;result=D.observe(self.outer_path,self.sha,self.receipt)
        self.assertFalse(result['complete']);self.assertIn(result['reason'],('wall_timeout','TimeoutExpired'))
        terminal=self.receipt.read_bytes()
        if result['containment']['no_live_members_remaining'] is not True:
            post=json.loads(Path(str(self.receipt)+'.post-containment.json').read_bytes())
            self.assertTrue(post['reaped']);self.assertTrue(post['no_live_members_remaining'])
        else:self.assertTrue(result['containment']['reaped'])
        self.assertEqual(self.receipt.read_bytes(),terminal)
        self.assertFalse(json.loads(terminal)['complete']);self.assertIs(D.Q.preflight,old)

    def test_actual_output_cap_failure_preserves_failure_receipt(self):
        self.runner.write_text('import sys,json,pathlib\np=json.load(open(sys.argv[sys.argv.index("--request")+1]));o=pathlib.Path(p["out"]);o.mkdir();(o/"bulk").write_bytes(b"x"*(33554432+1))\n')
        self.refresh();result=D.observe(self.outer_path,self.sha,self.receipt)
        self.assertFalse(result['complete']);self.assertEqual(result['reason'],'output_cap_failed')
        self.assertTrue(result['containment']['no_live_members_remaining'])
        self.assertFalse(json.loads(self.receipt.read_bytes())['complete'])


if __name__=='__main__':unittest.main()
