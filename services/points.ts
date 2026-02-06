
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { PointsQueryClient } from '@/contracts/codegen/points/Points.client'

export const PointsClient = async (rpcUrl: string) => {
  console.log("points CW client")
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return new PointsQueryClient(cosmWasmClient, contracts.points)
}

export const getAllUserPoints = async (rpcUrl: string) => {
  const client = await PointsClient(rpcUrl)
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

export interface UserConversionRateState {
  user: string;
  conversion_rates: UserConversionRates[];
}

export const getUserConversionRates = async (address: string, rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return cosmWasmClient.queryContractSmart(contracts.points, {
    user_conversion_rates: {
      user: address
    }
  }) as Promise<{
    user: string;
    conversion_rates: UserConversionRates[];
  }[]>;
}

export const getAllConversionRates = async (rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return cosmWasmClient.queryContractSmart(contracts.points, {
    user_conversion_rates: {
      limit: 1024
    }
  }) as Promise<UserConversionRateState[]>;
}

export const getPointsMultipliers = async (rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return cosmWasmClient.queryContractSmart(contracts.points, {
    points_multipliers: {}
  }) as Promise<{
    points_multipliers: {
      interest_rate: string;
      vault_yields: Array<{
        vault_address: string;
        multiplier: string;
      }>;
      liquidation_execution: string;
      liquidation_claims: string;
      governance_votes: string;
      transmuter_swap_fees: string;
      disco_revenue: string;
    };
  }>;
}