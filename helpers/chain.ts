import { getEvmTokens, type EvmToken } from '@/config/evm/tokens'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * Asset identity — EVM-backed (config/evm/tokens.ts), same export surface the app
 * has always consumed. Was: chain-registry (Cosmos).
 *
 * `base` is the ERC-20 address (or 'native'), keeping the "find by asset.base"
 * pattern used across components working unchanged. The index signature absorbs
 * legacy chain-registry field access (denom_units, logo_URIs, …) in files that
 * are still mid-migration; those reads return undefined.
 *
 * Legacy chainID string params ('osmosis', 'neutron', …) are accepted and ignored —
 * the app is single-EVM-chain; they map to DEFAULT_EVM_CHAIN.
 */
export type Asset = {
  base: string
  symbol: string
  name: string
  decimal: number
  logo: string
  isLP: boolean
  [key: string]: any
}

/** @deprecated Osmosis swap-route helper — kept for legacy imports (useLP, services/osmosis) until those files are removed in the component-layer wave. */
export interface exported_supportedAssets {
  OSMO: undefined
  ATOM: undefined
  TIA: undefined
  CDT: undefined
  MBRN: undefined
  stOSMO: undefined
  stATOM: undefined
  USDT: undefined
  USDC: undefined
  'USDC.axl': undefined
  WBTC: undefined
  'WBTC.axl': undefined
  ETH: undefined
  INJ: undefined
}

const toAsset = (t: EvmToken): Asset => ({
  base: t.address,
  symbol: t.symbol,
  name: t.name,
  decimal: t.decimals,
  logo: t.logo ?? '',
  isLP: t.isLP ?? false,
})

export const getAssetLogo = (asset: Asset | { logo?: string } | null | undefined) =>
  asset?.logo || ''

export const getChainAssets = (_legacyChainID?: string) =>
  getEvmTokens(DEFAULT_EVM_CHAIN.id).map(toAsset)

export const getAssets = (_legacyChainID?: string) =>
  getEvmTokens(DEFAULT_EVM_CHAIN.id).map(toAsset)

export const getAssetBySymbol = (symbol: string, _legacyChainID?: string) => {
  const assets = getAssets()
  return assets?.find((asset) => asset.symbol === symbol)
}

export const getAssetByDenom = (denom: string, _legacyChainID?: string) => {
  const assets = getAssets()
  return assets?.find((asset) => asset.base === denom)
}

export const getAssetsByDenom = (denoms: string[], _legacyChainID?: string) => {
  const assets = getAssets()
  return assets?.filter((asset) => denoms.includes(asset.base))
}
