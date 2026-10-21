"""Independent targeted exact-rational certificate audit; no subject imports.

No payload access at import. Execution requires separately reviewed explicit pins.
Two fixed realizations per domain are checked, not a proof over the whole box.
"""
import argparse
from fractions import Fraction as F
import hashlib
import json
import math
from pathlib import Path
import resource
import shutil
import signal
import time
import numpy as np

TARGETS=[('T24_G0',0,0),('T720_G0',12,0),('T720_G0',12,5),('T168_G3',11,0)]
MODES=['combined','cluster_only','calendar_only']
DOMAINS=['literal_stored_endpoint_box','conditional_packing_aggregation_box']
MATRIX_SHA='21a0e7e3c4bb9feb36719c81820e3ce9aa6bb74bea1bfebc6a189da67d022523'
DRIVER_SHA='9405bfd5fd493ce8cf9645bb9955a833e15e40d0bf11b99fa3ef8ca155dc4619'
COUNTS={'T24_G0':585420,'T720_G0':578190,'T168_G3':175719}
FIELDS=['Md','MdLo','MdHi','Mn','SIDs','BIDs']
BITS=256
SCALE=1<<BITS

def need(ok,msg):
    if not ok: raise AssertionError(msg)

def pin(p):
    p=Path(p).resolve();h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())

def checked(p):
    actual=pin(p['path'])
    need(actual['size']==p['size'] and actual['sha256']==p['sha256'],'artifact bytes mismatch at declared path');return Path(p['path'])

def frac(v):return F.from_float(float(v))

def contains(record,x):
    need(frac(record['lo'])<=x<=frac(record['hi']),'rational realization outside certificate')

def outward(q,upper):
    x=float(q)
    if (frac(x)<q if upper else frac(x)>q):x=math.nextafter(x,math.inf if upper else -math.inf)
    return frac(x)

def box_arrays(lo,hi,mn,widened):
    a=[];b=[]
    for l,h,n in zip(lo.flat,hi.flat,mn.flat):
        l,h=frac(l),frac(h)
        if widened:
            n=int(n);e=F(n*(n-1),2**53-n+1) if n>1 else F(0)
            l,h=outward(l-e,False),outward(h+e,True)
        need(l<=h,'invalid box');a.append(l);b.append(h)
    return a,b

def integer_realization(lo,hi,shape,kind):
    vals=[(l+h)/2 if kind=='midpoint' else (l if ((i//shape[1]+i%shape[1])%2==0) else h) for i,(l,h) in enumerate(zip(lo,hi))]
    q=max(x.denominator.bit_length()-1 for x in vals)
    need(all(x.denominator&(x.denominator-1)==0 for x in vals),'non-dyadic point')
    return np.array([x.numerator*((1<<q)//x.denominator) for x in vals],dtype=object).reshape(shape),q

def exact_cgm(k,q,mn):
    n=sum(map(int,mn.flat));total=sum(map(int,k.flat));u=n*k-total*mn.astype(object)
    rs=u.sum(axis=1);cs=u.sum(axis=0)
    num=sum(int(x)**2 for x in rs)+sum(int(x)**2 for x in cs)-sum(int(x)**2 for x in u.flat)
    return F(num,(1<<(2*q))*n**4)

def square_range(l,h):
    return (0 if l<=0<=h else min(l*l,h*h)),max(l*l,h*h)

def variance_bracket(nums,dens,q):
    pairs=[]
    for v,d in zip(nums,dens):
        if d:
            a=int(v)*SCALE;b=int(d)*(1<<q)
            pairs.append((a//b,-((-a)//b)))
    r=len(pairs)
    if r<2:return None,r
    # Exact proportional realizations retain exactly zero variance.
    first=None;constant=True
    for v,d in zip(nums,dens):
        if d:
            z=F(int(v),int(d)*(1<<q))
            if first is None:first=z
            elif z!=first:constant=False;break
    if constant:return (F(0),F(0)),r
    sumlo=sum(x[0] for x in pairs);sumhi=sum(x[1] for x in pairs)
    squares=[square_range(*x) for x in pairs];sl,sh=square_range(sumlo,sumhi)
    den=r*(r-1)*SCALE*SCALE
    return (max(F(0),F(r*sum(x[0] for x in squares)-sh,den)),F(r*sum(x[1] for x in squares)-sl,den)),r

def sqrt_bracket(vlo,vhi):
    need(0<=vlo<=vhi,'invalid variance bracket')
    a=math.isqrt((vlo.numerator<<(2*BITS))//vlo.denominator)
    b=math.isqrt((vhi.numerator<<(2*BITS))//vhi.denominator)
    if F(b*b,1<<(2*BITS))<vhi:b+=1
    return F(a,SCALE),F(b,SCALE)

def endpoint(v):
    if v=='+infinity':return math.inf
    if v=='-infinity':return -math.inf
    return frac(v)

def ratio_check(record,mu,variance):
    vl,vh=variance
    if vh==0:
        need(record['signed'] is None or record['status'].startswith('positive_branch'),'zero variance status');return
    need(vl>0,'oracle needs finer fixed precision; no false clearance')
    s0,s1=sqrt_bracket(vl,vh)
    need(s0>0,'oracle sqrt too small')
    quotients=[mu/s0,mu/s1];l,h=min(quotients),max(quotients)
    signed=record['signed'];need(signed is not None,'missing defined z')
    need(endpoint(signed['lo'])<=l and h<=endpoint(signed['hi']),'z rational enclosure failed')
    fav=record['favorable'];need(endpoint(fav['lo'])<=-h and -l<=endpoint(fav['hi']),'favorable sign enclosure failed')

def sd_check(rec,variance):
    vl,vh=variance
    for key in ['intersection','centered','norm_perturbation']:
        x=rec[key];l,h=frac(x['lo']),frac(x['hi'])
        need(0<=l<=h and l*l<=vl and h*h>=vh,'SD rational squared enclosure failed')

def exact_denominators(mn,ws,wb,mode):
    a=ws if mode!='calendar_only' else np.ones_like(ws)
    b=wb if mode!='cluster_only' else np.ones_like(wb)
    need(sum(map(int,mn.flat))*int(a.max())*int(b.max())<2**53,'denominator exactness bound')
    return ((a@mn)*b).sum(axis=1)

def numerators(k,ws,wb,mode):
    if mode=='combined':return ((ws.astype(object)@k)*wb.astype(object)).sum(axis=1)
    if mode=='cluster_only':return ws.astype(object)@k.sum(axis=1)
    return wb.astype(object)@k.sum(axis=0)

def resource_check(start,out):
    need(time.monotonic()-start<=120,'audit wall limit')
    need(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss<=1_000_000_000,'audit RSS limit')
    need(shutil.disk_usage(out.parent).free>=2147483648,'audit disk reserve')

def execute(args):
    start=time.monotonic();out=Path(args.out).resolve();need(not out.exists(),'fresh audit output required')
    def alarm(*_):raise TimeoutError('120 second audit alarm')
    signal.signal(signal.SIGALRM,alarm);signal.alarm(120)
    request=pin(args.request);resultpin=pin(args.result);receiptpin=pin(args.receipt)
    need(request['sha256']==args.request_sha256 and resultpin['sha256']==args.result_sha256 and receiptpin['sha256']==args.receipt_sha256,'explicit admission pin mismatch')
    r=json.loads(Path(args.request).read_text());result=json.loads(Path(args.result).read_text());receipt=json.loads(Path(args.receipt).read_text())
    need(r['admission_status']=='parent_accepted' and result['complete'] and result['request']==request,'accepted output/request binding')
    need(r['targets']==[list(t) for t in TARGETS] and r['modes']==MODES and r['domains']==DOMAINS,'frozen protocol mismatch')
    need(result['source_pins']==r['source_pins'] and r['source_pins']['implementation']['sha256']==DRIVER_SHA,'source identity')
    pins=[request,resultpin,receiptpin]+list(r['source_pins'].values())+r['runtime_pins']+[r['old_request'],r['old_result'],r['endpoint_proof'],r['runtime_identity_audit']]
    for p in pins:checked(p)
    old=json.loads(checked(r['old_request']).read_text());art=old['artifacts'];matrix=art['matrices']
    need(matrix['sha256']==MATRIX_SHA and matrix['size']==5248072,'fixed matrix identity')
    for p in art.values():checked(p)
    observations=receipt['observations'];need(receipt['policy']==r['policy'] and observations and receipt['elapsed_seconds']<=120,'resource receipt')
    for v in observations:need(v['elapsed_seconds']<=120 and v['peak_rss_bytes']<=1e9 and v['free_bytes']>=2147483648,'subject resource observation')
    need(len(result['targets'])==4,'all targets retained')
    checks=[];draws={};loaded={};expectedgroups=['T'+str(h)+'_G'+str(g) for h in [24,72,168,720] for g in range(4)]
    with np.load(checked(matrix),allow_pickle=False) as z:
        need(set(z.files)=={g+'_'+f for g in expectedgroups for f in FIELDS},'exact 96 members')
        for g in sorted({t[0] for t in TARGETS}):loaded[g]={f:z[g+'_'+f] for f in FIELDS}
    for target,(g,ordinal,j) in zip(result['targets'],TARGETS):
        resource_check(start,out);d=loaded[g];mn=d['Mn'];n=sum(map(int,mn.flat))
        need(mn.dtype==np.dtype('int64') and mn.shape==(127,29) and np.all(mn>=0) and n==COUNTS[g],'counts closure')
        for f in ['Md','MdLo','MdHi']:need(d[f].dtype==np.dtype('float64') and d[f].shape==(12,127,29) and np.isfinite(d[f]).all() and np.all(d[f][:,mn==0]==0),'matrix schema')
        for f,size in [('SIDs',127),('BIDs',29)]:need(d[f].dtype==np.dtype('int64') and d[f].shape==(size,) and np.all(np.diff(d[f])>0),'ID schema')
        need((target['group'],target['ordinal'],target['comparison_index'])==(g,ordinal,j) and target['total_count']==n and target['zero_count_cells']==int((mn==0).sum()),'target identity')
        if g not in draws:
            rng=np.random.default_rng(np.random.SeedSequence([20261641,ordinal]));ws=rng.multinomial(127,np.full(127,1/127),size=2000).astype(np.float64);wb=rng.multinomial(29,np.full(29,1/29),size=2000).astype(np.float64)
            draws[g]=(ws.astype(np.int64),wb.astype(np.int64),hashlib.sha256(ws.tobytes()).hexdigest(),hashlib.sha256(wb.tobytes()).hexdigest())
        ws,wb,wh,bh=draws[g];need(target['weight_hashes']=={'ws_sha256':wh,'wb_sha256':bh},'fresh deterministic draw hashes')
        need(set(target['domains'])==set(DOMAINS),'all domains retained')
        for domain in DOMAINS:
            lo,hi=box_arrays(d['MdLo'][j],d['MdHi'][j],mn,domain==DOMAINS[1]);rec=target['domains'][domain];need(set(rec['bootstrap'])==set(MODES),'all modes retained')
            # Independently verify the exact center-CGM scalar, using the declared finite float center.
            centers=[frac(min(float(h),max(float(l),float(l)/2+float(h)/2))) for l,h in zip(lo,hi)]
            ck,cq=integer_realization(centers,centers,mn.shape,'midpoint');cv=exact_cgm(ck,cq,mn)
            need(F(rec['CGM']['center_net_exact_fraction'])==cv,'exact center CGM scalar');contains(rec['CGM']['center_net'],cv)
            for kind in ['midpoint','checkerboard_endpoints']:
                k,q=integer_realization(lo,hi,mn.shape,kind);mu=F(sum(map(int,k.flat)),(1<<q)*n);v=exact_cgm(k,q,mn);cgm=rec['CGM']
                for field in ['signed_net','direct','center_perturbation']:contains(cgm[field],v)
                need(cgm['negative_net_never_clipped'] is True,'CGM interpretation flag')
                if v>0:ratio_check(cgm['z'],mu,(v,v))
                elif cgm['SD_positive_branch'] is None:need(cgm['z']['signed'] is None,'nonpositive CGM undefined ratio')
                for mode in MODES:
                    den=exact_denominators(mn,ws,wb,mode);num=numerators(k,ws,wb,mode);var,valid=variance_bracket(num,den,q);b=rec['bootstrap'][mode]
                    need((b['requested'],b['valid'],b['censored_zero_denominator'],b['redrawn'],b['denominator_min'],b['denominator_max'])==(2000,valid,2000-valid,0,int(den.min()),int(den.max())),'denominator/censor identities')
                    contains(b['mean'],mu);need(var is not None,'fixed count support');sd_check(b['sample_SD'],var);ratio_check(b['z'],mu,var)
                    checks.append({'group':g,'comparison':j,'domain':domain,'realization':kind,'mode':mode,'valid':valid})
                resource_check(start,out)
    for p in pins+list(art.values()):checked(p)
    report={'complete':True,'scope':'Independent exact-rational targeted-realization audit, NOT full-box proof or packing/native proof','checks':checks,'count_mean_records':8,'count_SD_z_records':24,'count_CGM_records':8,'realizations_per_domain':2,'realizations':['exact rational midpoint','checkerboard lo/hi by SID-index+block-index parity'],'variance_oracle':'256-bit outward integer grid, exact rational variance bounds','request':request,'result':resultpin,'resource_receipt':receiptpin,'matrix':matrix,'source':pin(__file__),'elapsed_seconds':time.monotonic()-start,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    resource_check(start,out);raw=(json.dumps(report,indent=2,allow_nan=False)+'\n').encode();need(len(raw)<=10_000_000,'output cap');out.write_bytes(raw);signal.alarm(0)
    return report

def selfcheck():
    # unequal counts, observed mean != mean of replicates, one censored draw
    k=np.array([[-1,3]],dtype=object);mn=np.array([[1,3]],dtype=np.int64);ws=np.array([[1],[1],[1],[0]],dtype=np.int64);wb=np.array([[1,0],[0,1],[1,1],[0,0]],dtype=np.int64)
    num=numerators(k,ws,wb,'combined');den=exact_denominators(mn,ws,wb,'combined');v,count=variance_bracket(num,den,0)
    need(count==3 and v[0]<=F(13,12)<=v[1],'exact variance fixture');need(F(sum(k.flat),int(mn.sum()))==F(1,2),'observed mean fixture')
    sd=sqrt_bracket(*v);need(sd[0]**2<=v[0] and sd[1]**2>=v[1],'sqrt fixture')
    for a,b in [(F(1,4),F(0)),(F(0),F(1,4)),(F(1,4),F(1,4))]:
        vals=[F(1,8)+a*x+b*y for x,y in [(1,1),(1,-1),(-1,-1),(-1,1)]];q=3;kk=np.array([int(x*(1<<q)) for x in vals],dtype=object).reshape(2,2)
        need(exact_cgm(kk,q,np.ones((2,2),dtype=np.int64))==(a*a-b*b)/4,'signed CGM fixture')
    print('synthetic selfcheck PASS; no payload opened')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--selfcheck',action='store_true');p.add_argument('--request');p.add_argument('--request-sha256');p.add_argument('--result');p.add_argument('--result-sha256');p.add_argument('--receipt');p.add_argument('--receipt-sha256');p.add_argument('--out');a=p.parse_args()
    if a.selfcheck:selfcheck()
    else:
        need(all([a.request,a.request_sha256,a.result,a.result_sha256,a.receipt,a.receipt_sha256,a.out]),'explicit reviewed CLI pins required');execute(a)
