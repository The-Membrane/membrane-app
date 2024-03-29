import contracts from '@/config/contracts.json'
import { LaunchClient, LaunchQueryClient } from '@/contracts/codegen/launch/Launch.client'
import { UserRatio } from '@/contracts/codegen/launch/Launch.types'
import { LiquidationQueueQueryClient } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.client'
import { LiquidationQueueMsgComposer } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.message-composer'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import { Asset, getAssetBySymbol } from '@/helpers/chain'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { shiftDigits } from '@/helpers/math'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { Coin, coin } from '@cosmjs/stargate'

export const liquidationClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new LiquidationQueueQueryClient(cosmWasmClient, contracts.liquidation)
}

export const getLiquidationQueue = async (asset: Asset) => {
  const client = await liquidationClient()
  return client.premiumSlots({
    bidFor: {
      native_token: {
        denom: asset.base,
      },
    },
  })
}
export const getQueue = async (asset: Asset) => {
  const client = await liquidationClient()
  return client.queue({
    bidFor: {
      native_token: {
        denom: asset.base,
      },
    },
  })
}

type BidMsg = {
  address: Addr
  asset: Asset
  liqPremium: number
  funds?: Coin[]
}

const getBidInput = (denom: string, liq_premium: number) => {
  return {
    bid_for: {
      native_token: {
        denom,
      },
    },
    liq_premium,
  }
}

export const buildBidMsg = ({ address, asset, liqPremium, funds = [] }: BidMsg) => {
  const messageComposer = new LiquidationQueueMsgComposer(address, contracts.liquidation)
  // const microAmount = shiftDigits(amount, asset.decimal).dp(0).toString()
  // const funds = [coin(microAmount, asset.base)]
  const bidInput = getBidInput(asset.base, liqPremium)
  return messageComposer.submitBid({ bidInput }, funds)
}
