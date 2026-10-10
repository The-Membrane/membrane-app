#!/bin/sh
# Hourly public-chain-only direct-market withdrawal evidence continuation.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-direct-supplier-flow.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
except BlockingIOError:
    print('direct-supplier-flow:lock-unavailable', file=sys.stderr, flush=True)
    sys.exit(75 if os.environ.get('DIRECT_FLOW_SUPPLEMENTAL') == '1' else 1)
except Exception:
    print('direct-supplier-flow:lock-unavailable', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${DIRECT_FLOW_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${DIRECT_FLOW_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

# Finish before the higher-priority cash issue tick at :10. A slow RPC may
# reduce this tick's progress; the next hourly run resumes sealed segments.
# Provider output may carry URL credentials and holder data. A private FIFO
# stores no bytes if launchd kills this process; a strict reader emits only
# the recorder's fixed diagnostic schema.
diagnostic_dir=$(/usr/bin/mktemp -d "${TMPDIR:-/private/tmp}/membrane-direct-flow.XXXXXX") || exit 1
diagnostic_pipe="$diagnostic_dir/status"
cleanup() {
  /bin/rm -f "$diagnostic_pipe"
  /bin/rmdir "$diagnostic_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
/usr/bin/mkfifo -m 600 "$diagnostic_pipe" || exit 1
/usr/bin/awk -F: '
  length($0) > 200 { next }
  $1 == "direct_supplier_flow_target" && NF == 3 &&
    $2 ~ /^[0-9]+$/ && length($2) <= 12 &&
    $3 ~ /^[0-9]+$/ && length($3) <= 2 { print; next }
  $1 == "direct_supplier_flow_market" && NF == 9 &&
    ($2 == "aaveV3Usde" || $2 == "aaveV3Usdc" || $2 == "sparkLendUsdt" || $2 == "compoundV3Usdc") &&
    ($3 == "complete" || $3 == "budget_reached" || $3 == "failed") &&
    ($4 == "done" || $4 == "start" || $4 == "backfill") &&
    $5 ~ /^[0-9]+$/ && length($5) <= 12 &&
    $6 ~ /^[0-9]+$/ && length($6) <= 3 &&
    ($7 == "none" || $7 == "direct_unknown_failure" || $7 == "direct_segment_unavailable" || $7 == "direct_source_disagreement" || $7 == "direct_resume_gap" || $7 == "direct_resume_overlap" || $7 == "direct_resume_range_mismatch" || $7 == "direct_segment_too_large" || $7 == "direct_disk_reserve" || $7 == "direct_stage_cleanup_failed" || $7 == "invalid_direct_segment_json" || $7 == "invalid_direct_output_directory") &&
    ($8 == "none" || $8 == "timeout" || $8 == "socket_closed" || $8 == "http_401" || $8 == "http_403" || $8 == "http_408" || $8 == "http_429" || $8 == "http_500" || $8 == "http_502" || $8 == "http_503" || $8 == "http_504" || $8 == "http_other" || $8 == "rpc_rate_limited" || $8 == "rpc_origin_unavailable" || $8 == "rpc_other" || $8 == "source_or_proof") &&
    ($9 == "0" || $9 == "1") { print; next }
  $1 == "direct_supplier_flow_tick_failed" && NF == 2 &&
    ($2 == "direct_unknown_failure" || $2 == "two_distinct_direct_rpc_origins_required" || $2 == "two_healthy_direct_rpc_origins_required" || $2 == "direct_finalized_target_disagreement" || $2 == "direct_finalized_target_stale") { print; next }
' "$diagnostic_pipe" &
filter_pid=$!
if DIRECT_FLOW_DIAGNOSTIC=1 "$timeout_bin" -k 5s 240s "$node_bin" --max-old-space-size=384 scripts/record-carry-direct-supplier-flow.mjs >"$diagnostic_pipe" 2>&1; then
  wait "$filter_pid"
  echo 'direct-supplier-flow:tick-ok'
else
  wait "$filter_pid"
  echo 'direct-supplier-flow:tick-failed' >&2
  exit 1
fi
