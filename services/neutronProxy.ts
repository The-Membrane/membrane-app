import { getCosmWasmClient } from '@/helpers/cosmwasmClient'

/**
 * Get token info (including total supply) for a denom from neutron-proxy contract
 */
export const getMBRNTokenInfo = async (
  rpcUrl: string,
  neutronProxyContract: string,
  mbrnDenom: string
) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)

  try {
    const response = await cosmWasmClient.queryContractSmart(neutronProxyContract, {
      get_token_info: { denom: mbrnDenom }
    })

    return response as {
      denom: string
      current_supply: string
      max_supply: string
      burned_supply: string
    }
  } catch (error) {
    console.error('Error querying MBRN token info:', error)
    return null
  }
}

export interface SupplySnapshotEntry {
  timestamp: number
  current_supply: string
  burned_supply: string
}

export interface SupplySnapshotResponse {
  denom: string
  snapshots: SupplySnapshotEntry[]
}

/**
 * Get supply history snapshots for a denom from proxy contract
 */
export const getMBRNSupplyHistory = async (
  rpcUrl: string,
  proxyContract: string,
  mbrnDenom: string,
  limit?: number,
  startAfter?: number
): Promise<SupplySnapshotResponse | null> => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)

  try {
    const response = await cosmWasmClient.queryContractSmart(proxyContract, {
      get_supply_history: {
        denom: mbrnDenom,
        limit: limit ?? 365,
        ...(startAfter !== undefined && { start_after: startAfter }),
      }
    })

    return response as SupplySnapshotResponse
  } catch (error) {
    console.error('Error querying MBRN supply history:', error)
    return null
  }
}
