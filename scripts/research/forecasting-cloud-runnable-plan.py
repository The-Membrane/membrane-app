#!/usr/bin/env python3
"""Prepare concrete seals/commands only. Never starts typecheck/build/server/browser."""
import argparse, fcntl, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys
sys.dont_write_bytecode = True

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(262144), b''): h.update(b)
    return h.hexdigest()

def save(directory, stem, value):
    body = json.dumps(value, indent=2) + '\n'; digest = hashlib.sha256(body.encode()).hexdigest()
    path = directory / (stem + '.' + digest + '.json')
    if path.exists() and path.read_text() != body: raise RuntimeError('immutable_manifest_collision')
    path.write_text(body); path.chmod(0o400)
    return path, digest

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['prebuild','postbuild'])
    parser.add_argument('--source', required=True); parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--datasets', required=True); parser.add_argument('--snapshot', required=True)
    parser.add_argument('--data-pins', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--build-proof'); parser.add_argument('--build-spec')
    a = parser.parse_args(); source = pathlib.Path(a.source).resolve(); snapshot = pathlib.Path(a.snapshot).resolve()
    datasets = pathlib.Path(a.datasets).resolve(); output = pathlib.Path(a.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if subprocess.check_output(['git','rev-parse','HEAD'], cwd=source, text=True).strip() != a.expected_commit:
        raise RuntimeError('reviewed_source_commit_mismatch')
    if subprocess.check_output(['git','status','--porcelain'], cwd=source, text=True).strip():
        raise RuntimeError('reviewed_source_not_clean')
    helper = source / 'scripts/research/forecasting-cloud-full-app-prepare.py'
    python = str(pathlib.Path(sys.executable).resolve()); node = str(pathlib.Path(shutil.which('node')).resolve())
    module_spec = importlib.util.spec_from_file_location('reviewed_prepare', helper)
    module = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(module)
    def prepare(kind, argv, reuse=False):
        command = [python,str(helper),'--source',str(source),'--expected-commit',a.expected_commit,
            '--datasets',str(datasets),'--destination',str(snapshot),'--kind',kind,'--argv-json',json.dumps(argv),
            '--data-pins-json',str(pathlib.Path(a.data_pins).resolve())]
        if reuse: command.append('--reuse-snapshot')
        if kind in ['bounded-http','chromium-browser']:
            if not a.build_proof or not a.build_spec: raise RuntimeError('actual_accepted_build_required')
            command += ['--build-proof',a.build_proof,'--build-spec',a.build_spec]
        env = {'PATH':str(pathlib.Path(node).parent)+':/usr/bin:/bin','HOME':str(output),'TMPDIR':str(output),
            'PYTHONDONTWRITEBYTECODE':'1'}
        result = subprocess.run(command, check=True, capture_output=True, text=True, env=env, timeout=240)
        return json.loads(result.stdout)
    lock_path = datasets / 'forecasting-cloud/linux-recovery/gate.lock'
    with open(lock_path,'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stat = os.statvfs(output)
        if stat.f_bavail * stat.f_frsize < 8192 * 1024 ** 2: raise RuntimeError('preparation_disk_start_floor')
        proposals = []
        if a.action == 'prebuild':
            ts = str((source / 'node_modules/typescript/bin/tsc').resolve())
            nxt = str((source / 'node_modules/next/dist/bin/next').resolve())
            first = prepare('full-typecheck',[node,'--max-old-space-size=2304','--max-semi-space-size=16',ts,
                '--noEmit','--incremental','false','--pretty','false'])
            proposals.append(first)
            # Same immutable source/dependency/data/Node closure for build: hash once,
            # retain a distinct exact-argv spec rather than duplicate source or cache.
            build = json.loads(pathlib.Path(first['spec']).read_text())
            build.update(kind='production-build',argv=[node,'--max-old-space-size=2304','--max-semi-space-size=16',nxt,'build'])
            path,digest = save(snapshot.parent,'proposed-production-build',build)
            proposals.append({'spec':str(path),'sha256':digest,'status':'PREPARED_NOT_EXECUTED_PENDING_REVIEW'})
            pins,links = {},{}
            for tree in ['/usr/lib/chromium','/usr/share/fonts','/etc/fonts','/var/cache/fontconfig']:
                module.seal_tree(tree,pins,links)
            pins['/usr/bin/chromium'] = sha('/usr/bin/chromium')
            elf = []
            for p in pathlib.Path('/usr/lib/chromium').rglob('*'):
                if p.is_file():
                    with open(p,'rb') as f:
                        if f.read(4) == b'\x7fELF': elf.append(p)
            closure = module.seal_runtime_closure(elf,pins,links)
            browser_manifest,digest = save(output,'browser-prebuild-closure',{
                'schema':'installed-browser-prebuild-seal-v1','sourceCommit':a.expected_commit,
                'pins':pins,'links':links,'elfRuntimeClosure':closure,'browserStarted':False,
                'qualification':'installed resource and loader metadata only; runtime and build unqualified'})
            browser_inventory = {'path':str(browser_manifest),'sha256':digest}
        else:
            stage = str(snapshot / 'scripts/research/forecasting-cloud-server-stage.mjs')
            for kind,mode in [('bounded-http','http'),('chromium-browser','browser')]:
                proposals.append(prepare(kind,[node,'--max-old-space-size=2304','--max-semi-space-size=16',stage,mode],True))
            browser_inventory = None
        review = {'schema':'concrete-cloud-full-app-runnable-plan-v1','status':'PREPARED_COMMANDS_NOT_EXECUTED',
            'action':a.action,'sourceCommit':a.expected_commit,'source':str(source),'sharedSnapshot':str(snapshot),
            'orchestratorSha256':sha(__file__),'preparerSha256':sha(helper),'dataPinsSha256':sha(a.data_pins),
            'proposals':proposals,'browserPrebuildInventory':browser_inventory,
            'reviewRequired':'Exact candidate specs remain pending. Parent must review and copy with reviewStatus parent-reviewed-full-app; reseal copied spec. This tool grants no broad execution authority.',
            'launchCommandsAfterReview':[{'argv':[python,str(source/'scripts/research/forecasting-cloud-full-app-launcher.py'),
                '--spec','<reviewed-copy-of-'+pathlib.Path(p['spec']).name+'>','--sha256','<sha256-of-reviewed-copy>'],
                'oneJobAtATime':True} for p in proposals],
            'postbuildRequirements':'Actual production-build PASS proof/spec lineage, pins before/after, descendant cleanup and BUILD_ID mandatory. HTTP/browser spec seals are deterministically produced only after that actual build.'}
        path,digest = save(output,'concrete-'+a.action+'-plan',review)
        print(json.dumps({'manifest':str(path),'sha256':digest,**review}))

if __name__ == '__main__': main()
