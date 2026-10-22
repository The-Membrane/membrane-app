"""Synthetic saved certificates and transport only; no historical cache reads."""
import copy
from fractions import Fraction
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
import numpy as np
HERE=Path(__file__).parent

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
C=load('saved_independent_checker','saved_check.py')
P=load('saved_producer_fixture','saved_repair.py')
K=load('saved_kernel_fixture','horizon_coherence.py')
O=load('saved_oracle_fixture','horizon_check.py')

def fixture(count=2,partial=True):
    mapping=[[i,'synthetic:'+str(i)] for i in range(count)];archives={}
    for index,h in enumerate(C.HS):
        sid=np.array(list(range(count))*2,dtype=np.int32);ts=np.array([1704067200]*count+[1735689600]*count,dtype=np.int64);n=len(sid)
        y=np.zeros((n,5),dtype=np.uint8);y[count:]=1;valid=np.ones(n,dtype=bool)
        p=np.repeat(np.array([.8,.2,.6,.4,.9])[index],5)+np.arange(5)*.01;p=np.tile(p,(n,1))
        d=dict(sid=sid,ts=ts,y=y,label_valid=valid)
        for a in C.ALL:d[a]=p.copy()
        if partial and h!=6:
            d={k:v[:-1].copy() for k,v in d.items()}
        archives[h]=d
    return mapping,archives

class SavedChecker(unittest.TestCase):
    def positive(self):
        m,a=fixture();out,r=P.reduce_saved(a,m,K.project_grid);C.verify_saved(a,m,out,r,O);return m,a,out,r

    def test_known_join_partial_and_roundtrip(self):
        m,a,out,r=self.positive();self.assertEqual(r['partial_grid_rows'],1)
        with tempfile.TemporaryDirectory(dir='/private/tmp') as temp:
            loaded={}
            for h in C.HS:
                p=Path(temp)/f'{h}.npz';np.savez_compressed(p,**out[h]);C.headers(p,True)
                with np.load(p,allow_pickle=False) as z:loaded[h]={k:z[k] for k in z.files}
            report=json.loads(json.dumps(r));C.verify_saved(a,m,loaded,report,O)

    def test_tampered_cells_membership_rational_counts_and_scores(self):
        for name in ('cell','mask','rational','count','native','candidate','delta','extra'):
            with self.subTest(name=name):
                m,a,out,r=self.positive();out=copy.deepcopy(out);r=copy.deepcopy(r)
                if name=='cell':out[6]['baseline_raw'][0,0]=np.nextafter(out[6]['baseline_raw'][0,0],1.)
                elif name=='mask':out[6]['projected'][0]=False
                elif name=='rational':r['exact_complete_coherent_loss']['baseline_raw'][0]['ideal'][0]='999'
                elif name=='count':r['union_rows']+=1
                elif name=='native':r['horizons'][0]['native']['scores'][0]['brier']+=.01
                elif name=='candidate':r['horizons'][0]['candidate']['scores'][0]['brier']+=.01
                elif name=='delta':r['horizons'][0]['candidate_minus_own_source'][0]['brier']+=.01
                else:r['invented']=True
                with self.assertRaises(ValueError):C.verify_saved(a,m,out,r,O)

    def test_structural_float_exact_metric_compatibility_only(self):
        for target in ('primary','score_identity','bound_identity','delta_identity'):
            with self.subTest(target=target):
                m,a,out,r=self.positive();r=copy.deepcopy(r)
                if target=='primary':r['primary']['barrier']+=1e-13
                elif target=='score_identity':r['horizons'][0]['candidate']['scores'][0]['barrier']+=1e-13
                elif target=='bound_identity':r['horizons'][0]['native']['missing_label_sensitivity'][0]['barrier']+=1e-13
                else:r['horizons'][0]['candidate_minus_own_source'][0]['barrier']+=1e-13
                with self.assertRaisesRegex(ValueError,'exact structural'):C.verify_saved(a,m,out,r,O)
        m,a,out,r=self.positive();r=copy.deepcopy(r)
        r['horizons'][0]['native']['scores'][0]['brier']+=1e-13
        C.verify_saved(a,m,out,r,O)
        r['horizons'][0]['native']['scores'][0]['brier']+=1e-8
        with self.assertRaisesRegex(ValueError,'metric compatibility'):C.verify_saved(a,m,out,r,O)

    def test_paired_probability_change_survives_big_aggregate_cancellation(self):
        old=np.array([1.,0.]);new=np.array([1.,1e-17]);y=np.array([1,0],dtype=np.uint8)
        self.assertEqual(float(new.sum())-float(old.sum()),0.)
        result=C.paired_delta(y,new,old)
        self.assertEqual(result['sum_probability'],1e-17)
        self.assertEqual(result['brier'],float(Fraction.from_float(1e-17)**2/2))
        self.assertEqual(result['bounded_logloss'],0.)

    def test_exact_dyadic_tiny_clamp_and_opposite_sign_refused(self):
        m,a=fixture(partial=False)
        for h in C.HS:
            for arm in C.ALL:a[h][arm][:]=.5
        for arm in C.ALL:a[6][arm][:]=np.nextafter(.5,1.)
        out,r=P.reduce_saved(a,m,K.project_grid);C.verify_saved(a,m,out,r,O)
        row=r['horizons'][0]['candidate_minus_own_source'][0]
        self.assertLess(row['brier'],0.)
        for key,value in [('brier',0.),('brier',-row['brier']),('exact_brier',['0','1']),('brier_direction','positive'),('sum_probability',0.)]:
            bad=copy.deepcopy(r);bad['horizons'][0]['candidate_minus_own_source'][0][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):C.verify_saved(a,m,out,bad,O)
        tiny=np.nextafter(0.,1.);positive=C.paired_delta(np.array([0],dtype=np.uint8),np.array([tiny]),np.array([0.]))
        self.assertEqual(positive['brier'],0.);self.assertEqual(positive['brier_direction'],'positive')
        self.assertEqual(positive['exact_brier'],['1',str(1<<2148)])
        bad=copy.deepcopy(positive);bad['exact_brier']=['0','1'];bad['brier_direction']='zero'
        with self.assertRaises(ValueError):C.compare(bad,positive,'candidate_minus_own_source[0]')
        negative=C.paired_delta(np.array([0],dtype=np.uint8),np.array([0.]),np.array([tiny]))
        bad=copy.deepcopy(negative);bad['brier']=0.
        with self.assertRaises(ValueError):C.compare(bad,negative,'candidate_minus_own_source[0]')

    def test_strict_json_nonfinite_duplicate_and_overflow(self):
        for raw in ('{"a":1,"a":2}','{"x":NaN}','{"x":Infinity}','{"x":1e400}'):
            with self.subTest(raw=raw),self.assertRaises(ValueError):C.parse(raw)

    def test_partial_signed_zero_preserved_and_not_projected(self):
        m,a=fixture();a[6]['baseline_raw'][-1]=np.full(5,-0.);out,r=P.reduce_saved(a,m,K.project_grid);C.verify_saved(a,m,out,r,O);out[6]['baseline_raw'][-1]=0.
        with self.assertRaisesRegex(ValueError,'partial-grid'):C.verify_saved(a,m,out,r,O)

    def test_duplicate_keys_bad_available_values_and_nonnested_labels(self):
        for name in ('duplicate','range','nan','labels','sidviews'):
            with self.subTest(name=name):
                m,a=fixture(partial=False);out,r=P.reduce_saved(a,m,K.project_grid)
                if name=='duplicate':a[6]['ts'][2]=a[6]['ts'][0]
                elif name=='range':a[6]['linear_raw'][0,0]=2.
                elif name=='nan':a[6]['baseline_raw'][0,0]=np.nan
                elif name=='labels':a[6]['y'][0]=1
                else:a[6]['label_valid'][a[6]['sid']==1]=False
                with self.assertRaises(ValueError):C.verify_saved(a,m,out,r,O)

    def test_unlabelled_placeholders_not_negative_outcomes(self):
        m,a=fixture(partial=False)
        for h in C.HS:a[h]['label_valid'][-1]=False;a[h]['y'][-1]=255
        out,r=P.reduce_saved(a,m,K.project_grid);C.verify_saved(a,m,out,r,O)
        self.assertEqual(r['exact_complete_coherent_loss']['baseline_raw'][0]['vectors'],3)

    def test_original_native_record_order_independent(self):
        m,a=fixture(partial=False);_,prior=P.reduce_saved(a,m,K.project_grid);accepted={h['horizon_hours']:copy.deepcopy(h['native']) for h in prior['horizons']}
        for v in accepted.values():v['scores'].reverse();v['missing_label_sensitivity'].reverse()
        out,r=P.reduce_saved(a,m,K.project_grid,accepted);C.verify_saved(a,m,out,r,O,accepted)

    def test_bounded_headers_refuse_wrong_dtype_extra_member(self):
        m,a=fixture(partial=False)
        with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
            p=Path(t)/'bad.npz';bad=copy.deepcopy(a[6]);bad['sid']=bad['sid'].astype(np.int64);np.savez_compressed(p,**bad)
            with self.assertRaises(ValueError):C.headers(p)
            bad=copy.deepcopy(a[6]);bad['unexpected']=np.zeros(1);np.savez_compressed(p,**bad)
            with self.assertRaises(ValueError):C.headers(p)

    def test_canonical_alias_and_external_digest_before_decode(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
            root=Path(t);p=root/'request.json';p.write_text('{}')
            with self.assertRaises(ValueError):C.canonical(root/'x'/'..'/'receipt.json')
            with mock.patch.object(C.np,'load',side_effect=AssertionError('must not decode')):
                with self.assertRaisesRegex(ValueError,'external request digest'):C.run(p,'0'*64,root/'out'/'result.json',root/'receipt.json')


def transport_fixture(root,real_producer=False):
    inp=root/'inputs';inp.mkdir();out=root/'output'
    if not real_producer:out.mkdir()
    mapping,a=fixture(24,False)
    candidate,analysis=P.reduce_saved(a,mapping,K.project_grid)
    def write(name,value):
        p=inp/name;p.write_text(json.dumps(value,allow_nan=False));return C.pin(p)
    archives={}
    for h in C.HS:
        path=inp/f'original-{h}.npz';np.savez_compressed(path,**a[h]);archives[h]=C.pin(path)
    native=dict(complete=True,horizons=[dict(horizon_hours=h,local_predictions_sha256=archives[h]['sha256'],evaluation_issued_origins=len(a[h]['sid']),evaluation_complete_label_origins=len(a[h]['sid']),**{k:analysis['horizons'][i]['native'][k] for k in ('scores','missing_label_sensitivity')}) for i,h in enumerate(C.HS)])
    nativepin=write('native.json',native)
    monitorpin=write('monitor.json',dict(complete=True,exit_code=0,changed_pin_paths=[],observation_failure=None,stop_reason=None,containment=dict(errors=[],no_live_members_remaining=True,remaining_live_members=[],remaining_zombies=[]),result_pins=[nativepin]+list(archives.values())))
    auditpin=write('audit.json',dict(accepted=True,result=nativepin,monitor=monitorpin));staged=write('staged.json',dict(complete=True,canonical_mapping=mapping));selected=write('selected.json',dict(selected=mapping));dummy=write('dummy.json',{})
    authorities=dict(complete_result=nativepin,complete_monitor=monitorpin,complete_parent_audit=auditpin,staged_manifest=staged,staging_request=selected)
    for i in range(23):authorities['unused_'+str(i)]=dummy
    loc=write('location.json',dict(authority_references=authorities,canonical_mapping=mapping,canonical_mapping_authority=dict(pin=staged),completed_O81_predictions={str(h):dict(pin=archives[h]) for h in C.HS}))
    qualification=dict(status='HEADERS_AND_METADATA_ONLY_QUALIFIED',source_location=loc,prediction_archives={str(h):dict(pin=archives[h],fields={k:dict(shape=list(shape),dtype=dt) for k,(shape,dt) in C.headers(archives[h]['path']).items()}) for h in C.HS})
    env=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONOPTIMIZE='0',PYTHONDONTWRITEBYTECODE='1');runtime=write('runtime.json',dict(executable=C.pin(Path(sys.executable).resolve()),python_version=sys.version.split()[0],numpy_version=np.__version__,env=env));pins=dict(source=C.pin(HERE/'saved_repair.py'),checker=C.pin(HERE/'saved_check.py'),kernel=C.pin(HERE/'horizon_coherence.py'),check_kernel=C.pin(HERE/'horizon_check.py'),protocol=dummy,runtime=runtime,location=loc,headers=write('headers.json',qualification),**{f'archive_{h}':archives[h] for h in C.HS})
    request=root/'request.json';request.write_text(json.dumps(dict(schema='q26-r17-saved-repair-request-v1',pins=pins,out=str(out))));sha=C.pin(request)['sha256']
    if real_producer:
        P.run(request,sha,str(out))
        return request,sha,out/'result.json',root/'receipt.json',env
    started=out/'started.json';started.write_text(json.dumps(dict(schema='q26-r17-saved-repair-started-v1',request_sha256=sha,request_pins=pins)))
    accepted={h['horizon_hours']:h for h in native['horizons']};candidate,analysis=P.reduce_saved(a,mapping,K.project_grid,accepted);candpins={}
    for h in C.HS:
        path=out/f'candidate-{h}.npz';np.savez_compressed(path,**candidate[h]);candpins[str(h)]=C.pin(path)
    result=out/'result.json';result.write_text(json.dumps(dict(schema='q26-r17-saved-repair-result-v1',label='CODEX CONTINUATION',complete=True,request_sha256=sha,request_pins=pins,source=pins['source'],started=C.pin(started),candidates=candpins,analysis=analysis)))
    return request,sha,result,root/'receipt.json',env

class SerializedTransport(unittest.TestCase):
    def test_real_producer_and_checker_same_serialized_authority(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
            env=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONOPTIMIZE='0',PYTHONDONTWRITEBYTECODE='1')
            with mock.patch.dict(os.environ,env),mock.patch.object(C.sys,'flags',types.SimpleNamespace(optimize=0,dont_write_bytecode=1)):
                args=transport_fixture(Path(t),real_producer=True)
                accepted=C.run(*args[:4]);self.assertTrue(accepted['complete'])
                self.assertEqual(len(list(args[2].parent.iterdir())),7)
                self.assertEqual(args[2].parent.stat().st_mode&0o777,0o700)

    def test_positive_actual_serialized_checker_path(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as t:
            args=transport_fixture(Path(t))
            with mock.patch.dict(os.environ,args[4]),mock.patch.object(C.sys,'flags',types.SimpleNamespace(optimize=0,dont_write_bytecode=1)):
                result=C.run(*args[:4]);self.assertTrue(result['complete']);self.assertTrue(args[3].exists())
                with self.assertRaises(ValueError):C.run(*args[:4])

    def test_auth_tamper_and_extra_inventory_before_array_decode(self):
        for mutation in ('candidate_bytes','extra_output','started','receipt_alias','output_cap'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory(dir='/private/tmp') as t:
                args=list(transport_fixture(Path(t)));out=args[2].parent
                if mutation=='candidate_bytes':
                    with (out/'candidate-6.npz').open('ab') as f:f.write(b'x')
                elif mutation=='extra_output':(out/'extra.json').write_text('{}')
                elif mutation=='started':(out/'started.json').write_text('{}')
                elif mutation=='output_cap':
                    with (out/'candidate-6.npz').open('r+b') as f:f.truncate(64*1024**2+1)
                else:args[3]=out/'x'/'..'/'bad.json'
                with mock.patch.dict(os.environ,args[4]),mock.patch.object(C.sys,'flags',types.SimpleNamespace(optimize=0,dont_write_bytecode=1)),mock.patch.object(C.np,'load',side_effect=AssertionError('auth must precede decode')):
                    with self.assertRaises(ValueError):C.run(*args[:4])
                self.assertFalse((out/'bad.json').exists())

if __name__=='__main__':unittest.main()
