"""Generated fixed-edge/unknown/key-coverage oracle; no accepted market payloads."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import numpy as np

spec=importlib.util.spec_from_file_location('_tested_probability_diagnostic',Path(__file__).with_name('diagnostic.py'))
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)


class Diagnostic(unittest.TestCase):
    def setUp(self):
        self.p=np.array([0,np.nextafter(.01,0),.01,np.nextafter(.01,1),np.nextafter(.8,0),.8,np.nextafter(.8,1),1],np.float64)
        self.sid=np.array([0]*8,np.int32);self.ts=np.array([D.EVAL0+86400*i for i in range(8)],np.int64)
        self.known=np.array([True,True,True,False,True,True,False,True])
        self.y=np.repeat(np.array([1,0,1,1,0,1,1,0],np.uint8)[:,None],5,axis=1)
        self.probs={a:np.repeat(self.p[:,None],5,axis=1) for a in D.ARMS}
        self.expected=list(zip(self.sid.tolist(),self.ts.tolist()))

    def run_rows(self,**kwargs):
        args=dict(expected_keys=self.expected,status=D.READY);args.update(kwargs)
        return D.diagnose_rows(self.sid,self.ts,self.probs,self.y,self.known,**args)

    def test_default_draft_refuses_before_any_payload_or_path_access(self):
        with mock.patch.object(D,'pin',side_effect=AssertionError('no request input')):
            with self.assertRaisesRegex(ValueError,'DRAFT'):D.run('/unused','unused')
        with self.assertRaisesRegex(ValueError,'DRAFT'):
            D.diagnose_rows(self.sid,self.ts,self.probs,self.y,self.known)

    def test_registered_edges_and_unknown_oracle(self):
        r=self.run_rows();a=r['public_data']['groups']['pooled']['arms']['C_conditional']
        self.assertEqual(a['all_J_bins']['n'],[2,2,0,0,0,0,0,1,3])
        self.assertEqual(a['known_L24_bins']['n'],[2,1,0,0,0,0,0,1,2])
        self.assertEqual(a['known_L24_bins']['events'],[1,1,0,0,0,0,0,0,1])
        self.assertEqual({k:a['zero'][k] for k in ('n','events','non_events','unknown')},dict(n=1,events=1,non_events=0,unknown=0))
        self.assertEqual({k:a['low'][k] for k in ('n','events','non_events','unknown')},dict(n=2,events=1,non_events=1,unknown=0))
        self.assertEqual({k:a['high'][k] for k in ('n','events','non_events','unknown')},dict(n=3,events=1,non_events=1,unknown=1))
        self.assertEqual(a['high']['known_L24_n'],2)
        self.assertAlmostEqual(a['high']['sum_probability_all_J'],2.6)
        self.assertAlmostEqual(a['high']['sum_probability_known_L24'],1.8)
        self.assertAlmostEqual(a['high']['mean_probability_all_J'],2.6/3)
        self.assertAlmostEqual(a['high']['mean_probability_known_L24'],.9)
        cases=r['private_data']['case_inventory'];self.assertEqual(len(cases),4)
        self.assertEqual(sum(not c['known'] for c in cases),1)

    def test_same_histograms_do_not_establish_same_arm_membership(self):
        # Swap a zero with a nonzero and a high with a low without changing counts.
        self.probs['A_raw_fH']=self.probs['A_raw_fH'][[2,1,0,5,4,3,6,7]]
        r=self.run_rows();g=r['public_data']['groups']['pooled'];m=g['A_C_membership']
        self.assertEqual(m['zero']['A_n'],m['zero']['C_n']);self.assertFalse(m['zero']['identical_membership'])
        self.assertEqual(m['zero']['intersection_n'],0);self.assertEqual(m['zero']['A_only_n'],1);self.assertEqual(m['zero']['C_only_n'],1)
        self.assertEqual(m['high']['A_n'],m['high']['C_n']);self.assertFalse(m['high']['identical_membership'])
        self.assertEqual(m['high']['A_only_n'],1);self.assertEqual(m['high']['C_only_n'],1)

    def test_unknown_label_mutation_cannot_change_any_public_result(self):
        a=self.run_rows();self.y[~self.known]=255;b=self.run_rows()
        self.assertEqual(a['public_data'],b['public_data'])
        self.assertEqual(a['private_data']['case_inventory'],b['private_data']['case_inventory'])

    def test_known_label_changes_do_not_change_probability_membership(self):
        before=self.run_rows();self.y[self.known]=1-self.y[self.known];after=self.run_rows()
        self.assertEqual(before['public_data']['groups']['pooled']['A_C_membership'],after['public_data']['groups']['pooled']['A_C_membership'])
        self.assertEqual(before['public_data']['concentration'],after['public_data']['concentration'])
        for arm in D.ARMS:
            x=before['public_data']['groups']['pooled']['arms'][arm];y=after['public_data']['groups']['pooled']['arms'][arm]
            self.assertEqual(x['all_J_bins']['n'],y['all_J_bins']['n']);self.assertEqual(x['all_J_bins']['sum_probability'],y['all_J_bins']['sum_probability'])

    def test_reordering_is_canonical_and_missing_expected_key_refuses(self):
        before=self.run_rows();order=np.array([7,4,2,0,6,3,5,1]);self.sid=self.sid[order];self.ts=self.ts[order]
        self.y=self.y[order];self.known=self.known[order];self.probs={a:p[order] for a,p in self.probs.items()}
        self.assertEqual(before,self.run_rows())
        with self.assertRaisesRegex(ValueError,'complete independently expected'):
            D.diagnose_rows(self.sid[:-1],self.ts[:-1],{a:p[:-1] for a,p in self.probs.items()},self.y[:-1],self.known[:-1],expected_keys=self.expected,status=D.READY)

    def test_join_refuses_duplicate_missing_extra_and_accepts_reordered_quarters(self):
        a=dict(sid=self.sid[:4],ts=self.ts[:4],**{k:v[:4] for k,v in self.probs.items()})
        b=dict(sid=self.sid[4:][::-1],ts=self.ts[4:][::-1],**{k:v[4:][::-1] for k,v in self.probs.items()})
        restored=D.join_predictions(self.sid,self.ts,[b,a])
        for arm in D.ARMS:np.testing.assert_array_equal(restored[arm],self.probs[arm])
        for parts in ([a],[a,b,a]):
            with self.assertRaises(ValueError):D.join_predictions(self.sid,self.ts,parts)
        extra=dict(sid=np.array([1],np.int32),ts=self.ts[:1],**{k:v[:1] for k,v in self.probs.items()})
        with self.assertRaises(ValueError):D.join_predictions(self.sid,self.ts,[a,b,extra])

    def test_join_and_pure_component_reject_invalid_domains_and_duplicate_keys(self):
        for bad in (-.01,1.01,np.nan):
            p=copy.deepcopy(self.probs);p['C_conditional'][0,2]=bad
            with self.assertRaises(ValueError):D.diagnose_rows(self.sid,self.ts,p,self.y,self.known,status=D.READY)
        self.ts[1]=self.ts[0]
        with self.assertRaisesRegex(ValueError,'duplicate'):self.run_rows()

    def test_derive_J_uses_all_five_horizons_and_no_label_filter(self):
        arrays={h:dict(sid=self.sid.copy(),ts=self.ts.copy(),issue_eligible=np.ones(8,bool),p_fH_valid=np.ones(8,bool),label_valid=self.known.copy()) for h in D.HORIZONS}
        j,l=D.derive_joint(arrays,0);self.assertTrue(j.all());self.assertEqual(l,6)
        arrays[168]['label_valid'][:]=False;j2,l2=D.derive_joint(arrays,0)
        np.testing.assert_array_equal(j,j2);self.assertEqual(l2,0)
        arrays[12]['p_fH_valid'][0]=False;j3,_=D.derive_joint(arrays,0);self.assertFalse(j3[0]);self.assertTrue(j3[1:].all())

    def test_empty_and_all_unknown_have_explicit_denominators(self):
        self.known[:]=False;r=self.run_rows();g=r['public_data']['groups']['pooled']
        self.assertEqual((g['J_n'],g['L24_n'],g['unknown_n']),(8,0,8))
        for a in g['arms'].values():self.assertEqual(sum(a['known_L24_bins']['n']),0);self.assertEqual(a['zero']['non_events'],0)
        r=D.diagnose_rows(np.empty(0,np.int32),np.empty(0,np.int64),{a:np.empty((0,5),np.float64) for a in D.ARMS},np.empty((0,5),np.uint8),np.empty(0,bool),expected_keys=[],status=D.READY)
        self.assertEqual(r['public_data']['groups']['pooled']['J_n'],0);self.assertEqual(r['private_data']['case_inventory'],[])

    def test_registered_report_counts_and_tamper_refusal(self):
        result=self.run_rows();groups=result['public_data']['groups'];views=[]
        for name in ('pooled','2024','2025'):
            g=groups[name];arms={}
            for arm in D.ARMS:
                row=g['arms'][arm];bins=[dict(n=[0]*9,events=[0]*9,sum_probability=[0.]*9) for _ in range(5)]
                bins[2]=row['known_L24_bins']
                zeros=[0]*5;ones=[0]*5;zeros[2]=row['zero']['n']-row['zero']['unknown'];ones[2]=row['one']['n']-row['one']['unknown']
                arms[arm]=dict(calibration_bins=bins,exact_zero=zeros,exact_one=ones)
            views.append(dict(view_type='calendar',view=name,forecast_J_n=g['J_n'],scored_L24_n=g['L24_n'],arms=arms))
        report=dict(J_n=8,L24_n=6,views=views);D.registered_bins(report,result)
        broken=copy.deepcopy(report);broken['views'][0]['arms']['C_conditional']['calibration_bins'][2]['n'][0]+=1
        with self.assertRaisesRegex(ValueError,'registered bin exact'):D.registered_bins(broken,result)

    def test_object_NPZ_and_stale_pin_refuse_without_pickle(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory).resolve()/'bad.npz';np.savez(p,x=np.array([object()],object));record=D.pin(p)
            with self.assertRaises(ValueError):D.archive(record)
            p.write_bytes(p.read_bytes()+b'changed')
            with self.assertRaises(ValueError):D.archive(record)

    def test_public_results_exclude_identifiers_cases_and_predictions(self):
        result=self.run_rows();text=json.dumps(result['public_data'])
        self.assertNotIn('"sid"',text);self.assertNotIn('"ts"',text);self.assertNotIn('"case_inventory"',text)
        self.assertNotIn('"probabilities"',text);self.assertNotIn('"private_quarter"',text)


if __name__=='__main__':unittest.main()
