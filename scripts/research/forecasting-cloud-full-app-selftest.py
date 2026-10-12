#!/usr/bin/env python3
"""Finite fixtures only. Root reviewer coordinates execution through sealed launcher."""
import json, os, signal, sys, time

kind = sys.argv[1]
if kind == 'ordinary-exit':
    print(json.dumps({'fixture': kind, 'pid': os.getpid(), 'expectedLauncherStatus': 'PASS'}), flush=True)
elif kind == 'timeout':
    print(json.dumps({'fixture': kind, 'pid': os.getpid(), 'expectedLauncherReason': 'cooperative_deadline'}), flush=True)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(12) # Launcher selftest begins cleanup by 5 seconds; finite fallback.
elif kind == 'detached-child':
    first = os.fork()
    if first == 0:
        os.setsid()
        second = os.fork()
        if second == 0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            print(json.dumps({'fixture': kind, 'detachedPid': os.getpid(), 'parentPid': os.getppid(),
                'expectedLauncherReason': 'descendants_survived_root'}), flush=True)
            time.sleep(12)
            os._exit(0)
        os._exit(0)
    os.waitpid(first, 0)
    time.sleep(.1)
elif kind == 'pid-reuse-selector':
    import importlib.util, pathlib
    path = pathlib.Path(__file__).with_name('forecasting-cloud-full-app-launcher.py')
    spec = importlib.util.spec_from_file_location('full_app_selector', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    tracked = {10: 'root-old', 20: 'child-old', 40: 'known-live'}
    controlled = {10: {'parent': 99, 'birth': 'root-new'}, 20: {'parent': 99, 'birth': 'child-new'},
        30: {'parent': 20, 'birth': 'not-inherited'}, 40: {'parent': 1, 'birth': 'known-live'},
        50: {'parent': 40, 'birth': 'known-child'}, 60: {'parent': 99, 'birth': 'adopted'},
        70: {'parent': 99, 'birth': 'ordinary-baseline'}}
    selected, violations = module.select_owned_rows(controlled, tracked, 10, 'root-old', 99, {70: 'ordinary-baseline'})
    assert set(selected) == {40, 50, 60}
    assert tracked[10] == 'root-old' and tracked[20] == 'child-old'
    assert set(v['pid'] for v in violations) == {10, 20}
    assert 30 not in tracked and 70 not in tracked
    original = {10: 'root-old', 20: 'child-old', 40: 'known-live', 50: 'known-child', 60: 'adopted'}
    assert tracked == original
    selected, violations = module.select_owned_rows({10: controlled[10]}, {}, 10, 'root-old', 99, {})
    assert selected == {} and violations[0]['pid'] == 10
    print(json.dumps({'fixture': kind, 'expectedLauncherStatus': 'PASS',
        'syntheticReuseExcluded': True, 'originalBirthsUnchanged': True,
        'unknownDescendantDidNotInherit': True, 'ordinaryBaselineUntouched': True}), flush=True)
else:
    raise SystemExit('unknown_finite_fixture')
