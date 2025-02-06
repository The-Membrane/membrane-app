import { useChain } from '@cosmos-kit/react'

const useWallet = (chainID: string = "osmosis") => {
  return useChain(chainID)
}

export default useWallet
