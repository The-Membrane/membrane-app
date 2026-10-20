"""Synthetic-only tests; no historical matrices or predictions are loaded."""
import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import audit_r164_bootstrap_sensitivities as A

def fixture():
 mn=np.array([[1,2],[3,4]],dtype=np.int64);base=np.array([[-.125,.25],[-.0625,.125]])*mn
 return {g+'_'+f:v.copy() for g in A.GROUPS for f,v in dict(Mn=mn,Md=np.repeat(base[None],12,axis=0),MdLo=np.repeat((base-.001*mn)[None],12,axis=0),MdHi=np.repeat((base+.001*mn)[None],12,axis=0),SIDs=np.array([0,1],dtype=np.int64),BIDs=np.array([0,1],dtype=np.int64)).items()}

def accepted_request(root):
 arrays=fixture();matrix=root/'synthetic.npz';np.savez(matrix,**arrays)
 rr=root/'reconstruction-request.json';rr.write_text('synthetic reconstruction request')
 monitor=root/'monitor.json';monitor.write_text(json.dumps(dict(complete=True,exit_code=0,request_sha256=A.sha(rr))))
 rec=root/'reconstruction.json';rec.write_text(json.dumps(dict(complete=True,request=A.pin(rr),matrix=A.pin(matrix),comparison_order=A.COMPS,model_order=A.MODELS,groups=[dict(key=g,S=2,B=2,rows=10) for g in A.GROUPS],input_pins=[],source_pins=[],limitations='SYNTHETIC ONLY')))
 accept=root/'parent-synthetic.json';accept.write_text(json.dumps(dict(schema='codex-parent-r164-original-matrix-admission-v1',complete=True,request=A.pin(rr),monitor=A.pin(monitor),source=A.pin(A.ORIGINAL),matrix=A.pin(matrix),reconstruction=A.pin(rec))))
 proof=root/'runtime.json';proof.write_text(json.dumps(A.runtime()))
 artifacts=dict(implementation=A.pin(A.__file__),tests=A.pin(__file__),original_score_source=A.pin(A.ORIGINAL),runtime_proof=A.pin(proof),matrices=A.pin(matrix),reconstruction=A.pin(rec),parent_acceptance=A.pin(accept),reconstruction_request=A.pin(rr),reconstruction_monitor=A.pin(monitor))
 request=root/'request.json';request.write_text(json.dumps(dict(schema=A.SCHEMA,admission_status='parent_accepted',groups=A.GROUPS,comparison_order=A.COMPS,models=A.MODELS,modes=A.MODES,Nrep=A.NREP,seed=A.SEED,policy=A.POLICY,runtime=A.runtime(),artifacts=artifacts)))
 return request

class SyntheticTests(unittest.TestCase):
 def test_unequal_ratio_not_cell_mean(self):
  md=np.array([[1.,8.],[6.,16.]]);mn=np.array([[1,2],[3,4]])
  values,c=A.ratio_replicates(md,mn,np.ones((1,2)),np.ones((1,2)))
  self.assertEqual(c,0);self.assertEqual(values[0],3.1);self.assertNotEqual(values[0],np.mean(md/mn))
 def test_original_common_rng_combined(self):
  # Expand unequal cell counts into synthetic observations for original cells().
  cl=np.repeat([0,0,1,1],[1,2,3,4]);bl=np.repeat([0,1,0,1],[1,2,3,4]);d=np.repeat([-.125,.25,-.0625,.125],[1,2,3,4])
  ns=A.original_functions();old=ns['twoway_mean'](d,cl,bl,np.random.default_rng(np.random.SeedSequence([A.SEED,3])),n_rep=A.NREP)
  group=A.validate_arrays(fixture())[A.GROUPS[0]];result=A.analyze_group(A.GROUPS[0],group,3)['records'][0]
  self.assertAlmostEqual(old['mean_d'],result['point_mean'],places=15)
  self.assertAlmostEqual(old['sd'],result['bootstrap']['sample_SD_ddof1'],places=15)
  self.assertAlmostEqual(old['z'],result['bootstrap']['signed_z'],places=13)
  self.assertAlmostEqual(old['z_cgm'],result['CGM']['signed_z'],places=13)
 def test_balanced_additive_ratio(self):
  a=np.array([-.03,-.01,.01,.03]);b=np.array([-.002,0,.002]);md=-.01+a[:,None]+b;mn=np.ones((4,3),dtype=np.int64);ws,wb=A.draw_weights(4,3,0,50)
  got,_=A.ratio_replicates(md,mn,ws,wb);expect=-.01+ws@a/4+wb@b/3
  np.testing.assert_allclose(got,expect,rtol=0,atol=2e-17)
 def test_censor_without_redraw(self):
  md=np.array([[.125,0.],[0.,0.]]);mn=np.array([[1,0],[0,0]]);ws=np.array([[2.,0.],[0.,2.],[2.,0.]]);wb=np.array([[2.,0.],[2.,0.],[0.,2.]])
  v,c=A.ratio_replicates(md,mn,ws,wb);s=A.bootstrap_summary(v,c,.125,3)
  self.assertEqual((len(v),c),(1,2));self.assertEqual(s['redrawn_replicates'],0);self.assertIsNone(s['signed_z']);self.assertEqual(s['z_status'],'insufficient_valid_replicates')
 def test_zero_sd(self):
  s=A.bootstrap_summary(np.array([.125,.125]),0,.125,2)
  self.assertEqual(s['sample_SD_ddof1'],0);self.assertIsNone(s['favorable_z']);self.assertEqual(s['z_status'],'zero_SD')
 def test_negative_cgm(self):
  c=A.cgm_terms(np.array([[1.,-1.],[-1.,1.]]),np.ones((2,2)),0.)
  self.assertLess(c['net_score_variance'],0);self.assertIsNone(c['SD'])
 def test_exact_keys_dtype_and_empty_cell(self):
  arrays=fixture();arrays.pop(A.GROUPS[0]+'_BIDs')
  with self.assertRaisesRegex(A.ReviewFailure,'exact96'):A.validate_arrays(arrays)
  arrays=fixture();arrays[A.GROUPS[0]+'_Mn']=arrays[A.GROUPS[0]+'_Mn'].astype(float)
  with self.assertRaisesRegex(A.ReviewFailure,'int64'):A.validate_arrays(arrays)
  arrays=fixture();arrays[A.GROUPS[0]+'_Mn'][0,0]=0
  with self.assertRaisesRegex(A.ReviewFailure,'zero-count'):A.validate_arrays(arrays)
 def test_draft_refuses_before_metadata_or_rng(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'draft.json';p.write_text(json.dumps({'admission_status':'DRAFT_PENDING'}))
   with patch.object(A,'check_pin',side_effect=AssertionError('metadata accessed')),patch.object(A,'draw_weights',side_effect=AssertionError('draws')):
    with self.assertRaisesRegex(A.ReviewFailure,'must precede'):A.authenticate(p,A.sha(p))
 def test_source_and_input_tamper_before_draws(self):
  for artifact in ('original_score_source','matrices'):
   with self.subTest(artifact=artifact),tempfile.TemporaryDirectory() as td:
    root=Path(td);r=accepted_request(root);v=json.loads(r.read_text());f=root/'tampered';f.write_text('original synthetic');v['artifacts'][artifact]=A.pin(f);f.write_text('changed synthetic');r.write_text(json.dumps(v))
    with patch.object(A,'draw_weights',side_effect=AssertionError('premature draws')):
     with self.assertRaisesRegex(A.ReviewFailure,'identity changed'):A.run(r,A.sha(r),root/'out')
    failure=json.loads((root/'out/failure.json').read_text());self.assertEqual(failure['error_code'],'PIN_CHANGED');self.assertEqual(failure['stage'],'authenticate')
 def test_full_576_ipc_and_quantization_mean_only(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r=accepted_request(root);out=A.run(r,A.sha(r),root/'out');serialized=json.loads((root/'out/result.json').read_text())
   self.assertTrue(out['complete']);self.assertEqual(serialized['statistics'],576);self.assertEqual(len(serialized['groups']),16)
   for g in serialized['groups']:
    self.assertEqual(len(g['records']),36)
    for v in g['records']:
     self.assertFalse(v['quantization_envelope_is_SD_bound']);self.assertEqual(v['bootstrap']['valid_replicates'],2000)
   self.assertLess((root/'out/result.json').stat().st_size,A.POLICY['output_bytes'])
 def test_request_identity_failure_retained(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);r=accepted_request(root)
   with self.assertRaises(A.ReviewFailure):A.run(r,'0'*64,root/'out')
   f=json.loads((root/'out/failure.json').read_text());self.assertEqual((f['stage'],f['error_code']),('authenticate','REQUEST_CHANGED'))
 def test_all_three_modes_and_common_draw_hashes(self):
  d=A.validate_arrays(fixture())[A.GROUPS[0]];a=A.analyze_group(A.GROUPS[0],d,0,20);b=A.analyze_group(A.GROUPS[0],d,0,20)
  self.assertEqual(a,b);self.assertEqual({r['mode'] for r in a['records']},set(A.MODES));self.assertEqual(len(a['records']),36)
if __name__=='__main__':unittest.main()
