import { Asset, getAssets } from '@/helpers/chain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import useWallet from './useWallet'

/**
 * Asset registry hook — EVM-backed. Legacy chainID string params are accepted and
 * ignored (single-EVM-chain app); the wallet's chain id keys the query instead so
 * assets refresh on network switch.
 */
const useAssets = (_legacyChainID?: string) => {
  const { chain } = useWallet()
  const { data: assets } = useQuery({
    queryKey: ['evm assets', chain.id],
    queryFn: async () => {
      return getAssets()
    },
  })

  return assets as Asset[]
}

export const useAssetBySymbol = (symbol: string, _legacyChainID?: string) => {
  const assets = useAssets()

  return useMemo(() => {
    if (!assets || !symbol) return null
    return assets.find((asset) => asset.symbol === symbol) as Asset
  }, [assets, symbol])
}

export const useAssetByDenom = (denom: string, _legacyChainID?: string, assets?: any[]) => {
  return useMemo(() => {
    if (!assets || !denom) return null
    return assets.find((asset) => asset.base === denom)
  }, [assets, denom])
}

export default useAssets
