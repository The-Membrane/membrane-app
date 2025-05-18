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
import { useBoundedIntents, useCDTVaultTokenUnderlying, useUserBoundedIntents } from '@/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import useNeuroState from "./useNeuroState"
import { useBasket } from "@/hooks/useCDP"

import useCollateralAssets from '@/components/Bid/hooks/useCollateralAssets'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { getAssetByDenom } from '@/helpers/chain'
import { deleteCookie, getCookie, setCookie } from '@/helpers/cookies'
import { useChainRoute } from '@/hooks/useChainRoute'

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

  const positionIndex = intents.findIndex(intent => intent.position_id !== undefined && intent.position_id === positionIdToRemove);

  // If position not found, return original data
  if (positionIndex === -1) {
    return data;
  }

  // Get the yield percentage that needs to be redistributed
  const yieldToRedistribute = parseFloat(intents[positionIndex].yield_percent);

  // Remove the position
  intents.splice(positionIndex, 1);

  // If there are no remaining intents, return the data
  if (intents.length === 0) {
    return newData;
  }

  // Calculate the additional yield each remaining intent will receive
  const additionalYieldPerIntent = yieldToRedistribute / intents.length;

  // Redistribute the yield
  intents.forEach(intent => {
    const currentYield = parseFloat(intent.yield_percent);
    intent.yield_percent = (currentYield + additionalYieldPerIntent).toString();
  });

  newData.intents.purchase_intents = intents;

  return newData;
}

const useNeuroClose = ({ position, onSuccess, ledger, run }: { position: PositionResponse, onSuccess: () => void, ledger: boolean, run: boolean }) => {
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const assets = useCollateralAssets()
  const { neuroState } = useNeuroState()
  const { data: userIntents } = useUserBoundedIntents()
  //Get asset by symbol
  const collateralAsset = position.collateral_assets[0].asset
  //@ts-ignore
  const { chainName } = useChainRoute()
  const assetInfo = getAssetByDenom(collateralAsset.info.native_token.denom, chainName)

  //Get cookie for the position_id. If cookie exists, we add the deposit to it.
  const cookie = getCookie("neuroGuard " + position.position_id)
  //parse the cookie
  const cookiedDepositAmount = num(cookie ?? "0").toNumber()
  //set withdraw amount
  const newCookieAmount =
    neuroState.withdrawSelectedAsset?.sliderValue && neuroState.withdrawSelectedAsset?.sliderValue > 0 && cookiedDepositAmount > 0
      ? num(cookiedDepositAmount).minus(neuroState.withdrawSelectedAsset?.sliderValue).toNumber()
      : undefined;

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'neuroClose_msg_creation',
      address,
      position.position_id,
      basket,
      assets,
      userIntents,
      assetInfo,
      neuroState.withdrawSelectedAsset?.sliderValue,
      run
    ],
    queryFn: () => {
      //   const guardedAsset = useAssetBySymbol(debouncedValue.position_to_close.symbol)

      if (!run || !address || !position || (position && position.position_id === "0") || !basket || !assets || !userIntents || !assetInfo || !neuroState.withdrawSelectedAsset?.sliderValue || (neuroState.withdrawSelectedAsset && neuroState.withdrawSelectedAsset?.sliderValue == 0)) {
        // console.log("neuroClose early return", address, position, basket, assets, userIntents, assetInfo, neuroState.withdrawSelectedAsset?.sliderValue); 
        return { msgs: [] }
      }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      //calc the % of the position to close     
      //@ts-ignore
      const maxAmount = shiftDigits(collateralAsset.amount, -assetInfo?.decimal).toNumber()
      const percentToClose = num(maxAmount).dividedBy(neuroState.withdrawSelectedAsset?.sliderValue).toString()
      var debtToRepay = num(position.credit_amount).times(percentToClose).toString()
      const remainingDebt = num(position.credit_amount).minus(debtToRepay).toString()
      // Leave 1 CDT to ensure ClosePosition never fails
      if (Number(remainingDebt) < 1000000) { debtToRepay = num(debtToRepay).minus(1000000).toString() }

      console.log("neuroClose position:", position)
      //1) Repay using intented VTs
      if (Number(debtToRepay) > 1000000) {
        let intentRepayMsg = {
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
                repayment: debtToRepay
              }
            })),
            funds: []
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(intentRepayMsg)
      }

      //2) Close Position
      //This execution flow doesn't work for undebted positions
      if (Number(position.credit_amount) > 0) {
        let closeMsg = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: contracts.cdp,
            msg: toUtf8(JSON.stringify({
              close_position: {
                position_id: position.position_id,
                max_spread: "0.02",
                close_percentage: percentToClose,
              }
            })),
            funds: []
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(closeMsg)
      }
      //3) Split the yield_percent split from this intent to the remaining intents
      // & set intents to the new split
      //4) Update intents
      // We only Update if there was more than 1 intent && the percentToClose is 100%
      // , otherwise we let the remainder (1 CDT) compound into whatever the previous intent was
      if (userIntents && userIntents[0] && percentToClose === "1") {

        const updatedIntents = redistributeYield(userIntents[0].intent, Number(position.position_id))
        // console.log("updatedIntent data", updatedIntents)
        if (updatedIntents.intents.purchase_intents.length > 0) {
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
        } else {
          //If there are no intents left, we withdraw the remaining vault tokens
          const clearIntentsMsg = {
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
            value: MsgExecuteContract.fromPartial({
              sender: address,
              contract: contracts.rangeboundLP,
              msg: toUtf8(JSON.stringify({
                set_user_intents: {
                  reduce_vault_tokens: {
                    exit_vault: true,
                    amount: "10000000000000000" //big number so that the execution uses the max from state instead
                  }
                }
              })),
              funds: []
            })
          } as MsgExecuteContractEncodeObject
          msgs.push(clearIntentsMsg)

        }
      }

      console.log("in query guardian msgs:", msgs)

      return { msgs }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  // console.log("neuroClose msgs:", msgs)

  //Pop the last msg if ledger
  if (ledger && msgs.length > 2) msgs.pop()


  const onInitialSuccess = () => {
    newCookieAmount && newCookieAmount > 0 ? setCookie("neuroGuard " + position.position_id, newCookieAmount.toString(), 3650) : deleteCookie("neuroGuard " + position.position_id)
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['useUserBoundedIntents'] })
  }





  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_neuroClose', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useNeuroClose
