"""Small synthetic refusal/membership regressions; no historical rows or Torch."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

spec=importlib.util.spec_from_file_location('fresh_allocation',Path(__file__).with_name('verify_allocation_fresh.py'))
V=importlib.util.module_from_spec(spec);spec.loader.exec_module(V)

class AllocationChecks(unittest.TestCase):
    def test_exact_first_cell_excludes_boundary_and_embargo(self):
        R=dict(sid=np.zeros(12,np.int32),ts=np.array([0,86400,100000,110000,120000,130000,140000,150000,160000,170000,180000,190000],np.int64),T=np.ones(12,np.int32),Tidx=np.zeros(12,np.int32))
        groups=np.array([0,2,0,2,0,2,1,3,1,3,1,3],np.int8)
        with patch.object(V.I,'groups',return_value=groups):split,m=V.first_cell(R,['synthetic'])
        self.assertEqual(split,135000.0)
        want={'tr_all':[10,11],'tr_full':[11],'tr':[11],'va':[10],'te':[0,1]}
        for k,ix in want.items():self.assertEqual(m[k],V.I.membership(ix,R,groups))
    def test_train_then_validation_sampling_has_no_constructor_permutation(self):
        n=240010;R=dict(sid=np.zeros(n,np.int32),ts=np.concatenate([np.arange(10,dtype=np.int64),np.full(n-10,1000000,np.int64)]),T=np.ones(n,np.int32),Tidx=np.zeros(n,np.int32))
        groups=np.concatenate([np.zeros(10,np.int8),np.tile(np.array([1,3],np.int8),(n-10)//2)])
        # Fix the split to exercise both 60k sampling draws without allocating any model/feature arrays.
        with patch.object(V.I,'groups',return_value=groups),patch.object(V.I,'split_time',return_value=500000.):_,m=V.first_cell(R,['synthetic'])
        candidates=np.arange(10,n);rng=np.random.default_rng(20261903)
        tr=rng.choice(candidates[groups[candidates]==3],60000,replace=False)
        va=rng.choice(candidates[groups[candidates]==1],60000,replace=False)
        self.assertEqual(m['tr'],V.I.membership(tr,R,groups));self.assertEqual(m['tr_full'],m['tr']);self.assertEqual(m['va'],V.I.membership(va,R,groups))
        self.assertNotEqual(m['tr']['ordered_indices'],V.I.membership(rng.permutation(tr),R,groups)['ordered_indices'])
    def test_shape_checker_rejects_model_matrix_tamper(self):
        n=sum(V.I.COUNTS.values());preds={m:dict(shape=[n,5],dtype='<f4',nbytes=n*20) for m in V.I.MODELS}
        preds['nmlp']['shape']=[n-1,5]
        with self.assertRaisesRegex(ValueError,'matrix allocation'):V.allocation_shapes({'allocated_prediction_matrices':preds},Path('/nonexistent'))
    def test_historical_metadata_is_checked_but_not_consumer_recursed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);anchor=root/'historical-anchor.json';payload=root/'fresh-payload.txt'
            anchor.write_text(json.dumps({'unavailable_old_payload':{'path':str(root/'vanished.npy'),'size':1,'sha256':'a'*64}}));payload.write_text('fresh')
            pins=V.I.Pins(root/'raw');a=V.pin(anchor);p=V.pin(payload);pins.check(a);pins.walk(p)
            metadata={'manifest':dict(path=a['path'],bytes=a['size'],sha256=a['sha256'])}
            emitted=V.receipt_evidence_pins(pins.entries,metadata)
            serialized={entry['path']:entry for entry in emitted}
            self.assertNotIn('size',serialized[str(anchor.resolve())]);self.assertIn('bytes',serialized[str(anchor.resolve())])
            self.assertIn('size',serialized[str(payload.resolve())])
            # Actual original downstream consumer succeeds without opening vanished old payload.
            consumer=V.I.Pins(root/'raw');consumer.walk({'evidence_pins':emitted})
            self.assertNotIn(str(anchor.resolve()),consumer.entries);self.assertIn(str(payload.resolve()),consumer.entries)
            # Historical metadata hash remains actively checked before receipt publication.
            anchor.write_text('changed')
            with self.assertRaisesRegex(ValueError,'pin changed'):pins.recheck()
            # Fresh payload still uses ordinary recursive consumer verification.
            payload.write_text('mutated')
            with self.assertRaisesRegex(ValueError,'pin changed'):V.I.Pins(root/'raw').walk({'evidence_pins':emitted})

    def test_symlink_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'source').write_bytes(b'input');(root/'alias').symlink_to(root/'source')
            with self.assertRaisesRegex(ValueError,'symlink'):V.no_symlink(root/'alias')

if __name__=='__main__':unittest.main()
