"""Synthetic source/control checks. No historical payloads or empirical fits."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import numpy as np
import adapter as A
import control as C
from test_adapter import ActualScienceIntegration, sources


class PureControl(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.science,cls.pins=sources()

    def test_draft_before_any_payload_reads(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            p=Path(d).resolve()/'request.json';p.write_text('{"status":"DRAFT"}')
            digest=C.file_pin(p)['sha256']
            with mock.patch.object(C,'checked',side_effect=AssertionError('no payload pin reads')):
                with self.assertRaisesRegex(ValueError,'DRAFT'):C.authenticate(p,digest)
            with self.assertRaisesRegex(ValueError,'external control request SHA'):C.authenticate(p,'0'*64)

    def test_exact_native_report_rejects_one_ulp_type_and_field_drift(self):
        for candidate in ({'a':np.nextafter(.1,1.).item()},{'a':1},{'a':.1,'extra':0}):
            with self.assertRaises(ValueError):C.exact_tree(candidate,{'a':.1})
        C.exact_tree({'a':[.1,None,1]}, {'a':[.1,None,1]})

    def test_scope_ledger_does_not_claim_unexecuted_empty_markets(self):
        mapping=[[i,'generated:'+str(i)] for i in range(277)]
        ledger=C.control_scope_ledger(mapping,mapping[:24])
        self.assertEqual(sum(x['status']=='REPLAY_CONTROL_EXECUTED' for x in ledger),24)
        self.assertEqual(sum(x['status']=='UNEXECUTED_CONTROL_ONLY' for x in ledger),253)
        with self.assertRaises(ValueError):C.control_scope_ledger(mapping[:24],mapping[:24])

    def test_original_and_canonical_report_order_plus_adapter307_positive(self):
        science=self.science;n=17180
        sid=np.r_[np.arange(8420)%24,np.arange(8760)%24].astype(np.int32)
        ts=np.r_[science.runner.EVAL0+86400*(np.arange(8420)//24),
                 science.runner.YEAR25+86400*(np.arange(8760)//24)].astype(np.int64)
        p=np.tile(np.array([.01,.05,.1,.2,.4]),(n,1))
        p*=np.where(np.arange(n)%2,.9,1.)[:,None]
        saved=dict(sid=sid,ts=ts,y=np.zeros((n,5),np.uint8),label_valid=np.ones(n,bool),
            issue_eligible=np.ones(n,bool),p_fH_valid=np.ones(n,bool),fH_fallback=np.zeros(n,bool),
            p_fH=p,Xbase=np.zeros((n,12),np.float32),Xshape=np.zeros((n,6),np.float32),on_J=np.ones(n,bool))
        mapping=[[i,'generated:'+str(i)] for i in range(277)];selected=mapping[:24]
        cuts={axis:{'cut':science.runner.CUT if axis=='downside_imbalance_D' else 0.} for axis in science.reporter.AXES}
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            root=Path(d).resolve();root.chmod(0o700);results=[]
            for s,key in selected:
                at=sid==s;local={k:v[at] for k,v in saved.items()}
                preds=dict(sid=local['sid'].copy(),ts=local['ts'].copy(),A_raw_fH=local['p_fH'].copy(),
                    B_matched=local['p_fH']*.9,C_conditional=local['p_fH']*.8)
                # Matched mechanism arm has the original name, not a new method.
                bname=science.runner.ARMS[1];preds[bname]=preds.pop('B_matched')
                quarters=[];pins=[]
                for q in (science.runner.EVAL0,science.runner.YEAR25):
                    ix=(local['ts']<science.runner.YEAR25) if q==science.runner.EVAL0 else (local['ts']>=science.runner.YEAR25)
                    state={k:v[ix] for k,v in preds.items()}
                    state.update(on_J=np.ones(ix.sum(),bool),candidate_prediction_valid=np.ones(ix.sum(),bool),
                                 fH_fallback=np.zeros(ix.sum(),bool),issuance_state=np.zeros(ix.sum(),np.int8))
                    science.runner.persist_quarter(root,s,q,state,None)
                    quarters.append(dict(sid=s,quarter_cutoff=q,J_n=int(ix.sum())))
                    pins.extend([A.pin(root/f'sid-{s}-q-{q}.private.npz'),A.pin(root/f'sid-{s}-q-{q}.private.json')])
                results.append(A.SeriesResult(local,preds,quarters,pins,dict(L5_n=int(at.sum())),'SYNTHETIC_REPORT_BOUNDARY'))
            forecasts=C.align_predictions(science,saved,results);records=[q for r in results for q in r.quarters]
            retained=science.runner.build_report(science.reporter,saved,saved['on_J'],cuts,
                                                 [s for s,k in selected],forecasts,records)
            C.original_report_control(science,saved,cuts,selected,forecasts,records,retained)
            component,native=C.component_report_control(A,science,saved,cuts,mapping,selected,results)
            self.assertEqual(len(component['views']),307);self.assertEqual(len(native['views']),54)
            self.assertFalse(component['full277_scientific_coverage'])
            self.assertTrue(all(r['status']=='UNEXECUTED_CONTROL_ONLY' for r in component['series_ledger'][24:]))
            broken=copy.deepcopy(retained);broken['views'][0]['arms']['A_raw_fH']['brier'][0]=np.nextafter(
                broken['views'][0]['arms']['A_raw_fH']['brier'][0],1.).item()
            with self.assertRaisesRegex(ValueError,'float parity'):
                C.original_report_control(science,saved,cuts,selected,forecasts,records,broken)

    def test_npz_header_tamper_refuses_before_payload(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            p=Path(d).resolve()/'tiny.npz';np.savez_compressed(p,sid=np.array([1],np.int32))
            np.testing.assert_array_equal(C.load_npz(p)['sid'],[1])
            np.savez_compressed(p,sid=np.array([object()]))
            with self.assertRaisesRegex(ValueError,'dtype/shape'):C.load_npz(p)


class SerializedLegacyControl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ActualScienceIntegration.setUpClass();cls.fixture=ActualScienceIntegration
    @classmethod
    def tearDownClass(cls):ActualScienceIntegration.tearDownClass()

    def test_actual_legacy_replay_exact_private_arrays_and_key_join(self):
        f=self.fixture;old=f.results[:2];saved={k:np.concatenate([r.saved[k] for r in old]) for k in old[0].saved}
        selected=f.mapping[:2];metadata={sid:f.populated[sid][1][24] for sid,key in selected}
        quarters=[q for r in old for q in r.quarters];pins=[p for r in old for p in r.persistence]
        with tempfile.TemporaryDirectory(dir='/private/tmp') as d:
            out=Path(d).resolve();out.chmod(0o700)
            predictions,records,fresh,results=C.replay_series(A,f.science,f.A6,f.M2,f.D,saved,selected,metadata,
                lambda key:f.populated[int(key.split(':')[1])][3],pins,quarters,out)
            self.assertGreater(len(predictions['C_conditional']),0)
            C.compare_quarters(A,fresh,pins,quarters)
            for arm in f.science.runner.ARMS:
                expected=C.align_predictions(f.science,saved,old)[arm]
                self.assertEqual(predictions[arm].tobytes(),expected.tobytes())
            # Original fixed17180 guard remains intact on tiny source qualification.
            with self.assertRaisesRegex(ValueError,'fixed original J'):
                C.original_report_control(f.science,saved,f.cuts,selected,predictions,records,{})
            broken=copy.deepcopy(results);broken[0].predictions['ts'][0]+=3600
            with self.assertRaisesRegex(ValueError,'J keys'):C.align_predictions(f.science,saved,broken)
            # A semantic private-array alteration cannot hide behind a fresh ZIP pin.
            pin=fresh[0];path=Path(pin['path']);original=path.read_bytes()
            try:
                with np.load(path,allow_pickle=False) as z:data={k:z[k] for k in z.files}
                data['issuance_state'][0]=np.int8(99);np.savez_compressed(path,**data)
                with self.assertRaisesRegex(ValueError,'input pin'):C.compare_quarters(A,fresh,pins,quarters)
            finally:path.write_bytes(original)


if __name__=='__main__':unittest.main()
