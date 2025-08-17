import { stargazeRPCUrl } from '@/config/defaults'
import { useQuery } from "@tanstack/react-query"
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";

export const useCosmWasmClient = (rpcUrl: string) => {

  return useQuery({
    queryKey: ['cosmwasm_client', rpcUrl],
    queryFn: async () => {
      return getCosmWasmClient(rpcUrl)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}


//Osmosis
export const getCosmWasmClient = (rpcUrl: string) => {
  console.log('getCosmWasmClient')
  return CosmWasmClient.connect(rpcUrl)
}

//SG
export const getSGCosmwasmClient = () => {
  return CosmWasmClient.connect(stargazeRPCUrl)
}