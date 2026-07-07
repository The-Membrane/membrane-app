import { defineChain, type Chain } from 'viem'

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
