
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient' 
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse } from '@/contracts/codegen/earn/Earn.types'
import { Uint128 } from '@/contracts/codegen/positions/Positions.types'

export const EarnClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new EarnQueryClient(cosmWasmClient, contracts.earn)
}

export const getUnderlyingUSDC = async (vtAmount: string) => {
  const client = await EarnClient()
  return client.vaultTokenUnderlying({ vaultTokenAmount: vtAmount}).then((res) => res) as Promise<Uint128>    
}


export const getVaultAPRResponse = async () => {
    const client = await EarnClient()
    return client.aPR().then((res) => res) as Promise<APRResponse>    
  
}
