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
import { useAllConversionRates } from '@/hooks/usePoints'
import { UserConversionRateState } from '@/services/points'
import { useRouter } from 'next/router'

const MSG_CAP = undefined

const useGiveRBLPPoints = () => {
    const { address } = useWallet()
    //Get users' intents
    const { data: conversionRates } = useAllConversionRates()
    //Get current conversion rate
    const { data: currentConversionRate } = useBoundedCDTVaultTokenUnderlying("1000000000000")
    const router = useRouter()

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: ['rblp_points_allocation_msg_creator', conversionRates, currentConversionRate, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/dashboard") return { msgs: [] }
            if (!conversionRates || !currentConversionRate) {
                // console.log("give points early return", address, conversionRates, currentConversionRate); 
                return { msgs: [] }
            }
            // console.log("conversionRates", conversionRates, currentConversionRate)
            var msgs = [] as MsgExecuteContractEncodeObject[]

            //Parse user conversion rates, if any rblp conversion_rates are above the current rate, add a give_points msg
            conversionRates.forEach((userRates: UserConversionRateState) => {
                //we aren't going to cap msg length for ledgers (which is 3) but we'll cap it for gas at 9
                //Find rangebound contract in user rates
                const rblpRate = userRates.conversion_rates.find((rate) => rate.vault_address === contracts.rangeboundLP)
                // console.log("points booleans", currentConversionRate, rblpRate?.last_conversion_rate, Number(rblpRate?.last_conversion_rate ?? currentConversionRate), num(currentConversionRate).isGreaterThan(Number(rblpRate?.last_conversion_rate ?? currentConversionRate)), (MSG_CAP && msgs.length < MSG_CAP))

                //If rate is below current rate, add a give_points msg
                if (num(currentConversionRate).isGreaterThan(Number(rblpRate?.last_conversion_rate ?? currentConversionRate))
                    && (!MSG_CAP || MSG_CAP && msgs.length < MSG_CAP)) {

                    // console.log("userRateState for msg", userRates)

                    msgs.push({
                        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                        value: MsgExecuteContract.fromPartial({
                            sender: address,
                            contract: contracts.points,
                            msg: toUtf8(JSON.stringify({
                                give_points: {
                                    cdp_repayment: false,
                                    lq_claims: false,
                                    sp_claims: false,
                                    rangebound_user: userRates.user,
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

    console.log("rblp give points msgs", msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard_rblp_give_points'] })
        queryClient.invalidateQueries({ queryKey: ['rblp_points_allocation_msg_creator'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['dashboard_rblp_give_points', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useGiveRBLPPoints