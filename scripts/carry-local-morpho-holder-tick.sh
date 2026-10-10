#!/bin/sh
# Local public RPC prospective Morpho exact-holder issue/score; no Neon.
set -u
mode=${1-}
if [ "$mode" != issue ] && [ "$mode" != issue-missing-api ] && [ "$mode" != score ] && [ "$mode" != v2score ]; then
  echo 'carry-local-morpho-holder:invalid-mode' >&2
  exit 2
fi
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

lock_mode = 'issue' if sys.argv[2] in ('issue', 'issue-missing-api') else sys.argv[2]
path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                    'membrane-carry-local-morpho-holder-' + lock_mode + '.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-local-morpho-holder:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
if [ "$mode" = issue-missing-api ]; then
  disk_status=$(/usr/bin/python3 - "$PWD" <<'PY'
import os
import sys

disk = os.statvfs(sys.argv[1])
free = disk.f_bavail * disk.f_frsize
print('ok' if free >= 3 * 1024 ** 3 else 'low')
PY
  ) || exit 1
  if [ "$disk_status" = low ]; then
    echo 'carry-local-morpho-holder:issue-missing-api disk-reserve-skip'
    exit 0
  fi
  [ "$disk_status" = ok ] || exit 1
fi
node_bin=${MORPHO_HOLDER_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${MORPHO_HOLDER_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
if [ "$mode" = issue ] || [ "$mode" = issue-missing-api ]; then
  max_seconds=510
  module=scripts/research/carry-local-morpho-holder-v2.mjs
  if [ "$mode" = issue-missing-api ]; then
    argument=--issue-missing-api
  else
    argument=--issue
  fi
elif [ "$mode" = v2score ]; then
  max_seconds=240
  module=scripts/research/carry-local-morpho-holder-v2.mjs
  argument=--score
else
  max_seconds=240
  module=scripts/research/carry-local-morpho-holder.mjs
  argument=--score
fi

# The child may include RPC secrets in an unexpected error. Capture privately,
# emit only the validated fixed-schema score aggregate, and remove the capture.
umask 077
output_file=$(mktemp "${TMPDIR:-/private/tmp}/membrane-morpho-holder-tick.XXXXXX") || exit 1
trap 'rm -f "$output_file"' EXIT HUP INT TERM
if [ "$mode" = issue-missing-api ]; then
  set -- --import tsx
else
  set --
fi
if "$timeout_bin" -k 10s "${max_seconds}s" "$node_bin" --max-old-space-size=384 \
  "$@" "$module" "$argument" >"$output_file" 2>&1; then
  if [ "$mode" = v2score ]; then
    if ! "$node_bin" --max-old-space-size=384 --input-type=module - "$output_file" <<'JS'
import { readFileSync, statSync } from 'node:fs'
import { formatV2ScoreTickSummary } from './scripts/research/carry-local-morpho-holder-v2.mjs'

try {
  const path = process.argv[2]
  if (statSync(path).size > 8192) throw Error('oversize')
  process.stdout.write(`${formatV2ScoreTickSummary(JSON.parse(readFileSync(path, 'utf8')))}\n`)
} catch {
  process.stderr.write('carry-local-morpho-holder:v2score failed (summary_invalid)\n')
  process.exitCode = 1
}
JS
    then
      exit 1
    fi
  else
    echo "carry-local-morpho-holder:$mode ok"
  fi
else
  status=$?
  echo "carry-local-morpho-holder:$mode failed (exit $status)" >&2
  exit 1
fi
