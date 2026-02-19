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























