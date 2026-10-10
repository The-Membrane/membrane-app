#!/usr/bin/env python3
"""One guarded, bounded venue observation pass for the five enabled venues.

This is intentionally narrower than recorder-tick.sh. It records current
venue evidence and checks alarms; it does not run holder research or forecasts.
The LaunchAgent may be installed while disk is low; preflight keeps collectors
idle until the reserve is available.

One optional stage (2026-10-06, owner-approved) runs the net-APY tick
(scripts/record-net-apy.ts: IRM params, Merkl campaigns + end dates, change log).
It is optional: its result is recorded, but it never turns a complete venue pass
into a partial one.
"""

import fcntl
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / 'data/research/venue-signals'
NODE = '/opt/homebrew/bin/node'
LOCK_PATH = '/private/tmp/membrane-venue-observations.lock'
STATUS_PATH = Path('/private/tmp/membrane-venue-observations.status.json')
MIN_FREE_BYTES = 1024 * 1024 * 1024 + 256 * 1024 * 1024
TOTAL_SECONDS = 30 * 60
TERMINATION_GRACE_SECONDS = 5
HISTORICAL_MAX_SLOTS = 8
HISTORICAL_SECONDS = 900
HISTORICAL_ABSOLUTE_SECONDS = 1750
HISTORICAL_SLOT_SECONDS = 155
HISTORICAL_MAX_RPC_STARTS = 4096
HISTORICAL_SLOT_RPC_STARTS = 1024
HISTORICAL_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
HISTORICAL_MAX_RECORD_BYTES = 512 * 1024
HISTORICAL_ROOT = DATA_PATH / 'historical-depth-quotes'

# Importing the collector does not run its CLI. Print only these bounded fields;
# raw RPC evidence stays in the immutable archive, never the native status/log.
HISTORICAL_SUMMARY_CODE = """
import { runTick } from './scripts/research/carry-depth-quote-archive.mjs';
try {
  const r = await runTick();
  const has429 = (trace) => Array.isArray(trace) && trace.some((e) => e.transportError?.message === 'historical_depth_quote_http_429');
  const isInternal = (e) => {
    const q = e?.request, r = e?.response, error = r?.error;
    return q?.jsonrpc === '2.0' && Number.isSafeInteger(q.id) && q.id > 0 &&
      typeof q.method === 'string' && Array.isArray(q.params) &&
      JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['id', 'jsonrpc', 'method', 'params']) &&
      r?.jsonrpc === '2.0' && r.id === q.id &&
      JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['error', 'id', 'jsonrpc']) &&
      error?.code === -32603 && error.message === 'Internal error' &&
      JSON.stringify(Object.keys(error).sort()) === JSON.stringify(['code', 'message']);
  };
  const hasInternal = (trace) => Array.isArray(trace) && trace.some(isInternal);
  const throttled = r.reason === 'http_429' || r.captures?.some((c) => c.reason === 'http_429' || has429(c.rawRpcTrace)) || has429(r.evidence?.headerEvidence);
  const internal = r.reason === 'provider_rpc_internal_error' || r.captures?.some((c) => c.reason !== null && hasInternal(c.rawRpcTrace)) || hasInternal(r.evidence?.headerEvidence);
  console.log(JSON.stringify({
    status: r.status ?? (r.study === 'historical-depth-quote-anchor-failure-v1' ? 'anchor_failed' : 'collector_error'),
    reason: throttled ? 'http_429' : internal ? 'provider_rpc_internal_error' : r.reason ?? null,
    venue: r.venue ?? null,
    day: r.anchorDay ?? r.day ?? null,
    rpcStarts: r.rpcStarts ?? r.starts ?? r.evidence?.headerEvidence?.length ?? 0,
  }));
} catch (e) {
  const match = typeof e?.message === 'string' ? /^historical_depth_quote_([a-zA-Z0-9_:-]{1,160})$/.exec(e.message) : null;
  const reason = typeof e?.reason === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(e.reason)
    ? e.reason : match?.[1] ?? 'collector_failure';
  console.log(JSON.stringify({ status: 'collector_error', reason, venue: null, day: null, rpcStarts: null }));
  process.exitCode = 1;
}
"""


@dataclass(frozen=True)
class Stage:
    name: str
    script: str
    args: tuple
    timeout_seconds: int
    # Extra node flags (e.g. ('--import', 'tsx') for a .ts script).
    node_args: tuple = ()
    # Returns the checkout to run from; None runs from ROOT.
    code_root: object = None
    # Extra environment as ((key, value), ...).
    env: tuple = ()
    # An optional stage is recorded but does not decide complete/partial.
    optional: bool = False


# net-APY code (lib/netApy, scripts/record-net-apy.ts) reached evm-migration in
# a9a0b5b3. Until this checkout has it, run it from a detached worktree of
# origin/evm-migration (refresh: git -C <it> fetch origin && git -C <it>
# checkout --detach origin/evm-migration). Once ROOT has the script, ROOT wins.
NET_APY_RUNTIME = ROOT / '.claude/worktrees/recorder-runtime'
# Gitignored in every .gitignore version; kept beside the other venue signals.
NET_APY_STORE = ROOT / 'data/research/venue-signals/net-apy'


def net_apy_root():
    return ROOT if (ROOT / 'scripts/record-net-apy.ts').exists() else NET_APY_RUNTIME


# A completed interval is never fabricated after a failure or timeout. Each
# flow collector owns its cursor and records only ranges it actually sealed.
STAGES = (
    Stage('liquidity', 'record-venue-liquidity.mjs', ('--local',), 180),
    Stage('venue_flows_local', 'record-venue-flows.mjs', ('--local', '--chunk', '200'), 300),
    Stage('route_flow_susde', 'record-route-flows.mjs', ('--venue', 'sUSDe', '--chunk', '200', '--max-ranges-per-venue', '10'), 95),
    Stage('route_flow_susds', 'record-route-flows.mjs', ('--venue', 'sUSDS', '--chunk', '200', '--max-ranges-per-venue', '10'), 95),
    Stage('route_flow_scrvusd', 'record-route-flows.mjs', ('--venue', 'scrvUSD', '--chunk', '200', '--max-ranges-per-venue', '10'), 95),
    Stage('depth', 'record-depth-curves.mjs', ('--local',), 150),
    Stage('terms', 'watch-venue-terms.mjs', (), 150),
    Stage('news', 'fetch-venue-news.mjs', ('--local-only',), 150),
    Stage('alarms', 'check-venue-alarms.mjs', ('--record-only',), 120),
    Stage(
        'net_apy',
        'record-net-apy.ts',
        (),
        150,
        node_args=('--import', 'tsx'),
        code_root=net_apy_root,
        env=(('NET_APY_STORE_DIR', str(NET_APY_STORE)),),
        optional=True,
    ),
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def disk_free_bytes():
    disk = os.statvfs(DATA_PATH)
    return disk.f_bavail * disk.f_frsize


def disk_guard(free_bytes):
    return free_bytes >= MIN_FREE_BYTES


def write_status(payload):
    """Keep one small local status record; never append collector output."""
    encoded = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf8')
    if len(encoded) > 8192:
        raise ValueError('venue_observations_status_too_large')
    temporary = STATUS_PATH.with_name(STATUS_PATH.name + f'.{os.getpid()}.tmp')
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(encoded)
        os.replace(temporary, STATUS_PATH)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def acquire_lock():
    descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    file_stat = os.fstat(descriptor)
    if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError('venue_observations_lock_invalid')
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def stop_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=TERMINATION_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_stage(stage, deadline):
    seconds_remaining = deadline - time.monotonic()
    if seconds_remaining <= 0:
        return {'name': stage.name, 'status': 'total_runtime_bound'}
    budget = min(stage.timeout_seconds, seconds_remaining)
    started = time.monotonic()
    root = stage.code_root() if stage.code_root else ROOT
    command = [
        NODE,
        '--max-old-space-size=384',
        *stage.node_args,
        str(root / 'scripts' / stage.script),
        *stage.args,
    ]
    env = {**os.environ, **dict(stage.env)} if stage.env else None
    try:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        try:
            exit_code = process.wait(timeout=budget)
            status = 'ok' if exit_code == 0 else 'failed'
        except subprocess.TimeoutExpired:
            stop_process_group(process)
            exit_code = None
            status = 'timeout'
    except OSError:
        exit_code = None
        status = 'spawn_failed'
    return {
        'name': stage.name,
        'status': status,
        'exitCode': exit_code,
        'durationSeconds': round(time.monotonic() - started, 3),
        'optional': stage.optional,
    }


def historical_archive_bytes():
    """Fail closed on unusual files; never follow links or inspect evidence."""
    if not HISTORICAL_ROOT.exists():
        return 0
    total = 0
    entries = 0
    pending = [HISTORICAL_ROOT]
    while pending:
        path = pending.pop()
        entries += 1
        if entries > 10_000:
            raise ValueError('historical_archive_file_count')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            pending.extend(path.iterdir())
        elif stat.S_ISREG(info.st_mode):
            total += info.st_size
        else:
            raise ValueError('historical_archive_file_type')
    return total


def run_historical_slot(deadline, global_lock=None):
    if deadline - time.monotonic() < HISTORICAL_SLOT_SECONDS:
        return {'status': 'time_bound', 'rpcStarts': None}
    command = [NODE, '--max-old-space-size=384', '--input-type=module', '--eval', HISTORICAL_SUMMARY_CODE]
    try:
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, start_new_session=True, close_fds=True,
                                   pass_fds=() if global_lock is None else (global_lock,))
        try:
            output, _ = process.communicate(timeout=min(HISTORICAL_SLOT_SECONDS, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            stop_process_group(process)
            process.communicate()
            return {'status': 'timeout', 'rpcStarts': None}
    except OSError:
        return {'status': 'spawn_failed', 'rpcStarts': None}
    try:
        if len(output.encode('utf8')) > 4096:
            raise ValueError('historical_summary_size')
        data = json.loads(output)
        if not isinstance(data, dict) or set(data) != {'status', 'reason', 'venue', 'day', 'rpcStarts'}:
            raise ValueError('historical_summary_shape')
        if data['status'] not in ('verified', 'failed', 'anchor_sealed', 'anchor_failed', 'complete', 'partial', 'setup_failed', 'collector_error'):
            raise ValueError('historical_summary_status')
        reason = data['reason']
        if reason is not None and (not isinstance(reason, str) or not re.fullmatch(r'[a-zA-Z0-9_:-]{1,160}', reason)):
            raise ValueError('historical_summary_reason')
        if data['venue'] not in (None, 'sUSDe', 'sUSDS', 'scrvUSD'):
            raise ValueError('historical_summary_venue')
        if data['day'] is not None and (not isinstance(data['day'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\d', data['day'])):
            raise ValueError('historical_summary_day')
        starts = data['rpcStarts']
        if process.returncode != 0 or type(starts) is not int or not 0 <= starts <= HISTORICAL_SLOT_RPC_STARTS:
            return {'status': 'collector_error', 'reason': reason, 'rpcStarts': None}
        return data
    except (ValueError, TypeError):
        return {'status': 'invalid_summary', 'rpcStarts': None}


def run_historical_block(started, outer_deadline, global_lock=None):
    begin = time.monotonic()
    deadline = min(begin + HISTORICAL_SECONDS, started + HISTORICAL_ABSOLUTE_SECONDS, outer_deadline)
    result = {'name': 'historical_depth_archive', 'optional': True, 'status': 'slot_bound',
              'slots': [], 'rpcStarts': 0, 'durationSeconds': 0}
    while len(result['slots']) < HISTORICAL_MAX_SLOTS:
        if not disk_guard(disk_free_bytes()):
            result['status'] = 'disk_reserve'
            break
        if historical_archive_bytes() + 3 * HISTORICAL_MAX_RECORD_BYTES > HISTORICAL_MAX_ARCHIVE_BYTES:
            result['status'] = 'archive_byte_cap'
            break
        if deadline - time.monotonic() < HISTORICAL_SLOT_SECONDS:
            result['status'] = 'time_bound'
            break
        if HISTORICAL_MAX_RPC_STARTS - result['rpcStarts'] < HISTORICAL_SLOT_RPC_STARTS:
            result['status'] = 'rpc_start_bound'
            break
        slot = run_historical_slot(deadline, global_lock)
        result['slots'].append(slot)
        starts = slot.get('rpcStarts')
        if type(starts) is not int:
            result['status'] = slot['status']
            break
        result['rpcStarts'] += starts
        reason = slot.get('reason') or ''
        if slot['status'] in ('complete', 'partial', 'setup_failed', 'collector_error'):
            result['status'] = 'exhausted' if slot['status'] == 'partial' else slot['status']
            break
        if reason in ('http_429', 'provider_rpc_internal_error', 'deadline_elapsed', 'rpc_start_cap', 'provider_timeout', 'provider_unavailable', 'collector_failure') or any(
            marker in reason for marker in ('writer', 'ownership', 'disk', 'storage', 'archive_byte_cap', 'evidence_over_limit', 'record_size')
        ):
            result['status'] = reason
            break
        if starts == 0:
            result['status'] = 'no_progress'
            break
    result['durationSeconds'] = round(time.monotonic() - begin, 3)
    return result


def run_tick():
    started_at = utc_now()
    try:
        lock = acquire_lock()
    except BlockingIOError:
        print('venue-observations:already-running')
        return 0
    except (OSError, RuntimeError):
        print('venue-observations:lock-unavailable', file=sys.stderr)
        return 1

    try:
        free_bytes = disk_free_bytes()
        result = {
            'schema': 'venue-observations-tick-v1',
            'startedAtUtc': started_at,
            'completedAtUtc': None,
            'status': 'starting',
            'stages': [],
            'freeBytesAtStart': free_bytes,
            'requiredFreeBytes': MIN_FREE_BYTES,
        }
        if not disk_guard(free_bytes):
            result['status'] = 'disk_reserve'
            result['completedAtUtc'] = utc_now()
            write_status(result)
            print('venue-observations:disk-reserve')
            return 0

        # The lower priority is inherited by every child. Fail before any
        # collector if the requested priority cannot be established.
        os.nice(10)
        started = time.monotonic()
        deadline = started + TOTAL_SECONDS
        for stage in STAGES:
            if not disk_guard(disk_free_bytes()):
                result['status'] = 'disk_reserve_during_tick'
                break
            if time.monotonic() >= deadline:
                result['status'] = 'total_runtime_bound'
                break
            stage_result = run_stage(stage, deadline)
            result['stages'].append(stage_result)
            write_status(result)
            if stage_result['status'] == 'total_runtime_bound':
                result['status'] = 'total_runtime_bound'
                break

        if result['status'] == 'starting':
            try:
                historical = run_historical_block(started, deadline, lock)
            except (OSError, ValueError):
                historical = {'name': 'historical_depth_archive', 'optional': True, 'status': 'preflight_failed'}
            result['stages'].append(historical)

        if result['status'] == 'starting':
            result['status'] = (
                'complete'
                if all(stage['status'] == 'ok' for stage in result['stages'] if not stage.get('optional'))
                else 'partial'
            )
        result['completedAtUtc'] = utc_now()
        write_status(result)
        print('venue-observations:' + result['status'])
        return 0 if result['status'] in ('complete', 'disk_reserve') else 1
    except (OSError, ValueError):
        print('venue-observations:preflight-or-status-failed', file=sys.stderr)
        return 1
    finally:
        os.close(lock)


def main(argv):
    if argv == ['--check-guard']:
        free_bytes = disk_free_bytes()
        print(
            json.dumps(
                {
                    'status': 'ready' if disk_guard(free_bytes) else 'disk_reserve',
                    'freeBytes': free_bytes,
                    'requiredFreeBytes': MIN_FREE_BYTES,
                },
                sort_keys=True,
            )
        )
        return 0
    if argv:
        print('Usage: venue-observations-tick.py [--check-guard]', file=sys.stderr)
        return 2
    return run_tick()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
