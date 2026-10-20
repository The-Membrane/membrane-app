"""Descriptive seen-development audit; no Torch, fits, selection, or causal claims.
Peak owned arrays are sequential per-horizon/per-model; conservative <512 MB estimate,
not a measured/enforced RSS bound. Run under the parent's 2.5 GB operational cap.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np

SOURCE=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts')
spec=importlib.util.spec_from_file_location('shallow_independent_descriptive',SOURCE/'r16_shallow_nn_independent.py')
I=importlib.util.module_from_spec(spec);spec.loader.exec_module(I)
LEVELS={1:(-.02,-.03,-.05),3:(-.02,-.03,-.05,-.07),12:(-.02,-.03,-.05,-.07,-.10)}
LIMITATION=('DESCRIPTIVE ONLY, seen development. All five models, four original retrospective hash/time cells and twelve horizon/barrier labels are retained. No eligibility, ranking, reselection, p-values, causal inference, or independent Torch training/weights verification. Early-time cells train on future peer-series data. Ratios are predicted_mean / observed_rate, null when observed_rate is zero. Exact/deviation comparisons use stored probabilities without clipping or rounding.')


def require(condition,message):
    if not condition:raise ValueError(message)


def pin(path):
    path=Path(path).resolve()
    return dict(path=str(path),size=path.stat().st_size,sha256=I.sha(path))


def bound(path,digest):
    require(I.sha(path)==digest,'explicit evidence SHA mismatch: '+str(path))
    return pin(path)


def cell_masks(ts,groups,split):
    ts=np.asarray(ts);groups=np.asarray(groups)
    require(ts.shape==groups.shape and ts.ndim==1,'cell shape mismatch')
    daily=ts%86400==0
    return {(sh,tt):daily & (groups%2==sh) & ((ts>=split) if tt else (ts<split)) for sh in (0,1) for tt in (0,1)}


def statistics(y,reference,prediction):
    y=np.asarray(y,dtype=np.float64);f=np.asarray(reference,dtype=np.float64);p=np.asarray(prediction,dtype=np.float64)
    require(y.ndim==1 and y.shape==p.shape==f.shape,'metric shape mismatch')
    require(np.isfinite(y).all() and np.isin(y,[0,1]).all(),'invalid binary labels')
    require(np.isfinite(f).all() and np.isfinite(p).all() and ((f>=0)&(f<=1)).all() and ((p>=0)&(p<=1)).all(),'invalid probability')
    if len(y)==0:
        return dict(n=0,observed_count=0,observed_rate=None,predicted_mean=None,reference_predicted_mean=None,brier_model=None,brier_fH=None,brier_difference=None,model_calibration_ratio=None,fH_calibration_ratio=None,mean_abs_probability_deviation_fH=None,max_abs_probability_deviation_fH=None,fraction_exactly_identical_fH=None,fraction_within_1e_6_fH=None)
    observed=float(y.mean());d=p-f;bm=float(np.mean((p-y)**2));bf=float(np.mean((f-y)**2))
    return dict(n=len(y),observed_count=int(y.sum()),observed_rate=observed,predicted_mean=float(p.mean()),reference_predicted_mean=float(f.mean()),brier_model=bm,brier_fH=bf,brier_difference=bm-bf,model_calibration_ratio=float(p.mean()/observed) if observed else None,fH_calibration_ratio=float(f.mean()/observed) if observed else None,mean_abs_probability_deviation_fH=float(np.mean(np.abs(d))),max_abs_probability_deviation_fH=float(np.max(np.abs(d))),fraction_exactly_identical_fH=float(np.mean(p==f)),fraction_within_1e_6_fH=float(np.mean(np.abs(d)<=1e-6)))


def admit(scope,digest,independent,score_path,score,monitor,start):
    out=Path(scope['out']).resolve()
    require(scope.get('schema')=='r16-shallow-original-nn-v1' and scope.get('phase')=='fit','original fit scope required')
    require(independent.get('complete') is True and independent.get('scope_sha256')==digest and independent.get('fit_replay',{}).get('fits')==20,'complete matching independent twenty-fit verification required')
    require(set(independent.get('coverage',{}))=={'1','3','12'},'all independent coverage horizons required')
    require(Path(score_path).resolve()==out/'dev-r162-nn.json','score output path differs from exact frozen out')
    require(score.get('complete') is True and score.get('phase')=='score' and score.get('scope_sha256')==digest,'complete matching score receipt required')
    require(score.get('output')==pin(score_path),'score output receipt pin mismatch')
    require(score.get('audit_violations')=={'total':0,'attempts':[]},'score audit not clean')
    I.monitor_admission(monitor,start,'score',digest)
    require(monitor.get('child_receipt')==pin(out/'score.json'),'score monitor child binding mismatch')
    policy=scope['score_resource_policy']
    require(monitor['elapsed_seconds']<=policy['wall_seconds'] and monitor['peak_sampled_child_rss_bytes']<=policy['rss_bytes'],'score resource limit exceeded')
    require(score.get('coverage')==independent['coverage'],'score/independent coverage differs')


def describe(scope_path,scope_sha,independent_path,independent_sha,score_path,score_sha):
    require(not any(n=='torch' or n.startswith('torch.') for n in sys.modules),'Torch must not be imported')
    explicit=[bound(scope_path,scope_sha),bound(independent_path,independent_sha),bound(score_path,score_sha)]
    scope=I.load(scope_path);ind=I.load(independent_path);out=Path(scope['out']).resolve()
    score=I.load(out/'score.json');monitor=I.load(out/'score-monitor.json');start=I.load(out/'score-monitor-start.json')
    admit(scope,scope_sha,ind,score_path,score,monitor,start)
    scored=I.load(score_path)
    require(scored.get('schema')=='q26-r16.2-dev-nn/1' and isinstance(scored.get('cells'),dict) and isinstance(scored.get('tiers'),dict),'original score payload schema required')
    del scored
    evidence={p['path']:p for p in explicit}
    def check(p):
        q=pin(p['path']);require(q==p,'live evidence pin changed: '+p['path']);evidence[q['path']]=q
    # The successful original scorer preserves all pre-score independent pins.
    # Any changed byte is rejected; no historical sidecar is silently exempted.
    for p in ind['evidence_pins']:check(p)
    child=I.load(out/'child.json')
    require(child.get('complete') is True and child.get('neural_fits')==20 and child.get('scope_sha256')==scope_sha and child.get('audit_violations')=={'total':0,'attempts':[]},'preserved clean fit child required')
    audit=I.load(out/'audit.json')
    require(audit.get('violations')=={'total':0,'attempts':[]},'post-score audit not clean')
    for name in ('score.json','score-monitor.json','score-monitor-start.json','audit.json','child.json'):
        check(pin(out/name))
    e=scope['evidence']
    require(set(e['inputs'])==set(I.INPUTS),'original five merged pins required')
    for p in e['inputs'].values():check(p)
    sources={}
    for relative,digest in scope['source_sha256'].items():
        path=I.ROOT/relative;require(I.sha(path)==digest,'changed original source');sources[str(path)]=digest
    for path,digest in ind['source_sha256'].items():
        require(I.sha(path)==digest,'changed independently verified source');sources[path]=digest
    base=Path(e['inputs']['rows-meta.json']['path']).parent
    keys=I.load(base/'rows-meta.json')['series'];require(keys==e['canonical_keys'],'canonical keys differ')
    R=I.core_rows(base);split=I.split_time(R['ts'])
    require(split==ind['fit_replay']['tsplit_float'],'pooled original split differs')
    actual=I.coverage(base,out)
    require(actual==ind['coverage']==score['coverage']==child['coverage'],'actual all-five daily coverage differs')
    del R
    cells=[];daily_counts={}
    for T in I.HORIZONS:
        with np.load(base/f'rows-T{T}.npz',allow_pickle=False) as z:
            sid=z['sid'];ts=z['ts'];y=z['y'];f=z['fH']
        require(y.shape==f.shape==(I.COUNTS[T],len(LEVELS[T])),'base label/probability shape differs')
        masks=cell_masks(ts,I.groups(keys,sid),split)
        require(np.array_equal(sum(mask.astype(np.int8) for mask in masks.values()),(ts%86400==0).astype(np.int8)),'daily partition differs')
        daily_counts[str(T)]={f'{sh},{tt}':int(mask.sum()) for (sh,tt),mask in masks.items()}
        with np.load(out/f'rows-nn-T{T}.npz',allow_pickle=False) as z:
            for model in I.MODELS:
                p=z[model]
                for (sh,tt),mask in masks.items():
                    for j,level in enumerate(LEVELS[T]):
                        cells.append(dict(model=model,hash_half=sh,time_half=tt,horizon_hours=T,barrier=level,**statistics(y[mask,j],f[mask,j],p[mask,j])))
                del p
        del sid,ts,y,f,masks
    require(len(cells)==240,'all five by four by twelve slices required')
    check(pin(__file__));check(pin(SOURCE/'r16_shallow_nn_independent.py'))
    for p in list(evidence.values()):check(p)
    return dict(schema='codex-r16-shallow-descriptive-weaknesses-v1',complete=True,scope_sha256=scope_sha,independent_fit_sha256=independent_sha,score_output_sha256=score_sha,tsplit_float=split,daily_cell_counts=daily_counts,cells=cells,evidence_pins=list(evidence.values()),source_sha256=sources,fit_audit_handling='All independently accepted pre-score pins must remain byte-identical, including audit.json. A denial can overwrite it, but successful scoring does not.',limitations=LIMITATION,resource_design='Sequential per-horizon/per-model arrays; conservative owned-array estimate <512 MB, no feature reconstruction. Estimate is not measured/enforced RSS; use parent 2.5 GB process cap.')


def main():
    p=argparse.ArgumentParser()
    for flag in ('scope','scope-sha256','fit-independent','fit-independent-sha256','score-json','score-json-sha256','out'):p.add_argument('--'+flag,required=True)
    a=p.parse_args();require(not Path(a.out).exists(),'fresh output required')
    value=describe(a.scope,a.scope_sha256,a.fit_independent,a.fit_independent_sha256,a.score_json,a.score_json_sha256)
    with open(a.out,'x') as f:json.dump(value,f,indent=2,allow_nan=False)
if __name__=='__main__':main()
