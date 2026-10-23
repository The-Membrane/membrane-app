"""Generic bounded-score HAC falsification laws; no empirical loader or power claim.

These two score coordinates are NOT shown jointly realizable as Brier/log-loss
U from common binary forecasts A,C, outcome Y and missingness M. Their size
behavior cannot qualify the actual C/U-process or admit empirical inference.

Bounded two-state Markov X has stationary uniform signs and E[X_t|X_(t-1)]
=rho*X_(t-1); independent sign flips give geometric mixing for rho<1.
Independent iid nonnegative counts imply E[S_t]=0, Gamma=E[S]/E[N]=0.
The mean-break control deliberately violates each-t centered-score conditions.
"""
import argparse, hashlib, importlib.util, json, math, os, random, time
from pathlib import Path

CORE_SHA='15dd196cff71cf3c47104f73bf3e53e61e458c6843ea8b8b298db4ff6dfc9906'
SEED=20261023
REPS=1000
SCENARIOS=(('independent',0.,0.,False),('common_iid',0.,.75,False),
           ('persistent_05',.5,.75,False),('persistent_09',.9,.75,False),
           ('mean_break_control',.5,.75,True))
# 4 scenarios * (four marginals + IUT) =20 simultaneous null diagnostics.
FAMILY=20
MC_TAIL=.01/(2*FAMILY)

def load_core(path):
    path=Path(path);b=path.read_bytes()
    if hashlib.sha256(b).hexdigest()!=CORE_SHA:raise ValueError('core source pin')
    spec=importlib.util.spec_from_loader('qualified_hac',loader=None)
    m=importlib.util.module_from_spec(spec);exec(compile(b,str(path),'exec'),m.__dict__)
    return m

def generate(seed,rho,common,mean_break=False):
    """Three latent stationary signs; rowweights vary independently, never by loss."""
    rng=random.Random(seed);states=[rng.choice((-1,1)) for _ in range(3)]
    years=[]
    for T in (366,365):
        n=[];s=[]
        for t in range(T):
            for j in range(3):
                if rng.random()<(1-rho)/2:states[j]*=-1
            count=rng.choice((0,1,3,7));n.append(count)
            offset=0.
            if mean_break:
                half=T//2;offset=-.2 if t<half else .2*half/(T-half)
            # amplitudes <=.5+.2<1; LL numerator uses its own exact bound.
            vals=[.5*(common*states[0]+(1-common)*states[j+1])+offset for j in range(2)]
            s.append([count*vals[0],count*vals[1]*(-math.log(1e-6))])
        years.append((n,s))
    return years

def binomial_interval(k,n):
    """Equal-tail Clopper-Pearson, Bonferroni family99% for20 null cells."""
    if type(k)is not int or type(n)is not int or not 0<=k<=n or n<=0:raise ValueError('binomial domain')
    logchoose=[math.lgamma(n+1)-math.lgamma(i+1)-math.lgamma(n-i+1) for i in range(n+1)]
    def cdf(j,p):
        if p==0:return 1.
        if p==1:return float(j>=n)
        lp=math.log(p);lq=math.log1p(-p)
        return math.fsum(math.exp(logchoose[i]+i*lp+(n-i)*lq) for i in range(j+1))
    def inverse(j,target):
        lo=0.;hi=1.
        for _ in range(52):
            mid=(lo+hi)/2
            if cdf(j,mid)>target:lo=mid
            else:hi=mid
        return (lo+hi)/2
    lower=0. if k==0 else inverse(k-1,1-MC_TAIL)
    upper=1. if k==n else inverse(k,MC_TAIL)
    return [lower,upper]

def decisions(core,years):
    decisions=[];refusals=[]
    for n,s in years:
        try:
            r=core.ratio_hac(n,s);decisions.extend(r['components'][k]['reject'] for k in core.LOSSES);refusals.extend([False,False])
        except (ValueError,OverflowError):decisions.extend([False,False]);refusals.extend([True,True])
    return decisions+[all(decisions)],refusals+[any(refusals)]

def summarize(reject,refuse,n,negative_control=False):
    ci=binomial_interval(reject,n);worst=binomial_interval(reject+refuse,n)
    return {'rejections':reject,'refusals':refuse,'denominator':n,'rate':reject/n,
            'simultaneous_99pct_clopper_pearson_interval':ci,
            'refusal_as_rejection_interval':worst,
            'mc_family_member':not negative_control,
            'refusal_bound_semantics':'Conservative: IUT treats any refusal as possible rejection even if a tested component already fails.',
            'excess_size_flag':None if negative_control else ci[0]>.05,
            'unresolved_refusal_flag':bool(refuse),
            'meaning':'OUTSIDE_ASSUMPTIONS_NEGATIVE_CONTROL' if negative_control else 'GENERIC_BOUNDED_SCORE_NULL_NOT_ACTUAL_U_LAW_QUALIFICATION'}

def run(core,reps=REPS):
    if reps!=REPS:raise ValueError('fixed repetitions')
    out={}
    for index,(name,rho,c,broken) in enumerate(SCENARIOS):
        reject=[0]*5;refuse=[0]*5
        for r in range(reps):
            # Separate fixed scenario streams; serial replication independent seeds.
            d,f=decisions(core,generate(SEED+index*100000+r,rho,c,broken))
            reject=[a+int(b) for a,b in zip(reject,d)];refuse=[a+int(b) for a,b in zip(refuse,f)]
        names=('2024_brier','2024_logloss','2025_brier','2025_logloss','IUT4')
        out[name]={key:summarize(a,b,reps,broken) for key,a,b in zip(names,reject,refuse)}
    return {'schema':'q26-generated-hac-size-v1','seed':SEED,'repetitions':reps,
            'scope':'GENERIC_BOUNDED_SCORE_HAC_FALSIFICATION_ONLY','empirical_admission':'NOT_ADMITTED',
            'power_claim':False,'finite_size_validity_established':False,'actual_U_law_qualified':False,'joint_binary_proper_loss_realizability_established':False,'results':out}

def pilot(core):
    start=time.monotonic()
    for i,(_,rho,c,broken) in enumerate(SCENARIOS):
        for r in range(3):decisions(core,generate(SEED+900000+i*10+r,rho,c,broken))
    elapsed=time.monotonic()-start
    # No pilot rejection counts/pvalues retained. Main reps never adjusted to results.
    return {'mode':'TIMING_ONLY_15_REPLICATES','seconds':elapsed,
            'projected_main_seconds':elapsed*(len(SCENARIOS)*REPS)/15,
            'main_repetitions_unchanged':REPS,'decisions_retained':False}

def main():
    p=argparse.ArgumentParser();p.add_argument('--core',required=True);p.add_argument('--pilot',action='store_true')
    p.add_argument('--admitted',action='store_true');p.add_argument('--out',required=True);a=p.parse_args()
    if not a.pilot and not a.admitted:raise ValueError('DRAFT main simulation refuses')
    core=load_core(a.core);result=pilot(core) if a.pilot else run(core)
    # Parent externally enforces fresh wall/RSS/disk/output bounds and source pins.
    blob=(json.dumps(result,sort_keys=True,allow_nan=False)+'\n').encode()
    if len(blob)>2*1024*1024:raise ValueError('output cap')
    fd=os.open(a.out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(blob);f.flush();os.fsync(f.fileno())
    print(json.dumps({'mode':'pilot' if a.pilot else 'main','bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}))
if __name__=='__main__':main()
