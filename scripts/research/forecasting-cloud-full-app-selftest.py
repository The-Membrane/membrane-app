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
else:
    raise SystemExit('unknown_finite_fixture')
