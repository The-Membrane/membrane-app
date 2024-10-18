import { rpcUrl, stargazeRPCUrl } from '@/config/defaults'
import { useQuery } from "@tanstack/react-query"
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'

//Osmosis
export const getCosmWasmClient = () => {
  return CosmWasmClient.connect(rpcUrl)
}

//SG
export const getSGCosmwasmClient = () => {
  return CosmWasmClient.connect(stargazeRPCUrl)
}