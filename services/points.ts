
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { PointsQueryClient } from '@/contracts/codegen/points/Points.client'

export const PointsClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new PointsQueryClient(cosmWasmClient, contracts.points)
}

export const getAllUserPoints = async () => {
  const client = await PointsClient()
  console.log("b4 query", client)
  return client.userStats({
    limit: 1024
  })
}

interface UserConversionRates {
  vault_address: string;
  last_conversion_rate: string;
  last_vt_balance: string;
}

export const getUserConversionRates = async (address: string) => {
  const cosmWasmClient = await getCosmWasmClient()
  return cosmWasmClient.queryContractSmart(contracts.points, {
    user_conversion_rates: {
      user: address
    }
  }) as Promise<{
    user: string;
    conversion_rates: UserConversionRates[];
  }[]>;
}

