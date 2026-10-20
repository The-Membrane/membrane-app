"""Synthetic adapter fixtures only; no row producer or Torch execution."""
import tempfile
import json
import unittest
from pathlib import Path
import numpy as np
import r16_shallow_reconstruction as R


def result(key,shift=0):
    rows={}
    for T in (1,3,6,12):
        n=3; k=len(R.D.LV[T]); ts=np.array([30,10,20],np.int64)+shift
        fields=dict(ts=ts,y=np.zeros((n,k),np.int8),fH=np.full((n,k),.2,np.float32),
                    f=np.full((n,k),.3,np.float32),ignored=np.zeros(n))
        fields.update({name:np.array([1,np.nan,3],np.float32) for name in R.NN.STATIC})
        rows[T]=fields
    return dict(key=key,rows=rows,fits={},fallback={})


class CanonicalTests(unittest.TestCase):
    def test_exact_published_sized_keyset(self):
        keys=[f's{i}' for i in range(277)]; summary=dict(series=keys,code=R.ORIGINAL_CODE)
        specs=[dict(key=k,value=i) for i,k in enumerate(keys)]
        got=R.canonical_specs(summary,specs[::-1])
        self.assertEqual([s['key'] for s in got],keys)
        for bad in (specs[:-1],specs+[specs[0]],specs[:-1]+[dict(key='unknown')]):
            with self.assertRaises(ValueError): R.canonical_specs(summary,bad)
        with self.assertRaises(ValueError): R.canonical_specs(dict(series=keys[:-1],code=R.ORIGINAL_CODE),specs)

    def test_retention_shapes_and_order(self):
        src=result('b'); rows=R.retain_series_rows(src,{'a':0,'b':1})
        self.assertEqual(set(rows),{1,3,12})
        for T,v in rows.items():
            self.assertEqual(tuple(v),R.FIELDS); np.testing.assert_array_equal(v['sid'],[1,1,1])
            np.testing.assert_array_equal(v['ts'],[30,10,20])
            self.assertEqual(v['fH'].shape,(3,len(R.D.LV[T])))
            self.assertEqual(v['fH'].dtype,np.dtype('float32'))
            self.assertTrue(np.isnan(v[R.NN.STATIC[0]][1]))
        broken=result('b'); broken['rows'][1]['fH']=np.zeros((3,4))
        with self.assertRaises(ValueError): R.retain_series_rows(broken,{'b':0})
        broken=result('b'); broken['rows'][3][R.NN.STATIC[0]]=np.zeros((3,1))
        with self.assertRaises(ValueError): R.retain_series_rows(broken,{'b':0})

    def test_shuffled_completion_identical_arrays(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); keys=['b','a','c']; tasks=[result(k,100*i) for i,k in enumerate(keys)]
            R.collect_shards(tasks,root/'one',keys); R.collect_shards(tasks[::-1],root/'two',keys)
            R.merge_shards(root/'one',root/'out1',keys); R.merge_shards(root/'two',root/'out2',keys)
            for T in R.HORIZONS:
                with np.load(root/'out1'/f'rows-T{T}.npz') as a,np.load(root/'out2'/f'rows-T{T}.npz') as b:
                    for k in R.FIELDS: np.testing.assert_array_equal(a[k],b[k])
                    np.testing.assert_array_equal(a['sid'],np.repeat([0,1,2],3))
                    np.testing.assert_array_equal(a['ts'][:3],[30,10,20])

    def test_duplicate_missing_unknown_results_rejected(self):
        for tasks in ([result('a'),result('a')],[result('a')],[result('a'),result('unknown')]):
            with tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(ValueError): R.collect_shards(tasks,Path(temp)/'shards',['a','b'])

    def test_completed_shards_immutable_and_hash_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); shards=root/'shards'; R.collect_shards([result('a')],shards,['a'])
            with self.assertRaises(FileExistsError): R.write_series_shard(shards,result('a'),{'a':0})
            p=shards/'000'/'rows-T1.npz'; p.write_bytes(p.read_bytes()+b'corrupt')
            with self.assertRaises(ValueError): R.merge_shards(shards,root/'out',['a'])

    def test_rehashed_wrong_shape_dtype_labels_and_sid_rejected(self):
        for kind in ('shape','dtype','labels','sid','timestamps','nonfiniteprob','outofrangeprob'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=Path(temp); shards=root/'shards'; R.collect_shards([result('a')],shards,['a'])
                p=shards/'000'/'rows-T1.npz'
                with np.load(p) as z: arrays={k:z[k] for k in z.files}
                if kind=='shape': arrays['fH']=np.zeros((3,4),np.float32)
                if kind=='dtype': arrays['fH']=arrays['fH'].astype(np.float64)
                if kind=='labels': arrays['y'][0,0]=2
                if kind=='sid': arrays['sid'][0]=9
                if kind=='timestamps': arrays['ts'][0]=arrays['ts'][1]
                if kind=='nonfiniteprob': arrays['fH'][0,0]=np.nan
                if kind=='outofrangeprob': arrays['f'][0,0]=1.1
                np.savez_compressed(p,**arrays)
                mp=shards/'000'/'manifest.json'; receipt=json.loads(mp.read_text())
                receipt['files']['1']['sha256']=R.sha(p)
                # Even a coherently altered declared dtype cannot redefine the producer schema.
                if kind=='dtype': receipt['files']['1']['dtypes']['fH']='float64'
                mp.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError): R.merge_shards(shards,root/'out',['a'])

    def test_manifest_schema_extra_file_unknown_horizon_and_path_rejected(self):
        for kind in ('schema','extra','horizon','path','duplicate'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp:
                root=Path(temp); shards=root/'shards'; R.collect_shards([result('a')],shards,['a'])
                p=shards/'000'/'manifest.json'; receipt=json.loads(p.read_text())
                if kind=='schema': receipt['schema']='incorrect'
                if kind=='extra': (shards/'000'/'extra.npz').write_bytes(b'unexpected')
                if kind=='horizon': receipt['files']['6']=receipt['files']['1']
                if kind=='path': receipt['files']['1']['name']='../rows-T1.npz'
                text=json.dumps(receipt)
                if kind=='duplicate': text=text.replace('"files": {','"files": {"1": {},',1)
                p.write_text(text)
                with self.assertRaises(ValueError): R.merge_shards(shards,root/'out',['a'])

    def test_original_producer_ast_guard(self):
        self.assertEqual(R.verify_task_ast(),R.ORIGINAL_TASK_AST_SHA256)


if __name__=='__main__': unittest.main()
