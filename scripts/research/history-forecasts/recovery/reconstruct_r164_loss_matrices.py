"""Original seven-model R16.4 stored-loss matrices; quantization compatibility, no bootstrap."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import resource
import shutil
import sys
import time
import zipfile
import numpy as np

MODELS=('a','f','fH','rec12','fix12','recb12','recc12')
COMPS=(('rec12','fH'),('rec12','f'),('rec12','a'),('fix12','fH'),('rec12','fix12'),('recb12','fH'),('recc12','fH'),('recc12','rec12'),('recb12','rec12'),('fH','f'),('f','a'),('fH','a'))
HORIZONS=(24,72,168,720);TNAME={24:'1d',72:'3d',168:'7d',720:'30d'}
BANDS={'shallow -2..-7%':(0,1,2,3),'mid -10..-20%':(4,5,6),'deep -25..-40%':(7,8,9)}
MAJOR={'bspan:ETH':'ETH','locked:coinbase-eth-usd':'ETH','bspan:BTC':'BTC','locked:bitstamp-btc-usd':'BTC','locked:coinbase-btc-usd':'BTC'}
ORIGIN=17532;SCHEMA='codex-r164-original-loss-matrix-request-v1'
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=300,output_bytes=10000000)
REQUIRED={'name','day','T_h','k_i','y',*('p_'+m for m in MODELS)}
LIMITATION='Stored float16 predictions are not the original unpersisted float32 arrays. Closed adjacent-float16 midpoint envelopes conservatively contain possible original float32 preimages and can include unattainable tie endpoints. Published-summary compatibility is not proof of original float recovery. Md is computed from stored point values; MdLo/MdHi are conservative rounding envelopes, not confidence intervals. No bootstrap, inference, fit, new predictions, reserves or LP replay.'


def need(c,message):
    if not c:raise ValueError(message)

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return h.hexdigest()

def pin(path):
    p=Path(path).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))

def check(p):need(pin(p['path'])==p,'changed evidence pin')

def load(path):
    def unique(pairs):
        d={}
        for k,v in pairs:need(k not in d,'duplicate JSON key');d[k]=v
        return d
    with open(path) as f:return json.load(f,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite JSON')))

def preimage(p):
    need(p.dtype.str in ('<f2','<f4'),'unsupported prediction precision; review hold')
    x=p.astype(np.float64);need(np.isfinite(x).all() and ((x>=0)&(x<=1)).all(),'finite probability bounds')
    if p.dtype.str=='<f4':return x,x.copy()
    lower=(np.nextafter(p,np.float16(-np.inf),dtype=np.float16).astype(np.float64)+x)/2
    upper=(np.nextafter(p,np.float16(np.inf),dtype=np.float16).astype(np.float64)+x)/2
    return np.maximum(lower,0.),np.minimum(upper,1.)

def loss_bounds(y,lower,upper):
    return np.where(y==1,(1-upper)**2,lower**2),np.where(y==1,(1-lower)**2,upper**2)

def bss_bounds(al,au,bl,bu):
    if bu==0:return None
    return dict(lower=float(1-au/bl) if bl>0 else None,upper=float(1-al/bu),denominator_may_be_zero=bool(bl==0))

def guard(value):return 64*np.finfo(np.float64).eps*max(1.,abs(float(value)))

def compatible(value,bounds,label,checks,point=None):
    if bounds is None:need(value is None,'published defined statistic but reconstructed undefined: '+label)
    elif value is None:need(bounds.get('denominator_may_be_zero',False),'published null but strictly defined: '+label)
    else:
        need(isinstance(value,(float,int)) and not isinstance(value,bool) and np.isfinite(value),'invalid published statistic: '+label)
        lo,hi=bounds['lower'],bounds['upper'];g=guard(value)
        need((lo is None or value>=lo-g) and (hi is None or value<=hi+g),'published statistic outside rounding bounds: '+label)
    checks.append(dict(statistic=label,published=value,stored_point=point,bounds=bounds))

def closed(lo,hi):return dict(lower=float(lo),upper=float(hi),denominator_may_be_zero=False)

def empty():
    return dict(n=0,pos=0,p=np.zeros((3,7)),se=np.zeros((3,7)),cells={})

def add(a,y,p,pl,pu,cid,blocks):
    se=(p-y)**2;sl,su=loss_bounds(y,pl,pu);a['n']+=len(y);a['pos']+=int(y.sum())
    a['p']+=np.stack([p.sum(1),pl.sum(1),pu.sum(1)]);a['se']+=np.stack([se.sum(1),sl.sum(1),su.sum(1)])
    u,inv=np.unique(blocks,return_inverse=True);counts=np.bincount(inv)
    for j,b in enumerate(u):
        cell=a['cells'].setdefault((cid,int(b)),[0,np.zeros((3,12))]);cell[0]+=int(counts[j])
    for c,(ma,mb) in enumerate(COMPS):
        i,k=MODELS.index(ma),MODELS.index(mb)
        for z,v in enumerate((se[i]-se[k],sl[i]-su[k],su[i]-sl[k])):
            sums=np.bincount(inv,weights=v,minlength=len(u))
            for j,b in enumerate(u):a['cells'][cid,int(b)][1][z,c]+=sums[j]

def merge(parts):
    a=empty()
    for b in parts:
        a['n']+=b['n'];a['pos']+=b['pos'];a['p']+=b['p'];a['se']+=b['se']
        for key,(n,d) in b['cells'].items():
            cell=a['cells'].setdefault(key,[0,np.zeros((3,12))]);cell[0]+=n;cell[1]+=d
    return a

def read_npz(path):
    arrays={};geometry={}
    with zipfile.ZipFile(path) as z:
        names=z.namelist();need(len(names)==len(set(names)) and all('/' not in n and n.endswith('.npy') for n in names),'invalid NPZ members')
        for name in names:
            with z.open(name) as f:v=np.lib.format.read_array(f,allow_pickle=False)
            key=name[:-4];geometry[key]=dict(dtype=v.dtype.str,shape=list(v.shape))
            if key in REQUIRED:arrays[key]=v
    need(REQUIRED<=set(arrays),'missing original required fields');return arrays,geometry

def build(paths,expected_series=130,expected_clusters=127,expected_main_dtype=None,progress=None):
    need(len(paths)==expected_series and len(set(str(p) for p in paths))==expected_series,'exact series source count')
    groups={(T,b):empty() for T in HORIZONS for b in BANDS};levels={(T,k):empty() for T in HORIZONS for k in range(10)}
    raw={T:0 for T in HORIZONS};clusters={};names=[];metadata=[]
    for ordinal,path in enumerate(sorted(paths,key=lambda p:Path(p).name)):
        a,geometry=read_npz(path);name=str(a['name']);need(a['name'].shape==() and a['name'].dtype.kind in 'US' and name not in names,'unique scalar series name')
        names.append(name);cl=MAJOR.get(name,name);cid=clusters.setdefault(cl,len(clusters));y=a['y'];n=len(y)
        need(y.shape==(n,) and np.isfinite(y).all() and np.isin(y,[0,1]).all(),'binary label geometry')
        for k in ('day','T_h','k_i'):need(a[k].shape==(n,) and a[k].dtype.kind in 'iu','integer row identity geometry')
        need(((a['k_i']>=0)&(a['k_i']<10)).all(),'original threshold index range')
        common=np.ones(n,bool)
        for model in MODELS:
            v=a['p_'+model];need(v.shape==(n,) and v.dtype.str in ('<f2','<f4'),'unsupported original probability geometry/precision; review hold');need(expected_main_dtype is None or v.dtype.str==expected_main_dtype,'stored dtype differs from frozen packet headers');common&=np.isfinite(v)
        yy=y[common].astype(np.float64);pp=[];ll=[];uu=[]
        for model in MODELS:
            v=a['p_'+model][common];l,u=preimage(v);pp.append(v.astype(np.float64));ll.append(l);uu.append(u)
        pp=np.asarray(pp);ll=np.asarray(ll);uu=np.asarray(uu);ts=a['T_h'][common];kk=a['k_i'][common];blocks=(a['day'][common].astype(np.int64)-ORIGIN)//182
        for T in HORIZONS:
            raw[T]+=int((a['T_h']==T).sum())
            for k in range(10):
                use=(ts==T)&(kk==k)
                if use.any():add(levels[T,k],yy[use],pp[:,use],ll[:,use],uu[:,use],cid,blocks[use])
        metadata.append(dict(ordinal=ordinal,file=Path(path).name,name=name,cluster_name=cl,cluster_id=cid,rows=n,positive_labels=int(y.sum()),joint_finite_rows=int(common.sum()),raw_horizon_counts={str(int(T)):int((a['T_h']==T).sum()) for T in np.unique(a['T_h'])},joint_finite_horizon_counts={str(T):int((ts==T).sum()) for T in HORIZONS},raw_threshold_counts={str(k):int((a['k_i']==k).sum()) for k in range(10)},joint_finite_threshold_counts={str(k):int((kk==k).sum()) for k in range(10)},fields=geometry))
        if progress is not None:progress(ordinal+1)
    need(len(names)==expected_series and len(clusters)==expected_clusters,'exact original series/major-cluster count')
    for T in HORIZONS:
        for band,ks in BANDS.items():groups[T,band]=merge([levels[T,k] for k in ks])
        groups[T,'all']=merge([groups[T,b] for b in BANDS])
    return groups,levels,raw,metadata,clusters

def arrays_for(a):
    need(a['n']>0,'empty original matrix group');sids=np.array(sorted({s for s,b in a['cells']}),np.int64);bids=np.array(sorted({b for s,b in a['cells']}),np.int64)
    si={v:i for i,v in enumerate(sids)};bi={v:i for i,v in enumerate(bids)};mn=np.zeros((len(sids),len(bids)),np.int64);md=np.zeros((3,12,len(sids),len(bids)))
    for (s,b),(n,d) in a['cells'].items():mn[si[s],bi[b]]=n;md[:,:,si[s],bi[b]]=d
    need(int(mn.sum())==a['n'] and np.all(mn.sum(1)>0) and np.all(mn.sum(0)>0),'trimmed exact matrix support')
    for c,(ma,mb) in enumerate(COMPS):
        i,j=MODELS.index(ma),MODELS.index(mb)
        for z,expected in enumerate((a['se'][0,i]-a['se'][0,j],a['se'][1,i]-a['se'][2,j],a['se'][2,i]-a['se'][1,j])):
            need(abs(md[z,c].sum()/a['n']-expected/a['n'])<=guard(expected/a['n']),'internal comparison/model-loss conservation')
    return dict(Md=md[0],MdLo=md[1],MdHi=md[2],Mn=mn,SIDs=sids,BIDs=bids)

def reconcile(groups,levels,raw,published):
    need(published['models']==list(MODELS) and published['comparisons']==[list(c) for c in COMPS] and set(published['per_T'])==set(TNAME.values()),'original main model/comparison closure')
    checks=[];summaries={}
    def model_checks(a,sc,label):
        need(a['n']>0,'empty published support')
        for j,m in enumerate(MODELS):
            compatible(sc[m]['brier'],closed(a['se'][1,j]/a['n'],a['se'][2,j]/a['n']),label+'/'+m+'/brier',checks,point=float(a['se'][0,j]/a['n']))
            rb=closed(a['p'][1,j]/a['pos'],a['p'][2,j]/a['pos']) if a['pos'] else None
            compatible(sc[m]['R'],rb,label+'/'+m+'/R',checks,point=float(a['p'][0,j]/a['pos']) if a['pos'] else None)
    for T in HORIZONS:
        a=groups[T,'all'];sc=published['per_T'][TNAME[T]];label=TNAME[T];need(type(sc['n_rows']) is int and sc['n_rows']==a['n'] and type(sc['n_rows_T']) is int and sc['n_rows_T']==raw[T],'published exact row counts differ')
        compatible(sc['base_rate'],closed(a['pos']/a['n'],a['pos']/a['n']),label+'/base_rate',checks)
        need(abs(sc['base_rate']*a['n']-a['pos'])<=guard(a['pos']),'published positive-count consistency')
        model_checks(a,sc['models'],label+'/models');matrix=arrays_for(a)
        need(set(sc['levels'])==set(str(k) for k in range(10)),'all original levels required')
        for k in range(10):
            z=levels[T,k];sl=sc['levels'][str(k)];need(type(sl['n']) is int and sl['n']==z['n'],'published exact level count differs')
            compatible(sl['base_rate'],closed(z['pos']/z['n'],z['pos']/z['n']),label+f'/level{k}/base_rate',checks);model_checks(z,sl,label+f'/level{k}')
        for c,(ma,mb) in enumerate(COMPS):
            i,j=MODELS.index(ma),MODELS.index(mb);co=sc['comparisons'][ma+'_vs_'+mb]
            need(co['S']==len(matrix['SIDs']) and co['B']==len(matrix['BIDs']),'published cluster/block counts differ')
            compatible(co['mean_d'],closed(matrix['MdLo'][c].sum()/a['n'],matrix['MdHi'][c].sum()/a['n']),label+f'/{ma}_vs_{mb}/mean_d',checks,point=float(matrix['Md'][c].sum()/a['n']))
            compatible(co['bss'],bss_bounds(a['se'][1,i],a['se'][2,i],a['se'][1,j],a['se'][2,j]),label+f'/{ma}_vs_{mb}/bss',checks,point=float(1-a['se'][0,i]/a['se'][0,j]) if a['se'][0,j]>0 else None)
            for band in BANDS:
                z=groups[T,band];compatible(co['bands'][band]['bss'],bss_bounds(z['se'][1,i],z['se'][2,i],z['se'][1,j],z['se'][2,j]),label+f'/{ma}_vs_{mb}/{band}/bss',checks,point=float(1-z['se'][0,i]/z['se'][0,j]) if z['se'][0,j]>0 else None)
        summaries[label]=dict(raw_rows=raw[T],joint_finite_rows=a['n'],positive_labels=a['pos'],levels={str(k):dict(rows=levels[T,k]['n'],positive_labels=levels[T,k]['pos']) for k in range(10)})
    return checks,summaries


def resources(start,folder):
    rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
    need(rss<=POLICY['rss_bytes'] and time.monotonic()-start<=POLICY['wall_seconds'] and shutil.disk_usage(folder).free>=POLICY['disk_reserve_bytes'],'matrix operational policy breached');return rss

def atomic(path,value):
    tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(value,separators=(',',':'),allow_nan=False));os.replace(tmp,path)

def authenticate(path,digest):
    need(not any(n=='torch' or n.startswith('torch.') or n=='scipy' or n.startswith('scipy.') for n in sys.modules),'NumPy-only reconstruction process required')
    need(sha(path)==digest,'request SHA differs');r=load(path)
    need(r.get('schema')==SCHEMA and r.get('status')=='FROZEN' and r.get('policy')==POLICY,'frozen original reconstruction protocol required')
    need(r['models']==list(MODELS) and r['comparisons']==[list(c) for c in COMPS] and r['horizons']==list(HORIZONS) and r['bands']=={k:list(v) for k,v in BANDS.items()} and r['origin']==ORIGIN,'original scorer constants differ')
    for p in r['artifacts'].values():check(p)
    need(r['artifacts']['implementation']==pin(__file__),'new matrix implementation binding differs')
    admitted=load(r['artifacts']['restore_acceptance']['path']);retrieval=load(r['artifacts']['retrieval']['path'])
    need(admitted.get('schema')=='codex-parent-r164-original-input-admission-v1' and admitted.get('complete') is True and admitted['retrieval']==r['artifacts']['retrieval'] and admitted['request']==r['artifacts']['retrieval_request'],'parent restore acceptance binding required')
    monitor=load(r['artifacts']['restore_monitor']['path']);need(admitted['monitor']==r['artifacts']['restore_monitor'] and monitor.get('complete') is True and monitor.get('exit_code')==0 and monitor.get('request_sha256')==r['artifacts']['retrieval_request']['sha256'],'parent restore monitor binding required')
    need(r['expected_main_dtype']=='<f2','frozen admitted prediction header precision required')
    need(retrieval.get('complete') is True and retrieval['request']==r['artifacts']['retrieval_request'] and len(retrieval['files'])==132,'complete original restore receipt required')
    original=load(r['artifacts']['retrieval_request']['path']);need(original['repo']=='triccs/membrane-datasets' and original['commit']=='a8d2594e68faa44ad4376de24d21c6c8c20c4e5f' and original['files']==r['original_manifest'],'immutable original packet/manifest differs')
    files=[]
    for rec in retrieval['files']:
        p=dict(path=rec['path'],size=rec['size'],sha256=rec['sha256']);check(p);need(any(all(rec[k]==v[k] for k in ('relative','size','sha256','git_blob_sha1')) for v in original['files']),'restored file outside original manifest');files.append(p)
    need(len({p['path'] for p in files})==132 and {v['relative'] for v in retrieval['files']}=={v['relative'] for v in original['files']},'duplicate/incomplete restored payload closure')
    need(files==r['input_pins'],'all132 explicit input request pins differ')
    need(r['artifacts']['score']==next(p for p in files if Path(p['path']).name=='score-main.json'),'exact restored score pin required')
    need(sys.executable==r['runtime']['executable'] and sys.version==r['runtime']['python'] and np.__version__==r['runtime']['numpy'],'pinned matrix runtime differs')
    return r,files


def run(path,digest):
    start=time.monotonic();r,inputs=authenticate(path,digest);folder=Path(r['output']).resolve();need(not folder.exists(),'fresh output directory required');folder.mkdir();receipt=folder/'reconstruction.json';state=dict(schema='codex-r164-original-loss-matrices-v1',complete=False,status='running',request=pin(path),implementation=pin(__file__))
    atomic(receipt,state)
    try:
        peak=resources(start,folder);rows=[p['path'] for p in inputs if p['path'].endswith('.npz')];need(len(rows)==130,'all original 130 NPZ required')
        def progress(n):
            nonlocal peak
            peak=max(peak,resources(start,folder))
            if n%25==0 or n==130:print(json.dumps(dict(event='series_reconstructed',completed=n)),flush=True)
        groups,levels,raw,metadata,clusters=build(rows,expected_main_dtype=r['expected_main_dtype'],progress=progress);published=load(r['artifacts']['score']['path']);checks,summaries=reconcile(groups,levels,raw,published)
        arrays={};group_meta=[]
        for T in HORIZONS:
            for index,band in enumerate(('all',*BANDS)):
                key=f'T{T}_G{index}';values=arrays_for(groups[T,band]);arrays.update({key+'_'+k:v for k,v in values.items()});group_meta.append(dict(key=key,horizon_hours=T,band=band,rows=groups[T,band]['n'],S=len(values['SIDs']),B=len(values['BIDs'])))
        data=io.BytesIO();np.savez_compressed(data,**arrays);payload=data.getvalue();state.update(status='quantization-compatible',comparison_order=[list(c) for c in COMPS],model_order=list(MODELS),groups=group_meta,series=metadata,cluster_ids=clusters,published_compatibility=checks,summaries=summaries,limitations=LIMITATION,input_pins=inputs,source_pins={k:v for k,v in r['artifacts'].items() if k.endswith('_source')})
        for p in inputs+list(r['artifacts'].values()):check(p)
        need(sha(path)==digest,'request changed during reconstruction');peak=max(peak,resources(start,folder))
        state.update(complete=True,status='complete',elapsed_seconds=time.monotonic()-start,peak_process_rss_bytes=peak,matrix_bytes=len(payload))
        need(len(payload)+len(json.dumps(state,separators=(',',':'),allow_nan=False).encode())+512<=POLICY['output_bytes'],'bounded output budget exceeded')
        matrix=folder/'matrices.npz'
        part=matrix.with_name(matrix.name+'.part')
        with part.open('xb') as f:f.write(payload);f.flush();os.fsync(f.fileno())
        os.replace(part,matrix);state['matrix']=pin(matrix);atomic(receipt,state);return state
    except BaseException as error:
        state.update(complete=False,status='failed-review-hold',error_type=type(error).__name__,error=str(error)[:300],elapsed_seconds=time.monotonic()-start);atomic(receipt,state);raise RuntimeError('matrix reconciliation failed; stage preserved') from None


def main():
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);a=p.parse_args();run(a.request,a.request_sha256)
if __name__=='__main__':main()
