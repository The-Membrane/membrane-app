"""Synthetic metadata/sealed-command transport only, never historical arrays.

Fake workers intentionally replace scientific authentication and computation.
Actual Q/S/O transport, sampling, failure containment and restoration are used.
"""
import copy
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('depth_observer_tested',Path(__file__).with_name('depth_observer.py'))
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)


class Admission(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='q26-depth-transport-');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        self.env=mock.patch.dict(os.environ,{'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1',
                                           'PYTHONDONTWRITEBYTECODE':'1','PYTHONOPTIMIZE':'0'})
        self.env.start();self.addCleanup(self.env.stop)
        self.runner=self.root/'depth_accounting.py'
        self.runner.write_text('import sys,json,pathlib,hashlib\np=json.load(open(sys.argv[sys.argv.index("--request")+1]))\no=pathlib.Path(p["out"]);o.mkdir()\n(o/"basis.npz").write_bytes(b"synthetic transport, not arrays")\n(o/"started.json").write_text(json.dumps(dict(schema="q26-fh-depth-accounting-started-v1",request_sha256=sys.argv[sys.argv.index("--request-sha256")+1],reconstruction=True)))\ndef pin(f):return dict(path=str(f),size=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest())\n(o/"result.json").write_text(json.dumps(dict(complete=True,request_sha256=sys.argv[sys.argv.index("--request-sha256")+1],request_pins=p["pins"],source=p["pins"]["source"],basis=pin(o/"basis.npz"),started=pin(o/"started.json"))))\n')
        self.checker_runner=self.root/'depth_check.py'
        self.checker_runner.write_text('import sys,json,pathlib\np=json.load(open(sys.argv[sys.argv.index("--request")+1]))\npathlib.Path(p["out"]).write_text(json.dumps(dict(complete=True,fixture_only=True)))\n')
        self.output=self.root/'new';self.receipt=self.root/'terminal.json';self.outer=self.root/'outer.json'
        self.freeze()

    def write(self,path,value):
        path.write_text(json.dumps(value));return D.O.pin(path)

    def save(self):
        self.sha=self.write(self.outer,self.value)['sha256']

    def freeze(self):
        helpers={}
        for name in ('audit','checker','support_module'):
            p=self.root/(name+'.py');p.write_text('# Synthetic sealed metadata helper; never executed.\n');helpers[name]=D.O.pin(p)
        self.sources=[D.O.pin(p.resolve()) for p in (Path(D.__file__),D.OLD_PATH,D.M.Q_PATH,Path(D.Q.S.__file__),Path(D.O.__file__),self.runner,self.checker_runner)]
        self.sources+=list(helpers.values())
        python=D.O.pin(Path(sys.executable).resolve())
        old=self.root/'old';old.mkdir(exist_ok=True)
        self.plan=self.write(self.root/'plan.json',dict(schema='q26-fh-date-support-plan-v1',parent_admitted=True,
            mode='NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT',row_capacity=200000,out=str(old),
            roles={'audit':helpers['audit'],'checker':helpers['checker']},legacy_sources={},files=self.sources+[python],
            runtime=dict(executable=python,python_version=sys.version.split()[0],
                         packages={k:importlib.metadata.version(k) for k in ('numpy','scipy','numba','llvmlite')},
                         env=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',PYTHONOPTIMIZE='0'))))
        (old/'witness.npz').write_bytes(b'synthetic opaque witness; preflight must not decode')
        witness=D.O.pin(old/'witness.npz')
        started=self.write(old/'started.json',dict(schema='q26-fh-date-support-started-v1',plan_sha256=self.plan['sha256'],reconstruction=True))
        result=self.write(old/'result.json',dict(schema='q26-fh-date-support-result-v1',complete=True,reconstruction=True,
            historical_bridge_parity='UNAVAILABLE',plan_sha256=self.plan['sha256'],summary={},witness=witness,started=started,source=helpers['audit']))
        acceptance=self.write(self.root/'old-acceptance.json',dict(schema='q26-fh-date-support-acceptance-v1',complete=True,
            reconstruction=True,historical_bridge_parity='UNAVAILABLE',plan_sha256=self.plan['sha256'],result_sha256=result['sha256'],
            checker_source=helpers['checker'],summary={}))
        support=self.write(self.root/'support-request.json',dict(schema='q26-fh-support-width-request-v1',
            pins=dict(plan=self.plan,result=result,acceptance=acceptance,witness=witness,started=started,implementation=helpers['support_module'],python=python),out=str(self.root/'old-width.json')))
        self.inner_body=dict(schema='q26-fh-depth-accounting-request-v1',pins=dict(plan=self.plan,result=result,acceptance=acceptance,
            witness=witness,started=started,audit=helpers['audit'],checker=helpers['checker'],source=D.O.pin(self.runner),python=python,
            support_module=helpers['support_module'],support_request=support),out=str(self.output))
        self.inner=self.write(self.root/'inner.json',self.inner_body)
        self.value=dict(schema=D.SCHEMA,kind='producer',fixture_only=True,policy=dict(D.POLICY,wall_seconds=2),
            invocation_python=sys.executable,resolved_python=str(Path(sys.executable).resolve()),python_pin=python,source_pins=self.sources,
            inner_request=self.inner,runner=D.O.pin(self.runner),output=str(self.output),
            argv=[sys.executable,'-B',str(self.runner),'--request',self.inner['path'],'--request-sha256',self.inner['sha256'],'--out',str(self.output)])
        self.save()

    def test_positive_metadata_admission_does_not_launch_or_decode(self):
        D.preflight(self.outer,self.sha,self.receipt)
        self.assertFalse(self.output.exists());self.assertFalse(self.receipt.exists())

    def test_wrong_command_source_policy_runtime_or_fixture_refuses(self):
        base=copy.deepcopy(self.value)
        for kind in ('argv','oldplanflag','source','wall','rss','python','kind','productionwall'):
            self.value=copy.deepcopy(base)
            if kind=='argv':self.value['argv']+=['--extra']
            elif kind=='oldplanflag':self.value['argv'][3]='--plan'
            elif kind=='source':self.value['source_pins']=self.value['source_pins'][1:]
            elif kind=='wall':self.value['policy']['wall_seconds']=3
            elif kind=='rss':self.value['policy']['rss_bytes']+=1
            elif kind=='python':self.value['resolved_python']='/wrong/python'
            elif kind=='kind':self.value['kind']='other'
            else:self.value['fixture_only']=False
            self.save()
            with self.subTest(kind=kind),self.assertRaises((ValueError,KeyError)):D.preflight(self.outer,self.sha,self.receipt)
        self.assertFalse(self.output.exists())

    def test_tampered_inner_pin_external_sha_or_noncanonical_output_refuses(self):
        old=copy.deepcopy(self.value)
        self.value['inner_request']['sha256']='0'*64;self.save()
        with self.assertRaises(ValueError):D.preflight(self.outer,self.sha,self.receipt)
        self.value=old;self.save();self.outer.write_text(self.outer.read_text()+' ')
        with self.assertRaises(ValueError):D.preflight(self.outer,self.sha,self.receipt)
        self.save();self.inner_body['out']=str(self.root/'unused'/'..'/'old'/'new.json')
        self.value['inner_request']=self.write(Path(self.inner['path']),self.inner_body)
        self.value['output']=self.inner_body['out'];self.value['argv'][-1]=self.inner_body['out'];self.value['argv'][-3]=self.value['inner_request']['sha256'];self.save()
        with self.assertRaises(ValueError):D.preflight(self.outer,self.sha,self.receipt)

    def test_all_seven_destinations_fresh_and_outside_old_inventory(self):
        targets=[self.output,self.receipt,Path(str(self.receipt)+'.start.json'),Path(str(self.receipt)+'.stdout.log'),
                 Path(str(self.receipt)+'.stderr.log'),Path(str(self.receipt)+'.sampling.json'),Path(str(self.receipt)+'.post-containment.json')]
        for target in targets:
            target.write_text('stale')
            with self.subTest(path=target),self.assertRaises(ValueError):D.preflight(self.outer,self.sha,self.receipt)
            target.unlink()
        oldroot=Path(self.inner_body['pins']['witness']['path']).parent
        with self.assertRaises(ValueError):D.preflight(self.outer,self.sha,oldroot/'terminal.json')

    def test_patch_restored_on_preflight_exception(self):
        original=D.Q.preflight
        with mock.patch.object(D.Q,'observe',side_effect=RuntimeError('synthetic preflight failure')):
            with self.assertRaises(RuntimeError):D.observe(self.outer,self.sha,self.receipt)
        self.assertIs(D.Q.preflight,original)

    def test_actual_cold_request_transport_success(self):
        original=D.Q.preflight
        result=D.observe(self.outer,self.sha,self.receipt)
        self.assertTrue(result['complete'],result);self.assertEqual(result['tool_terminal_exit'],0)
        self.assertTrue(result['containment']['reaped']);self.assertTrue(result['containment']['no_live_members_remaining'])
        self.assertTrue(Path(str(self.receipt)+'.sampling.json').is_file())
        self.assertIs(D.Q.preflight,original)

    def checker_admission_fixture(self):
        # Actual synthetic producer transport; no scientific computations/arrays.
        terminal=D.observe(self.outer,self.sha,self.receipt)
        self.assertTrue(terminal['complete'],terminal)
        outputpins={k:D.O.pin(self.output/filename) for k,filename in
                    [('result','result.json'),('basis','basis.npz'),('started','started.json')]}
        projection=dict(schema='q26-fh-depth-producer-terminal-v1',request=self.inner,argv=self.value['argv'],
            complete=True,exit_code=0,reaped=True,no_live_members=True,
            elapsed_seconds=terminal['elapsed_seconds'],charged_seconds=terminal['charged_seconds'],output_pins=outputpins)
        projectionpin=self.write(self.root/'projection.json',projection)
        old=self.inner_body['pins']
        cpins=dict(producer_request=self.inner,**outputpins,producer_source=old['source'],terminal=projectionpin,
            checker_source=D.O.pin(self.checker_runner),**{k:old[k] for k in
                ('python','support_module','support_request','plan','acceptance','witness','audit','checker')})
        checkoutput=self.root/'acceptance.json'
        inner=self.write(self.root/'check-inner.json',dict(schema='q26-fh-depth-check-request-v1',pins=cpins,out=str(checkoutput)))
        outer=copy.deepcopy(self.value)
        outer.update(kind='saved_check',inner_request=inner,runner=cpins['checker_source'],output=str(checkoutput),
            producer_observer_terminal=D.O.pin(self.receipt),argv=[sys.executable,'-B',str(self.checker_runner),'--request',inner['path'],'--request-sha256',inner['sha256']])
        path=self.root/'check-outer.json';sha=self.write(path,outer)['sha256']
        return path,sha,outer,projection

    def test_actual_saved_checker_request_transport_and_projection_tamper_refusals(self):
        path,sha,outer,projection=self.checker_admission_fixture()
        dest=self.root/'check-terminal.json'
        D.preflight(path,sha,dest)
        originalinner=json.loads(Path(outer['inner_request']['path']).read_text())
        validouter=copy.deepcopy(outer)
        for kind in ('elapsed','argv','reaped','outputs','fixture'):
            # Re-pin and prove a valid baseline before this isolated mutation.
            outer=copy.deepcopy(validouter)
            inner=copy.deepcopy(originalinner)
            inner['pins']['terminal']=self.write(self.root/'projection.json',projection)
            outer['inner_request']=self.write(Path(outer['inner_request']['path']),inner)
            outer['argv'][-1]=outer['inner_request']['sha256']
            sha=self.write(path,outer)['sha256']
            D.preflight(path,sha,dest)
            broken=copy.deepcopy(projection)
            if kind=='elapsed':broken['elapsed_seconds']+=1
            elif kind=='argv':broken['argv']=['wrong']
            elif kind=='reaped':broken['reaped']=False
            elif kind=='outputs':broken['output_pins']['basis']['sha256']='0'*64
            else:
                outer['fixture_only']=False;outer['policy']['wall_seconds']=30
            if kind!='fixture':
                inner=copy.deepcopy(originalinner)
                inner['pins']['terminal']=self.write(self.root/'projection.json',broken)
                outer['inner_request']=self.write(Path(outer['inner_request']['path']),inner)
                outer['argv'][-1]=outer['inner_request']['sha256']
            sha=self.write(path,outer)['sha256']
            reason='actual complete producer containment' if kind=='fixture' else 'projection of actual producer terminal'
            with self.subTest(kind=kind),self.assertRaisesRegex(ValueError,reason):D.preflight(path,sha,dest)
        projectionpin=self.write(self.root/'projection.json',projection)
        originalinner['pins']['terminal']=projectionpin
        outer['inner_request']=self.write(Path(outer['inner_request']['path']),originalinner)
        outer['argv'][-1]=outer['inner_request']['sha256'];outer['fixture_only']=True;outer['policy']['wall_seconds']=2
        sha=self.write(path,outer)['sha256']
        result=D.observe(path,sha,dest)
        self.assertTrue(result['complete'],result)
        self.assertTrue(Path(outer['output']).is_file())

    def test_actual_failure_transport_preserves_failed_terminal_and_cleanup(self):
        self.runner.write_text('import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\ntime.sleep(30)\n')
        self.freeze();self.value['policy']['wall_seconds']=1.2;self.save()
        original=D.Q.preflight;result=D.observe(self.outer,self.sha,self.receipt)
        self.assertFalse(result['complete']);self.assertIn(result['reason'],('wall_timeout','TimeoutExpired'))
        raw=self.receipt.read_bytes()
        if not (result['containment']['reaped'] is True and result['containment']['no_live_members_remaining'] is True):
            post=json.loads(Path(str(self.receipt)+'.post-containment.json').read_text())
            self.assertTrue(post['reaped']);self.assertTrue(post['no_live_members_remaining'])
        self.assertEqual(self.receipt.read_bytes(),raw);self.assertFalse(json.loads(raw)['complete'])
        self.assertIs(D.Q.preflight,original)


if __name__=='__main__':unittest.main()
