"""Generated-series preparation qualification only. Never reads market arrays."""
import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import numpy as np
import adapter as A
import control as C
import preparation as P
import test_adapter as fixtures
import preparation_check as PC


class Preparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base=fixtures.ActualScienceIntegration;cls.base.setUpClass();f=cls.base
        cls.selected=[[i,'synthetic:'+str(i)] for i in range(24)]
        cls.mapping=[[i,'synthetic:'+str(i)] for i in range(277)]
        arrays,metadata,saved,ser=f.populated[0]
        cls.old_archives={h:{k:v.copy() for k,v in arrays[h].items()} for h in P.HORIZONS}
        cls.old_metadata={h:{0:copy.deepcopy(metadata[h])} for h in P.HORIZONS}
        for h in P.HORIZONS:
            cls.old_metadata[h][0].update(volume_loader_returned_none=True,volume_length_mismatch=False)
        cls.tmp=tempfile.TemporaryDirectory(dir='/private/tmp');cls.root=Path(cls.tmp.name).resolve();cls.root.chmod(0o700)
        cls.new=[];cls.new_series={}
        for sid in (24,25):
            series,_,_=fixtures.generated_series(f.science,f.M3,f.A6,f.D,sid)
            spec=dict(key='synthetic:'+str(sid),kind='generated')
            features,shape,vmeta=f.science.producer.raw_features(series,spec,f.D,f.A6)
            receipt=P.prepare_one(A,f.science,sid,'synthetic:'+str(sid),cls.selected,cls.old_archives,
                cls.old_metadata,cls.root,ser=series,features=features,shape=shape,
                feature_metadata=dict(volume_loader_returned_none=True,volume_length_mismatch=False),
                A6=f.A6,M2=f.M2,status=P.READY)
            cls.new.append(receipt);cls.new_series[sid]=(series,spec)

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup();cls.base.tearDownClass()

    def test_two_actual_original_five_horizon_preparations_serialized(self):
        f=self.base
        for record in self.new:
            r=json.loads(P.checked(record).read_bytes());self.assertEqual(r['mode'],P.MODES[1])
            self.assertEqual(set(r['outputs']),{'6','12','24','72','168','metadata'})
            m=json.loads(P.checked(r['outputs']['metadata']).read_bytes())
            self.assertEqual(len(m['series_horizons']),5)
            for h,meta in zip(P.HORIZONS,m['series_horizons']):
                with np.load(P.checked(r['outputs'][str(h)]),allow_pickle=False) as z:a={k:z[k] for k in z.files}
                P.validate(f.science,r['sid'],h,a,meta)
                self.assertEqual(P.array_identity(a),r['arrays'][str(h)])
                self.assertTrue(any(q['coef'] is not None for q in meta['quarters']))
            self.assertEqual({p.stat().st_mode&0o777 for p in Path(record['path']).parent.iterdir()},{0o600})
            self.assertEqual(len(list(Path(record['path']).parent.iterdir())),7)

    def test_original_cached_reuse_has_no_fit_and_replays_original_C(self):
        f=self.base
        with mock.patch.object(A,'stage_series',side_effect=AssertionError('retained24 must not fit')):
            receipt=P.prepare_one(A,f.science,0,self.selected[0][1],self.selected,self.old_archives,
                                   self.old_metadata,self.root,status=P.READY)
        r=json.loads(P.checked(receipt).read_bytes());self.assertEqual(r['mode'],P.MODES[0])
        metadata=json.loads(P.checked(r['outputs']['metadata']).read_bytes())
        archives={}
        for h in P.HORIZONS:
            with np.load(P.checked(r['outputs'][str(h)]),allow_pickle=False) as z:archives[h]={k:z[k] for k in z.files}
            P.exact_arrays(archives[h],self.old_archives[h])
            C.exact_tree(metadata['series_horizons'][P.HORIZONS.index(h)],self.old_metadata[h][0])
        saved,ledger=A.attach_joint(f.science,archives)
        destination=self.root/'replay-C';destination.mkdir(mode=0o700)
        result=A.evaluate_series(f.science,f.A6,f.M2,f.D,f.populated[0][3],0,
            metadata['series_horizons'][2],saved,ledger,destination)
        C.compare_quarters(A,result.persistence,f.results[0].persistence,f.results[0].quarters)
        for arm in f.science.runner.ARMS:
            self.assertEqual(result.predictions[arm].tobytes(),f.results[0].predictions[arm].tobytes())

    def test_complete277_inventory_finalize_and_independent_manifest_check(self):
        f=self.base
        def empty(h,sid):
            arrays={k:v[:0].copy() for k,v in self.old_archives[h].items()}
            meta=copy.deepcopy(self.old_metadata[h][0]);meta['sid']=sid;meta['quarters']=[]
            meta['counts'].update({k:0 for k in meta['counts'] if k not in ('Xbase_missing','Xshape_missing')})
            meta['counts']['Xbase_missing']=[0]*12;meta['counts']['Xshape_missing']=[0]*6
            return arrays,meta
        oldmeta={h:{sid:(copy.deepcopy(self.old_metadata[h][0]) if sid==0 else empty(h,sid)[1])
                    for sid in range(24)} for h in P.HORIZONS}
        genuine={}
        for receipt in self.new:
            r=json.loads(P.checked(receipt).read_bytes());sid=r['sid']
            metadata=json.loads(P.checked(r['outputs']['metadata']).read_bytes())['series_horizons']
            arrays={}
            for h in P.HORIZONS:
                with np.load(P.checked(r['outputs'][str(h)]),allow_pickle=False) as z:arrays[h]={k:z[k] for k in z.files}
            genuine[sid]=(arrays,{m['horizon']:m for m in metadata})
        # Inventory fixture reserializes genuine prepared bytes for two series.
        # Remaining new-series zero descriptors are SYNTHETIC ONLY, not claims
        # that their actual market histories are empty or scientifically replayed.
        def synthetic_inventory_stage(science,ser,sid,features,shape,A6,M2,checkpoint):
            if sid in genuine:return copy.deepcopy(genuine[sid])
            pairs={h:empty(h,sid) for h in P.HORIZONS}
            return {h:pairs[h][0] for h in P.HORIZONS},{h:pairs[h][1] for h in P.HORIZONS}
        fixture_adapter=types.SimpleNamespace(stage_series=synthetic_inventory_stage)
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700);receipts=[];checks=[]
            for sid,key in self.mapping:
                receipt=P.prepare_one(fixture_adapter,f.science,sid,key,self.selected,self.old_archives,
                    oldmeta,root,ser=object(),features={},shape=np.empty((0,6)),
                    feature_metadata=dict(volume_loader_returned_none=True,volume_length_mismatch=False),
                    A6=object(),M2=object(),status=P.READY)
                receipts.append(receipt)
                if sid<24:
                    golden={h:{k:v[v_sid] for k,v in self.old_archives[h].items()}
                            for h in P.HORIZONS for v_sid in [self.old_archives[h]['sid']==sid]}
                    check=PC.check_series(f.science,None,None,None,None,None,receipt,sid=sid,key=key,
                        original_archives=golden,original_metadata={h:oldmeta[h][sid] for h in P.HORIZONS},status=PC.READY)
                elif sid in genuine:
                    ser,spec=self.new_series[sid]
                    check=PC.check_series(f.science,f.A6,f.M2,f.D,ser,spec,receipt,sid=sid,key=key,status=PC.READY)
                else:
                    check=dict(sid=sid,key=key,mode=P.MODES[1],complete=True,receipt_pin=receipt,
                        verification_basis=PC.FIXTURE,checker_regression_calls=0,
                        fit_origin_independently_refit=False,C_candidate_evaluated=False,**PC.admission_flags(PC.READY))
                checks.append(check)
            for invalid in (receipts[:-1],receipts[:-1]+[receipts[0]]):
                with self.assertRaises(ValueError):P.finalize(self.mapping,self.selected,invalid,root,status=P.READY)
            manifest=P.finalize(self.mapping,self.selected,receipts,root,status=P.READY)
            result=PC.check_manifest(manifest,self.mapping,self.selected,checks,status=PC.READY)
            self.assertEqual(result['series'],277);self.assertTrue(result['original24_reused_exact'])
            self.assertEqual(result['scientifically_replayed_additional_series'],2)
            self.assertEqual(result['synthetic_inventory_fixture_series'],251)
            self.assertFalse(result['additional253_retained_coefficient_replay'])
            (root/'extra').write_text('extra')
            with self.assertRaisesRegex(ValueError,'inventory'):
                PC.check_manifest(manifest,self.mapping,self.selected,checks,status=PC.READY)
            (root/'extra').unlink()
            path=Path(manifest['path']);original=path.read_bytes();value=json.loads(original)
            value['source_synthetic_component']=False;path.write_text(json.dumps(value))
            changed=P.pin(path)
            with self.assertRaisesRegex(ValueError,'manifest scope'):
                PC.check_manifest(changed,self.mapping,self.selected,checks,status=PC.READY)
            path.write_bytes(original)

    def test_draft_refuses_before_any_stage_or_output_access(self):
        with mock.patch.object(A,'stage_series',side_effect=AssertionError('DRAFT staged')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):
                P.prepare_one(A,self.base.science,24,'synthetic:24',self.selected,{}, {},'/missing')

    def test_invalid_calendar_maturity_schema_and_missing_metadata_refuse(self):
        f=self.base;a={k:v.copy() for k,v in self.old_archives[24].items()};m=copy.deepcopy(self.old_metadata[24][0])
        for field,change in [('ts',lambda x:x+1),('sid',lambda x:x.astype(np.int64))]:
            bad=copy.deepcopy(a);bad[field]=change(bad[field])
            with self.assertRaises(ValueError):P.validate(f.science,0,24,bad,m)
        bad=copy.deepcopy(m);bad['quarters'][0]['library_label_end_max']=bad['quarters'][0]['quarter_cutoff']+3600
        with self.assertRaisesRegex(ValueError,'future'):P.validate(f.science,0,24,a,bad)
        bad=copy.deepcopy(m);bad.pop('volume_loader_returned_none')
        with self.assertRaisesRegex(ValueError,'volume'):P.validate(f.science,0,24,a,bad)
        empty={k:v[:0].copy() for k,v in a.items()};empty_meta=copy.deepcopy(m)
        empty_meta['counts'].update({k:0 for k in empty_meta['counts'] if k not in ('Xbase_missing','Xshape_missing')})
        empty_meta['counts']['Xbase_missing']=[0]*12;empty_meta['counts']['Xshape_missing']=[0]*6;empty_meta['quarters']=[]
        P.validate(f.science,0,24,empty,empty_meta)

    def test_exclusive_and_tampered_persistence_refuse(self):
        with self.assertRaisesRegex(ValueError,'exclusive'):
            P.prepare_one(A,self.base.science,24,'synthetic:24',self.selected,self.old_archives,
                self.old_metadata,self.root,ser=self.base.populated[0][3],features={},shape=np.empty((0,6)),
                feature_metadata=dict(volume_loader_returned_none=True,volume_length_mismatch=False),
                A6=self.base.A6,M2=self.base.M2,status=P.READY)

    def test_changed_shard_pin_is_refused(self):
        r=json.loads(P.checked(self.new[0]).read_bytes());record=r['outputs']['24']
        path=Path(record['path']);old=path.read_bytes()
        try:
            path.write_bytes(old+b'tamper')
            with self.assertRaisesRegex(ValueError,'pin mismatch'):P.checked(record)
        finally:path.write_bytes(old)

    def test_synthetic_and_future_transport_modes_are_distinct(self):
        synthetic=P.admission_flags(P.READY);admitted=P.admission_flags(P.ADMITTED)
        self.assertTrue(synthetic['source_synthetic_component'])
        self.assertEqual(synthetic['empirical_admission_status'],'NOT_ADMITTED')
        self.assertFalse(admitted['source_synthetic_component'])
        self.assertEqual(admitted['empirical_admission_status'],'ADMITTED_BASELINE_PREPARATION_ONLY')
        for flags in (synthetic,admitted):
            self.assertEqual(flags['candidate_evaluation_status'],'NOT_RUN')
            self.assertEqual(flags['forecast_promotion_status'],'NOT_ADMITTED')
        with self.assertRaisesRegex(ValueError,'DRAFT'):P.admission_flags('DRAFT')

    def test_finalize_refuses_partial_universe_and_draft(self):
        with self.assertRaisesRegex(ValueError,'all277'):
            P.finalize(self.mapping,self.selected,self.new,self.root,status=P.READY)
        with self.assertRaisesRegex(ValueError,'DRAFT'):P.finalize([],[],[],'/missing')


if __name__=='__main__':unittest.main()
