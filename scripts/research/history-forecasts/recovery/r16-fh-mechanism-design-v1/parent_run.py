#!/usr/bin/env python3
"""Parent-owned invocation timer; no scientific metrics are consulted."""
import argparse, hashlib, json, os, pathlib, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--stage',type=int,choices=(8,64),required=True);p.add_argument('--script-sha',required=True);p.add_argument('--spec-sha',required=True);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parent
script=root/'mechanism.py';spec=root/'spec.json'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
expected={script:a.script_sha,spec:a.spec_sha}
assert all(sha(k)==v for k,v in expected.items()), 'Prelaunch frozen identity mismatch'
receipt=root/f'parent-stage-{a.stage}-receipt.json'
assert not receipt.exists(), 'Never overwrite an earlier invocation receipt'
env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
cmd=['/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python',str(script),'--stage',str(a.stage),'--approved-spec-sha256',a.spec_sha]
start=time.monotonic();code=None;timeout=False
try:
 r=subprocess.run(cmd,cwd=root,env=env,capture_output=True,timeout=125);code=r.returncode;stdout,stderr=r.stdout,r.stderr
except subprocess.TimeoutExpired as e:
 timeout=True;stdout,stderr=e.stdout or b'',e.stderr or b''
elapsed=time.monotonic()-start
(root/f'parent-stage-{a.stage}-stdout.txt').write_bytes(stdout);(root/f'parent-stage-{a.stage}-stderr.txt').write_bytes(stderr)
post={str(k):sha(k) for k in expected}
r=dict(stage=a.stage,returncode=code,timed_out=timeout,outer_elapsed_seconds=elapsed,expected_hashes={str(k):v for k,v in expected.items()},post_hashes=post,launcher_sha256=sha(pathlib.Path(__file__).resolve()),command=cmd,timing_scope='Before child spawn through termination including imports and final writes; excludes parent receipt writes.')
receipt.write_text(json.dumps(r,indent=2)+'\n');print(receipt)
assert code==0 and not timeout and all(post[str(k)]==v for k,v in expected.items()), 'Invocation incomplete or identity changed'
