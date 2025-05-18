import { useChainRoute } from './useChainRoute'
import { getChainAssets, getAssets, getAssetBySymbol, getAssetByDenom, getAssetsByDenom } from '@/helpers/chain'

export const useChainAssets = () => {
    const { chainName } = useChainRoute()

    return {
        getChainAssets: () => getChainAssets(chainName),
        getAssets: () => getAssets(chainName),
        getAssetBySymbol: (symbol: string) => getAssetBySymbol(symbol, chainName),
        getAssetByDenom: (denom: string) => getAssetByDenom(denom, chainName),
        getAssetsByDenom: (denoms: string[]) => getAssetsByDenom(denoms, chainName)
    }
} 