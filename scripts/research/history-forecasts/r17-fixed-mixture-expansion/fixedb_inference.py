"""Source-only Bartlett fixed-b critical-value comparison; no empirical admission.

Kiefer & Vogelsang, A New Asymptotic Theory for Heteroskedasticity-
Autocorrelation Robust Tests, CAE05-08, January2005: printedp11 permits
interpolation with b=M/T and left-tail symmetry; TableI printedp24 gives
95% right quantiles .06:1.772,.08:1.813 (50,000 simulated draws, not exact).
Linear interpolation is our frozen permitted convention, not a paper-mandated
formula. Original Bartlett weight1-k/(L+1) means M=L+1, NOT L.
This fixed-calendar comparison changes only critical values; no covariance,
lag, ratio, model, or data changes. Fixed-b asymptotics are not finite-T exact
and application assumptions/joint U realizability/power remain unqualified.
"""
import hashlib,math,types
from pathlib import Path
CORE_SHA='15dd196cff71cf3c47104f73bf3e53e61e458c6843ea8b8b298db4ff6dfc9906'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
TABLE=((.06,1.772),(.08,1.813))

def need(ok,msg):
    if not ok:raise ValueError(msg)

def load_core(path):
    p=Path(path);b=p.read_bytes();need(hashlib.sha256(b).hexdigest()==CORE_SHA,'HAC source pin')
    m=types.ModuleType('qualified_hac');exec(compile(b,str(p),'exec'),m.__dict__);return m

def interpolate(b):
    need(type(b)in(int,float) and math.isfinite(b),'finite b')
    (lo,a),(hi,c)=TABLE;need(lo<=b<=hi,'only registered table bracket')
    return a+(b-lo)/(hi-lo)*(c-a)

def critical_value(T,L=28):
    need(type(T)is int and T in (365,366),'registered full calendar lengths')
    need(type(L)is int and L==28,'registered unchanged bandwidth')
    M=L+1;b=M/T
    return {'T':T,'L':L,'M':M,'b':b,'critical_right_95':interpolate(b),
            'critical_rounding_sensitivity':[interpolate(b)-.0005,interpolate(b)+.0005],
            'rounding_scope':'DIAGNOSTIC_ONLY_PRIMARY_REMAINS_PUBLISHED_ROUNDED_LINEAR_POINT',
            'alpha':.05,'tail':'LEFT','rule':'t<=-critical_right_95',
            'interpolation':'FROZEN_LINEAR_BETWEEN_PUBLISHED_POINTS',
            'asymptotic_not_finite_exact':True}

def compare(mean,t,critical):
    need(type(mean)in(int,float) and math.isfinite(mean),'finite mean')
    need(type(t)in(int,float) and math.isfinite(t),'finite t')
    need(type(critical)in(int,float) and math.isfinite(critical) and critical>0,'critical domain')
    return mean<0 and t<=-critical

def evaluate(core,counts,sums,*,status='DRAFT'):
    need(status==READY,'DRAFT source qualification only')
    c=critical_value(len(counts));r=core.ratio_hac(counts,sums)
    need(r['bandwidth']==c['L'],'unchanged HAC lag')
    out={}
    for loss in core.LOSSES:
        v=r['components'][loss]
        out[loss]={'mean_U':v['mean_U'],'se':v['se'],'t':v['z'],
                   'reject':compare(v['mean_U'],v['z'],c['critical_right_95'])}
    return {'critical':c,'components':out,'scope':'FIXED_B_SOURCE_QUALIFICATION_ONLY',
            'empirical_admission':'NOT_ADMITTED','finite_size_validity_established':False,
            'actual_U_law_qualified':False,'power_established':False}

def iut4(years):
    need(type(years)is dict and set(years)=={'2024','2025'},'exact years')
    values=[]
    for year,T in (('2024',366),('2025',365)):
        r=years[year];need(r['scope']=='FIXED_B_SOURCE_QUALIFICATION_ONLY' and r['empirical_admission']=='NOT_ADMITTED','scope')
        need(r['critical']==critical_value(T),'critical binding')
        need(set(r['components'])=={'brier','bounded_logloss'},'two losses')
        for v in r['components'].values():
            need(type(v['se'])in(int,float) and math.isfinite(v['se']) and v['se']>0,'positive marginal SE')
            need(v['t']==v['mean_U']/v['se'],'ratio t binding')
            reject=compare(v['mean_U'],v['t'],r['critical']['critical_right_95'])
            need(v['reject']is reject,'decision binding');values.append(reject)
    return {'joint_reject':all(values),'component_count':4,'scope':'SOURCE_QUALIFICATION_ONLY',
            'independence_required':False,'union_null_size_qualified':False,'empirical_admission':'NOT_ADMITTED'}
