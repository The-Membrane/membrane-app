"""Original EWMA-FHS reference replay on complete accepted full277 J; no fits."""
import hashlib
import json
import os
from pathlib import Path
import sys
import types
import numpy as np

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FULL277_EWMA_REFERENCE'
EPS=1e-6
CAP=64*1024**2
FIXED_BARRIERS=np.array([-.40,-.20,-.10,-.05,-.02],np.float64)

def need(ok,message):
    if not ok:raise ValueError(message)

def losses(p,y):
    p=np.asarray(p,np.float64);y=np.asarray(y,np.float64);c=np.clip(p,EPS,1-EPS)
    return dict(brier=(p-y)**2,logloss=-y*np.log(c)-(1-y)*np.log1p(-c))

def compare(p,available,y,known,reference):
    """Matched known scores and all-J completion bounds; y couples both losses."""
    p=np.asarray(p,np.float64);r=np.asarray(reference,np.float64);y=np.asarray(y)
    need(p.ndim==1 and p.shape==r.shape==y.shape==available.shape==known.shape and available.dtype==known.dtype==bool,'score shapes')
    need(np.isfinite(r).all() and np.all((r>=0)&(r<=1)) and np.isfinite(p[available]).all() and np.all((p[available]>=0)&(p[available]<=1)) and np.isin(y[known],[0,1]).all(),'score domain')
    at=available&known;n=len(p);result=dict(J_n=n,available_n=int(available.sum()),known_n=int(known.sum()),common_known_n=int(at.sum()),losses={})
    # Unknown y and missing p are completed jointly per row. Endpoint evaluations
    # preserve the original clipped log/log1p binary64 operation for EACH y.
    for name in ('brier','logloss'):
        lower=np.full(n,np.inf);upper=np.full(n,-np.inf)
        for outcome in (0,1):
            allowed=(~known)|(y==outcome);ref=losses(r,outcome)[name]
            endpoint0=losses(np.zeros(n),outcome)[name];endpoint1=losses(np.ones(n),outcome)[name]
            actual=losses(np.where(available,p,0.),outcome)[name]
            lo=np.where(available,actual,np.minimum(endpoint0,endpoint1))-ref
            hi=np.where(available,actual,np.maximum(endpoint0,endpoint1))-ref
            lower[allowed]=np.minimum(lower[allowed],lo[allowed]);upper[allowed]=np.maximum(upper[allowed],hi[allowed])
        own=losses(p[at],y[at])[name];baseline=losses(r[at],y[at])[name]
        result['losses'][name]=dict(common_f_mean=None if not at.any() else float(own.mean()),
            common_reference_mean=None if not at.any() else float(baseline.mean()),
            common_delta_sum=float(np.sum(own-baseline)),common_delta_mean=None if not at.any() else float(np.mean(own-baseline)),
            all_J_delta_lower_sum=float(lower.sum()),all_J_delta_upper_sum=float(upper.sum()),
            all_J_delta_lower_mean=None if not n else float(lower.sum()/n),all_J_delta_upper_mean=None if not n else float(upper.sum()/n))
    return result

def report(arrays,cases):
    names=('sid','ts','f_probability','available','y','known','A','C','fallback')
    a={k:np.concatenate([v[k] for v in arrays]) for k in names}
    keys=list(zip(a['sid'].tolist(),a['ts'].tolist()));need(len(keys)==len(set(keys)),'unique complete J')
    index={key:i for i,key in enumerate(keys)};views={}
    for name,at in [('pooled',np.ones(len(keys),bool)),('2024',a['ts']<1735689600),('2025',a['ts']>=1735689600)]:
        views[name]={r:compare(a['f_probability'][at,2],a['available'][at],a['y'][at],a['known'][at],a[r][at]) for r in ('A','C')}
    secondary={};need(len({(c['sid'],c['ts']) for c in cases})==len(cases),'unique fixed cases')
    for kind in ('C_zero','C_high'):
        for year,lo,hi in [(2024,1704067200,1735689600),(2025,1735689600,1767225600)]:
            cc=[c for c in cases if c['kind']==kind and lo<=c['ts']<hi]
            need(all((c['sid'],c['ts'])in index for c in cc),'all fixed cases on original J')
            at=np.array([index[(c['sid'],c['ts'])] for c in cc],np.int64)
            secondary[kind+':'+str(year)]={r:compare(a['f_probability'][at,2],a['available'][at],a['y'][at],a['known'][at],a[r][at]) for r in ('A','C')}
    common_pass=all(views[y][r]['common_known_n']>0 and all(views[y][r]['losses'][k]['common_delta_mean']<0 for k in ('brier','logloss')) for y in ('2024','2025') for r in ('A','C'))
    robust_pass=all(views[y][r]['J_n']>0 and all(views[y][r]['losses'][k]['all_J_delta_upper_mean']<0 for k in ('brier','logloss')) for y in ('2024','2025') for r in ('A','C'))
    return dict(common_support_primary_pass=common_pass,all_J_robust_improvement_pass=robust_pass,schema='q26-full277-ewma-reference-report-v1',label='CODEX CONTINUATION',complete=True,target='H24_MINUS10_INDEX2',
                J_n=len(keys),availability_n=int(a['available'].sum()),known_n=int(a['known'].sum()),views=views,
                secondary_fixed_cases=secondary,completion_bounds='Descriptive all-J missing-prediction/unknown-label completions; not confidence intervals',
                forecast_promotion_status='NOT_ADMITTED',unseen_validation=False)

def replay(M3,M2,ser,saved,onj,*,barriers,status='DRAFT'):
    need(status in(READY,ADMITTED),'DRAFT')
    need(isinstance(barriers,np.ndarray) and barriers.dtype==np.float64 and np.array_equal(barriers,FIXED_BARRIERS),'accepted five target barriers')
    need(onj.dtype==bool and onj.shape==saved['ts'].shape,'J shape')
    ts=saved['ts'][onj];cut=saved['quarter_cutoff'][onj];need(len(set(ts.tolist()))==len(ts),'unique J timestamps')
    if len(ts)==0:return np.empty((0,5),np.float64),np.empty(0,bool),[]
    diagnostics=[];P=M3.Prep3(ser,24,beta_select=False);all_i=np.arange(len(P.lab_ok));out=np.full((len(ts),5),np.nan)
    need(np.all((ts-ser.base_ts)%3600==0),'hourly keys');idx=((ts-ser.base_ts)//3600).astype(np.int64)
    need(np.all((idx>=0)&(idx<len(ser.sigma))),'origin bounds')
    for qa in sorted(set(cut.tolist())):
        at=cut==qa;need((qa-ser.base_ts)%3600==0,'quarter grid');tr=all_i+24<=(qa-ser.base_ts)//3600
        with np.errstate(divide='ignore',invalid='ignore',over='ignore'):
            query=np.log1p(barriers)[None,:]/(ser.sigma[idx[at],None]*P.scale)
        library=P.z[1.0][P.valid[1.0]&tr]
        diagnostics.append(dict(quarter_cutoff=int(qa),J_n=int(at.sum()),library_N=len(library),nonfinite_library_Z_n=int(np.sum(~np.isfinite(library))),nonfinite_query_rows=int(np.sum(~np.isfinite(query).all(axis=1)))))
        out[at]=M2.fhs_predict(library,query)
    available=np.all(np.isfinite(out)&(out>=0)&(out<=1),axis=1)
    need(np.all(np.diff(out[available],axis=1)>=0),'EWMA probability monotonicity')
    fallback=saved['fH_fallback'][onj]
    need(np.all(available[fallback]) and np.array_equal(out[fallback],saved['p_fH'][onj][fallback]),'exact original fallback parity')
    return out,available,diagnostics

def run(path,sha,*,status='DRAFT'):
    need(status==ADMITTED,'DRAFT: no inputs')
    b=Path(path).read_bytes();need(len(b)<=65536 and hashlib.sha256(b).hexdigest()==sha,'external request')
    q=json.loads(b);need(q['schema']=='q26-full277-ewma-reference-request-v1' and q['status']==ADMITTED,'admission')
    p=q['pins']['fixed_c_run'];raw=Path(p['path']).read_bytes();need(len(raw)==p['size'] and hashlib.sha256(raw).hexdigest()==p['sha256'],'accepted transport')
    R=types.ModuleType('_ewma_transport');R.__file__=p['path'];exec(compile(raw,p['path'],'exec'),vars(R))
    need(R.pin(Path(__file__).resolve())==q['pins']['source'],'current source')
    DG=R.load(q['pins']['diagnostic_source'],'_ewma_diagnostic');S=R.load(q['pins']['support_source'],'_ewma_support')
    accepted=R.read(q['pins']['parent_acceptance']);diag=R.read(q['pins']['diagnostic'],1024**2)
    need(accepted['public_data']['complete']is True and accepted['public_data']['phase_closed']is True and diag['private_data']['accepted_evidence']['parent_acceptance']==q['pins']['parent_acceptance'],'closed accepted C')
    req=accepted['private_evidence']['request'];oldq,prep,old,C,rawscope,_=R.authenticate(req['path'],req['sha256'],mode='check')
    need(diag['private_data']['accepted_evidence']['manifest']==accepted['private_evidence']['manifest'],'same accepted C manifest')
    manifest=R.read(accepted['private_evidence']['manifest'],8*1024**2);pm=R.read(oldq['pins']['preparation_manifest'],8*1024**2)
    need(manifest['canonical_mapping']==oldq['canonical_mapping'] and len(manifest['series_receipts'])==len(pm['series_receipts'])==277,'canonical277 inventories')
    cases=diag['private_data']['case_inventory'];need(len(cases)==377 and sum(c['kind']=='C_zero' for c in cases)==331 and sum(c['kind']=='C_high' for c in cases)==46,'fixed diagnostic cases')
    sourcepins=S.legacy_sources(R,old);A,science,R12,A6,M2,D,specs,finder=R.P.science_context(prep,old,rawscope)
    root=Path(q['out']);need(root.is_absolute() and str(root.resolve())==str(root) and not root.exists(),'fresh canonical output')
    R.protect_targets([root],oldq['files'],R.protected_roots(oldq,prep,old,rawscope));root.mkdir(mode=0o700)
    used=[];archives=[];pins=[];logical=0;library_records=[]
    try:
        sys.modules['control_check']=C;PC=R.load(oldq['pins']['preparation_check'],'preparation_check')
        M3=R.P.importlib.import_module('a3_touch')
        with science.reference_runner.no_regression(A6.Prep6):
            for sid,key in oldq['canonical_mapping']:
                pr=R.read(pm['series_receipts'][sid],65536);used.extend([pm['series_receipts'][sid],*pr['outputs'].values()])
                _,aa,metadata=PC.authenticated_series(pm['series_receipts'][sid],sid=sid,key=key);onj,_=DG.derive_joint(aa,sid);saved=aa[24]
                expected_sid=saved['sid'][onj];expected_ts=saved['ts'][onj]
                er=R.read(manifest['series_receipts'][sid],65536);need(er['sid']==sid and er['key']==key and er['prepared_receipt']==pm['series_receipts'][sid],'evaluated receipt join')
                used.append(manifest['series_receipts'][sid]);parts=[]
                for ep in er['quarters'][::2]:parts.append(DG.archive(ep,rows=92,cap=65536));used.append(ep)
                pred=DG.join_predictions(expected_sid,expected_ts,parts)
                if len(expected_ts):
                    ser,_,_=R12.load_series(specs[key]);f,available,diagnostics=replay(M3,M2,ser,saved,onj,barriers=science.core.BARRIERS,status=status);del ser
                else:f=np.empty((0,5),np.float64);available=np.empty(0,bool);diagnostics=[]
                library_records.append(dict(sid=sid,quarters=diagnostics))
                out=dict(sid=expected_sid,ts=expected_ts,f_probability=f,available=available,y=saved['y'][onj,2],known=saved['label_valid'][onj],
                         A=pred['A_raw_fH'][:,2],C=pred['C_conditional'][:,2],fallback=saved['fH_fallback'][onj])
                logical+=sum(v.nbytes for v in out.values());need(logical<=CAP,'logical archive cap')
                dest=root/('sid-'+str(sid)+'.npz');np.savez_compressed(dest,**out);os.chmod(dest,0o600);pins.append(R.pin(dest))
                with np.load(dest,allow_pickle=False) as z:need(set(z.files)==set(out) and all(z[k].dtype==out[k].dtype and z[k].shape==out[k].shape and z[k].tobytes()==out[k].tobytes() for k in out),'exact numeric persistence')
                archives.append(out);del aa,saved;R12._CHAIN.clear()
                print(json.dumps(dict(completed_sid=sid,J_n=len(expected_ts))),file=sys.stderr,flush=True)
        result=report(archives,cases);need(result['J_n']==186232 and result['known_n']==186231,'full accepted support')
        def write(name,value):
            data=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode();need(len(data)<=1024**2,'metadata cap');fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
            need(json.loads((root/name).read_bytes())==value,'metadata readback');return R.pin(root/name)
        result['nonfinite_original_library_Z_total']=sum(v['nonfinite_library_Z_n'] for r in library_records for v in r['quarters'])
        library_pin=write('library-diagnostics.json',dict(scope='PRIVATE_PER_SID_ORIGINAL_EWMA_LIBRARY',series=library_records))
        rp=write('report.json',result)
        mp=write('manifest.json',dict(schema='q26-full277-ewma-reference-manifest-v1',complete=True,label='CODEX CONTINUATION',request_sha256=sha,archives=pins,report=rp,library_diagnostics=library_pin,J_n=result['J_n'],forecast_promotion_status='NOT_ADMITTED'))
        need(sum(p.stat().st_size for p in root.iterdir())<=CAP,'output cap')
        R.closure(oldq['files'])
        for p in [*used,*sourcepins,*q['pins'].values(),*pins,rp,mp,library_pin]:R.checked(p)
        return dict(schema='q26-full277-ewma-reference-produced-v1',complete=True,manifest=mp,report=rp,request_sha256=sha)
    finally:
        if finder in sys.meta_path:sys.meta_path.remove(finder)

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--admitted',action='store_true');a=p.parse_args()
    print(json.dumps(run(a.request,a.request_sha256,status=ADMITTED if a.admitted else 'DRAFT')))
