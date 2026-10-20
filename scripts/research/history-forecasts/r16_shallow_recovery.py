"""Explicit fresh operational certificates; original scientific modules stay byte-identical.
Parity uses its original direct CLI. No historical receipts are reconstructed here.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types

SCHEMA = 'r16-shallow-operational-certificate-v1'
RUNTIME = 'r16-shallow-fresh-runtime-v1'
ROOT = Path(__file__).resolve().parents[3]
BOARD = Path('/Users/EBmic/membrane-board/inbox/patches/membrane-app')
STEM = '2026-10-20-codex-r16-shallow-source-handoff'
ANCHORS = {'manifest': '609078248a692e286b9cca26c14c46aeffe8370e628046d825e64d52e45c8cc9',
           'portability': 'f8f360d8a83828ff73ee9d074328d9a845505f58b0ce2a9d0c947883c38337d0'}
STAGES = ('generation', 'merge', 'allocation', 'fit')
SLOTS = {'generation': ('parity_scope_path', 'parity_manifest_path', 'parity_independent_path'),
         'merge': ('generation_scope_path', 'generation_manifest_path', 'generation_independent_path'),
         'allocation': ('merge_scope_path', 'merge_independent_path')}
CONSTANTS = {'generation': ('PARITY_SCOPE_SHA', 'PARITY_MANIFEST_SHA'),
             'merge': ('GENERATION_SHA', 'GENERATION_MANIFEST_SHA', 'GENERATION_INDEPENDENT_SHA'),
             'allocation': ('MERGE_SCOPE_SHA', 'MERGE_INDEPENDENT_SHA')}
FAMILIES = {'generation': 'r16_shallow_projected_generation', 'merge': 'r16_shallow_merge_runner',
            'nn': 'r16_shallow_nn_runner'}
MODELS = ['nmlp', 'ngru', 'ntcn', 'ntfm', 'nmlp0']


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        while block := stream.read(1024 * 1024): h.update(block)
    return h.hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value: raise ValueError('duplicate JSON key')
        value[key] = item
    return value


def read(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=unique)


def pin(path):
    path = Path(path).resolve()
    return dict(path=str(path), size=path.stat().st_size, sha256=sha(path))


def check(value):
    if pin(value['path']) != value: raise ValueError('pin changed: ' + value['path'])
    return read(value['path'])


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream: json.dump(value, stream, indent=2, allow_nan=False); stream.write('\n')
    return pin(path)


def anchors():
    paths = {k: BOARD / (STEM + '.' + ('manifest.json' if k == 'manifest' else 'portability.json')) for k in ANCHORS}
    for key, path in paths.items():
        if sha(path) != ANCHORS[key]: raise ValueError('published source/version anchor changed')
    manifest, audit = read(paths['manifest']), read(paths['portability'])
    sources = manifest['immutableSourcePins']
    if len(sources) != 32: raise ValueError('exact32 immutable source pins required')
    for relative, expected in sources.items():
        path = ROOT / relative
        if path.stat().st_size != expected['bytes'] or sha(path) != expected['sha256']:
            raise ValueError('original source changed: ' + relative)
    versions = {canonical(k): v for k, v in audit['runtime']['mac_base']['packages']}
    if len(versions) != 30: raise ValueError('published30 package versions required')
    # Metadata identity only: original independent Pins.walk must not chase lost historical payload references.
    published = {k: dict(path=str(v.resolve()), bytes=v.stat().st_size, sha256=sha(v)) for k, v in paths.items()}
    return sources, versions, published


def canonical(name):
    return re.sub('[-_.]+', '-', name).lower()


def clone(function, replacements):
    """Same bytecode/defaults/closure, isolated globals; no original constant mutation."""
    if not set(replacements) <= set(function.__globals__): raise ValueError('unknown original gate constant')
    namespace = dict(function.__globals__); namespace.update(replacements)
    copied = types.FunctionType(function.__code__, namespace, function.__name__, function.__defaults__, function.__closure__)
    copied.__kwdefaults__ = function.__kwdefaults__
    return copied


def all_pins(value):
    if isinstance(value, dict):
        if set(value) == {'path', 'size', 'sha256'}: yield value
        else:
            for child in value.values(): yield from all_pins(child)
    elif isinstance(value, list):
        for child in value: yield from all_pins(child)


def nn_request(stage, request):
    if request.get('phase') != stage: raise ValueError('NN certificate phase differs')
    for key, wall in (('resource_policy', 28800), ('score_resource_policy', 3600)):
        expected = dict(wall_seconds=wall, grace_seconds=30, rss_bytes=2_500_000_000)
        if request.get(key) != expected or any(type(v) is not int for v in request[key].values()):
            raise ValueError('original NN operational policy differs')


def load_certificate(path, digest, seen=None):
    if sha(path) != digest: raise ValueError('certificate SHA differs')
    value = read(path); seen = set() if seen is None else seen
    if digest in seen: raise ValueError('cyclic predecessor chain')
    seen.add(digest)
    sources, _, published = anchors()
    if value.get('schema') != SCHEMA or value.get('stage') not in STAGES:
        raise ValueError('unsupported operational certificate')
    if value['original_sources'] != sources or value['published_anchors'] != published:
        raise ValueError('certificate source identity differs')
    if value['root'] != str(ROOT) or value['adapter'] != pin(__file__): raise ValueError('adapter/root differs')
    if value.get('scientific_scope') != 'seen-development-original-recipe-no-promotion': raise ValueError('scope differs')
    declaration = check(value['request']); experiment = check(value['experiment_request'])
    if declaration.get('stage') != value['stage'] or declaration.get('experiment_request') != value['experiment_request'] or declaration.get('predecessor') != value['predecessor']:
        raise ValueError('certificate declaration differs')
    for evidence in value['payload_pins']: check_text(evidence)
    predecessor = value['predecessor']; index = STAGES.index(value['stage'])
    if index == 0:
        if predecessor is not None: raise ValueError('generation must start a fresh chain')
    else:
        check_text(predecessor)
        old = load_certificate(predecessor['path'], predecessor['sha256'], seen)
        if old['stage'] != STAGES[index - 1]: raise ValueError('stage predecessor differs')
    if value['stage'] in ('allocation', 'fit'): nn_request(value['stage'], experiment)
    expected_bindings = dict(old['bindings']) if index else {}
    if value['stage'] != 'fit':
        for name, key in zip(CONSTANTS[value['stage']], SLOTS[value['stage']]):
            expected_bindings[name] = pin(experiment[key])['sha256']
    if value['bindings'] != expected_bindings: raise ValueError('certificate gate bindings differ')
    if value['stage'] == 'fit' and value['runtime'] != old['runtime']: raise ValueError('fit runtime ancestry differs')
    return value


def scope_certificate(scope_path, certificate, certificate_pin):
    scope = read(scope_path); attached = scope.get('operational_recovery')
    candidates = [certificate_pin]; cursor = certificate
    while cursor['predecessor']:
        candidates.append(cursor['predecessor'])
        cursor = load_certificate(cursor['predecessor']['path'], cursor['predecessor']['sha256'])
    if attached not in candidates: raise ValueError('scope certificate missing/not in exact ancestry')
    check(attached)


def normalized_pin(value):
    """Only the two explicit census schemas are accepted; validate actual payload."""
    keys = set(value)
    if keys not in ({'path', 'size', 'sha256'}, {'path', 'bytes', 'sha256'}):
        raise ValueError('unsupported or ambiguous runtime pin schema')
    size = value['size'] if 'size' in value else value['bytes']
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError('invalid runtime pin size')
    normalized = dict(path=value['path'], size=size, sha256=value['sha256'])
    check_text(normalized)
    return normalized


def normalized_records(values):
    records = {}
    for name, value in values.items():
        key = canonical(name)
        if key in records: raise ValueError('duplicate canonical RECORD identity')
        records[key] = normalized_pin(value)
    return records


def runtime_identity():
    records, native, inventory = {}, [], {}
    prefix = Path(sys.prefix).resolve()
    for dist in metadata.distributions():
        name = canonical(dist.metadata['Name'])
        if name in inventory: raise ValueError('duplicate installed package')
        inventory[name] = dist.version
        members = list(dist.files or [])
        own = [m for m in members if len(Path(m).parts) == 2 and Path(m).parts[0].endswith('.dist-info') and Path(m).name == 'RECORD']
        if len(own) != 1: raise ValueError('one top-level own RECORD required')
        records[name] = pin(dist.locate_file(own[0]))
        for member in members:
            path = Path(dist.locate_file(member)).resolve()
            if not path.is_relative_to(prefix): raise ValueError('runtime distribution escape')
            if path.suffix in ('.so', '.dylib') and path.is_file(): native.append(pin(path))
    return inventory, records, sorted(native, key=lambda p: p['path'])


def runtime_parts(parts, current, identity_provider=runtime_identity):
    """Fresh reports + observed bootstrap pip; never claim30 downloaded wheels."""
    _, versions, _ = anchors()
    census = check(parts['census']); cpu = check(parts['cpu_probe'])
    requirements = Path(parts['requirements']['path']); check_text(parts['requirements'])
    locked = {}
    for line in requirements.read_text().splitlines():
        name, version = line.split('==')
        if canonical(name) in locked: raise ValueError('duplicate locked requirement')
        locked[canonical(name)] = version
    if locked != versions: raise ValueError('original30 version lock differs')
    check_text(parts['pip_check'])
    if Path(parts['pip_check']['path']).read_text().strip() != 'No broken requirements found.': raise ValueError('pip check failed')
    resolved = check(parts['resolve_report']); wheels = {}
    for item in resolved['install']:
        name = canonical(item['metadata']['name']); info = item['download_info']
        if name in wheels or name == 'pip' or item['metadata']['version'] != versions[name]: raise ValueError('resolved wheel inventory differs')
        digest = info['archive_info']['hashes']['sha256']
        if not re.fullmatch('[0-9a-f]{64}', digest): raise ValueError('wheel hash missing')
        wheels[name] = dict(version=versions[name], url=info['url'], sha256=digest)
    if set(wheels) != set(versions) - {'pip'}: raise ValueError('exact29 resolved wheels plus bootstrap pip required')
    for report_pin in parts['install_reports']:
        for item in check(report_pin)['install']:
            name = canonical(item['metadata']['name']); info = item['download_info']
            if name not in wheels or dict(version=item['metadata']['version'], url=info['url'], sha256=info['archive_info']['hashes']['sha256']) != wheels[name]:
                raise ValueError('install report wheel differs')
    if not parts['install_reports']: raise ValueError('actual installation report provenance required')
    inventory, records, native = identity_provider()
    records = normalized_records(records)
    native = sorted((normalized_pin(v) for v in native), key=lambda p: p['path'])
    census_records = normalized_records(census['record_pins'])
    census_native = sorted((normalized_pin(v) for v in census['native_pins']), key=lambda p: p['path'])
    pairs = current['base']['packages']; actual = {canonical(k): v for k, v in pairs}
    if len(pairs) != 30 or inventory != versions or actual != versions or len(actual) != 30: raise ValueError('actual30 runtime inventory differs')
    if census.get('complete') is not True or census['package_inventory'] != versions or census_records != records or census_native != native:
        raise ValueError('fresh census RECORD/native identity differs')
    required = dict(complete=True, synthetic_only=True, historical_inputs=False, optimizer_steps=0, numpy_shared_roundtrip=True, torch_threads=1)
    if any(cpu.get(k) != v or type(cpu.get(k)) is not type(v) for k, v in required.items()): raise ValueError('zero-optimizer CPU/NumPy probe required')
    if [m['model'] for m in cpu['models']] != MODELS or any(m.get('finite_forward_backward') is not True for m in cpu['models']): raise ValueError('five synthetic model probes required')
    for entry in cpu['models'][:-1]:
        if entry.get('residual_baseline_equal') is not True: raise ValueError('residual probe differs')
    expected = dict(executable=sys.executable, prefix=sys.prefix, base_prefix=sys.base_prefix, python=sys.version,
                    platform=current['base']['platform'], machine=current['base']['machine'], torch=current['torch_version'],
                    numpy=versions['numpy'], torch_threads=current['torch_threads'], torch_interop_threads=current['torch_interop_threads'])
    if any(census.get(k) != v for k, v in expected.items()) or cpu['torch_interop_threads'] != current['torch_interop_threads']:
        raise ValueError('current runtime invariants differ')
    if census.get('historical_fits') != 0 or census.get('prior_historical_proofs_recreated') is not False: raise ValueError('historical runtime attribution prohibited')
    return versions, records, native, wheels


def check_text(value):
    if pin(value['path']) != value: raise ValueError('text evidence changed')


def freeze_runtime(request_path, out):
    request = read(request_path)
    if request.get('schema') != 'r16-shallow-fresh-runtime-request-v1': raise ValueError('explicit fresh runtime request required')
    import r16_shallow_nn_protocol as P
    current = P.runtime(); versions, records, native, wheels = runtime_parts(request['parts'], current)
    out = Path(out)
    if out.exists(): raise FileExistsError('runtime wrapper output exists')
    out.mkdir(parents=True)
    sources, _, published = anchors()
    scope = dict(schema=RUNTIME, request=pin(request_path), parts=request['parts'], versions=versions,
                 original_sources=sources, published_anchors=published, adapter=pin(__file__),
                 wheel_lock=wheels, bootstrap_pip=dict(version=versions['pip'], record=records['pip'], downloaded_by_this_report=False))
    scope_pin = write_new(out/'scope.json', scope)
    probe = dict(complete=True, scope_sha256=scope_pin['sha256'], executable=sys.executable,
                 torch_version=current['torch_version'], numpy_version=versions['numpy'], inventory=versions, record_pins=records, native_pins=native,
                 original_probe=scope['parts']['cpu_probe'], synthetic_only=True, optimizer_steps=0, historical_inputs=False,
                 current_runtime=current, prior_historical_proofs_recreated=False)
    probe_pin = write_new(out/'probe.json', probe)
    manifest = dict(schema=RUNTIME, complete=True, scope_sha256=scope_pin['sha256'], probe=probe_pin,
                    parts=scope['parts'], qualification='Fresh operational qualification only; interrupted install reports are provenance, not proof every planned wheel installed. Actual inventory/RECORD/native census is authoritative.')
    return write_new(out/'manifest.json', manifest)


def fresh_runtime_proof(request, current, expected=None):
    references = {k: pin(request[k]) for k in ('runtime_probe_path', 'runtime_install_manifest_path', 'runtime_install_scope_path')}
    if expected is not None and references != expected: raise ValueError('certificate runtime proof differs')
    scope = check(references['runtime_install_scope_path']); probe = check(references['runtime_probe_path']); manifest = check(references['runtime_install_manifest_path'])
    if scope.get('schema') != RUNTIME or manifest.get('schema') != RUNTIME or manifest.get('complete') is not True:
        raise ValueError('fresh explicit runtime schema required')
    sources, _, published = anchors()
    if scope['original_sources'] != sources or scope['published_anchors'] != published or scope['adapter'] != pin(__file__): raise ValueError('runtime adapter/source identity differs')
    declaration = check(scope['request'])
    if declaration.get('schema') != 'r16-shallow-fresh-runtime-request-v1' or declaration.get('parts') != scope['parts']:
        raise ValueError('runtime request/parts differ')
    if manifest['scope_sha256'] != references['runtime_install_scope_path']['sha256'] or probe['scope_sha256'] != manifest['scope_sha256'] or manifest['probe'] != references['runtime_probe_path'] or manifest['parts'] != scope['parts']:
        raise ValueError('fresh runtime chain differs')
    versions, records, native, wheels = runtime_parts(scope['parts'], current)
    bootstrap = dict(version=versions['pip'], record=records['pip'], downloaded_by_this_report=False)
    if scope['bootstrap_pip'] != bootstrap: raise ValueError('bootstrap pip provenance differs')
    if probe.get('numpy_version') != versions['numpy']: raise ValueError('probe NumPy version differs')
    if scope['versions'] != versions or scope['wheel_lock'] != wheels or probe['inventory'] != versions or probe['record_pins'] != records or probe['native_pins'] != native or probe['current_runtime'] != current or probe['original_probe'] != scope['parts']['cpu_probe']:
        raise ValueError('fresh runtime proof/current payload differs')
    if probe.get('complete') is not True or probe.get('optimizer_steps') != 0 or probe.get('historical_inputs') is not False: raise ValueError('no-fit fresh probe required')
    return list(records.values()) + native, references['runtime_install_scope_path']


def certificate_gate(stage, request, bindings):
    if stage == 'generation':
        module = importlib.import_module(FAMILIES['generation'])
        return clone(module.accepted_proof, bindings)(request)
    if stage == 'merge':
        module = importlib.import_module(FAMILIES['merge'])
        return clone(module.accepted_generation, bindings)(request)
    module = importlib.import_module('r16_shallow_nn_protocol')
    return clone(module.accepted, bindings)(request)


def allocation_admission(request_path, experiment, ancestor, verifier=None):
    """Reuse original independent allocation admission before minting a fit certificate."""
    if verifier is None: verifier = importlib.import_module('r16_shallow_nn_independent')
    scope_path = Path(experiment['allocation_scope_path']).resolve()
    scope_pin = pin(scope_path)
    if scope_pin['sha256'] != experiment['allocation_scope_sha256'] or ancestor['phase'] != 'allocation':
        raise ValueError('exact allocation scope required')
    root = Path(ancestor['out']).resolve()
    actual = pin(experiment['allocation_receipt_path'])
    if Path(actual['path']) != root/'allocation.json': raise ValueError('allocation receipt location differs')
    independent = experiment['parent_verified_allocation_independent_receipt']
    check(independent)
    proof = [scope_pin, pin(root/'child.json'), pin(root/'monitor.json')]
    temporary_fit_scope = dict(request=pin(request_path), allocation_proof=proof,
                               allocation_receipt=actual, source_sha256=ancestor['source_sha256'])
    registry = verifier.Pins(ancestor['evidence']['datasets'])
    verifier.allocation_admission(temporary_fit_scope, independent['path'], independent['sha256'], registry)
    registry.recheck()
    return [independent, actual, *proof, *registry.entries.values()]


def freeze_certificate(request_path, out):
    request = read(request_path)
    if request.get('schema') != 'r16-shallow-operational-certificate-request-v1' or request.get('stage') not in STAGES:
        raise ValueError('explicit supported stage request required')
    stage = request['stage']; experiment = check(request['experiment_request']); predecessor = request.get('predecessor')
    if stage in ('allocation', 'fit'): nn_request(stage, experiment)
    sources, _, published = anchors(); bindings = {}; runtime = None
    if stage == 'generation':
        if predecessor is not None: raise ValueError('initial generation certificate cannot inherit historical proof')
    else:
        previous = load_certificate(predecessor['path'], predecessor['sha256'])
        if previous['stage'] != STAGES[STAGES.index(stage)-1]: raise ValueError('stages cannot be skipped')
        bindings.update(previous['bindings']); runtime = previous['runtime']
    payload = [request['experiment_request']]
    if stage != 'fit':
        paths = SLOTS[stage]
        for constant, key in zip(CONSTANTS[stage], paths): bindings[constant] = pin(experiment[key])['sha256']
        result = certificate_gate(stage, experiment, {k: bindings[k] for k in CONSTANTS[stage]})
        payload.extend(all_pins(result))
        payload.extend(pin(experiment[k]) for k in paths)
        if predecessor is not None: scope_certificate(experiment[paths[0]], previous, predecessor)
    else:
        if experiment.get('phase') != 'fit': raise ValueError('fit request required')
        scope_certificate(experiment['allocation_scope_path'], previous, predecessor)
        P = importlib.import_module('r16_shallow_nn_protocol')
        original_runtime_proof = P.runtime_proof
        P.runtime_proof = lambda req, current: fresh_runtime_proof(req, current, previous['runtime'])
        try: ancestor = P.preflight(experiment['allocation_scope_path'], experiment['allocation_scope_sha256'])
        finally: P.runtime_proof = original_runtime_proof
        payload.extend(allocation_admission(request['experiment_request']['path'], experiment, ancestor))
    if stage in ('allocation', 'fit'):
        P = importlib.import_module('r16_shallow_nn_protocol')
        fresh_runtime_proof(experiment, P.runtime(), runtime)
        runtime = {k: pin(experiment[k]) for k in ('runtime_probe_path', 'runtime_install_manifest_path', 'runtime_install_scope_path')}
        payload.extend(runtime.values())
    value = dict(schema=SCHEMA, stage=stage, root=str(ROOT), adapter=pin(__file__), original_sources=sources,
                 published_anchors=published, request=pin(request_path), experiment_request=request['experiment_request'],
                 predecessor=predecessor, bindings=bindings, runtime=runtime,
                 payload_pins=sorted({p['path']: p for p in payload}.values(), key=lambda p: p['path']),
                 scientific_scope='seen-development-original-recipe-no-promotion',
                 qualification='Fresh recovery derivative after unavailable temporary evidence. No historical receipt, original fit state, forward validity or model result is reconstructed.')
    return write_new(out, value)


class ChildProxy:
    """Only exact NN monitor child lists are rewritten; ps and other APIs forward."""
    def __init__(self, real, certificate_path, digest, validator):
        self.real, self.path, self.digest, self.validator = real, str(Path(certificate_path).resolve()), digest, validator
    def __getattr__(self, name): return getattr(self.real, name)
    def Popen(self, command, *args, **kwargs):
        runner = str(Path(__file__).with_name('r16_shallow_nn_runner.py'))
        if not isinstance(command, list) or len(command) != 9 or command[:2] != [sys.executable, runner] or command[2] not in ('_child', '_score_child') or command[3::2] != ['--scope', '--scope-sha256', '--out']:
            raise ValueError('unexpected monitor child argv')
        self.validator(command[4], command[6], command[8])
        original = command[2:]
        command[:] = [sys.executable, str(Path(__file__).resolve()), 'invoke', '--certificate', self.path,
                      '--certificate-sha256', self.digest, '--family', 'nn', '--', *original]
        return self.real.Popen(command, *args, **kwargs)


def install(certificate_path, digest, family):
    certificate = load_certificate(certificate_path, digest); certificate_pin = pin(certificate_path)
    allowed = 'nn' if certificate['stage'] in ('allocation', 'fit') else certificate['stage']
    if family != allowed: raise ValueError('certificate stage/CLI family mismatch')
    module = importlib.import_module(FAMILIES[family]); protocol = module.P if family == 'nn' else module
    stage = 'allocation' if family == 'nn' else family
    replacements = {k: certificate['bindings'][k] for k in CONSTANTS[stage]}
    gate = {'generation': 'accepted_proof', 'merge': 'accepted_generation', 'nn': 'accepted'}[family]
    setattr(protocol, gate, clone(getattr(protocol, gate), replacements))
    if family == 'nn':
        protocol.runtime_proof = lambda request, current: fresh_runtime_proof(request, current, certificate['runtime'])
    preflight = clone(protocol.preflight, replacements) if family == 'generation' else protocol.preflight
    def guarded(path, scope_sha):
        load_certificate(certificate_path, digest)
        scope_certificate(path, certificate, certificate_pin)
        return preflight(path, scope_sha)
    protocol.preflight = guarded
    freeze = protocol.freeze
    def frozen(request, out):
        load_certificate(certificate_path, digest)
        if pin(request) != certificate['experiment_request']: raise ValueError('certificate request differs')
        result = freeze(request, out); scope = read(out); scope['operational_recovery'] = certificate_pin
        protocol.R.atomic_json(out, scope)
        return dict(result, scope_sha256=sha(out))
    protocol.freeze = frozen
    if family == 'nn':
        monitor = importlib.import_module('r16_shallow_nn_monitor')
        def child_scope(path, scope_sha, out):
            load_certificate(certificate_path, digest)
            if sha(path) != scope_sha or str(Path(out).resolve()) != read(path)['out']: raise ValueError('child scope/output differs')
            scope_certificate(path, certificate, certificate_pin)
            if read(path)['operational_recovery'] != certificate_pin: raise ValueError('child requires exact stage certificate')
        monitor.subprocess = ChildProxy(subprocess, certificate_path, digest, child_scope)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest='command', required=True)
    for name in ('freeze-runtime', 'freeze-certificate'):
        p = commands.add_parser(name); p.add_argument('--request', required=True); p.add_argument('--out', required=True)
    p = commands.add_parser('invoke'); p.add_argument('--certificate', required=True); p.add_argument('--certificate-sha256', required=True)
    p.add_argument('--family', choices=FAMILIES, required=True); p.add_argument('original_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'freeze-runtime': result = freeze_runtime(args.request, args.out)
    elif args.command == 'freeze-certificate': result = freeze_certificate(args.request, args.out)
    else:
        module = install(args.certificate, args.certificate_sha256, args.family)
        tail = args.original_args[1:] if args.original_args[:1] == ['--'] else args.original_args
        if '--scope' in tail:
            if tail.count('--scope') != 1: raise ValueError('one exact child/scope entry required')
            scope = read(tail[tail.index('--scope') + 1])
            if scope.get('operational_recovery') != pin(args.certificate): raise ValueError('entry requires exact stage certificate')
        sys.argv = [module.__file__, *tail]; module.main(); return
    print(json.dumps(result))


if __name__ == '__main__': main()
