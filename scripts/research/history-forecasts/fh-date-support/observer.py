"""Finite admission for a reconstructed fH date audit; reuse qualified containment."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
Q_PATH = HERE.parent / 'state-reconstitution/q26-state-reconstitution-observer.py'
Q_SHA = 'e7f180f8bb5d9c2fe1ed9da29b5533b8ce112962d40e311c77a191509815a6ba'
if hashlib.sha256(Q_PATH.read_bytes()).hexdigest() != Q_SHA:
    raise ValueError('qualified containment wrapper changed')
spec = importlib.util.spec_from_file_location('fh_date_qualified_observer', Q_PATH)
Q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(Q)
O = Q.O
SCHEMA = 'q26-fh-date-support-observer-request-v1'
POLICY = dict(rss_bytes=768 * 1024**2, output_bytes=64 * 1024**2,
              disk_reserve_bytes=2 * 1024**3 + 256 * 1024**2)


def preflight(path, sha, receipt):
    rp = O.pin(path)
    O.need(rp['sha256'] == sha, 'external observer request hash')
    r = O.read(rp)
    keys = {'schema', 'kind', 'fixture_only', 'policy', 'invocation_python',
            'resolved_python', 'python_pin', 'source_pins', 'plan', 'runner', 'argv', 'output'}
    if r.get('kind') == 'saved_check':
        keys.update(('producer_root', 'producer_result', 'producer_terminal'))
    O.need(set(r) == keys and r['schema'] == SCHEMA, 'strict observer request')
    O.need(r['kind'] in ('producer', 'saved_check') and type(r['fixture_only']) is bool, 'purpose and fixture flag')
    wall = 60 if r['kind'] == 'producer' else 30
    policy = r['policy']
    O.need(type(policy) is dict and set(policy) == set(POLICY) | {'wall_seconds'}, 'resource policy fields')
    O.need(all(type(policy[k]) is int and policy[k] == v for k, v in POLICY.items()), 'fixed resource limits')
    if r['fixture_only']:
        O.need(type(policy['wall_seconds']) in (int, float) and 0 < policy['wall_seconds'] <= 2, 'tiny fixture wall')
    else:
        O.need(type(policy['wall_seconds']) is int and policy['wall_seconds'] == wall, 'fixed prospective wall')
    for name in ('python_pin', 'plan', 'runner'):
        O.check(r[name])
    O.need(str(Path(r['invocation_python']).resolve()) == r['resolved_python'] == r['python_pin']['path'], 'sealed interpreter')
    O.need(type(r['source_pins']) is list and r['source_pins'], 'source closure')
    sources = {}
    for pin in r['source_pins']:
        O.check(pin)
        O.need(pin['path'] not in sources, 'unique source path')
        sources[pin['path']] = pin
    for source in (Path(__file__).resolve(), Q_PATH, Path(Q.S.__file__), Path(O.__file__)):
        O.need(sources.get(str(source.resolve())) == O.pin(source.resolve()), 'executing observer source in closure')
    O.need(sources.get(r['runner']['path']) == r['runner'], 'runner source in closure')
    plan = O.read(r['plan'])
    O.need(plan.get('schema') == 'q26-fh-date-support-plan-v1' and plan.get('parent_admitted') is True,
           'admitted reconstruction plan')
    O.need(plan.get('mode') == 'NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT', 'fixed reconstruction purpose')
    pins = {}
    for pin in plan['files']:
        O.check(pin)
        O.need(pin['path'] not in pins, 'unique plan file')
        pins[pin['path']] = pin
    O.need(all(pins.get(p['path']) == p for p in sources.values()), 'observer and runner source plan closure')
    for pin in plan['files']:
        if Path(pin['path']).suffix in ('.py', '.md'):
            O.need(sources.get(pin['path']) == pin, 'all declared source files sealed')
    runner_role = 'audit' if r['kind'] == 'producer' else 'checker'
    O.need(plan['roles'][runner_role] == r['runner'], 'executing runner role')
    expected = [r['invocation_python'], '-B', r['runner']['path'], '--plan', r['plan']['path'], '--plan-sha256', r['plan']['sha256']]
    if r['kind'] == 'producer':
        O.need(r['output'] == plan['out'], 'producer output binding')
    else:
        for name in ('producer_result', 'producer_terminal'):
            O.check(r[name])
        terminal = O.read(r['producer_terminal'])
        O.need(terminal.get('schema') == 'q26-weighted-causal-primary-pair-observer-terminal-v1' and
               terminal.get('complete') is True and type(terminal.get('tool_terminal_exit')) is int and
               terminal['tool_terminal_exit'] == 0 and terminal.get('process_terminal') is True and
               terminal.get('observer_timeout') is False and terminal.get('reason') is None and terminal.get('errors') == [] and
               terminal.get('fixture_only') is r['fixture_only'] and
               terminal.get('runner') == plan['roles']['audit'] and
               terminal.get('containment', {}).get('reaped') is True and
               terminal['containment'].get('no_live_members_remaining') is True, 'producer complete and contained')
        original_request = O.read(terminal['request'])
        O.need(set(original_request) == keys - {'producer_root', 'producer_result', 'producer_terminal'} and
               original_request['schema'] == SCHEMA and original_request['fixture_only'] is r['fixture_only'] and
               original_request['plan'] == r['plan'] and original_request['kind'] == 'producer' and
               original_request['output'] == r['producer_root'] == plan['out'], 'same producer plan and root')
        for field in ('invocation_python', 'resolved_python', 'python_pin', 'source_pins'):
            O.need(original_request[field] == r[field], 'completed producer frozen ' + field)
        O.need(original_request['runner'] == plan['roles']['audit'] and
               sources.get(original_request['runner']['path']) == original_request['runner'], 'completed producer audit runner')
        producer_argv = [r['invocation_python'], '-B', original_request['runner']['path'],
                         '--plan', r['plan']['path'], '--plan-sha256', r['plan']['sha256']]
        O.need(original_request['argv'] == producer_argv, 'completed producer exact command')
        prior_policy = original_request['policy']
        O.need(type(prior_policy) is dict and set(prior_policy) == set(POLICY) | {'wall_seconds'} and
               all(type(prior_policy[k]) is int and prior_policy[k] == v for k, v in POLICY.items()), 'completed producer resource limits')
        if r['fixture_only']:
            O.need(type(prior_policy['wall_seconds']) in (int, float) and 0 < prior_policy['wall_seconds'] <= 2, 'completed fixture wall')
        else:
            O.need(type(prior_policy['wall_seconds']) is int and prior_policy['wall_seconds'] == 60, 'completed producer wall')
        O.need(r['producer_result']['path'] == str(Path(plan['out']) / 'result.json'), 'saved producer result path')
        result = O.read(r['producer_result'])
        O.need(result.get('complete') is True and result.get('plan_sha256') == r['plan']['sha256'], 'saved result plan binding')
        expected += ['--result', r['producer_result']['path'], '--receipt', r['output']]
    O.need(r['argv'] == expected, 'exact command binding')
    output, dest = O.canonical(r['output']), O.canonical(receipt)
    O.need(output.parent == dest.parent and dest.parent.is_dir(), 'existing common evidence parent')
    O.need(r['kind'] == 'producer' or not output.is_relative_to(Path(r['producer_root'])), 'checker output outside producer root')
    paths = dict(receipt=dest, start=Path(str(dest)+'.start.json'), stdout=Path(str(dest)+'.stdout.log'), stderr=Path(str(dest)+'.stderr.log'))
    all_paths = [output, *paths.values(), Path(str(dest)+'.sampling.json'), Path(str(dest)+'.post-containment.json')]
    O.need(len(set(all_paths)) == 7 and all(not p.exists() and not p.is_symlink() for p in all_paths), 'seven exclusive output paths')
    O.need(O.shutil.disk_usage(output.parent).free >= policy['disk_reserve_bytes'], 'disk reserve')
    return rp, r, output, paths


def observe(path, sha, receipt, *, factory=subprocess.Popen, sample=None, kill=O.os.killpg):
    original = Q.preflight
    Q.preflight = preflight
    try:
        return Q.observe(path, sha, receipt, factory=factory, sample=sample, kill=kill)
    finally:
        Q.preflight = original


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--request', required=True)
    p.add_argument('--sha256', required=True)
    p.add_argument('--receipt', required=True)
    a = p.parse_args()
    result = observe(a.request, a.sha256, a.receipt)
    print(json.dumps({k: result[k] for k in ('complete', 'reason', 'elapsed_seconds', 'charged_seconds')}))
    raise SystemExit(0 if result['complete'] else 1)
