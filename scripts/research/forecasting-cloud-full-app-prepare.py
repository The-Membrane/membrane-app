#!/usr/bin/env python3
"""Prepare immutable source copy and proposed seals only; never runs an app job."""
import argparse, hashlib, io, json, pathlib, re, shutil, subprocess, tarfile

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(262144), b''): h.update(b)
    return h.hexdigest()

def seal_runtime_closure(binaries, pins, links):
    """Read-only loader metadata for known installed ELF binaries/libraries only."""
    pending = [pathlib.Path(p).resolve() for p in binaries]; seen = set()
    while pending:
        path = pending.pop()
        if path in seen: continue
        if not path.is_file(): raise RuntimeError('runtime_library_missing:' + str(path))
        seen.add(path); pins[str(path)] = sha(path)
        with open(path, 'rb') as f: elf = f.read(4) == b'\x7fELF'
        if not elf: continue
        result = subprocess.run(['/usr/bin/ldd', str(path)], capture_output=True, text=True,
            timeout=4, env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
        body = result.stdout + result.stderr
        if 'not found' in body: raise RuntimeError('runtime_library_unresolved:' + str(path))
        if result.returncode and 'statically linked' not in body and 'not a dynamic executable' not in body:
            raise RuntimeError('runtime_loader_metadata_failed:' + str(path))
        for line in body.splitlines():
            if not line.strip() or 'linux-vdso.so' in line or 'statically linked' in line or 'not a dynamic executable' in line: continue
            match = re.search(r'(?:=>\s*)?(/[^\s]+)\s+\(', line)
            if not match: raise RuntimeError('runtime_loader_line_unrecognized:' + line)
            library = pathlib.Path(match.group(1))
            links[str(library)] = str(library.resolve())
            pending.append(library.resolve())
    return sorted(str(p) for p in seen)

def seal_tree(root, pins, links):
    root = pathlib.Path(root)
    if not root.exists(): raise RuntimeError('browser_resource_tree_missing:' + str(root))
    for p in root.rglob('*'):
        if p.is_symlink():
            links[str(p)] = str(p.resolve())
            if not p.exists(): raise RuntimeError('browser_resource_broken_link:' + str(p))
            if p.is_file(): pins[str(p.resolve())] = sha(p.resolve())
        elif p.is_file(): pins[str(p.resolve())] = sha(p)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--source', required=True)
    parser.add_argument('--expected-commit', required=True); parser.add_argument('--datasets', required=True)
    parser.add_argument('--destination', required=True); parser.add_argument('--kind', required=True)
    parser.add_argument('--reuse-snapshot', action='store_true')
    parser.add_argument('--build-proof'); parser.add_argument('--build-spec')
    parser.add_argument('--argv-json', required=True); parser.add_argument('--data-pins-json', required=True)
    a = parser.parse_args(); source = pathlib.Path(a.source).resolve(); dest = pathlib.Path(a.destination)
    def git(*args): return subprocess.check_output(['git', *args], cwd=source, text=True).strip()
    if git('rev-parse', 'HEAD') != a.expected_commit or git('status', '--porcelain'):
        raise RuntimeError('final_source_not_clean_exact_commit')
    if dest.exists() and not a.reuse_snapshot: raise RuntimeError('destination_must_be_new_no_overwrite')
    if a.reuse_snapshot and not dest.is_dir(): raise RuntimeError('shared_snapshot_missing')
    if a.kind not in ['full-typecheck','production-build','bounded-http','chromium-browser']:
        raise RuntimeError('job_kind_invalid')
    archive = subprocess.check_output(['git', 'archive', '--format=tar', a.expected_commit], cwd=source)
    if len(archive) > 128 * 1024 ** 2: raise RuntimeError('source_archive_size')
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('archive_unsafe_member')
            if any(part.startswith('.env') for part in path.parts): raise RuntimeError('source_env_file_forbidden')
        if a.reuse_snapshot:
            for member in tar.getmembers():
                if member.isfile():
                    target = dest / member.name
                    if target.is_symlink() or not target.is_file() or sha(target) != hashlib.sha256(tar.extractfile(member).read()).hexdigest():
                        raise RuntimeError('shared_source_snapshot_drift:' + member.name)
        else:
            dest.mkdir(parents=True, mode=0o700)
            tar.extractall(dest, filter='data')
    dependencies = (source / 'node_modules').resolve()
    if a.reuse_snapshot:
        if not (dest / 'node_modules').is_symlink() or (dest / 'node_modules').resolve() != dependencies:
            raise RuntimeError('shared_dependency_link_drift')
    else: (dest / 'node_modules').symlink_to(dependencies, target_is_directory=True)
    pins = {str(p.resolve()): sha(p) for p in dest.rglob('*') if p.is_file() and not p.is_symlink() and '.next' not in p.relative_to(dest).parts}
    artifact_lineage = None
    if a.kind in ['bounded-http','chromium-browser']:
        if not a.reuse_snapshot or not a.build_proof or not a.build_spec:
            raise RuntimeError('post_success_build_proof_and_shared_snapshot_required')
        proof_path = pathlib.Path(a.build_proof).resolve(); build_spec_path = pathlib.Path(a.build_spec).resolve()
        proof = json.loads(proof_path.read_text()); build_spec = json.loads(build_spec_path.read_text())
        if proof.get('status') != 'PASS' or proof.get('kind') != 'production-build' or proof.get('exitCode') != 0 or not proof.get('pinsCheckedBefore') or not proof.get('pinsCheckedAfter') or not proof.get('allDescendantsClean'):
            raise RuntimeError('production_build_not_accepted')
        if proof.get('specSha256') != sha(build_spec_path) or build_spec.get('sourceCommit') != a.expected_commit or pathlib.Path(build_spec.get('checkout','')).resolve() != dest.resolve():
            raise RuntimeError('production_build_lineage_mismatch')
        for path,digest in build_spec['pins'].items():
            if sha(path) != digest: raise RuntimeError('accepted_build_input_drift:' + path)
        for path,target in build_spec['links'].items():
            if str(pathlib.Path(path).resolve()) != target: raise RuntimeError('accepted_build_link_drift')
        if not (dest / '.next/BUILD_ID').is_file(): raise RuntimeError('production_build_artifacts_missing')
        artifacts = {}
        for path in (dest / '.next').rglob('*'):
            if path.is_symlink(): raise RuntimeError('build_artifact_symlink_forbidden')
            if path.is_file() and 'cache' not in path.relative_to(dest / '.next').parts:
                artifacts[str(path.resolve())] = sha(path)
        manifest = {'schema':'cloud-production-artifact-seal-v1','sourceCommit':a.expected_commit,'checkout':str(dest.resolve()),
            'acceptedBuildProof':str(proof_path),'acceptedBuildProofSha256':sha(proof_path),
            'acceptedBuildSpecSha256':sha(build_spec_path),'excludedMutablePaths':['.next/cache'], 'pins':artifacts}
        body = json.dumps(manifest,indent=2)+'\n'; digest = hashlib.sha256(body.encode()).hexdigest()
        manifest_path = dest.parent / ('production-artifacts-'+digest+'.json')
        if manifest_path.exists() and manifest_path.read_text()!=body: raise RuntimeError('artifact_manifest_collision')
        manifest_path.write_text(body); manifest_path.chmod(0o400)
        pins.update(artifacts); pins[str(manifest_path)] = digest
        pins[str(proof_path)] = sha(proof_path); pins[str(build_spec_path)] = sha(build_spec_path)
        artifact_lineage = {'manifest':str(manifest_path),'sha256':digest,'acceptedBuildProofSha256':sha(proof_path)}
    links = {str(dest / 'node_modules'): str(dependencies)}
    # Observed Vitest output is a generated results record, not installed software.
    # Exclude this exact root cache file only; do not exempt package caches/code.
    mutable_result = '.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json'
    excluded_mutable = []
    # Existing installed graph is sealed in place, never duplicated or installed.
    for p in dependencies.rglob('*'):
        if p.relative_to(dependencies).as_posix() == mutable_result and p.is_file() and not p.is_symlink():
            excluded_mutable.append({'path':str(p),'relativePath':mutable_result,
                'kind':'generated_vitest_result_cache_not_software',
                'reason':'focused Vitest rewrites results.json; all other installed files and links remain sealed'})
            continue
        if p.is_symlink(): links[str(p)] = str(p.resolve())
        elif p.is_file(): pins[str(p.resolve())] = sha(p)
    for p, digest in json.loads(pathlib.Path(a.data_pins_json).read_text()).items():
        if sha(p) != digest: raise RuntimeError('dataset_pin_mismatch')
        pins[str(pathlib.Path(p).resolve())] = digest
    argv = json.loads(a.argv_json)
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) for v in argv): raise RuntimeError('argv_invalid')
    if not pathlib.Path(argv[0]).is_absolute(): raise RuntimeError('absolute_executable_required')
    pins[str(pathlib.Path(argv[0]).resolve())] = sha(argv[0])
    links[argv[0]] = str(pathlib.Path(argv[0]).resolve())
    node = pathlib.Path(shutil.which('node')).resolve()
    links[shutil.which('node')] = str(node)
    runtime_closure = seal_runtime_closure([node, pathlib.Path(argv[0]).resolve()], pins, links)
    browser_closure = None
    if a.kind == 'chromium-browser':
        browser = pathlib.Path('/usr/lib/chromium/chromium')
        wrapper = pathlib.Path('/usr/bin/chromium')
        if not browser.is_file() or not wrapper.is_file(): raise RuntimeError('installed_browser_missing')
        pins[str(wrapper)] = sha(wrapper)
        seal_tree('/usr/lib/chromium', pins, links)
        seal_tree('/usr/share/fonts', pins, links)
        seal_tree('/etc/fonts', pins, links)
        seal_tree('/var/cache/fontconfig', pins, links)
        elf_resources = []
        for p in pathlib.Path('/usr/lib/chromium').rglob('*'):
            if p.is_file():
                with open(p, 'rb') as f:
                    if f.read(4) == b'\x7fELF': elf_resources.append(p)
        browser_closure = seal_runtime_closure(elf_resources, pins, links)
    launcher = source / 'scripts/research/forecasting-cloud-full-app-launcher.py'
    pins[str(launcher.resolve())] = sha(launcher)
    guard = source / 'scripts/research/forecasting-cloud-full-app-node-guard.cjs'
    pins[str(guard.resolve())] = sha(guard)
    network_guard = source / 'scripts/research/forecasting-cloud-full-app-network-guard.cjs'
    pins[str(network_guard.resolve())] = sha(network_guard)
    spec = {'schema':'cloud-full-app-reviewed-launcher-v1','kind':a.kind,'reviewStatus':'PENDING_PARENT_REVIEW',
        'sourceCommit':a.expected_commit,'checkout':str(dest.resolve()),'argv':argv,
        'datasetsRoot':str(pathlib.Path(a.datasets).resolve()),
        'evidenceRoot':str(pathlib.Path(a.datasets).resolve() / 'forecasting-cloud/full-app-plan/runs'),
        'pins':pins,'links':links,
        'excludedMutableRuntimeCaches':excluded_mutable,
        'nodeRuntimeClosure':runtime_closure,'browserRuntimeClosure':browser_closure,
        'productionArtifactLineage':artifact_lineage,
        'nonsecretEnv':{'MEMBRANE_CLOUD_ACCEPTANCE':'fixture'},
        'limitsAreSampledNotHardCgroupControls':True}
    content = json.dumps(spec, indent=2) + '\n'; digest = hashlib.sha256(content.encode()).hexdigest()
    path = dest.parent / ('proposed-' + a.kind + '-' + digest + '.spec.json')
    path.write_text(content); path.chmod(0o400)
    print(json.dumps({'status':'PREPARED_NOT_EXECUTED_PENDING_REVIEW','spec':str(path),'sha256':digest,'sourceCommit':a.expected_commit}))

if __name__ == '__main__': main()
