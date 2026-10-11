/**
 * keccak256 for the curator feed. One implementation in the repo: this delegates to the
 * oracle-registry engine's dependency-free keccak (lib/oracleRegistry/manipulation/
 * chain/keccak.ts). topic0 constants in abi.ts and Vault V2 cap ids are checked against
 * it in tests/unit/curatorFeed.test.ts, including a 288-byte input that crosses the
 * 136-byte rate boundary.
 */

import { keccak256 } from '../oracleRegistry/manipulation/chain/keccak'

/** keccak256 of a UTF-8 string (event and function signatures) → 0x-hex. */
export const keccakText = (s: string): string => keccak256(s, 'utf8')

/** keccak256 of 0x-hex bytes (abi-encoded id data) → 0x-hex. */
export const keccakHex = (hex: string): string => keccak256(hex, 'hex')
