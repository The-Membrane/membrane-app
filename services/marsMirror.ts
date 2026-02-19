import { getCosmWasmClient } from '@/helpers/cosmwasmClient'

/**
 * Get Mars LTV info for an asset from mars-mirror contract
 */
export const getMarsLTVInfo = async (
  rpcUrl: string,
  marsMirrorContract: string,
  asset: string
) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  
  try {
    const response = await cosmWasmClient.queryContractSmart(marsMirrorContract, {
      mars_ltv_info: { asset }
    })
    
    return response as {
      max_ltv: string
      max_borrow_ltv: string
    }
  } catch (error) {
    console.error('Error querying Mars LTV info:', error)
    return null
  }
}























