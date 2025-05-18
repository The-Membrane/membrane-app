import { useChain } from '@cosmos-kit/react'
import { DEFAULT_CHAIN } from '@/config/chains'
import { useChainRoute } from './useChainRoute'

const useWallet = (chainID: string = DEFAULT_CHAIN) => {
  const { chainName } = useChainRoute()
  return useChain(chainName)
}

export default useWallet
