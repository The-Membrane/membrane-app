#!/usr/bin/env bash
# Starts anvil on $PORT (default 8545), deploys script/DeployLocal.s.sol, prints anvil's PID.
# The caller stops anvil by that PID. Needs forge/anvil/cast on PATH and ./setup.sh done.
set -euo pipefail
cd "$(dirname "$0")"
PORT=${PORT:-8545}
RPC="http://127.0.0.1:${PORT}"
forge build >/dev/null
anvil --silent --port "$PORT" --host 127.0.0.1 --disable-code-size-limit --hardfork prague >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' ERR
for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast --slow --disable-code-size-limit >/dev/null
echo "$PID"
