"""Generated original-science fixed-C evaluation; no market payload reads."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import numpy as np
import adapter as A
import control as C
import preparation_check as PC
import preparation as P
import fixed_c as F
import test_preparation as fixtures


class FixedC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prep=fixtures.Preparation;cls.prep.setUpClass();cls.base=cls.prep.base

    @classmethod
    def tearDownClass(cls):cls.prep.tearDownClass()

    def evaluate(self,root,index=0):
        record=self.prep.new[index];sid=24+index;f=self.base
        with mock.patch.object(A,'stage_series',side_effect=AssertionError('C must not stage')):
            return F.evaluate_one(A,f.science,PC,f.A6,f.M2,f.D,self.prep.new_series[sid][0],
                sid,'synthetic:'+str(sid),record,root,status=F.READY)

    def test_two_generated_original_science_evaluations_and_exact_readback(self):
        f=self.base
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700)
            for i in range(2):
                with mock.patch.object(f.A6.Prep6,'har_coef',side_effect=AssertionError('C refit')):
                    receipt=self.evaluate(root,i)
                result=F.read_one(A,f.science,PC,receipt,status=F.READY)
                self.assertGreater(len(result.predictions['ts']),0)
                self.assertEqual(len(result.persistence),2*len(result.quarters))
                self.assertTrue(any(np.any(result.predictions['A_raw_fH']!=result.predictions['C_conditional']) for _ in [0]))
                self.assertEqual(result.predictions['A_raw_fH'].tobytes(),result.saved['p_fH'][result.saved['on_J']].tobytes())
                with self.assertRaisesRegex(ValueError,'exclusive'):
                    self.evaluate(root,i)

    def test_persisted_bytes_and_receipt_tamper_are_refused(self):
        f=self.base
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700);receipt=self.evaluate(root)
            value=F.read(receipt,F.RECEIPT_CAP);p=Path(value['quarters'][0]['path']);raw=p.read_bytes()
            p.write_bytes(raw+b'tamper')
            with self.assertRaisesRegex(ValueError,'pin/cap'):F.read_one(A,f.science,PC,receipt,status=F.READY)
            p.write_bytes(raw)
            rpath=Path(receipt['path']);original=rpath.read_bytes();value['key']='wrong'
            rpath.write_text(__import__('json').dumps(value))
            with self.assertRaisesRegex(ValueError,'identity'):F.read_one(A,f.science,PC,F.pin(rpath),status=F.READY)
            rpath.write_bytes(original)

    def test_draft_and_incomplete_global_control_refuse(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):
            F.evaluate_one(None,None,None,None,None,None,None,0,'x',None,'/absent')
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700)
            with self.assertRaisesRegex(ValueError,'complete277'):
                F.finalize(A,C,self.base.science,PC,self.prep.mapping,self.prep.selected,[],self.base.cuts,
                    [],{},root,status=F.READY)

    def test_zeroJ_quarters_and_noeval_series_remain_explicit(self):
        f=self.base
        def empty(a,m):
            a={k:v[:0].copy() for k,v in a.items()};m=copy.deepcopy(m);m['quarters']=[]
            for k in m['counts']:m['counts'][k]=[0]*len(m['counts'][k]) if isinstance(m['counts'][k],list) else 0
            return a,m
        for noeval in (False,True):
            arrays=copy.deepcopy(self.prep.old_archives);meta=copy.deepcopy(self.prep.old_metadata)
            for h in P.HORIZONS:
                if noeval or h==168:arrays[h],meta[h][0]=empty(arrays[h],meta[h][0])
            with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
                root=Path(d).resolve();root.chmod(0o700);prepared=root/'prepared';prepared.mkdir(mode=0o700)
                evaluated=root/'evaluated';evaluated.mkdir(mode=0o700)
                rp=P.prepare_one(A,f.science,0,'synthetic:0',self.prep.selected,arrays,meta,prepared,status=P.READY)
                with mock.patch.object(f.A6.Prep6,'har_coef',side_effect=AssertionError('C refit')):
                    out=F.evaluate_one(A,f.science,PC,f.A6,f.M2,f.D,None if noeval else f.populated[0][3],
                        0,'synthetic:0',rp,evaluated,status=F.READY)
                r=F.read_one(A,f.science,PC,out,status=F.READY)
                self.assertEqual(len(r.predictions['ts']),0)
                self.assertEqual(len(r.quarters),0 if noeval else len(f.results[0].quarters))
                self.assertEqual(r.status,'NO_EVALUATION_QUARTERS_ZERO_J' if noeval else 'CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE')

    def test_missing_labels_do_not_define_J_and_support_is_not_relaxed(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700);rp=self.evaluate(root)
            r=F.read_one(A,self.base.science,PC,rp,status=F.READY)
            self.assertTrue(np.any(r.saved['on_J']&~r.saved['label_valid']))
            self.assertEqual(len(r.predictions['ts']),int(r.saved['on_J'].sum()))
        with self.assertRaisesRegex(ValueError,'empty historical state'):
            self.base.science.mixture.missingness_mixture(np.array([-1.,-2.]),np.array([0,-1],np.int8),
                np.full((1,5),-1.5),np.array([-1],np.int8),np.full((1,5),.5))

    def test_complete277_finalization_wiring_cannot_skip_original_control(self):
        # Global orchestration fixture ONLY. The real original-science per-SID
        # boundary is tested separately; sentinels do not claim native191 parity.
        f=self.base
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700);receipts=[];results=[]
            template=f.results[0]
            for sid,key in self.prep.mapping:
                sub=root/('sid-'+str(sid));sub.mkdir(mode=0o700)
                summary=F.write(sub/'summary.json',{},F.SUMMARY_CAP)
                receipts.append(F.write(sub/'receipt.json',dict(sid=sid,key=key,summary=summary,quarters=[]),F.RECEIPT_CAP))
                results.append(A.SeriesResult({k:v[:0].copy() for k,v in template.saved.items()},
                    {k:v[:0].copy() for k,v in template.predictions.items()},[],[],{},'SYNTHETIC_WIRING_ONLY'))
            results[0].quarters=[dict(sid=0,quarter_cutoff=i) for i in range(191)]
            with mock.patch.object(F,'read_one',side_effect=results),mock.patch.object(C,'compare_quarters',side_effect=ValueError('old191 sentinel')):
                with self.assertRaisesRegex(ValueError,'old191 sentinel'):
                    F.finalize(A,C,f.science,PC,self.prep.mapping,self.prep.selected,receipts,f.cuts,[],{},root,status=F.READY)
            self.assertFalse((root/'manifest.json').exists())
            with mock.patch.object(F,'read_one',side_effect=results),mock.patch.object(C,'compare_quarters') as pairs, \
                 mock.patch.object(C,'align_predictions',return_value={}), \
                 mock.patch.object(C,'original_report_control',return_value={'synthetic_control_sentinel':True}) as native, \
                 mock.patch.object(A,'report',return_value={'synthetic_report_sentinel':True}) as report:
                manifest=F.finalize(A,C,f.science,PC,self.prep.mapping,self.prep.selected,receipts,f.cuts,[],{},root,status=F.READY)
            self.assertEqual(pairs.call_count,1);self.assertEqual(native.call_count,1)
            self.assertEqual(len(report.call_args.args[1]),277)
            value=F.read(manifest,F.MANIFEST_CAP);self.assertEqual(len(value['series_receipts']),277)
            self.assertTrue(value['source_synthetic_component']);self.assertFalse(value['unseen_validation'])
            self.assertEqual(value['forecast_promotion_status'],'NOT_ADMITTED')

    def test_flags_keep_seen_evaluation_separate_from_promotion(self):
        self.assertTrue(F.admission_flags(F.READY)['source_synthetic_component'])
        actual=F.admission_flags(F.ADMITTED)
        self.assertFalse(actual['source_synthetic_component']);self.assertFalse(actual['unseen_validation'])
        self.assertEqual(actual['forecast_promotion_status'],'NOT_ADMITTED')

if __name__=='__main__':unittest.main()
