import { OracleQueryClient } from '@/contracts/codegen/oracle/Oracle.client'
import contracts from '@/config/contracts.json'
import { AssetInfo, PriceResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { queryClient } from '@/pages/_app'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { useOraclePrice } from '@/hooks/useOracle'

export const oracleClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new OracleQueryClient(cosmWasmClient, contracts.oracle)
}

export const cdtSpecificOracleClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new OracleQueryClient(cosmWasmClient, contracts.cdtOracle) //The main oracle has the wrong CDT price rn
}

export type Price = {
  price: string
  denom: string
}

export const parsePrice = (prices: PriceResponse[], assetInfos: AssetInfo[]): Price[] => {
  return prices.flatMap((price, index) => {
    const asset = assetInfos[index]
    return {
      denom: asset?.native_token?.denom,
      price: price.price,
    }
  })
}

export const getPriceByDenom = (denom: string) => {
  const { data: prices } = useOraclePrice()
  return prices?.find((price) => price.denom === denom)
}

const getAssetsInfo = (basket: Basket) => {
  // const cdtAssetInfo = {
  //   native_token: {
  //     denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
  //   },
  // }
  const mbrnAssetInfo = {
    native_token: {
      denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/umbrn',
    },
  }

  const collateralAssets = basket.collateral_types.map((collateral) => collateral.asset.info)

  return [mbrnAssetInfo, ...collateralAssets] as AssetInfo[]
}

export const getOracleConfig = async () => {

  const client = await oracleClient()
  return client.config()
}

export const getOracleAssetInfos = async (asset_infos: AssetInfo[]) => {

  const client = await oracleClient()
  const params = {
    assetInfos: asset_infos,
  }
  return client.assets(params)
}


export const getOraclePrices = async (basket: Basket) => {
  const assetInfos = getAssetsInfo(basket)
  const oracleTimeLimit = 10
  const twapTimeframe = 0

  const client = await oracleClient()
  const params = {
    assetInfos,
    oracleTimeLimit,
    twapTimeframe,
  }

  const cdtAssetInfo = {
    native_token: {
      denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
    },
  }
  const cdtClient = await cdtSpecificOracleClient()
  const cdtParams = {
    assetInfos: [cdtAssetInfo],
    oracleTimeLimit,
    twapTimeframe,
  }

  return (await client.prices(params).then((prices) => parsePrice(prices, assetInfos))).concat(await cdtClient.prices(cdtParams).then((prices) => parsePrice(prices, [cdtAssetInfo])))
}
