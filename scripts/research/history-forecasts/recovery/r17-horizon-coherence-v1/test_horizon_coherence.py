import copy
from fractions import Fraction as F
import itertools
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import types
import sys
import numpy as np
import horizon_coherence as H

ROOT=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')


def oracle(p):
    # Independent max-min characterization, not the implementation's block pooling.
    p=[F(*float(x).as_integer_ratio()) for x in p]
    return [max(min(sum(p[a:b+1],F(0))/(b-a+1) for b in range(i,len(p))) for a in range(i+1)) for i in range(len(p))]


def fixtures():
    sids=list(range(1,25));sid=np.repeat(np.array(sids,dtype=np.int32),2)
    ts=np.tile(np.array([H.EVAL,H.YEAR25],np.int64),24);data={};pred={};cuts={}
    profile=np.array([0.,.8,0.,.8,.8])
    for k,h in enumerate(H.HORIZONS):
        n=len(sid);x=np.arange(n,dtype=float)
        d={'sid':sid.copy(),'ts':ts.copy(),'issue_eligible':np.ones(n,bool),'p_fH_valid':np.ones(n,bool),
           'label_valid':np.ones(n,bool),'legacy_label_valid':np.ones(n,bool),'fH_fallback':np.zeros(n,bool),
           'future_missing_hours':np.zeros(n,np.int64),'Xbase':np.zeros((n,12),np.float32),'Xshape':np.zeros((n,6),np.float32)}
        d['Xbase'][:,0]=x/100;d['Xshape'][:,3]=x/100;d['Xshape'][:,0]=x/100
        d['future_log_min']=np.full(n,-h*.001);d['y']=(d['future_log_min'][:,None]<=np.log1p(H.BARRIERS)).astype(np.uint8)
        p=np.broadcast_to(profile[k]+np.arange(6)[:,None,None]*.01+np.arange(5)[None,None,:]*.005,(6,n,5)).copy()
        d['p_fH']=p[0].copy();data[h]=d;pred[h]=p
        cuts[str(h)]={name:{'cut':.2} for name in ['issued_log_sigma','downside_imbalance_D','jump_share_D']}
    # One origin unavailable only at longest H is outside J, not removed from H24.
    d=data[168];d['p_fH_valid'][-1]=False;pred[168][:,-1]=np.nan;d['p_fH'][-1]=np.nan
    # Different origin has an unknown longest label, yet is forecastable and in J.
    d['label_valid'][-3]=False;d['future_log_min'][-3]=np.nan;d['y'][-3]=0;d['future_missing_hours'][-3]=1
    # Different fixed permutations exercise ID joins rather than positional pairing.
    for k,h in enumerate(H.HORIZONS):
        order=np.roll(np.arange(len(sid)),k*7)
        data[h]={name:value[order] for name,value in data[h].items()};pred[h]=pred[h][:,order]
    return data,pred,cuts,sids


class ProjectionTests(unittest.TestCase):
    def test_exact_oracle_multiblock_grid(self):
        for p in itertools.product([0.,.5,1.],repeat=5):
            q=H.pav_vector(p);expected=oracle(p)
            np.testing.assert_array_equal(q,[float(x) for x in expected])
            for jump in range(6):
                y=np.array([0]*jump+[1]*(5-jump),float)
                gap=((q-y)**2).sum()-((np.array(p)-y)**2).sum()+((np.array(p)-q)**2).sum()
                self.assertLessEqual(gap,H.LOSS_BUDGET)

    def test_identity_equal_endpoints_ties_and_invalid(self):
        for p in [[0,0,.5,1,1],[.1]*5,[0]*5,[1]*5]:np.testing.assert_array_equal(H.pav_vector(p),p)
        np.testing.assert_array_equal(H.pav_vector([1,0,1,0,1]),[.5,.5,.5,.5,1])
        for p in [[np.nan]*5,[-1,0,0,0,0],[2]*5]:
            with self.assertRaises(ValueError):H.pav_vector(p)

    def test_severity_preserved_on_common_lattice(self):
        rng=np.random.default_rng(731);p=np.sort(rng.uniform(size=(6,7,5,5)),axis=3)
        q=H.project_lattice(p)
        self.assertTrue(np.all(np.diff(q,axis=2)>=0));self.assertTrue(np.all(np.diff(q,axis=3)>=0))

    def test_individual_primary_can_worsen_and_nonnested_guarantee_fails(self):
        p=np.array([0.,1.,0.,1.,1.]);q=H.pav_vector(p);y=np.array([0,0,0,1,1],float)
        self.assertGreater((q[2]-y[2])**2,(p[2]-y[2])**2)
        self.assertLess(((q-y)**2).sum(),((p-y)**2).sum())
        p=np.array([1.,0.]);q=H.pav_vector(p)
        self.assertGreater(((q-p)**2).sum(),0)

    def test_clipped_logloss_can_worsen(self):
        eps=1e-6;p=np.array([2*eps,0,1,1,1.]);q=H.pav_vector(p);y=np.ones(5,np.uint8)
        self.assertAlmostEqual(float((H.bounded_logloss(y,q)-H.bounded_logloss(y,p)).sum()),np.log(2),places=12)
        a=[F(*x.as_integer_ratio()) for x in p];b=[F(*x.as_integer_ratio()) for x in q]
        improvement=sum(((x-1)**2 for x in a),F(0))-sum(((x-1)**2 for x in b),F(0))
        self.assertEqual(improvement,2*F(*eps.as_integer_ratio())**2)

    def test_uint8_bool_float_losses_boundaries(self):
        p=np.array([0.,1.,.01,.99]);y=np.array([1,0,1,0],np.uint8)
        a=H.bounded_logloss(y,p);self.assertTrue(np.all(a>=0))
        np.testing.assert_array_equal(a,H.bounded_logloss(y.astype(bool),p))
        np.testing.assert_array_equal(a,H.bounded_logloss(y.astype(float),p))
        self.assertAlmostEqual(a[0],-np.log(1e-6));self.assertAlmostEqual(a[1],-np.log(1-(1-1e-6)))

    def test_calibration_bins_include_zero_one_empty_support(self):
        p=H.EDGES.copy();r=H.calibration(np.ones(len(p),np.uint8),p)
        self.assertEqual([v['n'] for v in r],[1]*8+[2]);self.assertEqual(sum(v['n'] for v in r),10)
        self.assertEqual(sum(v['sum_probability'] for v in r),float(p.sum()))
        self.assertEqual([v['n'] for v in H.calibration(np.array([]),np.array([]))],[0]*9)

    def test_join_actual_producer_dtypes_and_label_independence(self):
        data,pred,cuts,sids=fixtures();keys,ix,support=H.join_five(data,pred)
        self.assertEqual(len(keys),47);self.assertEqual(data[6]['sid'].dtype,np.int32)
        for h in H.HORIZONS:np.testing.assert_array_equal(H.origin_keys(data[h])[ix[h]],keys)
        no_labels={h:{k:v for k,v in d.items() if k not in ['y','label_valid']} for h,d in data.items()}
        np.testing.assert_array_equal(H.join_five(no_labels,pred)[0],keys)
        L,y,m=H.label_support(data,ix);self.assertEqual(int(L.sum()),46)
        self.assertEqual(support['168']['baseline_unavailable_eval_n'],1)
        wrong=copy.deepcopy(data);wrong[6]['sid']=wrong[6]['sid'].astype(np.int64)
        with self.assertRaises(ValueError):H.join_five(wrong,pred)

    def test_duplicate_and_nonnested_label_refusal(self):
        data,pred,cuts,sids=fixtures();d=copy.deepcopy(data);d[6]['sid'][1]=d[6]['sid'][0];d[6]['ts'][1]=d[6]['ts'][0]
        with self.assertRaisesRegex(ValueError,'duplicate'):H.join_five(d,pred)
        keys,ix,_=H.join_five(data,pred);data[6]['y'][ix[6][0]]=1;data[12]['y'][ix[12][0]]=0
        with self.assertRaisesRegex(ValueError,'nonnested'):H.label_support(data,ix)

    def test_positive_full_synthetic_reporting_pipeline(self):
        data,pred,cuts,sids=fixtures()
        old=H.load_module(ROOT/'r17-conditional-cdf-comparison-v1/cdf_comparison.py','synthetic_O88_metrics')
        helper=H.load_module(ROOT/'r17-conditional-depth-audit-v1/conditional_depth_v2.py','synthetic_O86_views')
        report=H.build_projection(data,pred,cuts,sids,helper,old)
        self.assertEqual((report['J_origins'],report['L_origins']),(47,46))
        self.assertEqual(sum(len(v) for v in report['horizons'].values()),270)
        self.assertEqual(len(report['primary_calibration']),18)
        self.assertEqual(len(report['J_membership_sha256']),64)
        self.assertNotEqual(report['J_membership_sha256'],report['L_membership_sha256'])
        self.assertEqual(len(report['support']['24']['available_membership_sha256']),64)
        self.assertEqual(len(report['support']['24']['original_scored_membership_sha256']),64)
        self.assertEqual(len(report['L_theorem']['records']),162)
        self.assertEqual(len(report['projected_all_available_cross_H']),60)
        for row in report['projection_diagnostics']:
            self.assertTrue(all(sum(p['violations_projected'])==0 for p in row['pairs']))
        primary=report['horizons']['24'][0]
        self.assertEqual(primary['original']['scored_n'],48) # Do not replace original cohort by J/L.
        self.assertGreater(primary['projected_minus_original']['raw_fH']['brier'][2],0)
        longest=report['horizons']['168'][0]
        self.assertEqual(longest['all_available_projected_minus_original_Brier_bounds']['raw_fH']['unknown_n'],1)
        serialized=json.dumps(H.clean(report),allow_nan=False)
        self.assertNotIn('future_log_min',serialized)
        # Pinned metric helper's zero-expectation ratio is explicitly undefined after cleaning.
        s=old.score(np.ones((1,5),np.uint8),np.zeros((1,5)))
        self.assertEqual(H.clean(s)['observed_over_expected'],[None]*5)

    def test_exact_replay_discrepancies_fail(self):
        H.compare_exact({'a':[1.,None]},{'a':[1.,None]})
        with self.assertRaises(ValueError):H.compare_exact({'a':[1.0000000000000002]},{'a':[1.]})
        with self.assertRaises(ValueError):H.compare_exact({'a':[]},{'a':[0]})

    def test_positive_authentication_schema_and_lexical_native_pin(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)
            def artifact(name,value):
                p=root/name;p.write_text(json.dumps(value));return H.pin(p)
            source=H.pin(H.__file__)
            replay=H.pin(ROOT/'r17-conditional-cdf-comparison-v1/cdf_comparison.py')
            owner=H.pin('/Users/EBmic/membrane-board/design/q26-r17-horizon-coherence-2026-10-21.md')
            marker=artifact('marker.json',{})
            original={'status':'PARENT_FROZEN_COMPARISON','source_pin':replay,'cuts_pin':marker,'base_request_pin':marker}
            op=artifact('original-request.json',original)
            result={'complete':True,'source_pin':replay,'cuts_pin':marker,'base_request_pin':marker}
            rp=artifact('original-result.json',result)
            outer={'returncode':0,'execution_complete':True,'changed_pin_paths':[],'expected_pins':[op],'post_pins':[op],'result_pin':rp}
            outerpin=artifact('outer.json',outer)
            reviewpin=artifact('review.json',{'accepted':True,'request_pin':op,'result_pin':rp})
            native=root/'native';native.write_bytes(b'synthetic native identity')
            link=root/'lexical-python';link.symlink_to(native)
            npin=H.pin(link);self.assertEqual(npin['path'],str(link))
            identity={'runtime_native_pins':[H.pin(native)],'interpreter_pin':npin}
            ip=artifact('identity.json',identity)
            r={'admission_status':'parent_accepted','policy':H.POLICY,'horizons':list(H.HORIZONS),'arms':list(H.ARMS),
               'barriers':H.BARRIERS.tolist(),'source_pins':{'implementation':source,'tests':H.pin(__file__),'design':marker,'replay':replay,'owner_design':owner},
               'original_request':op,'original_result':rp,'original_outer':outerpin,'original_review':reviewpin,
               'runtime_identity_audit':ip,'runtime_pins':identity['runtime_native_pins']+[npin],
               'invocation_python':sys.executable,'resolved_python':str(Path(sys.executable).resolve()),'python_prefix':sys.prefix,
               'threads':{'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'},'intended_output':str(root/'declared-output')}
            p=root/'request.json'
            admission=mock.Mock(return_value=({}, {}, object()));old=types.SimpleNamespace(admission=admission)
            def admit(value):
                p.write_text(json.dumps(value));return H.authenticate(p,H.pin(p)['sha256'])
            with mock.patch.object(H,'load_module',return_value=old), mock.patch.object(np,'load',side_effect=AssertionError('payload opened')):
                admitted=admit(r);self.assertEqual(admitted[0]['original_request'],op);admission.assert_called_once_with(original)
                changed=copy.deepcopy(r);changed['source_pins']['implementation']['size']+=1
                with self.assertRaisesRegex(ValueError,'changed admitted pin'):admit(changed)
                alternate=artifact('other-original-request.json',original);changed=copy.deepcopy(r);changed['original_request']=alternate
                with self.assertRaisesRegex(ValueError,'outer request/result'):admit(changed)
                native.write_bytes(b'tampered native')
                with self.assertRaisesRegex(ValueError,'changed admitted pin'):admit(r)
                native.write_bytes(b'synthetic native identity');p.write_text(json.dumps(r))
                with self.assertRaisesRegex(ValueError,'declared output path'):H.run(p,H.pin(p)['sha256'],root/'wrong-output')
                self.assertTrue((root/'wrong-output/failure.json').exists())

    def test_draft_refuses_before_payload_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as t:
            r=Path(t)/'draft.json';r.write_text(json.dumps({'admission_status':'DRAFT','forbidden_payload':'/must/not/open'}));out=Path(t)/'failed'
            with self.assertRaisesRegex(ValueError,'DRAFT refuses'):H.run(r,H.pin(r)['sha256'],out)
            failure=json.loads((out/'failure.json').read_text());self.assertEqual(failure['stage'],'admission')
            self.assertTrue((out/'resource-receipt.json').exists())


if __name__=='__main__':unittest.main()
