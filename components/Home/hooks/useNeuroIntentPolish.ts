import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useUserBoundedIntents } from '@/components/Earn/hooks/useEarnQueries'
import useUserIntentState from '@/persisted-state/useUserIntentState'
import { UserIntentData } from './useNeuroClose'
import { useUserPositions } from '@/hooks/useCDP'

function redistributeYield(intent: UserIntentData, newPurchaseIntents: any[]) {
  //Get the number of intents
  const intentsNum = newPurchaseIntents.length
  //Get the percent to set per intent
  const percentToSet = 1 / intentsNum
  //Change the intents to the new percent
  const updatedIntents = newPurchaseIntents.map(intent => {
    return { ...intent, yield_percent: percentToSet.toString() }
  })

  return { intents: { ...intent.intents, purchase_intents: updatedIntents } }
}

//This cleans up the yield percent of the intents to properly distribute the 100% evenly.
//When ledger's use their NeuroClose
const useNeuroIntentPolish = () => {
  const { address } = useWallet()
  const { data: userIntents } = useUserBoundedIntents()
  const { reset: resetIntents } = useUserIntentState()
  const { data: userPositions } = useUserPositions()
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'neuro_intent_polish',
      address,
      userIntents,
      userPositions
    ],
    queryFn: () => {
      //   const guardedAsset = useAssetBySymbol(debouncedValue.position_to_close.symbol)

      if (!address || !userIntents || !userPositions) { console.log("neuro Polish early return", address, userIntents, userPositions); return { msgs: [] } }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      const totalPercent = userIntents[0].intent.intents.purchase_intents
        .map(intent => intent.yield_percent)
        .reduce((acc, curr) => acc + Number(curr), 0)

      //Filter out the purchase intents that don't existing positions.
      //This is to ensure that the intents are only for existing positions.
      const newPurchaseIntents = userIntents[0].intent.intents.purchase_intents.filter(intent => {
        return !intent.position_id || userPositions[0].positions.find(position => position.position_id === (intent.position_id ?? 0).toString())
      })

      console.log("newPurchaseIntents", newPurchaseIntents)
      //1a) Split the yield_percent split from this intent to the remaining intents
      // & set intents to the new split
      //1b) Update intents
      // We only Update if there was more than 1 intent && the percentToClose is 100%
      // , otherwise we let the remainder (1 CDT) compound into whatever the previous intent was
      if (userIntents[0]) {

        // console.log("updatedIntent data", updatedIntents)
        if (newPurchaseIntents.length > 0) {
          //Update intents
          const updatedIntents = redistributeYield(userIntents[0].intent, newPurchaseIntents)
          //Create the msg to update the intents
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



      // console.log("in query guardian msgs:", msgs)

      return { msgs }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  // console.log("neuroClose msgs:", msgs)


  const onInitialSuccess = () => {
    resetIntents()
    queryClient.invalidateQueries({ queryKey: ['useUserBoundedIntents'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }


  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_intent_polish', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useNeuroIntentPolish
