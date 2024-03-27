import { assets as registryAssets } from 'chain-registry'
import { Asset as RegistryAsset } from '@chain-registry/types'
import { getExponentByDenom } from '@chain-registry/utils'

export type Asset = RegistryAsset & {
  decimal: number
  logo: string
}

const defaultChain = 'osmosis'
const supportedAssets = ['OSMO', 'ATOM', 'TIA', 'CDT', 'MBRN', 'stOSMO', 'stATOM', 'USDT', 'USDC']

export const getAssetLogo = (asset: RegistryAsset) => {
  return asset?.logo_URIs?.svg || asset?.logo_URIs?.png || asset?.logo_URIs?.jpeg
}

const assetWithLogo = (asset: RegistryAsset) => ({
  ...asset,
  logo: getAssetLogo(asset),
  decimal: getExponentByDenom(registryAssets, asset.base, defaultChain),
})

export const getChainAssets = () => {
  const chainAssets = registryAssets.find((asset) => asset.chain_name === defaultChain)

  return chainAssets?.assets?.map(assetWithLogo)
}
export const getAssets = () => {
  const chainAssets = registryAssets.find((asset) => asset.chain_name === defaultChain)
  const supportedChainAssets = chainAssets?.assets.filter((asset) =>
    supportedAssets.includes(asset.symbol),
  )
  return supportedChainAssets?.map(assetWithLogo)
}

export const getAssetBySymbol = (symbol: string) => {
  const assets = getAssets()
  return assets?.find((asset) => asset.symbol === symbol)
}

export const getAssetByDenom = (denom: string) => {
  const assets = getAssets()
  return assets?.find((asset) => asset.base === denom)
}
