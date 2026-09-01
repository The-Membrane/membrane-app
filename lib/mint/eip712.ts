// Server-only EIP-712 voucher signing for the Q-Racing mint bridge.
//
// Mirrors membrane-solidity MintClaim.sol (branch feat/qracing-mint-claim) EXACTLY:
//   - domain: name "MembraneQRacing", version "1", chainId, verifyingContract = MintClaim addr
//   - type:   Voucher(address to,bytes32 petAttrsHash,uint256 byteAmount,uint256 nonce,uint256 deadline)
//     Field ORDER is load-bearing — it must match VOUCHER_TYPEHASH in the contract.
//
// The signer private key (MINT_SIGNER_KEY) is read lazily and NEVER logged or returned.
// getMintSignerAddress() exposes only the public address so the anvil deploy can set the
// matching on-chain `signer` (see scripts/print-mint-signer-address.mjs).

import { keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

if (typeof window !== 'undefined') {
  throw new Error('lib/mint/eip712 must never be imported from client-side code')
}

/** 32 zero bytes. petAttrsHash === ZERO_HASH ⇒ BYTE-only claim (no pet minted). */
export const ZERO_HASH = `0x${'00'.repeat(32)}` as const

export const EIP712_DOMAIN_NAME = 'MembraneQRacing'
export const EIP712_DOMAIN_VERSION = '1'

// The single typed-data struct. Order mirrors the Solidity struct / typehash.
export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'to', type: 'address' },
    { name: 'petAttrsHash', type: 'bytes32' },
    { name: 'byteAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type Voucher = {
  to: `0x${string}`
  petAttrsHash: `0x${string}`
  byteAmount: bigint
  nonce: bigint
  deadline: bigint
}

/**
 * Canonical petAttrsHash: keccak256 over the UTF-8 bytes of `JSON.stringify(attributes)`.
 *
 * LOAD-BEARING CANONICALIZATION: `attributes` must be the value AS READ BACK FROM POSTGRES
 * (the jsonb column), not the freshly-generated object. Postgres jsonb normalizes object key
 * ordering and strips insignificant whitespace on write, so `JSON.stringify` of the SELECTed
 * value is deterministic and reproducible by any later verifier — whereas stringifying the
 * pre-insert `generateTraits(...)` object would use the generator's key order and yield a
 * DIFFERENT hash. DB storage order = hash input. Always hash the stored value.
 */
export function petAttrsHash(attributes: unknown): `0x${string}` {
  return keccak256(toBytes(JSON.stringify(attributes)))
}

/** Builds the viem typed-data payload for signing (and for the frontend to mirror). */
export function buildVoucherTypedData(
  voucher: Voucher,
  chainId: number,
  verifyingContract: `0x${string}`,
) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract,
    },
    types: VOUCHER_TYPES,
    primaryType: 'Voucher' as const,
    message: voucher,
  }
}

// Never logged. Never exported. A missing/invalid key only breaks the mint routes.
function getSignerAccount() {
  const key = process.env.MINT_SIGNER_KEY
  if (!key) {
    throw new Error('MINT_SIGNER_KEY is not configured')
  }
  const normalized = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
  return privateKeyToAccount(normalized)
}

/** The public address of the voucher signer — safe to expose (used to align the on-chain signer). */
export function getMintSignerAddress(): `0x${string}` {
  return getSignerAccount().address
}

/**
 * Signs a voucher. Returns a 65-byte r||s||v signature hex (what viem's signTypedData
 * produces and what MintClaim's ECDSA.recover expects). The private key never leaves here.
 */
export async function signVoucher(
  voucher: Voucher,
  chainId: number,
  verifyingContract: `0x${string}`,
): Promise<`0x${string}`> {
  const account = getSignerAccount()
  return account.signTypedData(buildVoucherTypedData(voucher, chainId, verifyingContract))
}
