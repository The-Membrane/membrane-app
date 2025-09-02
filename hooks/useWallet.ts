import { useChain } from '@cosmos-kit/react'

import { useChainRoute } from './useChainRoute'

const useWallet = () => {
  const { chainName } = useChainRoute()
  return useChain(chainName)
}

export default useWallet
