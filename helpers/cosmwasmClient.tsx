import { rpcUrl, stargazeRPCUrl } from '@/config/defaults'
import { useQuery } from "@tanstack/react-query"
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import useAppState from '@/persisted-state/useAppState';


//Osmosis
export const getCosmWasmClient = (rpcUrl: string) => {
  return CosmWasmClient.connect(rpcUrl)
}

//SG
export const getSGCosmwasmClient = () => {
  return CosmWasmClient.connect(stargazeRPCUrl)
}