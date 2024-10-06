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

const useCDPRedeem = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_page_management_redeem_msg_creation',
      address,
      earnState.redeemAmount
    ],
    queryFn: () => {
      if (!address || !earnState.redeemAmount) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let messageComposer = new PositionsMsgComposer(address, contracts.cdp)
      const funds = [{ amount: shiftDigits(earnState.redeemAmount, 6).dp(0).toNumber().toString(), denom: denoms.CDT[0].toString() }]
      let redeemMsg = messageComposer.redeemCollateral({ maxCollateralPremium: "1" }, funds)
      msgs.push(redeemMsg)
      
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

    //Refetch user balances   
    queryClient.refetchQueries({ queryKey: ['osmosis balances'] })

    //Use new VT token balances to withdraw from the marsUSDC vault
    const { data: balances } = useBalance()
    const vtBalance = balances.find((b: any) => b.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.amount
    // VT Withdraw Msg
    const funds = [{ amount: vtBalance.toString(), denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized" }]
    const withdrawVTMsg  = {
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: MsgExecuteContract.fromPartial({
      sender: address,
      contract: contracts.marsUSDCvault,
      msg: toUtf8(JSON.stringify({
          exit_vault: {}
      })),
      funds: funds
      })
    } as MsgExecuteContractEncodeObject
    const withdrawVTMsgs = [withdrawVTMsg]
    const action = useSimulateAndBroadcast({
      msgs: withdrawVTMsgs,
      queryKey: ['earn_page_marsUSDC_vault_withdrawal', (withdrawVTMsgs?.toString()??"0")],
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['osmosis balances'] }),
      enabled: !!withdrawVTMsgs,
    })
    action.tx.mutate()
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
