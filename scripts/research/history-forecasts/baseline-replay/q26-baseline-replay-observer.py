"""Baseline-only replay admission; authenticated existing observers own supervision."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

ADAPTER_SHA = 'e7f180f8bb5d9c2fe1ed9da29b5533b8ce112962d40e311c77a191509815a6ba'
SCHEMA = 'q26-baseline-replay-observer-request-v1'
PLAN_SCHEMA = 'q26-r164-baseline-replay-plan-v1'
CONSTANTS = dict(paths=1000, origin_every=28, horizons=[24, 72, 168, 720],
                 expected_series=42, expected_quarters=806, expected_origins=2619, expected_rows=104310)
POLICY = dict(wall_seconds=1200, rss_bytes=768 * 1024**2,
              output_bytes=64 * 1024**2, disk_reserve_bytes=2 * 1024**3 + 256 * 1024**2)
SOURCES = ('r164_baseline_replay.py', 'r164_baseline_replay_check.py', 'r164_pool_moment_review.py',
           'r164_step_real_review.py', 'r164_step_review.py', 'r164_recursive.py',
           'a_touch.py', 'a2_touch.py', 'a3_touch.py', 'a4_touch.py', 'a5_touch.py', 'a6_touch.py')


def _load_adapter():
    path = Path(__file__).resolve().parent.parent / 'state-reconstitution/q26-state-reconstitution-observer.py'
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ADAPTER_SHA:
        raise ValueError('qualified state observer source drift')
    spec = importlib.util.spec_from_file_location('q26_replay_state_observer', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), vars(module))
    return module


A = _load_adapter()
O = A.O
pin = O.pin


def validate_plan(plan, sources, runner):
    O.need(type(plan) is dict and set(plan) == {'schema', 'authorities', 'files', 'source_commit',
                                               'runtime', 'constants', 'output_dir'}, 'exact plan schema')
    O.need(plan['schema'] == PLAN_SCHEMA and plan['constants'] == CONSTANTS, 'fixed replay scope')
    O.need(type(plan['constants']) is dict and
           all(type(plan['constants'][k]) is int for k in CONSTANTS if k != 'horizons') and
           type(plan['constants']['horizons']) is list and
           all(type(h) is int for h in plan['constants']['horizons']), 'constant types')
    O.need(type(plan['source_commit']) is str and len(plan['source_commit']) == 40 and
           all(c in '0123456789abcdef' for c in plan['source_commit']), 'source commit identity')
    O.need(type(plan['runtime']) is dict and type(plan['output_dir']) is str and
           Path(plan['output_dir']).is_absolute(), 'runtime and output declaration')
    files = plan['files']
    O.need(type(files) is list and files, 'list file closure')
    pins = {}
    for q in files:
        O.check(q)
        O.need(q['path'] not in pins, 'unique plan path')
        pins[q['path']] = q
        if Path(q['path']).suffix in ('.py', '.md'):
            O.need(q in sources, 'plan source in request closure')
    for name in SOURCES:
        target = str(Path(runner['path']).parent / name)
        O.need(target in pins and pins[target] in sources, 'executing source closure')
    for q in sources:
        O.need(pins.get(q['path']) == q, 'request source in plan closure')
    authorities = plan['authorities']
    O.need(type(authorities) is dict and set(authorities) == {
        'state_plan', 'state_manifest', 'state_acceptance', 'original_config'}, 'authority roles')
    for q in authorities.values():
        O.check(q)
        O.need(pins.get(q['path']) == q, 'authority in plan closure')
    state = O.read(authorities['state_plan'])
    manifest = O.read(authorities['state_manifest'])
    acceptance = O.read(authorities['state_acceptance'])
    config = O.read(authorities['original_config'])['config']
    O.need(state['pin'] == 'f9389b68ee1a4a94417a9311bc42dc974b4613fd' and
           state['horizons'] == CONSTANTS['horizons'] and state['runtime'] == plan['runtime'], 'accepted state identity')
    for path, sha in state['files'].items():
        O.need(path in pins and pins[path]['sha256'] == sha, 'accepted state closure')
    O.need(manifest['complete'] is True and manifest['plan'] == state and
           manifest['plan_sha256'] == authorities['state_plan']['sha256'] and
           (manifest['n_quarters'], manifest['n_origins']) == (806, 2619), 'accepted manifest binding')
    O.need(acceptance['complete'] is True and
           acceptance['plan_sha256'] == authorities['state_plan']['sha256'] and
           acceptance['manifest_sha256'] == authorities['state_manifest']['sha256'] and
           tuple(acceptance[k] for k in ('series', 'quarters', 'origins', 'historical_rows')) ==
           (42, 806, 2619, 104310), 'independent acceptance binding')
    root = Path(authorities['state_manifest']['path']).parent
    outputs = manifest['output_sha256']
    O.need(type(outputs) is dict and len(outputs) == 42, 'state outputs support')
    for name, sha in outputs.items():
        O.need(Path(name).name == name and name.startswith('blind5-') and name.endswith('.json'), 'state output name')
        target = str(root / name)
        O.need(target in pins and pins[target]['sha256'] == sha, 'state output closure')
    O.need(type(config['paths']) is int and config['paths'] == 1000 and
           type(config['origin_every']) is int and config['origin_every'] == 28 and
           config['pin'] == 'f9389b6' and config['collection'] == 'blind5-prices', 'original configuration')
    return pins


def preflight(path, sha, receipt):
    rp = pin(path)
    O.need(rp['sha256'] == sha, 'trusted observer request SHA')
    r = O.read(rp)
    required = {'schema', 'kind', 'fixture_only', 'policy', 'invocation_python', 'resolved_python',
                'python_pin', 'source_pins', 'plan', 'runner', 'argv', 'output'}
    O.need(type(r) is dict and r.get('kind') in ('producer', 'saved_check'), 'observer purpose')
    if r['kind'] == 'saved_check':
        required.update(('producer_root', 'producer_manifest', 'producer_terminal'))
    O.need(set(r) == required and r['schema'] == SCHEMA, 'strict request schema')
    O.need(type(r['fixture_only']) is bool, 'explicit fixture status')
    expected = dict(POLICY, wall_seconds=1200 if r['kind'] == 'producer' else 180)
    policy = r['policy']
    O.need(type(policy) is dict and set(policy) == set(expected), 'exact policy fields')
    O.need(all(type(policy[k]) is int and policy[k] == expected[k]
               for k in expected if k != 'wall_seconds'), 'fixed resource policy')
    if r['fixture_only']:
        O.need(type(policy['wall_seconds']) in (int, float) and 0 < policy['wall_seconds'] <= 2, 'tiny synthetic wall')
    else:
        O.need(type(policy['wall_seconds']) is int and policy == expected, 'fixed prospective wall')
    for name in ('python_pin', 'plan', 'runner'):
        O.check(r[name])
    O.need(type(r['invocation_python']) is str and Path(r['invocation_python']).is_absolute(), 'invocation Python')
    O.need(type(r['resolved_python']) is str and str(Path(r['invocation_python']).resolve()) ==
           r['resolved_python'] == r['python_pin']['path'], 'resolved pinned Python')
    sources = r['source_pins']
    O.need(type(sources) is list and sources, 'source closure')
    for q in sources:
        O.check(q)
    O.need(len({q['path'] for q in sources}) == len(sources), 'unique source paths')
    for q in (r['runner'], pin(__file__), pin(A.__file__), pin(A.S.__file__), pin(O.__file__)):
        O.need(q in sources, 'required observer source closure')
    plan = O.read(r['plan'])
    pins = validate_plan(plan, sources, r['runner'])
    argv = [r['invocation_python'], '-B', r['runner']['path']]
    if r['kind'] == 'producer':
        O.need(Path(r['runner']['path']).name == 'r164_baseline_replay.py', 'fixed baseline producer')
        O.need(r['output'] == plan['output_dir'], 'declared producer output')
        argv += ['--plan', r['plan']['path'], '--plan-sha256', r['plan']['sha256'], '--output-dir', r['output']]
    else:
        root = O.canonical(r['producer_root'])
        O.need(root.is_dir() and str(root) == plan['output_dir'], 'existing declared producer root')
        O.check(r['producer_manifest'])
        O.need(r['producer_manifest']['path'] == str(root / 'manifest.json'), 'producer manifest binding')
        producer = O.read(r['producer_manifest'])
        O.need(producer['complete'] is True and producer['plan_sha256'] == r['plan']['sha256'] and
               producer['schema'] == 'q26-r164-baseline-replay-manifest-v1' and
               tuple(producer[k] for k in ('series', 'quarters', 'origins', 'historical_rows')) ==
               (42, 806, 2619, 104310), 'accepted producer manifest support')
        O.check(r['producer_terminal'])
        terminal = O.read(r['producer_terminal'])
        O.need(terminal['complete'] is True and type(terminal['tool_terminal_exit']) is int and
               terminal['tool_terminal_exit'] == 0 and terminal['errors'] == [] and
               terminal['process_terminal'] is True and terminal['observer_timeout'] is False and
               terminal['reason'] is None and terminal['containment']['reaped'] is True and
               terminal['containment']['no_live_members_remaining'] is True and
               terminal['containment']['remaining_live_members'] == [], 'successful stopped producer required')
        previous = O.read(terminal['request'])
        previous_fields = required - {'producer_root', 'producer_manifest', 'producer_terminal'}
        O.need(type(previous) is dict and set(previous) == previous_fields and
               previous['schema'] == SCHEMA and previous['kind'] == 'producer' and
               type(previous['fixture_only']) is bool and previous['fixture_only'] == r['fixture_only'], 'producer request identity')
        for field in ('plan', 'invocation_python', 'resolved_python', 'python_pin', 'source_pins'):
            O.need(previous[field] == r[field], 'producer request binding')
        expected_runner = pins[str(Path(r['runner']['path']).parent / 'r164_baseline_replay.py')]
        O.need(previous['runner'] == expected_runner == terminal['runner'] and
               previous['output'] == str(root), 'producer output and runner binding')
        previous_policy = previous['policy']
        O.need(type(previous_policy) is dict and set(previous_policy) == set(POLICY) and
               all(type(previous_policy[k]) is int and previous_policy[k] == POLICY[k]
                   for k in POLICY if k != 'wall_seconds'), 'producer resource policy')
        if previous['fixture_only']:
            O.need(type(previous_policy['wall_seconds']) in (int, float) and
                   0 < previous_policy['wall_seconds'] <= 2, 'producer tiny fixture wall')
        else:
            O.need(type(previous_policy['wall_seconds']) is int and previous_policy == POLICY, 'producer fixed wall')
        O.need(previous['argv'] == [r['invocation_python'], '-B', expected_runner['path'],
               '--plan', r['plan']['path'], '--plan-sha256', r['plan']['sha256'],
               '--output-dir', str(root)], 'producer sealed argv')
        O.need(Path(r['runner']['path']).name == 'r164_baseline_replay_check.py', 'fixed saved checker')
        argv += ['--plan', r['plan']['path'], '--output-dir', str(root), '--plan-sha256', r['plan']['sha256'],
                 '--manifest-sha256', r['producer_manifest']['sha256'], '--out', r['output']]
    O.need(type(r['argv']) is list and r['argv'] == argv and all(type(v) is str for v in r['argv']), 'exact sealed argv')
    output, dest = O.canonical(r['output']), O.canonical(receipt)
    O.need(output.parent == dest.parent and output.parent.is_dir(), 'one existing evidence parent')
    paths = dict(receipt=dest, start=Path(str(dest) + '.start.json'),
                 stdout=Path(str(dest) + '.stdout.log'), stderr=Path(str(dest) + '.stderr.log'))
    all_paths = [output, *paths.values(), Path(str(dest) + '.sampling.json'), Path(str(dest) + '.post-containment.json')]
    if r['kind'] == 'saved_check':
        O.need(all(not p.is_relative_to(root) for p in all_paths), 'producer root remains read-only')
    O.need(len(set(all_paths)) == 7 and all(not p.exists() and not p.is_symlink() for p in all_paths), 'fresh exclusive evidence')
    O.need(O.shutil.disk_usage(output.parent).free >= policy['disk_reserve_bytes'], 'disk reserve before start')
    return rp, r, output, paths


def observe(path, sha, receipt, *, factory=subprocess.Popen, sample=None, kill=O.os.killpg):
    original = A.preflight
    A.preflight = preflight
    try:
        return A.observe(path, sha, receipt, factory=factory, sample=sample, kill=kill)
    finally:
        A.preflight = original


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    try:
        result = observe(args.request, args.sha256, args.receipt)
        print(json.dumps({k: result[k] for k in ('complete', 'reason', 'elapsed_seconds', 'charged_seconds')}))
        raise SystemExit(0 if result['complete'] else 1)
    except Exception as error:
        print(json.dumps(dict(complete=False, error_type=type(error).__name__)))
        raise SystemExit(1)
