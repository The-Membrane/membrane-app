"""R17 retrospective staging only. A DRAFT request refuses all production input access."""
import argparse
import contextlib
import datetime as dt
import hashlib
import importlib
import importlib.abc
import importlib.util
import importlib.machinery
import json
import math
import os
from pathlib import Path
import resource
import shutil
import sys
import time
import numpy as np

SOURCE = Path('/Users/EBmic/research-workspaces/history-forecasts-continuation')
BASE = ('lsH','lsf','dm','wm','r24','r168','r720','dd720','rng24','lvol','btc_r24','btc_dm')
SHAPE = tuple('jump_share_'+w for w in 'DWM') + tuple('semivariance_imbalance_'+w for w in 'DWM')
HORIZONS = (6,12,24,72,168)
BARRIERS = np.array([-.40,-.20,-.10,-.05,-.02])
START = int(dt.datetime(2022,1,1,tzinfo=dt.timezone.utc).timestamp())
END = int(dt.datetime(2026,1,1,tzinfo=dt.timezone.utc).timestamp())
MARGIN_EPS = 1e-6


def pin(path):
    p=Path(path); return {'path':str(p),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}


def check(p):
    if pin(p['path']) != {k:p[k] for k in ('path','size','sha256')}: raise ValueError('pin mismatch: '+p['path'])


def choose(keys,n=24):
    if len(set(keys)) != len(keys): raise ValueError('duplicate key')
    return sorted(enumerate(keys),key=lambda x:hashlib.sha256(('Q26-R17-STAGING:'+x[1]).encode()).hexdigest())[:n]


def quarters():
    return [int(dt.datetime(y,m,1,tzinfo=dt.timezone.utc).timestamp()) for y in range(2022,2026) for m in (1,4,7,10)] + [END]


def sanitize(a):
    a=np.asarray(a,dtype=float).copy(); a[~np.isfinite(a)]=np.nan
    return a


def margins(p):
    valid=np.all(np.isfinite(p)&(p>=0)&(p<=1),axis=1)
    q=np.clip(p,MARGIN_EPS,1-MARGIN_EPS)
    with np.errstate(invalid='ignore',divide='ignore'): out=np.log(q/(1-q))
    out[~valid]=np.nan
    return out, valid[:,None]&((p<MARGIN_EPS)|(p>1-MARGIN_EPS)),valid


def complete_labels(ser,H,idx,legacy_depth,legacy_valid):
    """Future lows are label-only; never used to construct issuance eligibility."""
    low=np.asarray(ser.low); bad=~np.isfinite(low)|(low<=0)
    cs=np.r_[0,np.cumsum(bad,dtype=np.int64)]
    ends=np.minimum(idx+H,len(low)); starts=np.minimum(idx,len(low))
    missing=cs[ends]-cs[starts]+np.maximum(idx+H-len(low),0)
    spot=np.asarray(ser.spot)[idx]
    valid=(idx+H<=len(low))&(missing==0)&np.isfinite(spot)&(spot>0)
    depth=np.full(len(idx),np.nan)
    for j in np.flatnonzero(valid): depth[j]=np.log(np.min(low[idx[j]:idx[j]+H])/spot[j])
    # On complete windows the original primitive must agree; this checks clock alignment.
    both=valid&legacy_valid
    if not np.allclose(depth[both],legacy_depth[both],rtol=1e-13,atol=1e-14): raise ValueError('legacy complete-window depth mismatch')
    y=np.zeros((len(idx),len(BARRIERS)),np.uint8)
    y[valid]=(depth[valid,None]<=np.log1p(BARRIERS)[None,:])
    depth[~valid]=np.nan
    return y,valid,missing.astype(np.int32),depth


def raw_features(ser,spec,D,A6):
    n=len(ser.close)+1
    with np.errstate(divide='ignore',invalid='ignore'):
        har=np.log(A6.har_of(ser)); lc=np.log(ser.spot)
    def lag(w):
        a=np.full(n,np.nan); a[w:]=lc[w:]-lc[:-w]; return a
    def maximum(x,w):
        a=np.full(n,np.nan)
        if len(x)>w:
            v=np.lib.stride_tricks.sliding_window_view(np.where(np.isfinite(x),x,-np.inf),w).max(1)
            a[w:]=v[:n-w]
        return sanitize(a)
    hi720=maximum(ser.high,720); hi24=maximum(ser.high,24); lo24=-maximum(-ser.low,24)
    vol=D.load_volume(spec); none=vol is None; mismatch=vol is not None and len(vol)!=len(ser.close)
    with np.errstate(divide='ignore',invalid='ignore'):
        lvol=np.log(D.roll_mean(vol,24,ser.start_i)/D.roll_mean(vol,720,ser.start_i)) if not(none or mismatch) else np.full(n,np.nan)
        f={'dm':har[:,0]-har[:,2],'wm':har[:,1]-har[:,2], 'r24':lag(24),'r168':lag(168),'r720':lag(720),
           'dd720':lc-np.log(hi720),'rng24':np.log(hi24/lo24),'lvol':lvol}
    f['btc_r24'],f['btc_dm']=D.btc_lookup(ser.base_ts+3600*np.arange(n))
    R=D.realized(ser)
    with np.errstate(divide='ignore',invalid='ignore'):
        shape=np.column_stack([np.where(R['RV'+w]>0,R['J'+w]/R['RV'+w],np.nan) for w in 'DWM']+
                              [np.where(R['RV'+w]>0,(R['RSm'+w]-R['RSp'+w])/R['RV'+w],np.nan) for w in 'DWM'])
    return {k:sanitize(v) for k,v in f.items()},sanitize(shape),{'volume_loader_returned_none':none,'volume_length_mismatch':mismatch}


def build_horizon(ser,H,sid,F,shape,A6,M2,checkpoint=lambda:None):
    """Emit only each quarter's own rows; never cache a later fit as old-row features."""
    P6=A6.Prep6(ser,H,with_fbL=False); P=P6.P; n=P6.n
    all_i=np.arange(n); ts=ser.base_ts+3600*all_i
    take=(ts>=START)&(ts<END)&(ts%86400==0)
    idx=all_i[take]; t=ts[take]; N=len(idx)
    p=np.full((N,5),np.nan); lsH=np.full(N,np.nan); fb=np.zeros(N,bool); cutoff=np.zeros(N,np.int64)
    proof=[]; q=quarters()
    for qa,qb in zip(q[:-1],q[1:]):
        checkpoint(); at=np.flatnonzero((t>=qa)&(t<qb)); te=idx[at]
        if not len(te): continue
        if (qa-ser.base_ts)%3600: raise ValueError('quarter off hourly grid')
        qs=(qa-ser.base_ts)//3600; tr=all_i+H<=qs
        coef,info=P6.har_coef(qs); sH=P6.sigma_H(coef); zH,vH=P6.z_of(sH)
        with np.errstate(divide='ignore',invalid='ignore'):
            ph=M2.fhs_predict(zH[vH&tr],np.log1p(BARRIERS)[None,:]/(sH[te,None]*P.scale))
            pf=M2.fhs_predict(P.z[1.0][P.valid[1.0]&tr],np.log1p(BARRIERS)[None,:]/(ser.sigma[te,None]*P.scale))
            lsH[at]=np.log(sH[te])
        fallback=~np.all(np.isfinite(ph),axis=1); ph[fallback]=pf[fallback]
        p[at]=ph; fb[at]=fallback; cutoff[at]=qa
        reg=np.flatnonzero(P6.okH&tr); lib=np.flatnonzero(vH&tr); flib=np.flatnonzero(P.valid[1.0]&tr)
        ends=lambda ii: int(ser.base_ts+3600*(int(ii[-1])+H)) if len(ii) else None
        if any(x is not None and x>qa for x in (ends(reg),ends(lib),ends(flib))): raise ValueError('future training label')
        if info['n_reg']!=len(reg): raise ValueError('HAR maturity count mismatch')
        proof.append({'quarter_cutoff':qa,'n_rows':len(at),'n_reg':len(reg),'har_label_end_max':ends(reg),
                      'library_label_end_max':ends(lib),'fallback_library_label_end_max':ends(flib),
                      'har_label_end_min':int(ser.base_ts+3600*(int(reg[0])+H)) if len(reg) else None,
                      'coef':None if coef is None else np.asarray(coef).tolist(),'fallback_rows':int(fallback.sum())})
    if N and (np.any(cutoff==0) or np.any(t<cutoff)): raise ValueError('missing own-quarter assignment')
    legacy=P.lab_ok[idx]&np.isfinite(P.depth[idx]); y,valid,missing,depth=complete_labels(ser,H,idx,P.depth[idx],legacy)
    with np.errstate(divide='ignore',invalid='ignore'): lsf=np.log(ser.sigma[idx])
    base=sanitize(np.column_stack([lsH,lsf]+[F[k][idx] for k in BASE[2:]])).astype(np.float32)
    sh=sanitize(shape[idx]).astype(np.float32); margin,clipped,pvalid=margins(p)
    if np.any(np.diff(p[pvalid],axis=1)<0): raise ValueError('nonmonotone baseline CDF')
    issue=(idx>=ser.start_i)&np.isfinite(ser.spot[idx])&(ser.spot[idx]>0)
    out={'sid':np.full(N,sid,np.int32),'ts':t.astype(np.int64),'p_fH':p,'y':y,'label_valid':valid,
         'legacy_label_valid':legacy,'future_missing_hours':missing,'future_log_min':depth,'Xbase':base,'Xshape':sh,'quarter_cutoff':cutoff,
         'p_fH_valid':pvalid,'issue_eligible':issue,'Xbase_missing':~np.isfinite(base),'Xshape_missing':~np.isfinite(sh),
         'base_margin':margin,'base_margin_clipped':clipped,'fH_fallback':fb}
    if any(np.any(np.isinf(v)) for v in out.values()): raise ValueError('infinite output')
    counts={'rows':N,'issue_eligible':int(issue.sum()),'label_valid':int(valid.sum()),'label_missing':int((~valid).sum()),
            'legacy_label_valid':int(legacy.sum()),'p_fH_valid':int(pvalid.sum()),'fallback_rows':int(fb.sum()),
            'future_missing_hours':int(missing.sum()),'Xbase_missing':out['Xbase_missing'].sum(0).tolist(),
            'Xshape_missing':out['Xshape_missing'].sum(0).tolist(),'dropped_future_label_rows':0}
    return out,{'sid':sid,'horizon':H,'counts':counts,'quarters':proof}


@contextlib.contextmanager
def guard(reads,out):
    allowed={str(Path(p).resolve()) for p in reads}; root=Path(out).resolve(); active=[True]; seen=set()
    prefixes={Path(sys.base_prefix).resolve(),Path(sys.prefix).resolve()}
    def hook(event,args):
        if not active[0]: return
        if event.startswith(('socket.','subprocess.','os.system','os.posix_spawn')): raise PermissionError('network/process forbidden')
        if event!='open' or not isinstance(args[0],(str,bytes,os.PathLike)): return
        p=Path(os.fsdecode(args[0])).resolve(); mode=args[1]; flags=args[2]
        writing=(isinstance(mode,str) and any(x in mode for x in 'wax+')) or (isinstance(flags,int) and flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
        if writing:
            if not p.is_relative_to(root): raise PermissionError('write outside fresh output')
        elif str(p) in allowed: seen.add(str(p))
        elif p.is_relative_to(root): pass
        elif p.suffix in ('.py','.pyc','.so','.dylib') and any(p.is_relative_to(b) for b in prefixes): pass
        else: raise PermissionError('unadmitted read: '+str(p))
    sys.addaudithook(hook)
    try: yield seen
    finally: active[0]=False


def authenticate(r):
    if r['status']!='READY_PARENT_REVIEWED': raise ValueError('DRAFT: production execution refused')
    if Path(__file__).resolve()!=Path(r['pins']['helper']['path']).resolve(): raise ValueError('executed helper path mismatch')
    if r['horizons']!=list(HORIZONS) or r['barriers']!=BARRIERS.tolist(): raise ValueError('protocol mismatch')
    if any(os.environ.get(k)!='1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')): raise ValueError('single threads required')
    if 'torch' in sys.modules: raise ValueError('Torch forbidden')
    for p in r['pins'].values(): check(p)
    scope=json.loads(Path(r['pins']['raw_scope']['path']).read_text())['base_scope']
    fit=json.loads(Path(r['pins']['fit_scope']['path']).read_text())
    if len(scope['canonical_keys'])!=277 or len(scope['price_inputs'])!=280: raise ValueError('universe mismatch')
    if [list(x) for x in choose(scope['canonical_keys'])]!=r['selected']: raise ValueError('selection changed')
    pins=scope['price_inputs']+scope['auxiliary_inputs']+fit['runtime_native_pins']
    pins += [dict(path=str(SOURCE/k),size=(SOURCE/k).stat().st_size,sha256=v) for k,v in fit['source_sha256'].items()]
    for p in pins: check(p)
    if sys.executable!=r['python'] or sys.version.split()[0]!=r['python_version'] or np.__version__!=r['numpy_version']: raise ValueError('runtime mismatch')
    admitted={p['path'] for p in scope['price_inputs']+scope['auxiliary_inputs']}
    if not set(r['required_raw_paths'])<=admitted: raise ValueError('unadmitted required raw path')
    return scope,pins


class FrozenSources(importlib.abc.MetaPathFinder):
    """Compile pinned source bytes; never execute an unpinned legacy pycache."""
    def __init__(self,paths): self.paths={Path(p).stem:Path(p) for p in paths if Path(p).suffix=='.py'}
    def find_spec(self,fullname,path=None,target=None):
        if fullname not in self.paths: return None
        p=self.paths[fullname]
        class Loader(importlib.machinery.SourceFileLoader):
            def get_code(self,name): return self.source_to_code(self.get_data(self.path),self.path)
        return importlib.util.spec_from_loader(fullname,Loader(fullname,str(p)))


def run(r,out):
    scope,pins=authenticate(r); root=Path(out)
    if root!=Path(r['out']) or root.exists(): raise ValueError('fresh exact output required')
    root.mkdir(); t0=time.monotonic(); stage='imports'; completed=0
    def checkpoint():
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
        size=sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
        if time.monotonic()-t0>1200 or rss>1_000_000_000 or shutil.disk_usage(root).free<2_000_000_000 or size>500_000_000: raise RuntimeError('resource limit')
    try:
        src=SOURCE/'scripts/research/history-forecasts'; sys.path.insert(0,str(src))
        source_reads=[p['path'] for p in pins if str(p['path']).startswith(str(SOURCE))]
        finder=FrozenSources(source_reads); sys.meta_path.insert(0,finder)
        with guard(source_reads+r['required_raw_paths'],root) as seen:
            R12=importlib.import_module('r12_tail'); D=importlib.import_module('r16_dev'); A6=importlib.import_module('a6_touch'); M2=importlib.import_module('a2_touch')
            R12._CHAIN.clear(); D._BTC.clear()
            specs={s['key']:s for s in R12.dev_specs(scope['datasets'])}
            if set(specs)!=set(scope['canonical_keys']): raise ValueError('canonical spec closure mismatch')
            expected={str(Path(specs[key]['path']).resolve()) for _,key in r['selected'] if specs[key]['kind']=='grid'}
            admitted={p['path'] for p in scope['price_inputs']+scope['auxiliary_inputs']}
            if any(specs[key]['kind']=='chain' for _,key in r['selected']):
                for k in ('eth_price','btc_price','steth_price','eth_dvol','btc_dvol'):
                    expected.add(str(Path(scope['datasets'])/A6.A.INPUTS[k][0]))
                for asset in ('ETH','BTC'): expected.add(str(Path(scope['datasets'])/M2.KLINES[M2.LONG_PAIR[asset]][0]))
            btcp=str(Path(scope['datasets'])/'binance-klines/BTCUSDT-1h.json')
            if btcp in admitted: expected.add(btcp)
            if expected!=set(r['required_raw_paths']): raise ValueError('selected dependency read closure mismatch')
            # init_btc is optional only when its exact admitted path exists in the frozen scope.
            btc=str(Path(scope['datasets'])/'binance-klines/BTCUSDT-1h.json')
            if btc in r['required_raw_paths']: D.init_btc(scope['datasets'])
            metadata=[]; shards={H:[] for H in HORIZONS}
            for sid,key in r['selected']:
                stage='load-series'; checkpoint(); spec=specs[key]
                ser,_,_=R12.load_series(spec); F,shape,vmeta=raw_features(ser,spec,D,A6)
                for H in HORIZONS:
                    stage=f'stage-series-{sid}-horizon-{H}'; checkpoint()
                    a,m=build_horizon(ser,H,sid,F,shape,A6,M2,checkpoint); m.update(vmeta); metadata.append(m)
                    p=root/f'partial-{sid}-{H}.npz'; np.savez_compressed(p,**a); shards[H].append(p); del a
                completed+=1; print(json.dumps({'completed_series':completed,'elapsed_seconds':round(time.monotonic()-t0,3)}),file=sys.stderr)
                del ser,F,shape
                R12._CHAIN.clear()  # prevent retaining all chain assets alongside the next series
            outputs=[]
            for H in HORIZONS:
                stage=f'finalize-{H}'; checkpoint(); acc={}
                for p in shards[H]:
                    with np.load(p,allow_pickle=False) as z:
                        for k in z.files: acc.setdefault(k,[]).append(z[k])
                joined={k:np.concatenate(v) for k,v in acc.items()}
                order=np.lexsort((joined['ts'],joined['sid'])); joined={k:v[order] for k,v in joined.items()}
                dst=root/f'horizon-{H}.npz'; np.savez_compressed(dst,**joined); outputs.append(pin(dst))
                for p in shards[H]: p.unlink()
            read_paths=sorted(seen)
        sys.meta_path.remove(finder)
        manifest={'schema':'codex-r17-staged-inputs-v1','complete':True,'request_protocol':r['protocol'], 'outputs':outputs,
                  'canonical_mapping':r['selected'],'barriers':BARRIERS.tolist(),'feature_names':{'Xbase':BASE,'Xshape':SHAPE},
                  'feature_units':{'lsH':'log annualized sigma','lsf':'log annualized sigma','dm/wm':'log annualized variance ratios','returns/range/drawdown':'log ratios','lvol':'log volume ratio','shape':'dimensionless hourly realized proxies'},
                  'clock':'origin UTC00; spot last finished close; lows bars i..i+H-1','series_horizons':metadata,'read_paths':read_paths,
                  'interpretation':'Retrospective staging only; complete primary labels, legacy tolerant own-series fH library; no correction model fitted.'}
        (root/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False)+'\n'); checkpoint()
    except BaseException as exc:
        (root/'failure.json').write_text(json.dumps({'complete':False,'stage':stage,'completed_series':completed,'error_class':type(exc).__name__,'read_paths':sorted(seen) if 'seen' in locals() else [],'elapsed_seconds':time.monotonic()-t0})+'\n'); raise


def main():
    p=argparse.ArgumentParser(); p.add_argument('--request',required=True); p.add_argument('--sha256',required=True); p.add_argument('--scope',required=True); p.add_argument('--scope-sha256',required=True); p.add_argument('--raw-root',required=True); p.add_argument('--out',required=True); a=p.parse_args()
    b=Path(a.request).read_bytes()
    if hashlib.sha256(b).hexdigest()!=a.sha256: raise ValueError('request pin mismatch')
    r=json.loads(b)
    if a.scope!=r['pins']['raw_scope']['path'] or a.scope_sha256!=r['pins']['raw_scope']['sha256'] or a.raw_root!=r['raw_root']: raise ValueError('explicit scope mismatch')
    run(r,a.out)

if __name__=='__main__': main()
