import { defineChain, type Chain } from 'viem'
import { mainnet } from 'viem/chains'

/**
 * EVM chain registry. Replaces config/chains.ts (Cosmos ChainConfig[]) under the
 * EVM-only migration. No live deployment exists yet: the default target is a local
 * anvil running membrane-solidity's script/DeployFullSystem.s.sol.
 *
 * Everything is env-driven so testnet/mainnet targets slot in without code changes:
 *   NEXT_PUBLIC_EVM_CHAIN_ID  (default 31337)
 *   NEXT_PUBLIC_EVM_RPC_URL   (default http://127.0.0.1:8545 on LOCAL origins only)
 *
 * TRUST/UX GUARD: a public origin (Vercel etc.) must never fetch a loopback RPC —
 * Chrome's Local Network Access permission pops "wants to access other apps and
 * services on this device", which reads as malware to users. Without an explicit
 * NEXT_PUBLIC_EVM_RPC_URL, non-local origins get a .invalid sentinel: requests fail
 * fast at DNS (no permission prompt), services null out, and the RPCStatus banner
 * reports the chain unreachable.
 */

const LOOPBACK_RPC = 'http://127.0.0.1:8545'
/** DNS-unresolvable per RFC 2606 — fails fast without touching the local network. */
const UNSET_RPC = 'https://rpc-not-configured.invalid'

function defaultRpcUrl(): string {
  if (process.env.NEXT_PUBLIC_EVM_RPC_URL) return process.env.NEXT_PUBLIC_EVM_RPC_URL
  if (typeof window === 'undefined') return LOOPBACK_RPC // SSR/build: never fetched client-side
  const host = window.location.hostname
  const isLocalOrigin = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  return isLocalOrigin ? LOOPBACK_RPC : UNSET_RPC
}

export const anvil = defineChain({
  id: 31337,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [defaultRpcUrl()] },
  },
})

/** Add mainnet/L2 targets here (import from viem/chains) once a deployment exists. */
export const supportedEvmChains: readonly [Chain, ...Chain[]] = [anvil]

export const DEFAULT_EVM_CHAIN: Chain =
  supportedEvmChains.find((c) => c.id === Number(process.env.NEXT_PUBLIC_EVM_CHAIN_ID)) ??
  supportedEvmChains[0]

/**
 * Chains a wallet may SIGN on for one surface, never the app's own chain: Ethereum mainnet,
 * for the /position levers (repay / add on the reader's own Aave V3, Spark, Compound V3 or
 * Morpho Blue position, components/PositionV0/LeverSheet.tsx). They join the wagmi config
 * (config/evm/wagmi.ts) only so useSwitchChain and a mainnet wallet client exist. They are
 * NOT in supportedEvmChains, so DEFAULT_EVM_CHAIN, the contract book, the RPC status check
 * and every read keep the app's chain, and useWallet() never reports one (isAppChain).
 */
export const executionOnlyChains = [mainnet] as const

/** Is `id` one of the app's own chains (not an execution-only one)? */
export const isAppChain = (id: number | undefined): boolean => supportedEvmChains.some((c) => c.id === id)
