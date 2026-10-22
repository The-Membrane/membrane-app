"""Narrow --request admission; unchanged qualified Q/S/O own observation.

Only metadata and streaming byte hashes are read. No numerical modules, private
array decoders or forecasting sources are imported by this admission adapter.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
OLD_PATH = HERE / 'observer.py'
OLD_SHA = 'c842d30223b5b7975064e400ca32688ebd5fc09ceb9974248b0305d69ff0254c'
_old_bytes = OLD_PATH.read_bytes()
if hashlib.sha256(_old_bytes).hexdigest() != OLD_SHA:
    raise ValueError('qualified existing observer changed')
_spec = importlib.util.spec_from_file_location('depth_qualified_old_observer', OLD_PATH)
M = importlib.util.module_from_spec(_spec)
exec(compile(_old_bytes, str(OLD_PATH), 'exec'), vars(M))
Q, O = M.Q, M.O
SCHEMA = 'q26-fh-depth-observer-request-v1'
POLICY = dict(rss_bytes=805306368, output_bytes=67108864, disk_reserve_bytes=2415919104)
PRODUCER_ROLES = {'plan','result','acceptance','witness','started','audit','checker','source','python','support_module','support_request'}
CHECKER_ROLES = {'producer_request','result','basis','started','producer_source','terminal','checker_source','python','support_module','support_request','plan','acceptance','witness','audit','checker'}
OUTER_KEYS = {'schema','kind','fixture_only','policy','invocation_python','resolved_python','python_pin','source_pins','inner_request','runner','argv','output'}


def canonical(path):
    p = O.canonical(path)
    O.need(not any(x.is_symlink() for x in p.parents), 'nonsymlink ancestors')
    return p


def checked(pin):
    canonical(pin['path'])
    O.check(pin)


def read(pin):
    checked(pin)
    def pairs(items):
        out = {}
        for key, value in items:
            O.need(key not in out, 'duplicate JSON key')
            out[key] = value
        return out
    def bad(_):
        raise ValueError('nonfinite JSON')
    return json.loads(Path(pin['path']).read_bytes(), object_pairs_hook=pairs, parse_constant=bad)


def request(pin, schema, roles):
    O.need(pin['size'] <= 65536, 'bounded inner request')
    body = read(pin)
    O.need(set(body) == {'schema','pins','out'} and body['schema'] == schema and set(body['pins']) == roles, 'sealed inner request schema')
    for value in body['pins'].values():
        checked(value)
    canonical(body['out'])
    return body


def accepted_chain(inner):
    """Rehash complete old closure and authenticate saved metadata, no decoding."""
    pins = inner['pins']
    support = request(pins['support_request'], 'q26-fh-support-width-request-v1',
                      {'plan','result','acceptance','witness','started','implementation','python'})
    old = support['pins']
    O.need(old['witness']['size'] <= 67108864, 'bounded accepted witness bytes')
    for role in ('plan','acceptance','witness','python'):
        O.need(old[role] == pins[role], 'same original accepted chain')
    O.need(old['implementation'] == pins['support_module'], 'accepted support source')
    plan = read(pins['plan'])
    O.need(plan['schema'] == 'q26-fh-date-support-plan-v1' and plan['parent_admitted'] is True and
           plan['mode'] == 'NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT' and plan['row_capacity'] == 200000, 'fixed original plan')
    files = {}
    for value in plan['files']:
        checked(value)
        O.need(value['path'] not in files, 'unique old closure')
        files[value['path']] = value
    for value in list(plan['roles'].values()) + list(plan['legacy_sources'].values()):
        O.need(files.get(value['path']) == value, 'old role/source closure')
    O.need(plan['roles']['audit'] == pins['audit'] and plan['roles']['checker'] == pins['checker'], 'original adapters')
    runtime = plan['runtime']
    O.need(pins['python'] == runtime['executable'] and
           runtime['python_version'] == sys.version.split()[0], 'original interpreter')
    O.need(sys.flags.optimize == 0 and sys.dont_write_bytecode and
           runtime['env'] == {'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONOPTIMIZE':'0'} and
           all(os.environ.get(k) == v for k,v in runtime['env'].items()), 'sealed runtime environment')
    O.need(set(runtime['packages']) == {'numpy','scipy','numba','llvmlite'} and
           all(importlib.metadata.version(k) == v for k,v in runtime['packages'].items()), 'runtime package versions')
    result, acceptance, started = (read(old[k]) for k in ('result','acceptance','started'))
    O.need(result['schema'] == 'q26-fh-date-support-result-v1' and result['complete'] is True and
           result['reconstruction'] is True and result['historical_bridge_parity'] == 'UNAVAILABLE', 'old reconstructed result')
    O.need(acceptance['schema'] == 'q26-fh-date-support-acceptance-v1' and acceptance['complete'] is True and
           acceptance['reconstruction'] is True and acceptance['historical_bridge_parity'] == 'UNAVAILABLE', 'old saved acceptance')
    O.need(result['plan_sha256'] == acceptance['plan_sha256'] == started['plan_sha256'] == old['plan']['sha256'] and
           acceptance['result_sha256'] == old['result']['sha256'] and acceptance['checker_source'] == pins['checker'] and
           acceptance['summary'] == result['summary'], 'old acceptance chain')
    O.need(result['witness'] == old['witness'] and result['started'] == old['started'] and
           result['source'] == pins['audit'], 'old result pins')
    O.need(started == {'schema':'q26-fh-date-support-started-v1','plan_sha256':old['plan']['sha256'],'reconstruction':True}, 'old started marker')
    root = canonical(plan['out'])
    O.need(root.is_dir() and {v.name for v in root.iterdir()} == {'started.json','witness.npz','result.json'} and
           all(v.is_file() and not v.is_symlink() for v in root.iterdir()), 'old exact inventory')
    for role, filename in (('result','result.json'),('witness','witness.npz'),('started','started.json')):
        O.need(old[role]['path'] == str(root/filename), 'old exact output paths')
    return plan, files, old


def terminal_binding(r, inner, plan, sources):
    """Bind actual unchanged Q terminal and the checker's summary projection."""
    pins = inner['pins']
    terminal = read(r['producer_observer_terminal'])
    O.need(terminal['schema'] == 'q26-weighted-causal-primary-pair-observer-terminal-v1' and
           terminal['complete'] is True and type(terminal['tool_terminal_exit']) is int and terminal['tool_terminal_exit'] == 0 and
           terminal['process_terminal'] is True and terminal['observer_timeout'] is False and
           terminal['reason'] is None and terminal['errors'] == [] and terminal['fixture_only'] is r['fixture_only'] and
           terminal['containment']['reaped'] is True and terminal['containment']['no_live_members_remaining'] is True, 'actual complete producer containment')
    original = read(terminal['request'])
    O.need(set(original) == OUTER_KEYS and original['schema'] == SCHEMA and original['kind'] == 'producer' and
           original['fixture_only'] is r['fixture_only'] and original['inner_request'] == pins['producer_request'] and
           original['runner'] == pins['producer_source'] == terminal['runner'] and
           original['python_pin'] == r['python_pin'] and original['invocation_python'] == r['invocation_python'] and
           original['resolved_python'] == r['resolved_python'] and original['source_pins'] == r['source_pins'], 'same producer admission lineage')
    producer = request(pins['producer_request'], 'q26-fh-depth-accounting-request-v1', PRODUCER_ROLES)
    for key in ('plan','acceptance','witness','audit','checker','python','support_module','support_request'):
        O.need(producer['pins'][key] == pins[key], 'producer/checker original authority')
    O.need(producer['pins']['source'] == pins['producer_source'] and sources.get(pins['producer_source']['path']) == pins['producer_source'], 'producer source closure')
    expected = [r['invocation_python'],'-B',pins['producer_source']['path'],'--request',pins['producer_request']['path'],
                '--request-sha256',pins['producer_request']['sha256'],'--out',producer['out']]
    O.need(original['argv'] == expected and original['output'] == producer['out'], 'actual producer exact command')
    limit = dict(POLICY,wall_seconds=60)
    if r['fixture_only']:
        O.need(type(original['policy']['wall_seconds']) in (int,float) and 0 < original['policy']['wall_seconds'] <= 2 and
               {k:v for k,v in original['policy'].items() if k!='wall_seconds'} == POLICY, 'completed tiny fixture policy')
    else:
        O.need(original['policy'] == limit and all(type(v) is int for v in original['policy'].values()), 'completed producer policy')
    root = canonical(producer['out'])
    O.need(root.is_dir() and not root.is_relative_to(canonical(plan['out'])) and
           {v.name for v in root.iterdir()} == {'started.json','basis.npz','result.json'}, 'new producer exact inventory')
    for role,filename in (('result','result.json'),('basis','basis.npz'),('started','started.json')):
        O.need(pins[role]['path'] == str(root/filename), 'new producer output paths')
    O.need(pins['result']['size'] <= 4194304 and pins['basis']['size'] <= 67108864 and pins['started']['size'] <= 4096, 'bounded new saved artifacts')
    result, started = read(pins['result']), read(pins['started'])
    O.need(result['complete'] is True and result['request_sha256'] == pins['producer_request']['sha256'] and
           result['request_pins'] == producer['pins'] and result['source'] == pins['producer_source'] and
           result['basis'] == pins['basis'] and result['started'] == pins['started'], 'new producer result bindings')
    O.need(started == {'schema':'q26-fh-depth-accounting-started-v1','request_sha256':pins['producer_request']['sha256'],'reconstruction':True}, 'new producer started')
    projected = read(pins['terminal'])
    O.need(set(projected) == {'schema','request','argv','complete','exit_code','reaped','no_live_members','elapsed_seconds','charged_seconds','output_pins'} and
           projected['schema'] == 'q26-fh-depth-producer-terminal-v1' and projected['request'] == pins['producer_request'] and
           projected['argv'] == expected and projected['complete'] is True and type(projected['exit_code']) is int and projected['exit_code'] == 0 and
           projected['reaped'] is True and projected['no_live_members'] is True and
           projected['elapsed_seconds'] == terminal['elapsed_seconds'] and projected['charged_seconds'] == terminal['charged_seconds'] and
           projected['output_pins'] == {k:pins[k] for k in ('result','basis','started')}, 'projection of actual producer terminal')
    return root


def preflight(path, sha, receipt):
    rp = O.pin(canonical(path))
    O.need(rp['sha256'] == sha and rp['size'] <= 65536, 'external bounded observer request SHA')
    r = read(rp)
    keys = OUTER_KEYS | ({'producer_observer_terminal'} if r.get('kind') == 'saved_check' else set())
    O.need(set(r) == keys and r['schema'] == SCHEMA and r['kind'] in ('producer','saved_check') and type(r['fixture_only']) is bool, 'strict observer purpose')
    policy = r['policy']
    O.need(set(policy) == set(POLICY)|{'wall_seconds'} and all(type(policy[k]) is int and policy[k] == v for k,v in POLICY.items()), 'fixed resource policy')
    if r['fixture_only']:
        O.need(type(policy['wall_seconds']) in (int,float) and 0 < policy['wall_seconds'] <= 2, 'tiny transport fixture')
    else:
        O.need(type(policy['wall_seconds']) is int and policy['wall_seconds'] == (60 if r['kind']=='producer' else 30), 'fixed prospective wall')
    for key in ('python_pin','inner_request','runner'):
        checked(r[key])
    O.need(str(Path(r['invocation_python']).resolve()) == r['resolved_python'] == r['python_pin']['path'] and
           r['invocation_python'] == sys.executable, 'sealed invocation interpreter')
    sources = {}
    O.need(type(r['source_pins']) is list and len(r['source_pins']) > 0, 'source closure')
    for value in r['source_pins']:
        checked(value);O.need(value['path'] not in sources,'unique source path');sources[value['path']] = value
    for p in (Path(__file__),OLD_PATH,M.Q_PATH,Path(Q.S.__file__),Path(O.__file__)):
        O.need(sources.get(str(p.resolve())) == O.pin(p.resolve()), 'unchanged executing observer closure')
    schema, roles, runner_role = ('q26-fh-depth-accounting-request-v1',PRODUCER_ROLES,'source') if r['kind']=='producer' else ('q26-fh-depth-check-request-v1',CHECKER_ROLES,'checker_source')
    inner = request(r['inner_request'],schema,roles)
    plan, files, old = accepted_chain(inner)
    O.need(r['python_pin'] == inner['pins']['python'] and r['runner'] == inner['pins'][runner_role] and
           sources.get(r['runner']['path']) == r['runner'], 'sealed worker and runtime')
    for value in list(files.values()) + list(inner['pins'].values()):
        if Path(value['path']).suffix in ('.py','.md'):
            O.need(sources.get(value['path']) == value, 'all scientific and worker sources declared')
    expected = [r['invocation_python'],'-B',r['runner']['path'],'--request',r['inner_request']['path'],'--request-sha256',r['inner_request']['sha256']]
    roots = [canonical(plan['out'])]
    if r['kind']=='producer':
        O.need(inner['pins']['result'] == old['result'] and inner['pins']['started'] == old['started'], 'same original producer outputs')
        expected += ['--out',r['output']]
    else:
        checked(r['producer_observer_terminal'])
        roots.append(terminal_binding(r,inner,plan,sources))
    O.need(r['argv'] == expected and r['output'] == inner['out'], 'exact request command/output')
    output, dest = canonical(r['output']), canonical(receipt)
    O.need(output.parent == dest.parent and dest.parent.is_dir(), 'one existing evidence parent')
    paths = dict(receipt=dest,start=Path(str(dest)+'.start.json'),stdout=Path(str(dest)+'.stdout.log'),stderr=Path(str(dest)+'.stderr.log'))
    all_paths = [output,*paths.values(),Path(str(dest)+'.sampling.json'),Path(str(dest)+'.post-containment.json')]
    O.need(len(set(all_paths)) == 7 and all(not p.exists() and not p.is_symlink() for p in all_paths), 'seven exclusive destinations')
    O.need(all(not p.is_relative_to(root) for p in all_paths for root in roots), 'accepted producer inventories remain read-only')
    O.need(O.shutil.disk_usage(output.parent).free >= policy['disk_reserve_bytes'], 'prelaunch disk reserve')
    return rp,r,output,paths


def observe(path, sha, receipt, *, factory=subprocess.Popen, sample=None, kill=O.os.killpg):
    original = Q.preflight
    Q.preflight = preflight
    try:
        # Calling M.observe would overwrite this narrow admission again.
        return Q.observe(path,sha,receipt,factory=factory,sample=sample,kill=kill)
    finally:
        Q.preflight = original


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('request','sha256','receipt'):p.add_argument('--'+key,required=True)
    a=p.parse_args()
    value=observe(a.request,a.sha256,a.receipt)
    print(json.dumps({k:value[k] for k in ('complete','reason','elapsed_seconds','charged_seconds')}))
    raise SystemExit(0 if value['complete'] else 1)
