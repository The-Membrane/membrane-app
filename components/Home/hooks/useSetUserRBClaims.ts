import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";


import { useUserConversionRates } from '@/hooks/usePoints'
import { useMemo } from 'react'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { num } from '@/helpers/num'

const useSetUserRBClaims = () => {
    const { address } = useWallet()
    const { data: userRates } = useUserConversionRates()
    const boundCDTAsset = useAssetBySymbol('range-bound-CDT')
    const boundCDTBalance = useBalanceByAsset(boundCDTAsset) ?? "0"

    // //Toast if a msg is ever ready to rock
    const hasRangeBoundRate = useMemo(() => {
        //Check if user rates has a Range Bound rate saved
        if (userRates && userRates.length > 0) {
            return userRates[0].conversion_rates.find(rate => rate.vault_address === contracts.rangeboundLP);
        } else {
            return null;
        }
    }, [userRates])

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    //If it has a range bound rate or it isn't deposited into the range bound vault, return early
    const { data: queryData } = useQuery<QueryData>({
        queryKey: ['toaster_set_RB_claim_msg_creator', hasRangeBoundRate, address, boundCDTBalance],
        queryFn: async () => {
            if (hasRangeBoundRate || !address || num(boundCDTBalance).isZero()) { console.log("set RB point claim early return", address, hasRangeBoundRate, boundCDTBalance); return { msgs: [] } }

            var msgs = [] as MsgExecuteContractEncodeObject[]
            msgs.push({
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.points,
                    msg: toUtf8(JSON.stringify({
                        check_claims: {
                            sp_claims: false,
                            lq_claims: false,
                            rangebound_user: address
                        }
                    })),
                    funds: []
                })
            } as MsgExecuteContractEncodeObject
            )

            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    console.log("set RB point claim msgs", msgs)

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['toaster_set_RB_claim_sim', (msgs?.toString() ?? "0")],
            enabled: !!msgs,
        })
    }
}

export default useSetUserRBClaims