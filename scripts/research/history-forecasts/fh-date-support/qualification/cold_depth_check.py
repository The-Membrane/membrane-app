"""Extend the committed 1000-hour None fixture with the independent checker.

Generated synthetic OHLC only. Parent must seal all external source digests and
run this cold process under a finite <=60-second outer job cap. This script adds
no supervisor. It qualifies original-source checker wiring for a genuine missing
predecessor only, not two eligible vintages, full accounting or historical data.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

F = Path('/Users/EBmic/research-workspaces/history-forecasts-continuation')
S = F / 'scripts/research/history-forecasts/fh-date-support'
FIXTURE = S / 'qualification/cold_depth_none.py'
CHECKER = S / 'depth_check.py'


def need(ok, why):
    if not ok:
        raise ValueError(why)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()


def source(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def same_arrays(actual, expected, label):
    need(set(actual) == set(expected), label+' field set')
    for key in expected:
        a, b = actual[key], expected[key]
        need(a.dtype == b.dtype and a.shape == b.shape and a.tobytes() == b.tobytes(),
             label+' exact dtype/shape/bits '+key)


def main():
    p = argparse.ArgumentParser()
    for key in ('out', 'self-sha256', 'fixture-sha256', 'checker-sha256', 'python-sha256',
                'depth-sha256', 'audit-sha256', 'fit-sha256', 'census-sha256', 'producer-sha256'):
        p.add_argument('--'+key, required=True)
    args = p.parse_args()
    own = Path(__file__).absolute()
    executable = Path(sys.executable).resolve()
    pins = {own: args.self_sha256, FIXTURE: args.fixture_sha256,
            CHECKER: args.checker_sha256, executable: args.python_sha256}
    for path, expected in pins.items():
        need(path.is_absolute() and path.resolve() == path and path.is_file() and
             not path.is_symlink() and digest(path) == expected, 'external qualification source/runtime digest')
    need(sys.dont_write_bytecode and not sys.flags.optimize and
         os.environ.get('PYTHONDONTWRITEBYTECODE') == '1' and
         os.environ.get('PYTHONOPTIMIZE') == '0' and
         all(os.environ.get(k) == '1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')),
         'cold one-thread/no-bytecode runtime')
    out = Path(args.out)
    need(out.is_absolute() and out.resolve() == out and not out.exists() and
         not any(x.is_symlink() for x in (out,*out.parents)), 'fresh canonical synthetic output')
    fixture = source(FIXTURE, 'checker_extension_original_committed_fixture')
    need(set(fixture.PATHS) == {'depth','audit','fit','census','producer'}, 'committed fixture source API')
    for key, path in fixture.PATHS.items():
        expected = getattr(args,key+'_sha256')
        need(path.resolve() == path and digest(path) == expected, 'all committed fixture source digests before execution')
        pins[path] = expected
    captures = {}
    original_mod = fixture.mod

    def observed_mod(path, name):
        value = original_mod(path, name)
        if name == 'cold_depth_old_audit':
            original = value.reconstruct
            def old_boundary(*a, **k):
                result = original(*a, **k)
                captures['accepted'] = {key: v.copy() for key,v in result.items()}
                return result
            value.reconstruct = old_boundary
        elif name == 'cold_depth_new_adapter':
            original = value.reconstruct
            def producer_boundary(plan, metadata, audit, accepted, output):
                result, status = original(plan,metadata,audit,accepted,output)
                captures.update(plan=plan,metadata=metadata,producer={key:v.copy() for key,v in result.items()},
                                producer_status=status,producer_called=True)
                return result,status
            value.reconstruct = producer_boundary
        return value

    # Execute the exact committed fixture rather than reproducing its OHLC or metadata recipe.
    # Wrappers observe outputs after the original functions return; they change no arithmetic.
    fixture.mod = observed_mod
    oldargv = list(sys.argv)
    argv = [str(FIXTURE),'--out',str(out)]
    for key in fixture.PATHS:
        argv += ['--'+key+'-sha256',getattr(args,key+'_sha256')]
    try:
        sys.argv = argv
        fixture.main()
    finally:
        sys.argv = oldargv
        fixture.mod = original_mod
    need(set(captures) == {'accepted','plan','metadata','producer','producer_status','producer_called'},
         'all original fixture paths actually observed')
    prior_result = json.loads((out/'result.json').read_bytes())
    need(prior_result['complete'] is True and prior_result['fixture_only'] is True and
         prior_result['two_eligible_vintages_qualified'] is False and
         prior_result['previous_reason'] == 'missing_predecessor_coefficient', 'faithful original None qualification')
    legacy = captures['plan']['legacy_sources']
    names = {Path(value['path']).stem for value in legacy.values()}
    removed = sorted(names & set(sys.modules))
    need(removed, 'new producer genuinely imported original scientific modules')
    for name in names:
        sys.modules.pop(name,None)
    need(not (names & set(sys.modules)), 'cold original-module cache reset before independent checker')
    checker = source(CHECKER, 'cold_independent_depth_checker')
    plan = dict(captures['plan'],out=str(out))
    stage,_,manifest,cut = captures['metadata']
    grid = out/'blind6-prices/binance-SYNTHETICUSDT-1h.json'
    # These fields are fixture-only loader metadata, not substitute historical authorities.
    raw = {'datasets':str(out),'price_inputs':[checker.pin(grid)]}
    metadata = stage,raw,manifest,cut
    try:
        arrays,status = checker.reconstruct(plan,metadata)
    finally:
        for name in names:
            sys.modules.pop(name,None)
    same_arrays({key:arrays[key] for key in checker.WITNESS},captures['accepted'],'original audit versus checker witness')
    same_arrays(arrays,captures['producer'],'new producer versus independent checker all fixed rows')
    need(json.dumps(status,sort_keys=True) == json.dumps(captures['producer_status'],sort_keys=True),
         'independent whole-vintage eligibility agreement')
    need(status['current']['available'] is True and status['previous']['available'] is False and
         status['previous']['reason'] == 'missing_predecessor_coefficient' and
         all(arrays['previous_'+key].size == 0 for key in ('sigma','z','valid')), 'genuine None predecessor, no fabricated basis')
    rejected = False
    try:
        checker.recount(arrays['current_z'],arrays['main_state'],arrays['main_label_end'],plan['pilot']['previous_cutoff'])
    except ValueError:
        rejected = True
    need(rejected,'recent-only fixture cannot qualify full accounting')
    for value in legacy.values():
        checker.check(value)
    for path,expected in pins.items():
        need(digest(path) == expected,'final qualification source/runtime unchanged')
    receipt = dict(schema='q26-depth-check-cold-qualification-v1',label='CODEX CONTINUATION',
        complete=True,fixture_only=True,private_arrays_decoded=0,
        reused_committed_fixture=dict(path=str(FIXTURE),sha256=args.fixture_sha256),
        old_fixture_result_sha256=digest(out/'result.json'),checker_source_sha256=args.checker_sha256,
        generated_raw_rows=prior_result['generated_raw_rows'],current_main_rows=len(arrays['main_index']),
        original_audit_all_five_witness_bits_match=True,
        producer_checker_all_fixed_cohort_sigma_z_valid_and_witness_bits_match=True,
        eligibility_statuses_match=True,original_module_cache_reset_before_checker=True,
        current_available=True,previous_reason='missing_predecessor_coefficient',
        checker_accounting_expected_refusal=True,two_eligible_vintages_qualified=False,
        full_accounting_qualified=False,full_new_request_authentication_qualified=False,
        historical_execution_admitted=False,no_fits=True,no_predictions=True,no_scores=True,
        array_sha256={key:hashlib.sha256(value.tobytes()).hexdigest() for key,value in arrays.items()})
    payload=(json.dumps(receipt,sort_keys=True,allow_nan=False)+'\n').encode()
    fd=os.open(out/'checker-qualification.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(payload);stream.flush();os.fsync(stream.fileno())
    print(json.dumps(dict(complete=True,fixture_only=True,result_sha256=digest(out/'checker-qualification.json'))))


if __name__=='__main__':
    main()
