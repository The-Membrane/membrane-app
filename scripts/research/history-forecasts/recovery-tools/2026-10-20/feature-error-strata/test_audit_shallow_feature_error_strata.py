"""Synthetic-only outcome-strata protocol tests; no historical row outcomes or predictions."""
import importlib.util
from pathlib import Path
import tempfile
import sys
import unittest
import numpy as np
S=importlib.util.spec_from_file_location('D',Path(__file__).with_name('audit_shallow_feature_error_strata.py'))
D=importlib.util.module_from_spec(S);S.loader.exec_module(D)


def synthetic_stage():
    n=4
    return {
      'hourly.normalized_before_clip10.range':(np.array([[10.,-10.],[10.01,0.],[0.,-10.01],[0.,0.]]),{}),
      'daily.normalized_before_clip10.range':(np.array([[0.,0.],[10.,-10.],[11.,0.],[0.,-11.]]),{}),
      'scale.hourly_HAR':(np.zeros(n),{'fallback':np.array([False,True,False,False])}),
      'static.lvol':(np.zeros(n),{'invalid':np.array([False,False,True,False])}),
      'hourly.return_raw':(np.array([[0.,0.],[np.nan,0.],[0.,np.inf],[0.,0.]]),{}),
      'hourly.volume_loader_returned_none':(np.zeros((n,2)),{'fallback':np.array([[False,False],[False,False],[True,True],[False,False]])})}


def census_record(flags,mask):
    return dict(role='test',rows=int(mask.sum()),fields={field:{key:int(flags[mask,j].sum())} for j,(field,key) in enumerate(D.CENSUS_COUNTERS.values())})


class ErrorStrataTests(unittest.TestCase):
    def test_metric_arithmetic_and_sign(self):
        m=D.metrics([0,1],[.25,.75],[.5,.5])
        self.assertEqual(m['n'],2);self.assertEqual(m['positive_count'],1)
        self.assertEqual(m['brier_model'],.25);self.assertEqual(m['brier_fH'],.0625)
        self.assertEqual(m['brier_difference'],.1875);self.assertEqual(m['BSS'],-3)
        self.assertEqual(m['observed_rate'],.5);self.assertEqual(m['model_calibration_ratio'],1)
    def test_zero_support_zero_positive_and_perfect_reference(self):
        empty=D.metrics([],[],[]);self.assertEqual(empty['n'],0);self.assertEqual(empty['positive_count'],0)
        self.assertIsNone(empty['BSS']);self.assertIsNone(empty['brier_model'])
        m=D.metrics([0,0],[0,0],[.1,.2]);self.assertIsNone(m['BSS']);self.assertIsNone(m['model_calibration_ratio']);self.assertIsNone(m['fH_calibration_ratio'])
    def test_missing_or_invalid_daily_prediction_or_label_refused(self):
        for y,f,p in [([0],[.2],[np.nan]),([1],[np.inf],[.3]),([2],[.1],[.2]),([0],[.1],[1.1]),([0,1],[.1],[.2])]:
            with self.assertRaises(ValueError):D.metrics(y,f,p)
    def test_flags_strict_boundaries_raw_masks_and_overlap(self):
        flags=D.stage_flags(synthetic_stage())
        self.assertEqual(flags.dtype,np.bool_);self.assertEqual(flags.shape,(4,6))
        self.assertEqual(flags[:,0].tolist(),[False,True,True,False])
        self.assertEqual(flags[:,1].tolist(),[False,False,True,True])
        self.assertEqual(flags[:,4].tolist(),[False,True,True,False])
        self.assertTrue(flags[2].sum()>1)
        self.assertFalse(flags[0].any())  # Valid zero and equal clip boundaries are not missingness.
    def test_all_six_census_counts_reconcile_and_tamper_refused(self):
        flags=D.stage_flags(synthetic_stage());mask=np.array([True,True,True,False]);record=census_record(flags,mask)
        result=D.reconcile(flags,mask,record);self.assertEqual(set(result),set(D.FLAGS))
        for field,key in D.CENSUS_COUNTERS.values():
            record['fields'][field][key]+=1
            with self.assertRaisesRegex(ValueError,'flag count differs'):D.reconcile(flags,mask,record)
            record['fields'][field][key]-=1
        record['rows']+=1
        with self.assertRaisesRegex(ValueError,'support differs'):D.reconcile(flags,mask,record)
    def test_zero_support_flag_counts_retained(self):
        flags=D.stage_flags(synthetic_stage());mask=np.zeros(4,bool)
        reconciled=D.reconcile(flags,mask,census_record(flags,mask))
        self.assertTrue(all(v['flagged_rows']==v['unflagged_rows']==0 for v in reconciled.values()))
    def test_global_daily_partition_boundary_and_series_groups(self):
        keys=['synthetic-a','synthetic-b','synthetic-c'];sid=np.array([0,1,2,0,1]);ts=np.array([0,86400,172800,172801,259200])
        masks=D.partition_masks(sid,ts,keys,86400.)
        self.assertEqual(sum(int(m.sum()) for m in masks.values()),4)
        self.assertTrue(any(m[1] for (sh,tt),m in masks.items() if tt==1))
        self.assertFalse(any(m[1] for (sh,tt),m in masks.items() if tt==0))
        self.assertFalse(any(m[3] for m in masks.values()))
        for (sh,tt),m in masks.items():
            g=D.I.groups(keys,sid);self.assertTrue(np.all(g[m]%2==sh))
    def test_new_prediction_preload_then_strict_feature_guard(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();raw=root/'raw';raw.mkdir();rawfile=raw/'admitted.json';rawfile.write_text('{}')
            outside=root/'outside.json';outside.write_text('{}');prediction=root/'rows-nn-T1.npz';np.savez(prediction,p=np.array([.25],np.float32))
            record=D.Q.pin(prediction);pins={record['path']:record};scope={'evidence':{'datasets':str(raw),'raw_pins':[D.Q.pin(rawfile)],'inputs':{}}}
            hook,state,reads=D.phase_guard(scope,pins,{},rawfile,root/'fresh.json',[prediction]);D.Q.ACTIVE_GUARD=state;sys.addaudithook(hook)
            try:
                with np.load(prediction,allow_pickle=False) as z:self.assertEqual(float(z['p'][0]),.25)
                self.assertTrue(state['prediction_preload_reads'])
                with self.assertRaises(PermissionError):outside.read_bytes()
                state['phase']='feature'
                with self.assertRaises(PermissionError):np.load(prediction,allow_pickle=False)
                D.Q.check_pin(record)
                self.assertIsNone(state['hash_only_target'])
                with self.assertRaises(PermissionError):prediction.read_bytes()
                with self.assertRaises(PermissionError):outside.write_text('changed')
                self.assertEqual(rawfile.read_text(),'{}')
            finally:state['active']=False;D.Q.ACTIVE_GUARD=None
    def test_unpinned_prediction_cannot_enter_preload_allowlist(self):
        scope={'evidence':{'datasets':'/private/tmp','raw_pins':[],'inputs':{}}}
        with self.assertRaisesRegex(ValueError,'prediction admission pins'):D.phase_guard(scope,{}, {},'/private/tmp/request.json','/private/tmp/out.json',['/private/tmp/unpinned.npz'])
    def test_request_digest_and_policy_tamper_fail_before_evidence_load(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'request.json';p.write_text('{}')
            with self.assertRaisesRegex(ValueError,'SHA mismatch'):D.authenticate(p,'0'*64)
            with self.assertRaisesRegex(ValueError,'fixed protocol'):D.authenticate(p,D.I.sha(p))

if __name__=='__main__':unittest.main()
