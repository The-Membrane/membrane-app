/**
 * Vault V2 cap ids. Pure.
 *
 * A Vault V2 cap is keyed by `id = keccak256(idData)`, where idData is abi.encode of a
 * type string plus its arguments. The Morpho adapters (morpho-org/vault-v2
 * src/adapters/MorphoMarketV1AdapterV2.sol:73,262-263, MorphoVaultV1Adapter.sol:38) use:
 *   abi.encode("this", adapter)                           one adapter
 *   abi.encode("collateralToken", collateralToken)        every market with that collateral
 *   abi.encode("this/marketParams", adapter, marketParams) one Morpho Blue market
 * The cap events carry idData, so a cap change names its collateral exactly.
 */

import { keccakHex } from './keccak'

export interface MarketParams {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: bigint
}

export type V2IdData =
  | { type: 'adapter'; adapter: string }
  | { type: 'collateral'; collateral: string }
  | { type: 'market'; adapter: string; marketParams: MarketParams; market: string }
  | { type: 'unknown'; tag: string }

const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h)
const w = (hex: string, i: number): string => hex.slice(i * 64, i * 64 + 64)
const addr = (word: string): string => '0x' + word.slice(24).toLowerCase()

/** Morpho Blue market id = keccak256(abi.encode(marketParams)). */
export function marketIdOf(p: MarketParams): string {
  const enc =
    '0x' +
    [p.loanToken, p.collateralToken, p.oracle, p.irm]
      .map((a) => strip(a).toLowerCase().padStart(64, '0'))
      .join('') +
    p.lltv.toString(16).padStart(64, '0')
  return keccakHex(enc)
}

export function decodeV2IdData(idData: string): V2IdData {
  const hex = strip(idData)
  if (hex.length < 128) return { type: 'unknown', tag: '' }
  const off = Number(BigInt('0x' + w(hex, 0)))
  if (off % 32 !== 0 || off * 2 + 64 > hex.length) return { type: 'unknown', tag: '' }
  const len = Number(BigInt('0x' + hex.slice(off * 2, off * 2 + 64)))
  const tagHex = hex.slice(off * 2 + 64, off * 2 + 64 + len * 2)
  const tag = new TextDecoder().decode(
    Uint8Array.from(tagHex.match(/../g) ?? [], (b) => parseInt(b, 16)),
  )
  if (tag === 'this' && off === 64) return { type: 'adapter', adapter: addr(w(hex, 1)) }
  if (tag === 'collateralToken' && off === 64)
    return { type: 'collateral', collateral: addr(w(hex, 1)) }
  if (tag === 'this/marketParams' && off === 224) {
    const marketParams: MarketParams = {
      loanToken: addr(w(hex, 2)),
      collateralToken: addr(w(hex, 3)),
      oracle: addr(w(hex, 4)),
      irm: addr(w(hex, 5)),
      lltv: BigInt('0x' + w(hex, 6)),
    }
    return {
      type: 'market',
      adapter: addr(w(hex, 1)),
      marketParams,
      market: marketIdOf(marketParams),
    }
  }
  return { type: 'unknown', tag }
}

/** The cap id for an idData blob. */
export const v2IdOf = (idData: string): string => keccakHex(idData)

// Encoders (inverse of the above) — used to derive the ids an adapter will touch, so a
// V2 Allocate/Deallocate (which carries ids, not idData) maps back to a market.
const encTag = (tag: string): string => {
  const bytes = new TextEncoder().encode(tag)
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return (
    bytes.length.toString(16).padStart(64, '0') + body.padEnd(Math.ceil(body.length / 64) * 64, '0')
  )
}
const encAddr = (a: string): string => strip(a).toLowerCase().padStart(64, '0')

export const adapterIdData = (adapter: string): string =>
  '0x' + (64).toString(16).padStart(64, '0') + encAddr(adapter) + encTag('this')
export const collateralIdData = (token: string): string =>
  '0x' + (64).toString(16).padStart(64, '0') + encAddr(token) + encTag('collateralToken')
export const marketIdData = (adapter: string, p: MarketParams): string =>
  '0x' +
  (224).toString(16).padStart(64, '0') +
  encAddr(adapter) +
  [p.loanToken, p.collateralToken, p.oracle, p.irm].map(encAddr).join('') +
  p.lltv.toString(16).padStart(64, '0') +
  encTag('this/marketParams')
