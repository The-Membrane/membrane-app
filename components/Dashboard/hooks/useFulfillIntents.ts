import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useBoundedCDTVaultTokenUnderlying, useBoundedIntents } from '@/hooks/useEarnQueries'
import { num } from '@/helpers/num'


import { PurchaseIntent } from '@/services/earn'
import { useRouter } from 'next/router'
const MINIMUM_YIELD = 10000;

const useFulfillIntents = ({ run, skipIDs }: { run: boolean, skipIDs: number[] }) => {
    const { address } = useWallet()
    //Get users' intents
    const { data: intents } = useBoundedIntents()
    //Get current conversion rate
    const { data: currentConversionRate } = useBoundedCDTVaultTokenUnderlying("1000000000000")
    const router = useRouter()

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: ['fillIntents_msg_creator', intents, currentConversionRate, run, skipIDs, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/dashboard") return { msgs: [] }
            if (!intents || !currentConversionRate || !run) {
                //  console.log("fulfill intents early return", address, intents, currentConversionRate, run); 
                return { msgs: [] }
            }

            var msgs = [] as MsgExecuteContractEncodeObject[]

            //Parse user intents, if any last_conversion_rates are above the current rate, add a fill_intent msg
            intents.forEach((intent: any) => {
                console.log("intent logs", intent, intent.intent.intents.last_conversion_rate, currentConversionRate)
                //we cap msg length in order to allow ledgers to sign the transaction.
                //We skipIDs that would cause errors
                if (num(currentConversionRate).isGreaterThan(Number(intent.intent.intents.last_conversion_rate) + MINIMUM_YIELD)
                    && !intent.intent.intents.purchase_intents.some((intent: PurchaseIntent) => skipIDs.includes(intent.position_id ?? 0))
                    && intent.intent.intents.purchase_intents.length > 0 && msgs.length < 2) {
                    console.log("intent for msg", intent)
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
            console.log("skipIDs", skipIDs)


            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    // console.log("msgs", msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['fillIntents_msg_creator'] })
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