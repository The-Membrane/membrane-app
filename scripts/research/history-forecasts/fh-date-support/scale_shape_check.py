"""Independent saved-only signed-adverse scale/shape check, with no producer import."""
import argparse
from collections import Counter
import datetime as dt
from fractions import Fraction
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import types

import numpy as np

CAPACITY=200000
MAX_JSON=1048576
QUANTILES=((1,10),(1,4),(1,2),(3,4),(9,10),(19,20),(99,100))
INTERPRETATION='Descriptive ECDF distances on fixed known-state cohorts. Median normalization is a scale comparison, not a significance test, mechanism attribution or forecast evaluation.'
CORE={'basis','result','acceptance','parent','closed','phase','producer_request','checker_request',
      'producer_terminal','checker_terminal','plan','depth_checker_source','python'}
ROLES=CORE|{'analysis_source','analysis_request','analysis_result','source'}


def need(ok,why):
    if not ok:raise ValueError(why)


def canonical(path):
    p=Path(path)
    need(p.is_absolute() and p.resolve()==p and not any(x.is_symlink() for x in (p,*p.parents)),'canonical nonsymlink path')
    return p


def pin(path):
    p=canonical(path);need(p.is_file(),'regular pinned file');h=hashlib.sha256();size=0
    with p.open('rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):h.update(block);size+=len(block)
    return dict(path=str(p),size=size,sha256=h.hexdigest())


def check(value):
    need(type(value)is dict and set(value)=={'path','size','sha256'} and type(value['size'])is int and value['size']>=0,'exact byte pin')
    need(pin(value['path'])==value,'byte pin mismatch');return Path(value['path'])


def read(path,limit=MAX_JSON):
    need(Path(path).stat().st_size<=limit,'bounded JSON metadata')
    def pairs(items):
        out={}
        for k,v in items:need(k not in out,'duplicate JSON key');out[k]=v
        return out
    def bad(_):raise ValueError('nonfinite JSON')
    return json.loads(Path(path).read_bytes(),object_pairs_hook=pairs,parse_constant=bad)


def same(a,b,why='exact saved tree'):
    need(type(a)is type(b),why+' type')
    if isinstance(b,dict):
        need(set(a)==set(b),why+' keys')
        for k in b:same(a[k],b[k],why+'/'+str(k))
    elif isinstance(b,list):
        need(len(a)==len(b),why+' length')
        for x,y in zip(a,b):same(x,y,why)
    else:need(a==b,why+' value')


def packed(value):
    return dict(numerator=str(value.numerator),denominator=str(value.denominator))


def distance(recent,older):
    """Independent grouped rational-key ECDF sweep, including every inclusive tie."""
    r,o=Counter(recent),Counter(older);nr,no=sum(r.values()),sum(o.values())
    need(nr>0 and no>0,'nonempty conditional groups')
    cr=co=best=0
    for key in sorted(r.keys()|o.keys()):
        cr+=r.get(key,0);co+=o.get(key,0)
        best=max(best,abs(cr*no-co*nr))
    need(cr==nr and co==no,'complete rational sweep')
    return Fraction(best,nr*no)


def analyze_pair(recent,older):
    for value in (recent,older):
        need(type(value)is np.ndarray and value.dtype==np.dtype('<f8') and value.ndim==1 and
             0<len(value)<=CAPACITY and np.isfinite(value).all(),'finite binary64 conditional group')
    # Quantiles select original binary64 order statistics. Normalization uses
    # exact rational values of those stored floats, never rounded division.
    ordered={'recent':sorted(map(float,recent)),'older':sorted(map(float,older))}
    values={name:[Fraction.from_float(x) for x in group] for name,group in ordered.items()}
    quantiles={};medians={}
    for name,group in ordered.items():
        n=len(group);items=[]
        for num,den in QUANTILES:
            rank=(num*n+den-1)//den
            value=group[rank-1]
            items.append(dict(probability=[num,den],rank=rank,value_hex=(0.0 if value==0 else value).hex(),
                              exact_value=packed(Fraction.from_float(value))))
        quantiles[name]=items;medians[name]=Fraction.from_float(group[(n-1)//2])
    raw=distance(values['recent'],values['older'])
    okay=all(value>0 for value in medians.values())
    if okay:
        normalized=distance([x/medians['recent'] for x in values['recent']],
                            [x/medians['older'] for x in values['older']])
        profiles={name:[packed(Fraction(int(q['exact_value']['numerator']),int(q['exact_value']['denominator']))/medians[name])
                        for q in quantiles[name]] for name in ('recent','older')}
        direction='reduced' if normalized<raw else 'increased' if normalized>raw else 'equal'
    else:normalized=profiles=direction=None
    return dict(recent_rows=len(recent),older_rows=len(older),raw_ks=packed(raw),quantiles=quantiles,
                normalization=dict(available=okay,reason=None if okay else 'nonpositive_median',
                    medians={k:packed(v) for k,v in medians.items()},median_relative_profiles=profiles,
                    normalized_ks=None if normalized is None else packed(normalized),direction=direction))


def predecessor(q):
    need(type(q)is int,'integer current cutoff');d=dt.datetime.fromtimestamp(q,dt.timezone.utc)
    need(d.month in (1,4,7,10) and d.day==1 and d.hour==d.minute==d.second==d.microsecond==0,'calendar quarter')
    return int(dt.datetime(d.year-(d.month==1),10 if d.month==1 else d.month-3,1,tzinfo=dt.timezone.utc).timestamp())


def analyze_basis(current_z,previous_z,states,ends,previous_cutoff,current_cutoff,expected_reports):
    n=len(ends)
    need(type(previous_cutoff)is int and previous_cutoff==predecessor(current_cutoff),'immediate predecessor')
    need(type(states)is np.ndarray and type(ends)is np.ndarray and states.dtype==np.dtype('i1') and ends.dtype==np.dtype('<i8') and
         states.shape==ends.shape==(n,) and 0<n<=CAPACITY and np.isin(states,(0,1,-1)).all() and
         np.all(ends%3600==0) and np.all(ends<=current_cutoff) and np.all(np.diff(ends)>0),'full saved state/date cohort')
    for value in (current_z,previous_z):
        need(type(value)is np.ndarray and value.dtype==np.dtype('<f8') and value.shape==(n,) and np.isfinite(value).all(),'entire eligible vintage depth vector')
    older=ends<=previous_cutoff
    totals=[sum(int(s)==state and bool(old)==date for s,old in zip(states,older))
            for state in (0,1,-1) for date in (False,True)]
    dates=[sum(totals[0::2]),sum(totals[1::2])]
    need(dates[0]>0 and dates[1]>0 and all(x>0 for x in totals[:4]),'four observed known-state pairs')
    need(set(expected_reports)=={'current','previous'},'exact eligible vintage reports')
    for report in expected_reports.values():
        need(report['available']is True and report['rows']==n and report['date_rows']==dates and
             report['state_date_rows']==totals,'accepted accounting support and rows')
    pairs={}
    for name,z in [('current',current_z),('previous',previous_z)]:
        for state in (0,1):
            recent=np.asarray(-z[(states==state)&~older],dtype='<f8')
            old=np.asarray(-z[(states==state)&older],dtype='<f8')
            pairs[name+'_state_'+str(state)]=analyze_pair(recent,old)
    return dict(schema='q26-fh-scale-shape-analysis-v1',target='signed_adverse_excursion_X_equals_minus_Z',
                known_states=[0,1],quantile_ratios=[list(v) for v in QUANTILES],pairs=pairs,
                provenance_counts=dict(cell_order=[[s,d] for s in (0,1,-1) for d in ('recent','older')],
                    date_rows=dates,state_date_rows=totals,unknown_rows=totals[4]+totals[5]),interpretation=INTERPRETATION)


def runtime(plan,python_pin):
    r=plan['runtime']
    need(r['executable']==python_pin and Path(sys.executable).resolve()==Path(python_pin['path']) and
         r['python_path']==sys.executable and r['python_version']==sys.version.split()[0],'accepted runtime identity')
    need(sys.dont_write_bytecode and not sys.flags.optimize and
         all(os.environ.get(k)==v for k,v in r['env'].items()),'one-thread runtime flags')
    need(r['env']=={'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1',
                   'PYTHONDONTWRITEBYTECODE':'1','PYTHONOPTIMIZE':'0'},'exact runtime environment')
    need(set(r['packages'])=={'numpy','scipy','numba','llvmlite'},'runtime package identity set')
    for name,version in r['packages'].items():need(importlib.metadata.version(name)==version,'runtime package version')


def accepted_root(pins,producer_out):
    root=canonical(pins['phase']['path']).parent
    need(canonical(producer_out)==root/'producer' and
         canonical(pins['parent']['path']).parent==root and canonical(pins['closed']['path']).parent==root,
         'phase-derived accepted root and authority locations')
    return root


def outside_old(path,root):
    out=canonical(path)
    need(not out.is_relative_to(root),'output outside whole accepted evidence root')
    return out


def old_chain(pins):
    """Authenticate saved O153 lineage only. Never import original model sources."""
    result,accept,parent,closed,phase,pr,cr,plan=[read(pins[k]['path']) for k in
        ('result','acceptance','parent','closed','phase','producer_request','checker_request','plan')]
    need(result['schema']=='q26-fh-depth-accounting-result-v1' and result['complete']is True and
         result['historical_bridge_parity']=='UNAVAILABLE' and result['reconstruction']is True,'accepted reconstructed depth report')
    need(accept['schema']=='q26-fh-depth-check-acceptance-v1' and accept['complete']is True and
         accept['result_sha256']==pins['result']['sha256'] and accept['request_sha256']==pins['checker_request']['sha256'] and
         accept['checker_source']==pins['depth_checker_source'],'independent accepted depth result')
    need(parent['schema']=='q26-depth-parent-acceptance-v1' and parent['complete']is True and
         parent['all_final_pins']=='PASS' and parent['result']==pins['result'] and parent['basis']==pins['basis'] and
         parent['independent_acceptance']==pins['acceptance'] and parent['vintages_both_available']is True and
         parent['original_inventory_preserved']is True and parent['historical_bridge_parity']=='UNAVAILABLE','parent accepted saved basis')
    need(closed['schema']=='q26-depth-phase-closed-v1' and closed['status']=='CLOSED_ACCEPTED' and
         closed['admission_authority']==pins['phase'] and closed['parent_acceptance_path']==pins['parent']['path'] and
         closed['no_running_jobs']is True and closed['unused_reused']is False,'accepted closed old phase')
    need(phase['schema']=='q26-fh-depth-phase-v1' and phase['parent_admitted']is True and
         phase['inner_request']==pins['producer_request'] and phase['closed_prior_capacity_reused']is False,'old immutable admission')
    need(pr['schema']=='q26-fh-depth-accounting-request-v1' and result['request_sha256']==pins['producer_request']['sha256'] and
         result['request_pins']==pr['pins'] and result['basis']==pins['basis'] and pr['pins']['plan']==pins['plan'],'original producer binding')
    need(cr['schema']=='q26-fh-depth-check-request-v1' and cr['pins']['producer_request']==pins['producer_request'] and
         cr['pins']['result']==pins['result'] and cr['pins']['basis']==pins['basis'] and
         cr['pins']['plan']==pins['plan'] and cr['pins']['checker_source']==pins['depth_checker_source'],'original independent request')
    need(plan['schema']=='q26-fh-date-support-plan-v1' and plan['parent_admitted']is True and
         plan['mode']=='NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT' and plan['row_capacity']==CAPACITY,'original full cohort plan')
    runtime(plan,pins['python'])
    extras=[result['started'],result['source'],accept['producer_terminal']]
    need(accept['producer_terminal']==cr['pins']['terminal'] and result['source']==pr['pins']['source'] and
         pr['pins']['python']==cr['pins']['python']==pins['python'],'saved source/runtime/terminal binding')
    need(read(result['started']['path'])=={'schema':'q26-fh-depth-accounting-started-v1',
         'request_sha256':pins['producer_request']['sha256'],'reconstruction':True},'old immutable started marker')
    charges=0
    for name,inner,source in [('producer',pins['producer_request'],result['source']),
                              ('checker',pins['checker_request'],pins['depth_checker_source'])]:
        t=read(pins[name+'_terminal']['path'])
        need(t['schema']=='q26-weighted-causal-primary-pair-observer-terminal-v1' and t['complete']is True and
             type(t['tool_terminal_exit'])is int and t['tool_terminal_exit']==0 and t['process_terminal']is True and
             t['observer_timeout']is False and t['fixture_only']is False and t['reason']is None and t['errors']==[] and
             t['containment']['reaped']is True and t['containment']['no_live_members_remaining']is True and
             t['containment']['remaining_live_members']==[],'old clean terminal')
        extras.append(t['request']);check(t['request']);outer=read(t['request']['path'])
        need(outer['schema']=='q26-fh-depth-observer-request-v1' and outer['kind']==('producer' if name=='producer' else 'saved_check') and
             outer['fixture_only']is False and outer['inner_request']==inner and
             outer['runner']==source==t['runner'] and outer['python_pin']==pins['python'],'old sealed request')
        argv=[plan['runtime']['python_path'],'-B',source['path'],'--request',inner['path'],'--request-sha256',inner['sha256']]
        if name=='producer':
            need(phase['producer_observer_request']==t['request'] and outer['output']==pr['out'],'old producer phase linkage')
            argv+=['--out',pr['out']]
        else:need(outer['output']==cr['out']==pins['acceptance']['path'],'old checker output linkage')
        same(outer['argv'],argv,'old exact command')
        need(type(t['charged_seconds'])is int and t['charged_seconds']>=0,'old integer charge');charges+=t['charged_seconds']
    need(closed['charged_seconds']==charges and closed['fresh_allocation_seconds']==phase['fresh_allocation_seconds'] and
         closed['unused_seconds']+charges==closed['fresh_allocation_seconds'],'closed phase charge reconciliation')
    need(set(result['vintages'])=={'current','previous'} and all(v['available']is True for v in result['vintages'].values()),'both accepted coefficient vintages')
    for value in extras:check(value)
    oldroot=accepted_root(pins,pr['out'])
    root=canonical(pr['out']);need(root==canonical(pins['basis']['path']).parent,'old exact output root')
    for role,filename in [('basis','basis.npz'),('result','result.json')]:need(Path(pins[role]['path'])==root/filename,'old exact output filename')
    need(Path(result['started']['path'])==root/'started.json' and
         {p.name for p in root.iterdir()}=={'started.json','basis.npz','result.json'},'old unchanged inventory')
    return result,plan,extras,oldroot,root


def authenticate(path,sha):
    p=canonical(path);need(p.stat().st_size<=65536 and pin(p)['sha256']==sha,'external checker request SHA')
    request=read(p,65536)
    need(set(request)=={'schema','pins','out'} and request['schema']=='q26-fh-scale-shape-check-request-v1' and
         set(request['pins'])==ROLES,'exact checker request schema')
    pins=request['pins']
    for value in pins.values():check(value)
    need(pins['source']==pin(Path(__file__).absolute()),'executed independent source')
    oldresult,plan,extras,oldroot,producerroot=old_chain(pins)
    need(pins['analysis_request']['size']<=65536 and pins['analysis_result']['size']<=MAX_JSON,'bounded new saved analysis')
    ar=read(pins['analysis_request']['path'],65536);report=read(pins['analysis_result']['path'])
    need(set(ar)=={'schema','pins','out'} and ar['schema']=='q26-fh-scale-shape-request-v1' and
         set(ar['pins'])==CORE|{'source'},'producer analysis request schema')
    for key in CORE:same(ar['pins'][key],pins[key],'identical saved authority')
    same(ar['pins']['source'],pins['analysis_source'],'analysis source pin')
    need(ar['out']==pins['analysis_result']['path'],'exact saved analysis destination');outside_old(ar['out'],oldroot)
    need(set(report)=={'schema','label','complete','request_sha256','request_pins','source','analysis','limitations'} and
         report['schema']=='q26-fh-scale-shape-result-v1' and report['label']=='CODEX CONTINUATION' and report['complete']is True and
         report['request_sha256']==pins['analysis_request']['sha256'] and report['source']==pins['analysis_source'],'new complete report')
    same(report['request_pins'],ar['pins'],'saved analysis request pins');same(report['limitations'],INTERPRETATION,'fixed interpretation')
    out=outside_old(request['out'],oldroot)
    need(not out.exists() and out.parent.is_dir() and
         str(out) not in {v['path'] for v in pins.values()} and str(out) not in {v['path'] for v in extras},'exclusive external acceptance')
    # The old saved-checker module is transport-only. No model source, metadata
    # authenticator, reconstruction or reduction method is invoked.
    source=check(pins['depth_checker_source']);transport=types.ModuleType('_scale_shape_old_transport')
    transport.__file__=str(source);exec(compile(source.read_bytes(),str(source),'exec'),transport.__dict__)
    transport.basis_headers(pins['basis']['path'])
    return request,oldresult,plan,report,extras,producerroot


def run(path,sha):
    request,oldresult,plan,report,extras,producerroot=authenticate(path,sha);pins=request['pins']
    with np.load(pins['basis']['path'],allow_pickle=False) as saved:
        # Exactly four saved arrays are decoded; all other arrays remain unopened.
        current=saved['current_z'];previous=saved['previous_z'];states=saved['main_state'];ends=saved['main_label_end']
    expected=analyze_basis(current,previous,states,ends,plan['pilot']['previous_cutoff'],
                           plan['pilot']['current_cutoff'],oldresult['vintages'])
    same(report['analysis'],expected,'independent four-pair exact analysis')
    for value in list(pins.values())+extras:check(value)
    need(pin(path)['sha256']==sha and {p.name for p in producerroot.iterdir()}=={'started.json','basis.npz','result.json'},'final request and old inventory')
    receipt=dict(schema='q26-fh-scale-shape-acceptance-v1',label='CODEX CONTINUATION',complete=True,
        request_sha256=sha,analysis_result=pins['analysis_result'],checker_source=pins['source'],
        proof=dict(four_fixed_known_state_pairs_exact=True,raw_ks_complete_ties_exact=True,
                   nearest_rank_quantiles_exact=True,median_normalized_rational_key_ks_exact=True,
                   nonpositive_median_unavailability_retains_raw_statistics=True,
                   signed_adverse_orientation_no_abs_clamp_or_filter=True,new_producer_imported=False,
                   original_model_sources_executed=False,original_raw_arrays_decoded=False),
        interpretation=INTERPRETATION)
    payload=(json.dumps(receipt,sort_keys=True,allow_nan=False)+'\n').encode();need(len(payload)<=MAX_JSON,'bounded receipt')
    fd=os.open(request['out'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(payload);stream.flush();os.fsync(stream.fileno())
    return receipt


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True)
    a=p.parse_args();run(a.request,a.request_sha256)
