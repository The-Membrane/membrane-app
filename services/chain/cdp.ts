import type { PublicClient } from 'viem'
import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Cdp.sol read service — the reference implementation for the EVM service layer.
 * Follows the existing service contract (see .claude/skills/hook-query-patterns):
 * null on failure, never throw; optional address override with config fallback.
 *
 * Migration counterpart: services/cdp.ts (queryContractSmart against the CosmWasm
 * positions contract). Business logic in hooks stays; only these primitives change.
 */

function cdpAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'cdp') : undefined)
}

/** Total CDT minted against the CDP (protocol-wide, public — no wallet required). */
export async function getCreditMinted(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: cdpAbi, functionName: 'creditMinted' })
  } catch (error) {
    console.error('Error querying CDP creditMinted:', error)
    return null
  }
}

/** Current adaptive borrow rate for a collateral denom (bytes32 asset key; public). */
export async function getCurrentAdaptiveRate(
  client: PublicClient | null,
  assetDenom: `0x${string}`,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = cdpAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: cdpAbi,
      functionName: 'currentAdaptiveRate',
      args: [assetDenom],
    })
  } catch (error) {
    console.error('Error querying CDP currentAdaptiveRate:', error)
    return null
  }
}
