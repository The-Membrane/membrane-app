import { assets as registryAssets } from 'chain-registry'
import { Asset as RegistryAsset } from '@chain-registry/types'
import { getExponentByDenom } from '@chain-registry/utils'
import lpAssets from '@/config/lpAssets.json'

export type Asset = RegistryAsset & {
  decimal: number
  logo: string
  isLP: boolean
}

const defaultChain = 'osmosis'

//For swaps
export interface exported_supportedAssets {
  OSMO: undefined,
  ATOM: undefined,
  TIA: undefined,
  CDT: undefined,
  MBRN: undefined,
  stOSMO: undefined,
  stATOM: undefined,
  USDT: undefined,
  USDC: undefined,
  "USDC.axl": undefined,
}

export const getAssetLogo = (asset: RegistryAsset) => {
  return asset?.logo_URIs?.svg || asset?.logo_URIs?.png || asset?.logo_URIs?.jpeg
}

const assetWithLogo = (asset: RegistryAsset, chainID: string = 'osmosis') => ({
  ...asset,
  logo: getAssetLogo(asset),
  decimal: getExponentByDenom(registryAssets, asset.base, chainID),
  isLP: false,
})

export const getChainAssets = (chainID: string = 'osmosis') => {
  const chainAssets = registryAssets.find((asset) => asset.chain_name === chainID)

  const assetsWtihLogo = chainAssets?.assets?.map((asset) => assetWithLogo(asset, chainID)) || []

  return [...assetsWtihLogo, ...lpAssets]
}

export const getAssets = (chainID: string = 'osmosis') => {
  const chainAssets = registryAssets.find((asset) => asset.chain_name === chainID)
  const supportedChainAssets = chainAssets?.assets.filter((asset) =>
    supportedAssets.includes(asset.symbol),
  )
  const assetsWtihLogo = supportedChainAssets?.map((asset) => assetWithLogo(asset, chainID)) || []

  return [...assetsWtihLogo, ...lpAssets]
}

export const getAssetBySymbol = (symbol: string, chainID: string = 'osmosis') => {
  const assets = getAssets(chainID)
  return assets?.find((asset) => asset.symbol === symbol)
}

export const getAssetByDenom = (denom: string, chainID: string = 'osmosis') => {
  const assets = getAssets(chainID)
  return assets?.find((asset) => asset.base === denom)
}
