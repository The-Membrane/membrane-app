"""Saved-only descriptive paired precision; no fitting, power or confirmation."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import types
import numpy as np

READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_C_PAIRED_PRECISION'
B=10000;SEED=20261022;S=277;DAY=86400;BLOCK=28*DAY;EPS=1e-6
R_SHA='5325108572f861c414c48c0b808c6720d52240dc2383a3c9936c9c33acb73533'
DG_SHA='af5e3e5d283ac38eb71e637aa66874a210687b22db7e1862ded40d3d16e1f123'

def need(ok,msg):
    if not ok:raise ValueError(msg)

def delta(C,A,y):
    C=np.asarray(C,np.float64);A=np.asarray(A,np.float64);y=np.asarray(y,np.float64)
    c=np.clip(C,EPS,1-EPS);a=np.clip(A,EPS,1-EPS)
    return np.stack(((C-y)**2-(A-y)**2,(-y*np.log(c)-(1-y)*np.log1p(-c))-(-y*np.log(a)-(1-y)*np.log1p(-a))),axis=-1)

def sufficient(sid,ts,A,C,y,known,*,status='DRAFT'):
    need(status in(READY,ADMITTED),'DRAFT')
    n=len(ts);need(sid.dtype==np.int32 and ts.dtype==np.int64 and y.dtype==np.uint8 and known.dtype==bool and all(v.shape==(n,) for v in (sid,ts,A,C,y,known)),'row schema')
    need(A.dtype==C.dtype==np.float64 and np.isfinite(A).all() and np.isfinite(C).all() and np.all((A>=0)&(A<=1)&(C>=0)&(C<=1)),'probability schema')
    need(np.all((sid>=0)&(sid<S)) and np.all((ts>=1704067200)&(ts<1767225600)&(ts%DAY==0)) and np.isin(y[known],[0,1]).all(),'target rows')
    need(int(np.sum(~known))<=1,'at most one unknown fixed target')
    keys=list(zip(sid.tolist(),ts.tolist()));need(len(keys)==len(set(keys)),'duplicate keys')
    blocks,bi=np.unique(ts//BLOCK,return_inverse=True);year=(ts>=1735689600).astype(np.int8);shape=(S,len(blocks),2)
    out=dict(blocks=blocks,sid=sid.copy(),ts=ts.copy(),known=known.copy(),N=np.zeros(shape,np.int64),known_N=np.zeros(shape,np.int64),unknown_N=np.zeros(shape,np.int64),events=np.zeros(shape,np.int64),A_sum=np.zeros(shape),C_sum=np.zeros(shape),observed=np.zeros((*shape,2)),completed=np.zeros((*shape,2,2)))
    ix=(sid,bi,year);np.add.at(out['N'],ix,1);np.add.at(out['known_N'],ix,known);np.add.at(out['unknown_N'],ix,~known);np.add.at(out['events'],ix,np.where(known,y,0));np.add.at(out['A_sum'],ix,A);np.add.at(out['C_sum'],ix,C)
    observed=delta(C,A,np.where(known,y,0));observed[~known]=0
    for loss in range(2):np.add.at(out['observed'][...,loss],ix,observed[:,loss])
    for label in (0,1):
        d=delta(C,A,np.where(known,y,label))
        for loss in range(2):np.add.at(out['completed'][...,label,loss],ix,d[:,loss])
    return out

def weights(K,*,draws=B,seed=SEED):
    need(K>0 and draws>0,'resampling units');rng=np.random.default_rng(seed)
    return rng.multinomial(S,np.full(S,1/S),size=draws).astype(np.uint16),rng.multinomial(K,np.full(K,1/K),size=draws).astype(np.uint16)

def weighted(matrix,count,ws,wb,mode):
    need(matrix.shape==count.shape==(S,wb.shape[1]) and ws.shape[0]==wb.shape[0] and ws.shape[1]==S,'weight geometry')
    if mode=='time_only':num=wb@matrix.sum(axis=0);den=wb@count.sum(axis=0)
    elif mode=='series_only':num=ws@matrix.sum(axis=1);den=ws@count.sum(axis=1)
    elif mode=='series_label_x_time':num=np.sum((ws@matrix)*wb,axis=1);den=np.sum((ws@count)*wb,axis=1)
    else:raise ValueError('fixed modes')
    result=np.full(len(den),np.nan);np.divide(num,den,out=result,where=den>0);return result,den

def describe(draw):
    ok=np.isfinite(draw).all(axis=1);d=draw[ok];need(not np.isinf(draw).any(),'finite draws or explicit zero denominators')
    corr=None
    if len(d)>1 and np.std(d[:,0])>0 and np.std(d[:,1])>0:corr=float(np.corrcoef(d.T)[0,1])
    return dict(valid_draws=int(ok.sum()),zero_denominator_draws=int((~ok).sum()),SD=[None,None] if not len(d) else np.std(d,axis=0).tolist(),
                percentile_025_50_975=[None,None] if not len(d) else np.quantile(d,[.025,.5,.975],axis=0).T.tolist(),
                paired_loss_correlation=corr,both_losses_negative_share=None if not len(d) else float(np.mean(np.all(d<0,axis=1))),
                share_interpretation='Conditional descriptive draw share on nonzero denominators; not power, p-value or confirmation')

def calculate(stats,ws,wb):
    need(ws.dtype==wb.dtype==np.uint16 and np.all(ws.sum(1)==S) and np.all(wb.sum(1)==len(stats['blocks'])),'exact multinomial weights')
    reports={};draws=np.full((3,3,2,ws.shape[0],2),np.nan);denoms=np.zeros((3,3,ws.shape[0]))
    for vi,name in enumerate(('pooled','2024','2025')):
        take=(0,1) if vi==0 else (vi-1,);N=stats['N'][:,:,take].sum(axis=2);known=stats['known_N'][:,:,take].sum(axis=2);obs=stats['observed'][:,:,take,:].sum(axis=2);complete=stats['completed'][:,:,take,:,:].sum(axis=2)
        means=np.full((2,2),np.nan)
        if N.sum():means=complete.sum(axis=(0,1))/N.sum()
        report=dict(J_n=int(N.sum()),known_n=int(known.sum()),unknown_n=int(N.sum()-known.sum()),canonical_SID_units=S,canonical_pooled_block_units=len(stats['blocks']),
                    occupied_SID_units=int(np.sum(N.sum(1)>0)),occupied_block_units=int(np.sum(N.sum(0)>0)),occupied_cells=int(np.sum(N>0)),
                    observed_delta=None if not known.sum() else (obs.sum(axis=(0,1))/known.sum()).tolist(),
                    completed_delta=None if not N.sum() else means.tolist(),completion_lower=None if not N.sum() else means.min(0).tolist(),completion_upper=None if not N.sum() else means.max(0).tolist(),resampling={})
        for mi,mode in enumerate(('time_only','series_only','series_label_x_time')):
            report['resampling'][mode]={}
            for label in (0,1):
                for loss in range(2):draws[mi,vi,label,:,loss],den=weighted(complete[...,label,loss],N,ws,wb,mode)
                denoms[mi,vi]=den;report['resampling'][mode][str(label)]=describe(draws[mi,vi,label])
        reports[name]=report
    # One fixed pooled observed Brier contribution ordering, never loss/year selected.
    counts=stats['N'].sum(axis=(1,2));contrib=stats['observed'][...,0].sum(axis=(1,2));positive=np.flatnonzero(counts>0)
    k=min(len(positive),max(3,math.ceil(.025*len(positive))))
    removed=positive[np.lexsort((positive,contrib[positive]))[:k]];remain=np.ones(S,bool);remain[removed]=False;concentration={}
    for vi,name in enumerate(('pooled','2024','2025')):
        yr=(0,1) if vi==0 else (vi-1,);n=stats['known_N'][remain][:,:,yr].sum();d=stats['observed'][remain][:,:,yr,:].sum(axis=(0,1,2))
        concentration[name]=dict(known_n=int(n),observed_delta=None if not n else (d/n).tolist(),adverse_loss_count=None if not n else int(np.sum(d/n>=0)))
    safe=dict(schema='q26-C-paired-precision-descriptive-v1',label='CODEX CONTINUATION',complete=True,target='H24_MINUS10_C_MINUS_A',negative_favors_C=True,draws=ws.shape[0],seed=SEED,epoch_block_days=28,
              shared_global_weights_all_views_losses_completions=True,views=reports,leave_top_k=dict(k=k,occupied_series=len(positive),selection='Pooled observed Brier sum most negative; canonical SID tie break; fixed once',views=concentration),
              limits=['TIME_ONLY primary fixed-panel calendar sensitivity, not new-asset generalization.','Series-only/two-way are file-label sensitivities, not qualified economic-entity inference; no selecting smaller variance.','Descriptive intervals/shares are not power, p-values, significance, candidate eligibility or readiness.','Adaptive seen-data selection, entity mapping, multiplicity/calibration gates, unseen coverage and outcome-blind counts remain unresolved.'],forecast_promotion_status='NOT_ADMITTED',prospective_confirmation_status='DRAFT')
    return safe,dict(draw_means=draws,draw_denominators=denoms,series_weights=ws,block_weights=wb,removed_sid=removed.astype(np.int32))

def point_views(stats):
    views={}
    for vi,name in enumerate(('pooled','2024','2025')):
        yr=(0,1) if vi==0 else (vi-1,);n=stats['N'][:,:,yr].sum();kn=stats['known_N'][:,:,yr].sum();d=stats['observed'][:,:,yr,:].sum(axis=(0,1,2));c=stats['completed'][:,:,yr,:,:].sum(axis=(0,1,2))
        views[name]=dict(J_n=int(n),known_n=int(kn),observed_delta=None if not kn else (d/kn).tolist(),completion_lower=None if not n else (c/n).min(0).tolist(),completion_upper=None if not n else (c/n).max(0).tolist())
    return views

def reconcile(safe,component):
    rows={v['view']:v for v in component['views'] if v['view_type']=='calendar'}
    for name,r in safe['views'].items():
        v=rows[name];need(r['J_n']==v['forecast_J_n'] and r['known_n']==v['scored_L24_n'],'accepted exact support')
        p=v['paired']['C_conditional_minus_A_raw_fH']
        for j,key in enumerate(('brier','bounded_logloss')):
            need(abs(r['observed_delta'][j]-p[key+'_delta'][2])<=1e-14,'accepted paired point')
            for bound in ('lower','upper'):need(abs(r['completion_'+bound][j]-p['all_common_issued_bounds'][key][bound][2])<=1e-14,'accepted completion bound')

def module(record,name,expected):
    p=Path(record['path']);b=p.read_bytes();need(len(b)==record['size'] and hashlib.sha256(b).hexdigest()==record['sha256']==expected,'frozen reader source')
    m=types.ModuleType(name);m.__file__=str(p);sys.modules[name]=m;exec(compile(b,str(p),'exec'),vars(m));return m

def run(path,sha,*,status='DRAFT'):
    need(status==ADMITTED,'DRAFT: no input access');b=Path(path).read_bytes();need(len(b)<=65536 and hashlib.sha256(b).hexdigest()==sha,'external request')
    q=json.loads(b);need(q['schema']=='q26-C-paired-precision-request-v1' and q['status']==ADMITTED,'request scope')
    R=module(q['pins']['fixed_c_run'],'_precision_R',R_SHA);DG=module(q['pins']['diagnostic_source'],'_precision_DG',DG_SHA);need(R.pin(Path(__file__).resolve())==q['pins']['source'],'current source')
    accepted=R.read(q['pins']['parent_acceptance']);need(accepted['public_data']['complete']is True and accepted['public_data']['phase_closed']is True,'closed accepted C')
    oldq=R.read(accepted['private_evidence']['request'],2*1024**2);runtime=oldq['runtime']
    need(sys.executable==runtime['invocation_path'] and sys.dont_write_bytecode and sys.flags.optimize==0 and sys.version==runtime['version'] and np.__version__==runtime['packages']['numpy'],'accepted runtime')
    need(str(Path(sys.executable).resolve())==runtime['executable']['path'] and all(os.environ.get(k)==v for k,v in runtime['environment'].items()),'accepted runtime environment')
    runtimepins=[runtime['executable'],*runtime['native_pins']]
    for p in runtimepins:R.checked(p)
    manifestpin=accepted['private_evidence']['manifest'];manifest=R.read(manifestpin,8*1024**2);preparedpin=oldq['pins']['preparation_manifest'];prepared=R.read(preparedpin,8*1024**2)
    need(manifest['complete']is True and manifest['canonical_mapping']==oldq['canonical_mapping'] and len(manifest['series_receipts'])==len(prepared['series_receipts'])==S,'accepted canonical277')
    used=[manifestpin,preparedpin,accepted['private_evidence']['request']];parts=[]
    for sid,key in oldq['canonical_mapping']:
        erpin=manifest['series_receipts'][sid];ppin=prepared['series_receipts'][sid];er=R.read(erpin,65536);pr=R.read(ppin,65536);summary=R.read(er['summary'],256*1024)
        need(er['sid']==pr['sid']==sid and er['key']==pr['key']==key and er['prepared_receipt']==ppin and er['complete']is True,'canonical receipt join')
        hpin=pr['outputs']['24'];h=DG.archive(hpin);used.extend([erpin,ppin,er['summary'],hpin]);predparts=[]
        need(len(er['quarters'])==2*len(summary['quarter_records']),'complete calendar pairs')
        for i,record in enumerate(summary['quarter_records']):
            npin,jpin=er['quarters'][2*i:2*i+2];a=DG.archive(npin,rows=92,cap=65536);r=R.read(jpin,65536);used.extend([npin,jpin])
            need(r['sid']==record['sid']==sid and r['quarter_cutoff']==record['quarter_cutoff'] and r['rows']==record['J_n']==len(a['ts']) and r['sha256']==npin['sha256'] and r['size']==npin['size'] and r['file']==Path(npin['path']).name and r['forecasts_only_on_original_J']is True,'quarter inventory binding')
            need(a['on_J'].dtype==a['candidate_prediction_valid'].dtype==bool and a['on_J'].all() and a['candidate_prediction_valid'].all(),'original J rows only');predparts.append(a)
        sidrows=np.concatenate([a['sid'] for a in predparts]) if predparts else np.empty(0,np.int32);ts=np.concatenate([a['ts'] for a in predparts]) if predparts else np.empty(0,np.int64);DG.keys(sidrows,ts)
        need(len(ts)==summary['joint_ledger']['J_n'],'all accepted perSID J');index={int(t):i for i,t in enumerate(h['ts'])};need(len(index)==len(h['ts']) and all(int(t)in index for t in ts),'exact H24 label join');ix=np.array([index[int(t)]for t in ts],np.int64)
        pred=DG.join_predictions(sidrows,ts,predparts);need(np.array_equal(pred['A_raw_fH'],h['p_fH'][ix]) and np.all(h['sid'][ix]==sid),'allfive A and SID identity')
        parts.append((sidrows,ts,pred['A_raw_fH'][:,2],pred['C_conditional'][:,2],h['y'][ix,2],h['label_valid'][ix]))
    arrays=[np.concatenate([p[i]for p in parts])for i in range(6)];need(len(arrays[0])==186232 and int(arrays[-1].sum())==186231,'fixed complete J and unknown')
    stats=sufficient(*arrays,status=status)
    reportpin=manifest['reports']['component'];component=R.read(reportpin,64*1024**2)['component'];reconcile(dict(views=point_views(stats)),component);used.append(reportpin)
    ws,wb=weights(len(stats['blocks']));safe,private=calculate(stats,ws,wb);reconcile(safe,component)
    for p in [*used,*runtimepins,*q['pins'].values()]:R.checked(p)
    root=Path(q['out']);need(root.is_absolute() and str(root.resolve())==str(root) and not root.exists(),'fresh canonical output')
    for p in used:need(not Path(p['path']).is_relative_to(root),'no output contains immutable input')
    root.mkdir(mode=0o700);payload={**stats,**private};need(sum(v.nbytes for v in payload.values())<=64*1024**2,'logical archive cap');archive=root/'sufficient-draws.npz';np.savez_compressed(archive,**payload);os.chmod(archive,0o600);need(archive.stat().st_size<=16*1024**2,'compressed archive cap')
    with np.load(archive,allow_pickle=False)as z:need(set(z.files)==set(payload) and all(z[k].dtype==v.dtype and z[k].shape==v.shape and z[k].tobytes()==v.tobytes() for k,v in payload.items()),'exact archive readback')
    data=(json.dumps(safe,indent=2,allow_nan=False)+'\n').encode();fd=os.open(root/'report.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
    need(json.loads((root/'report.json').read_bytes())==safe,'report readback');need(sum(p.stat().st_size for p in root.iterdir())<=16*1024**2,'whole output cap')
    for p in [*used,*runtimepins,*q['pins'].values()]:R.checked(p)
    return dict(schema='q26-C-paired-precision-produced-v1',complete=True,request_sha256=sha,archive=R.pin(archive),report=R.pin(root/'report.json'))

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--admitted',action='store_true');a=p.parse_args();print(json.dumps(run(a.request,a.request_sha256,status=ADMITTED if a.admitted else 'DRAFT')))
