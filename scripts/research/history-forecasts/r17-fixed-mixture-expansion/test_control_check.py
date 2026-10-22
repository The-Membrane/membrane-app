"""Private generated fixture + adversarial saved-control checks; no market inputs."""
import copy
import hashlib
import json
import os
import warnings
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
import numpy as np
import control_check as C


def pin(path):
    p=Path(path).resolve(); raw=p.read_bytes()
    return dict(path=str(p),size=len(raw),sha256=hashlib.sha256(raw).hexdigest())


def save(path, value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,allow_nan=False,separators=(',',':'))+'\n')
    return pin(path)


# This generated frozen reference is deliberately independent of new producer code.
# Its arithmetic is tiny: the test concerns transport, ordering and refutation.
REFERENCE = '''import numpy as np
ARMS=('A_raw_fH','B_common_shape','C_conditional')
PAIRS=()
def build_report(E,saved,on_J,cuts,sids,predictions,quarter_records):
    ts=saved['ts']; ids=saved['sid']; y=saved['y'][on_J]
    year=[('pooled',np.ones(len(ts),bool)),('2024',ts<1735689600),('2025',ts>=1735689600)]
    masks=[('calendar',name,mask) for name,mask in year]
    masks += [('asset',str(s),ids==s) for s in sids]
    for axis in ('issued_log_sigma','downside_imbalance_D','jump_share_D'):
        for group in ('unknown','low','high'):
            for name,mask in year:
                masks.append((axis,group+'/'+name,mask if group=='low' else np.zeros(len(ts),bool)))
    views=[]
    for kind,name,mask in masks:
        take=mask[on_J]; n=int(take.sum())
        arms={a:dict(n=n,total=float(np.sum(predictions[a][take])),brier=float(np.sum((predictions[a][take]-y[take])**2))) for a in ARMS}
        views.append(dict(view_type=kind,view=name,issued_n=int(mask.sum()),scored_J_n=n,issued_outside_J_n=int(mask.sum())-n,source_baseline_unavailable_n=0,source_available_unknown_label_n=0,source_fallback_n=0,arms=arms,paired={}))
    return dict(schema='synthetic-reference',quarter_records=quarter_records,views=views,J_n=int(on_J.sum()),primary_candidate_passed=False)
'''


def fixture(root):
    """191 nonempty quarters, all24 SIDs, exact frozen original year counts."""
    root=Path(root); old=root/'old'; old.mkdir(); out=root/'new'; (out/'quarters').mkdir(parents=True)
    source=root/'source'; source.mkdir()
    roles=('runner','mixture','core','inverse','reference_runner','census_source','joint_driver','joint_kernel','reporter','producer')
    science={}
    for role in roles:
        path=source/(role+'.py'); path.write_text(REFERENCE if role=='runner' else
            'import numpy as np\ndef metric(p,y): return dict(n=len(p),total=float(np.sum(p)),brier=float(np.sum((p-y)**2)))\n'
            if role=='reporter' else '# synthetic source only\n')
        science[role]=pin(path)
    rows=[]
    days2024=np.arange(C.START,C.YEAR25,86400,dtype=np.int64)
    days2025=np.arange(C.YEAR25,C.END,86400,dtype=np.int64)
    extra=273
    for sid in reversed(range(24)):
        drop=0 if sid==0 else 273//23+(sid<=273%23)
        d24=days2024[91:] if sid==0 else days2024[drop:]
        rows.extend((sid,int(t)) for t in np.concatenate((d24,days2025)))
    sid=np.array([s for s,t in rows],np.int32); ts=np.array([t for s,t in rows],np.int64); n=len(rows)
    assert n==17180 and (ts<C.YEAR25).sum()==8420
    identity=hashlib.sha256(np.array(sorted(rows),dtype='<i8').tobytes()).hexdigest()
    (source/'runner.py').write_text(REFERENCE+'\nJ_HASH='+repr(identity)+'\n')
    science['runner']=pin(source/'runner.py')
    p=np.broadcast_to(np.array([.6,.4,.2,.1,.05]),(n,5)).copy()
    # Deliberately represent tiny native summation-order differences.
    p[:,0]+=(np.arange(n)%7)*1e-8
    saved=dict(sid=sid,ts=ts,p_fH=p,y=(np.arange(n)[:,None]%np.arange(2,7)==0).astype(np.uint8),
               issue_eligible=np.ones(n,bool),p_fH_valid=np.ones(n,bool),label_valid=np.ones(n,bool),
               fH_fallback=np.zeros(n,bool),Xbase=np.zeros((n,12),np.float32),Xshape=np.zeros((n,6),np.float32))
    inputs={}
    for h in C.HORIZONS:
        path=root/('horizon-'+h+'.npz'); np.savez_compressed(path,**saved); inputs[h]=pin(path)
    quarters=[]; old_pins=[]; private_rows=[]
    for s in reversed(range(24)):
        for q in (1704067200,1711929600,1719792000,1727740800,1735689600,1743465600,1751328000,1759276800):
            ix=(sid==s)&(ts>=q)&(ts<C.next_quarter(q))
            if not ix.any(): continue
            count=int(ix.sum()); stem='sid-%d-q-%d.private'%(s,q)
            a=dict(sid=sid[ix],ts=ts[ix],on_J=np.ones(count,bool),candidate_prediction_valid=np.ones(count,bool),
                   fH_fallback=np.zeros(count,bool),issuance_state=np.zeros(count,np.int8),
                   **{arm:p[ix].copy() for arm in C.ARMS})
            private_rows.append(a)
            path=old/(stem+'.npz'); np.savez_compressed(path,**a); pp=pin(path); old_pins.append(pp)
            receipt=dict(sid=s,quarter_cutoff=q,rows=count,forecasts_only_on_original_J=True,
                         file=path.name,size=pp['size'],sha256=pp['sha256'],support={'synthetic':True})
            old_pins.append(save(old/(stem+'.json'),receipt))
            shutil.copyfile(path,out/'quarters'/path.name); shutil.copyfile(old/(stem+'.json'),out/'quarters'/(stem+'.json'))
            quarters.append(dict(sid=s,quarter_cutoff=q,J_n=count))
    assert len(quarters)==191
    namespace={};exec(REFERENCE,namespace)
    native=namespace['build_report'](None,saved,np.ones(n,bool),{},list(reversed(range(24))),
                                    {a:p for a in C.ARMS},quarters)
    reportpin=save(old/'report.json',native); old_pins.append(reportpin)
    order=np.argsort(sid,kind='stable'); canonical_saved={k:v[order] for k,v in saved.items()}
    canonical=namespace['build_report'](None,canonical_saved,np.ones(n,bool),{},list(reversed(range(24))),
                    {a:p[order] for a in C.ARMS},sorted(quarters,key=lambda q:q['sid']))
    save(out/'native-report.json',native);save(out/'canonical-native-report.json',canonical)
    component=copy.deepcopy(canonical);component['scope']=C.SCOPE;component['full277_scientific_coverage']=False
    component.update(L24_n=n,L5_n=n,unseen_validation=False,empirical_admission_status='NOT_ADMITTED',
        series_ledger=[dict(sid=s,source_rows=int((sid==s).sum()),evaluation_quarters=sum(q['sid']==s for q in quarters),
            L5_n=int((sid==s).sum()),status='CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE' if s<24 else 'UNEXECUTED_CONTROL_ONLY') for s in range(277)])
    for v in component['views']:
        v['scored_L24_n']=v.pop('scored_J_n');v['forecast_J_n']=v['scored_L24_n'];v['J_unknown_label_n']=0
    for s in range(24,277):
        component['views'].append(dict(view_type='asset',view=str(s),issued_n=0,scored_L24_n=0,forecast_J_n=0,J_unknown_label_n=0,
             issued_outside_J_n=0,source_baseline_unavailable_n=0,source_available_unknown_label_n=0,source_fallback_n=0,
             arms={arm:dict(n=0,total=0.,brier=0.) for arm in C.ARMS},paired={}))
    ledger=[dict(sid=s,status='REPLAY_CONTROL_EXECUTED' if s<24 else 'UNEXECUTED_CONTROL_ONLY') for s in range(277)]
    wrapper=dict(schema='q26-original24-adapter-component-control-v1',scope=C.SCOPE,full277_scientific_coverage=False,
                 unexecuted_status='UNEXECUTED_CONTROL_ONLY',ledger=ledger,component=component)
    save(out/'adapter-component-report.json',wrapper)
    legacy={}
    for i in range(30):
        name='legacy/synthetic%d.py'%i;path=root/name;path.parent.mkdir(exist_ok=True);path.write_text('# legacy source\n')
        legacy[name]=pin(path)['sha256']
    legacy_pin=save(root/'legacy-scope.json',dict(source_sha256=legacy))
    raw=root/'synthetic-raw';raw.write_bytes(b'no market data\n');rawpin=pin(raw)
    raw_scope=save(root/'raw-scope.json',dict(base_scope=dict(price_inputs=[rawpin],auxiliary_inputs=[],canonical_keys=['synthetic:'+str(s) for s in range(277)])))
    selected=[[s,'synthetic:'+str(s)] for s in reversed(range(24))]
    stage=save(root/'staging.json',dict(selected=selected,protocol='synthetic',required_raw_paths=[rawpin['path']],
                        pins=dict(fit_scope=legacy_pin,raw_scope=raw_scope)))
    manifest=save(root/'manifest.json',dict(complete=True,canonical_mapping=selected,request_protocol='synthetic',outputs=list(inputs.values())))
    cuts=save(root/'cuts.json',dict(complete=True,input_pins={'24':inputs['24']},request_pins={'manifest':manifest},horizons={'24':{}}))
    original=save(root/'original-request.json',dict(inputs=inputs,pins={**science,'manifest':manifest,'cuts':cuts,'staging_request':stage}))
    restoration=save(root/'restoration.json',dict(original_trial_request=original,science_roles=science))
    execution=save(root/'execution.json',dict(inner_request_pin=original,expected_results=[Path(p['path']).name for p in old_pins]))
    monitor=save(root/'monitor.json',dict(request=execution,complete=True,exit_code=0,stop_reason=None,result_pins=old_pins,
             changed_pin_paths=[],containment=dict(no_live_members_remaining=True,errors=[],remaining_zombies=[])))
    control=root/'control.py';control.write_text('# never imported producer\n')
    adapter=root/'adapter.py';adapter.write_text('# never imported adapter\n')
    pins=dict(control=pin(control),adapter=pin(adapter),restoration=restoration,legacy_scope=legacy_pin,raw_scope=raw_scope,
        staging_request=stage,manifest=manifest,cuts=cuts,original_request=original,original_execution=execution,
        original_monitor=monitor,original_report=reportpin)
    files={p['path']:p for p in [*pins.values(),*science.values(),*inputs.values(),*old_pins,rawpin,pin(sys.executable),pin(C.__file__)]}
    for path in (root/'legacy').glob('*.py'): files[str(path.resolve())]=pin(path)
    request=dict(schema='q26-fixed-mixture-original24-control-v1',status='READY_PARENT_REVIEWED_ORIGINAL24_CONTROL',scope=C.SCOPE,
                 pins=pins,inputs=inputs,science=science,files=list(files.values()),runtime=dict(executable=pin(sys.executable),native_pins=[],version=sys.version,packages={},
                 environment={k:'1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')}),out=str(out))
    request_pin=save(root/'request.json',request)
    result=dict(schema='q26-original24-control-result-v1',scope=C.SCOPE,request_sha256=request_pin['sha256'],source=pins['control'],complete=True,
                full277_scientific_coverage=False,regression_calls=0,series_ledger=ledger,
                outputs=[pin(p) for p in sorted(out.rglob('*')) if p.is_file()])
    result_pin=save(out/'control-result.json',result)
    identity=hashlib.sha256(np.array(sorted(rows),dtype='<i8').tobytes()).hexdigest()
    return request_pin,result_pin,identity


class ControlChecker(unittest.TestCase):
    def setUp(self):
        self.env=mock.patch.dict(os.environ,{k:'1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')});self.env.start()
        self.addCleanup(self.env.stop)
        self.tmp=tempfile.TemporaryDirectory(dir='/private/tmp');self.root=Path(self.tmp.name).resolve()
        self.request,self.result,self.identity=fixture(self.root)

    def tearDown(self): self.tmp.cleanup()

    def reseal(self):
        result=C.decode(Path(self.result['path']).read_bytes())
        result['outputs']=[pin(p) for p in sorted((self.root/'new').rglob('*')) if p.is_file() and p.name!='control-result.json']
        self.result=save(self.result['path'],result)

    def check(self):
        return C.check(self.request['path'],self.request['sha256'],self.result['path'],self.result['sha256'])

    def test_populated_original24_transport_and_independent_canonical_reference(self):
        result=self.check()
        self.assertEqual(result['original_J']['n'],17180)
        self.assertEqual(result['unexecuted_series'],253)
        self.assertFalse(result['scientific_acceptance'])

    def test_stale_source_hash_fails_before_any_payload_or_source_exec(self):
        path=self.root/'adapter.py';path.write_text('raise RuntimeError("must never execute")')
        with mock.patch.object(C,'read_archive',side_effect=AssertionError('decoded too early')):
            with self.assertRaisesRegex(ValueError,'pin file'): self.check()

    def test_external_terminal_result_digest_required(self):
        Path(self.result['path']).write_bytes(Path(self.result['path']).read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'external digest'):self.check()

    def test_unexpected_output_refused_even_after_manifest_reseal(self):
        (self.root/'new'/'extra').write_text('extra');self.reseal()
        with self.assertRaisesRegex(ValueError,'385 pinned'):self.check()

    def test_private_changed_probability_refused_after_manifest_reseal(self):
        path=next((self.root/'new'/'quarters').glob('*.npz'));a=C.read_archive(path);a['C_conditional'][0,0]=.12
        np.savez_compressed(path,**a);self.reseal()
        with self.assertRaisesRegex(ValueError,'private receipt binding'):self.check()

    def test_resealed_private_container_and_receipt_still_refuted_by_arrays(self):
        path=next((self.root/'new'/'quarters').glob('*.npz'));a=C.read_archive(path);a['C_conditional'][0,0]=.12
        np.savez_compressed(path,**a)
        receipt=C.decode(path.with_suffix('.json').read_bytes());receipt.update({k:v for k,v in pin(path).items() if k!='path'})
        save(path.with_suffix('.json'),receipt);self.reseal()
        with self.assertRaisesRegex(ValueError,'exact NPZ array'):self.check()

    def test_canonical_and_component_joint_metric_tamper_refused(self):
        canonical=self.root/'new'/'canonical-native-report.json';wrapper=self.root/'new'/'adapter-component-report.json'
        a=C.decode(canonical.read_bytes());b=C.decode(wrapper.read_bytes())
        a['views'][0]['arms']['C_conditional']['brier']+=1
        b['component']['views'][0]['arms']['C_conditional']['brier']+=1
        save(canonical,a);save(wrapper,b);self.reseal()
        with self.assertRaisesRegex(ValueError,'independent canonical original report'):self.check()

    def test_native_report_changed_even_when_producer_claims_exact(self):
        path=self.root/'new'/'native-report.json';a=C.decode(path.read_bytes());a['primary_candidate_passed']=True
        save(path,a);self.reseal()
        with self.assertRaisesRegex(ValueError,'native original54'):self.check()

    def test_unexecuted_asset_cannot_acquire_support(self):
        path=self.root/'new'/'adapter-component-report.json';a=C.decode(path.read_bytes());a['component']['views'][-1]['issued_n']=1
        save(path,a);self.reseal()
        with self.assertRaisesRegex(ValueError,'unexecuted exact empty reporter view'):self.check()

    def test_recompressed_private_zip_is_accepted_when_science_and_receipt_match(self):
        path=next((self.root/'new'/'quarters').glob('*.npz'));a=C.read_archive(path)
        # np.savez uses uncompressed ZIP: the container bytes must differ.
        before=path.read_bytes();np.savez(path,**a);self.assertNotEqual(before,path.read_bytes())
        receipt=C.decode(path.with_suffix('.json').read_bytes());receipt.update({k:v for k,v in pin(path).items() if k!='path'})
        save(path.with_suffix('.json'),receipt);self.reseal()
        self.assertTrue(self.check()['complete'])

    def test_unexecuted_ledger_and_universe_ids_are_exact(self):
        path=self.root/'new'/'adapter-component-report.json';a=C.decode(path.read_bytes())
        a['component']['views'][-1]['view']='999'
        save(path,a);self.reseal()
        with self.assertRaisesRegex(ValueError,'common and unexecuted view closure'):self.check()

    def test_draft_stops_before_archive_read(self):
        q=C.decode(Path(self.request['path']).read_bytes());q['status']='DRAFT'
        self.request=save(self.request['path'],q)
        with mock.patch.object(C,'read_archive',side_effect=AssertionError('DRAFT decoded')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):self.check()

    def test_fabricated_empty_scores_and_paired_fields_refused(self):
        path=self.root/'new'/'adapter-component-report.json';a=C.decode(path.read_bytes())
        a['component']['views'][-1]['arms']['C_conditional']['brier']=123.0
        a['component']['views'][-1]['paired']={'UNSUPPORTED_SCORE':{'brier':-999.0}}
        save(path,a);self.reseal()
        with self.assertRaisesRegex(ValueError,'unexecuted exact empty reporter view'):self.check()

    def test_huge_or_inconsistent_npy_header_rejected_before_numpy_allocation(self):
        import io
        for shape in ((1000000000,), (200000,)):
            stream=io.BytesIO()
            np.lib.format.write_array_header_1_0(stream,dict(descr='<f8',fortran_order=False,shape=shape))
            path=self.root/'malformed.npz'
            with zipfile.ZipFile(path,'w') as z:z.writestr('x.npy',stream.getvalue())
            with mock.patch.object(C.np,'load',side_effect=AssertionError('allocated malformed payload')):
                with self.assertRaisesRegex(ValueError,'NPY (dtype/shape bounds|exact declared payload size)'):
                    C.read_archive(path)

    def test_duplicate_json_and_nonfinite_rejected(self):
        for raw in ('{"a":1,"a":2}','{"a":NaN}','{"a":1e999}'):
            with self.assertRaises(ValueError): C.decode(raw)

    def test_dtype_signzero_and_duplicate_zip_refutations(self):
        for b in (np.array([0.],np.float32),np.array([-0.],np.float64)):
            with self.assertRaises(ValueError): C.exact_arrays({'x':b},{'x':np.array([0.],np.float64)})
        path=self.root/'duplicate.npz'
        import io
        stream=io.BytesIO();np.save(stream,np.array([1]),allow_pickle=False)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(path,'w') as z:
                z.writestr('a.npy',stream.getvalue());z.writestr('a.npy',stream.getvalue())
        with self.assertRaisesRegex(ValueError,'NPZ member inventory'): C.read_archive(path)


if __name__=='__main__': unittest.main()
