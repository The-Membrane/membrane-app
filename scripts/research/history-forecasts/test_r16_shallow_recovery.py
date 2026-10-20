"""Small synthetic tests. No producer imports, Torch, raw inputs or historical fits."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('r16_shallow_recovery.py'))
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)


class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.root = self.directory/'source'; self.root.mkdir()
        self.board = self.directory/'board'; self.board.mkdir()
        self.versions = dict(pip='25.0.1', numpy='2.5.4', torch='2.14.1', **{f'pkg{i}': '1' for i in range(27)})
        self.sources = {}
        for i in range(32):
            relative = f'original{i:02d}.py'; path = self.root/relative; path.write_text(f'VALUE = {i}\n')
            self.sources[relative] = dict(bytes=path.stat().st_size, sha256=R.sha(path))
        manifest = self.put('board/'+R.STEM+'.manifest.json', dict(immutableSourcePins=self.sources))
        audit = self.put('board/'+R.STEM+'.portability.json', dict(runtime=dict(mac_base=dict(packages=list(map(list, self.versions.items()))))))
        for name, value in [('ROOT', self.root), ('BOARD', self.board), ('ANCHORS', {'manifest': manifest['sha256'], 'portability': audit['sha256']})]:
            p = patch.object(R, name, value); p.start(); self.addCleanup(p.stop)

    def put(self, relative, value):
        return R.write_new(self.directory/relative, value)

    def certificate(self):
        inputs = {key: self.put(key+'.json', {'complete': True}) for key in R.SLOTS['generation']}
        exp = self.put('experiment.json', {key: value['path'] for key, value in inputs.items()})
        request = self.put('request.json', dict(schema='r16-shallow-operational-certificate-request-v1', stage='generation', predecessor=None, experiment_request=exp))
        def semantic_gate(stage, experiment, bindings):
            self.assertEqual(stage, 'generation')
            self.assertEqual(bindings, {name: inputs[key]['sha256'] for name, key in zip(R.CONSTANTS[stage], R.SLOTS[stage])})
            for value in inputs.values():
                if R.check(value).get('complete') is not True: raise ValueError('completion fails')
            return list(inputs.values())
        with patch.object(R, 'certificate_gate', side_effect=semantic_gate) as gate:
            result = R.freeze_certificate(request['path'], self.directory/'certificate.json')
            self.assertEqual(gate.call_count, 1)
        return result, inputs

    def test_clone_executes_same_original_semantic_checks_without_constant_mutation(self):
        module = types.ModuleType('original')
        exec("ACCEPTED_SHA = 'historical'\ncalls = []\ndef gate(receipt):\n calls.append(receipt)\n if receipt['hash'] != ACCEPTED_SHA: raise ValueError('hash')\n if receipt['rows'] != 3 or receipt['complete'] is not True: raise ValueError('semantic')\n return receipt['rows']\n", module.__dict__)
        original = module.gate
        cloned = R.clone(original, {'ACCEPTED_SHA': 'fresh'})
        self.assertIs(cloned.__code__, original.__code__)
        self.assertEqual(cloned(dict(hash='fresh', rows=3, complete=True)), 3)
        with self.assertRaises(ValueError): cloned(dict(hash='fresh', rows=2, complete=True))
        with self.assertRaises(ValueError): original(dict(hash='fresh', rows=3, complete=True))
        self.assertEqual(module.ACCEPTED_SHA, 'historical'); self.assertEqual(len(module.calls), 3)
        with self.assertRaises(ValueError): R.clone(original, {'NONEXISTENT_GATE': 'x'})

    def test_fresh_certificate_passes_then_altered_receipt_and_source_fail(self):
        certificate, inputs = self.certificate()
        value = R.load_certificate(certificate['path'], certificate['sha256'])
        self.assertEqual(value['stage'], 'generation')
        receipt = Path(next(iter(inputs.values()))['path']); old = receipt.read_bytes()
        receipt.write_text('{"complete":false}')
        with self.assertRaises(ValueError): R.load_certificate(certificate['path'], certificate['sha256'])
        receipt.write_bytes(old)
        path = self.root/'original00.py'; path.write_text('VALUE = 99\n')
        with self.assertRaises(ValueError): R.load_certificate(certificate['path'], certificate['sha256'])

    def test_certificate_tampering_rehashed_bindings_and_stage_skip_rejected(self):
        certificate, _ = self.certificate(); path = Path(certificate['path']); original = path.read_bytes()
        value = R.read(path); value['bindings']['PARITY_SCOPE_SHA'] = 'a'*64
        path.write_text(__import__('json').dumps(value))
        with self.assertRaises(ValueError): R.load_certificate(path, certificate['sha256'])
        with self.assertRaises(ValueError): R.load_certificate(path, R.sha(path))
        path.write_bytes(original)
        request = self.put('skip.json', dict(schema='r16-shallow-operational-certificate-request-v1', stage='allocation', predecessor=certificate, experiment_request=value['experiment_request']))
        with self.assertRaises(ValueError): R.freeze_certificate(request['path'], self.directory/'skipped.json')

    def test_scope_requires_certificate_or_explicit_ancestry(self):
        certificate, _ = self.certificate(); value = R.load_certificate(certificate['path'], certificate['sha256'])
        scope = self.put('scope.json', {'operational_recovery': certificate})
        R.scope_certificate(scope['path'], value, certificate)
        wrong = self.put('wrong-scope.json', {'operational_recovery': dict(certificate, sha256='0'*64)})
        with self.assertRaises(ValueError): R.scope_certificate(wrong['path'], value, certificate)

    def runtime(self):
        records = {name: self.put('records/'+name+'.json', {}) for name in self.versions}
        native = [self.put('native.json', {})]
        cpu = dict(complete=True, synthetic_only=True, historical_inputs=False, optimizer_steps=0,
                   numpy_shared_roundtrip=True, torch_threads=1, torch_interop_threads=8,
                   models=[dict(model=m, finite_forward_backward=True, residual_baseline_equal=True if m!='nmlp0' else None) for m in R.MODELS])
        current = dict(base=dict(packages=list(map(list, self.versions.items())), platform='test-platform', machine='test-machine'),
                       torch_version='2.14.1', torch_threads=1, torch_interop_threads=8)
        census = dict(complete=True, package_inventory=self.versions, record_pins=records, native_pins=native,
                      executable=sys.executable, prefix=sys.prefix, base_prefix=sys.base_prefix, python=sys.version,
                      platform='test-platform', machine='test-machine', torch='2.14.1', numpy='2.5.4',
                      torch_threads=1, torch_interop_threads=8, historical_fits=0, prior_historical_proofs_recreated=False)
        install = [dict(metadata=dict(name=n, version=v), download_info=dict(url='https://example.invalid/'+n+'.whl', archive_info=dict(hashes=dict(sha256='a'*64)))) for n,v in self.versions.items() if n!='pip']
        requirements = self.directory/'requirements.txt'; requirements.write_text(''.join(f'{n}=={v}\n' for n,v in self.versions.items()))
        pip_check = self.directory/'pip-check.txt'; pip_check.write_text('No broken requirements found.\n')
        parts = dict(census=self.put('census.json', census), cpu_probe=self.put('cpu.json', cpu),
                     requirements=R.pin(requirements), pip_check=R.pin(pip_check),
                     resolve_report=self.put('resolve.json', {'install':install}), install_reports=[self.put('install.json', {'install':install[:6]})])
        return parts, current, lambda: (self.versions, records, native)

    def test_fresh_runtime_29_resolved_plus_bootstrap_30_actual(self):
        parts, current, provider = self.runtime()
        versions, records, native, wheels = R.runtime_parts(parts, current, provider)
        self.assertEqual(len(versions), 30); self.assertEqual(len(records), 30)
        self.assertEqual(len(wheels), 29); self.assertNotIn('pip', wheels)
        self.assertEqual(len(native), 1)

    def test_runtime_altered_probe_inventory_record_or_install_metadata_rejected(self):
        parts, current, provider = self.runtime()
        for key, mutate in [('cpu_probe', lambda d:d.update(optimizer_steps=1)),
                             ('census', lambda d:d['record_pins'].pop('pip')),
                             ('resolve_report', lambda d:d['install'].pop()),
                             ('install_reports', lambda d:d['install'][0]['metadata'].update(version='999'))]:
            p = parts[key][0] if key=='install_reports' else parts[key]
            original = Path(p['path']).read_bytes(); data = R.read(p['path']); mutate(data)
            Path(p['path']).write_text(__import__('json').dumps(data)); changed = R.pin(p['path'])
            altered = dict(parts); altered[key] = [changed] if key=='install_reports' else changed
            with self.subTest(key=key), self.assertRaises((ValueError, KeyError)):
                R.runtime_parts(altered, current, provider)
            Path(p['path']).write_bytes(original)
        bad = dict(current, base=dict(current['base'], packages=current['base']['packages']+[('pip','25.0.1')]))
        with self.assertRaises(ValueError): R.runtime_parts(parts, bad, provider)

    def test_actual_census_bytes_schema_and_strict_bad_pin_rejection(self):
        parts, current, provider = self.runtime()
        census = R.read(parts['census']['path'])
        def as_bytes(value): return dict(path=value['path'], bytes=value['size'], sha256=value['sha256'])
        census['record_pins'] = {k:as_bytes(v) for k,v in census['record_pins'].items()}
        census['record_pins']['Pkg0'] = census['record_pins'].pop('pkg0')
        census['native_pins'] = [as_bytes(v) for v in census['native_pins']]
        path = Path(parts['census']['path']); path.write_text(__import__('json').dumps(census))
        parts['census'] = R.pin(path)
        self.assertEqual(len(R.runtime_parts(parts, current, provider)[1]), 30)
        sample = next(iter(census['record_pins'].values()))
        self.assertEqual(R.normalized_pin(sample)['size'], sample['bytes'])
        with self.assertRaises(ValueError): R.normalized_records({'Pkg0':sample, 'pkg0':sample})
        for bad in [dict(sample, bytes=sample['bytes']+1), dict(sample, size=sample['bytes']), dict(sample, bytes=True)]:
            with self.assertRaises(ValueError): R.normalized_pin(bad)
        native_path = Path(census['native_pins'][0]['path']); native_path.write_text('changed native payload')
        with self.assertRaises(ValueError): R.runtime_parts(parts, current, provider)

    def test_runtime_wrapper_meets_original_verifier_direct_probe_fields(self):
        import ast
        parts, current, provider = self.runtime()
        versions, records, native, wheels = R.runtime_parts(parts, current, provider)
        request = self.put('fresh-runtime.json', dict(schema='r16-shallow-fresh-runtime-request-v1', parts=parts))
        protocol = types.SimpleNamespace(runtime=lambda:current)
        with patch.dict(sys.modules, {'r16_shallow_nn_protocol':protocol}), patch.object(R, 'runtime_parts', return_value=(versions,records,native,wheels)):
            R.freeze_runtime(request['path'], self.directory/'proof')
            scope = self.directory/'proof/scope.json'; probe = self.directory/'proof/probe.json'
            manifest = self.directory/'proof/manifest.json'
            original_request = dict(runtime_probe_path=str(probe), runtime_install_manifest_path=str(manifest), runtime_install_scope_path=str(scope))
            R.fresh_runtime_proof(original_request, current)
            tree = ast.parse(Path(R.__file__).with_name('r16_shallow_nn_independent.py').read_text())
            fields = {n.slice.value for n in ast.walk(tree) if isinstance(n,ast.Subscript) and isinstance(n.value,ast.Name) and n.value.id=='probe' and isinstance(n.slice,ast.Constant)}
            self.assertEqual(fields, {'numpy_version'})
            value = R.read(probe)
            for field in fields: self.assertIn(field, value)
            self.assertEqual(value['numpy_version'], '2.5.4')
            value['numpy_version'] = 'wrong'; probe.write_text(__import__('json').dumps(value))
            m = R.read(manifest); m['probe'] = R.pin(probe); manifest.write_text(__import__('json').dumps(m))
            with self.assertRaises(ValueError): R.fresh_runtime_proof(original_request,current)

    def test_original_full_allocation_admission_positive_and_rehashed_contradictions(self):
        import ast, hashlib, json, math
        original = Path(R.__file__).with_name('r16_shallow_nn_independent.py')
        tree = ast.parse(original.read_text())
        names = {'fail','sha','unique','load','integer','monitor_admission','allocation_admission','Pins'}
        selected = [n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
        namespace = dict(Path=Path,hashlib=hashlib,json=json,np=types.SimpleNamespace(isfinite=math.isfinite),ROOT=self.root)
        exec(compile(ast.Module(body=selected,type_ignores=[]),str(original),'exec'),namespace)
        verifier = types.SimpleNamespace(**{k:namespace[k] for k in names})
        def fixture(label, mutation=None):
            out = self.directory/label; out.mkdir()
            scope = self.put(label+'/scope.json',dict(phase='allocation',out=str(out),source_sha256=self.sources,evidence=dict(datasets=str(self.directory/'raw'))))
            digest = scope['sha256']; ledger=dict(total=0,attempts=[])
            child = dict(complete=True,phase='allocation',scope_sha256=digest,allocation_only=True,neural_fits=0,audit_violations=ledger)
            start = dict(phase='allocation',scope_sha256=digest,child_pid=77,child_pgid=77)
            actual = dict(status='allocation-only-before-first-make_model',neural_fits=0,completed=False,scope_sha256=digest,first_membership=dict(membership={'ordered':'original'},tsplit_float=12.5))
            monitor = dict(complete=True,phase='allocation',scope_sha256=digest,child_exit=0,failure=None,child_pid=77,peak_sampled_child_rss_bytes=1,elapsed_seconds=0.25)
            independent = dict(complete=True,scope_sha256=digest,source_pins_verified=32,neural_fits=0,first_model_constructed=False,audit_violations=0,hardlink_inputs_verified=5,first_cell_membership_verified={'ordered':'original'},tsplit_float=12.5)
            if mutation: mutation(child,monitor,actual,independent)
            child_pin=self.put(label+'/child.json',child); self.put(label+'/monitor-start.json',start)
            monitor['child_receipt']=child_pin; monitor_pin=self.put(label+'/monitor.json',monitor)
            actual_pin=self.put(label+'/allocation.json',actual)
            independent.update(child_sha256=child_pin['sha256'],monitor_sha256=monitor_pin['sha256'],allocation_sha256=actual_pin['sha256'])
            independent_pin=self.put(label+'/independent.json',independent)
            request=dict(allocation_scope_path=scope['path'],allocation_scope_sha256=digest,allocation_receipt_path=actual_pin['path'],parent_verified_allocation_independent_receipt=independent_pin)
            req=self.put(label+'/fit-request.json',request)
            return req,request,R.read(scope['path'])
        req,request,ancestor=fixture('positive')
        evidence=R.allocation_admission(req['path'],request,ancestor,verifier)
        self.assertIn(str(self.directory/'positive/monitor-start.json'),{p['path'] for p in evidence})
        mutations=[lambda c,m,a,i:i.update(scope_sha256='f'*64),lambda c,m,a,i:m.update(child_exit=1),
                   lambda c,m,a,i:c.update(neural_fits=20),lambda c,m,a,i:a['first_membership'].update(tsplit_float=13.5),
                   lambda c,m,a,i:c.update(audit_violations=dict(total=1,attempts=['denied']))]
        for n,mutation in enumerate(mutations):
            req,request,ancestor=fixture('bad'+str(n),mutation)
            with self.subTest(case=n), self.assertRaises(ValueError): R.allocation_admission(req['path'],request,ancestor,verifier)

    def test_original_pin_walker_metadata_boundary_keeps_payload_checks(self):
        import ast, hashlib, json
        source=Path(R.__file__).with_name('r16_shallow_nn_independent.py')
        tree=ast.parse(source.read_text()); names={'fail','sha','unique','load','Pins'}
        nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
        ns=dict(Path=Path,hashlib=hashlib,json=json,ROOT=self.root)
        exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),ns)
        anchor=self.put('historical-anchor.json',{'lost':dict(path=str(self.directory/'missing.bin'),size=3,sha256='a'*64)})
        with self.assertRaises(ValueError): ns['Pins'](self.directory/'raw').walk(anchor)
        metadata=dict(path=anchor['path'],bytes=anchor['size'],sha256=anchor['sha256'])
        payload=self.directory/'payload.bin'; payload.write_bytes(b'new')
        proof=self.put('fresh-proof.json',{'payload':R.pin(payload)})
        registry=ns['Pins'](self.directory/'raw'); registry.walk(dict(metadata=metadata,proof=proof))
        self.assertNotIn(anchor['path'],registry.entries)
        self.assertIn(str(payload),registry.entries)
        payload.write_bytes(b'bad')
        with self.assertRaises(ValueError): registry.recheck()
        _,_,published=R.anchors()
        self.assertTrue(all(set(v)=={'path','bytes','sha256'} for v in published.values()))
        published_path=Path(published['manifest']['path']); published_path.write_text(published_path.read_text()+' ')
        with self.assertRaises(ValueError): R.anchors()

    def test_nn_phase_and_original_resource_policies_are_exact(self):
        request=dict(phase='allocation',resource_policy=dict(wall_seconds=28800,grace_seconds=30,rss_bytes=2500000000),score_resource_policy=dict(wall_seconds=3600,grace_seconds=30,rss_bytes=2500000000))
        R.nn_request('allocation', request)
        with self.assertRaises(ValueError): R.nn_request('fit', request)
        for key in ('resource_policy','score_resource_policy'):
            changed=dict(request); changed[key]=dict(request[key],rss_bytes=2500000001)
            with self.assertRaises(ValueError): R.nn_request('allocation', changed)

    def test_exact_child_argv_rewrite_preserves_tail_env_and_ps_forwarding(self):
        calls=[]; observed=[]
        real=types.SimpleNamespace(Popen=lambda command,*a,**k:calls.append((list(command),k)), run=lambda *a,**k:'ps forwarded')
        proxy=R.ChildProxy(real, self.directory/'certificate.json', 'b'*64, lambda *a:observed.append(a))
        command=[sys.executable,str(Path(R.__file__).with_name('r16_shallow_nn_runner.py')),'_child','--scope','/scope.json','--scope-sha256','c'*64,'--out','/out']
        original=list(command); env={'OMP_NUM_THREADS':'1'}
        proxy.Popen(command, env=env, start_new_session=True)
        self.assertEqual(command[-7:], original[2:]); self.assertEqual(command[2], 'invoke')
        self.assertEqual(calls[0][0], command); self.assertIs(calls[0][1]['env'], env)
        self.assertEqual(observed,[('/scope.json','c'*64,'/out')]); self.assertEqual(proxy.run(['ps']), 'ps forwarded')
        for wrong in [original+['unexpected'], tuple(original), [*original[:2],'unknown',*original[3:]], ['other-python',*original[1:]]]:
            with self.assertRaises(ValueError): proxy.Popen(wrong)
        self.assertEqual(len(calls),1)


if __name__ == '__main__': unittest.main()
