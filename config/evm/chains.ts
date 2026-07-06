import { defineChain, type Chain } from 'viem'

/**
 * EVM chain registry. Replaces config/chains.ts (Cosmos ChainConfig[]) under the
 * EVM-only migration. No live deployment exists yet: the default target is a local
 * anvil running membrane-solidity's script/DeployFullSystem.s.sol.
 *
 * Everything is env-driven so testnet/mainnet targets slot in without code changes:
 *   NEXT_PUBLIC_EVM_CHAIN_ID  (default 31337)
 *   NEXT_PUBLIC_EVM_RPC_URL   (default http://127.0.0.1:8545)
 */

export const anvil = defineChain({
  id: 31337,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_EVM_RPC_URL ?? 'http://127.0.0.1:8545'] },
  },
})

/** Add mainnet/L2 targets here (import from viem/chains) once a deployment exists. */
export const supportedEvmChains: readonly [Chain, ...Chain[]] = [anvil]

export const DEFAULT_EVM_CHAIN: Chain =
  supportedEvmChains.find((c) => c.id === Number(process.env.NEXT_PUBLIC_EVM_CHAIN_ID)) ??
  supportedEvmChains[0]
