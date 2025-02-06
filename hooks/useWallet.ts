import { useChain } from '@cosmos-kit/react'

const useWallet = (chainID: string = "osmosis") => {
  return { ...useChain(chainID), address: "osmo15qn0rc5p42q9vzx4d99xwfl68pwd8pyln7ds2l" }
}

export default useWallet
