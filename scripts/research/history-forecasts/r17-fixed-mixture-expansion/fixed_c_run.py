"""Closed-baseline admission and serial unchanged-C evaluation transport.

DRAFT refuses before scientific imports. This transport never stages baselines,
changes the candidate, refits coefficients, or reuses an old phase allowance.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import types

HERE=Path(__file__).resolve().parent
P_PATH=HERE/'preparation_run.py'
P_SHA='a7db9220016e94c1ad2b8014855ccca0b439de1d8d56878ba13fd9061a6e5c7f'
raw=P_PATH.read_bytes()
if hashlib.sha256(raw).hexdigest()!=P_SHA:raise ValueError('accepted preparation transport changed')
P=types.ModuleType('_q26_fixed_c_accepted_preparation');P.__file__=str(P_PATH)
sys.modules[P.__name__]=P;exec(compile(raw,str(P_PATH),'exec'),vars(P))
need,canonical,pin,checked,read,closure,load=P.need,P.canonical,P.pin,P.checked,P.read,P.closure,P.load
SCOPE='FULL277_UNCHANGED_FIXED_C_EVALUATION'
READY='READY_PARENT_REVIEWED_FULL277_FIXED_C_EVALUATION'
ROOT=HERE.parents[4]/'history-forecasts-full277-fixed-c-2026-10-22-v1'
CHECK_ROOT=HERE.parents[4]/'history-forecasts-full277-fixed-c-check-2026-10-22-v1'
ROLES={'preparation_request','preparation_manifest','preparation_parent_acceptance',
       'producer_terminal','producer_start','producer_stdout','checker_terminal','checker_start','checker_stdout',
       'preparation_run','preparation_check','adapter','fixed_c','fixed_c_check','fixed_c_run','fixed_c_observer'}


def prepared_inventory(manifest_pin,prep,files):
    m=read(manifest_pin,8*1024**2);root=canonical(prep['out'])
    need(manifest_pin['path']==str(root/'manifest.json') and m['schema']=='q26-full277-preparation-manifest-v1' and
         m['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and m['canonical_mapping']==prep['canonical_mapping'] and
         m['empirical_admission_status']=='ADMITTED_BASELINE_PREPARATION_ONLY' and
         m['source_synthetic_component'] is False and m['candidate_evaluation_status']=='NOT_RUN' and
         m['forecast_promotion_status']=='NOT_ADMITTED' and len(m['series_receipts'])==277,'accepted actual baseline manifest')
    expected={canonical(manifest_pin['path'])};old=dict(prep['selected24'])
    for sid,rp in enumerate(m['series_receipts']):
        need(files.get(rp['path'])==rp and rp['path']==str(root/('sid-'+str(sid))/'receipt.json'),'canonical prepared receipt input')
        r=read(rp,65536);expected.add(canonical(rp['path']))
        need(r['schema']=='q26-full277-preparation-series-receipt-v1' and r['sid']==sid and
             r['key']==prep['canonical_mapping'][sid][1] and r['complete'] is True and
             r['mode']==('REUSED_ORIGINAL24' if sid in old else 'PREPARED_ADDITIONAL_SERIES') and
             set(r['outputs'])=={'6','12','24','72','168','metadata'} and
             set(r['rows'])=={'6','12','24','72','168'} and
             all(type(v)is int and 0<=v<=1461 for v in r['rows'].values()),'prepared all-five-H receipt scope')
        for role,p in r['outputs'].items():
            wanted=root/('sid-'+str(sid))/('quarter-metadata.json' if role=='metadata' else 'horizon-'+role+'.npz')
            need(p['path']==str(wanted) and files.get(p['path'])==p,'all prepared output bytes in flat closure');checked(p)
            expected.add(wanted)
    actual={p for p in root.rglob('*') if p.is_file()}
    need(len(actual)==1940 and actual==expected and
         all(not p.is_symlink() for p in root.rglob('*')),'exact immutable1940 prepared files')
    return m


def baseline_proof(q,prep,manifest,files):
    """Authenticate immutable CLOSED O166 evidence without phase activation."""
    pins=q['pins'];request=pins['preparation_request'];mp=pins['preparation_manifest']
    clean={}
    for kind,termkey,startkey,stdoutkey in (
            ('producer','producer_terminal','producer_start','producer_stdout'),
            ('saved_check','checker_terminal','checker_start','checker_stdout')):
        t=read(pins[termkey],65536);s=read(pins[startkey],65536)
        need(t['schema']=='q26-weighted-causal-primary-pair-observer-terminal-v1' and
             t['complete'] is True and type(t['tool_terminal_exit'])is int and t['tool_terminal_exit']==0 and
             t['process_terminal'] is True and t['observer_timeout'] is False and t['reason'] is None and
             t['errors']==[] and t['fixture_only'] is False and
             t['containment']==dict(reaped=True,no_live_members_remaining=True,remaining_live_members=[]),
             'actual clean closed O166 terminal')
        need(type(t['charged_seconds'])is int and t['charged_seconds']==math.ceil(t['elapsed_seconds']) and
             0<=t['elapsed_seconds']<=1800,'recorded O166 elapsed and charge')
        need(files.get(t['request']['path'])==t['request'],'closed observer request in flat closure')
        outer=read(t['request'],2*1024**2)
        argv=[prep['runtime']['invocation_path'],'-B',pins['preparation_run']['path'],'--mode',
              'produce' if kind=='producer' else 'check','--request',request['path'],'--request-sha256',request['sha256']]
        if kind=='saved_check':argv+=['--manifest',mp['path'],'--manifest-sha256',mp['sha256']]
        need(outer['schema']=='q26-full277-preparation-observer-request-v1' and outer['kind']==kind and
             outer['fixture_only'] is False and outer['inner_request']==request and
             outer['runner']==t['runner']==pins['preparation_run'] and outer['argv']==argv and
             outer['python_pin']==prep['runtime']['executable'] and
             outer['invocation_python']==prep['runtime']['invocation_path'] and
             outer['resolved_python']==prep['runtime']['executable']['path'] and
             outer['policy']==dict(wall_seconds=1800,rss_bytes=1342177280,output_bytes=805306368,disk_reserve_bytes=2415919104),
             'closed preparation exact argv/source/runtime/resource binding')
        expected_out=prep['out'] if kind=='producer' else str(P.CHECK_ROOT)
        need(outer['output']==expected_out,'closed preparation physical output binding')
        need(s['schema']=='q26-weighted-causal-primary-pair-observer-start-v1' and s['request']==t['request'] and
             s['runner']==outer['runner'] and s['policy']==outer['policy'] and s['fixture_only'] is False,
             'closed start/terminal binding')
        need(pins[startkey]['path']==pins[termkey]['path']+'.start.json' and
             pins[stdoutkey]['path']==pins[termkey]['path']+'.stdout.log','closed physical proof log paths')
        for p in [outer['phase'],*outer['source_pins'],*outer['runtime_pins']]:
            need(files.get(p['path'])==p,'closed nested observer closure');checked(p)
        phase=read(outer['phase'],65536)
        need(phase['schema']=='q26-full277-preparation-phase-v1' and phase['status']=='ADMITTED_PARENT_REVIEWED' and
             phase['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and phase['total_seconds']==3720 and
             phase['producer_seconds']==phase['checker_seconds']==1800 and phase['cleanup_seconds']==120 and
             phase['deadline_unix']==phase['started_unix']+3720,'closed phase recorded allocation only')
        clean[kind]=(t,outer,phase)
    producer,po,pp=clean['producer'];checker,co,cp=clean['saved_check']
    need(co['producer_observer_terminal']==pins['producer_terminal'] and co['producer_manifest']==mp and
         cp['producer_terminal']==pins['producer_terminal'] and cp['producer_manifest']==mp and
         all(cp[k]==pp[k] for k in ('started_unix','deadline_unix','total_seconds','producer_seconds','checker_seconds','cleanup_seconds')),
         'O166 checker bound actual producer and unchanged historical clock')
    produced=read(pins['producer_stdout'],65536)
    need(produced['schema']=='q26-full277-preparation-produced-v1' and produced['complete'] is True and
         produced['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and produced['request']==request and
         produced['manifest']==mp and produced['series']==277 and produced['original24_reused_exact'] is True and
         produced['empirical_baseline_preparation'] is True and produced['C_candidate_evaluated'] is False and
         produced['forecast_promotion_status']=='NOT_ADMITTED','actual producer JSON proof, not an inferred success flag')
    checked_proof=read(pins['checker_stdout'],65536)
    need(checked_proof['schema']=='q26-full277-preparation-check-v1' and checked_proof['complete'] is True and
         checked_proof['request_sha256']==request['sha256'] and checked_proof['manifest_sha256']==mp['sha256'] and
         checked_proof['series']==277 and checked_proof['horizons_per_series']==5 and
         checked_proof['original24_reused_exact'] is True and
         checked_proof['additional253_retained_coefficient_replay'] is True and
         checked_proof['checker_regression_calls']==0 and checked_proof['C_candidate_evaluated'] is False,
         'actual independent saved-baseline stdout proof')
    parent=read(pins['preparation_parent_acceptance'],65536)
    need(parent['schema']=='q26-full277-preparation-parent-acceptance-v1' and parent['label']=='CODEX CONTINUATION' and
         parent['scope']=='FULL277_ORIGINAL_RECIPE_PREPARATION' and parent['complete'] is True and
         parent['full277_baseline_preparation']=='PASS' and parent['series']==277 and
         parent['output_files_rehashed']==1940 and parent['original24_exact_reuse'] is True and
         parent['additional253_original_recipe_retained_coefficient_replay'] is True and
         parent['synthetic_inventory_fixture_series']==0 and parent['phase_closed'] is True and
         parent['no_live_numerical_jobs'] is True and parent['C_candidate_evaluated'] is False and
         parent['forecast_promotion_status']=='NOT_ADMITTED' and parent['unseen_validation'] is False and
         parent['producer_seconds']==producer['elapsed_seconds'] and parent['checker_seconds']==checker['elapsed_seconds'] and
         parent['charged_seconds']==producer['charged_seconds']+checker['charged_seconds'],
         'externally pinned O166 parent acceptance and terminal timing')


def protected_roots(q,prep,old,raw_scope):
    return P.protected_roots(prep,old,raw_scope)|{canonical(prep['out'])}


def protect_targets(targets,files,roots):return P.protect_targets(targets,files,roots)


def authenticate(path,sha,*,mode):
    request=pin(path);need(request['sha256']==sha,'external fixed-C request SHA')
    q=read(request)
    need(q.get('status','DRAFT')==READY,'DRAFT: unchanged fixed-C evaluation not admitted')
    need(set(q)=={'schema','status','scope','pins','files','runtime','canonical_mapping','selected24','out'} and
         q['schema']=='q26-full277-fixed-c-request-v1' and q['scope']==SCOPE and
         set(q['pins'])==ROLES and mode in ('produce','check'),'exact unchanged fixed-C request')
    files=closure(q['files'])
    for p in q['pins'].values():need(files.get(p['path'])==p,'all fixed-C authority roles in flat closure')
    for role,name in (('preparation_run','preparation_run.py'),('preparation_check','preparation_check.py'),('adapter','adapter.py'),
                      ('fixed_c','fixed_c.py'),('fixed_c_check','fixed_c_check.py'),('fixed_c_run','fixed_c_run.py'),
                      ('fixed_c_observer','fixed_c_observer.py')):
        need(q['pins'][role]==pin(HERE/name),'fixed executing source identity')
    need(q['pins']['preparation_run']==pin(P_PATH),'accepted metadata-only authentication source')
    prep,old,C,raw_scope,_=P.authenticate(q['pins']['preparation_request']['path'],
                                        q['pins']['preparation_request']['sha256'],mode='check')
    need(all(files.get(p['path'])==p for p in prep['files']),'unchanged entire accepted input closure')
    need(q['runtime']==prep['runtime'] and q['canonical_mapping']==prep['canonical_mapping'] and
         q['selected24']==prep['selected24'],'same accepted runtime/universe/selection')
    manifest=prepared_inventory(q['pins']['preparation_manifest'],prep,files)
    baseline_proof(q,prep,manifest,files)
    out=canonical(q['out']);need(out==ROOT,'fixed new unchanged-C output')
    if mode=='produce':need(not out.exists(),'fresh fixed-C output')
    else:need(out.is_dir(),'existing saved fixed-C output')
    protect_targets([out],q['files'],protected_roots(q,prep,old,raw_scope))
    return q,prep,old,C,raw_scope,request


def execute(path,sha,*,mode,manifest_path=None,manifest_sha=None):
    q,prep,old,C,raw_scope,request=authenticate(path,sha,mode=mode)
    mp=None
    if mode=='check':
        need(manifest_path==str(ROOT/'manifest.json') and manifest_sha,'parent externally sealed fixed-C manifest')
        mp=pin(manifest_path);need(mp['sha256']==manifest_sha,'external fixed-C manifest SHA')
    A,science,R12,A6,M2,D,specs,finder=P.science_context(prep,old,raw_scope)
    try:
        # Required accepted dependency aliases compile exact bytes, never stale pyc.
        sys.modules['control_check']=C
        PC=load(q['pins']['preparation_check'],'preparation_check')
        component=load(q['pins']['fixed_c' if mode=='produce' else 'fixed_c_check'],
                       '_q26_fixed_c_component_'+mode)
        return numerical(q,prep,old,C,PC,science,A,R12,A6,M2,D,specs,request,component,mode,mp)
    finally:
        if finder in sys.meta_path:sys.meta_path.remove(finder)


def needs_raw_series(baseline):
    """Loader optimization only; never select by J, outcomes or support strength."""
    n=baseline['rows']['24']
    need(type(n)is int and 0<=n<=1461,'bounded prepared source rows')
    return n>0


def numerical(q,prep,old,C,PC,science,A,R12,A6,M2,D,specs,request,component,mode,manifest_pin):
    # The component API owns exact scoring and private-state persistence. Transport
    # supplies only authenticated original inputs and the unchanged canonical order.
    prepared=read(q['pins']['preparation_manifest'],8*1024**2)['series_receipts']
    if mode=='produce':ROOT.mkdir(mode=0o700)
    receipts=[];bundles=[]
    if mode=='check':
        manifest=read(manifest_pin,8*1024**2);receipts=manifest['series_receipts']
        need(len(receipts)==277,'all277 evaluated receipts')
    reads=[p['path'] for p in q['files']]+[request['path']]
    if mode=='check':
        reads.append(manifest_pin['path'])
        for rp in receipts:
            r=read(rp,65536);reads+=[rp['path'],r['summary']['path']]+[p['path'] for p in r['quarters']]
        reads += [p['path'] for p in manifest['reports'].values()]
    guard_root=ROOT if mode=='produce' else CHECK_ROOT
    with science.producer.guard(reads,guard_root):
        for sid,key in q['canonical_mapping']:
            ser=None
            try:
                # No baseline reconstruction, feature restaging or coefficient fit.
                baseline=read(prepared[sid],65536)
                if needs_raw_series(baseline):
                    ser,_,_=R12.load_series(specs[key])
                if mode=='produce':
                    result=component.evaluate_one(A,science,PC,A6,M2,D,ser,sid,key,prepared[sid],ROOT,status=READY)
                    receipts.append(result)
                else:
                    bundles.append(component.check_one(science,A6,M2,D,ser,sid,key,prepared[sid],receipts[sid],status=READY))
                print(json.dumps(dict(completed_sid=sid,mode=mode)),file=sys.stderr,flush=True)
            finally:
                del ser;R12._CHAIN.clear()
        cuts=read(old['pins']['cuts'])['horizons']['24']
        old_result=prep['pins']['original_control_result']
        old_manifest=read(old_result)
        old_canonical=next(p for p in old_manifest['outputs'] if p['path'].endswith('/canonical-native-report.json'))
        if mode=='produce':
            control=load(old['pins']['control'],'_q26_fixed_c_original_control')
            original_private=[p for p in old_manifest['outputs'] if '.private.' in Path(p['path']).name]
            need(len(original_private)==382,'accepted original191 private pairs')
            result=component.finalize(A,control,science,PC,q['canonical_mapping'],q['selected24'],receipts,cuts,
                original_private,read(old_canonical),ROOT,status=READY)
            proof=dict(schema='q26-full277-fixed-c-produced-v1',complete=True,scope=SCOPE,request=request,
                manifest=result,series=277,unchanged_C_evaluated=True,original24_controls='EXACT',
                forecast_promotion_status='NOT_ADMITTED',unseen_validation=False)
        else:
            proof=component.check_manifest(science,manifest_pin,q['canonical_mapping'],q['selected24'],bundles,cuts,
                                            old_result,old_canonical,status=READY)
            proof.update(request_sha256=request['sha256'],manifest_sha256=manifest_pin['sha256'])
    closure(q['files']);need(pin(request['path'])==request,'final fixed-C input/request bytes unchanged')
    return proof


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--mode',choices=('produce','check'),required=True)
    p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True)
    p.add_argument('--manifest');p.add_argument('--manifest-sha256');a=p.parse_args()
    print(json.dumps(execute(a.request,a.request_sha256,mode=a.mode,manifest_path=a.manifest,
                            manifest_sha=a.manifest_sha256),allow_nan=False,separators=(',',':')))
