import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useEffect, useMemo, useState } from 'react'

import contracts from '@/config/contracts.json'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import useQuickActionState from './useQuickActionState'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useCDTVaultTokenUnderlying } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import useNeuroState from "./useNeuroState"
import { useBasket } from "@/hooks/useCDP"


import EventEmitter from 'events';
import { getCookie, setCookie } from '@/helpers/cookies'
import useAppState from '@/persisted-state/useAppState'
import { denoms } from '@/config/defaults'
EventEmitter.defaultMaxListeners = 25; // Increase the limit

const useNeuroGuard = ({ onSuccess, run }: { onSuccess: () => void, run: boolean }) => {
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { appState } = useAppState()
  const { neuroState } = useNeuroState()

  // console.log('above neuro', neuroState.openSelectedAsset);

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'neuroGuard_msg_creation',
      address,
      neuroState.openSelectedAsset,
      basket,
      run
    ],
    queryFn: () => {
      console.log("in query guardian", neuroState.openSelectedAsset)


      if (!run || !address || !neuroState.openSelectedAsset || (neuroState.openSelectedAsset && neuroState.openSelectedAsset?.sliderValue == 0) || !basket) { console.log("neuroGuard early return", address, neuroState, basket); return { msgs: [] } }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      const newDeposit = num(neuroState.openSelectedAsset.sliderValue).toNumber()
      // const amount = shiftDigits(num(newDeposit).dividedBy(neuroState.openSelectedAsset.price).toString(), neuroState.openSelectedAsset.decimal).toFixed(0)
      const amount = shiftDigits(newDeposit, neuroState.openSelectedAsset.decimal).toFixed(0)
      console.log("Neuro funds", newDeposit, amount, neuroState.openSelectedAsset)
      const funds = [{ amount, denom: neuroState.openSelectedAsset.base }]
      console.log(funds)

      //Deposit msg
      let depositMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(JSON.stringify({
            deposit: {}
          })),
          funds: funds
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(depositMsg)

      //Mint msg 
      const ltv = neuroState.openSelectedAsset.symbol === "USDC" ? 0.89 : 0.8
      //Add vault intent
      let mintMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(JSON.stringify({
            set_user_intents: {
              mint_intent: {
                user: address,
                position_id: basket.current_position_id,
                mint_to_ltv: num(neuroState.openSelectedAsset?.maxBorrowLTV).times(ltv).toString()
              }
            }
          })),
          funds: []
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(mintMsg)

      //Fulfill intent thru CDP to set the intent on the RBLP vault & mint the initial CDT
      let fulfillIntentMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(JSON.stringify({
            fulfill_intents: {
              users: [address],
            }
          })),
          funds: []
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(fulfillIntentMsg)


      console.log("in query guardian msgs:", msgs)

      return { msgs }
    },
    enabled: !!address,
    // staleTime: 5000,
    // Disable automatic refetching
    // refetchOnWindowFocus: false,
    // refetchOnReconnect: false,
    // refetchOnMount: false,
    // retry: false
    /////ERRORS ON THE 3RD OR 4TH MODAL OPEN, CHECKING TO SEE IF ITS THE INVALIDATED QUERY////
  })

  // console.log("neuroGuard msgs:", "enabled", !!address)
  const msgs = queryData?.msgs ?? []

  // console.log("neuroGuard msgs:", msgs)

  const cookie = getCookie("neuroGuard " + basket?.current_position_id)

  const onInitialSuccess = () => {
    if (cookie == null && appState.setCookie) setCookie("neuroGuard " + basket?.current_position_id, (neuroState?.openSelectedAsset?.sliderValue ?? 0).toString(), 3650)
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['useUserBoundedIntents'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_neuroGuard', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useNeuroGuard