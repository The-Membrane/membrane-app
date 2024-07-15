
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient' 
import { PointsQueryClient } from '@/contracts/codegen/points/Points.client'
import { UserStatsResponse } from '@/contracts/codegen/points/Points.types'

export const PointsClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new PointsQueryClient(cosmWasmClient, contracts.points)
}

export const getAllUserPoints = async () => {
  const client = await PointsClient()
  return client.userStats({ 
    limit: 1024
   }).then((res) => res) as Promise<UserStatsResponse[]>    
}

