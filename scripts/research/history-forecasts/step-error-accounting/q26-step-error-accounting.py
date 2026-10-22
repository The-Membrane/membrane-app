"""Pure stdlib O12 prediction accounting. No I/O, simulation, fitting or bootstrap.
Caller authenticates archive/source bytes before constructing these objects.
"""
import itertools
import math
from collections import Counter, defaultdict

ARMS=('garch','fH','rec12','base12')
PRIORITY=('fH','rec12','base12','garch','h3')
HORIZONS=(24,72,168,720)
DEPTHS=tuple('k'+str(k) for k in range(10))+('all','mid','deep')
ATTRIBUTION='CODEX CONTINUATION'
SCOPE='Spent-development O12 paired prediction-error accounting; no state recovery or causal mechanism attribution.'
MAX_ROWS=300000
MAX_VIEWS=10000


def need(ok,why):
    if not ok:raise ValueError(why)


def number(x):
    return type(x) in (int,float)


def finite(x):
    if not number(x):return False
    try:return math.isfinite(x)
    except OverflowError:return False


def valid_probability(p):
    return finite(p) and 0<=p<=1


def reason(row,five=False):
    if row['y'] not in (0.,1.):return 'invalid_outcome'
    missing=[a for a in ARMS if row['p_'+a] is None]
    if missing:return 'missing_'+'+'.join(missing)
    if not all(valid_probability(row['p_'+a]) for a in ARMS):return 'invalid_prediction'
    if five:
        if row['p_h3'] is None:return 'missing_h3'
        if not valid_probability(row['p_h3']):return 'invalid_h3'
    return None


def validate(report,step):
    need(type(report) is dict and type(step) is dict,'decoded report objects')
    rows=report['rows'];need(type(rows) is list and len(rows)<=MAX_ROWS,'native row resource/schema')
    cfg=report['config'];old=step['config'];selected=cfg['selected_series'];prior=old['selected_series']
    need(type(selected) is list and 0<len(selected)<=42
         and all(type(x) is str and x for x in selected) and selected==sorted(set(selected)),'selected source identities')
    need(type(prior) is list and all(type(x) is str and x for x in prior)
         and prior==sorted(set(prior)) and set(selected)<=set(prior),'original selected population')
    need(cfg['prior_signature']==step['signature'] and cfg['pin']==old['pin']
         and cfg['paths']==old['paths']==1000 and cfg['origin_every']==old['origin_every']==28,'original derivation metadata')
    need(report['prediction_rows']==len(rows),'native report row count')
    keys=set();clock={};clusters={}
    for r in rows:
        need(type(r) is dict and {'series','cluster','i0','T','k','block182','y',*( 'p_'+a for a in ARMS+('h3',))}<=set(r),'native row schema')
        need(type(r['series']) is str and r['series'] in selected and type(r['cluster']) is str,'native row identity')
        need(all(type(r[k]) is int for k in ('i0','T','k','block182')) and r['i0']>=0
             and r['T'] in HORIZONS and r['k'] in range(10),'native row clock/cell')
        key=(r['series'],r['i0'],r['T'],r['k']);need(key not in keys,'duplicate native row key');keys.add(key)
        origin=(r['series'],r['i0']);need(origin not in clock or clock[origin]==r['block182'],'origin calendar consistency');clock[origin]=r['block182']
        need(r['series'] not in clusters or clusters[r['series']]==r['cluster'],'source cluster consistency');clusters[r['series']]=r['cluster']
        need(r['y'] is None or number(r['y']),'native outcome type')
        need(all(r['p_'+a] is None or number(r['p_'+a]) for a in ARMS+('h3',)),'native prediction type')
    censored=report['inherited_censored_origins'];need(type(censored) is list,'inherited censor ledger')
    for r in censored:
        need(type(r) is dict and type(r.get('i0')) is int and r['i0']>=0
             and type(r.get('stored_rows')) is int and r['stored_rows']>=0
             and r.get('reason') in ('no_fold','no_HAR_prediction'),'inherited censor schema')
    same=selected==prior
    if same:need(step['prediction_rows']==len(rows),'original same-scope native count')
    return rows,selected,censored,same


def metric(rows,arm):
    n=len(rows);events=[r for r in rows if r['y']==1];nonevents=[r for r in rows if r['y']==0]
    p='p_'+arm
    losses=[(r[p]-r['y'])**2 for r in rows]
    el=math.fsum((r[p]-1)**2 for r in events);nl=math.fsum(r[p]**2 for r in nonevents)
    mean=math.fsum(r[p] for r in rows)/n if n else None;freq=len(events)/n if n else None
    return dict(brier=math.fsum(losses)/n if n else None,event_contribution=el/n if n else None,
        non_event_contribution=nl/n if n else None,event_conditional_mean=el/len(events) if events else None,
        non_event_conditional_mean=nl/len(nonevents) if nonevents else None,mean_prediction=mean,
        event_frequency=freq,signed_bias=mean-freq if n else None,
        exact_zero=sum(r[p]==0 for r in rows),exact_one=sum(r[p]==1 for r in rows),
        zero_events=sum(r[p]==0 for r in events),one_non_events=sum(r[p]==1 for r in nonevents))


def view(native,arms,five,scope,H,depth):
    reasons=Counter();common=[]
    for r in native:
        why=reason(r,five)
        if why:reasons[why]+=1
        else:common.append(r)
    n=len(common);pairs={};priority=[a for a in PRIORITY if a in arms]
    for reference,candidate in itertools.combinations(priority,2):
        delta=[((r['p_'+candidate]-r['y'])**2-(r['p_'+reference]-r['y'])**2,r['y']) for r in common]
        pairs[candidate+'_minus_'+reference]=dict(brier=math.fsum(x for x,y in delta)/n if n else None,
            event_contribution=math.fsum(x for x,y in delta if y==1)/n if n else None,
            non_event_contribution=math.fsum(x for x,y in delta if y==0)/n if n else None)
    availability={a:dict(valid=sum(valid_probability(r['p_'+a]) for r in native),
        missing=sum(r['p_'+a] is None for r in native),
        invalid=sum(r['p_'+a] is not None and not valid_probability(r['p_'+a]) for r in native)) for a in arms}
    return dict(scope=scope,horizon=H,depth=depth,native_rows=len(native),common_rows=n,
        excluded_rows=len(native)-n,reason_counts=dict(sorted(reasons.items())),native_availability=availability,
        events=sum(r['y']==1 for r in common),non_events=sum(r['y']==0 for r in common),
        models={a:metric(common,a) for a in arms},pair_deltas=pairs)


def analyze(intraday_report,step_summary):
    rows,selected,censored,same=validate(intraday_report,step_summary)
    aliases={s:'series_%03d'%i for i,s in enumerate(selected)}
    blocks=sorted({r['block182'] for r in rows})
    scopes=['all',*aliases.values(),*('block_'+str(b) for b in blocks)]
    need(len(scopes)*len(HORIZONS)*len(DEPTHS)*2<=MAX_VIEWS,'full view resource cap; no truncation')
    buckets=defaultdict(list)
    for r in rows:
        ds=['k'+str(r['k']),'all']
        if 4<=r['k']<=6:ds.append('mid')
        if 7<=r['k']<=9:ds.append('deep')
        for scope in ('all',aliases[r['series']],'block_'+str(r['block182'])):
            for depth in ds:buckets[(scope,r['T'],depth)].append(r)
    supports=[]
    for five,name in ((False,'four_arm'),(True,'five_arm')):
        arms=ARMS+('h3',) if five else ARMS
        reasons=Counter(reason(r,five) for r in rows);reasons.pop(None,None)
        views=[view(buckets[(scope,H,depth)],arms,five,scope,H,depth)
               for scope in scopes for H in HORIZONS for depth in DEPTHS]
        n=len(rows)-sum(reasons.values())
        if five:
            need(intraday_report['paired_rows']==n and intraday_report['excluded_rows']==len(rows)-n,'five-arm retained support count')
        elif same:need(step_summary['paired_rows']==n,'original four-arm support count')
        supports.append(dict(name=name,arms=list(arms),common_rows=n,excluded_rows=len(rows)-n,
            reason_counts=dict(sorted(reasons.items())),views=views))
    return dict(schema='q26-step-error-accounting-v1',attribution=ATTRIBUTION,scope=SCOPE,
        input_coverage=dict(native_rows=len(rows),selected_series=len(selected),
            inherited_censored_origins=len(censored),inherited_censored_rows=sum(r['stored_rows'] for r in censored),
            censored_reason_counts=dict(sorted(Counter(r['reason'] for r in censored).items())),
            original_four_summary_scope_match=same),logloss_status='not_defined_in_O12',supports=supports,
        interpretation=['Event/non-event contributions use the entire common-row denominator; conditional means use their separately named category denominators.',
            'Overlapping horizon/depth views are descriptive and must not be summed as independent observations.',
            'Anonymous series aliases follow original sorted selected-series order. Calendar blocks are source-qualified native block182 fields.',
            'Inherited censored origins are outside native prediction rows and outside every loss denominator.',
            'Fitted coefficients, origin variance and residual pools are not recovered. No feedback/frozen mechanism, statistical significance, new model or promotion is established.'])
