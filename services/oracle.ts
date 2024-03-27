import { OracleQueryClient } from '@/contracts/codegen/oracle/Oracle.client'
import contracts from '@/config/contracts.json'
import collateralAssets from '@/config/collateralAssets.json'
import { AssetInfo, PriceResponse } from '@/contracts/codegen/oracle/Oracle.types'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { queryClient } from '@/pages/_app'

type CollateralAssets = {
  symbol: string
  denom: string
  isNative: boolean
}

export const oracleClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new OracleQueryClient(cosmWasmClient, contracts.oracle)
}

export const getAssetsInfo = () => {
  return collateralAssets.map((asset: CollateralAssets) => {
    return {
      native_token: {
        denom: asset.denom,
      },
    }
  }) as AssetInfo[]
}

export type Price = {
  price: string;
  symbol: string;
  denom: string;
  isNative: boolean;
}

export const parsePrice = (prices: PriceResponse[]): Price[] => {
  return prices.flatMap((price, index) => {
    const asset = collateralAssets[index] as CollateralAssets
    return {
      ...asset,
      price: price.price,
    }
  })
}

export const getPriceByDenom = (denom: string) => {
    const prices = queryClient.getQueryData(['oraclePrice']) as any[]
    return prices?.find((price) => price.denom === denom)
}



export const getOraclePrices = async () => {
  const assetInfos = getAssetsInfo()
  const oracleTimeLimit = 10
  const twapTimeframe = 0

  const client = await oracleClient()
  const params = {
    assetInfos,
    oracleTimeLimit,
    twapTimeframe,
  }

  return client.prices(params).then(parsePrice)
}
