"""Generated original-science fixtures only; no market archives or admission."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import numpy as np
import adapter as A
import preparation as P
import preparation_check as V
from test_adapter import sources,legacy,generated_series

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'


class SavedPreparationVerification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.science,_=sources();cls.M3,cls.A6,cls.M2,cls.D=legacy(cls.science)
        cls.generated={}
        for sid in (0,1):
            ser,_,_=generated_series(cls.science,cls.M3,cls.A6,cls.D,sid)
            D=types.SimpleNamespace(realized=cls.D.realized,load_volume=lambda spec:None,
                                   btc_lookup=lambda ts:(np.zeros(len(ts)),np.zeros(len(ts))))
            spec=dict(key='synthetic:'+str(sid))
            F,shape,flags=cls.science.producer.raw_features(ser,spec,D,cls.A6)
            arrays,metadata=A.stage_series(cls.science,ser,sid,F,shape,cls.A6,cls.M2)
            for record in metadata.values():record.update(flags)
            cls.generated[sid]=(ser,D,spec,F,shape,flags,arrays,metadata)
        cls.selected=[[i,'synthetic:'+str(i)] for i in range(24)]

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)

    def write_new(self,sid=1):
        ser,D,spec,F,shape,flags,arrays,metadata=self.generated[sid]
        # Reserve unrelated canonical IDs as old24 so this generated SID is new.
        selected=[[i,'synthetic:'+str(i)] for i in range(100,124)]
        pin=P.prepare_one(A,self.science,sid,spec['key'],selected,{}, {},self.root,
              ser=ser,features=F,shape=shape,feature_metadata=flags,A6=self.A6,M2=self.M2,status=READY)
        return pin,ser,D,spec

    def verify_new(self,pin,ser,D,spec):
        return V.check_series(self.science,self.A6,self.M2,D,ser,spec,pin,sid=1,key=spec['key'],status=READY)

    def reseal(self,pin):
        path=Path(pin['path']);receipt=json.loads(path.read_bytes())
        for role,record in receipt['outputs'].items():receipt['outputs'][role]=P.pin(record['path'])
        for h in V.HORIZONS:
            with np.load(receipt['outputs'][str(h)]['path'],allow_pickle=False) as z:
                a={k:z[k] for k in z.files}
            receipt['arrays'][str(h)]={k:V.array_record(v) for k,v in a.items()}
        path.write_text(json.dumps(receipt,allow_nan=False));return P.pin(path)

    def test_two_actual_generated_series_all_five_horizons_without_checker_fits(self):
        for sid in (0,1):
            with self.subTest(sid=sid),tempfile.TemporaryDirectory(dir='/private/tmp') as folder:
                root=Path(folder).resolve();root.chmod(0o700)
                ser,D,spec,F,shape,flags,arrays,metadata=self.generated[sid]
                pin=P.prepare_one(A,self.science,sid,spec['key'],[[i,'synthetic:'+str(i)] for i in range(100,124)],{}, {},root,
                    ser=ser,features=F,shape=shape,feature_metadata=flags,A6=self.A6,M2=self.M2,status=READY)
                with mock.patch.object(np.linalg,'lstsq',side_effect=AssertionError('checker fitted')):
                    result=V.check_series(self.science,self.A6,self.M2,D,ser,spec,pin,sid=sid,key=spec['key'],status=READY)
                self.assertTrue(result['complete']);self.assertEqual(result['checker_regression_calls'],0)
                self.assertFalse(result['fit_origin_independently_refit']);self.assertFalse(result['C_candidate_evaluated'])

    def test_old_series_exact_cache_and_metadata_reuse_never_prepares_or_fits(self):
        sid=0;ser,D,spec,F,shape,flags,arrays,metadata=self.generated[sid]
        pin=P.prepare_one(A,self.science,sid,spec['key'],self.selected,arrays,{h:{sid:m} for h,m in metadata.items()},self.root,status=READY)
        with mock.patch.object(self.science.producer,'build_horizon',side_effect=AssertionError('old24 recomputed')):
            result=V.check_series(self.science,None,None,None,None,None,pin,sid=sid,key=spec['key'],
                                 original_archives=arrays,original_metadata=metadata,status=READY)
        self.assertTrue(result['complete'])
        wrong=copy.deepcopy(metadata);wrong[24]['quarters'][0]['n_reg']+=1
        with self.assertRaisesRegex(ValueError,'original24 exact metadata'):
            V.check_series(self.science,None,None,None,None,None,pin,sid=sid,key=spec['key'],
                           original_archives=arrays,original_metadata=wrong,status=READY)

    def test_explicit_internal_admission_retains_baseline_only_flags(self):
        sid=0;ser,D,spec,F,shape,flags,arrays,metadata=self.generated[sid]
        pin=P.prepare_one(A,self.science,sid,spec['key'],self.selected,arrays,{h:{sid:m} for h,m in metadata.items()},self.root,status=READY)
        result=V.check_series(self.science,None,None,None,None,None,pin,sid=sid,key=spec['key'],
            original_archives=arrays,original_metadata=metadata,status=V.ADMITTED)
        self.assertFalse(result['source_synthetic_component'])
        self.assertEqual(result['empirical_admission_status'],'ADMITTED_BASELINE_PREPARATION_ONLY')
        self.assertEqual(result['candidate_evaluation_status'],'NOT_RUN')
        self.assertEqual(result['forecast_promotion_status'],'NOT_ADMITTED')
        self.assertFalse(result['C_candidate_evaluated'])

    def test_draft_before_any_saved_byte_access(self):
        with mock.patch.object(V,'authenticated_series',side_effect=AssertionError('DRAFT touched saved bytes')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):
                V.check_series(None,None,None,None,None,None,{},sid=0,key='synthetic:0')

    def test_changed_retained_baseline_cannot_hide_behind_resealed_receipts(self):
        pin,ser,D,spec=self.write_new();receipt=json.loads(Path(pin['path']).read_bytes())
        path=Path(receipt['outputs']['24']['path'])
        with np.load(path,allow_pickle=False) as z:a={k:z[k] for k in z.files}
        at=np.flatnonzero(a['p_fH_valid'])[0];a['p_fH'][at,2]=np.nextafter(a['p_fH'][at,2],1.)
        np.savez_compressed(path,**a);pin=self.reseal(pin)
        with self.assertRaisesRegex(ValueError,'exact NPZ array: p_fH'):self.verify_new(pin,ser,D,spec)

    def test_changed_maturity_count_rejected_without_any_fit(self):
        pin,ser,D,spec=self.write_new();receipt=json.loads(Path(pin['path']).read_bytes())
        path=Path(receipt['outputs']['metadata']['path']);meta=json.loads(path.read_bytes())
        meta['series_horizons'][0]['quarters'][0]['n_reg']+=1
        path.write_text(json.dumps(meta));pin=self.reseal(pin)
        with mock.patch.object(np.linalg,'lstsq',side_effect=AssertionError('checker fitted')):
            with self.assertRaisesRegex(ValueError,'independent mature regression count'):self.verify_new(pin,ser,D,spec)

    def test_own_quarter_and_label_unknown_masks_cannot_be_forged(self):
        pin,ser,D,spec=self.write_new();receipt=json.loads(Path(pin['path']).read_bytes())
        path=Path(receipt['outputs']['24']['path'])
        with np.load(path,allow_pickle=False) as z:a={k:z[k] for k in z.files}
        a['quarter_cutoff'][0]+=3600;np.savez_compressed(path,**a);pin=self.reseal(pin)
        with self.assertRaisesRegex(ValueError,'own quarter vintage'):self.verify_new(pin,ser,D,spec)

    def test_stale_shard_hash_fails_before_numpy_payload(self):
        pin,ser,D,spec=self.write_new();receipt=json.loads(Path(pin['path']).read_bytes())
        path=Path(receipt['outputs']['24']['path']);path.write_bytes(path.read_bytes()+b'stale')
        with mock.patch.object(V.C,'read_archive',side_effect=AssertionError('decoded before all pins')):
            with self.assertRaisesRegex(ValueError,'pin file'):self.verify_new(pin,ser,D,spec)

    def test_missing_horizon_or_extra_series_file_rejected(self):
        pin,ser,D,spec=self.write_new();(Path(pin['path']).parent/'extra.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'exact seven series files'):self.verify_new(pin,ser,D,spec)


if __name__=='__main__':unittest.main()
