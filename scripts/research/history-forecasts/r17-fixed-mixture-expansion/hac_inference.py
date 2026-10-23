"""Generated-source qualification of the frozen daily upper-loss ratio/HAC.

References: Diebold & Mariano (1995), Comparing Predictive Accuracy,
J. Business & Economic Statistics 13:253-263, doi:10.1080/07350015.1995.10524599;
Newey & West (1987), A Simple, Positive Semi-definite, Heteroskedasticity and
Autocorrelation Consistent Covariance Matrix, Econometrica 55:703-708,
doi:10.2307/1913610 (Theorem 2 supplies asymptotic assumptions, not a finite-T
validation of this bandwidth or application).

Inputs are complete calendar daily counts and two U-loss numerator sums.
Gamma=sum(S)/sum(N); psi_t=S_t-Gamma*N_t. Bartlett HAC uses denominator T;
SE=sqrt(Omega_ll/T)/Nbar. A negative mean with Phi(mean/SE)<=.05 rejects
one asymptotic upper-null component. Both losses in both years form one IUT.
Joint covariance may be PSD singular: no inversion; marginal SEs must be positive.

Application requires an appropriate within-year law with E[S_t-Gamma*N_t]=0
at each t, positive limiting mean count, and suitable CLT/mixing/moment and
bandwidth conditions. Calendar aggregation retains cross-panel shocks; it does
not establish these conditions or independent days. Generated arithmetic tests
do not verify the actual U-process law, power, empirical admission, finite-size
validity, or a forecast-score claim. No data loader is supplied.
"""
import calendar
import math
from datetime import date,timedelta

PROPOSAL_SHA256='67fa07cdda8ac1ef89c776e7d641836fd183febabe09ff7fd4a83252c48d1acb'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
LOSSES=('brier','bounded_logloss')
ALPHA=.05
EPS=1e-6
BOUNDS=(1.0,-math.log(EPS))
SCOPE='GENERATED_U_HAC_SOURCE_QUALIFICATION_ONLY'

def need(ok,message):
    if not ok:raise ValueError(message)

def finite(x):
    need(type(x) in (int,float),'finite numeric scalar, bool forbidden')
    try:y=float(x)
    except (OverflowError,ValueError):raise ValueError('numeric overflow')
    need(math.isfinite(y),'nonfinite scalar');return y

def total(xs):
    try:y=math.fsum(xs)
    except (OverflowError,ValueError):raise ValueError('sum overflow')
    need(math.isfinite(y),'nonfinite sum');return y

def bandwidth(T):
    need(type(T)is int and T>=2,'at least two calendar units')
    return min(T-1,max(1,math.floor(28*(T/365)**(1/5))))

def normal_cdf(z):
    z=finite(z)
    return .5*math.erfc(-z/math.sqrt(2))

def rejection(mean,p):
    mean=finite(mean);p=finite(p);need(0<=p<=1,'p domain')
    return mean<0 and p<=ALPHA

def bartlett(psi,L):
    """Joint2x2 HAC, unadjusted denominatorT, exact Bartlett lag convention."""
    need(type(psi)in(list,tuple) and len(psi)>=2,'score shape')
    T=len(psi);need(type(L)is int and 0<=L<T,'bandwidth range')
    rows=[]
    for row in psi:
        need(type(row)in(list,tuple) and len(row)==2,'two-loss vector')
        rows.append(tuple(finite(v) for v in row))
    omega=[[total(row[a]*row[b] for row in rows)/T for b in range(2)] for a in range(2)]
    for k in range(1,L+1):
        weight=1-k/(L+1)
        for a in range(2):
            for b in range(a,2):
                c1=total(rows[t][a]*rows[t-k][b] for t in range(k,T))/T
                c2=total(rows[t][b]*rows[t-k][a] for t in range(k,T))/T
                val=total([omega[a][b],weight*total([c1,c2])])
                omega[a][b]=omega[b][a]=val
    need(all(math.isfinite(v) for row in omega for v in row),'HAC overflow')
    scale=max(abs(v) for row in omega for v in row)
    if scale:
        a=omega[0][0]/scale;b=omega[0][1]/scale;d=omega[1][1]/scale
        need(a>=-1e-12 and d>=-1e-12 and a*d-b*b>=-1e-12,'HAC PSD failure')
    return omega

def ratio_hac(counts,sums,L=None):
    """Pure math seam for generated aggregates; caller supplies no outcome labels."""
    need(type(counts)in(list,tuple) and type(sums)in(list,tuple),'aggregate sequences')
    T=len(counts);need(T>=2 and len(sums)==T,'aggregate shape')
    n=[finite(v) for v in counts];need(all(v>=0 for v in n),'negative weights/counts')
    N=total(n);need(N>0,'zero support')
    s=[]
    for i,row in enumerate(sums):
        need(type(row)in(list,tuple) and len(row)==2,'two-loss numerator')
        v=tuple(finite(a) for a in row)
        if n[i]==0:need(v==(0.0,0.0),'nonzero zero-support numerator')
        for a in range(2):
            limit=n[i]*BOUNDS[a];need(math.isfinite(limit),'bound overflow')
            need(abs(v[a])<=limit+16*math.ulp(limit),'bounded U numerator')
        s.append(v)
    means=[total(row[a] for row in s)/N for a in range(2)]
    psi=[[total([s[t][a],-means[a]*n[t]]) for a in range(2)] for t in range(T)]
    for a in range(2):
        scale=max(total(abs(row[a]) for row in s),abs(means[a])*N)
        need(abs(total(row[a] for row in psi))<=64*math.ulp(scale),'ratio score centering')
    for a in range(2):
        # A constant ratio may leave only rounding residuals; do not turn them into tiny SE/significance.
        input_scale=max(max(abs(row[a]) for row in s),max(abs(means[a]*v) for v in n))
        need(max(abs(row[a]) for row in psi)>64*math.ulp(input_scale),
             'numerically degenerate HAC score: NOT TESTABLE')
    L=bandwidth(T) if L is None else L
    omega=bartlett(psi,L);nbar=N/T;components={}
    # No variance clamping or automatic reject at zero variance.
    for a,name in enumerate(LOSSES):
        need(omega[a][a]>0,'zero/negative HAC variance: NOT TESTABLE')
        se=math.sqrt(omega[a][a]/T)/nbar
        need(math.isfinite(se) and se>0,'invalid ratio standard error')
        z=means[a]/se;need(math.isfinite(z),'invalid z')
        p=normal_cdf(z)
        components[name]={'mean_U':means[a],'se':se,'z':z,'p':p,'reject':rejection(means[a],p)}
    return {'T':T,'N':N,'Nbar':nbar,'occupied_days':sum(v>0 for v in n),
            'bandwidth':L,'score_sums':[total(row[a] for row in psi) for a in range(2)],
            'omega':omega,'components':components,'psi':psi,
            'tail_type':'ASYMPTOTIC_GAUSSIAN_HAC_PVALUE','resampling_draws':0}

def qualify_year(year,days,counts,sums,*,status='DRAFT'):
    need(status==READY,'DRAFT: synthetic source qualification only')
    need(type(year)is int and year in (2024,2025),'fixed calendar year')
    T=366 if calendar.isleap(year) else 365
    expected=[(date(year,1,1)+timedelta(days=i)).isoformat() for i in range(T)]
    need(type(days)in(list,tuple) and list(days)==expected,'complete ordered unique calendar including zero days')
    need(len(counts)==T and len(sums)==T,'calendar aggregate coverage')
    result=ratio_hac(counts,sums)
    result.update(year=str(year),scope=SCOPE,source_synthetic_component=True,
                  empirical_admission_status='NOT_ADMITTED',finite_sample_validity_established=False)
    return result

def iut4(reports):
    need(type(reports)is dict and set(reports)=={'2024','2025'},'exact two-year conjunction')
    cells={}
    for year in ('2024','2025'):
        r=reports[year]
        need(r['year']==year and r['scope']==SCOPE and r['empirical_admission_status']=='NOT_ADMITTED','source-only year scope')
        need(r['tail_type']=='ASYMPTOTIC_GAUSSIAN_HAC_PVALUE' and r['resampling_draws']==0,'honest tail identity')
        need(set(r['components'])==set(LOSSES),'exact two losses')
        for loss in LOSSES:
            v=r['components'][loss];m=finite(v['mean_U']);se=finite(v['se']);need(se>0,'component se')
            z=m/se;p=normal_cdf(z)
            need(v['z']==z and v['p']==p and v['reject']is rejection(m,p),'component arithmetic binding')
            cells[year+':'+loss]={'mean_U':m,'p':p,'reject':rejection(m,p)}
    return {'scope':SCOPE,'alpha':ALPHA,'components':cells,'joint_reject':all(v['reject'] for v in cells.values()),
            'decision_type':'FOUR_COMPONENT_INTERSECTION_NOT_SELECTABLE_WINS',
            'source_synthetic_component':True,'empirical_admission_status':'NOT_ADMITTED',
            'finite_sample_validity_established':False,'power_established':False}
