#!/usr/bin/env bash
# Links the two source trees this project builds against. Nothing is vendored.
#   membrane-solidity  triccs/membrane-solidity @ 70f965e4 (needs lib/forge-std + lib/openzeppelin-contracts)
#   bundler3           morpho-org/bundler3      @ b4014349 (needs lib/openzeppelin-contracts, lib/morpho-blue, lib/permit2 + lib/permit2/lib/solmate)
# Override with MEMBRANE_SOLIDITY=/path BUNDLER3=/path ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${MEMBRANE_SOLIDITY:?set MEMBRANE_SOLIDITY to a membrane-solidity checkout}"
: "${BUNDLER3:?set BUNDLER3 to a morpho-org/bundler3 checkout with submodules}"
mkdir -p lib
ln -sfn "$MEMBRANE_SOLIDITY" lib/membrane-solidity
ln -sfn "$BUNDLER3" lib/bundler3
echo "linked: $(readlink lib/membrane-solidity) $(readlink lib/bundler3)"
