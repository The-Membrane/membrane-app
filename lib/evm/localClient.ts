import { createPublicClient, http, type PublicClient } from 'viem'
import { anvil } from 'viem/chains'

// Read-only client for the LOCAL anvil deploy the pre-mainnet pages read
// (owner decision 2026-09-25: build on-chain surfaces against local anvil first).
// No multicall: a fresh anvil has no Multicall3, so the app-wide client
// (services/chain/client.ts, batch.multicall) fails every read there. Plain
// JSON-RPC batching instead — the same choice lib/riskDesk/loadRiskDesk.ts makes.
// Mainnet later = swap this for getPublicClient() once Multicall3 exists there.
export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545'

let client: PublicClient | null = null
export function localChainClient(rpcUrl = LOCAL_RPC_URL): PublicClient {
  if (!client) client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { batch: true }) }) as PublicClient
  return client
}
