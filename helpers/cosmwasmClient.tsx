import { stargazeRPCUrl } from '@/config/defaults'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import useRPCState from "@/components/useRPCState";


//Osmosis
export const getCosmWasmClient = () => {
  const { rpcState } = useRPCState()
  return CosmWasmClient.connect(rpcState.rpcURLs[rpcState.urlIndex])
} 

//SG
export const getSGCosmwasmClient = () => {
  return CosmWasmClient.connect(stargazeRPCUrl)
}