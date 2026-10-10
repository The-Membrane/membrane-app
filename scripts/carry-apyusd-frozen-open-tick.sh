#!/bin/sh
# One serial ApyUSD lane under the existing campaign lock and timeout.
set -eu
cd "$(dirname "$0")/.."
exec /opt/homebrew/bin/node --max-old-space-size=384 scripts/research/apyusd-frozen-open-tick.mjs
