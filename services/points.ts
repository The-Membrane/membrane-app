
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
  return client.userStats({ })
}

