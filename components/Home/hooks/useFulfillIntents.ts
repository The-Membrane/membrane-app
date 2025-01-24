import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useBoundedCDTVaultTokenUnderlying, useBoundedIntents } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'


import EventEmitter from 'events';
EventEmitter.defaultMaxListeners = 25; // Increase the limit

const useFulfillIntents = (run: boolean) => {
    const { address } = useWallet()
    //Get users' intents
    const { data: intents } = useBoundedIntents()
    //Get current conversion rate
    const { data: currentConversionRate } = useBoundedCDTVaultTokenUnderlying("1000000000000")

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: ['fillIntents_msg_creator', intents, currentConversionRate, run],
        queryFn: async () => {
            if (!intents || !currentConversionRate || !run) { console.log("fulfill intents early return", address, intents, currentConversionRate, run); return { msgs: [] } }

            var msgs = [] as MsgExecuteContractEncodeObject[]

            //Parse user intents, if any last_conversion_rates are above the current rate, add a fill_intent msg
            intents.forEach((intent: any) => {
                console.log("intent logs", intent, intent.intent.intents.last_conversion_rate, currentConversionRate)
                //we cap msg length in order to allow ledgers to sign the transaction
                if (num(currentConversionRate).isGreaterThan(intent.intent.intents.last_conversion_rate) && intent.intent.intents.purchase_intents.length > 0 && msgs.length < 2) {
                    msgs.push({
                        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                        value: MsgExecuteContract.fromPartial({
                            sender: address,
                            contract: contracts.rangeboundLP,
                            msg: toUtf8(JSON.stringify({
                                ful_fill_user_intents: {
                                    user: intent.user,
                                }
                            })),
                            funds: []
                        })
                    } as MsgExecuteContractEncodeObject
                    )
                }
            })


            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    console.log("fulfillment msgs:", msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['useBoundedIntents'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['dashboard_fulfillment', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useFulfillIntents