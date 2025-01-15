import { useChain } from '@cosmos-kit/react'

const useWallet = (chainID: string = "osmosis") => {
  return { ...useChain(chainID), address: "osmo1lgdwng93exmdfjkerg7spadkl9tzc22v549tp7" }
}

export default useWallet
