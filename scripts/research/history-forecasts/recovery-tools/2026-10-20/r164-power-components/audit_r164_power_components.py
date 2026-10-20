"""Known-law validation of unchanged R16.4 power summary components, no market inputs."""
from __future__ import annotations
import argparse,hashlib,importlib.metadata,importlib.util,itertools,json,math,os,platform,resource,shutil,sys,time,types
from pathlib import Path
import numpy as np
import scipy
from scipy.integrate import quad
from scipy.special import ndtr,betaincinv
E=Path(__file__).resolve().parent
ORIGINAL=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts/r164_power.py')
SCHEMA='codex-r164-known-law-components-v1'
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=180,output_bytes=2000000)
N=200000;SEED=20261020;Z=1.6449;NOMINAL=.90;TOL=.05
GRID=dict(coverage_means=[.84,.85,.90,.95,.96],coverage_SEs=[.01,.02],empty_control=[.90,.04],width_medians=[8.,10.,12.],correlations=[-.8,0.,.8],log_width_SD=.20)
LIMITS=('KNOWN-LAW mathematical component validation, not original empirical R16.4 variance decomposition, forecast skill, market power or reserve evidence. C_hat is an unbounded Gaussian summary proxy, not literal finite Bernoulli coverage. Width_hat is a lognormal summary proxy. Null/alternative labels refer only to coverage-equivalence mean, not a separately registered width hypothesis. Pointwise independent-world binomial intervals and discrepancy diagnostics are not simultaneous across cases; no cross-case independence is assumed. Actual original code is preserved: header width-bootstrap/90th-percentile and CGM branches are absent. No model, gate, score, market input, labels, predictions or reserve changes.')
def require(ok,message):
 if not ok:raise ValueError(message)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def pin(p):
 p=Path(p).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))
def check_pin(p):
 f=Path(p['path']);require(f.is_file() and f.stat().st_size==p['size'] and sha(f)==p['sha256'],'artifact pin changed')
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform(),machine=platform.machine(),numpy=np.__version__,scipy=scipy.__version__)
def load_original(path=ORIGINAL):
 m=types.ModuleType('unchanged_r164_power');m.__file__=str(path);exec(compile(Path(path).read_bytes(),str(path),'exec'),m.__dict__);return m
def grid():
 cs=[(c,s) for c in GRID['coverage_means'] for s in GRID['coverage_SEs']]+[tuple(GRID['empty_control'])]
 return [dict(case_id=i,coverage_mean=c,known_SE=s,width_median=w,rho=r) for i,(c,s,w,r) in enumerate((c,s,w,r) for c,s in cs for w in GRID['width_medians'] for r in GRID['correlations'])]
def law(c,s,w,rho):
 require(s>0 and w>0 and abs(rho)<1,'positive scale/width and strict correlation required')
 lo=(NOMINAL-TOL+Z*s-c)/s;hi=(NOMINAL+TOL-Z*s-c)/s;t=math.log(10/w)/.20;q=math.sqrt(1-rho*rho)
 width=float(ndtr(t));coverage=max(0.,float(ndtr(hi)-ndtr(lo))) if hi>lo else 0.
 normal=lambda x:math.exp(-x*x/2)/math.sqrt(2*math.pi)
 if hi<=lo:j1=j2=0.;errors=[0.,0.]
 else:
  j1,e1=quad(lambda x:normal(x)*ndtr((t-rho*x)/q),lo,hi,epsabs=1e-12,epsrel=1e-12,limit=200)
  j2,e2=quad(lambda y:normal(y)*(ndtr((hi-rho*y)/q)-ndtr((lo-rho*y)/q)),-np.inf,t,epsabs=1e-12,epsrel=1e-12,limit=200);errors=[e1,e2]
 require(abs(j1-j2)<=1e-9,'independent quadrature disagreement')
 require(rho!=0 or abs(j1-coverage*width)<=1e-9,'rho-zero product identity')
 return dict(coverage=coverage,width=width,joint=float(j1),joint_reverse=float(j2),quadrature_absolute_difference=abs(j1-j2),quadrature_error_estimates=errors,coverage_Z_interval=[lo,hi],width_Z_limit=t,corrected_marginal_product=coverage*width)
def binomial(k,n,p):
 require(0<=k<=n and n>0 and 0<=p<=1,'invalid binomial inputs');rate=k/n;se=math.sqrt(p*(1-p)/n);emp=math.sqrt(rate*(1-rate)/n)
 lower=0. if k==0 else float(betaincinv(k,n-k+1,.025));upper=1. if k==n else float(betaincinv(k+1,n-k,.975));bound=6*se+1/n
 return dict(successes=int(k),worlds=n,rate=rate,reference_MCSE=se,estimated_MCSE=emp,pointwise_binomial_CI95=[lower,upper],discrepancy=rate-p,predeclared_discrepancy_bound=bound,within_discrepancy_bound=abs(rate-p)<=bound)
def original_b(original,case,work):
 c=case['coverage_mean'];s=case['known_SE'];w=case['width_median'];require(w>0,'positive width required');bounds=[c-3.29*s/2,c+3.29*s/2];require(0<=bounds[0]<=bounds[1]<=1,'CI descriptor outside0..1')
 path=work/f"part-b-{case['case_id']:03d}.json";path.write_text(json.dumps({'cells':[dict(T='T',tier='shallow',level=-2,constructions={'known':dict(coverage_groups=c,coverage_ci90=bounds,width_median_pts=w)})]}))
 return original.part_b(str(path),[('T','shallow',-2,'known')],NOMINAL,TOL,10.,1.)[0]
def coverage_class(c):
 require(c in GRID['coverage_means'],'declared coverage mean required')
 return ('alternative','interior') if c==.90 else ('null','boundary' if c in (.85,.95) else 'outside')
def evaluate_case(original,case,work,n=N):
 c=case['coverage_mean'];s=case['known_SE'];w=case['width_median'];r=case['rho'];refs=law(c,s,w,r);old=original_b(original,case,work)
 require(abs(old['tost_power']-refs['coverage'])<=1e-9,'original TOST differs from Gaussian mass');require(old['width_leg']==float(w<=10),'original deterministic width leg differs')
 rng=np.random.default_rng(np.random.SeedSequence([SEED,case['case_id']]));x=rng.standard_normal(n);y=rng.standard_normal(n);chat=c+s*x;what=w*np.exp(.20*(r*x+math.sqrt(1-r*r)*y))
 okc=(chat-Z*s>NOMINAL-TOL)&(chat+Z*s<NOMINAL+TOL);okw=what<=10;require(np.isfinite(what).all() and (what>0).all(),'nonpositive width')
 events={name:binomial(int(event.sum()),n,refs[name]) for name,event in [('coverage',okc),('width',okw),('joint',okc&okw)]};truth,position=coverage_class(c)
 return dict(**case,coverage_truth=truth,coverage_position=position,coverage_truth_definition='mean at/beyond0.85/0.95 is equivalence null; interval interior is alternative',classification_applies_to='coverage-equivalence parameter only',width_population_median_at_or_below10=w<=10,analytic=refs,monte_carlo=events,null_acceptance={k:v['rate'] for k,v in events.items()} if truth=='null' else None,alternative_acceptance_or_power={k:v['rate'] for k,v in events.items()} if truth=='alternative' else None,original_part_b=old,original_joint_minus_analytic_joint=old['joint']-refs['joint'],corrected_marginal_product_minus_joint=refs['corrected_marginal_product']-refs['joint'])
def part_a_exact(original,work):
 a=np.array([-.03,-.01,.01,.03]);b=np.array([-.002,0,.002]);am=np.array([np.mean(a[list(ix)]) for ix in itertools.product(range(4),repeat=4)]);bm=np.array([np.mean(b[list(ix)]) for ix in itertools.product(range(3),repeat=3)]);allmeans=-.01+am[:,None]+bm[None,:];require(allmeans.size==6912,'exact enumeration size')
 variances=dict(combined=float(np.var(allmeans)),series_fixed_time_only=float(np.var(-.01+bm)),time_fixed_series_only=float(np.var(-.01+am)));analytic=float(np.var(a)/4+np.var(b)/3);require(abs(variances['combined']-analytic)<1e-18,'exact bootstrap variance identity')
 out={}
 for name,var in variances.items():
  sd=math.sqrt(var);z=-.01/sd;path=work/f'part-a-{name}.json';path.write_text(json.dumps({'per_T':{'T':{'comparisons':{'known':{'z':z,'mean_d':-.01,'mean_d_leave_top':-.01,'bands':{}}}}}}));actual=original.part_a(str(path),[('T','known',None)],1.)[0]
  require(abs(actual['z_dev']-(-z))<1e-12,'original Part A z mapping');out[name]=dict(bootstrap_variance=var,bootstrap_SD=sd,known_signed_z=z,original_part_a=actual)
 return dict(series=4,blocks=3,draw_tuples=6912,bootstrap_variance_convention='population SD of exact independent uniform resampling law (ddof0)',analytic_combined_variance=analytic,components=out,combined_plugin_is_time_only_ceiling=False,qualification='Mathematical counterexample only: combined bootstrap z differs from time-only z. Not the original empirical R164 decomposition or a forecasting edge.')
def load_request(path,digest):
 require(sha(path)==digest,'request hash changed');r=json.loads(Path(path).read_text());require(r['schema']==SCHEMA and r['grid']==GRID and r['N_worlds_per_case']==N and r['seed']==SEED and r['policy']==POLICY and r['z']==Z and r['nominal']==NOMINAL and r['tolerance']==TOL,'fixed protocol changed')
 for p in r['artifacts'].values():check_pin(p)
 require(r['runtime']==runtime(),'runtime identity/version changed');require('torch' not in sys.modules,'Torch must not be imported');return r
def admission_guard(paths,work):
 allowed={str(Path(p).resolve()) for p in paths};roots=[Path(sys.prefix).resolve(),Path(sys.base_prefix).resolve()];state={'active':True,'denials':0}
 def hook(event,args):
  if not state['active']:return
  if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.posix_spawn','os.exec'):
   state['denials']+=1;raise RuntimeError('network/subprocess prohibited')
  if event!='open' or isinstance(args[0],int):return
  path=Path(os.fsdecode(args[0])).resolve();mode=args[1] if len(args)>1 else '';flags=args[2] if len(args)>2 else 0;write=bool((flags or 0)&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or (isinstance(mode,str) and any(x in mode for x in 'wax+'))
  permitted=path.is_relative_to(work) if write else path.is_relative_to(work) or str(path) in allowed or any(path.is_relative_to(root) for root in roots)
  if not permitted:state['denials']+=1;raise RuntimeError('unadmitted file access')
 sys.addaudithook(hook);return state
def resources(start,work):
 rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss;require(rss<=POLICY['rss_bytes'],'RSS policy');require(time.monotonic()-start<=POLICY['wall_seconds'],'wall policy');require(shutil.disk_usage(work).free>=POLICY['disk_reserve_bytes'],'disk reserve');return rss
def run(request_path,digest,work):
 r=load_request(request_path,digest);work=Path(work).resolve();require(not work.exists(),'fresh working directory required');work.mkdir(parents=True);start=time.monotonic();state=admission_guard([request_path,*[v['path'] for v in r['artifacts'].values()]],work)
 try:
  original=load_original(Path(r['artifacts']['original']['path']));rows=[];peak=resources(start,work)
  for case in grid():
   rows.append(evaluate_case(original,case,work));peak=max(peak,resources(start,work))
  require(len(rows)==99 and [x['case_id'] for x in rows]==list(range(99)),'all99fixedcases required');a=part_a_exact(original,work)
  for p in r['artifacts'].values():check_pin(p)
  require(sha(request_path)==digest and state['denials']==0,'changed request or access denial');require('torch' not in sys.modules,'Torch imported')
  value=dict(schema=SCHEMA,complete=True,request=pin(request_path),artifacts=r['artifacts'],runtime=runtime(),case_count=99,N_worlds_per_case=N,seed=SEED,part_b=rows,part_a=a,telemetry=dict(elapsed_seconds=time.monotonic()-start,peak_process_RSS_bytes=peak),access_denials=state['denials'],limitations=LIMITS,actual_source_header_qualification='Actual Part B uses deterministic median width<=10 and no CGM/width-bootstrap branch. No header behavior invented.')
  data=(json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n').encode();require(len(data)+sum(f.stat().st_size for f in work.iterdir() if f.is_file())<=POLICY['output_bytes'],'aggregate fixture/result output cap');resources(start,work);(work/'result.json').write_bytes(data);return value
 finally:state['active']=False
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--work-dir',required=True);args=p.parse_args();result=run(args.request,args.request_sha256,args.work_dir);print(json.dumps({'complete':result['complete'],'cases':result['case_count'],'result':str(Path(args.work_dir)/'result.json')}))
