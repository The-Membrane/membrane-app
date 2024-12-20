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
import { useBoundedIntents, useCDTVaultTokenUnderlying } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import useNeuroState from "./useNeuroState"
import { useBasket } from "@/hooks/useCDP"

import useCollateralAssets from '@/components/Bid/hooks/useCollateralAssets'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'

const useNeuroClose = ({ position } : { position: PositionResponse }) => { 
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const assets = useCollateralAssets()
  // const { neuroState, setNeuroState } = useNeuroState()
  const { data: userIntents } = useBoundedIntents()

  // Debounce the slider value to prevent too many queries
  // const [debouncedValue, setDebouncedValue] = useState<{position_to_close: number | undefined}>(
  //   {position_to_close: undefined}
  // );
  
  // useEffect(() => {
  //   console.log('Debounce effect triggered:', neuroState);
  //   const timer = setTimeout(() => {
  //     console.log('Setting debounced values:', neuroState);
  //     setDebouncedValue({
  //       position_to_close: neuroState.position_to_close
  //     });
  //   }, 300);
    
  //   return () =>{
  //     console.log('Cleaning up debounce effect');
  //      clearTimeout(timer)
  //     };
  // }, [neuroState.position_to_close]);

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'neuroClose_msg_creation',
      address,
      position,
      basket,
      assets,
      userIntents
    ],
    queryFn: () => {
    //   const guardedAsset = useAssetBySymbol(debouncedValue.position_to_close.symbol)

      if (!address || !position || !basket || !assets || !userIntents) {console.log("neuroClose early return", address, position, basket, assets, userIntents); return { msgs: [] }}
      var msgs = [] as MsgExecuteContractEncodeObject[]

      //Find the user intent for the position to close
      // const guardedIntent = userIntents[0].intent.intents.purchase_intent.find((intent: any) => intent?.position_id === position.position_id)!
      // //Calc the amount of vault tokens this intent holds
      // const guardedTokens = num(guardedIntent.yield_percent).times(userIntents[0].intent.vault_tokens).toFixed(0)


      //1) Repay using intented VTs
      // Leave 1 CDT to allow the ClosePosition to never fail
      let intentRepayMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.rangeboundLP,
          msg: toUtf8(JSON.stringify({
            repay_user_debt: {
                user_info: {
                  position_owner: address, 
                  position_id: position.position_id
                },
                repayment: num(position.credit_amount).minus(1000000).toString(),
              }
          })),
          funds: []
          })
      } as MsgExecuteContractEncodeObject
      msgs.push(intentRepayMsg)      
      //2) Close Position
      let closeMsg  = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
        sender: address,
        contract: contracts.cdp,
        msg: toUtf8(JSON.stringify({
          close_position: {            
            position_id: position.position_id,
            max_spread: "0.02"
          }
        })),
        funds: []
        })
    } as MsgExecuteContractEncodeObject
    msgs.push(closeMsg) 
      

      console.log("in query guardian msgs:", msgs)
      
      return { msgs }
    },
    enabled: !!address && !!position.position_id,
    staleTime: 5000,
    // Disable automatic refetching
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false
    /////ERRORS ON THE 3RD OR 4TH MODAL OPEN, CHECKING TO SEE IF ITS THE INVALIDATED QUERY////
  })
  
  const  msgs = queryData?.msgs ?? []

  console.log("neuroClose msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['home_page_neuroClose', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useNeuroClose