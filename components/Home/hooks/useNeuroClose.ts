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

export type UserIntentData = {
    vault_tokens: string,
    intents: {
      user: string, 
      last_conversion_rate: string,
      purchase_intents: {
        desired_asset: string,
        route: any | undefined,
        yield_percent: string,
        position_id: number | undefined,
        slippage: string | undefined
      }[]
    }
}

/**
 * Removes a specified position and redistributes its yield percentage among remaining intents
 * @param data Original vault data
 * @param positionIdToRemove Position ID to remove
 * @returns Updated vault data with redistributed yields
 */
function redistributeYield(data: UserIntentData, positionIdToRemove: number): UserIntentData {  
  // Create a deep copy of the data to avoid mutations
  const newData: UserIntentData = JSON.parse(JSON.stringify(data));
  
  const intents = newData.intents.purchase_intents;
  
  console.log("here")
  const positionIndex = intents.findIndex(intent => intent.position_id !== undefined && intent.position_id === positionIdToRemove);
  
  // If position not found, return original data
  if (positionIndex === -1) {
    return data;
  }
  console.log("here1")
  
  // Get the yield percentage that needs to be redistributed
  const yieldToRedistribute = parseFloat(intents[positionIndex].yield_percent);
  
  // Remove the position
  intents.splice(positionIndex, 1);
  console.log("here2")
  
  // If there are no remaining intents, return the data
  if (intents.length === 0) {
    return newData;
  }
  
  // Calculate the additional yield each remaining intent will receive
  const additionalYieldPerIntent = yieldToRedistribute / intents.length;
  
  console.log("here3")
  // Redistribute the yield
  intents.forEach(intent => {
    const currentYield = parseFloat(intent.yield_percent);
    intent.yield_percent = (currentYield + additionalYieldPerIntent).toString();
  });

  newData.intents.purchase_intents = intents;
  console.log("here4")
  
  return newData;
}

const useNeuroClose = ({ position } : { position: PositionResponse }) => { 
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const assets = useCollateralAssets()
  // const { neuroState, setNeuroState } = useNeuroState()
  const { data: userIntents } = useBoundedIntents()

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

      console.log("neuroClose position:", position)
      //1) Repay using intented VTs
      // Leave 1 CDT to allow the ClosePosition to never fail
      if (Number(position.credit_amount) > 1000000) {
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
      }
      //2) Close Position
      
      if (Number(position.credit_amount) > 0) {
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
      }
      //3) Split the yield_percent split from this intent to the remaining intents
      // & set intents to the new split
      const updatedIntents = redistributeYield(userIntents[0].intent, Number(position.position_id))
      console.log("updatedIntent data", updatedIntents)
      const updatedIntentsMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
        sender: address,
        contract: contracts.rangeboundLP,
        msg: toUtf8(JSON.stringify({
          set_user_intents: {
              intents: {                
                user: address,
                last_conversion_rate: "0", //this isn't updated
                purchase_intents: updatedIntents.intents.purchase_intents
              },
            }
        })),
        funds: []
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(updatedIntentsMsg)      

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
  
  const  msgs = queryData?.msgs ?? []

  console.log("neuroClose msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['useBoundedIntents'] })   
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