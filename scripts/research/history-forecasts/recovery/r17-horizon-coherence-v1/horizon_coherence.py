"""DRAFT deterministic horizon projection of pinned O88 predictions; no new fit."""
import argparse
from fractions import Fraction
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import sys
import time
import numpy as np

HORIZONS=(6,12,24,72,168)
ARMS=('raw_fH','A_pooled_Z','B_pooled_W','C_state_Z','hash_B','hash_C')
BARRIERS=np.array([-.4,-.2,-.1,-.05,-.02])
EVAL=1704067200;YEAR25=1735689600;END=1767225600
COHERENCE_TOL=1e-12
EDGES=np.array([0,.01,.02,.05,.1,.2,.4,.6,.8,1.])
POLICY={'wall_seconds':120,'rss_bytes':1000000000,'disk_reserve_bytes':2147483648,'output_bytes':10000000}
REPLAY_SHA='f5cae4471db94e1a5e3b187db1c90192aad70f4fa2758fcb98df95ed6b08c7f1'
DESIGN_SHA='ee0c2bcf972b53625204ff5b31eea803568336b727a7ad4f84384840e3121a54'


def need(ok,message):
    if not ok:raise ValueError(message)


def pin(path):
    p=Path(path).absolute();h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return {'path':str(p),'size':p.stat().st_size,'sha256':h.hexdigest()}


def check(p):
    need(Path(p['path']).is_absolute() and pin(p['path'])==p,'changed admitted pin: '+p['path'])


def loss_budget():
    """Absolute per5-coordinate theorem-gap error bound, fixed before payload.

    Binary64 RN, p,q,y in[0,1], binary labels. Each rounded subtract-square
    error<=4u; each5-term sum error<=5*4u+gamma4*5*(1+4u).
    Two final adds cost<=gamma2*(15+3A). Rounded exact-PAV block means
    alter loss+projection-distance by at most5*(4u+2u^2).
    """
    u=Fraction(1,2**53);g4=4*u/(1-4*u);g2=2*u/(1-2*u)
    a=20*u+g4*5*(1+4*u)
    exact=5*(4*u+2*u*u)+3*a+g2*(15+3*a)
    bound=float(exact)
    if Fraction(*bound.as_integer_ratio())<exact:bound=float(np.nextafter(bound,np.inf))
    return exact,bound


LOSS_BUDGET_EXACT,LOSS_BUDGET=loss_budget()


def pav_vector(p):
    """Equal-weight PAV with exact dyadic block ordering/sums, rounded once/block."""
    p=np.asarray(p,dtype=float)
    need(p.ndim==1 and len(p)>0 and np.all(np.isfinite(p)&(p>=0)&(p<=1)),'invalid PAV probabilities')
    if np.all(p[:-1]<=p[1:]):return p.copy()
    ratios=[float(x).as_integer_ratio() for x in p];den=max(b for a,b in ratios)
    blocks=[]
    for a,b in ratios:
        blocks.append([a*(den//b),1])
        while len(blocks)>1 and blocks[-2][0]*blocks[-1][1]>blocks[-1][0]*blocks[-2][1]:
            z,n=blocks.pop();blocks[-1][0]+=z;blocks[-1][1]+=n
    q=[]
    for z,n in blocks:q.extend([float(Fraction(z,den*n))]*n)
    return np.asarray(q)


def project_lattice(p):
    """p=(arm,origin,H,barrier). Full5H, same equal weights for all barriers."""
    p=np.asarray(p,dtype=float)
    need(p.ndim==4 and p.shape[2:]==(5,5) and np.all(np.isfinite(p)&(p>=0)&(p<=1)),'full finite5x5 lattice required')
    need(np.all(np.diff(p,axis=3)>=-COHERENCE_TOL),'original severity order')
    vectors=p.transpose(0,1,3,2).reshape(-1,5)
    q=vectors.copy();bad=np.any(np.diff(vectors,axis=1)<0,axis=1)
    for i in np.flatnonzero(bad):q[i]=pav_vector(vectors[i])
    q=q.reshape(p.shape[0],p.shape[1],5,5).transpose(0,1,3,2)
    need(np.all(np.diff(q,axis=2)>=-COHERENCE_TOL),'residual horizon violation')
    need(np.all(np.diff(q,axis=3)>=-COHERENCE_TOL),'projected severity violation')
    return q


def origin_keys(d):
    sid,ts=d['sid'],d['ts']
    need(sid.dtype==np.dtype('int32') and ts.dtype==np.dtype('int64') and sid.shape==ts.shape and sid.ndim==1,'origin key geometry')
    keys=np.rec.fromarrays([sid,ts],names='sid,ts')
    need(len(np.unique(keys))==len(keys),'duplicate origin IDs')
    return keys


def join_five(data,pred):
    """J uses issuance, availability and predictions only; never reads labels."""
    keys={h:origin_keys(data[h]) for h in HORIZONS};available={};common=None
    for h in HORIZONS:
        d=data[h];p=pred[h]
        need(p.shape==(6,len(keys[h]),5),'six-arm prediction geometry')
        good=np.all(np.isfinite(p)&(p>=0)&(p<=1),axis=(0,2))
        available[h]=d['issue_eligible']&d['p_fH_valid']&good&(d['ts']>=EVAL)&(d['ts']<END)
        k=keys[h][available[h]];common=np.sort(k) if common is None else np.intersect1d(common,k)
    indices={}
    for h in HORIZONS:
        order=np.argsort(keys[h]);pos=np.searchsorted(keys[h][order],common);indices[h]=order[pos]
        need(np.array_equal(keys[h][indices[h]],common),'five-H exact join failed')
    support={}
    for h in HORIZONS:
        d=data[h];p=pred[h];evaluation=(d['ts']>=EVAL)&(d['ts']<END);issued=d['issue_eligible']&evaluation
        support[str(h)]={'available_n':int(available[h].sum()),'outside_J_available_n':int(available[h].sum()-len(common)),
            'issued_eval_n':int(issued.sum()),'not_issue_eligible_eval_n':int(np.sum(evaluation&~d['issue_eligible'])),
            'baseline_unavailable_eval_n':int(np.sum(issued&~d['p_fH_valid'])),
            'baseline_available_nonfinite_prediction_n':int(np.sum(issued&d['p_fH_valid']&~np.isfinite(p).all(axis=(0,2)))),
            'baseline_available_out_of_range_prediction_n':int(np.sum(issued&d['p_fH_valid']&np.any((p<0)|(p>1),axis=(0,2)))),
            'available_membership_sha256':membership_hash(d,available[h]),
            'other_H_missing_origin_n':{str(k):int(np.sum(~np.isin(keys[h][available[h]],keys[k]))) for k in HORIZONS if k!=h},
            'other_H_present_but_unavailable_n':{str(k):int(np.sum(np.isin(keys[h][available[h]],keys[k])&~np.isin(keys[h][available[h]],keys[k][available[k]]))) for k in HORIZONS if k!=h}}
    return common,indices,support


def label_support(data,indices):
    masks=np.stack([data[h]['label_valid'][indices[h]] for h in HORIZONS],axis=1)
    L=np.all(masks,axis=1)
    y=np.stack([data[h]['y'][indices[h]] for h in HORIZONS],axis=1).astype(float)
    need(np.isin(y[L],[0.,1.]).all(),'nonbinary complete labels')
    need(np.all(np.diff(y[L],axis=1)>=0),'nonnested complete horizon labels')
    need(np.all(np.diff(y[L],axis=2)>=0),'nonnested severity labels')
    # Source prefix windows imply longer completeness includes shorter completeness.
    need(not np.any((~masks[:,:-1])&masks[:,1:]),'long complete window with missing shorter label')
    return L,y,masks


def calibration(y,p):
    y=np.asarray(y,dtype=float);p=np.asarray(p,dtype=float)
    need(y.shape==p.shape and np.isin(y,[0.,1.]).all() and np.all(np.isfinite(p)&(p>=0)&(p<=1)),'calibration support')
    bins=np.minimum(len(EDGES)-2,np.searchsorted(EDGES,p,side='right')-1)
    out=[]
    for k in range(len(EDGES)-1):
        m=bins==k;out.append({'left':float(EDGES[k]),'right':float(EDGES[k+1]),'right_inclusive':k==len(EDGES)-2,
            'n':int(m.sum()),'events':int(y[m].sum()),'sum_probability':float(p[m].sum()),'brier_sum':float(((p[m]-y[m])**2).sum())})
    return out


def compare_exact(actual,expected,path='root'):
    """Replay is the identical function/runtime: require exact cleaned aggregate equality."""
    if isinstance(expected,dict):
        need(isinstance(actual,dict) and actual.keys()==expected.keys(),'replay keys '+path)
        for k in expected:compare_exact(actual[k],expected[k],path+'.'+str(k))
    elif isinstance(expected,list):
        need(isinstance(actual,list) and len(actual)==len(expected),'replay list '+path)
        for k,(a,b) in enumerate(zip(actual,expected)):compare_exact(a,b,path+'.'+str(k))
    else:need(actual==expected,'replay value '+path)


def bounded_logloss(y,p):
    y=np.asarray(y,dtype=float);p=np.asarray(p,dtype=float);pc=np.clip(p,1e-6,1-1e-6)
    return -y*np.log(pc)-(1-y)*np.log1p(-pc)


def membership_hash(d,mask):
    ids=np.column_stack([d['sid'][mask],d['ts'][mask]]).astype('<i8')
    if len(ids):ids=ids[np.lexsort((ids[:,1],ids[:,0]))]
    return hashlib.sha256(ids.tobytes()).hexdigest()


def score_views(d,before,after,cuts,sids,helper,old):
    original=old.summarize_views(d,before,cuts,sids,helper)
    projected=old.summarize_views(d,after,cuts,sids,helper);records=[]
    for a,b,(kind,name,view) in zip(original,projected,helper.views(d,cuts,sids)):
        available=view&d['p_fH_valid'];take=available&d['label_valid'];y=d['y'][take].astype(float)
        deltas={};boundary={};bounds={}
        for j,arm in enumerate(ARMS):
            p,q=before[j,take],after[j,take]
            deltas[arm]={'brier':np.mean((q-y)**2-(p-y)**2,axis=0).tolist() if take.any() else [None]*5,
                'bounded_logloss':np.mean(bounded_logloss(y,q)-bounded_logloss(y,p),axis=0).tolist() if take.any() else [None]*5}
            boundary[arm]={label:{'exact_zero':np.sum(v==0,axis=0).tolist(),'exact_one':np.sum(v==1,axis=0).tolist()} for label,v in [('original',p),('projected',q)]}
            bounds[arm]=old.pair_bounds(d['y'][available],d['label_valid'][available],after[j,available],before[j,available])
        records.append({'original':a,'projected':b,'projected_minus_original':deltas,'probability_boundaries':boundary,
            'all_available_projected_minus_original_Brier_bounds':bounds,
            'new_membership_hashes_not_archived_O88':{'issued':membership_hash(d,view),'scored':membership_hash(d,take)}})
    return records


def projection_diagnostics(before,after):
    out=[]
    for j,arm in enumerate(ARMS):
        p,q=before[j],after[j];delta=q-p;changed=delta!=0
        row={'arm':arm,'J_origins':len(p),'changed_origin_barrier_vectors':np.sum(np.any(changed,axis=1),axis=0).tolist(),
            'changed_H_barrier_cells':np.sum(changed,axis=0).tolist(),
            'max_absolute_correction_by_barrier':np.max(np.abs(delta),axis=(0,1)).tolist() if len(p) else [None]*5,
            'adjacent_H_ties_original':np.sum(np.diff(p,axis=1)==0,axis=(0,1)).tolist(),
            'adjacent_H_ties_projected':np.sum(np.diff(q,axis=1)==0,axis=(0,1)).tolist(),'pairs':[]}
        for i,h in enumerate(HORIZONS):
            for k in range(i+1,5):
                a=p[:,i]-p[:,k];b=q[:,i]-q[:,k]
                need(not np.any(b>COHERENCE_TOL),'projected cross-H reversal')
                row['pairs'].append({'short_h':h,'long_h':HORIZONS[k],'common_J_origins':len(p),
                    'violations_original':np.sum(a>COHERENCE_TOL,axis=0).tolist(),'violations_projected':np.sum(b>COHERENCE_TOL,axis=0).tolist(),
                    'max_positive_original':np.maximum(0,a.max(0)).tolist() if len(p) else [None]*5,
                    'max_positive_projected':np.maximum(0,b.max(0)).tolist() if len(p) else [None]*5})
        out.append(row)
    return out


def theorem_report(keys,L,y,p,q,sids):
    # Only complete5H vectors and horizon-independent calendar/asset subsets.
    before=((p[:,L]-y[L])**2).sum(axis=2);after=((q[:,L]-y[L])**2).sum(axis=2)
    distance=((p[:,L]-q[:,L])**2).sum(axis=2);gap=after-before+distance
    need(np.all(gap<=LOSS_BUDGET),'summed-H projection theorem arithmetic violation')
    takekeys=keys[L];subsets=[('pooled',np.ones(L.sum(),bool)),('2024',takekeys['ts']<YEAR25),('2025',takekeys['ts']>=YEAR25)]
    subsets += [('asset:'+str(s),takekeys['sid']==s) for s in sids];out=[]
    for name,mask in subsets:
        n=int(mask.sum());u=Fraction(1,2**53);gamma=Fraction(max(n-1,0))*u/(1-max(n-1,0)*u)
        exact=n*LOSS_BUDGET_EXACT+gamma*15*n;budget=float(exact)
        if Fraction(*budget.as_integer_ratio())<exact:budget=float(np.nextafter(budget,np.inf))
        for j,arm in enumerate(ARMS):
            summed=gap[j,mask].sum(0)
            need(np.all(summed<=budget),'aggregate summed-H theorem arithmetic violation')
            out.append({'view':name,'arm':arm,'complete_L_n':n,'summed_H_original_Brier_sum':before[j,mask].sum(0).tolist(),
                'summed_H_projected_Brier_sum':after[j,mask].sum(0).tolist(),'projection_distance_sum':distance[j,mask].sum(0).tolist(),
                'theorem_gap_sum':summed.tolist(),'aggregate_gap_upper_arithmetic_budget':budget,
                'worst_positive_origin_gap':np.maximum(0,gap[j,mask].max(0)).tolist() if n else [None]*5,
                'per_H_original_Brier_mean':np.mean((p[j,L][mask]-y[L][mask])**2,axis=0).tolist() if n else [[None]*5 for _ in HORIZONS],
                'per_H_projected_Brier_mean':np.mean((q[j,L][mask]-y[L][mask])**2,axis=0).tolist() if n else [[None]*5 for _ in HORIZONS]})
    return {'per_origin_gap_upper_arithmetic_budget':LOSS_BUDGET,'exact_rational_budget':str(LOSS_BUDGET_EXACT),'records':out,
        'target':'Equal-weight five-H squared-error sum on identical complete nested vectors, not individual-H or logloss guarantee.'}


def build_projection(data,pred,cuts,sids,helper,old):
    keys,indices,support=join_five(data,pred);L,y,masks=label_support(data,indices)
    for h in HORIZONS:
        d=data[h];take=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']>=EVAL)&(d['ts']<END)
        support[str(h)]['original_scored_membership_sha256']=membership_hash(d,take)
    p=np.stack([pred[h][:,indices[h],:] for h in HORIZONS],axis=2)
    q=project_lattice(p);after={h:pred[h].copy() for h in HORIZONS}
    for i,h in enumerate(HORIZONS):after[h][:,indices[h],:]=q[:,:,i,:]
    rows={str(h):score_views(data[h],pred[h],after[h],cuts[str(h)],sids,helper,old) for h in HORIZONS}
    primary=[];d=data[24]
    for year,ym in [('pooled',np.ones(len(d['ts']),bool)),('2024',d['ts']<YEAR25),('2025',d['ts']>=YEAR25)]:
        take=d['issue_eligible']&d['p_fH_valid']&d['label_valid']&(d['ts']>=EVAL)&(d['ts']<END)&ym
        for j,arm in enumerate(ARMS):
            primary.append({'year':year,'arm':arm,'n':int(take.sum()),'original':calibration(d['y'][take,2],pred[24][j,take,2]),'projected':calibration(d['y'][take,2],after[24][j,take,2])})
    retained={h:{'sid':data[h]['sid'],'ts':data[h]['ts'],'pred':after[h],
        'available':data[h]['issue_eligible']&data[h]['p_fH_valid']&(data[h]['ts']>=EVAL)&(data[h]['ts']<END)} for h in HORIZONS}
    joined={'sid':keys['sid'],'ts':keys['ts']}
    return {'J_origins':len(keys),'L_origins':int(L.sum()),
        'J_membership_sha256':membership_hash(joined,np.ones(len(keys),bool)),
        'L_membership_sha256':membership_hash(joined,L),'J_missing_label_counts_by_H':np.sum(~masks,axis=0).tolist(),
        'outside_J_forecasts_unchanged':True,'support':support,'horizons':rows,'primary_calibration':primary,
        'projection_diagnostics':projection_diagnostics(p,q),'L_theorem':theorem_report(keys,L,y,p,q,sids),
        'projected_all_available_cross_H':old.cross_horizon(retained)}


def load_module(p,name):
    sp=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);return m


def authenticate(request,digest):
    need(pin(request)['sha256']==digest,'request changed');r=json.loads(Path(request).read_text())
    need(r.get('admission_status')=='parent_accepted','DRAFT refuses before payload authentication')
    need(r['policy']==POLICY and r['horizons']==list(HORIZONS) and r['arms']==list(ARMS) and r['barriers']==BARRIERS.tolist(),'protocol mismatch')
    need({'implementation','tests','design','replay','owner_design'}<=set(r['source_pins']),'new source/test/design closure incomplete')
    for p in r['source_pins'].values():check(p)
    need(r['source_pins']['implementation']==pin(__file__),'executing source identity')
    for key in ['original_request','original_result','original_outer','original_review','runtime_identity_audit']:check(r[key])
    need(r['source_pins']['replay']['sha256']==REPLAY_SHA,'original O88 predictor identity')
    need(r['source_pins']['owner_design']['sha256']==DESIGN_SHA,'parent-reviewed design identity')
    identity=json.loads(Path(r['runtime_identity_audit']['path']).read_text())
    need(r['runtime_pins']==identity['runtime_native_pins']+[identity['interpreter_pin']],'exact native closure required')
    for p in r['runtime_pins']:check(p)
    need(r['invocation_python']==sys.executable and r['resolved_python']==str(Path(sys.executable).resolve()) and r['python_prefix']==sys.prefix,'interpreter invocation/resolution/prefix')
    need(r['threads']=={'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'} and all(os.environ.get(k)==v for k,v in r['threads'].items()),'thread runtime')
    original=json.loads(Path(r['original_request']['path']).read_text());reference=json.loads(Path(r['original_result']['path']).read_text())
    outer=json.loads(Path(r['original_outer']['path']).read_text());review=json.loads(Path(r['original_review']['path']).read_text())
    need(original['status']=='PARENT_FROZEN_COMPARISON' and original['source_pin']==r['source_pins']['replay'],'actual admitted O88 request binding')
    need(outer['returncode']==0 and outer['execution_complete'] and not outer['changed_pin_paths'] and outer['expected_pins']==outer['post_pins'],'original outer terminal/pin closure')
    need(r['original_request'] in outer['expected_pins'] and outer['result_pin']==r['original_result'],'outer request/result binding')
    need(review['accepted'] and review['request_pin']==r['original_request'] and review['result_pin']==r['original_result'],'original independent acceptance binding')
    need(reference['complete'] and reference['source_pin']==original['source_pin'] and reference['cuts_pin']==original['cuts_pin'] and reference['base_request_pin']==original['base_request_pin'],'original result source/base/cut binding')
    old=load_module(r['source_pins']['replay']['path'],'immutable_O88_predictor');base,cuts,helper=old.admission(original)
    need('torch' not in sys.modules and 'scipy' not in sys.modules,'unadmitted numerical module')
    return r,original,reference,old,base,cuts,helper


def clean(x):
    if isinstance(x,float) and not np.isfinite(x):return None
    if isinstance(x,dict):return {k:clean(v) for k,v in x.items()}
    if isinstance(x,list):return [clean(v) for v in x]
    return x


def write(path,obj):
    raw=(json.dumps(clean(obj),separators=(',',':'),allow_nan=False)+'\n').encode()
    other=sum(p.stat().st_size for p in path.parent.rglob('*') if p.is_file() and p!=path)
    need(other+len(raw)<=POLICY['output_bytes'],'recursive owned output cap');path.write_bytes(raw)


def run(request,digest,out):
    out=Path(out).absolute();need(not out.exists(),'fresh output directory required');out.mkdir(parents=True)
    started=time.monotonic();stage='admission';obs=[];partial={'complete':False,'reconciled_horizons':[]}
    def observe(enforce=True):
        row={'stage':stage,'elapsed_seconds':time.monotonic()-started,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024),'free_bytes':shutil.disk_usage(out).free};obs.append(row)
        if enforce:need(row['elapsed_seconds']<=120 and row['peak_rss_bytes']<=1000000000 and row['free_bytes']>=2147483648,'resource limit')
    def timeout(*_):raise TimeoutError('fixed120second internal wall')
    previous=signal.signal(signal.SIGALRM,timeout);signal.alarm(120)
    try:
        r,original,reference,old,base,cuts,helper=authenticate(request,digest)
        need(out==Path(r['intended_output']).absolute(),'declared output path');observe()
        data={};pred={};retained={};fold_count=0
        for h in HORIZONS:
            stage='replay-H'+str(h);observe()
            with np.load(base['inputs'][str(h)]['path'],allow_pickle=False) as z:d={k:z[k] for k in old.MEMBERS}
            helper.metadata(d,base['sids']);valid=d['label_valid']
            need(np.array_equal(np.isfinite(d['future_log_min']),valid) and np.array_equal(d['y'][valid],(d['future_log_min'][valid,None]<=np.log1p(BARRIERS)).astype(np.uint8)),'complete label contract')
            expected=np.all(np.isfinite(d['p_fH'])&(d['p_fH']>=0)&(d['p_fH']<=1),axis=1)
            need(np.array_equal(expected,d['p_fH_valid']),'baseline availability')
            hc=cuts['horizons'][str(h)];p,state,folds,nf=old.make_predictions(d,h,hc['downside_imbalance_D']['cut'],observe,return_support=True)
            rows=old.summarize_views(d,p,hc,base['sids'],helper);saved=reference['horizons'][str(h)]
            compare_exact(clean(rows),saved['point_views']);compare_exact(clean(folds),saved['folds'])
            compare_exact(clean(old.nonfallback_views(d,p,nf)),saved['main_nonfallback_point_sensitivity'])
            need(len(rows)==54,'all54 original views required');fold_count+=len(folds)
            data[h]=d;pred[h]=p;retained[h]={'sid':d['sid'],'ts':d['ts'],'pred':p,'available':d['issue_eligible']&d['p_fH_valid']&(d['ts']>=EVAL)&(d['ts']<END)}
            partial['reconciled_horizons'].append(h);write(out/'partial.json',partial)
        stage='reconcile-all-cross-H';cross=old.cross_horizon(retained);compare_exact(clean(cross),reference['cross_horizon'])
        need(fold_count==sum(len(v['folds']) for v in reference['horizons'].values()) and len(cross)==60,'original replay closure')
        stage='project-and-score';observe();report=build_projection(data,pred,cuts['horizons'],base['sids'],helper,old);observe()
        stage='final-identity';authenticate(request,digest);observe()
        result={'schema':'r17-horizon-coherence-v1','complete':True,'request':pin(request),'source_pins':r['source_pins'],
            'original_request':r['original_request'],'original_result':r['original_result'],'replay':{'original_views':270,'folds':fold_count,'cross_H_records':60,'all_cleaned_original_aggregates_exact':True},
            'projection':report,'interpretation':r['interpretation']}
        write(out/'result.pending.json',result);observe();(out/'result.pending.json').replace(out/'result.json');(out/'partial.json').unlink();observe()
        return result
    except BaseException as ex:
        write(out/'failure.json',{'complete':False,'stage':stage,'error_class':type(ex).__name__,'error_code':'HORIZON_REPLAY_PROJECTION_HOLD','error':str(ex)[:300],'elapsed_seconds':time.monotonic()-started});raise
    finally:
        signal.alarm(0);signal.signal(signal.SIGALRM,previous);observe(False);write(out/'resource-receipt.json',{'observations':obs,'policy':POLICY})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();run(a.request,a.sha256,a.out)
