"""Independent saved O81 coherence verifier: no saved_repair/PAV import."""
import argparse
import ast
from fractions import Fraction as F
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import zipfile
import numpy as np

HS=(6,12,24,72,168)
BS=(-.4,-.2,-.1,-.05,-.02)
ARMS=('baseline_raw','linear_projected','xgb_base_projected','xgb_shape_projected')
ALL=('baseline_raw','baseline_clipped_control','linear_raw','linear_projected','xgb_base_raw','xgb_base_projected','xgb_shape_raw','xgb_shape_projected')
KEYS=('sid','ts','y','label_valid')
EPS=1e-6
METRIC_FLOATS={'sum_probability','brier','baseline_raw_brier','bss','bounded_logloss','observed_over_expected','expected_over_observed','known_sum_d','mean_d_lower','mean_d_upper','mean_prediction','observed_frequency','signed_error'}
PAIRED_DELTA_CONTRACT=('Brier and sum_probability use exact binary64 dyadic differences; displayed values round exact totals once. Bounded log loss uses paired binary64 logs and fsum with compatibility-only comparison; no exact tiny log-loss direction claim.')
CLAIM='Seen-data descriptive repair only; no inference, model selection, blind authority or per-horizon guarantee.'

def need(ok,why):
    if not ok: raise ValueError(why)

def fr(q):return [str(q.numerator),str(q.denominator)]

def compare(actual,expected,path='report'):
    if isinstance(expected,dict):
        need(type(actual)is dict and set(actual)==set(expected),path+' exact keys')
        for k in expected:compare(actual[k],expected[k],path+'.'+str(k))
    elif isinstance(expected,list):
        need(type(actual)is list and len(actual)==len(expected),path+' exact list')
        for i,(a,b) in enumerate(zip(actual,expected)):compare(a,b,path+f'[{i}]')
    elif type(expected)is float:
        need(type(actual)is float and math.isfinite(actual),'finite binary64 report scalar')
        if path.rsplit('.',1)[-1] in METRIC_FLOATS and not ('candidate_minus_own_source' in path and path.rsplit('.',1)[-1] in ('brier','sum_probability')):
            need(math.isclose(actual,expected,rel_tol=2e-11,abs_tol=2e-12),path+' original metric compatibility')
        else:need(actual.hex()==expected.hex(),path+' exact structural scalar')
    else:need(type(actual)is type(expected) and actual==expected,path+' exact value')

def validate(data,sids):
    need(type(data)is dict and set(data)==set(KEYS+ALL),'archive keys')
    n=len(data['sid']);need(0<n<=200000,'row bound')
    for k,dt,shape in [('sid','<i4',(n,)),('ts','<i8',(n,)),('y','u1',(n,5)),('label_valid','bool',(n,))]+[(k,'<f8',(n,5)) for k in ALL]:
        a=data[k];need(type(a)is np.ndarray and a.dtype==np.dtype(dt) and a.shape==shape,'typed shape '+k)
    keys=[(int(s),int(t)) for s,t in zip(data['sid'],data['ts'])]
    need(len(set(keys))==n,'duplicate row key')
    need(all(s in sids and 1704067200<=t<1767225600 and t%86400==0 for s,t in keys),'canonical daily issuance')
    for k in ALL:
        p=data[k];need(np.isfinite(p).all() and ((p>=0)&(p<=1)).all(),'available probability range')
    for k in ARMS:need((data[k][:,1:]>=data[k][:,:-1]).all(),'source barrier order')
    yy=data['y'][data['label_valid']];need(np.isin(yy,(0,1)).all() and (yy[:,1:]>=yy[:,:-1]).all(),'observed labels')
    need(set(map(int,data['sid']))==set(map(int,data['sid'][data['label_valid']]))==set(sids),'original native asset view identity')
    return dict(zip(keys,range(n)))

def points(y,p,b,sid,ts):
    n=len(y)
    if not n:return {'status':'no_scored_rows','n':0}
    yf=y.astype(float);v=p.astype(float);cp=np.clip(v,EPS,1-EPS)
    avg=lambda a:math.fsum(map(float,a))/n
    loss=avg((v-yf)**2);ref=avg((b-yf)**2);ev=int(y.sum());ex=math.fsum(map(float,v))
    return dict(status='scored',n=n,series=len(set(map(int,sid))),utc_epoch_weeks=len({int(t)//604800 for t in ts}),events=ev,sum_probability=ex,brier=loss,baseline_raw_brier=ref,bss=None if ref==0 else 1-loss/ref,bss_status='undefined_zero_baseline_loss' if ref==0 else 'defined',bounded_logloss=avg(-yf*np.log(cp)-(1-yf)*np.log1p(-cp)),logloss_clipped_predictions=sum(float(x)<EPS or float(x)>1-EPS for x in v),observed_over_expected=None if ex==0 else ev/ex,observed_over_expected_status='undefined_zero_expected' if ex==0 else 'defined',expected_over_observed=None if ev==0 else ex/ev,expected_over_observed_status='undefined_zero_events' if ev==0 else 'defined')

def bounds(y,p,b,valid):
    n=len(y);scope='missing-label sensitivity bounds, not confidence intervals'
    if not n:return dict(status='no_issued_rows',n=0,unknown_rows=0,mean_d_lower=None,mean_d_upper=None,scope=scope)
    # Form point terms separately; independent fsum then reproduces defined missing-label targets.
    d0=p*p-b*b;d1=(p-1)**2-(b-1)**2
    known=math.fsum(float(d1[i] if y[i]==1 else d0[i]) for i in range(n) if valid[i])
    low=math.fsum(float(min(d0[i],d1[i])) for i in range(n) if not valid[i]);high=math.fsum(float(max(d0[i],d1[i])) for i in range(n) if not valid[i])
    return dict(status='bounded',n=n,known_rows=sum(map(bool,valid)),unknown_rows=n-sum(map(bool,valid)),known_sum_d=known,mean_d_lower=(known+low)/n,mean_d_upper=(known+high)/n,scope=scope)

def views(data,predictions,h,sids):
    sid,ts,y,valid=(data[k] for k in KEYS);groups=[('all','all',np.ones(len(ts),bool)),('year','2024',ts<1735689600),('year','2025',ts>=1735689600)]+[('asset',str(s),sid==s) for s in sids]
    score=[];bound=[];desc=[]
    for kind,key,mask in groups:
        m=mask&valid;n=int(m.sum())
        for arm,p in predictions.items():
            for j,barrier in enumerate(BS):
                ident=dict(horizon_hours=h,group_type=kind,group=key,prediction=arm,barrier=barrier)
                score.append(dict(ident,**points(y[m,j],p[m,j],data['baseline_raw'][m,j],sid[m],ts[m])))
                bound.append(dict(ident,**bounds(y[mask,j],p[mask,j],data['baseline_raw'][mask,j],valid[mask])))
                avg=lambda a:math.fsum(map(float,a))/n if n else None
                desc.append(dict(ident,issued_rows=int(mask.sum()),scored_rows=n,unknown_labels=int((mask&~valid).sum()),mean_prediction=avg(p[m,j]),observed_frequency=avg(y[m,j]),signed_error=avg(p[m,j]-y[m,j])))
    return dict(scores=score,missing_label_sensitivity=bound,descriptive=desc)

def paired_delta(y,candidate,source):
    n=len(y)
    if not n:return dict(brier=None,bounded_logloss=None,sum_probability=None,exact_brier=None,exact_sum_probability=None,brier_direction=None,sum_probability_direction=None)
    probability=F(0);squared=F(0);logs=[]
    for observed,new,old in zip(y,candidate,source):
        yy=int(observed);new=float(new);old=float(old)
        nq=F.from_float(new);oq=F.from_float(old)
        probability+=nq-oq;squared+=(nq-yy)**2-(oq-yy)**2
        nc=min(max(new,EPS),1-EPS);oc=min(max(old,EPS),1-EPS)
        ln=-yy*math.log(nc)-(1-yy)*math.log1p(-nc)
        lo=-yy*math.log(oc)-(1-yy)*math.log1p(-oc)
        logs.append(ln-lo)
    squared/=n
    direction=lambda q:'negative' if q<0 else 'positive' if q>0 else 'zero'
    return dict(brier=float(squared),bounded_logloss=math.fsum(logs)/n,sum_probability=float(probability),exact_brier=fr(squared),exact_sum_probability=fr(probability),brier_direction=direction(squared),sum_probability_direction=direction(probability))

def verify_saved(archives,canonical_mapping,outputs,report,oracle,accepted_horizons=None):
    """Independent joins, exact minmax ideals, saved cells, losses and score views."""
    need(set(archives)==set(outputs)==set(HS),'five horizon sets')
    need(type(canonical_mapping)is list and all(type(x)is list and len(x)==2 and type(x[0])is int and type(x[1])is str for x in canonical_mapping),'canonical map schema')
    sids=[v[0] for v in canonical_mapping];need(len(set(sids))==len(sids) and len({v[1] for v in canonical_mapping})==len(sids),'unique map')
    before={h:{k:v.tobytes() for k,v in d.items()} for h,d in archives.items()}
    ix={h:validate(archives[h],sids) for h in HS};union=set().union(*(set(ix[h]) for h in HS));common=set.intersection(*(set(ix[h]) for h in HS))
    for h in HS:
        out=outputs[h];need(type(out)is dict and set(out)==set(KEYS+ARMS+('projected',)),'candidate exact fields')
        for k in KEYS:need(out[k].dtype==archives[h][k].dtype and out[k].shape==archives[h][k].shape and out[k].tobytes()==before[h][k],'preserved identity/labels')
        need(type(out['projected'])is np.ndarray and out['projected'].dtype==np.dtype('bool') and out['projected'].shape==(len(ix[h]),),'projected mask geometry')
        for k in ARMS:need(type(out[k])is np.ndarray and out[k].dtype==np.dtype('<f8') and out[k].shape==archives[h][k].shape,'candidate geometry')
    totals={a:[dict(vectors=0,original=F(0),ideal=F(0),displacement=F(0),represented=F(0),quantization_bound=F(0)) for _ in BS] for a in ARMS}
    st={a:dict(exact_violations_before=0,diagnostic_violations_before=0,represented_changed_cells=0,quantization_bound_all_J=[F(0) for _ in BS]) for a in ARMS}
    for key in sorted(union):
        present=[h for h in HS if key in ix[h]]
        for a,h1 in enumerate(present):
            for h2 in present[a+1:]:
                i,j=ix[h1][key],ix[h2][key]
                if archives[h1]['label_valid'][i] and archives[h2]['label_valid'][j]:need((archives[h1]['y'][i]<=archives[h2]['y'][j]).all(),'nonnested observed labels')
        for h in present:
            i=ix[h][key];need(bool(outputs[h]['projected'][i])==(key in common),'common label-independent J')
            if key not in common:
                for a in ARMS:need(outputs[h][a][i].tobytes()==archives[h][a][i].tobytes(),'partial-grid bit identity')
        if key not in common:continue
        complete=all(archives[h]['label_valid'][ix[h][key]] for h in HS)
        for arm in ARMS:
            p=np.stack([archives[h][arm][ix[h][key]] for h in HS]);qcols=[oracle.minmax_column([float(v) for v in p[:,j]]) for j in range(5)]
            q=np.array([[float(qcols[j][i]) for j in range(5)] for i in range(5)])
            need((q[1:]>=q[:-1]).all() and (q[:,1:]>=q[:,:-1]).all(),'both coordinate orders')
            for i,h in enumerate(HS):need(outputs[h][arm][ix[h][key]].tobytes()==q[i].tobytes(),'independent once-rounded candidate cells')
            for i in range(5):
                for k in range(i+1,5):
                    d=p[i]-p[k];st[arm]['exact_violations_before']+=int((d>0).sum());st[arm]['diagnostic_violations_before']+=int((d>1e-12).sum())
            st[arm]['represented_changed_cells']+=int((p!=q).sum())
            for j in range(5):
                ideal=qcols[j];orig=tuple(F.from_float(float(v)) for v in p[:,j]);rep=tuple(F.from_float(float(v)) for v in q[:,j]);err=[a-b for a,b in zip(rep,ideal)];qb=sum((2*abs(e)+e*e for e in err),F(0));st[arm]['quantization_bound_all_J'][j]+=qb
                if complete:
                    yy=[int(archives[h]['y'][ix[h][key],j]) for h in HS];loss=lambda v:sum(((x-y)**2 for x,y in zip(v,yy)),F(0));disp=sum(((x-y)**2 for x,y in zip(orig,ideal)),F(0));need(loss(ideal)<=loss(orig)-disp and abs(loss(rep)-loss(ideal))<=qb,'exact ideal/represented bound')
                    t=totals[arm][j];t['vectors']+=1
                    for k,v in [('original',loss(orig)),('ideal',loss(ideal)),('represented',loss(rep)),('displacement',disp),('quantization_bound',qb)]:t[k]+=v
    horizons=[]
    for h in HS:
        data=archives[h];native=views(data,{a:data[a] for a in ALL},h,sids);cand=views(data,{a:outputs[h][a] for a in ARMS},h,sids)
        if accepted_horizons is not None:
            for k in ('scores','missing_label_sensitivity'):
                identity=lambda r:tuple(r[v] for v in ('horizon_hours','group_type','group','prediction','barrier'))
                left={identity(r):r for r in native[k]};right={identity(r):r for r in accepted_horizons[h][k]}
                need(len(left)==len(native[k]) and len(right)==len(accepted_horizons[h][k]),'unique native score identities')
                compare(left,right,'native.'+k)
        originals={(r['group_type'],r['group'],r['prediction'],r['barrier']):r for r in native['scores']};delta=[]
        for r in cand['scores']:
            kind,key=r['group_type'],r['group']
            mask=np.ones(len(data['sid']),bool) if kind=='all' else ((data['ts']<1735689600) if key=='2024' else (data['ts']>=1735689600)) if kind=='year' else data['sid']==int(key)
            selected=mask&data['label_valid'];j=BS.index(r['barrier']);arm=r['prediction']
            delta.append({k:r[k] for k in ('horizon_hours','group_type','group','prediction','barrier')}|paired_delta(data['y'][selected,j],outputs[h][arm][selected,j],data[arm][selected,j]))
        prov={} if accepted_horizons is None else {k:v for k,v in accepted_horizons[h].items() if k.startswith('evaluation_') or k in ('issue_eligible_origins','issue_eligible_invalid_baseline')}
        horizons.append(dict(horizon_hours=h,native=native,candidate=cand,candidate_minus_own_source=delta,original_provenance=prov,projected_rows=len(common),unchanged_partial_rows=len(ix[h])-len(common)))
    for a in ARMS:st[a]['quantization_bound_all_J']=list(map(fr,st[a]['quantization_bound_all_J']))
    exact={a:[{k:fr(v) if type(v)is F else v for k,v in t.items()} for t in tt] for a,tt in totals.items()}
    expected=dict(schema='q26-r17-saved-repair-analysis-v1',horizons=horizons,common_prediction_only_J=dict(rows=len(common),sha256=hashlib.sha256('\n'.join(f'{s}:{t}' for s,t in sorted(common)).encode()).hexdigest()),union_rows=len(union),partial_grid_rows=len(union-common),common_support_across_four_arms=True,structural=st,exact_complete_coherent_loss=exact,primary=dict(horizon_hours=24,barrier=-.1),native_metric_parity='PASS' if accepted_horizons is not None else 'NOT_CHECKED_SYNTHETIC',paired_delta_contract=PAIRED_DELTA_CONTRACT,claims=CLAIM)
    compare(report,expected)
    need(all(archives[h][k].tobytes()==before[h][k] for h in HS for k in archives[h]),'checker input immutable')
    return {'complete':True,'independent_exact_minmax':True,'independent_fsum_score_reconciliation':True,'common_J_sha256':expected['common_prediction_only_J']['sha256']}

def canonical(path):
    p=Path(path);need(p.is_absolute() and p.resolve()==p and not p.is_symlink(),'canonical nonsymlink path');return p

def pin(path):
    p=canonical(path);need(p.is_file(),'regular input');h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''):h.update(block)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())

def checked(rec):
    need(type(rec)is dict and set(rec)=={'path','size','sha256'} and type(rec['size'])is int and rec['size']>=0,'exact pin');need(pin(rec['path'])==rec,'pin changed');return canonical(rec['path'])

def parse(raw):
    def pairs(items):
        d={}
        for k,v in items:need(k not in d,'duplicate JSON key');d[k]=v
        return d
    def finite_float(token):
        value=float(token);need(math.isfinite(value),'nonfinite JSON float');return value
    return json.loads(raw,object_pairs_hook=pairs,parse_float=finite_float,parse_constant=lambda _:need(False,'nonfinite JSON'))

def read(rec):
    need(type(rec)is dict and type(rec.get('size'))is int and rec['size']<=16*1024**2,'JSON pin cap');p=canonical(rec['path']);need(p.stat().st_size<=16*1024**2,'JSON stat cap');checked(rec);return parse(p.read_bytes())

def headers(path,candidate=False):
    fields=KEYS+ARMS+('projected',) if candidate else KEYS+ALL;desc={};total=0
    with zipfile.ZipFile(canonical(path)) as z:
        members=z.infolist();need(len(members)==len(fields) and len({v.filename for v in members})==len(fields) and {v.filename for v in members}=={k+'.npy' for k in fields},'ZIP exact inventory')
        for m in members:
            need(not m.flag_bits&1 and m.compress_type==zipfile.ZIP_DEFLATED and m.file_size<=64*1024**2,'ZIP bound')
            with z.open(m) as f:
                magic=f.read(8);need(magic[:6]==b'\x93NUMPY' and magic[6:] in (b'\x01\x00',b'\x02\x00'),'NPY magic');width=2 if magic[6]==1 else 4;b=f.read(width);need(len(b)==width,'header length');length=int.from_bytes(b,'little');need(0<length<=10000,'header cap');b=f.read(length);need(len(b)==length,'header truncated');d=ast.literal_eval(b.decode('latin1'))
            k=m.filename[:-4];need(type(d)is dict and set(d)=={'descr','shape','fortran_order'} and d['fortran_order'] is False,'header schema')
            dt={'sid':'<i4','ts':'<i8','y':'|u1','label_valid':'|b1','projected':'|b1'}.get(k,'<f8');shape=d['shape'];need(type(shape)is tuple and len(shape)in (1,2) and all(type(x)is int and x>=0 for x in shape) and shape[0]<=200000,'header dimensions');need(shape==((shape[0],) if k in ('sid','ts','label_valid','projected') else (shape[0],5)) and d['descr']==dt,'header field geometry');n=math.prod(shape)*np.dtype(dt).itemsize;need(m.file_size==8+width+length+n,'payload size');total+=n;desc[k]=(shape,dt)
    need(len({v[0][0] for v in desc.values()})==1 and total<=64*1024**2,'payload cap/alignment');return desc

def authenticate(request_path,sha,result_path,receipt_path):
    rp=canonical(request_path);need(rp.stat().st_size<=1024**2,'request byte cap');raw=rp.read_bytes();need(len(raw)<=1024**2 and hashlib.sha256(raw).hexdigest()==sha,'external request digest');req=parse(raw);need(type(req)is dict and set(req)=={'schema','pins','out'} and req['schema']=='q26-r17-saved-repair-request-v1','request schema');pins=req['pins'];need(type(pins)is dict and set(pins)=={'source','checker','kernel','check_kernel','protocol','runtime','location','headers'}|{f'archive_{h}' for h in HS},'request roles')
    for v in pins.values():checked(v)
    need(pins['checker']==pin(Path(__file__).resolve()),'executed checker identity')
    location=read(pins['location']);auth=location['authority_references'];need(type(auth)is dict and len(auth)==28,'authority closure inventory');closure=list(pins.values())+list(auth.values())
    for v in closure:checked(v)
    staged=read(auth['staged_manifest']);selection=read(auth['staging_request']);mapping=location['canonical_mapping'];need(len(mapping)==24 and mapping==staged['canonical_mapping']==selection['selected'] and staged['complete'] is True and location['canonical_mapping_authority']['pin']==auth['staged_manifest'],'canonical selection closure')
    old=read(auth['complete_result']);audit=read(auth['complete_parent_audit']);monitor=read(auth['complete_monitor']);need(old['complete'] is True and audit['accepted'] is True and audit['result']==auth['complete_result'] and audit['monitor']==auth['complete_monitor'],'accepted result binding')
    need(monitor['complete'] is True and monitor['exit_code']==0 and monitor['changed_pin_paths']==[] and monitor['observation_failure'] is None and monitor['stop_reason'] is None and monitor['containment']['errors']==[] and monitor['containment']['no_live_members_remaining'] is True and monitor['containment']['remaining_live_members']==[] and monitor['containment']['remaining_zombies']==[] and auth['complete_result'] in monitor['result_pins'],'clean terminal ancestry')
    accepted={int(h['horizon_hours']):h for h in old['horizons']};need(set(accepted)==set(HS) and len(old['horizons'])==5,'accepted five horizon reports');qualified=read(pins['headers']);need(qualified['status']=='HEADERS_AND_METADATA_ONLY_QUALIFIED' and qualified['source_location']==pins['location'],'header authority binding')
    for h in HS:
        rec=pins[f'archive_{h}'];need(rec==location['completed_O81_predictions'][str(h)]['pin'] and rec in monitor['result_pins'] and rec['sha256']==accepted[h]['local_predictions_sha256'] and qualified['prediction_archives'][str(h)]['pin']==rec,'accepted archive binding');hd=headers(rec['path'])
        for k,(shape,dt) in hd.items():need(qualified['prediction_archives'][str(h)]['fields'][k]['shape']==list(shape) and qualified['prediction_archives'][str(h)]['fields'][k]['dtype']==dt,'qualified header exact')
    runtime=read(pins['runtime']);need(set(runtime)=={'executable','python_version','numpy_version','env'},'runtime schema');checked(runtime['executable']);closure.append(runtime['executable']);env=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONOPTIMIZE='0',PYTHONDONTWRITEBYTECODE='1');need(runtime['env']==env and all(os.environ.get(k)==v for k,v in env.items()) and sys.flags.optimize==0 and sys.flags.dont_write_bytecode and str(Path(sys.executable).resolve())==runtime['executable']['path'] and sys.version.split()[0]==runtime['python_version'] and np.__version__==runtime['numpy_version'],'frozen runtime')
    out=canonical(req['out']);respath=canonical(result_path);receipt=canonical(receipt_path);need(out.is_dir() and respath==out/'result.json' and not receipt.exists(),'result and fresh receipt');protected={Path(v['path']).parent for v in closure}|{out};need(all(not receipt.is_relative_to(p) for p in protected),'receipt outside immutable roots');need(all(not out.is_relative_to(Path(v['path']).parent) for v in closure),'producer outside immutable roots');inventory={'started.json','result.json'}|{f'candidate-{h}.npz' for h in HS};need({p.name for p in out.iterdir()}==inventory and all(not p.is_symlink() and p.is_file() for p in out.iterdir()),'producer exact inventory');need(sum(p.stat().st_size for p in out.iterdir())<=64*1024**2,'cumulative producer output cap');resultpin=pin(respath);result=read(resultpin);need(set(result)=={'schema','label','complete','request_sha256','request_pins','source','started','candidates','analysis'} and result['schema']=='q26-r17-saved-repair-result-v1' and result['label']=='CODEX CONTINUATION' and result['complete'] is True and result['request_sha256']==sha and result['request_pins']==pins and result['source']==pins['source'],'producer result binding');need(result['started']['path']==str(out/'started.json'),'started location');started=read(result['started']);need(started==dict(schema='q26-r17-saved-repair-started-v1',request_sha256=sha,request_pins=pins),'started exact binding');need(set(result['candidates'])=={str(h) for h in HS},'candidate five pins')
    for h in HS:
        rec=result['candidates'][str(h)];need(rec['path']==str(out/f'candidate-{h}.npz'),'candidate location');checked(rec);headers(rec['path'],True);closure.append(rec)
    closure.extend([resultpin,result['started']]);return req,mapping,accepted,closure,result,inventory

def load_oracle(rec):
    p=checked(rec);mod=importlib.util.module_from_spec(importlib.util.spec_from_loader('_q26_saved_independent_oracle',loader=None));exec(compile(p.read_bytes(),str(p),'exec'),mod.__dict__);return mod

def run(request_path,request_sha256,result_path,receipt_path):
    req,mapping,accepted,closure,result,inventory=authenticate(request_path,request_sha256,result_path,receipt_path)
    oracle=load_oracle(req['pins']['check_kernel']);archives={};outputs={}
    for h in HS:
        with np.load(req['pins'][f'archive_{h}']['path'],allow_pickle=False) as z:archives[h]={k:z[k] for k in KEYS+ALL}
        with np.load(result['candidates'][str(h)]['path'],allow_pickle=False) as z:outputs[h]={k:z[k] for k in KEYS+ARMS+('projected',)}
        need(len(archives[h]['sid'])==accepted[h]['evaluation_issued_origins'] and int(archives[h]['label_valid'].sum())==accepted[h]['evaluation_complete_label_origins'],'accepted mask counts')
    verified=verify_saved(archives,mapping,outputs,result['analysis'],oracle,accepted)
    for rec in closure:checked(rec)
    need(hashlib.sha256(canonical(request_path).read_bytes()).hexdigest()==request_sha256 and {p.name for p in canonical(req['out']).iterdir()}==inventory and sum(p.stat().st_size for p in canonical(req['out']).iterdir())<=64*1024**2,'final immutable inputs/inventory/cap')
    receipt=dict(schema='q26-r17-saved-repair-acceptance-v1',complete=True,label='CODEX CONTINUATION',request_sha256=request_sha256,result=pin(result_path),checker=req['pins']['checker'],check_kernel=req['pins']['check_kernel'],verified=verified,limits='Shared saved predictions and original scientific arithmetic; independent joins, minmax oracle and fsum score reducers. Seen-data descriptive only; no model or forecast execution.')
    raw=json.dumps(receipt,indent=2,allow_nan=False)+'\n';need(len(raw.encode())<=65536,'receipt cap')
    with canonical(receipt_path).open('x') as f:f.write(raw)
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--result',required=True);p.add_argument('--receipt',required=True);a=p.parse_args();run(a.request,a.request_sha256,a.result,a.receipt)
