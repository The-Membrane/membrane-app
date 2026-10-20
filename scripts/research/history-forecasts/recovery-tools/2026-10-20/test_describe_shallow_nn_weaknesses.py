"""Synthetic arithmetic, partition and admission regressions only; no real predictions."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
S=importlib.util.spec_from_file_location('D',Path(__file__).with_name('describe_shallow_nn_weaknesses.py'))
D=importlib.util.module_from_spec(S);S.loader.exec_module(D)

class DescribeTests(unittest.TestCase):
    def test_known_brier_calibration_and_deviation(self):
        v=D.statistics([0,1],[.25,.75],[.5,.5])
        self.assertEqual(v['brier_model'],.25);self.assertEqual(v['brier_fH'],.0625)
        self.assertEqual(v['brier_difference'],.1875);self.assertEqual(v['model_calibration_ratio'],1.)
        self.assertEqual(v['mean_abs_probability_deviation_fH'],.25)
        self.assertEqual(v['fraction_exactly_identical_fH'],0.)
    def test_zero_events_and_empty_support_explicit(self):
        self.assertIsNone(D.statistics([0],[.2],[.1])['model_calibration_ratio'])
        v=D.statistics([],[],[]);self.assertEqual(v['n'],0)
        self.assertIsNone(v['brier_model']);self.assertIsNone(v['fraction_exactly_identical_fH'])
    def test_precision_not_clipped_and_no_missing_predictions(self):
        f=np.array([0.,.5,1.],np.float32);p=np.array([0.,.5000005,1.],np.float32)
        v=D.statistics([0,1,1],f,p)
        self.assertEqual(v['fraction_exactly_identical_fH'],2/3)
        self.assertEqual(v['fraction_within_1e_6_fH'],1.)
        for bad in ([np.nan,1,1],[-.1,1,1],[0,1.1,1]):
            with self.assertRaises(ValueError):D.statistics([0,1,1],f,bad)
    def test_pooled_split_boundary_and_non_daily_exclusion(self):
        ts=np.array([0,86400,172800,172801]);g=np.array([0,1,2,3])
        masks=D.cell_masks(ts,g,86400.)
        self.assertEqual(np.flatnonzero(masks[0,0]).tolist(),[0])
        self.assertEqual(np.flatnonzero(masks[1,1]).tolist(),[1])
        self.assertEqual(np.flatnonzero(masks[0,1]).tolist(),[2])
        self.assertEqual(sum(int(x.sum()) for x in masks.values()),3)
        self.assertEqual(D.I.split_time(np.array([0,1,10,11])),5.5)
    def test_digest_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'x';p.write_text('first')
            h=D.I.sha(p);D.bound(p,h);p.write_text('changed')
            with self.assertRaises(ValueError):D.bound(p,h)
    def test_incomplete_independent_or_wrong_scope_rejected(self):
        s={'schema':'r16-shallow-original-nn-v1','phase':'fit','out':'/tmp/example'}
        for r in ({},{'complete':True,'scope_sha256':'other','fit_replay':{'fits':20}}, {'complete':True,'scope_sha256':'scope','fit_replay':{'fits':19}}):
            with self.assertRaisesRegex(ValueError,'independent twenty-fit'):D.admit(s,'scope',r,'/tmp/example/dev-r162-nn.json',{},{},{})
    def test_wrong_score_path_rejected_before_loading_payload(self):
        s={'schema':'r16-shallow-original-nn-v1','phase':'fit','out':'/tmp/example'}
        r={'complete':True,'scope_sha256':'scope','fit_replay':{'fits':20},'coverage':{'1':{},'3':{},'12':{}}}
        with self.assertRaisesRegex(ValueError,'score output path'):D.admit(s,'scope',r,'/tmp/elsewhere/dev-r162-nn.json',{},{},{})
    def test_score_monitor_success_and_changed_output_refused(self):
        with tempfile.TemporaryDirectory() as t:
            out=Path(t);payload=out/'dev-r162-nn.json';payload.write_text('{}')
            receipt=out/'score.json';receipt.write_text('{}')
            scope={'schema':'r16-shallow-original-nn-v1','phase':'fit','out':t,'score_resource_policy':{'wall_seconds':10,'rss_bytes':1000}}
            coverage={'1':{},'3':{},'12':{}}
            ind={'complete':True,'scope_sha256':'s','fit_replay':{'fits':20},'coverage':coverage}
            score={'complete':True,'phase':'score','scope_sha256':'s','output':D.pin(payload),'audit_violations':{'total':0,'attempts':[]},'coverage':coverage}
            monitor={'complete':True,'phase':'score','scope_sha256':'s','child_pid':1,'child_exit':0,'failure':None,'peak_sampled_child_rss_bytes':1,'elapsed_seconds':1,'child_receipt':D.pin(receipt)}
            start={'phase':'score','scope_sha256':'s','child_pid':1,'child_pgid':1}
            D.admit(scope,'s',ind,payload,score,monitor,start)
            for field,value in [('child_exit',2),('complete',False),('scope_sha256','wrong'),('peak_sampled_child_rss_bytes',1001)]:
                bad=dict(monitor);bad[field]=value
                with self.assertRaises(ValueError):D.admit(scope,'s',ind,payload,score,bad,start)
            payload.write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError,'output receipt pin'):D.admit(scope,'s',ind,payload,score,monitor,start)
    def test_invalid_labels_or_shape_refused(self):
        with self.assertRaises(ValueError):D.statistics([2],[.1],[.2])
        with self.assertRaises(ValueError):D.statistics([0,1],[.1],[.2])

if __name__=='__main__':unittest.main()
