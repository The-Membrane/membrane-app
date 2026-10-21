"""Synthetic fixtures only. No admitted scientific NPZ or outcome arrays opened."""
import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import conditional_depth_v2 as C

def fixture():
 ts=np.array([C.TRAIN0,C.TRAIN0+86400,C.EVAL0-86400,C.EVAL0,C.EVAL0+86400,C.YEAR25-86400,C.YEAR25,C.YEAR25+86400],np.int64);n=len(ts)
 xb=np.zeros((n,12),np.float32);xb[:,0]=np.log(2);xb[:,1]=np.log(4);xs=np.zeros((n,6),np.float32);xs[:,0]=np.arange(n)%2;xs[:,3]=np.linspace(-1,1,n)
 depth=np.array([-.04,-.08,-.1,-.12,np.nan,-.03,-.25,-.07]);lv=np.isfinite(depth);p=np.tile([.01,.04,.1,.3,.6],(n,1));p[-1]=np.nan
 return dict(sid=np.ones(n,np.int32),ts=ts,issue_eligible=np.ones(n,bool),fH_fallback=np.array([0,0,0,0,0,1,0,0],bool),Xbase=xb,Xshape=xs,p_fH=p,p_fH_valid=np.isfinite(p).all(1),label_valid=lv,legacy_label_valid=lv.copy(),future_missing_hours=(~lv).astype(np.int32),future_log_min=depth,y=np.where(lv[:,None],depth[:,None]<=np.log1p(C.BARRIERS),False).astype(np.uint8))
class Tests(unittest.TestCase):
 def test_cuts_no_future_or_labels(self):
  d=fixture();a=C.cut_table(d);e=copy.deepcopy(d);future=e['ts']>=C.EVAL0;e['Xbase'][future]=1e30;e['Xshape'][future]=-1e30;e['fH_fallback'][future]=True;e['y'][:]=255;e['future_log_min'][:]=-100;e['p_fH'][:]=.9
  self.assertEqual(json.dumps(a,sort_keys=True),json.dumps(C.cut_table(e),sort_keys=True));self.assertEqual(a['issued_log_sigma']['training_n'],3)
 def test_lazy_cuts_never_requests_label_probability_members(self):
  d=fixture();seen=[]
  class Lazy:
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def __getitem__(self,k):
    seen.append(k)
    if k not in C.CUT_KEYS:raise AssertionError('forbidden member')
    return d[k]
  with patch.object(C.np,'load',return_value=Lazy()):C.read_columns('synthetic.npz','cuts')
  self.assertEqual(seen,list(C.CUT_KEYS));self.assertFalse(set(seen)&set(C.LABEL_KEYS))
 def test_scale_fallback_and_8760(self):
  d=fixture();d['Xbase'][5,0]=np.nan
  self.assertEqual(C.effective(d)[5],float(d['Xbase'][5,1]));self.assertTrue(np.isnan(d['Xbase'][5,0]))
  self.assertAlmostEqual(float(np.exp(C.effective(d)[3])*np.sqrt(24/8760)),2*np.sqrt(24/8760),places=7)
 def test_ties_unknown_empty_axis_views(self):
  d=fixture();d['Xshape'][:,0]=0;d['Xshape'][1,0]=np.nan;cuts=C.cut_table(d);self.assertEqual(cuts['jump_share_D']['cut'],0)
  v=C.views(d,cuts,[1,2]);self.assertEqual(sum(m.sum() for k,n,m in v if k=='jump_share_D' and n=='high/pooled'),0)
  d['Xshape'][:,0]=np.nan;cuts=C.cut_table(d);self.assertIsNone(cuts['jump_share_D']['cut']);self.assertEqual(next(m for k,n,m in C.views(d,cuts,[1]) if k=='jump_share_D' and n=='unknown/pooled').sum(),5)
 def test_weighted_quantile_exact_repeat_linear(self):
  rng=np.random.default_rng(617)
  for _ in range(24):
   x=rng.normal(size=11);w=rng.integers(0,5,size=11);q=np.array([0,.01,.05,.25,.5,.75,.99,1]);expected=np.quantile(np.repeat(x,w),q,method='linear');np.testing.assert_allclose(C.weighted_quantile(x,w,q),expected,rtol=2e-15,atol=2e-15)
  self.assertTrue(np.isnan(C.weighted_quantile([1,2],[0,0],[.5])).all())
  with self.assertRaises(ValueError):C.weighted_quantile([1],[-1],[.5])
 def test_calendar_year_split_and_draw_replay(self):
  ts=np.array([C.YEAR25-86400,C.YEAR25]);k=C.block_keys(ts);self.assertEqual(k[0]%1000000,k[1]%1000000);self.assertNotEqual(k[0],k[1]);a,w=C.draw_plan();b,v=C.draw_plan();np.testing.assert_array_equal(a,b);np.testing.assert_array_equal(w,v)
  for yr in [2024,2025]:
   ix=a//1000000==yr;np.testing.assert_array_equal(w[:,ix].sum(1),np.full(500,ix.sum()))
 def test_matched_shapes_losses_unknown_bounds(self):
  d=fixture();d['Xbase'][6,0]=np.nan;keys,w=C.draw_plan();r=C.analyze_horizon(d,24,C.cut_table(d),[1,2],keys,w)[0]
  take=(d['ts']>=C.EVAL0)&d['p_fH_valid']&d['label_valid'];matched=take&np.isfinite(C.effective(d));raw=d['future_log_min'][matched];z=raw/(np.exp(C.effective(d)[matched])*np.sqrt(24/8760))
  self.assertEqual(r['matched_effective_raw_depth']['n'],matched.sum());self.assertEqual(r['matched_effective_standardized_depth']['n'],matched.sum());np.testing.assert_array_equal(r['matched_effective_raw_depth']['quantiles'],np.quantile(raw,C.Q));np.testing.assert_array_equal(r['matched_effective_standardized_depth']['quantiles'],np.quantile(z,C.Q))
  np.testing.assert_allclose(r['brier'],np.mean((d['p_fH'][take]-d['y'][take])**2,axis=0));self.assertEqual(r['unknown_label_n'],1);self.assertEqual(r['scale_unavailable_scored_n'],1);self.assertEqual(r['matched_effective_n'],int(matched.sum()));np.testing.assert_allclose(r['matched_effective_predicted_minus_observed'],(d['p_fH'][matched]-d['y'][matched]).mean(0))
  avail=(d['ts']>=C.EVAL0)&d['p_fH_valid'];pos=d['y'][take].sum(0);np.testing.assert_array_equal(r['all_available_event_frequency_bounds'],[pos/avail.sum(),(pos+1)/avail.sum()])
  self.assertEqual(len(r['matched_effective_sensitivity']['event_error']['weighted_denominators']),500)
 def test_label_tamper_and_empty_support(self):
  d=fixture();d['y'][3,0]=1;keys,w=C.draw_plan()
  with self.assertRaisesRegex(ValueError,'depth label'):C.analyze_horizon(d,24,C.cut_table(d),[1,2],keys,w)
  s=C.shape_stats(np.array([]));self.assertEqual(s['n'],0);self.assertEqual(s['ratios'],[None,None]);self.assertIsNone(C.nulls(float('nan')))
 def test_empty_bootstrap_replicates_preserved(self):
  d=fixture();keys,w=C.draw_plan();x=C.bootstrap(d,np.zeros(len(d['ts']),bool),np.array([]),keys,w);self.assertEqual(x['event_error']['undefined_replicates'],[500]*5);self.assertEqual(x['shape_ratios']['undefined_replicates'],[500]*2)
 def test_reference_reconciliation_and_refusal(self):
  row=dict(view_type='calendar',view='pooled',scored_n=2,positive_labels=[0,0,1,1,2],brier=[.1]*5,bounded_logloss=[.2]*5,mean_probability=[.3]*5)
  ref={'horizons':[{'horizon_hours':24,'scores':[dict(prediction='baseline_raw',group_type='all',group='all',barrier=float(b),n=2,events=row['positive_labels'][j],brier=.1,bounded_logloss=.2,sum_probability=.6) for j,b in enumerate(C.BARRIERS)]}]};self.assertEqual(C.reconcile([row],24,ref),15);ref['horizons'][0]['scores'][0]['brier']=.101
  with self.assertRaisesRegex(ValueError,'reference metric'):C.reconcile([row],24,ref)
 def test_nonfinite_standardized_quotient_is_counted_not_accepted(self):
  z,valid,bad=C.normalize(np.array([-1e308,-.1]),np.array([-700.,0.]),24)
  self.assertTrue(valid.all());self.assertTrue(bad[0]);self.assertFalse(bad[1]);self.assertFalse(np.isfinite(z[0]));self.assertTrue(np.isfinite(z[1]))
 def test_resource_failure_receipt_before_arrays(self):
  from collections import namedtuple
  disk=namedtuple('disk','total used free')(10,9,1)
  with tempfile.TemporaryDirectory() as td,patch.object(C,'authenticate',return_value=None),patch.object(C.shutil,'disk_usage',return_value=disk),patch.object(C,'read_columns',side_effect=AssertionError('arrays accessed')):
   out=Path(td)/'out'
   with self.assertRaisesRegex(RuntimeError,'resource cap'):C.execute({'status':'PARENT_FROZEN_CUTS'},'cuts',out)
   r=json.loads((out/'resource-receipt.json').read_text());self.assertEqual(r['min_free_bytes'],1);self.assertTrue((out/'failure.json').exists())
 def test_same_cohort_wrong_staging_request_refused(self):
  pins={'build_launch':{'path':'launch','sha256':'a','size':1},'manifest':{'path':'manifest','sha256':'b','size':2},'staging_request':{'path':'accepted-request','sha256':'c','size':3}}
  mon=dict(complete=True,exit_code=0,changed_pin_paths=[],request=pins['build_launch'],result_pins=[pins['manifest']]);launch=dict(argv=['python','build.py','--request','accepted-request','--sha256','c'],pins=[pins['staging_request']]);C.validate_launch(mon,launch,pins)
  # Same selected-cohort identity would not authorize a different request path/hash.
  wrong=copy.deepcopy(launch);wrong['argv'][3]='different-request-same-cohort'
  with self.assertRaisesRegex(ValueError,'request binding'):C.validate_launch(mon,wrong,pins)
  wrong=copy.deepcopy(mon);wrong['changed_pin_paths']=['changed-source']
  with self.assertRaisesRegex(ValueError,'monitor launch'):C.validate_launch(wrong,launch,pins)
  wrong=copy.deepcopy(mon);wrong['result_pins']=[]
  with self.assertRaisesRegex(ValueError,'manifest binding'):C.validate_launch(wrong,launch,pins)
 def test_positive_uint8_logloss_independent_oracle_and_dtype_invariance(self):
  d=fixture();keys,w=C.draw_plan();cuts=C.cut_table(d);row=C.analyze_horizon(d,24,cuts,[1,2],keys,w)[0]
  mask=d['issue_eligible']&(d['ts']>=C.EVAL0)&d['p_fH_valid']&d['label_valid'];labels=d['y'][mask];p=np.clip(d['p_fH'][mask],C.EPS,1-C.EPS)
  self.assertTrue(np.any(labels==1));oracle=np.where(labels==1,-np.log(p),-np.log1p(-p)).mean(0)
  np.testing.assert_allclose(row['bounded_logloss'],oracle,rtol=2e-15,atol=2e-15);self.assertTrue(np.all(oracle>0))
  broken=np.mean(-labels*np.log(p)-(1-labels)*np.log1p(-p),axis=0);self.assertLess(float(np.min(broken)),0)
  for dtype in [np.float64,np.int64,bool]:
   alt=copy.deepcopy(d);alt['y']=alt['y'].astype(dtype);r=C.analyze_horizon(alt,24,cuts,[1,2],keys,w)[0]
   np.testing.assert_array_equal(r['bounded_logloss'],row['bounded_logloss']);np.testing.assert_array_equal(r['brier'],row['brier'])
 def test_execution_source_identity_refuses_substitution(self):
  r=dict(execution_source_pin=C.pin(C.__file__),execution_tests_pin=C.pin(__file__),operational_amendment={'failed_v1_evidence':[]});C.execution_identity(r)
  wrong=copy.deepcopy(r);wrong['execution_source_pin']['path']=__file__
  with self.assertRaisesRegex(ValueError,'execution source path'):C.execution_identity(wrong)
  wrong=copy.deepcopy(r);wrong['execution_tests_pin']['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'changed pin'):C.execution_identity(wrong)
 def test_predecessor_budget_and_frozen_cut_binding(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);oldpath=root/'analyze.request.parent.json';outerpath=root/'analysis-v1.outer-receipt.json';failpath=root/'failure.json';cut=dict(path='cuts-v1/result.json',size=7,sha256='cutsha');historical_source=dict(path='historical-source',size=1,sha256='srcsha');r=dict(pins={'source':historical_source},inputs={'6':'same'},parent_frozen_cuts_pin=cut,policy={'wall_seconds':116})
   oldpath.write_text(json.dumps(dict(pins=r['pins'],inputs=r['inputs'],parent_frozen_cuts_pin=cut)));oldpin=C.pin(oldpath);expected={str(oldpath):oldpin['sha256'],'historical-source':'srcsha',str((Path(C.__file__).parent/cut['path']).resolve()):'cutsha'}
   outer=dict(phase='analyze',returncode=1,timed_out=False,outer_elapsed_seconds=3.162,expected_pins=expected,post_pins=expected.copy());outerpath.write_text(json.dumps(outer));failpath.write_text(json.dumps(dict(complete=False,phase='analyze',stage='horizon-6',error_class='ValueError')))
   r['operational_amendment']={'failed_v1_evidence':[oldpin,C.pin(outerpath),C.pin(failpath)],'budget':dict(original_analysis_seconds=120,charged_failed_seconds=4,remaining_seconds=116,old_outer_elapsed_seconds=3.162)};C.validate_predecessor(r)
   bad=copy.deepcopy(r);bad['operational_amendment']['budget']['remaining_seconds']=120
   with self.assertRaisesRegex(ValueError,'budget'):C.validate_predecessor(bad)
   bad=copy.deepcopy(r);bad['inputs']={'6':'different'}
   with self.assertRaisesRegex(ValueError,'closure'):C.validate_predecessor(bad)
   cp=dict(cut,path=str((Path(C.__file__).parent/cut['path']).resolve()));C.validate_cut_pin(r,cp);cp['sha256']='different'
   with self.assertRaisesRegex(ValueError,'cuts changed'):C.validate_cut_pin(r,cp)
 def test_frozen_request_refuses_before_arrays(self):
  with tempfile.TemporaryDirectory() as td,patch.object(C,'read_columns',side_effect=AssertionError('array accessed')):
   with self.assertRaisesRegex(ValueError,'not admitted'):C.execute({'status':'DRAFT'},'cuts',Path(td)/'out')
 def test_authentication_failure_preserves_receipt(self):
  with tempfile.TemporaryDirectory() as td,patch.object(C,'authenticate',side_effect=ValueError('syntheticpinchange')):
   out=Path(td)/'out'
   with self.assertRaises(ValueError):C.execute({'status':'PARENT_FROZEN_CUTS'},'cuts',out)
   r=json.loads((out/'failure.json').read_text());self.assertEqual(r['stage'],'admission');self.assertEqual(r['columns_read'],[]);resource=json.loads((out/'resource-receipt.json').read_text());self.assertGreater(resource['peak_rss_bytes'],0);self.assertGreater(resource['min_free_bytes'],0);self.assertEqual(resource['observations'][-1]['stage'],'admission')
if __name__=='__main__':unittest.main(verbosity=2)
