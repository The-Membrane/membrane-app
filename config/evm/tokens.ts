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
 * NEXT_PUBLIC_EVM_TOKENS='{"31337":[{"symbol":"WBTC","name":"Wrapped BTC","address":"0x…","decimals":8}]}'
 */
function envTokens(chainId: number): EvmToken[] {
  try {
    const raw = process.env.NEXT_PUBLIC_EVM_TOKENS
    if (!raw) return []
    const parsed = JSON.parse(raw) as Record<string, EvmToken[]>
    return parsed[String(chainId)] ?? []
  } catch (e) {
    console.error('Invalid NEXT_PUBLIC_EVM_TOKENS:', e)
    return []
  }
}

/** Protocol tokens come from the contract address book (deploy-dependent). */
function protocolTokens(chainId: number): EvmToken[] {
  const cdt = getContractAddress(chainId, 'cdt')
  const mbrn = getContractAddress(chainId, 'mbrn')
  const tokens: EvmToken[] = []
  if (cdt) tokens.push({ symbol: 'CDT', name: 'Membrane CDT', address: cdt, decimals: 18, logo: '/images/cdt.svg' })
  if (mbrn) tokens.push({ symbol: 'MBRN', name: 'Membrane MBRN', address: mbrn, decimals: 18, logo: '/images/Logo.svg' })
  return tokens
}

export function getEvmTokens(chainId: number = DEFAULT_EVM_CHAIN.id): EvmToken[] {
  return [
    ...(STATIC_TOKENS[chainId] ?? []),
    ...protocolTokens(chainId),
    ...envTokens(chainId),
  ]
}
