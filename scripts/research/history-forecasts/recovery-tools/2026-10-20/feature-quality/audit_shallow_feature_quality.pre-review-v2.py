"""CODEX CONTINUATION factual feature census; no Torch, fitting or prediction inspection.
Original memberships are exposures, reused across models/roles, not independent samples.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata as md
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import sys
import time
import warnings
import numpy as np

SOURCE=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts')
sys.path.insert(0,str(SOURCE))
import r16_shallow_nn_independent as I
import r16_nn as NN
CAPS=dict(nmlp=60000,ngru=20000,ntcn=30000,ntfm=20000,nmlp0=60000)
POLICY=dict(rss_bytes=2500000000,disk_reserve_bytes=2000000000,wall_seconds=1800,batch_rows=1024,output_bytes=5000000)
SCHEMA='codex-r16-shallow-feature-census-request-v2'
ACTIVE_GUARD=None
LIMITATION='Factual aggregate feature-quality census on previously seen development data. Role supports reuse observations across models/cells; counts are membership exposures, not independent samples or epoch-weighted training examples. No predictions, outcomes, scoring, fitting, model selection, causal attribution, p-values, reserve data or per-row feature archive.'


def require(condition,message):
    if not condition:raise ValueError(message)


def no_torch():require(not any(n=='torch' or n.startswith('torch.') for n in sys.modules),'Torch import prohibited')

def pin(path):
    p=Path(path).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=I.sha(p))

def check_pin(p):
    # This is the only integrity-only permission site: streamed SHA, no deserialization.
    state=ACTIVE_GUARD;previous=None
    if state is not None and state['active']:
        path=str(Path(p['path']).resolve());expected=state['integrity_pins'].get(path)
        require(expected is not None and all(expected[k]==p[k] for k in ('path','size','sha256')),'unadmitted integrity hash')
        previous=state['hash_only_target'];state['hash_only_target']=path
    try:
        actual=pin(p['path']);require(all(actual[k]==p[k] for k in ('path','size','sha256')),'changed evidence pin: '+str(p['path']));return actual
    finally:
        if state is not None and state['active']:state['hash_only_target']=previous

def exact(actual,expected,name):
    require(set(actual)==set(expected),'array key mismatch '+name)
    for key,a in actual.items():
        b=expected[key]
        if np.isscalar(a):require(a==b,name+' scalar differs '+key)
        else:require(I.descriptor(a)==I.descriptor(b),name+' array differs '+key)


def roll_raw(x,W,fn):
    out=np.full(len(x),np.nan);all_invalid=np.zeros(len(x),bool);unavailable=(np.arange(len(x))<W-1) if len(x)>W else np.ones(len(x),bool)
    if len(x)>W:
        windows=np.lib.stride_tricks.sliding_window_view(np.where(np.isfinite(x),x,np.nan),W)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',RuntimeWarning);out[W-1:]=fn(windows,axis=1)
        all_invalid[W-1:]=~np.isfinite(windows).any(axis=1)
    return out,all_invalid,unavailable


def series_formula(ser,volume,har):
    """Independent arithmetic copy before filling/clipping; caller captures loader returns once."""
    n=len(ser.close)+1;lc=np.log(np.r_[np.nan,ser.close]);hi=np.r_[np.nan,ser.high];lo=np.r_[np.nan,ser.low]
    r=np.full(n,np.nan);r[1:]=lc[1:]-np.r_[np.nan,lc[1:-1]]
    with np.errstate(all='ignore'):rg=np.log(hi/lo)
    returned_none=volume is None;mismatch=not returned_none and len(volume)!=len(ser.close)
    ratio=np.full(n,np.nan);lv=np.zeros(n)
    if not returned_none and not mismatch:
        mean=NN.A6.window_mean_null_rule(volume,720,ser.start_i)
        with np.errstate(all='ignore'):ratio=np.log(np.r_[np.nan,volume]/mean)
        lv=np.where(np.isfinite(ratio),ratio,0.)
    hm,hm_all,hm_un=roll_raw(hi,24,np.nanmax);lm,lm_all,lm_un=roll_raw(lo,24,np.nanmin)
    R24=np.full(n,np.nan);R24[24:]=lc[24:]-lc[:-24]
    with np.errstate(all='ignore'):RG24=np.log(hm/lm)
    V24,v_all,v_un=roll_raw(lv,24,np.nanmean)
    _,vr_all,vr_un=roll_raw(ratio,24,np.nanmean)
    rv22,rv_all,rv_un=roll_raw(np.where(np.isfinite(r),r*r,np.nan),22,np.nanmean)
    with np.errstate(all='ignore'):lrv22=.5*np.log(8760*rv22);lpm=.5*np.log(har)[:,2]
    with np.errstate(all='ignore'):
        clean=dict(r=np.nan_to_num(r).astype(np.float32),rg=np.nan_to_num(rg).astype(np.float32),lv=np.clip(lv,-5,5).astype(np.float32),R24=np.nan_to_num(R24).astype(np.float32),RG24=np.nan_to_num(RG24).astype(np.float32),V24=np.clip(np.nan_to_num(V24),-5,5).astype(np.float32),lrv22=lrv22.astype(np.float32),lpm=lpm.astype(np.float32),base_ts=ser.base_ts)
    raw=dict(r=r,rg=rg,R24=R24,RG24=RG24,V24=V24,lv=lv,volume_ratio=ratio,volume_loader_returned_none=returned_none,volume_mismatch=mismatch,hm_all=hm_all,lm_all=lm_all,v_all=v_all,rv_all=rv_all,hm_un=hm_un,lm_un=lm_un,v_un=v_un,rv_un=rv_un,vr_all=vr_all,vr_un=vr_un)
    return clean,raw


def captured_series(spec):
    """Call original series_arrays once; tap, do not replace, its actual loader results."""
    captured={};old_series=NN.R12.load_series;old_volume=NN.D.load_volume;old_har=NN.A6.har_of
    def series(*args,**kwargs):
        value=old_series(*args,**kwargs);require('series' not in captured,'multiple series loads');captured['series']=value[0];return value
    def volume(*args,**kwargs):
        value=old_volume(*args,**kwargs);require('volume' not in captured,'multiple volume loads');captured['volume']=value;return value
    def har(*args,**kwargs):
        value=old_har(*args,**kwargs);require('har' not in captured,'multiple HAR loads');captured['har']=value;return value
    NN.R12.load_series=series;NN.D.load_volume=volume;NN.A6.har_of=har
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',RuntimeWarning);original=NN.series_arrays(spec)
    finally:NN.R12.load_series=old_series;NN.D.load_volume=old_volume;NN.A6.har_of=old_har
    require(set(captured)=={'series','volume','har'},'incomplete captured source inputs')
    clean,raw=series_formula(captured['series'],captured['volume'],captured['har']);exact(original,clean,'series')
    return original,raw


def counter(values,invalid=None,fallback=None,low=None,high=None):
    """Each row is an exposure; counters use genuine pre-transform masks, not filled zeros."""
    a=np.asarray(values);a=a.reshape((len(a),int(np.prod(a.shape[1:])) if a.ndim>1 else 1))
    inv=~np.isfinite(a) if invalid is None else np.broadcast_to(np.asarray(invalid,bool),np.shape(values)).reshape(a.shape)
    fb=np.zeros(a.shape,bool) if fallback is None else np.broadcast_to(np.asarray(fallback,bool),np.shape(values)).reshape(a.shape)
    lo=np.zeros(a.shape,bool) if low is None else a<low
    hi=np.zeros(a.shape,bool) if high is None else a>high
    eql=np.zeros(a.shape,bool) if low is None else a==low
    eqh=np.zeros(a.shape,bool) if high is None else a==high
    affected=inv|fb|lo|hi
    return dict(denominator=int(a.size),rows=len(a),invalid=int(inv.sum()),fallback=int(fb.sum()),strictly_clipped_low=int(lo.sum()),strictly_clipped_high=int(hi.sum()),equal_low_boundary=int(eql.sum()),equal_high_boundary=int(eqh.sum()),rows_affected=int(affected.any(axis=1).sum()))


def batch_formula(A,raw,sid,ts,F,Tidx,nT=3):
    """Separate original batch arithmetic with explicit pre-fill and pre-clip stages."""
    n=len(ts);require(n<=POLICY['batch_rows'],'batch bound');require(len(np.unique(sid))<=1,'single streamed canonical series required')
    ls=F['lsH'].astype(np.float32)
    with np.errstate(all='ignore'):scale=np.exp(ls)/math.sqrt(8760.)
    origin=((ts-A['base_ts'])//3600).astype(np.int64)
    hi0=origin[:,None]-np.arange(48)[None,::-1];di0=origin[:,None]-24*np.arange(30)[None,::-1]
    hi=np.clip(hi0,0,len(A['r'])-1);di=np.clip(di0,0,len(A['R24'])-1);ii=np.clip(origin,0,len(A['lrv22'])-1)
    H=np.stack([A[k][hi] for k in ('r','rg','lv')],axis=2).astype(np.float32)
    D=np.stack([A[k][di] for k in ('R24','RG24','V24')],axis=2).astype(np.float32)
    gap22=A['lrv22'][ii]-ls;gapM=ls-A['lpm'][ii]
    g22=np.where(np.isfinite(gap22),gap22,0.).astype(np.float32);gm=np.where(np.isfinite(gapM),gapM,0.).astype(np.float32)
    good_scale=np.isfinite(scale)&(scale>0);shc=np.where(good_scale,scale,.02)[:,None]
    with np.errstate(all='ignore'):
        H[:,:,0]/=shc;H[:,:,1]/=shc;D[:,:,0]/=shc*math.sqrt(24);D[:,:,1]/=shc*math.sqrt(24)
    static_raw=[F[k].astype(np.float32) for k in NN.STATIC]+[gap22,gapM]
    static_clean=[np.nan_to_num(F[k].astype(np.float32)) for k in NN.STATIC]+[g22,gm]
    oh=np.zeros((n,nT),np.float32);oh[np.arange(n),Tidx]=1
    S=np.column_stack(static_clean+[oh]);stage={}
    def add(name,values,**kwargs):stage[name]=(values,kwargs)
    for name,idx in (('hourly',hi0),('daily',di0)):
        add(name+'.indices',idx,invalid=np.zeros_like(idx,bool),fallback=(idx<0)|(idx>=len(A['r'])))
    for name,k,ix in (('hourly.return_raw','r',hi),('hourly.range_raw','rg',hi),('daily.return_raw','R24',di),('daily.range_raw','RG24',di),('daily.volume_rolling_raw','V24',di)):
        value=raw[k][ix];add(name,value,fallback=~np.isfinite(value))
    for name,ix in (('hourly',hi),('daily',di)):
        add(name+'.volume_loader_returned_none',np.zeros(ix.shape),invalid=np.zeros(ix.shape,bool),fallback=np.full(ix.shape,raw['volume_loader_returned_none']))
        add(name+'.volume_mismatch',np.zeros(ix.shape),invalid=np.zeros(ix.shape,bool),fallback=np.full(ix.shape,raw['volume_mismatch']))
    add('hourly.volume_ratio_raw',raw['volume_ratio'][hi],fallback=~np.isfinite(raw['volume_ratio'][hi]))
    add('hourly.volume_before_clip5',raw['lv'][hi],low=-5,high=5)
    add('daily.volume_before_clip5',raw['V24'][di],fallback=~np.isfinite(raw['V24'][di]),low=-5,high=5)
    for field,ix in (('hm',di),('lm',di),('v',di),('vr',di),('rv',ii[:,None])):
        add('rolling.'+field+'.all_invalid',np.zeros(ix.shape),invalid=raw[field+'_all'][ix])
        add('rolling.'+field+'.unavailable',np.zeros(ix.shape),invalid=raw[field+'_un'][ix])
    add('scale.hourly_HAR',scale,fallback=~good_scale)
    add('gap22.before_fallback',gap22,fallback=~np.isfinite(gap22));add('gapM.before_fallback',gapM,fallback=~np.isfinite(gapM))
    for group,values in (('hourly',H),('daily',D)):
        for j,field in enumerate(('return','range','volume')):add(group+'.normalized_before_clip10.'+field,values[:,:,j],low=-10,high=10)
    names=list(NN.STATIC)+['gap22','gapM']+[f'T_onehot_{j}' for j in range(nT)]
    for j,name in enumerate(names):
        unfilled=static_raw[j] if j<len(static_raw) else oh[:,j-len(static_raw)]
        add('static.'+name,S[:,j],invalid=~np.isfinite(unfilled),fallback=~np.isfinite(unfilled),low=-20,high=20)
    return dict(H=np.clip(H,-10,10),D=np.clip(D,-10,10),S=np.clip(S,-20,20)),stage


def roles_replay(R,keys,receipts,meta,max_train=60000,caps=None):
    caps=caps or CAPS;I.replay(R,keys,receipts,meta,max_train=max_train,caps=caps)
    g=I.groups(keys,R['sid']);split=I.split_time(R['ts']);ts=R['ts'];rng=np.random.default_rng(20261903);roles=[];ordinal=0
    for sh in (0,1):
        for tt in (0,1):
            te=np.flatnonzero((g%2==sh)&((ts>=split) if tt else (ts<split))&(ts%86400==0))
            tr_all=np.flatnonzero((g%2!=sh)&((ts+43200<=split) if tt else (ts>=split+43200)))
            vg=int(g[tr_all].min());va=tr_all[g[tr_all]==vg];tr=tr_all[g[tr_all]!=vg]
            if len(tr)>max_train:tr=rng.choice(tr,max_train,replace=False)
            if len(va)>max_train:va=rng.choice(va,max_train,replace=False)
            for model in I.MODELS:
                chosen=tr[:caps[model]];r=receipts[ordinal]
                for role,indices in (('train',chosen),('validation',va),('test',te)):
                    original={'train':'tr','validation':'va','test':'te'}[role]
                    require(I.membership(indices,R,g)==r['membership'][original],'replayed role membership mismatch')
                    roles.append(dict(ordinal=ordinal,model=model,cell=[sh,tt],role=role,indices=indices))
                for _ in range(meta[ordinal]['epochs']):rng.permutation(chosen)
                ordinal+=1
    return roles,split


def access_guard(root,allowed,*,metadata=(),sources=(),runtime_roots=(),integrity_pins=(),output=None):
    """Post-admission body guard: data reads exact allowlist; integrity hashes separate.

    Admission itself reads explicit evidence solely for integrity/schema validation before
    installing this guard. Runtime exceptions cover code/shared-library/certificate files
    beneath the fixed interpreter prefixes, never arbitrary data archives there.
    """
    root=Path(root).resolve();allowed={str(Path(p).resolve()) for p in allowed}
    feature_files=allowed|{str(Path(p).resolve()) for p in metadata}|{str(Path(p).resolve()) for p in sources}
    roots=[Path(p).resolve() for p in runtime_roots];output=str(Path(output).resolve()) if output is not None else None
    reads={};state={'active':True,'violations':[],'hash_only_target':None,'integrity_pins':{p['path']:p for p in integrity_pins}}
    code_suffixes={'.py','.pyc','.so','.dylib','.pyd','.pth','.zip','.pem'}
    def deny(reason):
        state['violations'].append(reason);raise PermissionError(reason)
    def predicted(path):return path.name.startswith('rows-nn-') and path.suffix=='.npz' or path.name=='dev-r162-nn.json'
    def runtime_code(path):return path.suffix in code_suffixes and any(path.is_relative_to(prefix) for prefix in roots)
    def resolve(value):
        if isinstance(value,int):deny('descriptor data access prohibited')
        return Path(os.path.abspath(os.fsdecode(value))).resolve()
    def hook(event,args):
        if not state['active']:return
        no_torch()
        if event=='import' and (args[0]=='torch' or args[0].startswith('torch.')):deny('Torch import prohibited')
        if event.startswith('socket.') or event in ('subprocess.Popen','os.system'):deny('network/subprocess prohibited')
        if event in ('os.remove','os.rename','os.rmdir','os.mkdir','os.link','os.symlink','os.truncate','os.chmod','os.chown'):deny('data mutation prohibited: '+event)
        if event in ('os.listdir','os.scandir'):
            path=resolve(args[0])
            if not (path.is_relative_to(root) or any(path.is_relative_to(prefix) for prefix in roots)):deny('unadmitted directory enumeration')
        if event!='open':return
        target=resolve(args[0]);path=str(target);mode=args[1];flags=args[2] or 0
        writing=bool(flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or isinstance(mode,str) and any(k in mode for k in 'wax+')
        if writing:
            if path!=output or not flags&os.O_EXCL or target.exists():deny('unadmitted data write: '+path)
            return
        hash_only=state['hash_only_target']==path and path in state['integrity_pins']
        if not hash_only and (predicted(target) or not (path in feature_files or runtime_code(target))):deny('unadmitted data read: '+path)
        if target.is_relative_to(root) and not hash_only:reads[path]=reads.get(path,0)+1
    return hook,state,reads


def check_resources(start,out,policy):
    no_torch();rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform!='darwin':rss*=1024
    require(rss<=policy['rss_bytes'],'feature census RSS cap exceeded')
    require(time.monotonic()-start<=policy['wall_seconds'],'feature census wall cap exceeded')
    require(shutil.disk_usage(Path(out).parent).free>=policy['disk_reserve_bytes'],'feature census free disk reserve breached')
    return rss


def authenticate(request_path,digest):
    require(I.sha(request_path)==digest,'request SHA mismatch');request=I.load(request_path)
    require(request.get('schema')==SCHEMA and request.get('policy')==POLICY,'fixed feature census request/policy required')
    require(request.get('support')==dict(models=list(I.MODELS),cells=[[s,t] for s in (0,1) for t in (0,1)],roles=['train','validation','test'],horizons=[1,3,12],HW=48,DW=30,static=list(NN.STATIC),gap_features=2,horizon_onehot=3),'predetermined census support required')
    for p in request['artifacts'].values():check_pin(p)
    require(request['artifacts']['implementation']==pin(__file__),'census source request binding required')
    scope=I.load(request['artifacts']['scope']['path']);ind=I.load(request['artifacts']['independent_fit']['path']);desc=I.load(request['artifacts']['descriptive']['path'])
    digest=request['artifacts']['scope']['sha256']
    require(scope.get('phase')=='fit' and ind.get('complete') is True and ind.get('scope_sha256')==digest and ind.get('fit_replay',{}).get('fits')==20,'accepted exact twenty-fit scope required')
    require(desc.get('complete') is True and desc.get('scope_sha256')==digest and desc.get('independent_fit_sha256')==request['artifacts']['independent_fit']['sha256'],'accepted descriptive evidence identity required')
    evidence=scope['evidence'];require(len(evidence['raw_pins'])==282 and len(evidence['canonical_keys'])==277 and set(evidence['inputs'])==set(I.INPUTS),'exact raw/merged/canonical support required')
    pins={}
    for p in list(ind['evidence_pins'])+list(desc['evidence_pins'])+evidence['raw_pins']+list(evidence['inputs'].values())+list(request['artifacts'].values()):
        v=check_pin(p);pins[v['path']]=v
    sources={}
    for mapping in (scope['source_sha256'],ind['source_sha256'],desc['source_sha256']):
        for path,sha in mapping.items():
            p=Path(path) if Path(path).is_absolute() else I.ROOT/path;require(I.sha(p)==sha,'source pin changed');sources[str(p)]=sha
    runtime=scope['runtime']['base'];current=sorted([d.metadata['Name'].lower(),d.version] for d in md.distributions() if d.metadata.get('Name'))
    require(current==runtime['packages'] and sys.executable==runtime['executable'] and sys.version==runtime['python'] and platform.machine()==runtime['machine'],'exact restored runtime required')
    require(np.__version__==ind['numpy_version'],'NumPy changed')
    no_torch();return request,scope,ind,pins,sources


def run(request_path,digest,out):
    global ACTIVE_GUARD
    start=time.monotonic();out=Path(out).resolve();require(not out.exists(),'fresh output required');request,scope,ind,pins,sources=authenticate(request_path,digest)
    require(str(out)==request['output_path'],'output differs from frozen diagnostic request')
    allowed=[p['path'] for p in scope['evidence']['raw_pins']]
    metadata=[p['path'] for p in pins.values() if Path(p['path']).suffix=='.json' and Path(p['path']).name!='dev-r162-nn.json']
    metadata+=[str(request_path)]+[p['path'] for p in scope['evidence']['inputs'].values()]
    hook,state,reads=access_guard(scope['evidence']['datasets'],allowed,metadata=metadata,sources=list(sources)+[p['path'] for p in request['artifacts'].values() if Path(p['path']).suffix=='.py'],runtime_roots=(sys.prefix,sys.base_prefix),integrity_pins=list(pins.values()),output=out)
    ACTIVE_GUARD=state;sys.addaudithook(hook)
    try:
        peak=check_resources(start,out,request['policy']);base=Path(scope['evidence']['inputs']['rows-meta.json']['path']).parent;fitout=Path(scope['out'])
        receipts=[I.load(fitout/f'fit-{i:02d}.json') for i in range(20)];meta=I.load(fitout/'nn-meta.json')['info']['shallow']['fits']
        require([r['epochs'] for r in meta]==[4]*20,'frozen diagnostic expects actual twenty four-epoch fits')
        R=I.core_rows(base)
        for k in NN.STATIC:
            R[k]=np.concatenate([np.load(base/f'rows-T{T}.npz',allow_pickle=False)[k] for T in I.HORIZONS])
        require(I.replay(R,scope['evidence']['canonical_keys'],receipts,meta)==ind['fit_replay'],'independent recorded RNG replay differs')
        roles,split=roles_replay(R,scope['evidence']['canonical_keys'],receipts,meta)
        # Memberships fully checked before source/feature counters are accepted.
        keys=scope['evidence']['canonical_keys'];specs=NN.D.R12.dev_specs(scope['evidence']['datasets']);mapping={}
        for spec in specs:
            key=spec['key']
            require(key not in mapping,'duplicate canonical input key');mapping[key]=spec
        require(set(keys)==set(mapping),'missing or unknown canonical input specifications')
        results={};expected={};compared=0;field_contract=None
        for role in roles:
            for T in I.HORIZONS:
                tag=f"{role['ordinal']:02d}/{role['role']}/T{T}";n=int(np.sum(R['T'][role['indices']]==T));expected[tag]=n
                results[tag]=dict(ordinal=role['ordinal'],model=role['model'],cell=role['cell'],role=role['role'],horizon_hours=T,rows=n,fields={})
        metadata=dict(canonical_series=0,volume_loader_returned_none_series=0,volume_mismatch_series=0)
        for sid,key in enumerate(keys):
            require(not state['violations'],'caught prohibited access invalidates audit')
            peak=max(peak,check_resources(start,out,request['policy']));A,raw=captured_series(mapping[key]);metadata['canonical_series']+=1
            metadata['volume_loader_returned_none_series']+=int(raw['volume_loader_returned_none']);metadata['volume_mismatch_series']+=int(raw['volume_mismatch'])
            selected={i:r['indices'][R['sid'][r['indices']]==sid] for i,r in enumerate(roles)}
            union=np.unique(np.concatenate(list(selected.values())))
            for begin in range(0,len(union),POLICY['batch_rows']):
                ix=union[begin:begin+POLICY['batch_rows']];F={k:R[k][ix] for k in NN.STATIC};sidv=R['sid'][ix];ts=R['ts'][ix];tidx=R['Tidx'][ix]
                calculated,stage=batch_formula(A,raw,sidv,ts,F,tidx)
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore',RuntimeWarning);H,D,S=NN.build_batch({sid:A},sidv,ts,F,tidx,3)
                exact(dict(H=H,D=D,S=S),calculated,'batch');compared+=len(ix)
                if field_contract is None:field_contract=set(stage)
                require(set(stage)==field_contract,'feature counter contract changed')
                for j,role in enumerate(roles):
                    belongs=np.isin(ix,selected[j],assume_unique=True)
                    if not belongs.any():continue
                    for T in I.HORIZONS:
                        use=belongs&(R['T'][ix]==T)
                        if not use.any():continue
                        tag=f"{role['ordinal']:02d}/{role['role']}/T{T}";fields=results[tag]['fields']
                        for name,(value,kwargs) in stage.items():
                            kwargs={k:(v[use] if isinstance(v,np.ndarray) else v) for k,v in kwargs.items()}
                            delta=counter(value[use],**kwargs);aggregate=fields.setdefault(name,{k:0 for k in delta})
                            for k,v in delta.items():aggregate[k]+=v
                peak=max(peak,check_resources(start,out,request['policy']))
            del A,raw
        require(not state['violations'],'caught prohibited access invalidates audit')
        require(metadata['canonical_series']==277,'all canonical series required')
        for tag,result in results.items():
            if result['rows']:
                require(set(result['fields'])==field_contract and all(f['rows']==result['rows'] for f in result['fields'].values()),'stratum denominator coverage mismatch '+tag)
            else:
                result['fields']={name:counter(np.empty((0,1))) for name in field_contract}
        for p in pins.values():check_pin(p)
        for path,sha in sources.items():require(I.sha(path)==sha,'source changed during census')
        peak=max(peak,check_resources(start,out,request['policy']))
        require(I.sha(request_path)==digest,'request changed during census')
        value=dict(schema='codex-r16-shallow-feature-quality-v2',complete=True,request=pin(request_path),scope_sha256=request['artifacts']['scope']['sha256'],independent_fit_sha256=request['artifacts']['independent_fit']['sha256'],descriptive_sha256=request['artifacts']['descriptive']['sha256'],membership_fits_verified=20,membership_roles_verified=60,strata=results,series_metadata=metadata,unique_batch_rows_compared=compared,tsplit_float=split,raw_read_counts=reads,evidence_pins=list(pins.values()),source_sha256=sources,telemetry=dict(elapsed_seconds=time.monotonic()-start,peak_process_rss_bytes=peak,peak_definition='resource.getrusage(RUSAGE_SELF).ru_maxrss; process high-water mark, bytes on macOS; resource checks at admission/series/batch boundaries, external parent monitor required for asynchronous enforcement',final_free_disk_bytes=shutil.disk_usage(out.parent).free),volume_none_definition='volume_loader_returned_none means unchanged D.load_volume returned None, conflating non-grid, missing column, parse/read exceptions; it does not establish actual missing-source prevalence. Mismatch separately records a returned vector of wrong length.',access_boundary='Admission hashes/schema-checks explicit evidence before the body guard. After admission, exact admitted raw/merged/metadata/source reads and runtime code resources only; prediction archives/score payload are permitted solely inside check_pin streamed integrity hashing, never feature loading. Writes restricted to exact fresh output; caught denials invalidate census.',counter_definition='invalid is nonfinite prefill value (or explicit genuine raw mask); fallback is original invalid/index substitution; strict clips use <lower or >upper, equality counted separately; rows_affected union of invalid/fallback/strict clipping. Element fractions derive count/denominator; rows_affected fraction derives rows_affected/rows, null denominator zero. Reused role exposures are not summed into independent sample claims.',limitations=LIMITATION)
        data=json.dumps(value,separators=(',',':'),allow_nan=False).encode();require(len(data)<=POLICY['output_bytes'],'aggregate output cap exceeded')
        with open(out,'xb') as f:f.write(data)
        return value
    finally:
        state['active']=False;ACTIVE_GUARD=None


def main():
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();run(a.request,a.request_sha256,a.out)
if __name__=='__main__':main()
