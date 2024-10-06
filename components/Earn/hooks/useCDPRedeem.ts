import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import useEarnState from './useEarnState'
import { shiftDigits } from '@/helpers/math'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'
import { denoms } from '@/config/defaults'

import useBalance from '@/hooks/useBalance'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import { useOraclePrice } from '@/hooks/useOracle'
import { useBasket } from '@/hooks/useCDP'
import { num } from '@/helpers/num'

const useCDPRedeem = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_page_management_redeem_msg_creation',
      address,
      earnState.redeemAmount,
      prices,
      basket
    ],
    queryFn: () => {
      if (!address || !earnState.redeemAmount) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let messageComposer = new PositionsMsgComposer(address, contracts.cdp)
      const redemptionAmount = shiftDigits(earnState.redeemAmount, 6).dp(0).toNumber().toString()
      const funds = [{ amount: redemptionAmount, denom: denoms.CDT[0].toString() }]
      let redeemMsg = messageComposer.redeemCollateral({ maxCollateralPremium: "1" }, funds)
      msgs.push(redeemMsg)
      
      /////How many marsUSDC VT tokens will we redeem at a 1% discount using the CDT paid?///
      //CDT peg price * 99% * cdtAmount = value redeemed
      const cdtRedemptionPrice = num(basket?.credit_price.price??"0").multipliedBy(0.99)
      const valueRedeemed = cdtRedemptionPrice.multipliedBy(redemptionAmount)

      //valueRedeemed / marsUSDC VT token price = VT tokens redeemed
      const vtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.price ?? "0")
      const vtTokensRedeemed = valueRedeemed.dividedBy(vtPrice)

      console.log("vt tokens redeemed", vtTokensRedeemed.toString(), "vt price", vtPrice.toString(), "prices", prices)

      //VT Withdraw Msg
      const fundsVT = [{ amount: vtTokensRedeemed.toString(), denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized" }]
      let withdrawMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
        sender: address,
        contract: contracts.marsUSDCvault,
        msg: toUtf8(JSON.stringify({
            exit_vault: {}
        })),
        funds: fundsVT
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(withdrawMsg)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("redeem msg:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['useVaultInfo'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn_page_management_redeem', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useCDPRedeem
