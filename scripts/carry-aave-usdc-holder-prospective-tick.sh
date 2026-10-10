#!/bin/sh
# One bounded local holder issue and one due score, after a fresh joined source.
set -eu

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                    'membrane-aave-usdc-holder-prospective.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('aave-usdc-holder:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
if [ ! -f data/research/venue-signals/aave-usdc-holder-prospective-v1/issues/00000001.json ]; then
  set -- data/research/venue-signals/aave-usdc-market-cash-archive-v1/slice-*-26095417.json
  if [ ! -f "$1" ]; then
    # V1 has not sealed its final boundary; no issue exists to score yet.
    exit 0
  fi
fi
if ! /usr/bin/python3 - <<'PY'
import os
import sys

stat = os.statvfs('data/research/venue-signals')
if stat.f_bavail * stat.f_frsize < 1024 * 1024 * 1024:
    print('aave-usdc-holder:disk-reserve', file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

# Do not fill the issue-attempt ledger every five minutes while the finite V1
# archive is still behind the head. V2 must carry the joined endpoint past V1.
if ! /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 75s \
  /opt/homebrew/bin/node --max-old-space-size=512 --import tsx --input-type=module - <<'JS'
import { loadVerifiedEndpoint, preferredIndependentUrls } from './scripts/research/aave-usdc-holder-flow-pair.mjs'
import { TO_BLOCK as V1_TARGET } from './scripts/research/aave-usdc-market-cash-archive.mjs'
import { configuredPublicRpcUrls } from './scripts/research/carry-public-direct-exit-issue.mjs'
import { makeClient, readEnv } from './scripts/lib/venue-reads.mjs'

try {
  const joined = loadVerifiedEndpoint()
  const url = preferredIndependentUrls(configuredPublicRpcUrls(readEnv()))[0]
  const client = makeClient(url)
  if (await client.getChainId() !== 1) throw Error('chain')
  const [finalized, endpoint] = await Promise.all([
    client.getBlock({ blockTag: 'finalized' }),
    client.getBlock({ blockNumber: BigInt(joined.endpoint.blockNumber) }),
  ])
  const endpointMs = Number(endpoint?.timestamp) * 1000
  const ageMs = Date.now() - endpointMs
  if (endpoint?.hash?.toLowerCase() !== joined.endpoint.blockHash.toLowerCase() ||
      Number(finalized?.number) < joined.endpoint.blockNumber ||
      (joined.endpoint.blockNumber <= V1_TARGET && Number(finalized.number) > V1_TARGET + 1) ||
      !Number.isSafeInteger(endpointMs) || ageMs < -120_000 || ageMs > 7_200_000) {
    throw Error('stale_join')
  }
  process.stdout.write('aave-usdc-holder:joined-source-ready\n')
} catch {
  // RPC error objects can contain credentialed URLs. Keep the scheduler log clean.
  process.stderr.write('aave-usdc-holder:joined-source-not-ready\n')
  process.exitCode = 1
}
JS
then
  # Once an issue exists, its 1/4/24h outcomes must keep scoring even if the
  # archive stalls later. With no issue, stay entirely inert.
  if [ ! -f data/research/venue-signals/aave-usdc-holder-prospective-v1/issues/00000001.json ]; then
    exit 0
  fi
  exec /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 120s \
    /opt/homebrew/bin/node --max-old-space-size=512 --import tsx \
    scripts/research/aave-usdc-holder-prospective.mjs --score
fi

issue_exit=0
/usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 120s \
  /opt/homebrew/bin/node --max-old-space-size=512 --import tsx \
  scripts/research/aave-usdc-holder-prospective.mjs --issue || issue_exit=$?

score_exit=0
/usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 120s \
  /opt/homebrew/bin/node --max-old-space-size=512 --import tsx \
  scripts/research/aave-usdc-holder-prospective.mjs --score || score_exit=$?

if [ "$issue_exit" -ne 0 ] || [ "$score_exit" -ne 0 ]; then
  echo 'aave-usdc-holder:tick-command-failed' >&2
  exit 1
fi
