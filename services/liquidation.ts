import contracts from '@/config/contracts.json'
import {
  LiquidationQueueClient,
  LiquidationQueueQueryClient,
} from '@/contracts/codegen/liquidation_queue/LiquidationQueue.client'
import { LiquidationQueueMsgComposer } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.message-composer'
import { ClaimsResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { Addr } from '@/contracts/generated/positions/Positions.types'

import { Asset } from '@/helpers/chain'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { shiftDigits } from '@/helpers/math'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { Coin } from '@cosmjs/stargate'

export const liquidationClient = async (rpcUrl: string) => {
  console.log("liquidation CW client")
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return new LiquidationQueueQueryClient(cosmWasmClient, contracts.liquidation)
}

export const getSigningLiquidationClient = (
  signingClient: SigningCosmWasmClient,
  address: Addr,
) => {
  return new LiquidationQueueClient(signingClient, address, contracts.liquidation)
}

export const getLiquidationQueue = async (asset: Asset, rpcUrl: string) => {
  const client = await liquidationClient(rpcUrl)
  return client.premiumSlots({
    bidFor: {
      native_token: {
        denom: asset.base,
      },
    },
  })
}
export const getQueue = async (asset: Asset, rpcUrl: string) => {
  const client = await liquidationClient(rpcUrl)
  return client.queue({
    bidFor: {
      native_token: {
        denom: asset.base,
      },
    },
  })
}

export const getAllQueues = async (rpcUrl: string) => {
  const client = await liquidationClient(rpcUrl)
  return client.queues({ limit: 256 })
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
  const bidInput = getBidInput(asset.base, liqPremium)
  return messageComposer.submitBid({ bidInput }, funds)
}

type UpdateBidMsg = {
  address: Addr
  denom: string
  funds?: Coin[]
}
export const buildUpdateBidMsg = ({ address, denom, funds = [] }: UpdateBidMsg) => {
  const messageComposer = new LiquidationQueueMsgComposer(address, contracts.liquidation)
  return messageComposer.updateQueue(
    {
      bidFor: {
        native_token: {
          denom,
        },
      },
    },
    funds,
  )
}

type RetractBidMsg = {
  address: Addr
  bidId: string
  denom: string
  amount?: string
}
export const buildRetractBidMsg = ({ address, denom, bidId, amount }: RetractBidMsg) => {
  const messageComposer = new LiquidationQueueMsgComposer(address, contracts.liquidation)
  return messageComposer.retractBid({
    bidFor: {
      native_token: {
        denom,
      },
    },
    bidId,
    amount,
  })
}

export const getUserBids = async (address: Addr, rpcUrl: string, denom?: string) => {
  const client = await liquidationClient(rpcUrl)

  if (!denom) return

  const bidFor = {
    native_token: {
      denom,
    },
  }

  // let userBids = [];
  // //Query every premium slot
  // for (let i = 0; i <= 10; i++) {
  //   const slot = await client.premiumSlot({ bidFor, premium: i })
  //   if (slot.bids.length > 0) {
  //     for (let j = 0; j < slot.bids.length; j++) {
  //       const bid = slot.bids[j]
  //       if (bid.user === address) {
  //         userBids.push(bid)
  //       }
  //     }
  //   }
  // }

  // return userBids

  return client.bidsByUser({
    bidFor,
    user: address,
  })
}

export const getUserClaims = async (address: Addr, rpcUrl: string) => {
  const client = await liquidationClient(rpcUrl)

  return client.userClaims({
    user: address,
  })
}

export const claimstoCoins = (claims: ClaimsResponse[] = []) => {
  return claims.map((claim) => {
    return {
      denom: claim.bid_for,
      amount: claim.pending_liquidated_collateral,
    }
  })
}