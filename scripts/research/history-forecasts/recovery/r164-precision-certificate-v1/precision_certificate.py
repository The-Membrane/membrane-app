"""DRAFT exact-real box certificate. No historical payload is admitted by default."""
import argparse
from fractions import Fraction
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import resource
import shutil
import signal
import sys
import time
import numpy as np
from interval_arithmetic import Interval as I, IntervalError, sample_sd
from endpoint_arithmetic_check import fraction_bounds, reduction_error

ROOT = Path(__file__).resolve().parent
E = ROOT.parent
TARGETS = [('T24_G0',0,0),('T720_G0',12,0),('T720_G0',12,5),('T168_G3',11,0)]
MODES = ['combined','cluster_only','calendar_only']
DOMAINS = ['literal_stored_endpoint_box','conditional_packing_aggregation_box']
POLICY = dict(wall_seconds=120,rss_bytes=1000000000,disk_reserve_bytes=2147483648,output_bytes=10000000)
FIELDS = ['Md','MdLo','MdHi','Mn','SIDs','BIDs']
EXPECTED_DRAWS = {
 'T24_G0':(0,'3b9ba92b844630c6ddf934f59a45056a0718bc19d90eb53e54fa53f2ae825c1a','b1654df8cff4943cf4e2b7985b3f9616e259faf27aaf8a3e106a6e76be514ad3'),
 'T168_G3':(11,'0d5fbc928096e5dffa324025b316028d70432671c3d05a2eacedb9528283d676','1cb46401b652ca7aa86ec3f5a27bc5966c8531f8558b3d2ab9cb6bcc96b8ac7b'),
 'T720_G0':(12,'a14ff7c722888a4a527dd65cdbfe2528b045ffc26f1530f6a0bb7409547a3120','4abdaf75b1e714ba015ecbfdb1f6dc499403e7e67b0d1fca9d8ee2eb1a94499f')}
REQUIRED_SOURCES={'implementation','tests','interval_core','interval_tests','endpoint_helper','endpoint_tests','design','old_implementation','reconstruction_source','math_design','input_audit'}



def need(ok, message):
    if not ok: raise ValueError(message)


def pin(path):
    p=Path(path).resolve();h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def check_pin(p):
    need(pin(p['path'])==p,'changed artifact pin: '+p['path'])


def as_record(x):return {'lo':float(x.lo),'hi':float(x.hi)}


def intersect(a,b):
    lo,hi=np.maximum(a.lo,b.lo),np.minimum(a.hi,b.hi)
    need(np.all(lo<=hi),'contradictory certified intersection')
    return I(lo,hi)


def midpoint(x):
    c=np.minimum(x.hi,np.maximum(x.lo,x.lo/2+x.hi/2))
    need(np.all(np.isfinite(c)),'nonfinite chosen center')
    return c


def nonnegative(x):
    need(np.all(x.hi>=0),'contradictory nonnegative functional')
    return I(np.maximum(x.lo,0),x.hi)


def radius(box, centers):
    d=box-I(centers)
    return I(np.zeros(d.lo.shape),np.maximum(np.abs(d.lo),np.abs(d.hi)))


def certified_sd(box, known_constant=False):
    n=box.lo.size
    if n<2:return None
    if known_constant:return {'intersection':I(0.),'centered':I(0.),'norm_perturbation':I(0.),'known_constant':True}
    centers=midpoint(box);c=float(np.mean(centers))
    centered=sample_sd(box,center=c)
    center_sd=sample_sd(I(centers),center=c)
    delta=nonnegative(radius(box,centers).square().sum()).sqrt()/I(n-1).sqrt()
    norm=I(max(0.,float((center_sd-delta).lo)),float((center_sd+delta).hi))
    return {'intersection':intersect(centered,norm),'centered':centered,'norm_perturbation':norm,'known_constant':False}


def z_domain(mean,sd):
    """Defined-branch extended closure; a zero-crossing does not prove attainability."""
    if sd is None:return {'status':'insufficient_valid_replicates','signed':None,'favorable':None}
    lo,hi=float(sd.lo),float(sd.hi)
    need(0<=lo<=hi,'invalid SD domain')
    if hi==0:return {'status':'zero_SD_undefined_all','signed':None,'favorable':None}
    if lo>0:
        signed=as_record(mean/sd)
        return {'status':'strictly_positive_SD','signed':signed,'favorable':{'lo':-signed['hi'],'hi':-signed['lo']}}
    def partial(m):
        if float(m.lo)>0:return {'lo':float((I(m.lo)/hi).lo),'hi':'+infinity'}
        if float(m.hi)<0:return {'lo':'-infinity','hi':float((I(m.hi)/hi).hi)}
        if float(m.lo)==float(m.hi)==0:return {'lo':0.,'hi':0.}
        return {'lo':'-infinity','hi':'+infinity'}
    signed=partial(mean)
    def negate(v):return '-infinity' if v=='+infinity' else '+infinity' if v=='-infinity' else -v
    return {'status':'positive_branch_only_zero_SD_not_excluded','signed':signed,'favorable':{'lo':negate(signed['hi']),'hi':negate(signed['lo'])},'branch_attainability_not_established':True}


def exact_counts(mn):
    need(mn.dtype==np.dtype('int64') and mn.ndim==2 and np.all(mn>=0),'nonnegative int64 matrix counts required')
    total=sum(int(n) for n in mn.flat)
    need(0<total<2**53,'positive exactly representable count total required')
    return total


def validate_weights(ws,wb,shape):
    S,B=shape
    need(ws.ndim==wb.ndim==2 and ws.shape[0]==wb.shape[0] and ws.shape[1]==S and wb.shape[1]==B,'weight shape mismatch')
    for w,cap in [(ws,S),(wb,B)]:
        need(np.isfinite(w).all() and np.all(w>=0) and np.all(w<=cap) and np.all(w==np.floor(w)),'weights must be bounded exact integers')
    return ws.astype(np.int64),wb.astype(np.int64)


def proportional_point(box,mn):
    if not np.array_equal(box.lo,box.hi):return False,None
    ratios=[]
    for d,n in zip(box.lo.flat,mn.flat):
        if n:ratios.append(Fraction(*float(d).as_integer_ratio())/int(n))
        else:need(d==0,'nonzero empty cell')
    same=all(x==ratios[0] for x in ratios)
    return same,ratios[0] if same else None


def replicate_boxes(box,mn,ws,wb):
    N=exact_counts(mn);ws,wb=validate_weights(ws,wb,mn.shape)
    bound=N*int(ws.max(initial=0))*int(wb.max(initial=0))
    need(bound<min(2**53,2**63),'integer denominator product/sum bound not proved')
    den=np.zeros(ws.shape[0],dtype=np.int64);num=I(np.zeros(ws.shape[0]))
    for s,b in np.ndindex(mn.shape):
        if mn[s,b]==0:continue
        weights=ws[:,s]*wb[:,b]
        den += weights*mn[s,b]
        num = num + I(box.lo[s,b],box.hi[s,b])*weights.astype(np.float64)
    valid=den>0
    means=I(num.lo[valid],num.hi[valid])/den[valid].astype(np.float64)
    known,ratio=proportional_point(box,mn)
    if known:
        lo,hi=fraction_bounds(ratio);means=I(np.full(valid.sum(),lo),np.full(valid.sum(),hi))
    return means,den,known


def cgm_direct(box,mn):
    N=exact_counts(mn);mu=box.sum()/N;u=(box-mu*mn.astype(np.float64))/N
    return u.sum(1).square().sum()+u.sum(0).square().sum()-u.square().sum()


def exact_center_cgm(centers,mn):
    N=exact_counts(mn)
    values=[[Fraction(*float(x).as_integer_ratio()) for x in row] for row in centers]
    mu=sum((x for row in values for x in row),Fraction(0))/N
    u=[[(x-mu*int(mn[s,b]))/N for b,x in enumerate(row)] for s,row in enumerate(values)]
    row=sum((sum(r,Fraction(0))**2 for r in u),Fraction(0))
    col=sum((sum((u[s][b] for s in range(len(u))),Fraction(0))**2 for b in range(len(u[0]))),Fraction(0))
    inter=sum((x*x for r in u for x in r),Fraction(0))
    return row+col-inter


def cgm_certificate(box,mn):
    N=exact_counts(mn);direct=cgm_direct(box,mn);centers=midpoint(box);c=I(centers)
    exact_center=exact_center_cgm(centers,mn);vc=I(*fraction_bounds(exact_center));uc=(c-c.sum()/N*mn.astype(np.float64))/N
    rad=radius(box,centers);rmu=nonnegative(rad.sum()/N)
    e=nonnegative((rad+rmu*mn.astype(np.float64))/N)
    def perturb(x,r):
        absolute=I(np.maximum(np.abs(x.lo),np.abs(x.hi)))
        return (2*absolute*r+r.square()).sum()
    delta=perturb(uc.sum(1),nonnegative(e.sum(1)))+perturb(uc.sum(0),nonnegative(e.sum(0)))+perturb(uc,e)
    perturbed=I(float((vc-I(delta.hi)).lo),float((vc+I(delta.hi)).hi))
    net=intersect(direct,perturbed);mean=box.sum()/N
    if float(net.hi)<=0:domain={'status':'nonpositive_net_no_positive_CGM_SD','signed':None,'favorable':None};sd=None
    else:
        sd=I(max(0.,float(net.lo)),float(net.hi)).sqrt();domain=z_domain(mean,sd)
        if float(net.lo)<=0:domain['status']='positive_branch_only_nonpositive_CGM_not_excluded'
    return {'signed_net':as_record(net),'direct':as_record(direct),'center_perturbation':as_record(perturbed),'center_net':as_record(vc),'center_net_exact_fraction':str(exact_center),'SD_positive_branch':None if sd is None else as_record(sd),'z':domain,'negative_net_never_clipped':True}


def widen(box,mn):
    lo=np.empty(mn.shape);hi=np.empty(mn.shape)
    for index in np.ndindex(mn.shape):
        e=reduction_error(int(mn[index]))
        lo[index]=fraction_bounds(Fraction(*float(box.lo[index]).as_integer_ratio())-e)[0]
        hi[index]=fraction_bounds(Fraction(*float(box.hi[index]).as_integer_ratio())+e)[1]
    return I(lo,hi)


def bootstrap_certificate(box,mn,ws,wb):
    means,den,known=replicate_boxes(box,mn,ws,wb);mean=box.sum()/exact_counts(mn)
    result={'mean':as_record(mean),'requested':len(den),'valid':int((den>0).sum()),'censored_zero_denominator':int((den==0).sum()),'redrawn':0,'denominator_min':int(den.min()) if len(den) else None,'denominator_max':int(den.max()) if len(den) else None}
    sd=certified_sd(means,known)
    result['sample_SD']=None if sd is None else {k:as_record(v) if isinstance(v,I) else v for k,v in sd.items()}
    result['z']=z_domain(mean,None if sd is None else sd['intersection'])
    return result


def validate_draw_identity(group,ordinal,reference,ws,wb):
    need(group in EXPECTED_DRAWS,'unknown fixed draw group')
    expected=EXPECTED_DRAWS[group]
    need(ordinal==expected[0] and reference['common_draw_seed']==[20261641,ordinal],'draw ordinal or seed mismatch')
    need((reference['ws_sha256'],reference['wb_sha256'])==expected[1:],'old empirical draw hash manifest changed')
    need(ws.dtype==wb.dtype==np.dtype('float64') and ws.shape==(2000,127) and wb.shape==(2000,29),'fixed float64 draw geometry mismatch')
    need((hashlib.sha256(ws.tobytes()).hexdigest(),hashlib.sha256(wb.tobytes()).hexdigest())==expected[1:],'regenerated draw bytes mismatch')


def validate_half_geometry(rec,models):
    need(len(rec['series'])==130,'130 original series geometry records required')
    need(all(s['fields']['p_'+m]['dtype']=='<f2' for s in rec['series'] for m in models),'conditional upstream proof requires all main fields half')


def validate_disjoint_bands(bands):
    leaves=[int(k) for band in bands for k in band]
    need(len(leaves)==10 and sorted(leaves)==list(range(10)),'threshold leaves must partition0through9 once each')


def validate_reconstruction_layout(request,rec):
    expected={'shallow -2..-7%':[0,1,2,3], 'mid -10..-20%':[4,5,6], 'deep -25..-40%':[7,8,9]}
    need(request['bands']==expected,'original reconstruction bands mismatch')
    validate_disjoint_bands(list(request['bands'].values()))
    groups={g['key']:g for g in rec['groups']}
    for horizon in [24,72,168,720]:
        for index,label in enumerate(['all']+list(expected)):
            g=groups['T'+str(horizon)+'_G'+str(index)]
            need(g['horizon_hours']==horizon and g['band']==label,'actual matrix target/band mapping mismatch')
    need(request['comparisons']==rec['comparison_order'] and request['models']==rec['model_order'],'reconstruction request comparison/model binding')
    need(request['expected_main_dtype']=='<f2','reconstruction request is not actual half path')


def load_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


def authenticate(request,digest):
    need(pin(request)['sha256']==digest,'request pin mismatch');r=json.loads(Path(request).read_text())
    need(r.get('admission_status')=='parent_accepted','DRAFT refuses before payload authentication')
    need(r['targets']==[list(t) for t in TARGETS] and r['modes']==MODES and r['domains']==DOMAINS and r['policy']==POLICY,'protocol changed')
    need(REQUIRED_SOURCES<=set(r['source_pins']),'new source closure incomplete')
    for p in r['source_pins'].values():check_pin(p)
    need(r['source_pins']['implementation']==pin(__file__),'executing implementation mismatch')
    for p in [r['old_request'],r['old_result'],r['endpoint_proof']]:check_pin(p)
    check_pin(r['runtime_identity_audit']);identity=json.loads(Path(r['runtime_identity_audit']['path']).read_text())
    need(r['runtime_pins']==identity['runtime_native_pins']+[identity['interpreter_pin']],'runtime/native closure incomplete')
    for p in r['runtime_pins']:check_pin(p)
    proof=json.loads(Path(r['endpoint_proof']['path']).read_text())
    need(proof['complete'] and proof['endpoints']['nonnegative_float16_patterns_0_through_1']==15361,'finite endpoint proof absent')
    need(proof['source']==r['source_pins']['endpoint_helper'],'endpoint proof source mismatch')
    need(proof['endpoints'].get('signed_zero_representations_checked')==1,'signed zero proof absent')
    for filename,key in [('interval_arithmetic.py','interval_core'),('test_interval_arithmetic.py','interval_tests'),('endpoint_arithmetic_check.py','endpoint_helper'),('test_endpoint_arithmetic_check.py','endpoint_tests')]:
        need(proof['source_pins'][filename]==r['source_pins'][key],'finite endpoint/core proof source mismatch')
    old=load_module(r['source_pins']['old_implementation']['path'],'accepted_bootstrap')
    prior,rec=old.authenticate(r['old_request']['path'],r['old_request']['sha256'])
    empirical=json.loads(Path(r['old_result']['path']).read_text())
    need(rec['implementation']==r['source_pins']['reconstruction_source'],'reconstruction-source binding mismatch')
    validate_half_geometry(rec,old.MODELS)
    original_request=json.loads(Path(prior['artifacts']['reconstruction_request']['path']).read_text())
    validate_reconstruction_layout(original_request,rec)
    need(empirical['complete'] and empirical['request']==r['old_request'],'old output request binding mismatch')
    need(all(v=='1' for v in r['threads'].values()),'thread map not single-threaded')
    need(r['invocation_python']==sys.executable,'invocation interpreter path mismatch')
    need(r['threads']=={'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'},'required exact thread map')
    need('torch' not in sys.modules and 'scipy' not in sys.modules,'unadmitted numerical package imported')
    import os
    need(all(os.environ.get(k)==v for k,v in r['threads'].items()),'thread runtime mismatch')
    return r,prior,rec,empirical,old


def resources(start,out,observations,stage):
    row={'stage':stage,'elapsed_seconds':time.monotonic()-start,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'free_bytes':shutil.disk_usage(out).free}
    observations.append(row)
    need(row['elapsed_seconds']<=POLICY['wall_seconds'] and row['peak_rss_bytes']<=POLICY['rss_bytes'] and row['free_bytes']>=POLICY['disk_reserve_bytes'],'resource limit exceeded')


def write(path,obj):
    raw=(json.dumps(obj,indent=2,allow_nan=False)+'\n').encode()
    owned=sum(p.stat().st_size for p in path.parent.rglob('*') if p.is_file() and p!=path)
    need(owned+len(raw)<=POLICY['output_bytes'],'owned recursive output cap exceeded');path.write_bytes(raw)


def run(request,digest,out):
    out=Path(out).resolve();need(not out.exists(),'fresh output required');out.mkdir(parents=True);start=time.monotonic();observations=[];stage='admission';result={'complete':False,'schema':'r164-precision-certificate-v1','targets':[]}
    def timeout(signum,frame):raise TimeoutError('fixed120second internal wall alarm')
    previous=signal.signal(signal.SIGALRM,timeout);signal.alarm(POLICY['wall_seconds'])
    try:
        r,prior,rec,empirical,old=authenticate(request,digest)
        need(out==Path(r['intended_output']).resolve(),'declared fresh output path mismatch')
        resources(start,out,observations,stage)
        stage='selected_matrix_members';groups={};selected=sorted(set(t[0] for t in TARGETS))
        with np.load(prior['artifacts']['matrices']['path'],allow_pickle=False) as z:
            need(len(z.files)==96 and set(z.files)=={g+'_'+f for g in old.GROUPS for f in FIELDS},'96-key matrix manifest mismatch')
            for group in selected:groups[group]={f:z[group+'_'+f] for f in FIELDS}
        empirical_groups={g['group']:g for g in empirical['groups']};reconstruction_groups={g['key']:g for g in rec['groups']};draw_cache={}
        for group,ordinal,j in TARGETS:
            stage=group+'_comparison_'+str(j);resources(start,out,observations,stage);d=groups[group];mn=d['Mn'];N=exact_counts(mn);S,B=mn.shape
            need(S==127 and B==29 and reconstruction_groups[group]['rows']==N,'fixed dimensions/count mismatch')
            for f in ['Md','MdLo','MdHi']:
                v=d[f];need(v.dtype==np.dtype('float64') and v.shape==(12,S,B) and np.isfinite(v).all() and np.all(v[:,mn==0]==0),'invalid selected matrix values')
            for f,n in [('SIDs',S),('BIDs',B)]:need(d[f].dtype==np.dtype('int64') and d[f].shape==(n,) and np.all(d[f][1:]>d[f][:-1]),'invalid selected IDs')
            base=I(d['MdLo'][j],d['MdHi'][j])
            if group not in draw_cache:draw_cache[group]=old.draw_weights(S,B,ordinal)
            ws,wb=draw_cache[group]
            reference=empirical_groups[group]
            validate_draw_identity(group,ordinal,reference,ws,wb)
            target={'group':group,'ordinal':ordinal,'comparison_index':j,'total_count':N,'zero_count_cells':int((mn==0).sum()),'weight_hashes':{k:reference[k] for k in ['ws_sha256','wb_sha256']},'domains':{}}
            for name,box in [(DOMAINS[0],base),(DOMAINS[1],widen(base,mn))]:
                domain={'CGM':cgm_certificate(box,mn),'bootstrap':{}}
                for mode in MODES:
                    resources(start,out,observations,stage+'_'+name+'_'+mode)
                    a,b=(ws,wb) if mode=='combined' else (ws,np.ones_like(wb)) if mode=='cluster_only' else (np.ones_like(ws),wb)
                    domain['bootstrap'][mode]=bootstrap_certificate(box,mn,a,b)
                target['domains'][name]=domain
            target['old_empirical_context']=[v for v in reference['records'] if v['comparison_index']==j]
            result['targets'].append(target);write(out/'partial.json',result)
        stage='final_pins'
        for p in r['source_pins'].values():check_pin(p)
        for p in [r['old_request'],r['old_result'],r['endpoint_proof'],r['runtime_identity_audit']]+r['runtime_pins']:check_pin(p)
        for p in prior['artifacts'].values():check_pin(p)
        need(pin(request)['sha256']==digest,'final request changed');resources(start,out,observations,stage)
        result.update(complete=True,request=pin(request),source_pins=r['source_pins'],domains=DOMAINS,meaning=r['meaning'],conditional_upstream_proof=r['conditional_upstream_proof'])
        write(out/'result.json',result);resources(start,out,observations,'serialized')
        return result
    except Exception as e:
        write(out/'failure.json',{'complete':False,'stage':stage,'error_type':type(e).__name__,'error_code':getattr(e,'code','CERTIFICATE_PROOF_OR_RESOURCE_FAILURE'),'error':str(e)[:400],'completed_targets':len(result['targets']),'elapsed_seconds':time.monotonic()-start});raise
    finally:
        signal.alarm(0);signal.signal(signal.SIGALRM,previous)
        write(out/'resource-receipt.json',{'observations':observations,'elapsed_seconds':time.monotonic()-start,'policy':POLICY})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();run(a.request,a.request_sha256,a.out)
