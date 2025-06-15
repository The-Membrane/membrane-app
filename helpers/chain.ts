import { assets as registryAssets } from 'chain-registry'
import { Asset as RegistryAsset } from '@chain-registry/types'
import { getExponentByDenom } from '@chain-registry/utils'
import lpAssets from '@/config/lpAssets.json'
import { DEFAULT_CHAIN } from '@/config/chains'

export type Asset = RegistryAsset & {
  decimal: number
  logo: string
  isLP: boolean
}

const supportedAssets = [
  'OSMO',
  'ATOM',
  'TIA',
  'CDT',
  'MBRN',
  'stOSMO',
  'stATOM',
  'USDT',
  'USDC',
  'milkTIA',
  'USDC.axl',
  'stTIA',
  'ETH',
  'ETH.axl',
  'WBTC',
  'WBTC.axl',
  'INJ'
]

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
  WBTC: undefined,
  "WBTC.axl": undefined,
  //This is ETH.axl that Osmosis is using as canonical denom rn
  ETH: undefined,
  INJ: undefined,
}

export const getAssetLogo = (asset: RegistryAsset) => {
  return asset?.logo_URIs?.svg || asset?.logo_URIs?.png || asset?.logo_URIs?.jpeg
}

const assetWithLogo = (asset: RegistryAsset, chainID: string = DEFAULT_CHAIN) => ({
  ...asset,
  logo: getAssetLogo(asset),
  decimal: getExponentByDenom(registryAssets, asset.base, chainID),
  isLP: false,
})

export const getChainAssets = (chainID: string = DEFAULT_CHAIN) => {
  //Remove Asset with denom: ibc/F74225B0AFD2F675AF56E9BE3F235486BCDE5C5E09AA88A97AFD2E052ABFE04C
  //This denom is creating ambiguity errors in the UI
  const chainAssets = registryAssets.find((asset) => asset.chain_name === chainID)

  const supportedChainAssets = chainAssets?.assets.filter((asset) =>
    asset.base !== 'ibc/F74225B0AFD2F675AF56E9BE3F235486BCDE5C5E09AA88A97AFD2E052ABFE04C'
  )
  const assetsWtihLogo = supportedChainAssets?.map((asset) => assetWithLogo(asset, chainID)) || []

  return [...assetsWtihLogo, ...lpAssets]
}

export const getAssets = (chainID: string = DEFAULT_CHAIN) => {
  //Remove Asset with denom: ibc/F74225B0AFD2F675AF56E9BE3F235486BCDE5C5E09AA88A97AFD2E052ABFE04C
  //This denom is creating ambiguity errors in the UI
  const chainAssets = registryAssets.find((asset) => asset.chain_name === chainID)
  const supportedChainAssets = chainAssets?.assets.filter((asset) =>
    asset.base !== 'ibc/F74225B0AFD2F675AF56E9BE3F235486BCDE5C5E09AA88A97AFD2E052ABFE04C'
  )
  const assetsWtihLogo = supportedChainAssets?.map((asset) => assetWithLogo(asset, chainID)) || []

  return [...assetsWtihLogo, ...lpAssets]
}

export const getAssetBySymbol = (symbol: string, chainID: string = DEFAULT_CHAIN) => {
  const assets = getAssets(chainID)
  return assets?.find((asset) => asset.symbol === symbol)
}

export const getAssetByDenom = (denom: string, chainID: string = DEFAULT_CHAIN) => {
  const assets = getAssets(chainID)
  console.log(chainID, "assets", assets);
  return assets?.find((asset) => asset.base === denom)
}

export const getAssetsByDenom = (denoms: string[], chainID: string = DEFAULT_CHAIN) => {
  const assets = getAssets(chainID)
  return assets?.filter((asset) => denoms.includes(asset.base))
}
