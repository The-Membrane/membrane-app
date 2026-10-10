#!/bin/sh
# Bounded native capture of finalized direct-market gross supplier flow.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-direct-supplier-supply.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
except Exception:
    print('direct-supplier-supply:lock-unavailable', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
started_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
status_path=/private/tmp/membrane-direct-supplier-supply.status.json
if [ "${DIRECT_SUPPLY_TEST_MODE:-0}" = 1 ] && [ -n "${DIRECT_SUPPLY_TEST_STATUS_PATH:-}" ]; then
  status_path=$DIRECT_SUPPLY_TEST_STATUS_PATH
fi
disk_state=not_checked
post_disk_state=not_checked
supply_status=not_attempted
supply_exit_status=null
withdrawal_status=not_attempted
withdrawal_exit_status=null
tick_status=running

write_status() {
  completed_at=$1
  exit_status=$2
  /usr/bin/python3 - "$status_path" "$started_at" "$completed_at" "$exit_status" \
    "$tick_status" "$disk_state" "$post_disk_state" "$supply_status" \
    "$supply_exit_status" "$withdrawal_status" "$withdrawal_exit_status" <<'PY'
import json
import os
import re
import sys

(
    path,
    started_at,
    completed_at,
    exit_status,
    tick_status,
    disk_start,
    disk_after_supply,
    supply_status,
    supply_exit_status,
    withdrawal_status,
    withdrawal_exit_status,
) = sys.argv[1:]

stamp = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
disk_states = {'not_checked', 'blocked', 'supplemental', 'campaign', 'check_failed'}
supply_states = {'not_attempted', 'running', 'ok', 'failed'}
withdrawal_states = {
    'not_attempted',
    'running',
    'supplemental_ok',
    'other_capture_active',
    'supplemental_failed',
    'skipped_disk_reserve',
    'skipped_campaign_mode',
}
tick_states = {'running', 'complete', 'disk_reserve', 'failed'}

def parse_exit(value):
    if value == 'null':
        return None
    number = int(value)
    if number < 0 or number > 255:
        raise ValueError('invalid_exit_status')
    return number

if (
    not stamp.fullmatch(started_at)
    or (completed_at != 'null' and not stamp.fullmatch(completed_at))
    or tick_status not in tick_states
    or disk_start not in disk_states
    or disk_after_supply not in disk_states
    or supply_status not in supply_states
    or withdrawal_status not in withdrawal_states
):
    raise ValueError('invalid_direct_supply_status')

payload = {
    'schema': 'carry-direct-supplier-supply-tick-status-v1',
    'startedAtUtc': started_at,
    'completedAtUtc': None if completed_at == 'null' else completed_at,
    'status': tick_status,
    'exitStatus': parse_exit(exit_status),
    'disk': {'start': disk_start, 'afterSupply': disk_after_supply},
    'stages': {
        'supply': {'status': supply_status, 'exitStatus': parse_exit(supply_exit_status)},
        'withdrawal': {
            'status': withdrawal_status,
            'exitStatus': parse_exit(withdrawal_exit_status),
        },
    },
}
encoded = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode('utf8')
if len(encoded) > 4096:
    raise ValueError('direct_supply_status_too_large')
temporary = f'{path}.{os.getpid()}.tmp'
try:
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, 'wb') as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

finish() {
  final_exit=$1
  completed_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
  if ! write_status "$completed_at" "$final_exit"; then
    echo 'direct-supplier-supply:status-failed' >&2
    final_exit=1
  fi
  exit "$final_exit"
}

if ! write_status null null; then
  echo 'direct-supplier-supply:status-failed' >&2
  exit 1
fi

disk_status() {
  /usr/bin/python3 - <<'PY'
import os
import sys

try:
    space = os.statvfs('data/research/venue-signals')
    free_bytes = space.f_bavail * space.f_frsize
    if os.environ.get('DIRECT_SUPPLY_TEST_MODE') == '1':
        free_bytes = min(free_bytes, int(os.environ['DIRECT_SUPPLY_TEST_FREE_BYTES']))
    if free_bytes < 2 * 1024 ** 3:
        print('blocked')
    elif free_bytes < 3 * 1024 ** 3:
        print('supplemental')
    else:
        print('campaign')
except Exception:
    sys.exit(1)
PY
}
if disk_state=$(disk_status); then
  :
else
  disk_state=check_failed
  tick_status=failed
  echo 'direct-supplier-supply:disk-check-failed' >&2
  finish 1
fi
if [ "$disk_state" = blocked ]; then
  tick_status=disk_reserve
  echo 'direct-supplier-supply:disk-reserve' >&2
  finish 0
fi
if [ "$disk_state" != supplemental ] && [ "$disk_state" != campaign ]; then
  disk_state=check_failed
  tick_status=failed
  echo 'direct-supplier-supply:disk-check-failed' >&2
  finish 1
fi
node_bin=${DIRECT_SUPPLY_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${DIRECT_SUPPLY_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

# Credentials and receipt holder addresses must never enter persistent logs.
supply_status=running
if ! write_status null null; then
  echo 'direct-supplier-supply:status-failed' >&2
  exit 1
fi
if "$timeout_bin" -k 5s 240s "$node_bin" scripts/record-carry-direct-supplier-supply.mjs >/dev/null 2>&1; then
  supply_status=ok
  supply_exit_status=0
  echo 'direct-supplier-supply:tick-ok'
else
  supply_exit_status=$?
  supply_status=failed
  echo 'direct-supplier-supply:tick-failed' >&2
  supply_failed=1
fi
if ! write_status null null; then
  echo 'direct-supplier-supply:status-failed' >&2
  exit 1
fi

# The full holder campaign captures withdrawals above 3 GiB. Under its disk
# threshold, use the same native tick and the withdrawal recorder's own lock.
if post_disk_state=$(disk_status); then
  :
else
  post_disk_state=check_failed
  tick_status=failed
  echo 'direct-supplier-flow:disk-check-failed' >&2
  finish 1
fi
case "$post_disk_state" in
  supplemental)
    withdrawal_status=running
    if ! write_status null null; then
      echo 'direct-supplier-supply:status-failed' >&2
      exit 1
    fi
    if DIRECT_FLOW_SUPPLEMENTAL=1 DIRECT_FLOW_MAX_SEGMENTS_PER_MARKET_TICK=2 /bin/sh scripts/carry-direct-supplier-flow-tick.sh; then
      withdrawal_status=supplemental_ok
      withdrawal_exit_status=0
      echo 'direct-supplier-flow:supplemental-ok'
    else
      withdrawal_exit_status=$?
      if [ "$withdrawal_exit_status" -eq 75 ]; then
        withdrawal_status=other_capture_active
        echo 'direct-supplier-flow:other-capture-active'
      else
        withdrawal_status=supplemental_failed
        echo 'direct-supplier-flow:supplemental-failed' >&2
        flow_failed=1
      fi
    fi
    ;;
  blocked)
    withdrawal_status=skipped_disk_reserve
    echo 'direct-supplier-flow:disk-reserve' >&2
    ;;
  campaign)
    withdrawal_status=skipped_campaign_mode
    echo 'direct-supplier-flow:campaign-mode' >&2
    ;;
  *)
    post_disk_state=check_failed
    tick_status=failed
    echo 'direct-supplier-flow:disk-check-failed' >&2
    finish 1
    ;;
esac
if [ "${supply_failed:-0}" -eq 1 ] || [ "${flow_failed:-0}" -eq 1 ]; then
  tick_status=failed
  finish 1
fi
tick_status=complete
finish 0
