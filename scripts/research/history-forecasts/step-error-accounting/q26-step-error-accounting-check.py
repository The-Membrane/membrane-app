"""Independent decoded-record accounting; no I/O, fitting or original bootstrap.
Published native support/mapping remains source-qualified, not reconstructed raw.
Numerical comparisons use explicit 1e-12 absolute/relative policy, not inference.
"""
import math
from collections import Counter

HORIZONS=(24,72,168,720)
MODELS=('garch','fH','rec12','base12','h3')
BASE=MODELS[:4]


def need(ok,msg):
    if not ok:raise ValueError(msg)


def finite_probability(p):
    if type(p) not in (float,int):return False
    try:return math.isfinite(p) and 0<=p<=1
    except (OverflowError,ValueError):return False


def selected(rows,names):
    chosen=[];reasons=Counter()
    for row in rows:
        y=row.get('y')
        if type(y) not in (float,int) or y not in (0.,1.):reasons['invalid_outcome']+=1;continue
        missing=[m for m in names if row.get('p_'+m) is None]
        if missing:reasons['missing_'+'+'.join(missing)]+=1;continue
        if any(not finite_probability(row['p_'+m]) for m in names):reasons['invalid_prediction']+=1;continue
        chosen.append(row)
    return chosen,dict(reasons)


def metrics(rows,names):
    n=len(rows);events=sum(int(r['y']) for r in rows);nonevents=n-events
    result={}
    if not n:return dict(n_rows=0,events=0,non_events=0,models={m:None for m in names})
    for m in names:
        ps=[r['p_'+m] for r in rows]
        ev=math.fsum((1-r['p_'+m])**2 for r in rows if r['y']==1)
        ne=math.fsum(r['p_'+m]**2 for r in rows if r['y']==0)
        result[m]=dict(Brier=(ev+ne)/n,event_loss_contribution=ev/n,non_event_loss_contribution=ne/n,
            event_mean_loss=ev/events if events else None,non_event_mean_loss=ne/nonevents if nonevents else None,
            mean_probability=math.fsum(ps)/n,R=math.fsum(ps)/events if events else None,
            p0_count=sum(p==0 for p in ps),p1_count=sum(p==1 for p in ps),
            wrong_p0_events=sum(r['y']==1 and r['p_'+m]==0 for r in rows),
            wrong_p1_non_events=sum(r['y']==0 and r['p_'+m]==1 for r in rows))
    base=result['fH']['Brier']
    for m in names:result[m]['BSS_vs_fH']=1-result[m]['Brier']/base if base else None
    return dict(n_rows=n,events=events,non_events=nonevents,models=result)


def equal(actual,expected,path='root'):
    if expected is None:need(actual is None,path+' None');return
    if type(expected) is dict:
        need(type(actual) is dict and set(actual)==set(expected),path+' fields')
        for k in expected:equal(actual[k],expected[k],path+'/'+str(k))
    elif type(expected) is list:
        need(type(actual) is list and len(actual)==len(expected),path+' list')
        for i,(a,b) in enumerate(zip(actual,expected)):equal(a,b,path+'/'+str(i))
    elif type(expected) is float:
        need(type(actual) in (float,int) and math.isfinite(actual) and math.isclose(actual,expected,rel_tol=1e-12,abs_tol=1e-12),path+' numeric')
    else:need(type(actual) is type(expected) and actual==expected,path+' exact')


def historical_summary(rows,summary,*,h3=False):
    """Independently reconcile non-bootstrap published summary fields only."""
    names=('h3','fH','rec12','base12') if h3 else BASE
    chosen,reasons=selected(rows,names)
    equal(summary['paired_rows'],len(chosen),'historical paired count')
    equal(summary['censored_pairs'],len(rows)-len(chosen),'historical excluded count')
    equal(summary['censor_reasons'],reasons,'historical censor reasons')
    expected=[]
    for H in HORIZONS:
        for band,ks in (('all',range(10)),('mid',range(4,7)),('deep',range(7,10))):
            cohort=[r for r in chosen if r['T']==H and r['k'] in ks]
            if not cohort:continue
            stats=metrics(cohort,names)
            expected.append((H,band,cohort,stats))
    need(len(summary['summaries'])==len(expected),'historical horizon/band completeness')
    for saved,(H,band,cohort,stats) in zip(summary['summaries'],expected):
        need(saved['horizon']==H and saved['band']==band and saved['primary'] is (H in (72,168)),'historical summary order/primary')
        for k,v in dict(n_rows=len(cohort),n_origins=len({(r['series'],r['i0']) for r in cohort}),n_series=len({r['series'] for r in cohort}),n_clusters=len({r['cluster'] for r in cohort}),n_blocks=len({r['block182'] for r in cohort})).items():need(type(saved[k]) is int and saved[k]==v,'historical '+k)
        equal(saved['base_rate'],stats['events']/len(cohort),'historical base rate')
        equal(saved['bss_denominator_stored_fH'],stats['models']['fH']['Brier'],'historical denominator')
        need(set(saved['models'])==set(names),'historical model set')
        need(set(saved['paired_vs_fH'])==set(names),'historical paired model set')
        for m in names:
            for k in ('Brier','BSS_vs_fH','R'):equal(saved['models'][m][k],stats['models'][m][k],'historical model/'+m+'/'+k)
            # Paired numpy mean and difference of independently accumulated means
            # agree within the declared fixed comparison policy.
            equal(saved['paired_vs_fH'][m]['delta'],stats['models'][m]['Brier']-stats['models']['fH']['Brier'],'historical paired/'+m)
    return dict(rows=len(chosen),summary_cells=len(expected))

PRIORITY=('fH','rec12','base12','garch','h3')


def choose(rows,five):
    good=[];reason={}
    for i,r in enumerate(rows):
        base,why=selected([r],BASE)
        if not base:reason[i]=next(iter(why));continue
        if five:
            if r.get('p_h3') is None:reason[i]='missing_h3';continue
            if not finite_probability(r['p_h3']):reason[i]='invalid_h3';continue
        good.append(i)
    return set(good),reason


def value_view(rows,indices,good,reasons,arms):
    cohort=[rows[i] for i in indices if i in good];n=len(cohort)
    eventn=sum(r['y']==1 for r in cohort);non=n-eventn;models={}
    for m in arms:
        event_loss=math.fsum((1-r['p_'+m])**2 for r in cohort if r['y']==1)
        non_loss=math.fsum(r['p_'+m]**2 for r in cohort if r['y']==0)
        mean=math.fsum(r['p_'+m] for r in cohort)/n if n else None
        models[m]=dict(brier=(event_loss+non_loss)/n if n else None,
            event_contribution=event_loss/n if n else None,non_event_contribution=non_loss/n if n else None,
            event_conditional_mean=event_loss/eventn if eventn else None,
            non_event_conditional_mean=non_loss/non if non else None,mean_prediction=mean,
            event_frequency=eventn/n if n else None,signed_bias=mean-eventn/n if n else None,
            exact_zero=sum(r['p_'+m]==0 for r in cohort),exact_one=sum(r['p_'+m]==1 for r in cohort),
            zero_events=sum(r['y']==1 and r['p_'+m]==0 for r in cohort),
            one_non_events=sum(r['y']==0 and r['p_'+m]==1 for r in cohort))
    pair={}
    priority=[m for m in PRIORITY if m in arms]
    for j,m in enumerate(priority):
        for ref in priority[:j]:
            # Direct per-row differences are independent of subtracting the
            # producer's arm-level accumulated components.
            event_delta=math.fsum((1-r['p_'+m])**2-(1-r['p_'+ref])**2 for r in cohort if r['y']==1)
            non_delta=math.fsum(r['p_'+m]**2-r['p_'+ref]**2 for r in cohort if r['y']==0)
            pair[m+'_minus_'+ref]=dict(brier=(event_delta+non_delta)/n if n else None,
                event_contribution=event_delta/n if n else None,non_event_contribution=non_delta/n if n else None)
    availability={m:dict(valid=sum(finite_probability(rows[i]['p_'+m]) for i in indices),
        missing=sum(rows[i]['p_'+m] is None for i in indices),
        invalid=sum(rows[i]['p_'+m] is not None and not finite_probability(rows[i]['p_'+m]) for i in indices)) for m in arms}
    return dict(native_rows=len(indices),common_rows=n,excluded_rows=len(indices)-n,native_availability=availability,
        reason_counts=dict(Counter(reasons[i] for i in indices if i not in good)),events=eventn,non_events=non,
        models=models,pair_deltas=pair)


def check(I,S,public):
    """Pure independent saved-value check; caller authenticates bytes beforehand.
    I is original intraday JSON, S original step summary. No file reads occur.
    """
    rows=I['rows'];need(type(rows) is list,'native rows list')
    names=I['config']['selected_series'];need(type(names) is list and names==sorted(set(names)) and all(type(x) is str for x in names),'selected series catalogue')
    keys=set();origin_blocks={};clusters={}
    for r in rows:
        need(type(r) is dict and {'series','cluster','i0','T','k','block182','y',*(('p_'+m) for m in MODELS)}<=set(r),'native row schema')
        need(type(r['series']) is str and r['series'] in names and type(r['cluster']) is str,'native identity')
        need(all(type(r[k]) is int for k in ('i0','T','k','block182')) and r['i0']>=0 and r['T'] in HORIZONS and 0<=r['k']<10,'native clocks/cell')
        key=(r['series'],r['i0'],r['T'],r['k']);need(key not in keys,'duplicate native row');keys.add(key)
        origin=(r['series'],r['i0'])
        need(origin not in origin_blocks or origin_blocks[origin]==r['block182'],'source origin/block consistency');origin_blocks[origin]=r['block182']
        need(r['series'] not in clusters or clusters[r['series']]==r['cluster'],'source series/cluster consistency');clusters[r['series']]=r['cluster']
        need(r['y'] is None or type(r['y']) in (int,float),'native outcome type')
        for m in MODELS:need(r['p_'+m] is None or type(r['p_'+m]) in (int,float),'native probability type')
    equal(I['prediction_rows'],len(rows),'intraday native row count')
    need(I['config']['prior_signature']==S['signature'] and set(names)<=set(S['config']['selected_series']),'source-qualified original-row linkage')
    need(I['config']['pin']==S['config']['pin'] and I['config']['paths']==S['config']['paths']==1000 and I['config']['origin_every']==S['config']['origin_every']==28,'original producer configuration')
    four_scope_match=S['config']['selected_series']==names
    if four_scope_match:equal(S['prediction_rows'],len(rows),'same-scope original native row count')
    good4,why4=choose(rows,False);good5,why5=choose(rows,True)
    checked_four=historical_summary(rows,S) if four_scope_match else None
    five=[r for i,r in enumerate(rows) if i in good5]
    checked_garch=historical_summary(five,I['garch']);checked_h3=historical_summary(five,I['h3'],h3=True)
    equal(I['paired_rows'],len(five),'intraday five-common count');equal(I['excluded_rows'],len(rows)-len(five),'intraday five-excluded count')
    inherited=I['inherited_censored_origins'];need(type(inherited) is list,'inherited censor list')
    for v in inherited:need(type(v) is dict and type(v.get('i0')) is int and type(v.get('reason')) is str and type(v.get('stored_rows')) is int and v['stored_rows']>=0 and v['i0']>=0 and v['reason'] in ('no_fold','no_HAR_prediction'),'inherited censor schema')
    omitted=sum(r['stored_rows'] for r in inherited)
    if four_scope_match:need(S['censored_origin_rows']==omitted and S['total_censored_pairs_including_origins']==omitted+len(rows)-len(good4),'original inherited exclusion totals')
    expected_coverage=dict(native_rows=len(rows),selected_series=len(names),inherited_censored_origins=len(inherited),
        inherited_censored_rows=omitted,censored_reason_counts=dict(Counter(r['reason'] for r in inherited)),original_four_summary_scope_match=four_scope_match)
    equal(public['input_coverage'],expected_coverage,'coverage')
    need(set(public)=={'schema','attribution','scope','input_coverage','logloss_status','supports','interpretation'},'public root fields')
    need(public['schema']=='q26-step-error-accounting-v1' and public['logloss_status']=='not_defined_in_O12','fixed accounting schema/no LL')
    need(public['attribution']=='CODEX CONTINUATION' and public['scope']=='Spent-development O12 paired prediction-error accounting; no state recovery or causal mechanism attribution.','fixed attribution/scope')
    equal(public['interpretation'],[
        'Event/non-event contributions use the entire common-row denominator; conditional means use their separately named category denominators.',
        'Overlapping horizon/depth views are descriptive and must not be summed as independent observations.',
        'Anonymous series aliases follow original sorted selected-series order. Calendar blocks are source-qualified native block182 fields.',
        'Inherited censored origins are outside native prediction rows and outside every loss denominator.',
        'Fitted coefficients, origin variance and residual pools are not recovered. No feedback/frozen mechanism, statistical significance, new model or promotion is established.'],'interpretation')
    scopes=[('all',list(range(len(rows))))]
    scopes += [(f'series_{i:03d}',[j for j,r in enumerate(rows) if r['series']==s]) for i,s in enumerate(names)]
    scopes += [(f'block_{b}',[j for j,r in enumerate(rows) if r['block182']==b]) for b in sorted({r['block182'] for r in rows})]
    need(len(public['supports'])==2,'both common-support inventories')
    for support_name,arms,good,why,saved in zip(('four_arm','five_arm'),(BASE,MODELS),(good4,good5),(why4,why5),public['supports']):
        need(saved['name']==support_name and saved['arms']==list(arms),'fixed support/arm order')
        need(saved['common_rows']==len(good) and saved['excluded_rows']==len(rows)-len(good) and saved['reason_counts']==dict(Counter(why.values())),'whole-support count/reason accounting')
        expected_views=[]
        for scope,indices in scopes:
            for H in HORIZONS:
                for depth,ks in [(f'k{k}',(k,)) for k in range(10)]+[('all',range(10)),('mid',range(4,7)),('deep',range(7,10))]:
                    idx=[i for i in indices if rows[i]['T']==H and rows[i]['k'] in ks]
                    v=value_view(rows,idx,good,why,arms);v.update(scope=scope,horizon=H,depth=depth);expected_views.append(v)
        equal(saved['views'],expected_views,'all-complete-accounting-views/'+support_name)
    return dict(schema='q26-step-error-accounting-independent-proof-v1',accepted=True,
        native_rows=len(rows),four_common_rows=len(good4),five_common_rows=len(good5),
        views_per_support=len(public['supports'][0]['views']),historical_band_summaries_checked=(checked_four['summary_cells'] if checked_four else 0)+checked_garch['summary_cells']+checked_h3['summary_cells'],
        numerical_policy='absolute/relative1e-12 for independently accumulated floats; exact counts/schema; not inference.',
        raw_reconstruction=False,source_qualified_row_mapping=True,no_logloss=True)
