import ast,copy,json,shutil,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import train_models as M
BASE=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-event-pilot-v1/train_models.py')
SECOND=BASE.parent.parent/'r17-operational-continuation-v2/train_models.py'
def put(path,value):path.write_text(json.dumps(value));return M.metadata_pin(path)
def launch(model,modelpin,trainerpin,inputs):
 return {'policy':{'wall_seconds':model['max_full_seconds']},'pins':[trainerpin,modelpin,*[M.metadata_pin(inputs/f'horizon-{h}.npz') for h in M.HORIZONS]],'argv':[sys.executable,trainerpin['path'],'--admitted-request',modelpin['path'],'--inputs-dir',str(inputs),'--output-dir',model['output_directory']]}
def fixture(root):
 inputs=root/'inputs';inputs.mkdir();prior=root/'prior';prior.mkdir();second_out=root/'second';second_out.mkdir()
 for h in M.HORIZONS:np.savez(inputs/f'horizon-{h}.npz',synthetic=np.array([h]))
 for h in M.PREFIX_HORIZONS:(prior/f'predictions-{h}.npz').write_bytes(b'synthetic-unparsed-prefix-'+str(h).encode())
 basepin=M.metadata_pin(BASE);secondsource=M.metadata_pin(SECOND)
 original={'status':'READY_PARENT_ADMITTED','trainer_sha256':M.BASE_TRAINER_SHA256,'max_full_seconds':1200,'input_directory':str(inputs),'output_directory':str(prior),'input_sha256':{str(h):M.sha(inputs/f'horizon-{h}.npz') for h in M.HORIZONS},'scientific_constant':{'ridge':.01,'rounds':128}}
 op=put(root/'original-model.json',original);lp=put(root/'original-launch.json',launch(original,op,basepin,inputs))
 rp=put(root/'original-monitor.json',{'request':lp,'complete':False,'elapsed_seconds':121.7220577,'changed_pin_paths':[],'containment':{'no_live_members_remaining':True}})
 pp={str(h):M.metadata_pin(prior/f'predictions-{h}.npz') for h in M.PREFIX_HORIZONS}
 progress={'complete':False,'completed_horizons':[6,12],'scope':'synthetic only','horizons':[{'horizon_hours':h,'folds':[{}]*8,'scores':[{'synthetic_marker':h}],'missing_label_sensitivity':[],'local_predictions_sha256':pp[str(h)]['sha256']} for h in M.PREFIX_HORIZONS]};pr=put(prior/'progress.json',progress);audit=put(root/'audit.json',{'accepted':True,'monitor':rp,'result':pr})
 resume={'original_trainer':basepin,'original_model_request':op,'original_launch_request':lp,'original_monitor_receipt':rp,'parent_prefix_audit':audit,'prefix_progress':pr,'prefix_predictions':pp,'time_accounting':{'original_budget_seconds':1200,'prior_attempt_charged_seconds':122,'remaining_seconds':1078}}
 second={**original,'trainer_sha256':M.BASE_V2_TRAINER_SHA256,'max_full_seconds':1078,'output_directory':str(second_out),'resume':resume};sp=put(root/'second-model.json',second);sl=put(root/'second-launch.json',launch(second,sp,secondsource,inputs));sr=put(root/'second-monitor.json',{'request':sl,'complete':False,'elapsed_seconds':2.712388625,'changed_pin_paths':[],'containment':{'no_live_members_remaining':True}})
 shutil.copyfile(pr['path'],second_out/'prefix-progress.v1.json');second_prefix=M.metadata_pin(second_out/'prefix-progress.v1.json');second_progress=put(second_out/'progress.json',{**progress,'continuation':{'independent_repeat':False}})
 for h in M.PREFIX_HORIZONS:shutil.copyfile(pp[str(h)]['path'],second_out/f'predictions-{h}.npz')
 req={**original,'max_full_seconds':1075,'trainer_sha256':M.sha(M.__file__),'output_directory':str(root/'new-output'),'resume':{**resume,'time_accounting':{'original_budget_seconds':1200,'prior_attempt_charged_seconds':125,'remaining_seconds':1075},'second_trainer':secondsource,'second_model_request':sp,'second_launch_request':sl,'second_monitor_receipt':sr,'second_progress':second_progress,'second_prefix_progress':second_prefix,'second_prefix_predictions':{str(h):M.metadata_pin(second_out/f'predictions-{h}.npz') for h in [6,12]}}}
 return req,inputs,progress
class ResumeTests(unittest.TestCase):
 def test_validate_exact_two_attempt_chain(self):
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
 def test_second_receipt_wrong_launch_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);q,i,_=fixture(root);r=json.loads(Path(q['resume']['second_monitor_receipt']['path']).read_text());r['request']=q['resume']['original_launch_request'];q['resume']['second_monitor_receipt']=put(root/'wrong-second-monitor.json',r)
   with self.assertRaisesRegex(ValueError,'second monitor identity'):M.validate_resume(q,i)
 def test_second_new_horizon_or_wrong_prefix_rejected(self):
  for kind in ['new_horizon','prefix_bytes','new_prediction']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as t:
    root=Path(t);q,i,_=fixture(root);out=root/'second'
    if kind=='new_horizon':
     p=json.loads((out/'progress.json').read_text());p['completed_horizons'].append(24);q['resume']['second_progress']=put(out/'progress.json',p)
    elif kind=='prefix_bytes':
     (out/'prefix-progress.v1.json').write_bytes(b'wrong');q['resume']['second_prefix_progress']=M.metadata_pin(out/'prefix-progress.v1.json')
    else:(out/'predictions-24.npz').write_bytes(b'new partial prediction')
    with self.assertRaises(ValueError):M.validate_resume(q,i)
 def test_copies_prefix_only_runs_remaining(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);q,i,expected=fixture(root);called=[]
   def toy(d,h,out,full_deadline):
    called.append(h);self.assertLessEqual(full_deadline-time.monotonic(),1075);out.write_bytes(b'toy output');return {'horizon_hours':h,'scores':[{'synthetic_marker':h}]}
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
