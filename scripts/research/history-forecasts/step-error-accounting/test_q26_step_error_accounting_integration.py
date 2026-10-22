"""Synthetic transport only: real runner/observer/guard, fixture runtime context.

No historical archive or private request is loaded. Negative envelopes are
explicit synthetic mutations; only their rejection is evidence.
"""
import copy,gzip,hashlib,importlib.util,json,os,sys,tempfile,unittest
from pathlib import Path

BASE=Path(__file__).resolve().parent
RUNNER=BASE/'q26-step-error-accounting-run.py'
OBSERVER=BASE/'q26-step-error-accounting-observer.py'
ANALYSIS=BASE/'q26-step-error-accounting.py'
CHECKER=BASE/'q26-step-error-accounting-check.py'
FIXTURES=BASE/'test_q26_step_error_accounting.py'
GUARD=Path(os.environ['Q26_ACCOUNTING_GUARD']).resolve()
THREADS=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')

def load(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def pin(path):
 p=Path(path).resolve();b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())

def save(path,value):
 b=(json.dumps(value,allow_nan=False)+'\n').encode()
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(b)
 return pin(path)

STUB='''"""FIXTURE ONLY: not an accepted historical runtime authority."""
import hashlib,json,os,sys,types
from pathlib import Path
FIXTURE_ONLY=True

def saved_context(r):
 if r.get('schema')!='q26-step-error-fixture-runtime-v1' or r.get('fixture_only') is not True or r.get('synthetic_only') is not True:
  raise ValueError('synthetic fixture runtime only')
 return {'pins':{'read_guard':r['guard']}},[r['pins']['implementation'],r['guard']],[]

def module(q,name):
 p=Path(q['path']);b=p.read_bytes()
 if len(b)!=q['size'] or hashlib.sha256(b).hexdigest()!=q['sha256']:raise ValueError('fixture source drift')
 m=types.ModuleType(name);m.__file__=q['path'];sys.modules[name]=m;exec(compile(b,q['path'],'exec'),vars(m));return m

def atomic(path,value):
 b=(json.dumps(value,allow_nan=False,separators=(',',':'))+'\\n').encode()
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 if path.read_bytes()!=b or path.stat().st_mode&0o777!=0o600:raise ValueError('fixture receipt readback')
'''

class Integration(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.root=Path(tempfile.mkdtemp(prefix='q26-step-accounting-synthetic-',dir=tempfile.gettempdir())).resolve()
  cls.O=load(OBSERVER,'step_fixture_observer');cls.R=load(RUNNER,'step_fixture_runner')
  fixture=load(FIXTURES,'step_fixture_builder').fixture
  I,S=fixture()
  cls.stub=cls.root/'fixture_context.py';cls.stub.write_text(STUB);cls.stub.chmod(0o600)
  context=cls.root/'fixture_runtime.json'
  cp=save(context,dict(schema='q26-step-error-fixture-runtime-v1',fixture_only=True,synthetic_only=True,threads=THREADS,pins=dict(implementation=pin(cls.stub)),guard=pin(GUARD)))
  files={};archives={}
  for name,value in [('intraday-real.json.gz',I),('step-real.json.gz',S)]:
   raw=json.dumps(value,allow_nan=False,separators=(',',':')).encode();z=gzip.compress(raw,mtime=0);p=cls.root/name;p.write_bytes(z);p.chmod(0o600)
   files[name]=dict(bytes=len(z),sha256=hashlib.sha256(z).hexdigest(),uncompressed_sha256=hashlib.sha256(raw).hexdigest());archives[name]=pin(p)
  mp=save(cls.root/'manifest.json',dict(fixture_only=True,synthetic_only=True,files=files))
  cls.base=dict(schema='q26-weighted-causal-primary-pair-saved-request-v1',parent_admitted=True,saved_only=True,fixture_only=True,purpose='fixed_O12_prediction_error_accounting',policy=cls.R.POLICY,invocation_python=sys.executable,resolved_python=str(Path(sys.executable).resolve()),threads=THREADS,
   pins=dict(implementation=pin(RUNNER),analysis=pin(ANALYSIS),accepted_runtime_consumer=pin(cls.stub),accepted_runtime_request=cp,published_manifest=mp,intraday_archive=archives['intraday-real.json.gz'],step_archive=archives['step-real.json.gz']))
  cls.production,cls.prod_request,cls.prod_observer,cls.prod_terminal=cls.execute('produce',copy.deepcopy(cls.base))
  if not cls.prod_terminal['complete']:raise AssertionError('Synthetic producer failed: '+str(cls.prod_terminal)+' stderr='+Path(str(cls.root/'produce-terminal.json')+'.stderr.log').read_text())
  cls.produced=json.loads(Path(cls.production['out']).read_text())

 @classmethod
 def execute(cls,name,request):
  request['mode']='produce' if name=='produce' else 'check';request['out']=str(cls.root/(name+'-output.json'))
  ip=save(cls.root/(name+'-request.json'),request)
  outer=dict(schema='q26-weighted-causal-primary-pair-observer-request-v1',fixture_only=True,kind='saved_check',inner_request=ip,runner=pin(RUNNER),source_pins=[pin(RUNNER)],argv=[sys.executable,'-B',str(RUNNER),'--request',ip['path'],'--sha256',ip['sha256'],'--out',request['out']],output=request['out'],policy=dict(cls.O.POLICY,wall_seconds=2))
  op=save(cls.root/(name+'-observer.json'),outer);terminal=cls.O.observe(op['path'],op['sha256'],cls.root/(name+'-terminal.json'))
  return request,ip,op,terminal

 @classmethod
 def checker_request(cls):
  r=copy.deepcopy(cls.base);r['pins'].update(analysis=pin(CHECKER),produced_output=pin(cls.production['out']),production_request=cls.prod_request,production_terminal=pin(cls.root/'produce-terminal.json'),production_observer_request=cls.prod_observer);return r

 def test_full_synthetic_produce_observe_independent_check(self):
  r,_,_,t=self.execute('positive-check',self.checker_request())
  self.assertTrue(t['complete'],t);self.assertEqual(t['tool_terminal_exit'],0)
  got=json.loads(Path(r['out']).read_text());self.assertTrue(got['accepted']);self.assertIs(got['fixture_only'],True);self.assertEqual(got['mode'],'check')
  self.assertEqual(got['new_fits'],0);self.assertEqual(got['new_forecasts'],0);self.assertFalse(got['raw_bars_read'])

 def negative(self,name,mutation,expected):
  # Rebind all envelope identities so refusal reaches the intended semantic gate.
  prod=copy.deepcopy(self.production);mutation(prod);prod['out']=str(self.root/(name+'-forged-output.json'))
  pp=save(self.root/(name+'-forged-request.json'),prod)
  result=copy.deepcopy(self.produced);result['request']=pp;op=save(Path(prod['out']),result)
  outer=json.loads(Path(self.prod_observer['path']).read_text());outer['inner_request']=pp;outer['output']=prod['out']
  outerp=save(self.root/(name+'-forged-observer.json'),outer)
  terminal=copy.deepcopy(self.prod_terminal);terminal['request']=outerp
  tp=save(self.root/(name+'-forged-terminal.json'),terminal)
  r=self.checker_request();r['pins'].update(produced_output=op,production_request=pp,production_observer_request=outerp,production_terminal=tp)
  request,_,_,t=self.execute(name,r);self.assertFalse(t['complete']);self.assertNotEqual(t['tool_terminal_exit'],0);self.assertFalse(Path(request['out']).exists())
  self.assertIn(expected,Path(str(self.root/(name+'-terminal.json'))+'.stderr.log').read_text())

 def test_swapped_production_purpose_rejected(self):
  self.negative('bad-purpose',lambda p:p.update(purpose='another_scientific_job'),'production scope binding')

 def test_swapped_production_input_rejected(self):
  self.negative('bad-input',lambda p:p['pins'].update(intraday_archive=p['pins']['step_archive']),'production input identity')

 def test_failed_production_terminal_rejected(self):
  r=self.checker_request();terminal=copy.deepcopy(self.prod_terminal);terminal.update(complete=False,tool_terminal_exit=1)
  r['pins']['production_terminal']=save(self.root/'failed-terminal.json',terminal)
  request,_,_,t=self.execute('failed-terminal',r);self.assertFalse(t['complete']);self.assertFalse(Path(request['out']).exists())
  self.assertIn('terminal production required',Path(str(self.root/'failed-terminal-terminal.json')+'.stderr.log').read_text())

 def test_fixture_context_refuses_actual_shaped_request(self):
  context=load(self.stub,'stub_refusal_test')
  with self.assertRaisesRegex(ValueError,'synthetic fixture runtime only'):
   context.saved_context(dict(schema='q26-weighted-causal-primary-pair-saved-request-v1',parent_admitted=True,saved_only=True,pins={}))

if __name__=='__main__':unittest.main()
