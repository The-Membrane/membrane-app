"""Declared 1000-hour cold synthetic original-source boundary qualification.

Exercises new reconstruction with a genuinely unavailable predecessor. Does NOT
qualify two eligible vintages, accounting support, full new-request authentication,
or any historical arrays. Parent seals source hashes and an outer finite budget.
"""
import argparse
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys

F=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation')
E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
S=F/'scripts/research/history-forecasts/fh-date-support'
PATHS={'depth':S/'depth_accounting.py','audit':S/'audit.py','fit':E/'fit-scope-v2.json',
       'census':E/'fh-library-diagnostic-recovery-2026-10-22-v1/source/q26-fh-state-census.py',
       'producer':E/'r17-event-pilot-v1/build_inputs.py'}

def need(ok,why):
    if not ok:raise ValueError(why)

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def mod(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True)
    for key in PATHS:p.add_argument('--'+key+'-sha256',required=True)
    a=p.parse_args()
    for key,path in PATHS.items():
        need(path.resolve()==path and sha(path)==getattr(a,key+'_sha256'),'external source authority')
    need(sys.dont_write_bytecode and not sys.flags.optimize and
         all(os.environ.get(k)=='1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')),'cold runtime flags')
    out=Path(a.out);need(out.is_absolute() and out.resolve()==out and not out.exists(),'fresh canonical fixture output')
    out.mkdir(mode=0o700);gdir=out/'blind6-prices';gdir.mkdir(mode=0o700)
    grid=gdir/'binance-SYNTHETICUSDT-1h.json'
    n,q=1000,1704067200;base=q-900*3600
    close=[100*math.exp(.002*math.sin(i/17.)+.0001*i) for i in range(n)]
    prior=[close[0]]+close[:-1]
    low=[min(x,y)*.997 for x,y in zip(close,prior)]
    high=[max(x,y)*1.003 for x,y in zip(close,prior)]
    grid.write_text(json.dumps({'startTs':base,'columns':{'close':close,'low':low,'high':high}},allow_nan=False)+'\n')
    os.chmod(grid,0o600)
    import numpy as np
    A=mod(PATHS['audit'],'cold_depth_old_audit');N=mod(PATHS['depth'],'cold_depth_new_adapter')
    fit=json.loads(PATHS['fit'].read_bytes());legacy={}
    for relative,expected in fit['source_sha256'].items():
        value=A.pin(F/relative);need(value['sha256']==expected,'all original source bytes');legacy[relative]=value
    need(len(legacy)==30,'full original thirty-source closure')
    producer=A.source_module('cold_depth_original_staging',A.pin(PATHS['producer']))
    census=A.source_module('cold_depth_original_census',A.pin(PATHS['census']))
    finder=A.FrozenSources(legacy.values());need(not(set(finder.paths)&set(sys.modules)),'genuine initial cold original imports')
    sys.meta_path.insert(0,finder);oldpath=list(sys.path)
    try:
        with producer.guard([v['path'] for v in legacy.values()]+[str(grid)],out):
            R12,A6,D,M2=[importlib.import_module(k) for k in ('r12_tail','a6_touch','r16_dev','a2_touch')]
            pilot={'sid':7,'key':'blind6:SYNTHETICUSDT','current_cutoff':q,'previous_cutoff':A.previous_quarter(q)}
            spec=A.grid_spec([str(grid)],pilot['key'])
            with A.forbid_work(np,A6,M2):
                ser,_,_=R12.load_series(spec);prep=A6.Prep6(ser,24,with_fbL=False)
                def record(cutoff,coef):
                    i=np.arange(prep.n,dtype=np.int64);mature=i+24<=(cutoff-ser.base_ts)//3600
                    reg=np.flatnonzero(prep.okH&mature)
                    need((coef is None)==(len(reg)<4),'declared retained coefficient branch')
                    sigma=prep.sigma_H(coef);_,valid=prep.z_of(sigma)
                    main=np.flatnonzero(valid&mature);fallback=np.flatnonzero(prep.P.valid[1.]&mature)
                    end=lambda ix:None if not len(ix) else int(ser.base_ts+3600*(int(ix[-1])+24))
                    return {'quarter_cutoff':cutoff,'coef':None if coef is None else coef.tolist(),'n_reg':len(reg),
                            'har_label_end_min':None if not len(reg) else int(ser.base_ts+3600*(int(reg[0])+24)),
                            'har_label_end_max':end(reg),'library_label_end_max':end(main),'fallback_library_label_end_max':end(fallback)}
                current=record(q,np.zeros(4,dtype=np.float64));previous=record(pilot['previous_cutoff'],None)
                need(previous['n_reg']==0,'prior cutoff precedes synthetic history')
                scale=math.sqrt(24/8760.)
                need(prep.P.scale==scale,'original annualized H24 scale')
            accepted=A.reconstruct(np,R12,A6,D,M2,census,producer,spec,current,pilot,0.0)
            main=accepted['main_index'];expected_z=(prep.P.depth[main]/scale).copy()
            need(len(main)>0 and np.all(accepted['main_label_end']>pilot['previous_cutoff']),'declared recent-only fixture')
        # Cold-load new adapter dependencies independently; no historical arrays.
    finally:
        sys.meta_path.remove(finder);sys.path[:]=oldpath
        for name in finder.paths:sys.modules.pop(name,None)
    plan={'pilot':pilot,'legacy_sources':legacy,'files':list(legacy.values())+[A.pin(grid),A.pin(PATHS['producer']),A.pin(PATHS['census'])],
          'roles':{'staging_producer':A.pin(PATHS['producer']),'census':A.pin(PATHS['census'])}}
    metadata=({'required_raw_paths':[str(grid)]},{},
              {'series_horizons':[{'sid':7,'horizon':24,'quarters':[current,previous]}]},0.0)
    arrays,status=N.reconstruct(plan,metadata,A,accepted,out)
    N.exact_witness({k:arrays[k] for k in N.FIELDS},accepted)
    need(status['current']['available'] and not status['previous']['available'],'current eligible, predecessor genuinely unavailable')
    need(status['previous']['reason']=='missing_predecessor_coefficient' and
         all(arrays['previous_'+k].size==0 for k in ('sigma','z','valid')),'no fabricated predecessor values')
    need(np.array_equal(arrays['current_sigma'],np.ones(len(main))) and
         arrays['current_z'].tobytes()==expected_z.tobytes(),'exact original annualized standardized depths')
    refused=False
    try:N.accounting(arrays['current_z'],arrays['main_state'],arrays['main_label_end'],pilot['previous_cutoff'])
    except ValueError:refused=True
    need(refused,'recent-only fixture must not claim accounting qualification')
    for value in legacy.values():A.check(value)
    result={'schema':'q26-fh-depth-cold-synthetic-none-v1','complete':True,'fixture_only':True,'private_arrays_decoded':0,
            'generated_raw_rows':n,'current_main_rows':len(main),'all_five_witness_bits_match':True,'annualized_scale_verified':True,
            'current_available':True,'previous_reason':status['previous']['reason'],'accounting_expected_refusal':True,
            'two_eligible_vintages_qualified':False,'full_new_request_authentication_qualified':False,
            'no_fits':True,'no_predictions':True,'no_scores':True}
    N.write_json(out/'result.json',result)
    print(json.dumps({'complete':True,'fixture_only':True,'result_sha256':sha(out/'result.json')}))

if __name__=='__main__':main()
