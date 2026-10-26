"""Prepare signed v2 requests only after published O78 approval. Does not execute models."""
import argparse,datetime,hashlib,importlib.util,json,re,subprocess
from pathlib import Path
R=Path(__file__).resolve().parent
E=R.parent
V1=E/'r17-event-pilot-v1'
BOARD=Path('/Users/EBmic/membrane-board')
def pin(path):
 path=Path(path).resolve();h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return {'path':str(path),'size':path.stat().st_size,'sha256':h.hexdigest()}
def check(expected):
 if pin(expected['path'])!=expected:raise ValueError('admitted file identity changed: '+expected['path'])
def verify_board(commit):
 if not re.fullmatch('[0-9a-f]{40}',commit):raise ValueError('published O78 full commit required; placeholder refused')
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=BOARD,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=BOARD,text=True).split()[0]
 message=subprocess.check_output(['git','show','-s','--format=%s',commit],cwd=BOARD,text=True).strip()
 if head!=commit or remote!=commit or not re.search(r'\bO78\b',message):raise ValueError('O78 must be the verified current published Board commit')
def serialized(value):return (json.dumps(value,indent=2,sort_keys=True,allow_nan=False)+'\n').encode()
def write_new(path,content):
 with open(path,'xb') as f:f.write(content)
def prepare(commit):
 verify_board(commit)
 draft=json.loads((R/'resume-request.DRAFT.json').read_text())
 if not draft['status'].startswith('DRAFT'):raise ValueError('expected refusing draft')
 for name,expected in draft['files'].items():
  actual=pin(R/name)
  if actual['size']!=expected['size'] or actual['sha256']!=expected['sha256']:raise ValueError('draft source changed: '+name)
 if pin(R/'train_models.py')['sha256']!=draft['trainer_sha256']:raise ValueError('draft trainer hash')
 child=R/'model-request.v2.json';launchpath=R/'train-launch.v2.json';out=R/'model-results-v2'
 fresh=[child,launchpath,out,R/'train-v2.start.json',R/'train-v2.monitor.json',R/'train-v2.stdout.log',R/'train-v2.stderr.log']
 if any(p.exists() for p in fresh):raise ValueError('all v2 execution paths must remain fresh')
 draft.update(status='READY_PARENT_ADMITTED',execution_amendment_board_commit=commit,parent_admitted_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),output_directory=str(out))
 spec=importlib.util.spec_from_file_location('r17_resume_admission',R/'train_models.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.validate_resume(draft,draft['input_directory']) # Metadata/byte identity only, no arrays or fits.
 original_launch=json.loads(Path(draft['resume']['original_launch_request']['path']).read_text())
 allpins=list(original_launch['pins'])
 for expected in allpins:check(expected)
 # Original launch pins retain the previously qualified scientific/native/runtime closure.
 runtime_path=E/'r17-runtime-qualification-v1/receipt.json';runtime=json.loads(runtime_path.read_text())
 if runtime['complete'] is not True:raise ValueError('runtime qualification incomplete')
 venv=Path(draft['runtime'])
 for rel,expected in runtime['new_xgboost_package_files'].items():check({'path':str((venv/rel).resolve()),'size':expected['size'],'sha256':expected['sha256']})
 for key in ['pth','xgboost_native_library','inherited_native_library']:
  expected=runtime[key];actual=pin(expected['path'])
  if actual['sha256']!=expected['sha256'] or ('size' in expected and actual['size']!=expected['size']):raise ValueError('qualified native/dependency pin changed: '+key)
 for expected in runtime['inherited_dependency_pins'].values():
  if pin(expected['init_path'])['sha256']!=expected['init_sha256']:raise ValueError('qualified inherited dependency changed')
 for name in ['monitor.py','test_monitor.py','train_models.py','test_train_models.py','test_resume.py','prepare_launch.py','CONTINUATION_DESIGN.md','source-review-manifest.json','resume-request.DRAFT.json','immutable-v1-pins.json']:allpins.append(pin(R/name))
 allpins.append(pin(runtime_path))
 for name in ['original_trainer','original_model_request','original_launch_request','original_monitor_receipt','parent_prefix_audit','prefix_progress']:allpins.append(draft['resume'][name])
 allpins.extend(draft['resume']['prefix_predictions'].values())
 for expected in allpins:check(expected)
 childbytes=serialized(draft);allpins.append({'path':str(child),'size':len(childbytes),'sha256':hashlib.sha256(childbytes).hexdigest()})
 unique={}
 for expected in allpins:
  if expected['path'] in unique and unique[expected['path']]!=expected:raise ValueError('conflicting pin')
  unique[expected['path']]=expected
 launch={'schema':'codex-r17-execution-request-v1','status':'READY_PARENT_REVIEWED','phase':'train','policy':{'rss_bytes':1000000000,'disk_reserve_bytes':2000000000,'wall_seconds':1078,'output_bytes':500000000},'time_accounting':draft['resume']['time_accounting'],'argv':[str(venv/'bin/python'),str(R/'train_models.py'),'--admitted-request',str(child),'--inputs-dir',draft['input_directory'],'--output-dir',str(out)],'pins':list(unique.values()),'output':str(out),'expected_results':['result.json','progress.json','prefix-progress.v1.json','prefix-monitor.v1.json','prefix-parent-audit.v1.json','prefix-model-request.v1.json']+[f'predictions-{h}.npz' for h in [6,12,24,72,168]],'start_receipt':str(R/'train-v2.start.json'),'receipt':str(R/'train-v2.monitor.json'),'stdout_log':str(R/'train-v2.stdout.log'),'stderr_log':str(R/'train-v2.stderr.log'),'dyld_library_path':runtime['child_environment_overrides']['DYLD_LIBRARY_PATH'],'scientific_protocol_board_commit':draft['scientific_protocol_board_commit'],'execution_amendment_board_commit':commit}
 # Preparation is the only mutation: no subprocess invokes a trainer or monitor.
 write_new(child,childbytes);write_new(launchpath,serialized(launch))
 return {'child_request':pin(child),'launch_request':pin(launchpath),'pin_count':len(unique),'output':str(out),'executed':False}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--o78-board-commit',required=True);a=ap.parse_args();print(json.dumps(prepare(a.o78_board_commit),sort_keys=True))
if __name__=='__main__':main()
