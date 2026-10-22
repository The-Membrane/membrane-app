"""O33 admission only; authenticated O142/O140 observers retain containment."""
import argparse
import hashlib
import importlib.util
import json
import math
import subprocess
import time
from pathlib import Path

SAMPLING_SHA = 'f2d80105b8e807cd6c1bec5f8c1a815a3f5eecbba9308bac8b8274af6a70b4c9'
SAMPLING_NAME = 'q26-step-error-accounting-observer.py'
SCHEMA = 'q26-state-reconstitution-observer-request-v1'
POLICY = dict(wall_seconds=240, rss_bytes=768 * 1024**2,
              output_bytes=64 * 1024**2, disk_reserve_bytes=(2 * 1024**3 + 256 * 1024**2))


def _load_sampling():
    here = Path(__file__).resolve().parent
    for path in (here / SAMPLING_NAME, here.parent / 'step-error-accounting' / SAMPLING_NAME):
        if path.is_file():
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != SAMPLING_SHA:
                raise ValueError('qualified sampling adapter source drift')
            spec = importlib.util.spec_from_file_location('q26_state_sampling', path)
            module = importlib.util.module_from_spec(spec)
            exec(compile(raw, str(path), 'exec'), vars(module))
            return module
    raise FileNotFoundError('qualified sampling adapter unavailable')


S = _load_sampling()
O = S.O
pin = O.pin


def preflight(path, sha, receipt):
    rp = pin(path)
    O.need(rp['sha256'] == sha, 'trusted observer request SHA')
    r = O.read(rp)
    required = {'schema', 'kind', 'fixture_only', 'policy', 'invocation_python',
                'resolved_python', 'python_pin', 'source_pins', 'plan', 'runner', 'argv', 'output'}
    O.need(type(r) is dict and r.get('kind') in ('producer', 'saved_check'), 'observer purpose')
    if r['kind'] == 'saved_check':
        required.update(('producer_root', 'producer_manifest'))
    O.need(set(r) == required and r['schema'] == SCHEMA, 'strict request schema')
    O.need(type(r['fixture_only']) is bool, 'explicit fixture status')
    expected = dict(POLICY, wall_seconds=240 if r['kind'] == 'producer' else 180)
    policy = r['policy']
    O.need(type(policy) is dict and set(policy) == set(expected), 'exact policy fields')
    O.need(all(type(policy[k]) is int and policy[k] == expected[k]
               for k in expected if k != 'wall_seconds'), 'fixed resource policy')
    if r['fixture_only']:
        O.need(type(policy['wall_seconds']) in (int, float) and 0 < policy['wall_seconds'] <= 2,
               'tiny synthetic wall')
    else:
        O.need(type(policy['wall_seconds']) is int and policy == expected, 'fixed prospective wall')
    for name in ('python_pin', 'plan', 'runner'):
        O.check(r[name])
    O.need(type(r['invocation_python']) is str and Path(r['invocation_python']).is_absolute(), 'invocation Python')
    O.need(type(r['resolved_python']) is str and str(Path(r['invocation_python']).resolve()) ==
           r['resolved_python'] == r['python_pin']['path'], 'resolved pinned Python')
    plan = O.read(r['plan'])
    O.need(type(plan) is dict and type(plan.get('files')) is dict, 'JSON plan with file closure')
    sources = r['source_pins']
    O.need(type(sources) is list and sources, 'source closure')
    for q in sources:
        O.check(q)
    O.need(len({q['path'] for q in sources}) == len(sources), 'unique source paths')
    for q in (r['runner'], pin(__file__), pin(S.__file__), pin(O.__file__)):
        O.need(q in sources, 'required source closure member')
    O.need(Path(r['runner']['path']).suffix == '.py', 'Python runner')
    for filename, digest in plan['files'].items():
        O.need(type(filename) is str and type(digest) is str, 'plan file entry')
        if Path(filename).suffix in ('.py', '.md'):
            O.need(any(q['path'] == filename and q['sha256'] == digest for q in sources), 'plan source closure member')
    if r['kind'] == 'producer':
        O.need(Path(r['runner']['path']).name == 'r164_pool_moment_review.py', 'fixed O33 producer')
    argv = [r['invocation_python'], '-B', r['runner']['path']]
    if r['kind'] == 'producer':
        argv += ['run', '--plan', r['plan']['path'], '--out', r['output']]
    else:
        root = O.canonical(r['producer_root'])
        O.need(root.is_dir(), 'existing producer root')
        O.check(r['producer_manifest'])
        O.need(r['producer_manifest']['path'] == str(root / 'manifest.json'), 'producer manifest binding')
        O.need(Path(r['runner']['path']).name == 'r164_reconstituted_state_check.py', 'fixed saved checker')
        argv += ['--plan', r['plan']['path'], '--output-dir', str(root),
                 '--plan-sha256', r['plan']['sha256'], '--manifest-sha256',
                 r['producer_manifest']['sha256'], '--out', r['output']]
    O.need(type(r['argv']) is list and r['argv'] == argv and all(type(v) is str for v in r['argv']),
           'exact sealed argv')
    output = O.canonical(r['output'])
    dest = O.canonical(receipt)
    O.need(output.parent == dest.parent and output.parent.is_dir(), 'one existing evidence parent')
    paths = dict(receipt=dest, start=Path(str(dest) + '.start.json'),
                 stdout=Path(str(dest) + '.stdout.log'), stderr=Path(str(dest) + '.stderr.log'))
    all_paths = [output, *paths.values(), Path(str(dest) + '.sampling.json'),
                 Path(str(dest) + '.post-containment.json')]
    if r['kind'] == 'saved_check':
        O.need(all(not p.is_relative_to(root) for p in all_paths), 'saved producer root remains read-only')
    O.need(len(set(all_paths)) == 7 and all(not p.exists() and not p.is_symlink() for p in all_paths),
           'fresh exclusive output logs receipt and sampling')
    O.need(O.shutil.disk_usage(output.parent).free >= policy['disk_reserve_bytes'], 'disk reserve before start')
    return rp, r, output, paths


def _post_containment(path, sha, receipt, proc):
    """One fresh observation after the job wall; never rewrite original evidence."""
    started = time.monotonic()
    request_pin = None
    request_error = None
    try:
        request_pin = pin(path)
        O.need(request_pin['sha256'] == sha, 'post request identity')
    except Exception as e:
        request_pin = None
        request_error = type(e).__name__
    terminal_pin = None
    terminal_error = None
    try:
        terminal_pin = pin(receipt)
    except Exception as e:
        terminal_error = type(e).__name__
    state = None
    error = None
    try:
        state = O.snapshot(proc.pid, timeout=2)
    except Exception as e:
        error = type(e).__name__
    try:
        reaped = proc.poll() is not None
    except Exception as e:
        reaped = None
        error = error or type(e).__name__
    elapsed = time.monotonic() - started
    live = None if state is None else state['live_members']
    value = dict(schema='q26-state-reconstitution-post-containment-v1',
                 request=request_pin, request_sha256=sha, request_path=str(path),
                 request_pin_error_type=request_error, terminal=terminal_pin,
                 terminal_pin_error_type=terminal_error,
                 source_pins=[pin(__file__), pin(S.__file__), pin(O.__file__)],
                 child_pid=proc.pid, reaped=reaped,
                 no_live_members_remaining=None if live is None else live == [],
                 remaining_live_members=live, error_type=error,
                 snapshot_timeout_seconds=2, snapshot_attempts=1,
                 elapsed_seconds=elapsed, charged_seconds=math.ceil(elapsed),
                 timing_scope='post snapshot and metadata preparation; excludes final exclusive persistence',
                 original_terminal_unchanged=True, original_job_success_not_revised=True)
    O.exclusive(Path(str(receipt) + '.post-containment.json'), value)


def observe(path, sha, receipt, *, factory=subprocess.Popen, sample=None, kill=O.os.killpg):
    original = O.preflight
    owned = None
    result = None
    raised = False

    def capture(*args, **kwargs):
        nonlocal owned
        owned = factory(*args, **kwargs)
        return owned

    O.preflight = preflight
    try:
        result = S.observe(path, sha, receipt, factory=capture, sample=sample, kill=kill)
        return result
    except BaseException:
        raised = True
        raise
    finally:
        O.preflight = original
        if owned is not None and (raised or result is None or
                result.get('containment', {}).get('no_live_members_remaining') is not True):
            _post_containment(path, sha, receipt, owned)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--request', required=True)
    p.add_argument('--sha256', required=True)
    p.add_argument('--receipt', required=True)
    a = p.parse_args()
    try:
        result = observe(a.request, a.sha256, a.receipt)
        print(json.dumps({k: result[k] for k in ('complete', 'reason', 'elapsed_seconds', 'charged_seconds')}))
        raise SystemExit(0 if result['complete'] else 1)
    except Exception as e:
        print(json.dumps(dict(complete=False, error_type=type(e).__name__)))
        raise SystemExit(1)
