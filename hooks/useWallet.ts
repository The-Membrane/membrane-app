import { useChain } from '@cosmos-kit/react'

const useWallet = (chainID: string = "osmosis") => {
  return { ...useChain(chainID), address: "osmo1fd8z9npe5gd6afm0wj60tryzx04gn5jl84hcm2" }
}

export default useWallet
