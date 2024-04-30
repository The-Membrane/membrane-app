import { osmosis } from 'osmojs'
import { useChain } from '@cosmos-kit/react'

export const useRpcClient = (chainName: string) => {
  const { getRpcEndpoint } = useChain(chainName)

  const getRpcClient = async () => {
    let rpcEndpoint = await getRpcEndpoint()

    if (!rpcEndpoint) {
      console.log('no rpc endpoint — using a fallback')
      rpcEndpoint = `https://rpc.cosmos.directory/${chainName}`
    }

    return await osmosis.ClientFactory.createRPCQueryClient({ rpcEndpoint: "https://g.w.lavanet.xyz:443/gateway/cos3/rpc-http/bb6d2019c50124ec4fdb78498bc50573" })
  }

  return { getRpcClient }
}
