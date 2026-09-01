// Prints ONLY the public address derived from MINT_SIGNER_KEY (nothing else — never the key).
//
// The anvil Q-Racing deploy (membrane-solidity script/DeployQRacingMint.s.sol) needs the
// backend voucher signer's ADDRESS as its MINT_SIGNER env so the on-chain `signer` matches
// what POST /api/mint/voucher signs with. Wire it up like:
//
//   MINT_SIGNER=$(MINT_SIGNER_KEY=0x... node scripts/print-mint-signer-address.mjs) \
//   PRIVATE_KEY=0x... forge script script/DeployQRacingMint.s.sol --rpc-url ... --broadcast
//
// Usage: MINT_SIGNER_KEY=0x<64hex> node scripts/print-mint-signer-address.mjs

import { privateKeyToAccount } from 'viem/accounts'

const key = process.env.MINT_SIGNER_KEY
if (!key) {
  console.error('MINT_SIGNER_KEY is not set')
  process.exit(1)
}

try {
  const normalized = key.startsWith('0x') ? key : `0x${key}`
  const { address } = privateKeyToAccount(normalized)
  // Address ONLY — safe to capture in a shell var / CI log.
  console.log(address)
} catch {
  console.error('MINT_SIGNER_KEY is not a valid private key')
  process.exit(1)
}
