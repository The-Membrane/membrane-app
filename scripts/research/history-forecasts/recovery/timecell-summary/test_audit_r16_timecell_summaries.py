"""Synthetic JSON fixtures only. Never aggregate the accepted market-data descriptor."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import audit_r16_timecell_summaries as A
S=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts')
LABELS=((1,-.02),(1,-.03),(1,-.05),(3,-.02),(3,-.03),(3,-.05),(3,-.07),(12,-.02),(12,-.03),(12,-.05),(12,-.07),(12,-.1))
def fixture():
 counts={str(T):{f'{h},{q}':10 if h==0 else 90 for h in (0,1) for q in (0,1)} for T in (1,3,12)};cells=[]
 for m in A.MODELS:
  for h in (0,1):
   for q in (0,1):
    for T,k in LABELS:
     n=counts[str(T)][f'{h},{q}'];bf=.1 if h==0 else .4;bm=.05 if h==0 else .4
     cells.append(dict(model=m,hash_half=h,time_half=q,horizon_hours=T,barrier=k,n=n,observed_count=n//5,observed_rate=.2,predicted_mean=.2,reference_predicted_mean=.2,brier_model=bm,brier_fH=bf,brier_difference=bm-bf,model_calibration_ratio=1.,fH_calibration_ratio=1.,mean_abs_probability_deviation_fH=.1,max_abs_probability_deviation_fH=.2,fraction_exactly_identical_fH=0.,fraction_within_1e_6_fH=0.))
 d=dict(complete=True,**A.IDENTITIES,tsplit_float=100.,daily_cell_counts=counts,cells=cells,evidence_pins=['POISON_PRIVATE_MANIFEST_NOT_FOR_EXPORT'],unknown_secret='DO_NOT_EXPORT',source_sha256={str(S/'r16_nn.py'):A.SOURCE['nn_source'],str(S/'r16_dev.py'):A.SOURCE['dev_source']})
 t=dict(complete=True,pooled_median_origin=100.,cells=[dict(cell=[h,q],test=dict(by_horizon={str(T):10 if h==0 else 90 for T in (1,3,12)}),support_status='unsupported' if q==0 else 'nonempty_support_only',unsupported_reasons=['no_validation'] if q==0 else []) for h in (0,1) for q in (0,1)])
 return d,t

def request_fixture(root):
 d,t=fixture();desc=root/'descriptive.json';desc.write_text(json.dumps(d));census=root/'census.json';census.write_text(json.dumps(t));accepted=root/'parent.json';accepted.write_text(json.dumps(dict(complete=True,result=A.pin(census),cells=4,support_blocks_verified=36)));proof=root/'proof.json';proof.write_text('synthetic runtime identity')
 art=dict(implementation=A.pin(A.__file__),tests=A.pin(__file__),nn_source=A.pin(S/'r16_nn.py'),dev_source=A.pin(S/'r16_dev.py'),runtime_proof=A.pin(proof),accepted_descriptive=A.pin(desc),temporal_result=A.pin(census),temporal_parent_acceptance=A.pin(accepted));r=root/'request.json';r.write_text(json.dumps(dict(schema=A.SCHEMA,admission_status='parent_accepted',policy=A.POLICY,artifacts=art,runtime=A.runtime(),labels=LABELS)));return r,A.sha(desc)
class SyntheticTests(unittest.TestCase):
 def test_source_derived_labels(self):self.assertEqual(A.labels_from_source(S/'r16_dev.py'),LABELS)
 def test_weighted_SSE_BSS_not_average(self):
  d,t=fixture();v=A.aggregate(d,t,LABELS);r=v['hash_merged_labels'][0];self.assertAlmostEqual(r['BSS'],1-36.5/37);self.assertNotAlmostEqual(r['BSS'],.25);self.assertEqual(r['n'],100);self.assertEqual(r['observed_count'],20);self.assertEqual(r['model_calibration_ratio'],1)
 def test_pooled_R_not_unweighted_mean(self):
  d,t=fixture()
  for c in d['cells']:
   c['predicted_mean']=.1 if c['hash_half']==0 else .3;c['model_calibration_ratio']=c['predicted_mean']/.2
  r=A.aggregate(d,t,LABELS)['hash_merged_labels'][0];self.assertAlmostEqual(r['model_calibration_ratio'],1.4);self.assertNotAlmostEqual(r['model_calibration_ratio'],1.)
 def test_mean12_distinct_from_exposure_pooled_BSS(self):
  d,t=fixture()
  for c in d['cells']:
   if c['horizon_hours']==1 and c['barrier']==-.02:c.update(brier_fH=.01,brier_model=.005,brier_difference=-.005)
  v=A.aggregate(d,t,LABELS);summary=v['model_time_summaries'][0];rows=[r for r in v['hash_merged_labels'] if r['model']==A.MODELS[0] and r['time_half']==0]
  self.assertAlmostEqual(summary['mean12_label_BSS'],sum(r['BSS'] for r in rows)/12);self.assertNotAlmostEqual(summary['mean12_label_BSS'],summary['exposure_pooled_BSS'])
 def test_full_closure_and_ties(self):
  d,t=fixture();v=A.aggregate(d,t,LABELS);self.assertEqual((len(v['raw_cell_projection']),len(v['hash_merged_labels']),len(v['model_time_summaries']),len(v['all_12h_minus10pct_original_cells'])),(240,120,10,20));self.assertTrue(all(len(s['weakest_defined_labels'])==12 for s in v['model_time_summaries']))
 def test_missing_and_duplicate_refused(self):
  for operation in ('missing','duplicate'):
   d,t=fixture()
   if operation=='missing':d['cells'].pop()
   else:d['cells'][-1]=copy.deepcopy(d['cells'][0])
   with self.subTest(operation=operation),self.assertRaises(A.SummaryFailure):A.aggregate(d,t,LABELS)
 def test_reference_consistency_refused(self):
  d,t=fixture();d['cells'][48]['brier_fH']=.11;d['cells'][48]['brier_difference']=d['cells'][48]['brier_model']-.11
  with self.assertRaisesRegex(A.SummaryFailure,'shared reference'):A.aggregate(d,t,LABELS)
 def test_metric_arithmetic_refused(self):
  d,t=fixture();d['cells'][0]['model_calibration_ratio']=123.
  with self.assertRaisesRegex(A.SummaryFailure,'R must'):A.aggregate(d,t,LABELS)
 def test_zero_reference_and_observation_nulls(self):
  d,t=fixture()
  for c in d['cells']:
   c.update(brier_fH=0.,brier_difference=c['brier_model'],observed_count=0,observed_rate=0.,model_calibration_ratio=None,fH_calibration_ratio=None)
  v=A.aggregate(d,t,LABELS);self.assertTrue(all(r['derived_BSS'] is None for r in v['raw_cell_projection']));self.assertTrue(all(r['BSS'] is None and r['model_calibration_ratio'] is None for r in v['hash_merged_labels']));self.assertTrue(all(s['mean12_label_BSS'] is None and s['weakest_defined_labels']==[] for s in v['model_time_summaries']))
 def test_census_mismatch_refused(self):
  d,t=fixture();t['cells'][0]['test']['by_horizon']['1']=11
  with self.assertRaisesRegex(A.SummaryFailure,'O66'):A.aggregate(d,t,LABELS)
 def test_poison_manifest_omitted_exact_projection(self):
  d,t=fixture();v=A.aggregate(d,t,LABELS);encoded=json.dumps(v);self.assertNotIn('POISON_PRIVATE',encoded);self.assertNotIn('DO_NOT_EXPORT',encoded);self.assertNotIn('evidence_pins',v)
  self.assertEqual(set(v['raw_cell_projection'][0]),set(A.CELL_FIELDS)|{'derived_BSS','BSS_status'})
 def test_draft_refusal_precedes_input_access(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'draft';p.write_text(json.dumps(dict(admission_status='DRAFT')))
   with patch.object(A,'check_pin',side_effect=AssertionError('premature input')),patch.object(A,'aggregate',side_effect=AssertionError('premature aggregate')):
    with self.assertRaisesRegex(A.SummaryFailure,'review required'):A.authenticate(p,A.sha(p))
 def test_complete_synthetic_IPC(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r,deschash=request_fixture(root)
   with patch.object(A,'DESC_SHA',deschash):v=A.run(r,A.sha(r),root/'out')
   self.assertTrue(v['complete']);text=(root/'out/result.json').read_text();self.assertNotIn('POISON_PRIVATE',text);self.assertNotIn('DO_NOT_EXPORT',text);self.assertLess(len(text.encode()),A.POLICY['output_bytes'])
 def test_tamper_failure_before_aggregation(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r,deschash=request_fixture(root);desc=root/'descriptive.json';desc.write_text(desc.read_text()+' ')
   with patch.object(A,'DESC_SHA',deschash),patch.object(A,'aggregate',side_effect=AssertionError('premature aggregation')):
    with self.assertRaises(A.SummaryFailure):A.run(r,A.sha(r),root/'out')
   f=json.loads((root/'out/failure.json').read_text());self.assertEqual((f['stage'],f['error_code']),('authenticate','PIN_CHANGED'))
if __name__=='__main__':unittest.main()
