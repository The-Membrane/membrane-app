"""Synthetic fixtures only. Historical observations are never loaded."""
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import r164_baseline_replay as B

class ReplayFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'rows.npz'
        self.key = 'blind5:synthetic'
        np.savez(self.path, name=self.key, base_ts=0, levels=np.array([-.1, -.2], dtype=np.float32),
            t0_i=[672, 673], T_h=[72, 168], k_i=[0, 1])
        self.ser = SimpleNamespace(close=np.full(675, 100.), low=np.full(675, 99.), base_ts=0)
        self.pool = np.array([[.2, -.4], [-.3, -.3]])
        self.saved = dict(series=self.key, complete=True, quarters=[dict(quarter=2,
            model=dict(w=.1, alpha=.1, gamma=.1, beta=.7), training_variance=.2,
            filter_initial_variance=.2, quarter_h=.3, pool={'sha256': 'synthetic'})],
            origins=[dict(origin=o, quarter=2, h0=.3) for o in (672,673)])
        self.old = dict(quarter_fits=1, rows=[
            dict(series=self.key, i0=672, T=72, k=0, p_garch=.2),
            dict(series=self.key, i0=673, T=168, k=1, p_garch=.7)])
        self.calls = []
        def simulate(*args, **kwargs):
            self.calls.append((args, kwargs))
            return np.array([[.1,.2],[.2,.3],[.6,.7],[.8,.9]])
        def forbidden(*a, **kw):
            raise AssertionError('fit or asof_state called')
        self.G = SimpleNamespace(GJR=lambda **kw: SimpleNamespace(**kw), simulate_hourly=simulate,
            filter_variance=lambda r,m,h: np.full(len(r)+1,h), fit_gjr=forbidden, asof_state=forbidden)
        self.P = SimpleNamespace(reconstruct_pool=lambda *a: (self.pool.copy(),.2,.3),
            pool_descriptor=lambda p: {'sha256':'synthetic'})
        self.R = SimpleNamespace(EVAL_T=(24,72,168,720), series_seed=lambda key: 123)
        self.folds = [dict(qs_i=2,qe_i=675)]
    def replay(self):
        return B.replay_series(self.key,self.ser,self.folds,self.saved,self.old,self.path,self.G,self.P,self.R)
    def test_original_kernel_args_full_horizons_seed_pool(self):
        result,totals=self.replay()
        self.assertEqual(totals,dict(quarters=1,origins=2,historical_rows=2))
        self.assertEqual([r['p_replay'] for r in result['rows']],[.2,.7])
        self.assertEqual(len(self.calls),2)
        for origin,(args,kwargs) in zip((672,673),self.calls):
            self.assertEqual(args[1],.3)
            with np.load(self.path) as z:
                np.testing.assert_array_equal(args[2],np.log1p(z['levels'].astype(float)))
            self.assertIs(args[3],self.R.EVAL_T)
            self.assertEqual(args[4:],(1000,[9,123,origin]))
            self.assertEqual(set(kwargs),{'pool'})
            np.testing.assert_array_equal(kwargs['pool'],self.pool)
    def test_headerless_result_and_matching_optional_header(self):
        self.assertEqual(set(self.old),{'quarter_fits','rows'})
        self.replay()
        self.old['series']=self.key
        self.replay()
    def test_contradictory_header_and_missing_wrong_row_series(self):
        self.old['series']='blind5:wrong'
        with self.assertRaisesRegex(ValueError,'contradictory historical'): self.replay()
        del self.old['series']
        del self.old['rows'][0]['series']
        with self.assertRaisesRegex(ValueError,'mandatory historical row series'): self.replay()
        self.old['rows'][0]['series']='blind5:wrong'
        with self.assertRaisesRegex(ValueError,'mandatory historical row series'): self.replay()
    def test_row_order(self):
        self.old['rows'].reverse()
        self.assertEqual([r['i0'] for r in self.replay()[0]['rows']],[673,672])
    def test_one_ulp_fails(self):
        self.old['rows'][0]['p_garch']=float(np.nextafter(.2,1.))
        with self.assertRaisesRegex(ValueError,'exact original prediction mismatch'): self.replay()
    def test_nonfinite_original(self):
        for value in (None,float('nan'),float('inf'),-.1,True):
            self.old['rows'][0]['p_garch']=value
            with self.subTest(value=value),self.assertRaises(ValueError): self.replay()
    def test_saved_state_drift(self):
        for container,field,value in ((self.saved['quarters'][0],'training_variance',.21),
            (self.saved['quarters'][0],'pool',{}),(self.saved['quarters'][0],'quarter_h',.31),
            (self.saved['origins'][0],'h0',.31),(self.saved['origins'][0],'quarter',3)):
            old=container[field];container[field]=value
            with self.assertRaises(ValueError): self.replay()
            container[field]=old
    def test_duplicate_missing_support(self):
        self.old['rows'].append(copy.deepcopy(self.old['rows'][0]))
        with self.assertRaisesRegex(ValueError,'unique historical'): self.replay()
        self.old['rows'].pop();self.saved['origins'].pop()
        with self.assertRaisesRegex(ValueError,'origin support'): self.replay()
    def test_npz_identity_and_support(self):
        np.savez(self.path,name='wrong',base_ts=0,levels=[-.1],t0_i=[672],T_h=[72],k_i=[0])
        with self.assertRaisesRegex(ValueError,'NPZ identity'): self.replay()
        np.savez(self.path,name=self.key,base_ts=0,levels=[-.1],t0_i=[672],T_h=[72],k_i=[0])
        with self.assertRaisesRegex(ValueError,'support absent'): self.replay()
    def test_no_shortened_horizons(self):
        self.R.EVAL_T=(72,168)
        with self.assertRaisesRegex(ValueError,'full horizon'): self.replay()
    def test_bad_simulator_values(self):
        for data in (np.full((4,2),np.nan),np.ones((3,2)),np.full((4,2),1.1)):
            self.G.simulate_hourly=lambda *a,**kw:data
            with self.assertRaises(ValueError): self.replay()
    def test_clock_and_fold_overlap(self):
        self.ser.base_ts=86400
        with self.assertRaisesRegex(ValueError,'origin selection'): self.replay()
        self.ser.base_ts=0;self.folds*=2
        with self.assertRaisesRegex(ValueError,'unique quarter'): self.replay()

class AuthorityFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
    def test_hash_before_decode(self):
        path=self.root/'bad.json';path.write_text('{')
        with patch.object(B.json,'loads',side_effect=AssertionError('decoded first')):
            with self.assertRaisesRegex(ValueError,'external plan hash'): B.authenticate(path,'0'*64)
    def test_record_hash_size_symlink(self):
        path=self.root/'file';path.write_text('original');item=B.record(path);B.verify_record(item)
        path.write_text('changed!')
        with self.assertRaises(ValueError): B.verify_record(item)
        link=self.root/'link';link.symlink_to(path)
        with self.assertRaises(ValueError): B.record(link)
        item=B.record(path);item['size']=True
        with self.assertRaises(ValueError): B.verify_record(item)
    def test_existing_output_before_reads(self):
        out=self.root/'out';out.mkdir()
        with patch.object(B,'authenticate',side_effect=AssertionError('read first')):
            with self.assertRaisesRegex(ValueError,'fresh exclusive'): B.run(self.root/'missing',out,'0'*64)
    def test_exclusive_json(self):
        out=self.root/'out.json';B.write_json(out,{'complete':False})
        with self.assertRaises(FileExistsError): B.write_json(out,{'complete':True})
        self.assertEqual(json.loads(out.read_text()),{'complete':False})

class CompleteAuthorityFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.sources=self.root/'sources';self.sources.mkdir()
        self.names=('r164_baseline_replay.py','r164_baseline_replay_check.py')
        for n in self.names: (self.sources/n).write_text('# synthetic source '+n)
        self.patchers=[patch.object(B,'HERE',self.sources),patch.object(B,'SOURCES',self.names)]
        for p in self.patchers: p.start();self.addCleanup(p.stop)
        self.raw=self.root/'data'/'blind5-prices';self.raw.mkdir(parents=True)
        (self.raw/'synthetic.txt').write_text('synthetic')
        self.hist=self.root/'historical';self.hist.mkdir()
        self.states=self.root/'states';self.states.mkdir()
        npz=self.root/'data'/'history-forecasts/r16/r164-dev-63d4700f/rows';npz.mkdir(parents=True)
        self.keys=sorted('blind5:synthetic'+str(i) for i in range(42))
        self.inputs={};outputs={}
        for key in self.keys:
            name=key.replace(':','-')+'.json'
            B.write_json(self.hist/name,{'derived_provenance':{'synthetic':True},'result':{'quarter_fits':1,'rows':[dict(series=key,i0=0,T=24,k=0,p_garch=.25)]}})
            B.write_json(self.states/name,dict(series=key,historical_checkpoint_sha256=B.digest(self.hist/name)))
            outputs[name]=B.digest(self.states/name)
            path=npz/(Path(name).stem+'.npz');path.write_bytes(b'synthetic nonarray')
            self.inputs[key]=B.digest(path)
        oldpins={str(p):B.digest(p) for root in (self.sources,self.raw,self.hist,npz) for p in root.iterdir()}
        runtime=B.runtime_identity()
        sp=dict(pin=B.PIN,horizons=B.CONSTANTS['horizons'],runtime=runtime,files=oldpins,
            datasets=str(self.root/'data'),historical=str(self.hist))
        self.sp=self.root/'state-plan.json';B.write_json(self.sp,sp)
        B.write_json(self.states/'manifest.json',dict(complete=True,plan=sp,plan_sha256=B.digest(self.sp),
            n_quarters=806,n_origins=2619,output_sha256=outputs))
        receipt=self.root/'acceptance.json'
        B.write_json(receipt,dict(complete=True,plan_sha256=B.digest(self.sp),manifest_sha256=B.digest(self.states/'manifest.json'),
            series=42,quarters=806,origins=2619,historical_rows=104310))
        self.cfg=self.root/'config.json'
        B.write_json(self.cfg,dict(config=dict(paths=1000,origin_every=28,pin=B.PIN[:7],collection='blind5-prices',
            selected_series=self.keys,inputs=self.inputs,sources={})))
        authorities={k:B.record(p) for k,p in dict(state_plan=self.sp,state_manifest=self.states/'manifest.json',
            state_acceptance=receipt,original_config=self.cfg).items()}
        allpaths={*oldpins,*(str(p) for p in self.states.iterdir()),*(v['path'] for v in authorities.values())}
        self.plan=dict(schema=B.SCHEMA,authorities=authorities,files=[B.record(p) for p in sorted(allpaths)],
            source_commit='a'*40,runtime=runtime,constants=B.CONSTANTS.copy(),output_dir=str(self.root/'out'))
        self.path=self.root/'plan.json'
    def auth(self):
        self.path.write_text(json.dumps(self.plan))
        return B.authenticate(self.path,B.digest(self.path))
    def test_authentication_prevalidates_actual_headerless_identity(self):
        self.auth()
        for name in ('blind5-synthetic0.json',):
            packet=json.loads((self.hist/name).read_text())
            self.assertEqual(set(packet),{'derived_provenance','result'})
            self.assertEqual(set(packet['result']),{'quarter_fits','rows'})
    def test_prelaunch_historical_identity_rejects_contradictions(self):
        # Direct metadata validator is also called by authenticate before NPZ reads.
        key=self.keys[0];name=key.replace(':','-')+'.json'
        packet=json.loads((self.hist/name).read_text())
        saved=json.loads((self.states/name).read_text())
        for target in (packet,packet['result']):
            target['series']='blind5:wrong'
            with self.assertRaisesRegex(ValueError,'contradictory historical'):
                B.historical_identity(key,packet['result'],saved,name,packet)
            del target['series']
        with self.assertRaisesRegex(ValueError,'filename identity'):
            B.historical_identity(key,packet['result'],saved,'wrong.json',packet)
        del packet['result']['rows'][0]['series']
        with self.assertRaisesRegex(ValueError,'mandatory historical row series'):
            B.historical_identity(key,packet['result'],saved,name,packet)
    def test_complete_authenticated_metadata_fixture(self):
        self.assertEqual(len(self.auth()[2]),42)
    def test_authenticate_rejects_header_or_row_identity_before_numerical_io(self):
        real=B.read_record
        for mode in ('result_header','envelope_header','missing_row','wrong_row'):
            def injected(item):
                packet=real(item)
                if Path(item['path']).parent==self.hist:
                    if mode=='result_header': packet['result']['series']='blind5:wrong'
                    elif mode=='envelope_header': packet['series']='blind5:wrong'
                    elif mode=='missing_row': del packet['result']['rows'][0]['series']
                    else: packet['result']['rows'][0]['series']='blind5:wrong'
                return packet
            with self.subTest(mode=mode),patch.object(B,'read_record',side_effect=injected),\
                patch.object(B.np,'load',side_effect=AssertionError('numerical input read first')):
                with self.assertRaisesRegex(ValueError,'historical.*(series|header)'):
                    self.auth()
    def test_missing_or_stale_checker_pin(self):
        checker=str(self.sources/self.names[1])
        original=copy.deepcopy(self.plan['files'])
        self.plan['files']=[r for r in original if r['path']!=checker]
        with self.assertRaisesRegex(ValueError,'missing executing source'): self.auth()
        self.plan['files']=original
        (self.sources/self.names[1]).write_text('changed source')
        with self.assertRaisesRegex(ValueError,'record mismatch'): self.auth()
    def test_config_change_after_freeze(self):
        self.cfg.write_text('{}')
        with self.assertRaisesRegex(ValueError,'record mismatch'): self.auth()
    def test_added_raw_or_state_output_fails(self):
        extra=self.raw/'extra';extra.write_text('synthetic')
        with self.assertRaisesRegex(ValueError,'raw inventory'): self.auth()
        extra.unlink();(self.states/'extra').write_text('synthetic')
        with self.assertRaisesRegex(ValueError,'state inventory'): self.auth()
    def test_state_output_drift(self):
        next(self.states.glob('blind5-*.json')).write_text('{}')
        with self.assertRaisesRegex(ValueError,'record mismatch'): self.auth()
    def test_duplicate_file_pin_and_constant_type(self):
        self.plan['files'].append(self.plan['files'][0])
        with self.assertRaisesRegex(ValueError,'duplicate'): self.auth()
        self.plan['files'].pop();self.plan['constants']['paths']=1000.0
        with self.assertRaisesRegex(ValueError,'integer types'): self.auth()

class ProducerCheckerBoundary(unittest.TestCase):
    """Real serialization/admission boundary with synthetic numerical seam only."""
    def prepare(self):
        import test_r164_baseline_replay_check as fixtures
        helper=fixtures.ProvenanceTests(methodName='test_full_104310_synthetic_support_and_receipt')
        helper.setUp();self.addCleanup(helper.tearDown)
        pp,mp,plan,_=helper.fixture()
        sources=[B.record(B.HERE/name) for name in B.SOURCES]
        existing={r['path'] for r in plan['files']}
        plan['files'].extend(r for r in sources if r['path'] not in existing)
        cfgpath=Path(plan['authorities']['original_config']['path'])
        cfg=json.loads(cfgpath.read_text())
        cfg['config']['sources']={name:B.digest(B.HERE/name) for name in B.SOURCES
            if name not in ('r164_baseline_replay.py','r164_baseline_replay_check.py','r164_pool_moment_review.py')}
        cfgpath.write_text(json.dumps(cfg));new=B.record(cfgpath)
        plan['authorities']['original_config']=new
        plan['files']=[new if r['path']==str(cfgpath) else r for r in plan['files']]
        Path(pp['path']).write_text(json.dumps(plan));pp=B.record(pp['path'])
        out=Path(mp['path']).parent
        for path in out.iterdir(): path.unlink()
        out.rmdir()
        stateplan=json.loads(Path(plan['authorities']['state_plan']['path']).read_text())
        keys=cfg['config']['selected_series']
        loader=lambda *a,**kw:({k:object() for k in keys},{k:[] for k in keys},{})
        fakeR=SimpleNamespace(M6=SimpleNamespace(_clear=lambda ser:None))
        def numerical_seam(key,ser,folds,state,old,*unused):
            result=dict(series=key,rows=[dict(series=key,i0=r['i0'],T=r['T'],k=r['k'],p_replay=r['p_garch']) for r in old['rows']])
            return result,dict(quarters=len(state['quarters']),origins=len(state['origins']),historical_rows=len(old['rows']))
        return fixtures.C,pp,out,loader,fakeR,numerical_seam
    def test_actual_producer_json_accepted_by_independent_checker(self):
        C,pp,out,loader,fakeR,seam=self.prepare()
        with patch.object(B,'runtime_identity',return_value={'synthetic':True}),patch.object(C,'runtime_identity',return_value={'synthetic':True}),\
            patch.object(B,'replay_series',side_effect=seam),patch.dict('sys.modules',{'r164_step_review':SimpleNamespace(),
            'r164_pool_moment_review':SimpleNamespace(),'r164_recursive':fakeR}),patch('builtins.print'):
            counts=B.run(pp['path'],out,pp['sha256'],loader=loader)
            result=C.check(pp['path'],out,pp['sha256'],B.digest(out/'manifest.json'))
        self.assertEqual(counts['historical_rows'],104310)
        self.assertTrue(result['exact_probability_parity_verified'])
        self.assertFalse(result['simulation_independently_reexecuted'])
        marker=json.loads((out/'started.json').read_text())
        self.assertIs(marker['complete'],False)
    def test_post_write_output_drift_rejected_before_complete_manifest(self):
        C,pp,out,loader,fakeR,seam=self.prepare()
        original=B.authenticate;calls=[]
        def mutate(*args):
            result=original(*args);calls.append(1)
            if len(calls)==2:
                next(out.glob('blind5-*.json')).write_text('{}')
            return result
        with patch.object(B,'runtime_identity',return_value={'synthetic':True}),patch.object(B,'authenticate',side_effect=mutate),\
            patch.object(B,'replay_series',side_effect=seam),patch.dict('sys.modules',{'r164_step_review':SimpleNamespace(),
            'r164_pool_moment_review':SimpleNamespace(),'r164_recursive':fakeR}),patch('builtins.print'):
            with self.assertRaisesRegex(ValueError,'output changed during replay'):
                B.run(pp['path'],out,pp['sha256'],loader=loader)
        self.assertFalse((out/'manifest.json').exists())
        self.assertTrue((out/'started.json').exists())

if __name__=='__main__': unittest.main()
