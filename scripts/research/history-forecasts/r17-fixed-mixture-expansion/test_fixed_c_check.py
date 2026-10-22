"""Generated original-science C replays and adversarial saved-state tests only."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import numpy as np
import adapter as A
import preparation as P
import preparation_check as PC
import fixed_c as F
import fixed_c_check as V
from test_adapter import sources,legacy,generated_series


class IndependentFixedC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.science,_=sources();cls.M3,cls.A6,cls.M2,cls.D=legacy(cls.science)
        cls.selected=[[i,'synthetic:'+str(i)] for i in range(24)]
        cls.generated={}
        for sid in (0,1):
            ser,features,shape=generated_series(cls.science,cls.M3,cls.A6,cls.D,sid)
            arrays,metadata=A.stage_series(cls.science,ser,sid,features,shape,cls.A6,cls.M2)
            for m in metadata.values():m.update(volume_loader_returned_none=True,volume_length_mismatch=False)
            cls.generated[sid]=(ser,arrays,metadata)

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.prep=self.root/'prepared';self.prep.mkdir(mode=0o700)
        self.out=self.root/'evaluation';self.out.mkdir(mode=0o700)

    def make(self,sid=0):
        ser,arrays,metadata=self.generated[sid]
        prep=P.prepare_one(A,self.science,sid,'synthetic:'+str(sid),self.selected,arrays,
                           {h:{sid:m} for h,m in metadata.items()},self.prep,status=P.READY)
        with mock.patch.object(np.linalg,'lstsq',side_effect=AssertionError('C producer fitted')), \
             mock.patch.object(np.linalg,'solve',side_effect=AssertionError('C producer solved')):
            receipt=F.evaluate_one(A,self.science,PC,self.A6,self.M2,self.D,ser,sid,'synthetic:'+str(sid),prep,self.out,status=F.READY)
        return ser,prep,receipt

    def verify(self,ser,prep,receipt,sid=0):
        with mock.patch.object(np.linalg,'lstsq',side_effect=AssertionError('C checker fitted')), \
             mock.patch.object(np.linalg,'solve',side_effect=AssertionError('C checker solved')):
            return V.check_one(self.science,self.A6,self.M2,self.D,ser,sid,'synthetic:'+str(sid),prep,receipt,status=V.READY)

    def reseal(self,receipt):
        path=Path(receipt['path']);r=json.loads(path.read_bytes())
        r['summary']=F.pin(r['summary']['path']);r['quarters']=[F.pin(p['path']) for p in r['quarters']]
        path.write_text(json.dumps(r,allow_nan=False));return F.pin(path)

    def test_two_genuine_original_science_replays_no_fits_unknown_labels_retained(self):
        for sid in (0,1):
            ser,prep,receipt=self.make(sid);v=self.verify(ser,prep,receipt,sid)
            self.assertTrue(v.check['complete']);self.assertTrue(v.check['no_refit'])
            self.assertGreater(v.joint_ledger['J_n'],v.joint_ledger['L24_n'])
            self.assertGreaterEqual(v.joint_ledger['L24_n'],v.joint_ledger['L5_n'])
            self.assertTrue(any(q['J_unknown_issuance_n'] for q in v.quarters))
            self.assertTrue(any(q['J_fallback_n'] for q in v.quarters))

    def test_draft_refuses_before_any_prepared_or_evaluation_bytes(self):
        with mock.patch.object(PC,'authenticated_series',side_effect=AssertionError('read prepared')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):
                V.check_one(None,None,None,None,None,0,'synthetic:0',{}, {})

    def test_independent_membership_ignores_labels_and_handles_empty_horizon(self):
        arrays=copy.deepcopy(self.generated[0][1]);saved,ledger=V.derive_joint(self.science,arrays)
        before=saved['on_J'].copy();at=np.flatnonzero(before & arrays[24]['label_valid'])[0]
        key=int(arrays[24]['ts'][at])
        for h in V.HORIZONS:
            ix=np.flatnonzero(arrays[h]['ts']==key)
            arrays[h]['label_valid'][ix]=False;arrays[h]['y'][ix]=0
        changed,new=V.derive_joint(self.science,arrays)
        np.testing.assert_array_equal(before,changed['on_J']);self.assertEqual(new['L24_n'],ledger['L24_n']-1)
        arrays[168]={k:v[:0] for k,v in arrays[168].items()}
        empty,zero=V.derive_joint(self.science,arrays)
        self.assertEqual(zero['J_n'],0);self.assertFalse(empty['on_J'].any())
        self.assertGreater(zero['per_horizon']['24']['evaluation']['issued_outside_J']['n'],0)

    def test_resealed_C_probability_and_own_container_receipt_still_refuted(self):
        ser,prep,receipt=self.make();r=json.loads(Path(receipt['path']).read_bytes());pin=r['quarters'][0]
        path=Path(pin['path']);a=V.C.read_archive(path)
        a['C_conditional'][0,2]=np.nextafter(a['C_conditional'][0,2],1.);np.savez_compressed(path,**a)
        j=Path(r['quarters'][1]['path']);claim=json.loads(j.read_bytes());fresh=F.pin(path)
        claim.update(size=fresh['size'],sha256=fresh['sha256']);j.write_text(json.dumps(claim))
        receipt=self.reseal(receipt)
        with self.assertRaisesRegex(ValueError,'exact NPZ array: C_conditional'):self.verify(ser,prep,receipt)

    def test_resealed_summary_cannot_change_membership(self):
        ser,prep,receipt=self.make();r=json.loads(Path(receipt['path']).read_bytes());path=Path(r['summary']['path'])
        a=json.loads(path.read_bytes());a['joint_ledger']['J_n']-=1;path.write_text(json.dumps(a));receipt=self.reseal(receipt)
        with self.assertRaisesRegex(ValueError,'independent series summary'):self.verify(ser,prep,receipt)

    def test_quarter_omission_and_permutation_refused(self):
        ser,prep,receipt=self.make();path=Path(receipt['path']);original=path.read_bytes();r=json.loads(original)
        # Reordering pairs preserves every pin but violates fixed calendar coverage.
        r['quarters']=r['quarters'][2:4]+r['quarters'][:2]+r['quarters'][4:]
        path.write_text(json.dumps(r));changed=F.pin(path)
        with self.assertRaisesRegex(ValueError,'all evaluation quarters'):self.verify(ser,prep,changed)
        path.write_bytes(original);r=json.loads(original)
        for p in r['quarters'][:2]:Path(p['path']).unlink()
        r['quarters']=r['quarters'][2:];path.write_text(json.dumps(r));changed=F.pin(path)
        with self.assertRaisesRegex(ValueError,'all evaluation quarters'):self.verify(ser,prep,changed)

    def test_stale_evaluation_file_refused_before_prepared_numeric_decode(self):
        ser,prep,receipt=self.make();r=json.loads(Path(receipt['path']).read_bytes());p=Path(r['summary']['path']);p.write_bytes(p.read_bytes()+b' ')
        with mock.patch.object(PC,'authenticated_series',side_effect=AssertionError('decoded before output hash')):
            with self.assertRaisesRegex(ValueError,'pin file'):self.verify(ser,prep,receipt)

    def test_no_evaluation_and_zero_J_quarters_preserved(self):
        ser,arrays,metadata=self.generated[0]
        for sid,no_evaluation in ((2,True),(3,False)):
            cloned={h:{k:v[:0].copy() if no_evaluation or h==168 else v.copy() for k,v in a.items()}
                    for h,a in arrays.items()}
            metas={}
            for h,a in cloned.items():
                a['sid'][:]=sid;m=copy.deepcopy(metadata[h]);m['sid']=sid
                if not len(a['sid']):
                    m['quarters']=[]
                    m['counts']={k:([0]*12 if k=='Xbase_missing' else [0]*6 if k=='Xshape_missing' else 0) for k in m['counts']}
                metas[h]={sid:m}
            prep=P.prepare_one(A,self.science,sid,'synthetic:'+str(sid),self.selected,cloned,metas,self.prep,status=P.READY)
            receipt=F.evaluate_one(A,self.science,PC,self.A6,self.M2,self.D,None if no_evaluation else ser,
                                  sid,'synthetic:'+str(sid),prep,self.out,status=F.READY)
            v=V.check_one(self.science,self.A6,self.M2,self.D,None if no_evaluation else ser,
                          sid,'synthetic:'+str(sid),prep,receipt,status=V.READY)
            self.assertEqual(v.joint_ledger['J_n'],0)
            if no_evaluation:
                self.assertEqual(v.status,'NO_EVALUATION_QUARTERS_ZERO_J');self.assertEqual(v.quarters,[])
            else:
                self.assertGreater(len(v.quarters),0);self.assertTrue(all(q['J_n']==0 for q in v.quarters))
                self.assertEqual(len(v.persistence),2*len(v.quarters))

    def test_synthetic_check_cannot_be_promoted_by_relabeling_global_manifest(self):
        ser,prep,receipt=self.make();verified=self.verify(ser,prep,receipt)
        mapping=[[sid,'synthetic:'+str(sid)] for sid in range(277)]
        series=[];pins=[]
        for sid,key in mapping:
            v=copy.copy(verified);v.sid=sid;v.key=key;series.append(v)
            pins.append(receipt if sid==0 else dict(path=str(self.out/('sid-'+str(sid))/'receipt.json'),size=0,sha256='0'*64))
        manifest=dict(schema='q26-full277-fixed-c-manifest-v1',scope=V.SCOPE,label='CODEX CONTINUATION',complete=True,
            canonical_mapping=mapping,series_receipts=pins,reports={},original24_control={},**V.admission_flags(V.ADMITTED))
        path=self.out/'manifest.json';path.write_text(json.dumps(manifest));pin=F.pin(path)
        with mock.patch.object(V,'reference_report',side_effect=AssertionError('promoted synthetic result')):
            with self.assertRaisesRegex(ValueError,'per-series admission'):
                V.check_manifest(self.science,pin,mapping,self.selected,series,{}, {}, {},status=V.ADMITTED)

    def test_original191_and_native54_report_geometry_guard(self):
        # Reporting-only generated geometry; these are not hourly scientific
        # replays. Genuine C reconstructions are tested separately above.
        import test_control_check as generated
        folder=self.root/'old-control';folder.mkdir()
        request_pin,result_pin,_=generated.fixture(folder)
        request=json.loads(Path(request_pin['path']).read_bytes());result=json.loads(Path(result_pin['path']).read_bytes())
        saved=V.C.read_archive(request['inputs']['24']['path']);saved['on_J']=np.ones(len(saved['sid']),bool)
        tiny=json.loads((folder/'new'/'canonical-native-report.json').read_bytes());records=tiny['quarter_records']
        selected=[[s,'synthetic:'+str(s)] for s in reversed(range(24))]
        bundles=[]
        for sid in range(24):
            local={k:v[saved['sid']==sid] for k,v in saved.items()}
            pins=[p for p in result['outputs'] if Path(p['path']).name.startswith('sid-'+str(sid)+'-q-')]
            arrays=[V.C.read_archive(p['path']) for p in pins if p['path'].endswith('.npz')]
            bykey={int(t):(a,i) for a in arrays for i,t in enumerate(a['ts'])}
            predictions=dict(sid=local['sid'],ts=local['ts'],**{arm:np.asarray([bykey[int(t)][0][arm][bykey[int(t)][1]] for t in local['ts']]) for arm in V.ARMS})
            bundles.append(V.VerifiedSeries(sid,'synthetic:'+str(sid),local,predictions,[q for q in records if q['sid']==sid],pins,
                           {'L5_n':len(local['sid'])},'CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE',{}))
        cuts={axis:{'cut':self.science.runner.CUT if axis=='downside_imbalance_D' else 0.} for axis in self.science.reporter.AXES}
        all_saved,pred=V.concatenate(bundles)
        native=self.science.runner.build_report(self.science.reporter,all_saved,all_saved['on_J'],cuts,
               [s for s,k in selected],pred,[q for v in bundles for q in v.quarters])
        canonical=folder/'new'/'canonical-native-report.json';canonical.write_text(json.dumps(native,allow_nan=False))
        canonical_pin=F.pin(canonical)
        result['outputs']=[F.pin(p['path']) for p in result['outputs']]
        Path(result_pin['path']).write_text(json.dumps(result));result_pin=F.pin(result_pin['path'])
        actual=V.original24_control(self.science,bundles,selected,result_pin,canonical_pin,cuts)
        self.assertEqual(len(actual['views']),54)
        with self.assertRaisesRegex(ValueError,'original24 subset complete'):
            V.original24_control(self.science,bundles[:-1],selected,result_pin,canonical_pin,cuts)

    def test_dynamic307_report_matches_source_helper_with_unknown_bounds(self):
        ser,prep,receipt=self.make();verified=self.verify(ser,prep,receipt)
        ser1,prep1,receipt1=self.make(1);second=self.verify(ser1,prep1,receipt1,1)
        mapping=[[i,'synthetic:'+str(i)] for i in range(277)]
        bundles=[verified,second]
        empty={k:v[:0] for k,v in verified.saved.items()}
        preds=dict(sid=np.empty(0,np.int32),ts=np.empty(0,np.int64),**{a:np.empty((0,5),np.float64) for a in V.ARMS})
        # Report-only structural placeholders, never scientific market coverage.
        for sid in range(2,277):
            bundles.append(V.VerifiedSeries(sid,mapping[sid][1],empty,preds,[],[],{'L5_n':0},'NO_EVALUATION_QUARTERS_ZERO_J',{}))
        cuts={axis:{'cut':self.science.runner.CUT if axis=='downside_imbalance_D' else 0.} for axis in self.science.reporter.AXES}
        expected=V.reference_report(self.science,bundles,cuts,mapping)
        source=A.report(self.science,bundles,cuts,mapping)
        V.C.exact(source,expected)
        pooled=expected['views'][0]
        self.assertGreater(pooled['J_unknown_label_n'],0)
        for p in pooled['paired'].values():self.assertGreater(p['all_common_issued_bounds']['unknown_n'],0)
        permuted=bundles[::-1]
        with self.assertRaisesRegex(ValueError,'canonical complete277'):V.reference_report(self.science,permuted,cuts,mapping)


if __name__=='__main__':unittest.main()
