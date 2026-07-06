import { createPublicClient, http, type PublicClient, type Chain } from 'viem'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * Wallet-independent viem public client — the EVM replacement for
 * helpers/cosmwasmClient.tsx. ALL reads in the app go through this client so the full
 * app renders without a connected wallet (see docs/audits/02-wallet-gating-routes.md).
 * Wallet connection gates writes only.
 *
 * Cached per chainId+rpcUrl, mirroring the memoization role useCosmWasmClient played.
 */

const clients = new Map<string, PublicClient>()

export function getPublicClient(chain: Chain = DEFAULT_EVM_CHAIN, rpcUrl?: string): PublicClient {
  const key = `${chain.id}:${rpcUrl ?? 'default'}`
  let client = clients.get(key)
  if (!client) {
    client = createPublicClient({
      chain,
      transport: http(rpcUrl),
      batch: { multicall: true },
    })
    clients.set(key, client)
  }
  return client
}
