"""CODEX CONTINUATION: posthoc descriptive error strata on fixed original daily support.
Six flags are frozen before row outcomes are read. No fitting, selection or causal claims.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import warnings
import numpy as np

E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
spec=importlib.util.spec_from_file_location('accepted_feature_quality',E/'audit_shallow_feature_quality.py')
Q=importlib.util.module_from_spec(spec);spec.loader.exec_module(Q)
I=Q.I;NN=Q.NN
SCHEMA='codex-r16-shallow-feature-error-strata-request-v2'
POLICY=dict(rss_bytes=2500000000,disk_reserve_bytes=2000000000,wall_seconds=1800,batch_rows=1024,output_bytes=5000000)
FLAGS=('hourly_range_outside_clip10','daily_range_outside_clip10','HAR_scale_fallback','static_lvol_nonfinite','hourly_return_window_nonfinite','volume_loader_returned_none')
CENSUS_COUNTERS={
    FLAGS[0]:('hourly.normalized_before_clip10.range','rows_affected'),
    FLAGS[1]:('daily.normalized_before_clip10.range','rows_affected'),
    FLAGS[2]:('scale.hourly_HAR','fallback'),
    FLAGS[3]:('static.lvol','invalid'),
    FLAGS[4]:('hourly.return_raw','rows_affected'),
    FLAGS[5]:('hourly.volume_loader_returned_none','rows_affected')}
LEVELS={1:(-.02,-.03,-.05),3:(-.02,-.03,-.05,-.07),12:(-.02,-.03,-.05,-.07,-.10)}
LIMITATIONS=('POSTHOC DESCRIPTIVE outcome-linked audit on seen-development daily support; not causal intervention, fresh validation, model selection, p-values, tuning or promotion evidence. All models, original hash/time partitions, horizons/barriers and both values of all six flags are retained, including zero support. Flags overlap and observations/labels are reused across models/flags; counts are not independent sample totals. Early-time cells train on future peer-series support. A flag contrast does not establish that the flagged transformation caused harm. Volume loader None conflates non-grid, missing column and swallowed parse/read exceptions, not true source absence. No new data, labels, fits, predictions, scoring recipe or clipping changes.')


def require(c,message):
    if not c:raise ValueError(message)


def stage_flags(stage):
    """Flags use genuine pre-transform arrays/masks, not sanitized zero or clip equality."""
    h=stage['hourly.normalized_before_clip10.range'][0];d=stage['daily.normalized_before_clip10.range'][0]
    return np.column_stack([
        ((h < -10)|(h > 10)).any(axis=1),
        ((d < -10)|(d > 10)).any(axis=1),
        stage['scale.hourly_HAR'][1]['fallback'],
        stage['static.lvol'][1]['invalid'],
        (~np.isfinite(stage['hourly.return_raw'][0])).any(axis=1),
        stage['hourly.volume_loader_returned_none'][1]['fallback'].any(axis=1)]).astype(bool)


def partition_masks(sid,ts,keys,split):
    ts=np.asarray(ts);g=I.groups(keys,sid);daily=ts%86400==0
    masks={(sh,tt):daily&(g%2==sh)&((ts>=split) if tt else (ts<split)) for sh in (0,1) for tt in (0,1)}
    require(np.array_equal(sum(m.astype(np.int8) for m in masks.values()),daily.astype(np.int8)),'exact daily partition required')
    return masks


def metrics(y,f,p):
    y=np.asarray(y,dtype=np.float64);f=np.asarray(f,dtype=np.float64);p=np.asarray(p,dtype=np.float64)
    require(y.ndim==1 and y.shape==f.shape==p.shape,'metric shape mismatch')
    require(np.isfinite(y).all() and np.isin(y,[0,1]).all(),'invalid binary label')
    require(np.isfinite(f).all() and np.isfinite(p).all() and ((f>=0)&(f<=1)).all() and ((p>=0)&(p<=1)).all(),'invalid probability')
    names=('observed_rate','predicted_mean','fH_mean','brier_model','brier_fH','brier_difference','BSS','model_calibration_ratio','fH_calibration_ratio')
    if not len(y):return dict(n=0,positive_count=0,**{k:None for k in names})
    rate=float(y.mean());bm=float(np.mean((p-y)**2));bf=float(np.mean((f-y)**2));pm=float(p.mean());fm=float(f.mean())
    return dict(n=len(y),positive_count=int(y.sum()),observed_rate=rate,predicted_mean=pm,fH_mean=fm,brier_model=bm,brier_fH=bf,brier_difference=bm-bf,BSS=1-bm/bf if bf>0 else None,model_calibration_ratio=pm/rate if rate else None,fH_calibration_ratio=fm/rate if rate else None)


def reconcile(flags,mask,census_record):
    require(flags.dtype==np.bool_ and flags.ndim==2 and flags.shape[1]==6 and mask.dtype==np.bool_ and mask.shape==(len(flags),),'flag/support shape mismatch')
    n=int(mask.sum());require(census_record['role']=='test' and census_record['rows']==n,'accepted test census support differs')
    result={}
    for j,name in enumerate(FLAGS):
        field,key=CENSUS_COUNTERS[name];expected=census_record['fields'][field][key];actual=int(flags[mask,j].sum())
        require(actual==expected,'flag count differs from accepted census: '+name)
        result[name]=dict(flagged_rows=actual,unflagged_rows=n-actual,census_field=field,census_counter=key)
    return result


def phase_guard(scope,pins,sources,request_path,output,prediction_paths):
    """NEW protocol explicitly admits exact pinned prediction reads only for RAM preload.
    Once phase becomes feature, unchanged Q.guard blocks all further prediction loads
    except streamed pin hashing. Original merged NPZ inputs remain admitted and contain
    outcomes; this is not a column-level outcome-access barrier. Metrics use preloaded Y.
    """
    allowed=[p['path'] for p in scope['evidence']['raw_pins']]
    metadata=[p['path'] for p in pins.values() if Path(p['path']).suffix=='.json' and Path(p['path']).name!='dev-r162-nn.json']
    metadata+=[str(request_path)]+[p['path'] for p in scope['evidence']['inputs'].values()]
    base,state,reads=Q.access_guard(scope['evidence']['datasets'],allowed,metadata=metadata,sources=list(sources)+[p['path'] for p in pins.values() if Path(p['path']).suffix=='.py'],runtime_roots=(sys.prefix,sys.base_prefix),integrity_pins=list(pins.values()),output=output)
    paths={str(Path(p).resolve()) for p in prediction_paths};require(paths<=set(pins),'prediction admission pins required')
    state['phase']='preload';state['prediction_preload_reads']={}
    def hook(event,args):
        if not state['active']:return
        Q.no_torch()
        if event=='open' and not isinstance(args[0],int):
            path=str(Path(os.path.abspath(os.fsdecode(args[0]))).resolve());mode=args[1];flags=args[2] or 0
            writing=bool(flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or isinstance(mode,str) and any(k in mode for k in 'wax+')
            if state['phase']=='preload' and path in paths and not writing:
                state['prediction_preload_reads'][path]=state['prediction_preload_reads'].get(path,0)+1
                return
        base(event,args)
    return hook,state,reads


def authenticate(request_path,digest):
    require(I.sha(request_path)==digest,'request SHA mismatch');r=I.load(request_path)
    require(r.get('schema')==SCHEMA and r.get('policy')==POLICY,'fixed protocol/policy required')
    require(r.get('flags')==list(FLAGS) and r.get('expected_slices')==2880,'all six fixed flags and 2880 slices required')
    a=r['artifacts']
    for p in a.values():Q.check_pin(p)
    require(a['implementation']==Q.pin(__file__),'new implementation request binding differs')
    require(a['feature_helper']['sha256']=='5755376aae4aadd0fc01c89ac68fe5761ede4b58ec3e26bdf96ba6cef796f7d7' and a['feature_helper']==Q.pin(Q.__file__),'unchanged accepted feature helper required')
    old,scope,ind,pins,sources=Q.authenticate(a['census_request']['path'],a['census_request']['sha256'])
    require(a['scope']==old['artifacts']['scope'] and a['independent_fit']==old['artifacts']['independent_fit'] and a['descriptive']==old['artifacts']['descriptive'],'original evidence chain differs')
    census=I.load(a['census']['path']);accepted=I.load(a['census_acceptance']['path'])
    require(accepted.get('complete') is True and accepted.get('census')==a['census'] and accepted.get('request')==a['census_request'] and accepted.get('implementation')==a['feature_helper'],'accepted census identity differs')
    require(census.get('complete') is True and census.get('schema')=='codex-r16-shallow-feature-quality-v3' and census.get('scope_sha256')==a['scope']['sha256'] and census.get('independent_fit_sha256')==a['independent_fit']['sha256'] and census.get('descriptive_sha256')==a['descriptive']['sha256'],'complete matching original census required')
    require(census.get('membership_fits_verified')==20 and census.get('membership_roles_verified')==60 and len(census.get('strata',{}))==180,'all accepted census strata required')
    for p in census['evidence_pins']+list(a.values()):
        actual=Q.check_pin(p);pins[actual['path']]=actual
    for path,sha in census['source_sha256'].items():require(I.sha(path)==sha,'census original source changed');sources[path]=sha
    out=Path(scope['out']);require(Path(a['score_output']['path'])==out/'dev-r162-nn.json','exact original score output required')
    score=I.load(out/'score.json');monitor=I.load(out/'score-monitor.json');start=I.load(out/'score-monitor-start.json')
    require(score.get('complete') is True and score.get('phase')=='score' and score.get('scope_sha256')==a['scope']['sha256'] and score.get('output')==a['score_output'] and score.get('audit_violations')=={'total':0,'attempts':[]},'successful original score receipt required')
    I.monitor_admission(monitor,start,'score',a['scope']['sha256']);require(monitor.get('child_receipt')==Q.pin(out/'score.json'),'score monitor child pin differs')
    policy=scope['score_resource_policy'];require(monitor['elapsed_seconds']<=policy['wall_seconds'] and monitor['peak_sampled_child_rss_bytes']<=policy['rss_bytes'],'original score budget failed')
    require(I.load(a['score_output']['path']).get('schema')=='q26-r16.2-dev-nn/1','original score payload schema required')
    Q.no_torch();return r,scope,ind,census,pins,sources


def preload_daily(scope,ind):
    """Only explicitly admitted existing labels/reference/predictions; no recomputation."""
    base=Path(scope['evidence']['inputs']['rows-meta.json']['path']).parent;out=Path(scope['out']);keys=scope['evidence']['canonical_keys']
    R=I.core_rows(base);split=I.split_time(R['ts'])
    receipts=[I.load(out/f'fit-{i:02d}.json') for i in range(20)];meta=I.load(out/'nn-meta.json')['info']['shallow']['fits']
    require(I.replay(R,keys,receipts,meta)==ind['fit_replay'],'accepted original membership replay differs')
    coverage=I.coverage(base,out);require(coverage==ind['coverage'],'all-five prediction coverage differs')
    del R
    tables={};parts=[];offset=0
    for j,T in enumerate(I.HORIZONS):
        with np.load(base/f'rows-T{T}.npz',allow_pickle=False) as z:
            ts=z['ts'];daily=ts%86400==0
            table=dict(sid=z['sid'][daily],ts=ts[daily],y=z['y'][daily],fH=z['fH'][daily],F={k:z[k][daily] for k in NN.STATIC},predictions={})
        require(table['y'].shape==table['fH'].shape==(int(daily.sum()),len(LEVELS[T])),'daily outcome/reference shape mismatch')
        require(np.isfinite(table['y']).all() and np.isin(table['y'],[0,1]).all(),'daily binary outcome invalid')
        require(np.isfinite(table['fH']).all() and ((table['fH']>=0)&(table['fH']<=1)).all(),'daily reference invalid')
        with np.load(out/f'rows-nn-T{T}.npz',allow_pickle=False) as z:
            for model in I.MODELS:
                p=z[model][daily];require(p.shape==table['y'].shape and np.isfinite(p).all() and ((p>=0)&(p<=1)).all(),'missing/nonfinite daily prediction');table['predictions'][model]=p
        n=len(table['ts']);table['global_slice']=slice(offset,offset+n);table['partitions']=partition_masks(table['sid'],table['ts'],keys,split)
        offset+=n;tables[T]=table;parts.append(dict(sid=table['sid'],ts=table['ts'],T=np.full(n,T,np.int32),Tidx=np.full(n,j,np.int32),F=table['F']))
    pooled={k:np.concatenate([p[k] for p in parts]) for k in ('sid','ts','T','Tidx')}
    pooled['F']={k:np.concatenate([p['F'][k] for p in parts]) for k in NN.STATIC}
    return tables,pooled,split


def run(request_path,digest,output):
    start=time.monotonic();output=Path(output).resolve();require(not output.exists(),'fresh output required')
    r,scope,ind,census,pins,sources=authenticate(request_path,digest);require(str(output)==r['output_path'],'frozen output differs')
    prediction_paths=[str(Path(scope['out'])/f'rows-nn-T{T}.npz') for T in I.HORIZONS]
    hook,state,reads=phase_guard(scope,pins,sources,request_path,output,prediction_paths);Q.ACTIVE_GUARD=state;sys.addaudithook(hook)
    try:
        peak=Q.check_resources(start,output,POLICY);tables,pooled,split=preload_daily(scope,ind)
        require(split==census['tsplit_float'],'global split differs from accepted census')
        require(not state['violations'],'caught prohibited preload access invalidates audit');state['phase']='feature'
        keys=scope['evidence']['canonical_keys'];specs=NN.D.R12.dev_specs(scope['evidence']['datasets']);mapping={s['key']:s for s in specs}
        require(len(mapping)==len(specs) and set(mapping)==set(keys),'exact canonical specifications required')
        flags=np.zeros((len(pooled['ts']),6),bool);visited=np.zeros(len(flags),np.int8);series_count=0
        for sid,key in enumerate(keys):
            peak=max(peak,Q.check_resources(start,output,POLICY));A,raw=Q.captured_series(mapping[key]);series_count+=1
            ix=np.flatnonzero(pooled['sid']==sid)
            for begin in range(0,len(ix),1024):
                ii=ix[begin:begin+1024];F={k:v[ii] for k,v in pooled['F'].items()}
                calc,stage=Q.batch_formula(A,raw,pooled['sid'][ii],pooled['ts'][ii],F,pooled['Tidx'][ii])
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore',RuntimeWarning);h,d,s=NN.build_batch({sid:A},pooled['sid'][ii],pooled['ts'][ii],F,pooled['Tidx'][ii],3)
                Q.exact(dict(H=h,D=d,S=s),calc,'outcome-strata feature batch');flags[ii]=stage_flags(stage);visited[ii]+=1
                peak=max(peak,Q.check_resources(start,output,POLICY))
            require(not state['violations'],'caught prohibited feature access invalidates audit')
            del A,raw
        require(series_count==277 and np.all(visited==1),'every original daily row once/all series required')
        reconciliation={}
        for T,table in tables.items():
            local=flags[table['global_slice']]
            for sh in (0,1):
                for tt in (0,1):
                    mask=table['partitions'][sh,tt]
                    for im,model in enumerate(I.MODELS):
                        ordinal=(sh*2+tt)*5+im;tag=f'{ordinal:02d}/test/T{T}';record=census['strata'][tag]
                        require(record['model']==model and record['cell']==[sh,tt] and record['horizon_hours']==T,'census model/cell identity differs')
                        reconciliation[tag]=reconcile(local,mask,record)
        require(len(reconciliation)==60,'all sixty model/cell/horizon test counts required')
        # No metric is accepted until every predetermined flag matches accepted census totals.
        cells=[]
        for T,table in tables.items():
            local=flags[table['global_slice']]
            for model in I.MODELS:
                for (sh,tt),partition in table['partitions'].items():
                    for j,level in enumerate(LEVELS[T]):
                        for k,flag in enumerate(FLAGS):
                            for yes in (False,True):
                                use=partition&(local[:,k]==yes)
                                cells.append(dict(model=model,hash_half=sh,time_half=tt,horizon_hours=T,barrier=level,flag=flag,flag_value=yes,**metrics(table['y'][use,j],table['fH'][use,j],table['predictions'][model][use,j])))
            peak=max(peak,Q.check_resources(start,output,POLICY))
        require(len(cells)==2880,'all fixed slices including zero support required')
        for p in pins.values():Q.check_pin(p)
        for path,sha in sources.items():require(I.sha(path)==sha,'source changed during audit')
        require(I.sha(request_path)==digest and not state['violations'],'request changed or prohibited access caught')
        peak=max(peak,Q.check_resources(start,output,POLICY))
        value=dict(schema='codex-r16-shallow-feature-error-strata-v2',complete=True,request=Q.pin(request_path),scope_sha256=r['artifacts']['scope']['sha256'],census_sha256=r['artifacts']['census']['sha256'],census_acceptance_sha256=r['artifacts']['census_acceptance']['sha256'],flags=list(FLAGS),cells=cells,census_reconciliation=reconciliation,canonical_series=series_count,daily_rows_bitwise_compared=len(flags),tsplit_float=split,prediction_preload_reads=state['prediction_preload_reads'],feature_raw_reads=reads,evidence_pins=list(pins.values()),source_sha256=sources,telemetry=dict(elapsed_seconds=time.monotonic()-start,peak_process_rss_bytes=peak,definition='Process high-water RSS and boundary resource checks; parent external monitor required for asynchronous enforcement.'),metrics_definition='Unclipped stored probabilities; Brier difference=model minus fH; BSS=1-model_Brier/fH_Brier, null fH_Brier zero; calibration ratio=predicted_mean/observed_rate, null zero positives; zero support retained with null metrics.',access_boundary='New protocol explicitly admits existing prediction archive reads during fixed RAM preload; thereafter unchanged accepted feature guard denies prediction file loads except exact streamed integrity rechecks. Original merged input NPZ archives remain admitted for features and contain Y/fH; the guard does not enforce column-level outcome isolation. Metrics use admitted preloaded Y/fH/prediction columns. All prior helpers remain unchanged.',limitations=LIMITATIONS)
        data=json.dumps(value,separators=(',',':'),allow_nan=False).encode();require(len(data)<=POLICY['output_bytes'],'aggregate output cap exceeded')
        with open(output,'xb') as f:f.write(data)
        return value
    finally:state['active']=False;Q.ACTIVE_GUARD=None


def main():
    p=argparse.ArgumentParser()
    for name in ('request','request-sha256','out'):p.add_argument('--'+name,required=True)
    a=p.parse_args();run(a.request,a.request_sha256,a.out)
if __name__=='__main__':main()
