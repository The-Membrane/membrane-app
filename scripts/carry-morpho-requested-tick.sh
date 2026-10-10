#!/bin/sh
# Opt-in local Morpho requested-holder intake worker. Install plist only after review.
set -eu
if [ "${1-}" != '--tick' ]; then
  echo 'requested-native:usage' >&2
  exit 2
fi
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-morpho-requested.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('requested-native:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--tick', '--locked'])
PY
fi

cd "$(dirname "$0")/.."
umask 077
output_file=$(mktemp "${TMPDIR:-/private/tmp}/membrane-morpho-requested.XXXXXX")
error_file=$(mktemp "${TMPDIR:-/private/tmp}/membrane-morpho-requested-error.XXXXXX")
trap 'rm -f "$output_file" "$error_file"' EXIT HUP INT TERM
if /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 180s \
  /opt/homebrew/bin/node --max-old-space-size=384 --import tsx \
  scripts/research/carry-morpho-requested-native.mjs --tick >"$output_file" 2>"$error_file"; then
  # The child prints only counts; never forward unexpected raw output to LaunchAgent logs.
  /opt/homebrew/bin/node --input-type=module - "$output_file" <<'JS'
import { readFileSync, statSync } from 'node:fs'
try {
  const path = process.argv[2]
  if (statSync(path).size > 1024) throw Error('oversize')
  const result = JSON.parse(readFileSync(path, 'utf8'))
  const fields = ['queued', 'issued', 'scored', 'pending', 'intakeFailed']
  if (Object.keys(result).sort().join() !== 'forecastValidated,intakeFailed,issued,pending,queued,scored' ||
      result.forecastValidated !== false ||
      fields.some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 1024))
    throw Error('invalid')
  process.stdout.write(`requested-native:queued=${result.queued} issued=${result.issued} scored=${result.scored} pending=${result.pending} intake-failed=${result.intakeFailed}\n`)
} catch {
  process.stderr.write('requested-native:summary-invalid\n')
  process.exitCode = 1
}
JS
else
  echo 'requested-native:tick-failed' >&2
  exit 1
fi
