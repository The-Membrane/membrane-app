"""Fixed finite-world audit of downstream R16.4 coverage uncertainty; no market inputs."""
from __future__ import annotations
import argparse
from contextlib import contextmanager, redirect_stdout
from fractions import Fraction
import hashlib
import importlib
import io
import itertools
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import sys
import time
import traceback
import numpy as np
import scipy

SOURCE=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts')
CLOSURE=('r164_ranges.py','r164_score.py','r164_power.py','a_touch.py','a2_touch.py','a3_touch.py','a4_touch.py','a5_touch.py','a6_touch.py')
NAMES=('synthetic-range-05','synthetic-range-11','synthetic-range-04','synthetic-range-00','synthetic-range-01')
CONSTRUCTIONS=('PU','DIS','CAL','CALr','CALb','H_CD','H_CP')
SEED=20261642
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=300,output_bytes=10000000)
SCHEMA='codex-r164-range-uncertainty-request-v1'
LIMITS=('Finite synthetic laws, conditional on fixed algorithm seed; four-block stress test, not market calibration or power.',
        'Supplied boot_q validates downstream handling, not fh_boot parameter refits. No historical/raw/reserve inputs or forecast revision.',
        'Target is E_world of reported group coverage; distinct from O21 group-frequency/latent-probability coverage.',
        'Null CGM SE is retained; positive-only mean squared SE does not establish unconditional variance calibration.',
        'Original Part B plugin descriptors are retained, not empirical/corrected power or decision false-positive rates; no CGM decision branch is invented.',
        'Duplicate rows and series are dependent; the 337 enumerated states are weighted finite supports, not IID trials.')


def need(ok,msg):
    if not ok:raise ValueError(msg)

def pin(path):
    p=Path(path).resolve();h=hashlib.sha256(p.read_bytes()).hexdigest()
    return dict(path=str(p),size=p.stat().st_size,sha256=h)

def dump(path,value):
    with open(path,'x') as f:json.dump(value,f,separators=(',',':'),allow_nan=False)

def read(path):
    def unique(pairs):
        d={}
        for k,v in pairs:need(k not in d,'duplicate JSON key');d[k]=v
        return d
    with open(path) as f:return json.load(f,object_pairs_hook=unique,parse_constant=lambda x:(_ for _ in ()).throw(ValueError(x)))

def runtime():
    return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),numpy=np.__version__,scipy=scipy.__version__,machine=platform.machine(),
        threads={k:os.environ.get(k) for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')})

def worlds(law):
    if law=='independent':
        for bits in itertools.product((0,1),repeat=8):
            y=np.array(bits,dtype=np.int8).reshape(4,2)
            num=math.prod((1 if bit else 3) if j%2==0 else (3 if bit else 1) for j,bit in enumerate(bits))
            yield y,Fraction(num,4**8)
    elif law=='shared':
        outcomes=((0,0),(0,1),(1,1))
        for states in itertools.product(range(3),repeat=4):
            yield np.array([outcomes[s] for s in states],dtype=np.int8),Fraction(math.prod(2 if s==1 else 1 for s in states),4**4)
    else:raise ValueError('unknown law')

def fixture_arrays(y,name):
    need(y.shape==(4,2) and np.isin(y,[0,1]).all(),'invalid world')
    p=np.broadcast_to(np.array([.25,.75])[None,:,None],(4,2,16)).reshape(-1).copy()
    return dict(name=np.array(name),day=np.repeat(17532+182*np.arange(4),32).astype(np.int32),T_h=np.full(128,24,np.int32),k_i=np.zeros(128,np.int16),
        y=np.repeat(y[:,:,None],16,axis=2).reshape(-1).astype(np.int8),p_fH=p,p_rec12=p.copy(),p_a=np.clip(p-.25,0,1),p_f=np.clip(p-.125,0,1),p_fbL=np.clip(p+.25,0,1),
        boot_q=np.clip(p[:,None]+np.array([-.25,-.125,0,.125,.25]),0,1))

def write_fixture(path,y):
    path.mkdir(exist_ok=False)
    for name in NAMES:np.savez(path/(name+'.npz'),**fixture_arrays(y,name))

def validate_fixture(path,y):
    need(sorted(p.name for p in path.iterdir())==sorted(n+'.npz' for n in NAMES),'fixture member closure')
    for g,name in enumerate(NAMES):
        need(int(hashlib.sha256(('Q26-R16.4-SG:'+name).encode()).hexdigest()[:8],16)%5==g,'hashed series group')
        want=fixture_arrays(y,name)
        with np.load(path/(name+'.npz'),allow_pickle=False) as z:
            need(set(z.files)==set(want),'fixture field closure')
            for k,v in want.items():need(z[k].dtype==v.dtype and np.array_equal(z[k],v),'fixture member changed')
    # Exact equal masses give two occupied bins; the rightmost allocated bin is empty.
    lp=np.log(np.tile([.25,.75],320));edges=np.unique(np.quantile(lp,[.2,.4,.6,.8]))
    need(np.array_equal(edges,np.log([.25,.75])) and set(np.searchsorted(edges,lp))=={0,1},'forecast-bin projection')


def weighted_quantile(values,q):
    # All 24 training groups have equal count16. This independently uses their ranks.
    a=np.sort(np.asarray(values,dtype=float))
    return np.interp(q,np.arange(1,len(a)+1)/len(a),a)

def reference(y,diagnostics=None):
    """Independent 2-bin x5-series x4-block grid; never calls original helpers."""
    rng=np.random.default_rng(SEED);p=np.array([.25,.75]);grid=np.broadcast_to(y.T[:,None,:],(2,5,4)).astype(float)
    L={};U={}
    for c in ('PU','DIS'):
        L[c]=np.broadcast_to(np.clip(p-.25,0,1)[:,None,None],(2,5,4)).copy()
        U[c]=np.broadcast_to(np.clip(p+.25,0,1)[:,None,None],(2,5,4)).copy()
    for c in ('CAL','CALr','CALb'):L[c]=np.empty((2,5,4));U[c]=np.empty((2,5,4))
    base=np.empty((2,5,4))
    for g in range(5):
        for b in range(4):
            train=[float(y[j,k]/p[k]) for k in range(2) for h in range(5) if h!=g for j in range(4) if j!=b]
            need(len(train)==24,'training group support')
            q=weighted_quantile(train,[.05,.95])
            for c in ('CAL','CALr'):
                L[c][:,g,b]=np.clip(p*q[0],0,1);U[c][:,g,b]=np.clip(p*q[1],0,1)
            # Consume exactly the original series draws, although identical-series ratios cancel them.
            rng.multinomial(4,np.full(4,.25),size=200)
            wb=rng.multinomial(3,np.full(3,1/3),size=200);keep=[j for j in range(4) if j!=b]
            ratio=np.array([(wb@y[keep,k])/(3*p[k]) for k in range(2)]).T
            q=np.quantile(ratio,[.05,.95],axis=0)
            L['CALb'][:,g,b]=np.clip(p*q[0],0,1);U['CALb'][:,g,b]=np.clip(p*q[1],0,1)
            base[:,g,b]=float(y[keep].mean())
    for c,other in (('H_CD','DIS'),('H_CP','PU')):
        L[c]=np.minimum(L['CAL'],L[other]);U[c]=np.maximum(U['CAL'],U[other])
    result={};counts={}
    for c in CONSTRUCTIONS:
        lo,hi=L[c],U[c];covered=(grid>=lo-1e-12)&(grid<=hi+1e-12);cv=covered.astype(float)
        counts[c]=int(covered.sum());mean=float(cv.mean());res=(cv-mean)/40
        # Direct loops: intersection sums over BOTH bins before squaring.
        by_g=[0.]*5;by_b=[0.]*4;intersection=[[0.]*4 for _ in range(5)]
        for k in range(2):
            for g in range(5):
                for b in range(4):
                    r=float(res[k,g,b]);by_g[g]+=r;by_b[b]+=r;intersection[g][b]+=r
        v=sum(float((np.asarray(a)**2).sum())*sign for a,sign in ((by_g,1),(by_b,1),([x for row in intersection for x in row],-1)))
        exact=exact_cgm(covered)
        if diagnostics is not None:diagnostics[c]=dict(net=[exact.numerator,exact.denominator],sign=(exact>0)-(exact<0),source_positive_on_exact_zero=bool(exact==0 and v>0))
        draws=[]
        for _ in range(500):
            d=rng.integers(0,4,4)
            draws.append(sum(float(cv[:,:,b].sum()) for b in d)/40)
        # Every group has16 identical rows, so row and group width distributions coincide.
        wid=(hi-lo).reshape(-1);score=hi-lo+20*(np.maximum(lo-grid,0)+np.maximum(grid-hi,0))
        result[c]=dict(coverage_groups=mean,coverage_rows=mean,coverage_ci90=[float(np.quantile(draws,.05)),float(np.quantile(draws,.95))],
            width_median_pts=float(np.median(wid)*100),width_p90_pts=float(np.quantile(wid,.9)*100),share_width_lt10pts=float((wid<.1).mean()),
            share_excludes_base_rate=float(((base<lo)|(base>hi)).mean()),interval_score_pts=float(score.mean()*100),n_groups=40,
            T2_bins_covered=sum(int(grid[k].mean()>=lo[k].mean()-1e-12 and grid[k].mean()<=hi[k].mean()+1e-12) for k in range(2)),T2_bins=2,
            coverage_se_cgm=math.sqrt(v) if v>0 else None,rows_with_range=640)
    return dict(T='1d',level=0,tier='alts',n_rows=640,base_rate=float(grid.mean()),n_groups=40,n_blocks=4,constructions=result),counts


def reconcile(actual,expected):
    need(type(actual)==type(expected) or isinstance(actual,(int,float)) and isinstance(expected,(int,float)),'reference type mismatch')
    if isinstance(expected,dict):
        need(set(actual)==set(expected),'reference field mismatch')
        return max((reconcile(actual[k],v) for k,v in expected.items()),default=0.)
    if isinstance(expected,list):
        need(len(actual)==len(expected),'reference length mismatch');return max((reconcile(a,b) for a,b in zip(actual,expected)),default=0.)
    if isinstance(expected,float):
        err=abs(actual-expected);need(math.isfinite(actual) and err<=128*np.finfo(float).eps*max(1,abs(expected)),'reference numeric mismatch');return err
    need(actual==expected,'reference categorical mismatch');return 0.


def exact_cgm(covered):
    need(covered.shape==(2,5,4),'CGM coverage grid shape')
    count=int(covered.sum());sg=[0]*5;block=[0]*4;inter=[[0]*4 for _ in range(5)]
    for k in range(2):
        for g in range(5):
            for b in range(4):
                u=40*int(covered[k,g,b])-count
                sg[g]+=u;block[b]+=u;inter[g][b]+=u
    return Fraction(sum(x*x for x in sg)+sum(x*x for x in block)-sum(x*x for row in inter for x in row),40**4)


def plugin_reference(cell):
    result=[]
    for c in CONSTRUCTIONS:
        v=cell['constructions'][c];coverage=v['coverage_groups'];lo,hi=v['coverage_ci90'];se=(hi-lo)/3.29
        if se<=0:power=1. if abs(coverage-.9)<.05 else 0.
        else:
            def normal(x):return (1+math.erf(x/math.sqrt(2)))/2
            power=max(0.,normal((.05-(coverage-.9))/se-1.6449)+normal((.05+(coverage-.9))/se-1.6449)-1)
        width=float(v['width_median_pts']<=10.)
        result.append(dict(T='1d',tier='alts',level=0,construction=c,coverage_dev=coverage,se_proj=se,tost_power=power,
            width_median_pts=v['width_median_pts'],width_leg=width,joint=power*width))
    return result


def descriptor_distribution(records,weights,c):
    fields=('coverage_dev','se_proj','tost_power','width_median_pts','width_leg','joint');result={}
    for field in fields:
        masses={}
        for r,w in zip(records,weights):
            value=float(next(v for v in r['part_b'] if v['construction']==c)[field]);masses[value]=masses.get(value,Fraction(0))+w
        result[field]=dict(weighted_mean=math.fsum(float(w)*value for value,w in masses.items()),
            distribution=[dict(value=value,weight=[w.numerator,w.denominator]) for value,w in sorted(masses.items())])
    return result


def aggregate(records):
    result={}
    for law in ('independent','shared'):
        rr=[r for r in records if r['law']==law];need(len(rr)==(256 if law=='independent' else 81),'law support')
        weights=[Fraction(*r['weight']) for r in rr];need(sum(weights)==1,'law probability mass');cc={}
        for c in CONSTRUCTIONS:
            x=[Fraction(r['covered_counts'][c],40) for r in rr];theta=sum(w*a for w,a in zip(weights,x));var=sum(w*(a-theta)**2 for w,a in zip(weights,x))
            contains=sum(w for w,r in zip(weights,rr) if Fraction.from_float(r['cell']['constructions'][c]['coverage_ci90'][0])<=theta<=Fraction.from_float(r['cell']['constructions'][c]['coverage_ci90'][1]))
            nullmass=sum(w for w,r in zip(weights,rr) if r['cell']['constructions'][c]['coverage_se_cgm'] is None)
            exact_mean=sum(w*Fraction(*r['exact_CGM'][c]['net']) for w,r in zip(weights,rr))
            exact_sign_mass={str(sign):sum(w for w,r in zip(weights,rr) if r['exact_CGM'][c]['sign']==sign) for sign in (-1,0,1)}
            roundoff_mass=sum(w for w,r in zip(weights,rr) if r['exact_CGM'][c]['source_positive_on_exact_zero'])
            msse=sum(float(w)*r['cell']['constructions'][c]['coverage_se_cgm']**2 for w,r in zip(weights,rr) if r['cell']['constructions'][c]['coverage_se_cgm'] is not None)
            def exact(v):return dict(numerator=v.numerator,denominator=v.denominator,value=float(v))
            cc[c]=dict(theta=exact(theta),variance=exact(var),SD=math.sqrt(float(var)),CI_inclusion_mass=exact(contains),CGM_null_mass=exact(nullmass),
                exact_CGM_net_weighted_mean=exact(exact_mean),exact_CGM_sign_mass={k:exact(v) for k,v in exact_sign_mass.items()},source_positive_SE_on_exact_zero_mass=exact(roundoff_mass),
                exact_mean_CGM_net_over_world_variance=float(exact_mean/var) if var else None,CGM_positive_SE_square_weighted_sum=msse,CGM_positive_only_mean_square_SE=msse/float(1-nullmass) if nullmass<1 else None,
                positive_only_is_unconditional_variance_calibration=False,original_part_b_descriptor=descriptor_distribution(rr,weights,c))
            if c in ('PU','DIS'):
                need(theta==Fraction(3,4) and var==(Fraction(3,128) if law=='independent' else Fraction(1,64)),'analytical oracle failure')
        result[law]=cc
    return result


@contextmanager
def body_guard(output,source_pins):
    """No historical/data/network reads; only admitted source/runtime code and fresh synthetic output."""
    active=[True];out=Path(output).resolve();sources={Path(p['path']).resolve() for p in source_pins}
    runtime_roots={Path(sys.base_prefix).resolve(),Path(np.__file__).resolve().parent,Path(scipy.__file__).resolve().parent}
    def inside(p,root):return p==root or root in p.parents
    def audit(event,args):
        if not active[0]:return
        if event in ('socket.connect','socket.getaddrinfo','subprocess.Popen','os.system','os.exec','os.posix_spawn'):raise PermissionError('external access forbidden')
        if event=='open':
            path,mode,flags=args
            if isinstance(path,int):return
            p=Path(path).resolve();write=bool(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND))
            if inside(p,out):return
            if write:raise PermissionError('write outside fresh output')
            if p in sources:return
            if any(inside(p,r) for r in runtime_roots) and p.suffix in ('.py','.pyc','.so','.dylib'):return
            raise PermissionError('unadmitted file read')
    sys.addaudithook(audit)
    try:yield
    finally:active[0]=False


def authenticate(req):
    need(req['schema']==SCHEMA and req['status']=='READY_PARENT_REVIEWED','draft/unadmitted request')
    need(req['policy']==POLICY and req['runtime']==runtime(),'policy/runtime mismatch')
    need(all(v=='1' for v in req['runtime']['threads'].values()),'thread limit mismatch')
    expected={str((SOURCE/n).resolve()) for n in CLOSURE}
    need({p['path'] for p in req['source_pins']}==expected and len(req['source_pins'])==9,'source closure mismatch')
    need(req['runtime_proof_pin']['sha256']=='b0111f8eb81243ee27e6514b7bf13c32135c2ef50a214e5d7d1d031800931852','runtime proof identity')
    for p in req['source_pins']+[req['helper_pin'],req['test_pin'],req['runtime_proof_pin']]:need(pin(p['path'])==p,'source changed')
    need(req['helper_pin']['path']==str(Path(__file__).resolve()),'helper identity')
    need(req['protocol']==protocol(),'protocol changed')


def protocol():
    return dict(names=list(NAMES),blocks=4,forecasts=[.25,.75],duplicates=16,rows=640,occupied_bins=2,allocated_bins=3,nominal=.9,seed=SEED,horizon=24,level=0,tier='alts',
        probability_offsets=dict(a=-.25,f=-.125,fbL=.25,fH=0,rec12=0),boot_q_offsets=[-.25,-.125,0,.125,.25],CALb=200,coverage_bootstrap=500,
        laws=dict(independent=dict(states=256,integer_denominator=4**8),shared=dict(states=81,integer_denominator=4**4)),fixed_seed_per_world=True,part_b=dict(nominal=.9,tol=.05,width_pts=10.,b_new_ratio=1.,constructions=list(CONSTRUCTIONS),descriptive_plugin_only=True))


def execute(req,out):
    authenticate(req);need(not out.exists(),'output must be fresh');out.mkdir();start=time.monotonic();ordinal=-1;stage='start';records=[]
    def resources():
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
        need(rss<=POLICY['rss_bytes'],'RSS limit');need(time.monotonic()-start<=300,'wall limit');need(shutil.disk_usage(out).free>=POLICY['disk_reserve_bytes'],'disk reserve')
        need(sum(p.stat().st_size for p in out.rglob('*') if p.is_file())<=POLICY['output_bytes'],'output cap')
    try:
        with body_guard(out,req['source_pins']+[req['helper_pin'],req['test_pin']]):
            sys.path.insert(0,str(SOURCE));R=importlib.import_module('r164_ranges');P=importlib.import_module('r164_power')
            need(Path(R.__file__).resolve()==SOURCE/'r164_ranges.py' and Path(P.__file__).resolve()==SOURCE/'r164_power.py','producer module identity')
            need(R.N_BOOT_CALB==200 and R.N_SG==5 and R.NBIN==5 and R.CONSTR==CONSTRUCTIONS,'producer constants')
            (out/'worlds').mkdir();resources()
            for law in ('independent','shared'):
                for index,(y,weight) in enumerate(worlds(law)):
                    ordinal+=1;resources();stage='fixture';fixture=out/'fixture';write_fixture(fixture,y);validate_fixture(fixture,y)
                    stage='producer';dest=out/'worlds'/f'{ordinal:03d}-{law}-{index:03d}.json'
                    with redirect_stdout(io.StringIO()):R.run(str(fixture),str(dest),nominal=.9,seed=SEED,shuffle_blocks=False,horizons=(24,))
                    actual=read(dest);need(set(actual)=={'nominal','target','T2_target','cells'} and actual['nominal']==.9 and actual['target']=='realized_group_frequency' and actual['T2_target']=='pooled_calibration_frequency' and len(actual['cells'])==1,'producer output shape')
                    stage='reference';exact_diag={};ref,counts=reference(y,exact_diag);error=reconcile(actual['cells'][0],ref)
                    plugin=P.part_b(str(dest),[('1d','alts',0,c) for c in CONSTRUCTIONS],.9,.05,10.,b_new_ratio=1.)
                    error=max(error,reconcile(plugin,plugin_reference(ref)))
                    records.append(dict(law=law,index=index,weight=[weight.numerator,weight.denominator],covered_counts=counts,exact_CGM=exact_diag,part_b=plugin,cell=actual['cells'][0],output_pin=pin(dest),maximum_absolute_error=error))
                    shutil.rmtree(fixture);stage='complete-world';resources()
                    if (ordinal+1)%16==0:print(json.dumps(dict(completed_worlds=ordinal+1,elapsed_seconds=time.monotonic()-start)),file=sys.stderr,flush=True)
            stage='aggregate';summary=aggregate(records);resources()
            for p in req['source_pins']+[req['helper_pin'],req['test_pin']]:need(pin(p['path'])==p,'source changed during run')
            dump(out/'result.json',dict(schema='codex-r164-range-uncertainty-v1',complete=True,request=req,summary=summary,worlds=records,limitations=LIMITS,elapsed_seconds=time.monotonic()-start))
            resources()
    except BaseException as e:
        dump(out/'failure.json',dict(complete=False,world_ordinal=ordinal,stage=stage,exception_class=type(e).__name__,elapsed_seconds=time.monotonic()-start))
        raise


def main():
    p=argparse.ArgumentParser();p.add_argument('--request',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    need(pin(a.request)['sha256']==a.sha256,'request hash');req=read(a.request);need(str(a.out.resolve())==req['output'],'output request mismatch');execute(req,a.out.resolve())

if __name__=='__main__':main()
