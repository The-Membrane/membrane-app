import { useChain } from '@cosmos-kit/react'
import { DEFAULT_CHAIN } from '@/config/chains'

const useWallet = (chainID: string = DEFAULT_CHAIN) => {
  return useChain(chainID)
}

export default useWallet
