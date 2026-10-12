#!/usr/bin/env python3
"""Prepare immutable source copy and proposed seals only; never runs an app job."""
import argparse, hashlib, io, json, pathlib, subprocess, tarfile

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(262144), b''): h.update(b)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--source', required=True)
    parser.add_argument('--expected-commit', required=True); parser.add_argument('--datasets', required=True)
    parser.add_argument('--destination', required=True); parser.add_argument('--kind', required=True)
    parser.add_argument('--argv-json', required=True); parser.add_argument('--data-pins-json', required=True)
    a = parser.parse_args(); source = pathlib.Path(a.source).resolve(); dest = pathlib.Path(a.destination)
    def git(*args): return subprocess.check_output(['git', *args], cwd=source, text=True).strip()
    if git('rev-parse', 'HEAD') != a.expected_commit or git('status', '--porcelain'):
        raise RuntimeError('final_source_not_clean_exact_commit')
    if dest.exists(): raise RuntimeError('destination_must_be_new_no_overwrite')
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
        dest.mkdir(parents=True, mode=0o700)
        tar.extractall(dest, filter='data')
    dependencies = (source / 'node_modules').resolve()
    (dest / 'node_modules').symlink_to(dependencies, target_is_directory=True)
    pins = {str(p.resolve()): sha(p) for p in dest.rglob('*') if p.is_file() and not p.is_symlink()}
    links = {str(dest / 'node_modules'): str(dependencies)}
    # Existing installed graph is sealed in place, never duplicated or installed.
    for p in dependencies.rglob('*'):
        if p.is_symlink(): links[str(p)] = str(p.resolve())
        elif p.is_file(): pins[str(p.resolve())] = sha(p)
    for p, digest in json.loads(pathlib.Path(a.data_pins_json).read_text()).items():
        if sha(p) != digest: raise RuntimeError('dataset_pin_mismatch')
        pins[str(pathlib.Path(p).resolve())] = digest
    argv = json.loads(a.argv_json)
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) for v in argv): raise RuntimeError('argv_invalid')
    if not pathlib.Path(argv[0]).is_absolute(): raise RuntimeError('absolute_executable_required')
    pins[str(pathlib.Path(argv[0]).resolve())] = sha(argv[0])
    launcher = source / 'scripts/research/forecasting-cloud-full-app-launcher.py'
    pins[str(launcher.resolve())] = sha(launcher)
    guard = source / 'scripts/research/forecasting-cloud-full-app-node-guard.cjs'
    pins[str(guard.resolve())] = sha(guard)
    spec = {'schema':'cloud-full-app-reviewed-launcher-v1','kind':a.kind,'reviewStatus':'PENDING_PARENT_REVIEW',
        'sourceCommit':a.expected_commit,'checkout':str(dest.resolve()),'argv':argv,
        'datasetsRoot':str(pathlib.Path(a.datasets).resolve()),
        'evidenceRoot':str(pathlib.Path(a.datasets).resolve() / 'forecasting-cloud/full-app-plan/runs'),
        'pins':pins,'links':links,
        'limitsAreSampledNotHardCgroupControls':True}
    content = json.dumps(spec, indent=2) + '\n'; digest = hashlib.sha256(content.encode()).hexdigest()
    path = dest.parent / ('proposed-' + a.kind + '-' + digest + '.spec.json')
    path.write_text(content); path.chmod(0o400)
    print(json.dumps({'status':'PREPARED_NOT_EXECUTED_PENDING_REVIEW','spec':str(path),'sha256':digest,'sourceCommit':a.expected_commit}))

if __name__ == '__main__': main()
