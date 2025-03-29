import { rpcUrl, stargazeRPCUrl } from '@/config/defaults'
import { useQuery } from "@tanstack/react-query"
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import useAppState from '@/persisted-state/useAppState';

export const useCosmWasmClient = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['cosmwasm_client'],
    queryFn: async () => {
      return getCosmWasmClient(appState.rpcUrl)
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