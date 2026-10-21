#!/usr/bin/env python3
"""Prospective synthetic mechanism DRAFT; no stage runs before parent admission."""
import argparse, hashlib, importlib.util, json, os, platform, resource, shutil, signal, sys, time
from pathlib import Path
from types import SimpleNamespace
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'): os.environ[k]='1'
import numpy as np
HERE=Path(__file__).resolve().parent
F=HERE.parent/'r16-fh-bootstrap-validation-v1'
H=np.array([[1,1,1,1],[1,1,-1,-1],[1,-1,1,-1],[1,-1,-1,1]],float)
CONDITIONS=('common_zero','common_noisy','heterogeneous_zero','heterogeneous_noisy')

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def authenticate(s):
 for p in s['dependency_pins']:
  q=Path(p['path'])
  if q.stat().st_size!=p['size'] or sha(q)!=p['sha256']: raise ValueError('dependency pin changed')
 if sys.version.split()[0]!=s['python_version'] or np.__version__!=s['numpy_version']: raise ValueError('runtime changed')
 spec=importlib.util.spec_from_file_location('accepted_fh_subject',F/'validate_fh_boot.py')
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 subject=m.load_subject()
 pin=json.loads((F/'caller-pins.json').read_text());lines=(m.SOURCE_ROOT/m.SOURCE_REL).read_bytes().splitlines(keepends=True)
 lo,hi=pin['inclusive_lines']
 if hashlib.sha256(b''.join(lines[lo-1:hi])).hexdigest()!=pin['sha256']:raise ValueError('caller changed')
 return subject

class Weights:
 def __init__(self,w):self.w,self.i=w,0
 def multinomial(self,n,p):
  if n!=32 or not np.array_equal(p,np.full(32,1/32)):raise ValueError('block geometry changed')
  ans=self.w[self.i].copy();self.i+=1;return ans
class Barriers:
 def __init__(self,depth,scale,levels):self.depth,self.scale,self.a=depth,scale,np.log1p(levels)
 def thresholds(self,sigma):return self.a[None,:]/(np.asarray(sigma)[:,None]*self.scale)

def innovations(s,j):
 streams=np.random.SeedSequence(s['world_seeds'][j]).spawn(3)
 z=np.random.default_rng(streams[0]).normal(size=(32,4))
 e=np.random.default_rng(streams[1]).exponential(size=(32,64))
 u=np.random.default_rng(streams[2]).random((32,64))
 w=np.random.default_rng(s['bootstrap_seeds'][j]).multinomial(32,np.full(32,1/32),size=200)
 return z,e,u,w

def truths(s,heterogeneous):
 beta=np.array(s['beta']);t=-np.log1p(s['levels'])[None,:]/(np.exp(H@beta)[:,None]*s['scale'])
 common=np.exp(-t);mixed=.5*np.exp(-t/.25)+.5*np.exp(-t/1.75)
 conditional=common.copy()
 if heterogeneous:conditional[[1,3]]=mixed[[1,3]]
 pooled=(.5*common+.25*np.exp(-t/.25)+.25*np.exp(-t/1.75)) if heterogeneous else common.copy()
 return conditional,pooled

def build(s,z,e,u,condition):
 heterogeneous=condition.startswith('heterogeneous');noise=.125 if condition.endswith('noisy') else 0.
 rows=(np.arange(32)[:,None]*720+np.arange(64)).ravel();qs=int(rows[-1])+24;te=np.arange(qs+1,qs+5);n=int(te[-1])+1
 X=np.zeros((n,4));lfut=np.zeros(n);dep=np.full(n,np.nan);okH=np.zeros(n,bool);okX=np.zeros(n,bool)
 design=np.tile(H,(16,1));beta=np.array(s['beta']);v=e.copy()
 if heterogeneous:
  state=np.arange(64)%4;mult=np.where(u<.5,.25,1.75);v[:,np.isin(state,[1,3])]*=mult[:,np.isin(state,[1,3])]
 for b in range(32):
  ix=rows[b*64:(b+1)*64];X[ix]=design;lfut[ix]=design@(beta+noise*z[b]);dep[ix]=-np.exp(design@beta)*s['scale']*v[b];okH[ix]=True;okX[ix]=True
 X[te]=H;okX[te]=True
 return SimpleNamespace(P=Barriers(dep,s['scale'],s['levels']),T_h=24,n=n,X=X,lfut=lfut,okH=okH,okX=okX,K=3),qs,te

def package(raw):
 a=np.minimum.accumulate(raw,axis=-1)
 return np.nanquantile(a,[.05,.25,.5,.75,.95],axis=0),np.nanstd(a,axis=0)
def moments(x):
 x=np.asarray(x);n=len(x)
 return {'mean':x.mean(axis=0).tolist(),'world_se':(x.std(axis=0,ddof=1)/np.sqrt(n)).tolist() if n>1 else None}
def measures(r,B):
 q=r['q'+str(B)];valid=np.isfinite(q[0])&np.isfinite(q[-1]);covered=valid&(q[0]<=r['truth'])&(r['truth']<=q[-1])
 return {'point_error':r['point']-r['truth'],'point_squared_error':(r['point']-r['truth'])**2,'availability':valid.astype(float),'inclusion':covered.astype(float),'width':np.where(valid,q[-1]-q[0],np.nan)}
def summarize(records):
 out={'completed_worlds':len(records),'unit':'independent paired world; cells and conditions dependent','conditions':{},'paired_contrasts':{}}
 if not records:return out
 for B in (20,200):
  scores={c:{k:np.stack([measures(w[c],B)[k] for w in records]) for k in measures(records[0][c],B)} for c in CONDITIONS}
  for c in CONDITIONS:
   out['conditions'].setdefault(c,{})[str(B)]={k:moments(v) for k,v in scores[c].items()}
   err=scores[c]['point_squared_error'];rmse=np.sqrt(err.mean(0))
   out['conditions'][c][str(B)]['point_rmse']=rmse.tolist()
   out['conditions'][c][str(B)]['world_mean_over_12_cells']={k:moments(v.mean(axis=(1,2))) for k,v in scores[c].items()}
   out['conditions'][c][str(B)]['available_world_count']=scores[c]['availability'].sum(0).astype(int).tolist()
   out['conditions'][c][str(B)]['zero_point_world_count']=np.sum(np.stack([w[c]['point']==0 for w in records]),axis=0).tolist()
   out['conditions'][c][str(B)]['zero_upper_world_count']=np.sum(np.stack([w[c]['q'+str(B)][-1]==0 for w in records]),axis=0).tolist()
   out['conditions'][c][str(B)]['point_rmse_delta_world_se']=(err.std(0,ddof=1)/np.sqrt(len(records))/(2*rmse)).tolist() if len(records)>1 else None
   out['conditions'][c][str(B)]['invalid_replicates_by_world']=[int(np.any(~np.isfinite(w[c]['raw'+str(B)]),axis=(1,2)).sum()) for w in records]
  for name,coef in {'noise_common':(-1,1,0,0),'noise_heterogeneous':(0,0,-1,1),'shape_zero':(-1,0,1,0),'shape_noisy':(0,-1,0,1),'interaction':(1,-1,-1,1)}.items():
   out['paired_contrasts'].setdefault(name,{})[str(B)]={k:moments(sum(a*scores[c][k] for a,c in zip(coef,CONDITIONS) if a)) for k in scores[CONDITIONS[0]]}
 for c in CONDITIONS:
  out['paired_contrasts']['B200_minus_B20_'+c]={k:moments(np.stack([measures(w[c],200)[k]-measures(w[c],20)[k] for w in records])) for k in measures(records[0][c],20)}
 return out

def run(s,stage,spec_sha):
 if (s['conditions']!=list(CONDITIONS) or s['noise_sds']!=[0,.125] or s['levels']!=[-.02,-.1,-.2] or s['scale']!=.5 or s['blocks']!=32 or s['rows_per_block']!=64 or s['block_hours']!=720 or s['T_h']!=24 or s['bootstrap_replicates']!=[20,200] or s['quantiles']!=[.05,.25,.5,.75,.95]):raise ValueError('fixed design changed')
 if stage not in (8,64) or len(s['world_seeds'])!=64 or len(s['bootstrap_seeds'])!=64 or s['world_count']!=64 or len(set(s['world_seeds']+s['bootstrap_seeds']))!=128:raise ValueError('seed closure')
 subject=authenticate(s);out=HERE/f'worlds-stage-{stage}-{spec_sha[:12]}';out.mkdir(exist_ok=False)
 started=time.monotonic();records=[];current=-1;phase='admission';manifest={'status':'started','spec_sha256':spec_sha,'stage':stage,'script_sha256':sha(__file__),'dependency_pins':s['dependency_pins'],'observations':[],'runtime':{'python':sys.version,'numpy':np.__version__,'platform':platform.platform(),'executable':sys.executable}}
 def observe():
  rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024);free=shutil.disk_usage(HERE).free
  manifest['observations'].append({'elapsed':time.monotonic()-started,'peak_rss_bytes':rss,'free_bytes':free})
  if rss>=s['rss_bytes'] or free<s['disk_reserve_bytes'] or time.monotonic()-started>s['wall_seconds']:raise RuntimeError('resource boundary')
 def alarm(*_):raise TimeoutError('invocation wall limit')
 signal.signal(signal.SIGALRM,alarm);signal.alarm(s['wall_seconds'])
 try:
  observe()
  for j in range(stage):
   current=j;phase='inputs';z,e,u,w=innovations(s,j)
   np.savez(out/f'world-{j:02d}-inputs.npz',z=z,e=e,u=u,weights=w,world_seed=s['world_seeds'][j],bootstrap_seed=s['bootstrap_seeds'][j])
   record={}
   for c in CONDITIONS:
    phase=c;observe();p,qs,te=build(s,z,e,u,c);truth,pooled=truths(s,c.startswith('heterogeneous'))
    raw20=subject(p,qs,te,Weights(w[:20]));np.save(out/f'world-{j:02d}-{c}-raw20.npy',raw20)
    raw200=subject(p,qs,te,Weights(w),B=200);np.save(out/f'world-{j:02d}-{c}-raw200.npy',raw200);np.testing.assert_array_equal(raw20,raw200[:20])
    point=subject(p,qs,te,Weights(np.ones((1,32),int)),B=1)[0];q20,sd20=package(raw20);q200,sd200=package(raw200)
    r=dict(point=point,truth=truth,pooled_asymptote=pooled,raw20=raw20,raw200=raw200,q20=q20,q200=q200,sd20=sd20,sd200=sd200)
    np.savez(out/f'world-{j:02d}-{c}-outputs.npz',**r);record[c]=r;observe()
   records.append(record)
  phase='summary';(out/'summary.json').write_text(json.dumps(summarize(records),indent=2)+'\n');observe()
  authenticate(s);manifest['status']='complete'
 except BaseException as ex:
  manifest.update(status='failed_partial',error_type=type(ex).__name__,error=str(ex)[:300]);raise
 finally:
  signal.alarm(0);manifest.update(completed_worlds=len(records),current_world=current,phase=phase,elapsed=time.monotonic()-started)
  if manifest['status']!='complete':(out/'partial-summary.json').write_text(json.dumps(summarize(records),indent=2)+'\n')
  (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stage',type=int,choices=(8,64),required=True);p.add_argument('--approved-spec-sha256',required=True);a=p.parse_args();raw=(HERE/'spec.json').read_bytes();h=hashlib.sha256(raw).hexdigest()
 if h!=a.approved_spec_sha256:raise ValueError('unapproved spec bytes')
 run(json.loads(raw),a.stage,h)
if __name__=='__main__':main()
