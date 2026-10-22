"""Authenticated full277 original-recipe preparation, with separate saved checker.

DRAFT is the default refusal. Numerical input access occurs only after complete
metadata/byte-closure authentication and the external parent's observer admission.
No residual learner or conditional-mixture candidate is fitted/evaluated here.
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
import types

HERE=Path(__file__).resolve().parent
SCOPE='FULL277_ORIGINAL_RECIPE_PREPARATION'
READY='READY_PARENT_REVIEWED_FULL277_PREPARATION'
ROOT=HERE.parents[4]/'history-forecasts-full277-preparation-2026-10-22-v1'
CHECK_ROOT=HERE.parents[4]/'history-forecasts-full277-preparation-check-2026-10-22-v1'
ROLES={'original_control_request','original_control_result','parent_acceptance',
       'producer_terminal','producer_start','checker_terminal','checker_start','checker_stdout',
       'control_check','adapter','preparation','preparation_check','preparation_run','preparation_observer'}


def need(ok,message):
    if not ok:raise ValueError(message)


def canonical(path):
    p=Path(path)
    need(p.is_absolute() and str(p.resolve())==str(p) and not p.is_symlink() and
         not any(v.is_symlink() for v in p.parents),'canonical nonsymlink path')
    return p


def pin(path):
    p=canonical(path);h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def checked(record):
    need(type(record)is dict and set(record)=={'path','size','sha256'} and
         type(record['size'])is int and record['size']>=0 and pin(record['path'])==record,'exact current pin')
    return canonical(record['path'])


def read(record,cap=16*1024**2):
    p=checked(record);need(record['size']<=cap,'bounded metadata')
    def pairs(items):
        out={}
        for k,v in items:need(k not in out,'duplicate JSON key');out[k]=v
        return out
    def bad(_):raise ValueError('nonfinite JSON')
    return json.loads(p.read_bytes(),object_pairs_hook=pairs,parse_constant=bad)


def closure(records):
    need(type(records)is list and records,'nonempty byte closure');out={}
    for p in records:
        checked(p);need(p['path'] not in out,'unique byte closure');out[p['path']]=p
    return out


def load(record,name):
    path=checked(record);raw=path.read_bytes()
    need(hashlib.sha256(raw).hexdigest()==record['sha256'],'source unchanged before compile')
    module=types.ModuleType(name);module.__file__=str(path);sys.modules[name]=module
    exec(compile(raw,str(path),'exec'),vars(module));return module


def old_control_proof(q,old,C,files):
    """Authenticate CLOSED O163 history; never reactivate its expired phase."""
    p=q['pins'];request=p['original_control_request'];result=p['original_control_result']
    produced,_=C.authenticate_outputs(old,request['sha256'],result['path'],result['sha256'])
    for value in produced['outputs']:
        need(files.get(value['path'])==value,'all historical control outputs in flat closure')
    need(produced['original24_array_parity']=='EXACT_ALL_FIELDS' and
         produced['original54_native_report_parity']=='EXACT' and
         produced['canonical54_adapter_report_parity']=='EXACT' and
         produced['regression_calls']==0 and produced['full277_scientific_coverage'] is False,
         'exact original24 prior control')
    for kind,term_role,start_role,runner_name,wall in (
            ('producer','producer_terminal','producer_start','control.py',240),
            ('saved_check','checker_terminal','checker_start','control_check.py',300)):
        terminal=read(p[term_role],65536);start=read(p[start_role],65536)
        need(terminal['schema']=='q26-weighted-causal-primary-pair-observer-terminal-v1' and
             terminal['complete'] is True and terminal['tool_terminal_exit']==0 and
             type(terminal['tool_terminal_exit'])is int and terminal['process_terminal'] is True and
             terminal['observer_timeout'] is False and terminal['reason'] is None and
             terminal['errors']==[] and terminal['fixture_only'] is False and
             terminal['containment']==dict(reaped=True,no_live_members_remaining=True,remaining_live_members=[]),
             'clean historical O163 terminal')
        need(type(terminal['charged_seconds'])is int and
             terminal['charged_seconds']==math.ceil(terminal['elapsed_seconds']) and
             0<=terminal['elapsed_seconds']<=wall,'historical recorded elapsed/charge')
        need(files.get(terminal['request']['path'])==terminal['request'],'historical observer request in flat closure')
        outer=read(terminal['request'],2*1024**2)
        for value in [outer['phase'],*outer['source_pins'],*outer['runtime_pins']]:
            need(files.get(value['path'])==value,'historical observer nested metadata in flat closure')
        runner=pin(HERE/runner_name)
        expected=[old['runtime']['invocation_path'],'-B',runner['path'],'--request',request['path'],
                  '--request-sha256',request['sha256']]
        if kind=='saved_check':expected+=['--result',result['path'],'--result-sha256',result['sha256']]
        need(outer['schema']=='q26-original24-control-observer-request-v1' and outer['kind']==kind and
             outer['fixture_only'] is False and outer['inner_request']==request and
             outer['runner']==terminal['runner']==runner and outer['argv']==expected and
             outer['python_pin']==old['runtime']['executable'] and
             outer['policy']==dict(wall_seconds=wall,rss_bytes=1342177280,output_bytes=33554432,disk_reserve_bytes=2415919104),
             'historical exact observer command/runtime/resource binding')
        need(start['schema']=='q26-weighted-causal-primary-pair-observer-start-v1' and
             start['request']==terminal['request'] and start['runner']==runner and
             start['policy']==outer['policy'] and start['fixture_only'] is False,
             'historical start/terminal identity')
        # Every nested historical source/request remains byte-authenticated.
        checked(outer['phase']);closure(outer['source_pins']);closure(outer['runtime_pins'])
    proof=read(p['checker_stdout'],65536)
    need(proof['schema']=='q26-original24-independent-control-check-v1' and proof['complete'] is True and
         proof['scope']=='ORIGINAL24_SAVED_REPLAY_CONTROL' and proof['request_sha256']==request['sha256'] and
         proof['result_sha256']==result['sha256'] and proof['exact_original_private_pairs']==191 and
         proof['exact_original_native_views']==proof['exact_canonical_adapter_views']==54 and
         proof['unexecuted_series']==253 and proof['full277_scientific_coverage'] is False and
         proof['scientific_acceptance'] is False,'actual independent O163 stdout proof')
    checker_outer=read(read(p['checker_terminal'],65536)['request'],2*1024**2)
    need(p['checker_stdout']['path']==p['checker_terminal']['path']+'.stdout.log' and
         p['checker_start']['path']==p['checker_terminal']['path']+'.start.json' and
         p['producer_start']['path']==p['producer_terminal']['path']+'.start.json' and
         checker_outer['producer_manifest']==result and
         checker_outer['producer_observer_terminal']==p['producer_terminal'],'old proof physical lineage')
    parent=read(p['parent_acceptance'],65536)
    need(parent['schema']=='q26-original24-control-parent-acceptance-v1' and parent['label']=='CODEX CONTINUATION' and
         parent['scope']=='ORIGINAL24_SAVED_REPLAY_CONTROL' and parent['complete'] is True and
         parent['original24_replay']=='PASS_EXACT' and parent['independent_saved_checker']=='PASS' and
         parent['phase_closed'] is True and parent['no_live_jobs'] is True and
         parent['full277_scientific_coverage'] is False and parent['new_forecast_improvement_established'] is False,
         'externally bound parent original24 acceptance')
    for name,digest in parent['source_hashes'].items():
        need(pin(HERE/name)['sha256']==digest,'accepted historical source remains immutable')


def protected_roots(q,old,raw):
    """Genuine immutable trees, not the shared parent of historical receipts."""
    roots={canonical(old['pins']['raw_scope']['path']).parent,
           canonical(raw['datasets']),canonical(old['out']),HERE.parents[3],
           canonical(str(Path(old['runtime']['invocation_path']).parent.parent)),
           canonical(old['runtime']['executable']['path']).parent}
    roots.update(canonical(p['path']).parent for p in old['runtime']['native_pins'])
    return roots


def protect_targets(targets,files,roots):
    """Permit fresh evidence siblings while preserving exact inputs and trees."""
    paths=[canonical(p['path']) for p in files]
    for target in targets:
        target=canonical(target)
        need(all(target!=p and not p.is_relative_to(target) for p in paths),
             'destination cannot replace or contain any immutable input')
        need(all(not target.is_relative_to(root) for root in roots),
             'destination outside protected source/data/evidence/runtime trees')


def authenticate(path,sha,*,mode):
    request=pin(path);need(request['sha256']==sha,'external full277 request SHA')
    q=read(request)
    need(q.get('status','DRAFT')==READY,'DRAFT: full277 preparation not admitted')
    need(set(q)=={'schema','status','scope','pins','files','runtime','canonical_mapping','selected24','out'} and
         q['schema']=='q26-full277-preparation-request-v1' and q['scope']==SCOPE and
         set(q['pins'])==ROLES and mode in ('produce','check'),'fixed full277 request')
    files=closure(q['files'])
    for p in q['pins'].values():need(files.get(p['path'])==p,'all authority roles in closure')
    for role,name in (('control_check','control_check.py'),('adapter','adapter.py'),('preparation','preparation.py'),
                      ('preparation_check','preparation_check.py'),('preparation_run','preparation_run.py'),
                      ('preparation_observer','preparation_observer.py')):
        need(q['pins'][role]==pin(HERE/name),'executing fixed transport source')
    C=load(q['pins']['control_check'],'_q26_full277_old_control_checker')
    sys.modules['control_check']=C  # preparation_check must use these authenticated bytes, never stale pyc.
    old,oldfiles,_,selected=C.authenticate_request(q['pins']['original_control_request']['path'],
                                                 q['pins']['original_control_request']['sha256'])
    need(all(files.get(p)==v for p,v in oldfiles.items()),'unchanged complete O163 input closure')
    need(q['runtime']==old['runtime'],'same qualified current runtime')
    raw=read(old['pins']['raw_scope'])['base_scope']
    allraw=[{k:p[k] for k in ('path','size','sha256')} for p in raw['price_inputs']+raw['auxiliary_inputs']]
    need(len(allraw)==282 and len({p['path'] for p in allraw})==282 and
         all(files.get(p['path'])==p for p in allraw),'all282 raw inputs in closure')
    mapping=[[i,k] for i,k in enumerate(raw['canonical_keys'])]
    need(len(mapping)==277 and len({k for i,k in mapping})==277 and
         q['canonical_mapping']==mapping and q['selected24']==selected,'full canonical277 and frozen24')
    old_control_proof(q,old,C,files)
    out=canonical(q['out']);need(out==ROOT,'fixed new full277 preparation output')
    if mode=='produce':need(not out.exists(),'fresh full277 output')
    else:need(out.is_dir(),'existing prepared full277 output')
    protect_targets([out],q['files'],protected_roots(q,old,raw))
    return q,old,C,raw,request


def science_context(q,old,raw):
    A=load(q['pins']['adapter'],'_q26_full277_adapter')
    science=A.load_science(dict(schema='q26-fixed-mixture-expansion-source-v1',
        status='READY_SYNTHETIC_SOURCE_QUALIFICATION',science=old['science']))
    fit=read(old['pins']['legacy_scope']);paths=[]
    for relative,digest in fit['source_sha256'].items():
        matches=[p['path'] for p in old['files'] if p['path'].endswith('/'+relative) and p['sha256']==digest]
        need(len(matches)==1,'legacy original source identity');paths+=matches
    finder=science.producer.FrozenSources(paths)
    need(not(set(finder.paths)&set(sys.modules)),'cold original legacy modules')
    sys.meta_path.insert(0,finder)
    try:
        R12=importlib.import_module('r12_tail');A6=importlib.import_module('a6_touch')
        M2=importlib.import_module('a2_touch');D=importlib.import_module('r16_dev')
        R12._CHAIN.clear();D._BTC.clear()
        specs={s['key']:s for s in R12.dev_specs(raw['datasets'])}
        need(set(specs)==set(raw['canonical_keys']),'exact original277 loader spec closure')
        btc=str(Path(raw['datasets'])/'binance-klines/BTCUSDT-1h.json')
        need(btc in {p['path'] for p in raw['price_inputs']},'admitted exact BTC dependency')
        return A,science,R12,A6,M2,D,specs,finder
    except BaseException:
        if finder in sys.meta_path:sys.meta_path.remove(finder)
        raise


def execute(path,sha,*,mode,manifest_path=None,manifest_sha=None):
    q,old,C,raw,request=authenticate(path,sha,mode=mode)
    manifest_pin=None
    if mode=='check':
        need(manifest_path==str(ROOT/'manifest.json') and manifest_sha,'external prepared manifest binding')
        manifest_pin=pin(manifest_path);need(manifest_pin['sha256']==manifest_sha,'parent externally sealed manifest')
    A,science,R12,A6,M2,D,specs,finder=science_context(q,old,raw)
    try:
        return execute_numerical(q,old,C,raw,request,mode,manifest_path,manifest_sha,
                                 manifest_pin,A,science,R12,A6,M2,D,specs)
    finally:
        if finder in sys.meta_path:sys.meta_path.remove(finder)


def execute_numerical(q,old,C,raw,request,mode,manifest_path,manifest_sha,manifest_pin,
                      A,science,R12,A6,M2,D,specs):
    arrays={int(h):C.read_archive(p['path']) for h,p in old['inputs'].items()}
    meta={h:{} for h in A.HORIZONS}
    for record in read(old['pins']['manifest'])['series_horizons']:
        need(record['sid'] not in meta[record['horizon']],'unique original metadata');meta[record['horizon']][record['sid']]=record
    component=load(q['pins']['preparation' if mode=='produce' else 'preparation_check'],
                   '_q26_full277_component_'+mode)
    if mode=='produce':ROOT.mkdir(mode=0o700)
    receipts=[];checks=[]
    if mode=='check':
        m=read(manifest_pin);receipts=m['series_receipts']
        need(len(receipts)==277,'all277 prepared receipts')
    # Old five-H archives are the only retained array cache; new series are serial.
    reads=[p['path'] for p in q['files']]+[request['path']]
    # In saved-check mode all prepared outputs are admitted by a sealed manifest.
    if mode=='check':
        reads.append(manifest_path)
        for rp in receipts:
            reads.append(checked(rp).as_posix())
            reads.extend(p['path'] for p in read(rp)['outputs'].values())
    # Saved checker has no authority to write into the prepared input tree.
    guard_root=ROOT if mode=='produce' else CHECK_ROOT
    with science.producer.guard(reads,guard_root) as seen:
        D.init_btc(raw['datasets'])
        for sid,key in q['canonical_mapping']:
            old_sid=sid in dict(q['selected24']);ser=None
            try:
                if not old_sid:ser,_,_=R12.load_series(specs[key])
                if mode=='produce':
                    kwargs={}
                    if not old_sid:
                        features,shape,vmeta=science.producer.raw_features(ser,specs[key],D,A6)
                        kwargs=dict(ser=ser,features=features,shape=shape,feature_metadata=vmeta,A6=A6,M2=M2)
                    receipts.append(component.prepare_one(A,science,sid,key,q['selected24'],arrays,meta,ROOT,
                        status=READY,**kwargs))
                    kwargs.clear();del kwargs
                    if not old_sid:del features,shape
                else:
                    golden={h:{k:v[v_sid] for k,v in arrays[h].items()}
                            for h in A.HORIZONS for v_sid in [arrays[h]['sid']==sid]} if old_sid else None
                    golden_meta={h:meta[h][sid] for h in A.HORIZONS} if old_sid else None
                    checks.append(component.check_series(science,A6,M2,D,ser,specs[key],receipts[sid],sid=sid,key=key,
                        original_archives=golden,original_metadata=golden_meta,status=READY))
                    if old_sid:del golden,golden_meta
                print(json.dumps(dict(completed_sid=sid,mode=mode)),file=sys.stderr,flush=True)
            finally:
                del ser;R12._CHAIN.clear()
        if mode=='produce':
            result=component.finalize(q['canonical_mapping'],q['selected24'],receipts,ROOT,status=READY)
            need(len([p for p in ROOT.rglob('*') if p.is_file()])==1940,'exact final1940 files')
            proof=dict(schema='q26-full277-preparation-produced-v1',complete=True,scope=SCOPE,
                request=request,manifest=result,series=277,original24_reused_exact=True,
                empirical_baseline_preparation=True,C_candidate_evaluated=False,forecast_promotion_status='NOT_ADMITTED')
        else:
            proof=component.check_manifest(manifest_pin,q['canonical_mapping'],q['selected24'],checks,status=READY)
            proof.update(request_sha256=request['sha256'],manifest_sha256=manifest_sha,scope=SCOPE)
    closure(q['files']);need(pin(request['path'])==request,'final input/request bytes unchanged')
    return proof


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=('produce','check'),required=True)
    parser.add_argument('--request',required=True);parser.add_argument('--request-sha256',required=True)
    parser.add_argument('--manifest');parser.add_argument('--manifest-sha256')
    a=parser.parse_args();print(json.dumps(execute(a.request,a.request_sha256,mode=a.mode,
        manifest_path=a.manifest,manifest_sha=a.manifest_sha256),allow_nan=False,separators=(',',':')))
