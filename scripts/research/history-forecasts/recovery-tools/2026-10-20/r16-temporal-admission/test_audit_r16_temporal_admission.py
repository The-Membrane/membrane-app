"""Synthetic metadata only. No historical NPZ archives are decompressed."""
import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import audit_r16_temporal_admission as A
S=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts')
def keys4():
 keys=[None]*4
 for i in range(1000):
  key='synthetic-'+str(i);g=int(A.groups_of([key])[0])
  if keys[g] is None:keys[g]=key
  if all(k is not None for k in keys):return keys
 raise AssertionError('synthetic group keys unavailable')
def fixture():
 rows=[(sid,h*A.STEP,T) for T in A.HORIZONS for sid in range(4) for h in (0,12,24,36,48,60,72)]
 return {k:np.array([r[j] for r in rows],dtype=np.int64) for j,k in enumerate(('sid','ts','T'))}
def accepted_request(root):
 keys=keys4();R=fixture();meta=root/'meta.json';meta.write_text(json.dumps(dict(series=keys)));outputs={};art={}
 for T in A.HORIZONS:
  mask=R['T']==T;d={k:R[k][mask] for k in ('sid','ts')};p=root/f'rows-T{T}.npz';np.savez(p,**d,y=np.array(['MUST NOT LOAD'],dtype=object),fH=np.array(['MUST NOT LOAD'],dtype=object));art[f'rows_T{T}']=A.pin(p);outputs[str(T)]=dict(rows=int(mask.sum()),file_bytes=p.stat().st_size,sha256=A.sha(p),canonical_field_sha256={k:A.fieldsha(v) for k,v in d.items()})
 receipt=root/'accepted.json';receipt.write_text(json.dumps(dict(complete=True,all_51_concatenated_fields_verified=True,metadata_sha256=A.sha(meta),outputs=outputs)))
 proof=root/'runtime.json';proof.write_text(json.dumps(A.runtime()));art.update(implementation=A.pin(A.__file__),tests=A.pin(__file__),nn_source=A.pin(S/'r16_nn.py'),dev_source=A.pin(S/'r16_dev.py'),runtime_proof=A.pin(proof),parent_merge_admission=A.pin(receipt),rows_meta=A.pin(meta))
 request=root/'request.json';request.write_text(json.dumps(dict(schema=A.SCHEMA,admission_status='parent_accepted',horizons=A.HORIZONS,policy=A.POLICY,allowed_npz_members=['sid','ts'],runtime=A.runtime(),artifacts=art)));return request
class SyntheticTests(unittest.TestCase):
 def test_exact_original_masks_median_daily_and_validation(self):
  R=fixture();v=A.census(R,keys4());self.assertEqual(v['pooled_median_origin'],36*A.STEP);self.assertEqual(len(v['cells']),4)
  for cell in v['cells']:
   sh,tt=cell['cell'];self.assertEqual(cell['original_validation_group'],1 if sh==0 else 0);self.assertEqual(cell['test']['horizon_row_exposures'],12);self.assertEqual(cell['test']['by_horizon'],{'1':4,'3':4,'12':4});self.assertEqual(cell['original']['eligible']['horizon_row_exposures'],18);self.assertEqual(cell['original']['train_before_caps']['horizon_row_exposures'],9);self.assertEqual(cell['original']['validation_before_cap']['horizon_row_exposures'],9)
   if tt==0:self.assertEqual(cell['strict_preserving_validation_group']['eligible']['horizon_row_exposures'],0);self.assertEqual(cell['support_status'],'unsupported')
   else:self.assertEqual(cell['strict_preserving_validation_group']['eligible']['horizon_row_exposures'],24);self.assertEqual(cell['strict_preserving_validation_group']['validation_before_cap']['horizon_row_exposures'],12)
 def test_pooled_duplicate_horizon_median_not_unique_timestamp_median(self):
  R=dict(sid=np.array([0,0,0,0,1,1]),ts=np.array([0,0,0,12,48,72])*A.STEP,T=np.array([1,3,12,1,1,1]));v=A.census(R,keys4());self.assertEqual(v['pooled_median_origin'],6*A.STEP);self.assertNotEqual(v['pooled_median_origin'],float(np.median(np.unique(R['ts']))));self.assertEqual(v['pooled_horizon_rows'],6)
 def test_original_future_label_proportions(self):
  v=A.census(fixture(),keys4());early=v['cells'][0]['original'];self.assertEqual(early['train_before_caps']['own_label_after_test_start']['fraction'],1.);self.assertEqual(early['validation_before_cap']['own_label_after_test_end']['fraction'],1.);self.assertEqual(early['eligible']['unique_series'],2);self.assertEqual(early['eligible']['unique_groups'],2)
 def test_cutoff_boundary_12h_inclusive(self):
  v=A.census(fixture(),keys4());late=v['cells'][1];self.assertEqual(late['strict_cutoff_timestamp'],48*A.STEP);strict=late['strict_preserving_validation_group']['eligible'];self.assertEqual(strict['origin_timestamps']['max'],36*A.STEP);self.assertEqual(strict['Tmax_label_available_timestamps']['max'],48*A.STEP);self.assertEqual(strict['own_label_after_test_start']['count'],0)
 def test_no_validation_group_replacement(self):
  R=dict(sid=np.array([0,0,2,2,1,1,3,3]),ts=np.array([48,72,48,72,144,168,0,12])*A.STEP,T=np.ones(8,dtype=np.int64));c=A.census(R,keys4())['cells'][0]
  self.assertEqual(c['original_validation_group'],1);self.assertEqual(c['strict_preserving_validation_group']['validation_before_cap']['horizon_row_exposures'],0);self.assertIn('preserved_original_validation_group_empty',c['unsupported_reasons']);self.assertEqual(c['diagnostic_only_minimum_strict_group']['group'],3);self.assertEqual(c['diagnostic_only_minimum_strict_group']['validation']['horizon_row_exposures'],2);self.assertFalse(c['diagnostic_only_minimum_strict_group']['applied']);self.assertEqual(c['support_status'],'unsupported')
 def test_original_empty_eligibility_explicit_not_silently_repaired(self):
  R=dict(sid=np.array([0,1,2,3]),ts=np.array([0,0,0,0]),T=np.array([1,1,1,1]));v=A.census(R,keys4());late=v['cells'][1];self.assertEqual(late['original_execution_status'],'would_fail_empty_original_eligibility');self.assertEqual(late['support_status'],'unsupported');self.assertIsNone(late['original_validation_group'])
 def test_only_allowlisted_members_loaded(self):
  class Archive:
   files=['sid','ts','y','fH','predictions'];seen=[]
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def __getitem__(self,key):self.seen.append(key);self.assert_allowed(key);return np.array([1])
   def assert_allowed(self,key):
    if key not in ('sid','ts'):raise AssertionError('forbidden outcome/prediction member')
  z=Archive()
  with patch.object(A.np,'load',return_value=z) as load:A.read_metadata_npz('synthetic-only')
  self.assertEqual(z.seen,['sid','ts']);load.assert_called_once_with('synthetic-only',allow_pickle=False)
 def test_original_source_groups_match_exact(self):
  fn=A.source_contract(S/'r16_nn.py',S/'r16_dev.py');np.testing.assert_array_equal(fn(keys4()),A.groups_of(keys4()))
 def test_draft_refuses_before_any_input_or_npz_read(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'draft.json';p.write_text(json.dumps(dict(admission_status='DRAFT')))
   with patch.object(A,'check_pin',side_effect=AssertionError('input touched')),patch.object(A.np,'load',side_effect=AssertionError('archive touched')):
    with self.assertRaisesRegex(A.AdmissionFailure,'review required'):A.authenticate(p,A.sha(p))
 def test_input_tamper_prevents_npz_access_and_preserves_failure(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r=accepted_request(root);p=root/'rows-T1.npz';p.write_bytes(p.read_bytes()+b'tamper')
   with patch.object(A.np,'load',side_effect=AssertionError('archive touched')):
    with self.assertRaises(A.AdmissionFailure):A.run(r,A.sha(r),root/'out')
   failure=json.loads((root/'out/failure.json').read_text());self.assertEqual((failure['stage'],failure['error_code']),('authenticate','PIN_CHANGED'))
 def test_complete_synthetic_ipc_no_outcomes_loaded(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r=accepted_request(root);v=A.run(r,A.sha(r),root/'out');self.assertTrue(v['complete']);self.assertEqual(len(v['cells']),4);self.assertEqual([p['members_loaded'] for p in v['NPZ_members_loaded']],[['sid','ts']]*3);self.assertTrue((root/'out/result.json').is_file());self.assertNotIn('torch',A.sys.modules)
 def test_timestamp_and_field_identity_failures(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r=accepted_request(root);request=json.loads(r.read_text());accepted=json.loads(Path(request['artifacts']['parent_merge_admission']['path']).read_text());accepted['outputs']['1']['canonical_field_sha256']['ts']='0'*64
   with self.assertRaisesRegex(A.AdmissionFailure,'canonical parent'):A.load_pooled(request,accepted,keys4())
if __name__=='__main__':unittest.main()
