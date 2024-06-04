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

export type Price = {
  price: string
  denom: string
}

export const parsePrice = (prices: PriceResponse[], assetInfos: AssetInfo[]): Price[] => {
  console.log("HELLLLLLLLO")
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
  const cdtAssetInfo = {
    native_token: {
      denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
    },
  }
  const mbrnAssetInfo = {
    native_token: {
      denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/umbrn',
    },
  }

  const collateralAssets = basket.collateral_types.map((collateral) => collateral.asset.info)

  return [mbrnAssetInfo, cdtAssetInfo, ...collateralAssets] as AssetInfo[]
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
  
  console.log("right before query & parse")
  return client.prices(params).then((prices) => parsePrice(prices, assetInfos))
}
