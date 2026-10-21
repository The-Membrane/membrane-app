"""Synthetic fixtures only; no admitted input arrays or real CDF fits."""
import copy,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import cdf_comparison as C

def helper():
 p=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-conditional-depth-audit-v1/conditional_depth_v2.py');s=importlib.util.spec_from_file_location('o86_unit_functions_only',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def fixture():
 ts=np.array([C.START+i*86400 for i in range(8)]+[C.EVAL,C.EVAL+86400,C.EVAL+91*86400,C.YEAR25,C.YEAR25+86400],np.int64);n=len(ts);xb=np.zeros((n,12),np.float32);xb[:,:2]=np.log(np.sqrt(8760/24));xs=np.zeros((n,6),np.float32);xs[:,3]=np.array([-1]*4+[1]*4+[-1,1,-1,-1,1]);depth=np.array([-4,-2,-1,1,-8,-4,-2,2,-.12,-.08,.1,-.15,-.01]);y=(depth[:,None]<=np.log1p(C.BARRIERS)).astype(np.uint8)
 quarters=np.full(n,C.START,np.int64);ev=ts>=C.EVAL;quarters[ev]=C.quarter_starts()[np.searchsorted(C.quarter_starts(),ts[ev],side='right')-1]
 return dict(sid=np.ones(n,np.int32),ts=ts,quarter_cutoff=quarters,issue_eligible=np.ones(n,bool),p_fH_valid=np.ones(n,bool),fH_fallback=np.zeros(n,bool),Xbase=xb,Xshape=xs,future_log_min=depth,label_valid=np.ones(n,bool),y=y,p_fH=np.tile([.01,.03,.1,.3,.6],(n,1)),future_missing_hours=np.zeros(n,np.int32),legacy_label_valid=np.ones(n,bool))
class Tests(unittest.TestCase):
 def test_scale_only_null_with_unequal_state_counts(self):
  base=np.array([-4.,-2.,-1.,1.]);z=np.r_[np.tile(base,2),np.tile(2*base,3)];states=np.r_[np.zeros(8,int),np.ones(12,int)];t=np.tile([-.4,-.2,-.1,-.05,-.02],(2,1));pred,_=C.predict_fold(z,states,t,np.array([0,1]),np.full((2,5),.2));np.testing.assert_array_equal(pred[1],pred[2])
  p,_=C.predict_fold(z,states,np.array([[-1.5]*5]),np.array([0]),np.full((1,5),.2));self.assertNotEqual(p[0,0,0],p[2,0,0]);self.assertEqual(p[2,0,0],.5)
 def test_same_median_shape_alternative_exact(self):
  a=-np.array([1,1,1,1,2,2,2,2.]);b=-np.array([.5,.5,1,1,2,2,4,4.]);states=np.repeat([0,1],8);p,m=C.predict_fold(np.r_[a,b],states,np.full((2,5),-3.),np.array([0,1]),np.full((2,5),.2));self.assertEqual(m['median'],[1.5,1.5]);np.testing.assert_array_equal(p[1,:,0],[.125,.125]);np.testing.assert_array_equal(p[2,:,0],[0,.25])
 def test_inclusive_ecdf_canonical_C_and_monotonicity(self):
  x=np.array([-2.,-2.,0,1]);self.assertEqual(C.ecdf(x,np.array([-2.]))[0],.5);self.assertEqual(C.ecdf(x,np.array([np.nextafter(-2.,-np.inf)]))[0],0)
  z=np.r_[[-1.,np.nextafter(-1.,-np.inf),0,1],[-2,-1,0,2]];st=np.repeat([0,1],4);t=np.array([[-2.,-1.,0.,.5,1.],[-2.,-1.,0.,.5,1.]]);p,_=C.predict_fold(z,st,t,np.array([0,1]),np.full((2,5),.2));self.assertTrue(np.all(np.diff(p,axis=2)>=0));np.testing.assert_array_equal(p[2,0],C.ecdf(z[:4],t[0]));np.testing.assert_array_equal(p[2,1],C.ecdf(z[4:],t[1]));self.assertLess(p[2,0,2],1)
 def test_shared_fallback_unknown_degenerate_and_invalid_query(self):
  raw=np.array([[.1,.2,.3,.4,.5]]);t=np.full((1,5),-.1)
  for z,st in [(np.array([]),np.array([],int)),(np.array([-1.,0.]),np.array([0,0])),(np.array([0.,0.,1.,-1.]),np.array([0,0,0,1]))]:
   p,m=C.predict_fold(z,st,t,np.array([1]),raw);np.testing.assert_array_equal(p[1],p[0]);np.testing.assert_array_equal(p[2],p[0])
  p,_=C.predict_fold(np.array([-2,-1,-4,-2.]),np.array([0,0,1,1]),t,np.array([-1]),raw);np.testing.assert_array_equal(p[1],p[0]);np.testing.assert_array_equal(p[2],p[0])
  p,_=C.predict_fold(np.array([-1.,-2.]),np.array([0,1]),np.full((1,5),np.nan),np.array([0]),raw)
  for arm in p:np.testing.assert_array_equal(arm,raw)
  _,_,reason=C.fit_libraries(np.array([1e-308,1e-308,1e308,-1.,-2.,-3.]),np.array([0,0,0,1,1,1]));self.assertEqual(reason,'nonfinite_W')
  p,m=C.predict_fold(np.array([1e-320,2e-320,-1.,-2.]),np.array([0,0,1,1]),t,np.array([0]),raw);np.testing.assert_array_equal(p[1],p[0]);np.testing.assert_array_equal(p[2],p[0]);self.assertEqual(m['conditional_query_invalid_n'],1)
 def test_quarter_maturity_equality_next_bar_and_own_asset(self):
  q=C.EVAL;ts=np.array([q-24*3600,q-24*3600+1,q]);np.testing.assert_array_equal(C.mature_mask(ts,24,q),[True,False,False]);d=fixture();p,_,folds=C.make_predictions(d,24,0);self.assertTrue(all(x['library_label_end_max'] is None or x['library_label_end_max']<=x['quarter_start'] for x in folds))
  changed=copy.deepcopy(d);future=changed['ts']>=C.EVAL;changed['future_log_min'][future]=-1000;changed['y'][future]=1;p2,_,_=C.make_predictions(changed,24,0);ix=(d['ts']>=C.EVAL)&(d['ts']<C.quarter_starts()[1]);np.testing.assert_array_equal(p[:,ix],p2[:,ix])
  other=copy.deepcopy(d);other['sid'][:]=2;other['future_log_min']*=100;combined={k:np.concatenate([d[k],other[k]]) for k in d};p3,_,_=C.make_predictions(combined,24,0);np.testing.assert_array_equal(p,p3[:,:len(d['ts'])])
 def test_nonfallback_matched_scores_and_bad_quarter_fail_closed(self):
  d=fixture();p,_,_,nf=C.make_predictions(d,24,0,return_support=True);rows=C.nonfallback_views(d,p,nf);self.assertEqual(len(rows),3);self.assertEqual(rows[0]['scored_n'],int(np.sum(nf&d['label_valid'])))
  self.assertTrue(all(set(x['arms'])=={'A_pooled_Z','B_pooled_W','C_state_Z'} for x in rows))
  bad=copy.deepcopy(d);bad['quarter_cutoff'][0]=bad['ts'][0]+1
  with self.assertRaisesRegex(ValueError,'future feature quarter'):C.make_predictions(bad,24,0)
  bad=copy.deepcopy(d);bad['quarter_cutoff'][8]=C.START
  with self.assertRaisesRegex(ValueError,'own evaluation quarter'):C.make_predictions(bad,24,0)
 def test_hash_first_byte_payload_and_horizon_independence(self):
  sid=np.arange(1,20);ts=np.full(19,C.EVAL);got=C.hash_states(sid,ts);expected=np.array([hashlib.sha256(f'Q26-R17-COND-NEGATIVE-v1:{int(a)}:{int(b)}'.encode()).digest()[0]&1 for a,b in zip(sid,ts)]);np.testing.assert_array_equal(got,expected);np.testing.assert_array_equal(got,C.hash_states(sid,ts));self.assertEqual(len(np.unique(got)),2)
 def test_uint8_positive_logloss_and_raw_Brier(self):
  y=np.array([[1,0,1,0,1]],np.uint8);p=np.array([[0,.2,.7,1,.9]]);r=C.score(y,p);clipped=np.clip(p,1e-6,1-1e-6);np.testing.assert_allclose(r['bounded_logloss'],np.where(y==1,-np.log(clipped),-np.log1p(-clipped)).mean(0));np.testing.assert_array_equal(r['brier'],((p-y.astype(float))**2).mean(0));self.assertEqual(r['logloss_clipped'],[1,0,0,1,0])
 def test_views_retained_and_unknown_bounds(self):
  d=fixture();p,_,_=C.make_predictions(d,24,0);h=helper();cuts={name:{'cut':0.} for name in h.AXES};rows=C.summarize_views(d,p,cuts,[1,2],h);self.assertEqual(len(rows),32);self.assertEqual(len(C.summarize_views(d,p,cuts,list(range(1,25)),h)),54);self.assertEqual(rows[0]['view'],'pooled');self.assertEqual(rows[1]['view'],'2024');self.assertTrue(any(x['view']=='2' and x['scored_n']==0 for x in rows));self.assertTrue(all(set(x['arms'])==set(C.ARMS) for x in rows))
  y=np.array([[1]*5,[0]*5],np.uint8);v=np.array([True,False]);a=np.full((2,5),.8);b=np.full((2,5),.2);r=C.pair_bounds(y,v,a,b);self.assertEqual(r['unknown_n'],1);self.assertTrue(np.all(np.array(r['lower'])<=np.array(r['upper'])))
 def test_primary_sensitivity_literal_repeat_and_LOAO(self):
  d=fixture();p,_,_=C.make_predictions(d,24,0);h=helper();out=C.primary_sensitivity(d,p,h);self.assertEqual(len(out['targets']),6);keys,w=h.draw_plan();mask=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']>=C.EVAL)&(d['ts']<C.END);bi=np.searchsorted(keys,h.block_keys(d['ts'][mask]));y=d['y'][mask,2].astype(float);loss=(p[3,mask,2]-y)**2-(p[2,mask,2]-y)**2;literal=[]
  for weights in w:
   v=np.repeat(loss,weights[bi]);literal.append(float(v.mean()) if len(v) else np.nan)
  target=out['targets'][0]['sensitivity'];valid=np.isfinite(literal);self.assertEqual(target['defined_replicates'],[int(valid.sum())]);np.testing.assert_allclose(target['sd'],[np.std(np.array(literal)[valid],ddof=1)],rtol=2e-13,atol=2e-13);lo=C.leave_one_out(d,p,[1,2]);self.assertEqual(len(lo),6);self.assertTrue(all(x['n']==0 for x in lo if x['omitted_sid']==1))
 def test_raw_reference_reconciliation_fixture(self):
  d=fixture();p,_,_=C.make_predictions(d,24,0);h=helper();cuts={name:{'cut':0.} for name in h.AXES};rows=C.summarize_views(d,p,cuts,[1,2],h);refs=[]
  for row in rows:
   if row['view_type'] not in ['calendar','asset']:continue
   kind='all' if row['view']=='pooled' else ('year' if row['view_type']=='calendar' else 'asset');group='all' if kind=='all' else row['view'];a=row['arms']['raw_fH']
   for j,b in enumerate(C.BARRIERS):refs.append(dict(prediction='baseline_raw',group_type=kind,group=group,barrier=float(b),n=a['n'],events=a['events'][j],brier=a['brier'][j],bounded_logloss=a['bounded_logloss'][j],sum_probability=a['mean_probability'][j]*a['n'] if a['n'] else 0))
  ref={'horizons':[dict(horizon_hours=24,scores=refs)]};self.assertGreater(C.reference_check(rows,24,ref),0);ref['horizons'][0]['scores'][0]['brier']+=.01
  with self.assertRaisesRegex(ValueError,'reference mean'):C.reference_check(rows,24,ref)
 def test_cross_horizon_exact_common_issuance_masks(self):
  retained={}
  for h in C.HORIZONS:retained[h]=dict(sid=np.array([1,1]),ts=np.array([C.EVAL,C.EVAL+86400]),available=np.array([True,h==6]),pred=np.full((6,2,5),.5 if h==6 else .4))
  out=C.cross_horizon(retained);self.assertEqual(len(out),60);first=out[0];self.assertEqual(first['common_origins'],1);self.assertEqual(first['violations'],5);self.assertAlmostEqual(first['max_positive_violation'],.1)
 def test_draft_refuses_and_failure_retained_without_real_arrays(self):
  with tempfile.TemporaryDirectory() as td:
   with self.assertRaisesRegex(ValueError,'not admitted'):C.run({'status':'DRAFT'},Path(td)/'a')
   out=Path(td)/'b'
   with patch.object(C,'admission',side_effect=ValueError('synthetic pin failure')):
    with self.assertRaises(ValueError):C.run({'status':'PARENT_FROZEN_COMPARISON'},out)
   self.assertTrue((out/'failure.json').exists());self.assertTrue((out/'resource-receipt.json').exists())
if __name__=='__main__':unittest.main(verbosity=2)
