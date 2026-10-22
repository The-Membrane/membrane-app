"""Synthetic injected-archive fixtures only; no historical payload access."""
import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

PATH=Path(__file__).with_name('q26-weighted-causal-primary-pair-input.py')
spec=importlib.util.spec_from_file_location('weighted_primary_input',PATH)
M=importlib.util.module_from_spec(spec);sys.modules[spec.name]=M;spec.loader.exec_module(M)

class Archive:
    def __init__(self,data):self.data=data;self.files=list(data)
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def __getitem__(self,key):return self.data[key]

def shard(name):
    n=6;day=np.arange(n,dtype=np.int64)*2+17532
    data=dict(name=np.array(name),base_ts=np.array(17532*86400,dtype=np.int64),
        t0_i=(day-17532)*24,day=day,T_h=np.array([24,24,72,72,24,72],np.int16),
        k_i=np.array([5,5,7,7,4,4],np.int8),y=np.array([0,1,0,1,0,1],np.uint8),
        levels=np.array([-.02,-.03,-.05,-.07,-.10,-.15,-.20,-.25,-.30,-.40]),
        boot_q=np.full((n,5),.2,np.float16))
    data.update({k:np.full(n,.2,np.float16) for k in M.CONTROLS})
    data['p_a'][1]=np.nan;data['boot_q'][3,2]=np.nan
    return data

class PrimaryInputTests(unittest.TestCase):
    def setUp(self):
        self.files=('/synthetic/a.npz','/synthetic/b.npz','/synthetic/c.npz')
        self.data={p:shard(n) for p,n in zip(self.files,('altA','majorETH','altC'))}
        self.calls=[]
        self.original=dict(major={'majorETH':'ETH'},block_origin=17532,
            sg_of=lambda clusters,_:{v:v%5 for v in clusters.values()})
    def load(self,path,allow_pickle=False):
        self.assertIs(allow_pickle,False);self.calls.append(path);return Archive(self.data[path])
    def selected(self,cell=None):
        return M.stream_primary(np,self.files,self.original,cell=M.PrimaryCell() if cell is None else cell,np_load=self.load)
    def test_two_primary_cells_keep_native_keys_and_distinct_support(self):
        for horizon,k,index in ((24,5,0),(72,7,2)):
            self.calls.clear();out=self.selected(M.PrimaryCell(horizon,k))
            self.assertEqual(out['cell'],(horizon,k,'alts'));self.assertTrue(out['original_joint_mask'])
            np.testing.assert_array_equal(out['rows']['series'],[0,2])
            np.testing.assert_array_equal(out['rows']['row_index'],[index,index])
            np.testing.assert_array_equal(out['rows']['day'],[17532+2*index]*2)
            np.testing.assert_array_equal(out['rows']['sg'],[0,2])
            self.assertEqual(out['names'],('altA','majorETH','altC'))
            self.assertEqual(out['file_order'],self.files)
            self.assertTrue(all(self.calls.count(p)==2 for p in self.files))
    def test_selected_values_are_detached_from_archives(self):
        out=self.selected();before=out['rows']['p'].copy();self.data[self.files[0]]['p_fH'][:]=.9
        np.testing.assert_array_equal(out['rows']['p'],before)
    def test_partial_control_padding_censors_only_missing_shard(self):
        del self.data[self.files[0]]['p_f'];out=self.selected()
        np.testing.assert_array_equal(out['rows']['series'],[2])
        np.testing.assert_array_equal(out['rows']['row_index'],[0])
    def test_globally_missing_control_is_refused(self):
        for data in self.data.values():del data['p_f']
        with self.assertRaisesRegex(ValueError,'globally absent control'):self.selected()
    def test_partial_two_dimensional_boot_is_refused(self):
        del self.data[self.files[0]]['boot_q']
        with self.assertRaisesRegex(ValueError,'partial 2D boot_q'):self.selected()
    def test_no_boot_anywhere_preserves_original_no_boot_mask(self):
        for data in self.data.values():del data['boot_q']
        out=self.selected(M.PrimaryCell(72,7));self.assertFalse(out['has_boot'])
        np.testing.assert_array_equal(out['rows']['series'],[0,0,2,2])
        np.testing.assert_array_equal(out['rows']['row_index'],[2,3,2,3])
    def test_unsupported_or_boolean_cells_refused(self):
        for args in ((24,4),(72,5),(24,7),(168,7),(True,5),(24,True),(24,5,'majors')):
            with self.assertRaises(ValueError):M.PrimaryCell(*args)
    def test_exact_primary_level_geometry_is_required(self):
        self.data[self.files[0]]['levels'][5]=-.149
        with self.assertRaisesRegex(ValueError,'primary level geometry'):self.selected()
    def test_original_geometry_control_dtypes_and_sorted_catalogue(self):
        self.data[self.files[0]]['day'][0]+=1
        with self.assertRaisesRegex(ValueError,'midnight origin/day drift'):self.selected()
        self.data[self.files[0]]=shard('altA');self.data[self.files[0]]['p_fH']=np.full(6,.2,np.float32)
        with self.assertRaisesRegex(ValueError,'float16 control geometry'):self.selected()
        with self.assertRaisesRegex(ValueError,'sorted unique'):
            M.stream_primary(np,self.files[::-1],self.original,np_load=self.load)
    def test_contracts_reject_unpinned_source_before_execution(self):
        with self.assertRaisesRegex(ValueError,'original ranges source'):M.contracts(np,b'invented',b'invented')

if __name__=='__main__':unittest.main()
