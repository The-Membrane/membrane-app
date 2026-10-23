"""Same-row baseline-defined risk bins; source qualification, no execution admission."""
import math
from pathlib import Path
import numpy as np
import paired_precision as P

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_A_RISK_BIN_DIAGNOSTIC'
BINS=(0.,.01,.02,.05,.1,.2,.4,.6,.8,1.)

def need(ok,message):
    if not ok:raise ValueError(message)

def summed(values):
    return math.fsum(float(x) for x in values)

def losses(d,mask,global_n):
    n=int(mask.sum());s=[summed(d[mask,j]) for j in range(2)]
    return dict(n=n,sum=s,mean=[x/n for x in s] if n else None,
                global_calendar_contribution=[x/global_n for x in s] if global_n else None)

def cell(mask,A,C,y,known,delta,completed,global_known,global_J):
    km=mask&known;n=int(mask.sum());kn=int(km.sum());events=int(np.sum(y[km]))
    sy=float(events);sa=summed(A[km]);sc=summed(C[km])
    observed=dict(known_n=kn,event_n=events,non_event_n=kn-events,sumY=sy,sumA=sa,sumC=sc,
        meanY_minus_meanA=(sy-sa)/kn if kn else None,meanY_minus_meanC=(sy-sc)/kn if kn else None,
        paired=losses(delta,km,global_known),
        event_paired=losses(delta,km&(y==1),global_known),non_event_paired=losses(delta,km&(y==0),global_known))
    ba=observed['meanY_minus_meanA'];bc=observed['meanY_minus_meanC']
    observed['C_minus_A_signed_bias_change']=bc-ba if kn else None
    observed['C_minus_A_absolute_bias_change']=abs(bc)-abs(ba) if kn else None
    ca=summed(A[mask]);cc=summed(C[mask]);un=n-kn;completion={}
    for label in (0,1):
        cy=sy+label*un
        completion[str(label)]=dict(sumY=cy,meanY_minus_meanA=(cy-ca)/n if n else None,
            meanY_minus_meanC=(cy-cc)/n if n else None,paired=losses(completed[label],mask,global_J))
    return dict(J_n=n,known_n=kn,unknown_n=un,sumA_all_J=ca,sumC_all_J=cc,
                observed=observed,unknown_completions=completion)

def analyze(sid,ts,A,C,y,known,*,status='DRAFT'):
    need(status==READY,'DRAFT: source-only component requires explicit synthetic qualification')
    n=len(ts);need(all(isinstance(x,np.ndarray) for x in (sid,ts,A,C,y,known)),'ndarrays')
    need(sid.dtype==np.int32 and ts.dtype==np.int64 and A.dtype==C.dtype==np.float64 and y.dtype==np.uint8 and known.dtype==bool,'typed rows')
    need(all(x.shape==(n,) for x in (sid,ts,A,C,y,known)) and n<=200000,'aligned bounded rows')
    need(np.isfinite(A).all() and np.isfinite(C).all() and np.all((A>=0)&(A<=1)&(C>=0)&(C<=1)),'finite probabilities')
    need(int(np.sum(~known))<=1,'at most one unknown fixed target')
    need(np.isin(y[known],[0,1]).all() and np.all((sid>=0)&(sid<277)),'labels and SID')
    need(np.all((ts>=1704067200)&(ts<1767225600)&(ts%86400==0)),'daily evaluation clocks')
    need(len(set(zip(sid.tolist(),ts.tolist())))==n,'unique keys')
    ix=np.searchsorted(np.asarray(BINS[1:-1]),A,side='right')
    d=P.delta(C,A,np.where(known,y,0));complete=[P.delta(C,A,np.where(known,y,v)) for v in (0,1)]
    out={}
    for name,g in (('pooled',np.ones(n,bool)),('2024',ts<1735689600),('2025',ts>=1735689600)):
        gn=int(g.sum());gk=int(np.sum(g&known));args=(A,C,y,known,d,complete,gk,gn)
        bins=[cell(g&(ix==i),*args) for i in range(9)]
        total=cell(g,*args)
        need(sum(x['J_n'] for x in bins)==gn and sum(x['known_n'] for x in bins)==gk,'partition counts')
        for j in range(2):
            need(math.isclose(summed(x['observed']['paired']['sum'][j] for x in bins),total['observed']['paired']['sum'][j],rel_tol=0,abs_tol=2e-12),'observed loss partition')
            for label in ('0','1'):
                need(math.isclose(summed(x['unknown_completions'][label]['paired']['sum'][j] for x in bins),total['unknown_completions'][label]['paired']['sum'][j],rel_tol=0,abs_tol=2e-12),'completion partition')
        out[name]=dict(total=total,bins=bins,A_exact_zero_overlapping_control=cell(g&(A==0),*args))
    return dict(schema='q26-A-risk-bin-paired-diagnostic-v1',label='CODEX CONTINUATION',target='H24/-10%',
        membership='A-only, internal edge enters higher bin, p=1 final',bins=list(BINS),views=out,
        loss_order=['brier','bounded_logloss'],negative_paired_favors_C=True,
        source_synthetic_component=True,empirical_admission_status='NOT_ADMITTED',forecast_promotion_status='NOT_ADMITTED',
        limits='Descriptive A-risk strata, not C-conditional calibration, causal effects, CI, regional policy or new acceptance gates.')

def reconcile(report,component,precision=None):
    expected={'pooled','2024','2025'}
    need(set(report['views'])==expected,'exact report calendar inventory')
    calendars=[v for v in component['views'] if v['view_type']=='calendar']
    need(len(calendars)==3 and {v['view'] for v in calendars}==expected,'exact accepted calendar inventory')
    if precision is not None:need(set(precision['views'])==expected,'exact precision calendar inventory')
    old={v['view']:v for v in calendars}
    for name,v in report['views'].items():
        t=v['total'];r=old[name];need(t['J_n']==r['forecast_J_n'] and t['known_n']==r['scored_L24_n'],'accepted J/known counts')
        pair=r['paired']['C_conditional_minus_A_raw_fH']
        for j,loss in enumerate(('brier','bounded_logloss')):
            actual=t['observed']['paired']['mean'];need(actual is not None and abs(actual[j]-pair[loss+'_delta'][2])<=1e-14,'accepted observed losses')
            completed=[t['unknown_completions'][label]['paired']['mean'][j] for label in ('0','1')]
            for bound,value in (('lower',min(completed)),('upper',max(completed))):
                need(abs(value-pair['all_common_issued_bounds'][loss][bound][2])<=1e-14,'accepted completion bounds')
            if precision is not None:
                pr=precision['views'][name];need(pr['known_n']==t['known_n'] and pr['J_n']==t['J_n'] and abs(actual[j]-pr['observed_delta'][j])<=1e-14,'O174 point reconciliation')
    return True

def read_saved_rows(R,DG,accepted,*,status='DRAFT'):
    """Transport must authenticate pinned R/DG/P, runtime, request and admission FIRST.

    This reader creates no outputs; existing R/DG perform pin/header checks.
    Returned used pins must be rechecked by the admitted transport before acceptance.
    """
    need(status==ADMITTED,'DRAFT: no saved payload access')
    need(accepted['public_data']['complete']is True and accepted['public_data']['phase_closed']is True,'closed accepted C')
    qpin=accepted['private_evidence']['request'];q=R.read(qpin,2*1024**2)
    mp=accepted['private_evidence']['manifest'];m=R.read(mp,8*1024**2);pp=q['pins']['preparation_manifest'];prep=R.read(pp,8*1024**2)
    need(m['complete'] is True,'complete accepted C manifest')
    need(prep['schema']=='q26-full277-preparation-manifest-v1' and prep['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and prep['empirical_admission_status']=='ADMITTED_BASELINE_PREPARATION_ONLY' and prep['source_synthetic_component'] is False,'accepted preparation manifest')
    need(m['canonical_mapping']==q['canonical_mapping'] and len(m['series_receipts'])==len(prep['series_receipts'])==277,'canonical277')
    need([x[0] for x in q['canonical_mapping']]==list(range(277)) and len({x[1] for x in q['canonical_mapping']})==277,'exact canonical IDs')
    used=[qpin,mp,pp];parts=[]
    for sid,key in q['canonical_mapping']:
        ep=m['series_receipts'][sid];prp=prep['series_receipts'][sid];er=R.read(ep,65536);pr=R.read(prp,65536);summary=R.read(er['summary'],256*1024)
        need(er['sid']==pr['sid']==sid and er['key']==pr['key']==key and er['prepared_receipt']==prp and er['complete']is True,'receipt identity')
        hp=pr['outputs']['24'];h=DG.archive(hp);used.extend([ep,prp,er['summary'],hp]);ps=[]
        need(len(er['quarters'])==2*len(summary['quarter_records']),'calendar pair inventory')
        for i,record in enumerate(summary['quarter_records']):
            npin,jpin=er['quarters'][2*i:2*i+2];a=DG.archive(npin,rows=92,cap=65536);r=R.read(jpin,65536);used.extend([npin,jpin])
            need(r['sid']==record['sid']==sid and r['quarter_cutoff']==record['quarter_cutoff'] and r['rows']==record['J_n']==len(a['ts']) and r['sha256']==npin['sha256'] and r['size']==npin['size'] and r['file']==Path(npin['path']).name and r['forecasts_only_on_original_J']is True,'quarter binding')
            need(a['on_J'].dtype==a['candidate_prediction_valid'].dtype==bool and a['on_J'].all() and a['candidate_prediction_valid'].all(),'J validity');ps.append(a)
        ss=np.concatenate([a['sid']for a in ps])if ps else np.empty(0,np.int32);tt=np.concatenate([a['ts']for a in ps])if ps else np.empty(0,np.int64);DG.keys(ss,tt)
        need(len(tt)==summary['joint_ledger']['J_n'],'full perSID J');ix={int(t):i for i,t in enumerate(h['ts'])};need(len(ix)==len(h['ts']) and all(int(t)in ix for t in tt),'label key coverage')
        at=np.array([ix[int(t)]for t in tt],np.int64);pred=DG.join_predictions(ss,tt,ps)
        need(np.array_equal(pred['A_raw_fH'],h['p_fH'][at]) and np.all(h['sid'][at]==sid),'allfive A identity')
        parts.append((ss,tt,pred['A_raw_fH'][:,2],pred['C_conditional'][:,2],h['y'][at,2],h['label_valid'][at]))
    rows=tuple(np.concatenate([p[i]for p in parts])for i in range(6));need(len(rows[0])==186232 and rows[-1].sum()==186231,'accepted full J')
    for pin in used:R.checked(pin)
    return rows,used
