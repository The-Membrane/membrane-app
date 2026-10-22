"""Thin sampling-timeout adapter; unchanged qualified observer owns containment."""
import argparse,hashlib,importlib.util,json,subprocess,time
from pathlib import Path

BASE_SHA='5a78925415b78f34b13cec9f9836c3a1906a1fd08cfb632a120ec5f06b9cb68c'
BASE_NAME='q26-weighted-causal-primary-pair-observer.py'

def _load_base():
 here=Path(__file__).resolve().parent
 candidates=(here/BASE_NAME,here.parent/'weighted-causal-primary-pair'/BASE_NAME)
 for path in candidates:
  if path.is_file():
   raw=path.read_bytes()
   if hashlib.sha256(raw).hexdigest()!=BASE_SHA:raise ValueError('qualified observer source drift')
   spec=importlib.util.spec_from_file_location('q26_qualified_observer',path)
   module=importlib.util.module_from_spec(spec)
   # Execute the bytes already authenticated, without a second source read.
   exec(compile(raw,str(path),'exec'),vars(module));return module
 raise FileNotFoundError('qualified sibling observer unavailable')

O=_load_base()
POLICY=O.POLICY
pin=O.pin

class _Sampler:
 def __init__(self,deadline,sample):self.deadline=deadline;self.sample=sample;self.records=[];self.last_end=None
 def __call__(self,pgid,timeout=None):
  begin=time.monotonic();remaining=self.deadline-begin
  record=dict(sequence=len(self.records),gap_since_previous_end_seconds=None if self.last_end is None else begin-self.last_end,
              remaining_wall_seconds=max(0.,remaining),timeout_seconds=max(0.,min(2.,remaining)),success=False,error_type=None)
  self.records.append(record)
  try:
   if remaining<=0:raise subprocess.TimeoutExpired('/bin/ps',0)
   result=self.sample(pgid,timeout=min(2.,remaining));record['success']=True;return result
  except BaseException as e:
   record['error_type']=type(e).__name__;raise
  finally:
   end=time.monotonic();record['duration_seconds']=end-begin;self.last_end=end

def observe(path,sha,receipt,*,factory=subprocess.Popen,sample=None,kill=O.os.killpg):
 began=time.monotonic();request_pin=pin(path)
 O.need(request_pin['sha256']==sha,'trusted observer request SHA')
 request=O.read(request_pin);wall=request['policy']['wall_seconds']
 O.need(type(wall) in (int,float) and wall>0,'positive request wall')
 dest=O.canonical(receipt);telemetry=Path(str(dest)+'.sampling.json')
 O.need(not telemetry.exists() and not telemetry.is_symlink(),'fresh exclusive sampling addendum')
 sampler=_Sampler(began+wall,O.snapshot if sample is None else sample)
 result=O.observe(path,sha,receipt,factory=factory,sample=sampler,kill=kill)
 # The original terminal is never rewritten; a failed observation remains failed.
 terminal_pin=pin(dest)
 O.exclusive(telemetry,dict(schema='q26-step-error-accounting-sampling-addendum-v1',fixture_only=request.get('fixture_only',False),
   request=request_pin,terminal=terminal_pin,adapter_source=pin(__file__),qualified_observer_source=pin(O.__file__),
   sample_timeout_rule='min(2 seconds, remaining monotonic request wall from adapter entry)',
   retries=0,cached_or_substituted_samples=0,samples=sampler.records,
   sampling_failures=sum(not r['success'] for r in sampler.records),elapsed_seconds=time.monotonic()-began))
 return result

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--request',required=True);p.add_argument('--sha256',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
 try:
  r=observe(a.request,a.sha256,a.receipt);print(json.dumps({k:r[k] for k in ('complete','reason','elapsed_seconds','charged_seconds')}));raise SystemExit(0 if r['complete'] else 1)
 except Exception as e:print(json.dumps(dict(complete=False,error_type=type(e).__name__)));raise SystemExit(1)
