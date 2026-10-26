import ast,copy,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import train_models as M
BASE=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-event-pilot-v1/train_models.py')
def put(path,value):path.write_text(json.dumps(value));return M.metadata_pin(path)
def fixture(root):
 inputs=root/'inputs';inputs.mkdir();pred=root/'prior';pred.mkdir()
 for h in M.HORIZONS:np.savez(inputs/f'horizon-{h}.npz',synthetic=np.array([h]))
 for h in M.PREFIX_HORIZONS:(pred/f'predictions-{h}.npz').write_bytes(b'synthetic-unparsed-prefix-'+str(h).encode())
 basepin=M.metadata_pin(BASE)
 original={'status':'READY_PARENT_ADMITTED','trainer_sha256':M.BASE_TRAINER_SHA256,'max_full_seconds':1200,'input_directory':str(inputs),'input_sha256':{str(h):M.sha(inputs/f'horizon-{h}.npz') for h in M.HORIZONS},'scientific_constant':{'ridge':.01,'rounds':128}}
 op=put(root/'original-model.json',original)
 launch={'policy':{'wall_seconds':1200},'pins':[basepin,op,*[M.metadata_pin(inputs/f'horizon-{h}.npz') for h in M.HORIZONS]]};lp=put(root/'original-launch.json',launch)
 receipt={'request':lp,'complete':False,'elapsed_seconds':121.7220577,'changed_pin_paths':[],'containment':{'no_live_members_remaining':True}};rp=put(root/'original-monitor.json',receipt)
 pp={str(h):M.metadata_pin(pred/f'predictions-{h}.npz') for h in M.PREFIX_HORIZONS}
 progress={'complete':False,'completed_horizons':[6,12],'scope':'synthetic only','horizons':[{'horizon_hours':h,'folds':[{}]*8,'scores':[{'synthetic_marker':h}],'missing_label_sensitivity':[],'local_predictions_sha256':pp[str(h)]['sha256']} for h in M.PREFIX_HORIZONS]};pr=put(root/'progress.json',progress);audit=put(root/'audit.json',{'accepted':True,'monitor':rp,'result':pr})
 req={**original,'max_full_seconds':1078,'trainer_sha256':M.sha(M.__file__),'output_directory':str(root/'new-output'),'resume':{'time_accounting':{'original_budget_seconds':1200,'prior_attempt_charged_seconds':122,'remaining_seconds':1078},'original_trainer':basepin,'original_model_request':op,'original_launch_request':lp,'original_monitor_receipt':rp,'parent_prefix_audit':audit,'prefix_progress':pr,'prefix_predictions':pp}}
 return req,inputs,progress
class ResumeTests(unittest.TestCase):
 def test_validate_exact_structural_chain(self):
  with tempfile.TemporaryDirectory() as t:
   q,i,expected=fixture(Path(t));self.assertEqual(M.validate_resume(q,i),expected)
 def test_wrong_accepted_audit_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);q,i,_=fixture(root)
   for key in ['monitor','result']:
    with self.subTest(key=key):
     audit={'accepted':True,'monitor':q['resume']['original_monitor_receipt'],'result':q['resume']['prefix_progress']};audit[key]={'path':'wrong','size':0,'sha256':'0'*64};altered=copy.deepcopy(q);altered['resume']['parent_prefix_audit']=put(root/'wrong-audit.json',audit)
     with self.assertRaisesRegex(ValueError,'audit identity mismatch'):M.validate_resume(altered,i)
 def test_mutated_input_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   q,i,_=fixture(Path(t));(i/'horizon-6.npz').write_bytes(b'tamper')
   with self.assertRaises(ValueError):M.validate_resume(q,i)
 def test_scientific_or_time_change_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   q,i,_=fixture(Path(t))
   for kind in ['science','budget']:
    altered=copy.deepcopy(q)
    if kind=='science':altered['scientific_constant']['rounds']=129
    else:altered['resume']['time_accounting']['remaining_seconds']=1200
    with self.assertRaises(ValueError):M.validate_resume(altered,i)
 def test_copies_prefix_only_runs_remaining(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);q,i,expected=fixture(root);called=[]
   def toy(d,h,out,full_deadline):
    called.append(h);self.assertLessEqual(full_deadline-time.monotonic(),1078);out.write_bytes(b'toy output');return {'horizon_hours':h,'scores':[{'synthetic_marker':h}]}
   with patch.object(M,'run_horizon',side_effect=toy),patch.object(M,'cross_horizon',return_value=[]):result=M.run_resume_admitted(q,i,root/'new-output')
   self.assertEqual(called,[24,72,168]);self.assertEqual(result['horizons'][:2],expected['horizons']);self.assertFalse(result['continuation']['independent_repeat']);self.assertTrue(result['complete']);self.assertLess(result['original_budget_charged_seconds'],1200)
   for h in [6,12]:self.assertEqual((root/'new-output'/f'predictions-{h}.npz').read_bytes(),Path(q['resume']['prefix_predictions'][str(h)]['path']).read_bytes())
   self.assertEqual((root/'new-output/prefix-progress.v1.json').read_bytes(),Path(q['resume']['prefix_progress']['path']).read_bytes())
 def test_new_failure_preserves_prefix(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);q,i,_=fixture(root)
   with patch.object(M,'run_horizon',side_effect=RuntimeError('synthetic failure')):
    with self.assertRaises(RuntimeError):M.run_resume_admitted(q,i,root/'new-output')
   failure=json.loads((root/'new-output/failure.json').read_text());self.assertEqual(failure['completed_horizons'],[6,12]);self.assertTrue((root/'new-output/predictions-6.npz').exists())
 def test_all_original_numerical_functions_unchanged(self):
  old={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(BASE.read_text()).body if isinstance(n,ast.FunctionDef)};new={n.name:ast.dump(n,include_attributes=False) for n in ast.parse(Path(M.__file__).read_text()).body if isinstance(n,ast.FunctionDef)}
  for name,value in old.items():
   if name!='main':self.assertEqual(new[name],value,name)
if __name__=='__main__':unittest.main()
