#!/usr/bin/env python3
"""Parent invocation timer. Scientific admission and cut freezing remain explicit."""
import argparse,hashlib,json,os,pathlib,subprocess,time
p=argparse.ArgumentParser();p.add_argument('phase',choices=['analyze']);p.add_argument('--request',type=pathlib.Path,required=True);p.add_argument('--request-sha',required=True);p.add_argument('--script-sha',required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--cuts',type=pathlib.Path);p.add_argument('--cuts-sha');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parent;script=root/'conditional_depth_v2.py';req=a.request.resolve();out=a.out.resolve()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
expected={script:a.script_sha,req:a.request_sha}
if a.phase=='analyze':
 assert a.cuts and a.cuts_sha, 'Analyze requires parent-frozen cuts'
 expected[a.cuts.resolve()]=a.cuts_sha
else:assert a.cuts is None and a.cuts_sha is None
assert out.parent==root and not out.exists(), 'Fresh direct-child output required'
assert all(sha(k)==v for k,v in expected.items()), 'Prelaunch pin mismatch'
receipt=root/f'{out.name}.outer-receipt.json';assert not receipt.exists()
cmd=['/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python',str(script),a.phase,'--request',str(req),'--sha256',a.request_sha,'--out',str(out)]
if a.phase=='analyze':cmd+=['--cuts',str(a.cuts.resolve()),'--cuts-sha256',a.cuts_sha]
env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
start=time.monotonic();code=None;timed_out=False
try:
 child=subprocess.run(cmd,cwd=root,env=env,capture_output=True,timeout=116);code=child.returncode;stdout,stderr=child.stdout,child.stderr
except subprocess.TimeoutExpired as e:
 timed_out=True;stdout,stderr=e.stdout or b'',e.stderr or b''
elapsed=time.monotonic()-start
(root/f'{out.name}.stdout.txt').write_bytes(stdout);(root/f'{out.name}.stderr.txt').write_bytes(stderr)
post={str(k):sha(k) for k in expected};r={'phase':a.phase,'returncode':code,'timed_out':timed_out,'outer_elapsed_seconds':elapsed,'expected_pins':{str(k):v for k,v in expected.items()},'post_pins':post,'launcher_sha256':sha(pathlib.Path(__file__).resolve()),'command':cmd,'timing_scope':'Before child spawn through termination, including imports/final child writes; excludes parent receipt writes.'};receipt.write_text(json.dumps(r,indent=2)+'\n');print(receipt)
assert code==0 and not timed_out and all(post[str(k)]==v for k,v in expected.items()), 'Invocation incomplete or pins changed'
