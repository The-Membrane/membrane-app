"""CODEX CONTINUATION: observe unchanged original shallow NN; allocation is separate."""
from __future__ import annotations
import argparse
from pathlib import Path
import os
import sys
import r16_shallow_nn_protocol as P
import r16_shallow_nn_observer as O


def child(scope_path,digest,out):
    scope=P.preflight(scope_path,digest);out=Path(out).resolve()
    if str(out)!=scope['out']:raise ValueError('frozen output differs')
    links=P.R.A.read_unique_json(out/'links.json')
    if set(links)!=set(P.INPUTS):raise ValueError('hardlink proof incomplete')
    for name,pin in scope['evidence']['inputs'].items():
        a,b=Path(pin['path']).stat(),(out/name).stat()
        if (out/name).is_symlink() or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino) or P.R.A.sha(out/name)!=pin['sha256']:
            raise ValueError('immutable hardlink staging changed')
    from r16_shallow_nn_monitor import cache_environment
    if any(os.environ.get(k)!=v for k,v in cache_environment(out).items()):raise ValueError('isolated working-cache environment required')
    def persist(name,value):
        if name=='allocation.json':value=dict(value,scope_sha256=digest)
        P.R.atomic_json(out/name,value)
    hook,state,reads,ledger=P.audit(scope,out,persist);sys.addaudithook(hook)
    observer=O.Observer(P.R.A.NN.run_tier,persist,allocation=scope['phase']=='allocation',
        observe_resources=lambda:dict(P.M.rss_observation(),disk=P.disk(out,scope['archive_bounds'])))
    started=P.R.utc();result=None
    try:
        args=argparse.Namespace(datasets=scope['evidence']['datasets'],out=str(out),threads=1,tiers='shallow',models=','.join(O.MODELS))
        observer.install()
        try:P.R.A.NN.cmd_fit(args)
        except O.AllocationComplete:
            if scope['phase']!='allocation' or observer.starts!=1 or observer.completed:raise
            result=dict(allocation_only=True,neural_fits=0)
        finally:observer.uninstall()
        if scope['phase']=='allocation':
            if result is None:raise ValueError('allocation stop did not occur before first make_model')
        else:
            fits=observer.require_complete();meta=P.R.A.read_unique_json(out/'nn-meta.json')
            if meta['info']['shallow']['fits']!=fits:raise ValueError('original metadata and20 receipts differ')
            result=dict(neural_fits=20,coverage=O.coverage(out),output_pins=[P.R.pin(out/name) for name in scope['archive_bounds']],nn_meta=P.R.pin(out/'nn-meta.json'));persist('coverage.json',result['coverage'])
        if ledger['total']:raise PermissionError('persisted denial ledger is not clean')
        for name,pin in scope['evidence']['inputs'].items():
            if P.R.A.sha(out/name)!=pin['sha256']:raise ValueError('immutable input changed')
        persist('audit.json',dict(violations=ledger,opened_raw_inputs=reads))
        value=dict(complete=True,phase=scope['phase'],started_at=started,ended_at=P.R.utc(),scope_sha256=digest,
            audit_violations=ledger,opened_raw_inputs=reads,**result)
        persist('child.json',value);return value
    except BaseException as error:
        observer.uninstall()
        try:persist('child.json',dict(complete=False,phase=scope['phase'],scope_sha256=digest,started_at=started,ended_at=P.R.utc(),
            completed_fits=len(observer.completed),audit_violations=ledger,error_type=type(error).__name__,error=str(error)[:1000]))
        except BaseException:pass
        raise
    finally:state['active']=False


def score_child(scope_path,digest,out):
    scope=P.preflight(scope_path,digest);out=Path(out).resolve()
    if scope['phase']!='fit' or str(out)!=scope['out']:raise ValueError('complete fit scope required')
    monitor=P.R.A.read_unique_json(out/'monitor.json');receipt=P.R.A.read_unique_json(out/'child.json')
    if monitor.get('scope_sha256')!=digest or monitor.get('phase')!='fit' or receipt.get('phase')!='fit' or not monitor['complete'] or not receipt['complete'] or receipt.get('neural_fits')!=20 or receipt['scope_sha256']!=digest:
        raise ValueError('all20 terminal fits required')
    if receipt['audit_violations']['total']:raise ValueError('fit denied operation')
    if monitor.get('child_receipt')!=P.R.pin(out/'child.json'):raise ValueError('terminal fit child receipt changed')
    for pin in receipt['output_pins']+[receipt['nn_meta']]:P.R.check_pin(pin)
    if O.coverage(out)!=receipt['coverage']:raise ValueError('fit predictions changed before scoring')
    if (out/'dev-r162-nn.json').exists() or (out/'score.json').exists():raise FileExistsError('score already exists; no overwrite')
    def persist(name,value):P.R.atomic_json(out/name,value)
    score_scope=dict(scope,evidence=dict(scope['evidence'],inputs=dict(scope['evidence']['inputs'],**{Path(p['path']).name:p for p in receipt['output_pins']})))
    hook,state,reads,ledger=P.audit(score_scope,out,persist);sys.addaudithook(hook)
    try:
        P.R.A.D.cmd_score_nn(argparse.Namespace(out=str(out)))
        if ledger['total']:raise PermissionError('score denied operation')
        persist('score.json',dict(complete=True,phase='score',scope_sha256=digest,output=P.R.pin(out/'dev-r162-nn.json'),audit_violations=ledger,coverage=O.coverage(out)))
    finally:state['active']=False



def selftest(probe_path,out):
    import unittest
    out=Path(out)
    if out.exists():raise FileExistsError('selftest receipt exists')
    probe=P.R.A.read_unique_json(probe_path)
    suite=unittest.defaultTestLoader.loadTestsFromName('test_r16_shallow_nn_observer')
    def ids(node):
        if isinstance(node,unittest.TestSuite):return [item for child in node for item in ids(child)]
        return [node.id()]
    ordered=ids(suite);result=unittest.TextTestRunner(verbosity=2).run(suite)
    try:current=P.runtime()
    except ImportError:current=None
    valid_probe=probe.get('complete') is True and current is not None and probe.get('executable')==sys.executable and probe.get('torch_version')==current['torch_version']
    value=dict(complete=bool(result.wasSuccessful() and result.testsRun==9 and not result.skipped and valid_probe),
        tests_run=result.testsRun,ordered_test_ids=ordered,skipped=len(result.skipped),errors=len(result.errors),failures=len(result.failures),
        runtime=current,probe_sha256=P.R.A.sha(probe_path),source_sha256=P.observer_sources(),historical_inputs=False,finished_at=P.R.utc())
    out.parent.mkdir(parents=True,exist_ok=True)
    with open(out,'x') as f:__import__('json').dump(value,f,indent=2,allow_nan=False)
    if not value['complete']:raise RuntimeError('selftest failed/skipped or runtime probe mismatch; receipt is not accepted')
    return value


def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='command',required=True)
    t=sub.add_parser('selftest');t.add_argument('--probe',required=True);t.add_argument('--out',required=True)
    f=sub.add_parser('freeze');f.add_argument('--request',required=True);f.add_argument('--out',required=True)
    for name in ('allocation','fit','_child','score','_score_child'):
        p=sub.add_parser(name);p.add_argument('--scope',required=True);p.add_argument('--scope-sha256',required=True);p.add_argument('--out',required=True)
    a=parser.parse_args()
    if a.command=='selftest':value=selftest(a.probe,a.out)
    elif a.command=='freeze':value=P.freeze(a.request,a.out)
    elif a.command=='_child':value=child(a.scope,a.scope_sha256,a.out)
    elif a.command=='_score_child':value=score_child(a.scope,a.scope_sha256,a.out)
    elif a.command=='score':
        import r16_shallow_nn_monitor as monitor
        value=monitor.run(a.scope,a.scope_sha256,a.out,score=True)
    else:
        scope=P.preflight(a.scope,a.scope_sha256)
        expected='allocation' if a.command=='allocation' else 'fit'
        if scope['phase']!=expected:raise ValueError('command/phase mismatch')
        import r16_shallow_nn_monitor as monitor
        value=monitor.run(a.scope,a.scope_sha256,a.out)
    if value is not None:print(__import__('json').dumps(value))


if __name__=='__main__':main()
