"""Fixed original24 admission only; unchanged Q -> S -> O owns observation.

Metadata/streaming hashes only. No science imports, numerical decoding or new
process supervisor. DRAFT requests fail before creating any observer artifact.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import time
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
Q_PATH = HERE.parent / 'state-reconstitution/q26-state-reconstitution-observer.py'
Q_SHA = 'e7f180f8bb5d9c2fe1ed9da29b5533b8ce112962d40e311c77a191509815a6ba'
_raw = Q_PATH.read_bytes()
if hashlib.sha256(_raw).hexdigest() != Q_SHA:
    raise ValueError('qualified Q observer changed')
_spec = importlib.util.spec_from_file_location('original24_qualified_Q', Q_PATH)
Q = importlib.util.module_from_spec(_spec)
exec(compile(_raw, str(Q_PATH), 'exec'), vars(Q))
O = Q.O
OUTER_CAP = 2*1024**2
SCHEMA = 'q26-original24-control-observer-request-v1'
SCOPE = 'ORIGINAL24_SAVED_REPLAY_CONTROL'
POLICY = dict(rss_bytes=1342177280, output_bytes=33554432,
              disk_reserve_bytes=2415919104)
PHASE_KEYS = {'schema','status','scope','total_seconds','producer_seconds',
              'checker_seconds','cleanup_seconds','started_unix','deadline_unix'}
KEYS = {'schema','kind','fixture_only','policy','invocation_python','resolved_python',
        'python_pin','source_pins','runtime_pins','phase','inner_request','runner',
        'argv','output'}
PRODUCER_ROOT = HERE.parents[4] / 'history-forecasts-original24-control-2026-10-22-v1'


def canonical(path):
    p = O.canonical(path)
    O.need(not any(v.is_symlink() for v in p.parents), 'nonsymlink ancestors')
    return p


def checked(pin):
    O.need(type(pin) is dict and set(pin) == {'path','size','sha256'} and
           type(pin['size']) is int and pin['size'] >= 0, 'strict pin')
    canonical(pin['path']); O.check(pin)


def read(pin, cap=16*1024**2):
    checked(pin); O.need(pin['size'] <= cap, 'bounded JSON metadata')
    def pairs(items):
        out = {}
        for key, value in items:
            O.need(key not in out, 'duplicate JSON key'); out[key] = value
        return out
    def bad(_):
        raise ValueError('nonfinite JSON')
    return json.loads(Path(pin['path']).read_bytes(), object_pairs_hook=pairs,
                      parse_constant=bad)


def closure(pins):
    O.need(type(pins) is list and pins, 'nonempty closure')
    result = {}
    for pin in pins:
        checked(pin)
        O.need(pin['path'] not in result, 'unique closure paths')
        result[pin['path']] = pin
    return result


def runtime_environment(inner):
    env = inner['runtime'].get('environment')
    allowed = {'OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS',
               'PYTHONDONTWRITEBYTECODE','PYTHONOPTIMIZE','DYLD_LIBRARY_PATH'}
    O.need(type(env) is dict and set(env) <= allowed and
           all(type(k) is str and type(v) is str for k,v in env.items()) and
           all(env.get(k) == '1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS',
                                         'MKL_NUM_THREADS','PYTHONDONTWRITEBYTECODE')) and
           env.get('PYTHONOPTIMIZE','0') == '0', 'sealed bounded runtime environment')
    if 'DYLD_LIBRARY_PATH' in env:
        O.need(canonical(env['DYLD_LIBRARY_PATH']).is_dir(), 'sealed native library directory')
    return env


def inner_admission(r, sources, runtime):
    inner = read(r['inner_request'])
    if r['fixture_only']:
        O.need(set(inner) == {'schema','status','scope','files','runtime','out'} and
               inner['schema'] == 'q26-original24-control-observer-fixture-v1' and
               inner['status'] == 'READY_SYNTHETIC_OBSERVER_FIXTURE' and
               inner['scope'] == 'FIXTURE_ONLY', 'explicit tiny fixture')
    else:
        O.need(set(inner) == {'schema','status','scope','pins','inputs','science','files','runtime','out'} and
               inner['schema'] == 'q26-fixed-mixture-original24-control-v1' and
               inner['status'] == 'READY_PARENT_REVIEWED_ORIGINAL24_CONTROL' and
               inner['scope'] == SCOPE, 'DRAFT or wrong original24 admission')
        expected = HERE / ('control.py' if r['kind'] == 'producer' else 'control_check.py')
        O.need(r['runner'] == O.pin(expected), 'fixed original24 runner')
    files = closure(inner['files'])
    for pin in inner['files']:
        if Path(pin['path']).suffix in ('.py','.md'):
            O.need(sources.get(pin['path']) == pin, 'scientific source closure')
    if not r['fixture_only']:
        for pin in [*inner['pins'].values(), *inner['inputs'].values(), *inner['science'].values()]:
            O.need(files.get(pin['path']) == pin, 'inner role in byte closure')
    runtime_environment(inner)
    rt = inner['runtime']
    O.need(type(rt) is dict and rt.get('executable') == r['python_pin'] and
           type(rt.get('native_pins')) is list, 'current runtime metadata')
    expected_runtime = [r['python_pin'], *rt['native_pins']]
    # A native closure may already include its executable; require unique union.
    wanted = {p['path']:p for p in expected_runtime}
    O.need(runtime == wanted, 'entire declared runtime/native closure')
    for pin in wanted.values():
        O.need(files.get(pin['path']) == pin, 'runtime in authenticated files')
    return inner, files


def phase_admission(r, completed=False):
    phase = read(r['phase'], 65536)
    extra = {'producer_terminal','producer_manifest'} if r['kind'] == 'saved_check' else set()
    O.need(set(phase) == PHASE_KEYS | extra and
           phase['schema'] == 'q26-original24-control-phase-v1' and
           phase['status'] == 'ADMITTED_PARENT_REVIEWED' and phase['scope'] == SCOPE,
           'DRAFT: fresh parent phase not admitted')
    expected = dict(total_seconds=600,producer_seconds=240,checker_seconds=300,cleanup_seconds=60)
    O.need(all(type(phase[k]) is int and phase[k] == v for k,v in expected.items()),
           'fresh fixed600 phase; no old allowance')
    O.need(all(type(phase[k]) in (int,float) and math.isfinite(phase[k]) for k in ('started_unix','deadline_unix')) and
           phase['deadline_unix'] == phase['started_unix'] + 600 and
           phase['started_unix'] <= time.time() and
           time.time() + (0 if completed else r['policy']['wall_seconds'] + 60) <= phase['deadline_unix'],
           'nonrenewable phase deadline reserves cleanup')
    if extra:
        O.need(phase['producer_terminal'] == r['producer_observer_terminal'] and
               phase['producer_manifest'] == r['producer_manifest'],
               'parent externally bound actual producer evidence')
    return phase


def producer_binding(r, inner):
    """Checker admission requires actual clean producer terminal and result bytes."""
    terminal = read(r['producer_observer_terminal'], 65536)
    O.need(terminal['schema'] == 'q26-weighted-causal-primary-pair-observer-terminal-v1' and
           terminal['complete'] is True and type(terminal['tool_terminal_exit']) is int and
           terminal['tool_terminal_exit'] == 0 and terminal['process_terminal'] is True and
           terminal['observer_timeout'] is False and terminal['reason'] is None and
           terminal['errors'] == [] and terminal['fixture_only'] is r['fixture_only'] and
           terminal['containment']['reaped'] is True and
           terminal['containment']['no_live_members_remaining'] is True and
           terminal['containment']['remaining_live_members'] == [], 'actual clean producer terminal')
    O.need(type(terminal['charged_seconds']) is int and 0 <= terminal['charged_seconds'] <= 240 and
           type(terminal['elapsed_seconds']) in (int,float) and
           0 <= terminal['elapsed_seconds'] <= terminal['charged_seconds'], 'actual producer phase charge')
    original = read(terminal['request'], OUTER_CAP)
    O.need(set(original) == KEYS and original['schema'] == SCHEMA and
           original['kind'] == 'producer' and original['fixture_only'] is r['fixture_only'] and
           original['inner_request'] == r['inner_request'] and
           original['output'] == inner['out'] and original['runner'] == terminal['runner'] and
           original['python_pin'] == r['python_pin'] and
           original['invocation_python'] == r['invocation_python'] and
           original['resolved_python'] == r['resolved_python'] and
           original['runtime_pins'] == r['runtime_pins'] and
           original['source_pins'] == r['source_pins'], 'producer admission lineage')
    source = O.pin(HERE/'control.py') if not r['fixture_only'] else original['runner']
    O.need(original['runner'] == source and source in r['source_pins'], 'producer runner identity')
    expected = [r['invocation_python'],'-B',source['path'],'--request',r['inner_request']['path'],
                '--request-sha256',r['inner_request']['sha256']]
    O.need(original['argv'] == expected, 'producer exact command')
    producer_phase = phase_admission(original, completed=True)
    checker_phase = read(r['phase'], 65536)
    O.need(all(producer_phase[k] == checker_phase[k] for k in PHASE_KEYS),
           'same nonrenewable producer/checker phase clock')
    O.need(terminal['charged_seconds'] == math.ceil(terminal['elapsed_seconds']), 'actual rounded producer charge')
    O.need(original['policy'] == dict(POLICY,wall_seconds=original['policy']['wall_seconds']) and
           ((original['fixture_only'] and type(original['policy']['wall_seconds']) in (int,float) and
             0 < original['policy']['wall_seconds'] <= 2) or
            (not original['fixture_only'] and type(original['policy']['wall_seconds']) is int and
             original['policy']['wall_seconds'] == 240)), 'completed producer fixed resource policy')
    checked(r['producer_manifest'])
    root = canonical(inner['out'])
    O.need(root.is_dir() and r['producer_manifest']['path'] == str(root/'control-result.json'),
           'terminal manifest exact root')
    manifest = read(r['producer_manifest'])
    O.need(manifest['schema'] == 'q26-original24-control-result-v1' and
           manifest['complete'] is True and manifest['scope'] == SCOPE and
           manifest['request_sha256'] == r['inner_request']['sha256'] and
           manifest['source'] == source and manifest['full277_scientific_coverage'] is False,
           'actual producer completed manifest')
    closure(manifest['outputs'])
    O.need(all(canonical(p['path']).is_relative_to(root) for p in manifest['outputs']),
           'manifest outputs beneath producer root')
    return root


def preflight(path, sha, receipt):
    rp = O.pin(canonical(path))
    O.need(rp['sha256'] == sha and rp['size'] <= OUTER_CAP, 'external bounded request SHA')
    r = read(rp, OUTER_CAP)
    extra = {'producer_observer_terminal','producer_manifest'} if r.get('kind') == 'saved_check' else set()
    O.need(set(r) == KEYS | extra and r['schema'] == SCHEMA and
           r['kind'] in ('producer','saved_check') and type(r['fixture_only']) is bool,
           'strict original24 observer purpose')
    policy = r['policy']
    O.need(set(policy) == set(POLICY)|{'wall_seconds'} and
           all(type(policy[k]) is int and policy[k] == v for k,v in POLICY.items()), 'fixed resources')
    wall = policy['wall_seconds']
    if r['fixture_only']:
        O.need(type(wall) in (int,float) and 0 < wall <= 2, 'tiny synthetic wall')
    else:
        O.need(type(wall) is int and wall == (240 if r['kind']=='producer' else 300), 'fixed phase wall')
    phase_admission(r)
    for key in ('python_pin','inner_request','runner'): checked(r[key])
    O.need(r['invocation_python'] == sys.executable and
           str(Path(r['invocation_python']).resolve()) == r['resolved_python'] == r['python_pin']['path'],
           'current invocation separately bound to resolved binary')
    sources = closure(r['source_pins']); runtime = closure(r['runtime_pins'])
    for p in (Path(__file__), Q_PATH, Path(Q.S.__file__), Path(O.__file__)):
        O.need(sources.get(str(p.resolve())) == O.pin(p.resolve()), 'unchanged self/Q/S/O closure')
    O.need(sources.get(r['runner']['path']) == r['runner'], 'runner source closure')
    inner, files = inner_admission(r, sources, runtime)
    expected = [r['invocation_python'],'-B',r['runner']['path'],'--request',r['inner_request']['path'],
                '--request-sha256',r['inner_request']['sha256']]
    roots = {canonical(p['path']).parent for p in inner['files']}
    if r['kind'] == 'producer':
        O.need(r['output'] == inner['out'], 'producer output bound by inner request')
        if not r['fixture_only']:
            O.need(canonical(r['output']) == PRODUCER_ROOT, 'fixed fresh original24 control root')
    else:
        roots.add(producer_binding(r, inner))
        expected += ['--result',r['producer_manifest']['path'],'--result-sha256',r['producer_manifest']['sha256']]
    O.need(r['argv'] == expected, 'literal sealed argv')
    output, dest = canonical(r['output']), canonical(receipt)
    O.need(output.parent == dest.parent and output.parent.is_dir(), 'existing shared evidence parent')
    if not r['fixture_only']:
        O.need(output.parent == PRODUCER_ROOT.parent, 'fixed research evidence parent')
    paths = dict(receipt=dest,start=Path(str(dest)+'.start.json'),
                 stdout=Path(str(dest)+'.stdout.log'),stderr=Path(str(dest)+'.stderr.log'))
    destinations = [output,*paths.values(),Path(str(dest)+'.sampling.json'),Path(str(dest)+'.post-containment.json')]
    O.need(len(set(destinations)) == 7 and all(not p.exists() and not p.is_symlink() for p in destinations),
           'seven fresh exclusive destinations')
    O.need(all(not p.is_relative_to(root) for p in destinations for root in roots),
           'all immutable input roots stay outside destinations')
    O.need(O.shutil.disk_usage(output.parent).free >= policy['disk_reserve_bytes'], 'prelaunch disk reserve')
    return rp, r, output, paths


def observe(path, sha, receipt, *, factory=subprocess.Popen, sample=None, kill=O.os.killpg):
    original = Q.preflight
    Q.preflight = preflight
    def launch(*args, **kwargs):
        # O intentionally removes DYLD from inherited ambient state. Restore only
        # the externally pinned inner request's narrowly allowed runtime values.
        rp = O.pin(canonical(path))
        O.need(rp['sha256'] == sha, 'launch external request SHA')
        r = read(rp, OUTER_CAP)
        inner = read(r['inner_request'])
        O.need(args and args[0] == r['argv'], 'launch exact admitted command')
        env = dict(kwargs['env'])
        env.update(runtime_environment(inner))
        kwargs['env'] = env
        return factory(*args, **kwargs)
    try:
        return Q.observe(path,sha,receipt,factory=launch,sample=sample,kill=kill)
    finally:
        Q.preflight = original


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('request','sha256','receipt'): parser.add_argument('--'+name,required=True)
    args = parser.parse_args()
    result = observe(args.request,args.sha256,args.receipt)
    print(json.dumps({k:result[k] for k in ('complete','reason','elapsed_seconds','charged_seconds')}))
    raise SystemExit(0 if result['complete'] else 1)
