#!/usr/bin/env python3
"""Separate reviewed Cloud proposal. Sampled limits, no hard cgroup/swap control."""
import argparse, ctypes, fcntl, hashlib, json, os, pathlib, signal, socket, subprocess, time

MIB = 1024 ** 2
CG = pathlib.Path('/sys/fs/cgroup')
DEADLINES = {'selftest': 20, 'full-typecheck': 360, 'production-build': 720,
             'bounded-http': 150, 'chromium-browser': 360}

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(262144), b''): h.update(block)
    return h.hexdigest()

def cgroup():
    return {key: int((CG / key).read_text()) for key in ['memory.current', 'memory.max', 'memory.swap.current']}

def rows():
    result = {}
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            st = (p / 'stat').read_text().rsplit(')', 1)[1].split()
            result[int(p.name)] = {'parent': int(st[1]), 'group': int(st[2]),
                'birth': st[19], 'rss': int(st[21]) * os.sysconf('SC_PAGE_SIZE'),
                'threads': int(st[17]), 'zombie': st[0] == 'Z'}
        except (OSError, ValueError, IndexError): pass
    return result

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--spec', required=True); parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    if sha(args.spec) != args.sha256: raise RuntimeError('spec_hash_mismatch')
    spec = json.loads(pathlib.Path(args.spec).read_text()); kind = spec['kind']
    if kind not in DEADLINES or spec['schema'] != 'cloud-full-app-reviewed-launcher-v1': raise RuntimeError('spec_schema')
    required = 'parent-reviewed-selftest-only' if kind == 'selftest' else 'parent-reviewed-full-app'
    if spec.get('reviewStatus') != required: raise RuntimeError('parent_review_required')
    root = pathlib.Path(spec['evidenceRoot']); root.mkdir(parents=True, exist_ok=True)
    shared = pathlib.Path(spec['datasetsRoot']) / 'forecasting-cloud/linux-recovery/gate.lock'
    with open(shared, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = time.monotonic(); deadline = started + DEADLINES[kind]
        run = root / (kind + '-' + str(time.time_ns())); run.mkdir(mode=0o700)
        tracked = {}; child = None; reason = None; exit_code = None; before_pins = False; after_pins = False
        peak_rss = peak_threads = peak_processes = peak_cgroup = peak_swap_growth = 0
        initial_cgroup = None; subreaper = False; signals = []; disk_start = None; root_birth = None; env_keys = []
        baseline_children = {p: v['birth'] for p, v in rows().items() if v['parent'] == os.getpid()}
        affinity = sorted(os.sched_getaffinity(0))[:2]
        def free():
            s = os.statvfs(run); return s.f_bavail * s.f_frsize
        def pins():
            if not spec['pins'] or str(pathlib.Path(__file__).resolve()) not in spec['pins']: raise RuntimeError('launcher_not_sealed')
            for p, digest in spec['pins'].items():
                if time.monotonic() >= deadline - 15: raise RuntimeError('pin_deadline')
                if sha(p) != digest: raise RuntimeError('pin_drift:' + p)
            for p, target in spec['links'].items():
                if str(pathlib.Path(p).resolve()) != target: raise RuntimeError('symlink_drift')
        def inventory():
            all_rows = rows()
            live = {p for p, v in all_rows.items() if tracked.get(p) == v['birth']}
            if child and child.pid in all_rows and all_rows[child.pid]['birth'] == root_birth: live.add(child.pid)
            # Subreaper-adopted grandchildren remain ours even after setsid/double fork.
            live |= {p for p, v in all_rows.items() if v['parent'] == os.getpid() and baseline_children.get(p) != v['birth']}
            while True:
                more = live | {p for p, v in all_rows.items() if v['parent'] in live}
                if more == live: break
                live = more
            for p in live: tracked[p] = all_rows[p]['birth']
            return {p: all_rows[p] for p in live}
        def active(): return {p: v for p, v in inventory().items() if not v['zombie']}
        def reap():
            # Do not reap subprocess root before Popen has consumed its status.
            if child: child.poll()
            for p, v in inventory().items():
                if v['zombie'] and (not child or p != child.pid):
                    try: os.waitpid(p, os.WNOHANG)
                    except (ChildProcessError, ProcessLookupError): pass
        def signal_owned(sig):
            current = active()
            for p, v in current.items():
                # Re-read birth immediately before signalling, never signal a reused PID.
                try:
                    st = (pathlib.Path('/proc') / str(p) / 'stat').read_text().rsplit(')', 1)[1].split()
                    if st[19] == v['birth']: os.kill(p, sig); signals.append({'pid': p, 'birth': v['birth'], 'signal': sig})
                except (OSError, ProcessLookupError): pass
        try:
            if len(affinity) != 2: raise RuntimeError('two_cpu_affinity_unavailable')
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(36, 1, 0, 0, 0) != 0: raise RuntimeError('subreaper_unavailable')
            verified = ctypes.c_int(0)
            if libc.prctl(37, ctypes.byref(verified), 0, 0, 0) != 0 or verified.value != 1:
                raise RuntimeError('subreaper_verification_failed')
            subreaper = True
            initial_cgroup = cgroup()
            if initial_cgroup['memory.max'] - initial_cgroup['memory.current'] < 8192 * MIB: raise RuntimeError('initial_memory_headroom')
            if free() < 8192 * MIB: raise RuntimeError('disk_start_floor')
            disk_start = free()
            pins(); before_pins = True
            if kind in ['bounded-http', 'chromium-browser']:
                try:
                    with socket.create_connection(('127.0.0.1', 3005), timeout=.25):
                        raise RuntimeError('server_port_already_in_use')
                except ConnectionRefusedError: pass
            guard = str(pathlib.Path(__file__).with_name('forecasting-cloud-full-app-node-guard.cjs').resolve())
            if kind != 'selftest' and guard not in spec['pins']: raise RuntimeError('node_guard_not_sealed')
            node_options = '--max-old-space-size=2304 --max-semi-space-size=16 --require=' + guard
            env = {'PATH': str(pathlib.Path(spec['argv'][0]).parent) + ':/usr/bin:/bin', 'HOME': str(run), 'TMPDIR': str(run),
                'MEMBRANE_DATASETS_DIR': spec['datasetsRoot'], 'NODE_OPTIONS': node_options, 'CI': '1',
                'NEXT_TELEMETRY_DISABLED': '1', 'NO_COLOR': '1'}
            additions = spec.get('nonsecretEnv', {})
            if not isinstance(additions, dict) or any(k not in ['MEMBRANE_CLOUD_ACCEPTANCE', 'MEMBRANE_CLOUD_BROWSER_OUTPUT'] for k in additions):
                raise RuntimeError('nonsecret_env_not_allowlisted')
            if 'MEMBRANE_CLOUD_ACCEPTANCE' in additions and additions['MEMBRANE_CLOUD_ACCEPTANCE'] != '1':
                raise RuntimeError('nonsecret_acceptance_value_invalid')
            if 'MEMBRANE_CLOUD_BROWSER_OUTPUT' in additions:
                output = additions['MEMBRANE_CLOUD_BROWSER_OUTPUT']
                if not isinstance(output, str) or not pathlib.Path(output).is_absolute() or not pathlib.Path(output).resolve().is_relative_to(root.resolve()):
                    raise RuntimeError('browser_output_outside_evidence_root')
            env.update(additions)
            env_keys = sorted(additions)
            if kind != 'selftest': env.update(NODE_ENV='production', PLAYWRIGHT_BASE_URL='http://127.0.0.1:3005')
            def setup_child(): os.sched_setaffinity(0, affinity)
            with open(run / 'stdout.log', 'wb') as out, open(run / 'stderr.log', 'wb') as err:
                child = subprocess.Popen(spec['argv'], cwd=spec['checkout'], env=env, start_new_session=True,
                    preexec_fn=setup_child, stdout=out, stderr=err)
                # An exited root remains a zombie until poll/wait and retains its identity.
                # Capture birth before either operation; never attribute a reused PID.
                root_birth = rows().get(child.pid, {}).get('birth')
                if root_birth is None: raise RuntimeError('root_birth_unavailable')
                tracked[child.pid] = root_birth
                while True:
                    child.poll(); live = active(); rss = sum(v['rss'] for v in live.values())
                    threads = sum(v['threads'] for v in live.values()); current = cgroup()
                    peak_rss = max(peak_rss, rss); peak_processes = max(peak_processes, len(live)); peak_threads = max(peak_threads, threads)
                    peak_cgroup = max(peak_cgroup, current['memory.current'])
                    swap_growth = max(0, current['memory.swap.current'] - initial_cgroup['memory.swap.current'])
                    peak_swap_growth = max(peak_swap_growth, swap_growth)
                    if rss > 4096 * MIB: raise RuntimeError('sampled_aggregate_rss_limit')
                    if len(live) > 96: raise RuntimeError('process_count_limit')
                    for pid in live:
                        try:
                            if not os.sched_getaffinity(pid).issubset(set(affinity)): raise RuntimeError('descendant_cpu_affinity_changed')
                            exe = pathlib.Path(os.readlink('/proc/' + str(pid) + '/exe')).name
                            if exe == 'node':
                                environment = pathlib.Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0')
                                options = next((v.split(b'=', 1)[1] for v in environment if v.startswith(b'NODE_OPTIONS=')), b'')
                                if options != node_options.encode(): raise RuntimeError('node_guard_or_heap_env_changed')
                                cmd = pathlib.Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
                                for index, arg in enumerate(cmd):
                                    text = arg.decode(errors='replace')
                                    if text.startswith(('--max-old-space-size=', '--max_old_space_size=')) and int(text.split('=', 1)[1]) > 2304:
                                        raise RuntimeError('node_cli_heap_override')
                                    if text in ['--max-old-space-size', '--max_old_space_size'] and int(cmd[index + 1]) > 2304:
                                        raise RuntimeError('node_cli_heap_override')
                        except (FileNotFoundError, ProcessLookupError): pass
                    if swap_growth > 256 * MIB: raise RuntimeError('parent_cgroup_swap_growth_limit')
                    remaining_budget = max(0, 4096 * MIB - rss)
                    if current['memory.max'] - current['memory.current'] < 4096 * MIB + remaining_budget:
                        raise RuntimeError('parent_cgroup_memory_reserve')
                    if free() < 4096 * MIB: raise RuntimeError('disk_reserve')
                    if disk_start - free() > 4096 * MIB: raise RuntimeError('shared_disk_growth_budget')
                    if out.tell() + err.tell() > 16 * MIB: raise RuntimeError('log_limit')
                    if time.monotonic() >= deadline - 15: raise RuntimeError('cooperative_deadline')
                    if child.returncode is not None:
                        exit_code = child.returncode
                        if live: raise RuntimeError('descendants_survived_root')
                        break
                    time.sleep(.05)
            pins(); after_pins = True
            if exit_code != 0: raise RuntimeError('command_failure')
        except Exception as error: reason = str(error)
        finally:
            try:
                if child:
                    signal_owned(signal.SIGTERM)
                    until = min(deadline - 2, time.monotonic() + 2)
                    while active() and time.monotonic() < until: reap(); time.sleep(.05)
                    signal_owned(signal.SIGKILL)
                    until = max(time.monotonic() + .5, deadline - .5)
                    while active() and time.monotonic() < until: reap(); time.sleep(.05)
                    try: child.wait(timeout=.5)
                    except Exception as error: reason = reason or 'root_cleanup_failed:' + type(error).__name__
                    reap()
            except Exception as error:
                reason = reason or 'cleanup_exception:' + type(error).__name__
            try: survivors = active() if child else {}
            except Exception as error:
                reason = reason or 'cleanup_inventory_failed:' + type(error).__name__
                survivors = {-1: {'birth': 'UNKNOWN_CLEANUP_NOT_PROVEN'}}
            port_closed = None
            if kind in ['bounded-http', 'chromium-browser']:
                try:
                    with socket.create_connection(('127.0.0.1', 3005), timeout=.25): port_closed = False
                except ConnectionRefusedError: port_closed = True
                except OSError: port_closed = False
                if not port_closed: reason = reason or 'server_listener_survived'
            proof = {'schema': 'cloud-full-app-launcher-proof-v1', 'status': 'PASS' if reason is None and not survivors else 'FAIL',
                'reason': reason, 'kind': kind, 'specSha256': args.sha256, 'argv': spec['argv'], 'exitCode': exit_code,
                'pinsCheckedBefore': before_pins, 'pinsCheckedAfter': after_pins, 'elapsedSeconds': time.monotonic() - started,
                'peakAggregateRssBytes': peak_rss, 'peakProcesses': peak_processes, 'peakThreadsObservedSeparately': peak_threads,
                'initialCgroup': initial_cgroup, 'peakParentCgroupMemoryBytes': peak_cgroup, 'peakParentCgroupSwapGrowthBytes': peak_swap_growth,
                'cpuAffinity': affinity, 'subreaperEnabled': subreaper, 'trackedPidBirths': tracked,
                'rootPidBirth': root_birth, 'reviewedNonsecretEnvKeys': env_keys,
                'cleanupSignals': signals, 'survivingPidBirths': {p: v['birth'] for p, v in survivors.items()},
                'allDescendantsClean': not survivors, 'diskAvailableBytes': free(),
                'serverPort3005Closed': port_closed,
                'enforcement': {'aggregateRss': 'sampled_50ms_transient_overshoot_possible', 'memoryAndSwapHardControls': False,
                    'parentCgroupSharedWithOrdinaryServices': True, 'cpu': 'inherited_two_core_affinity_not_hard_cpu_quota',
                    'network': 'existing_environment_allowlist_unchanged_no_new_kernel_denial'},
                'limits': {'aggregateRssMiB': 4096, 'nodeOldSpaceMiB': 2304, 'swapGrowthMiB': 256, 'maxProcesses': 96,
                    'diskStartMiB': 8192, 'diskReserveMiB': 4096, 'logMiB': 16, 'deadlineSeconds': DEADLINES[kind], 'cleanupReserveSeconds': 15},
                'logs': {p.name: sha(p) for p in run.glob('*.log')}}
            (run / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n'); print(json.dumps({'run': str(run), **proof}))
            return 0 if proof['status'] == 'PASS' else 1

if __name__ == '__main__': raise SystemExit(main())
