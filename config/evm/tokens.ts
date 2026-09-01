import { getContractAddress, type Address } from './contracts'
import { DEFAULT_EVM_CHAIN } from './chains'

/**
 * EVM token registry — replaces chain-registry (Cosmos) as the source of asset
 * identity. `address` is the ERC-20 address, or the literal 'native' for the
 * chain's gas asset.
 *
 * DECIMALS NOTE: CDT and MBRN are 18 decimals on EVM (MembraneToken = stock
 * OpenZeppelin ERC20, Tokenfactory.sol:32). They were 6 on Cosmos — any
 * hardcoded shiftDigits(x, 6) around protocol tokens is wrong here.
 */
export type EvmToken = {
  symbol: string
  name: string
  address: Address | 'native'
  decimals: number
  logo?: string
  isLP?: boolean
}

/** Non-protocol tokens (collateral, gas). Anvil-deployed mocks are injected via env. */
const STATIC_TOKENS: Record<number, EvmToken[]> = {
  // anvil / local
  31337: [
    { symbol: 'ETH', name: 'Ether', address: 'native', decimals: 18, logo: '/images/eth.svg' },
  ],
}

/**
 * Collateral mock addresses vary per anvil deploy — override without code changes:
 * NEXT_PUBLIC_EVM_ASSETS='{"31337":[{"symbol":"WBTC","name":"Wrapped BTC","address":"0x…","decimals":8}]}'
 *
 * Named "ASSETS" (not "TOKENS") deliberately: the value is public ERC-20
 * metadata, and secret scanners flag NEXT_PUBLIC_*TOKEN* names as leaked
 * auth tokens. Never put anything secret in a NEXT_PUBLIC_ var.
 */
function envTokens(chainId: number): EvmToken[] {
  try {
    const raw = process.env.NEXT_PUBLIC_EVM_ASSETS
    if (!raw) return []
    const parsed = JSON.parse(raw) as Record<string, EvmToken[]>
    return parsed[String(chainId)] ?? []
  } catch (e) {
    console.error('Invalid NEXT_PUBLIC_EVM_ASSETS:', e)
    return []
  }
}

/** Protocol tokens come from the contract address book (deploy-dependent). */
function protocolTokens(chainId: number): EvmToken[] {
  const cdt = getContractAddress(chainId, 'cdt')
  const mbrn = getContractAddress(chainId, 'mbrn')
  const tokens: EvmToken[] = []
  // MBRN wears the protocol mark: a governance token is a claim on Membrane itself, so
  // it uses the intact-hexagon cell mark. CDT is deliberately unlike it — the same cells
  // uncontained and dissolving, because CDT is what flows through the membrane rather
  // than the membrane itself.
  //
  // Was '/images/Logo.svg', which does not exist — only lowercase logo.svg does. macOS is
  // case-insensitive so it resolved locally while 404ing on Linux in production.
  if (cdt) tokens.push({ symbol: 'CDT', name: 'Membrane CDT', address: cdt, decimals: 18, logo: '/images/cdt.png' })
  if (mbrn) tokens.push({ symbol: 'MBRN', name: 'Membrane MBRN', address: mbrn, decimals: 18, logo: '/images/mbrn.svg' })
  return tokens
}

export function getEvmTokens(chainId: number = DEFAULT_EVM_CHAIN.id): EvmToken[] {
  return [
    ...(STATIC_TOKENS[chainId] ?? []),
    ...protocolTokens(chainId),
    ...envTokens(chainId),
  ]
}
