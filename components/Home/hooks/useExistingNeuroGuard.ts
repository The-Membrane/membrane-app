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
import { getCookie } from '@/helpers/cookies'
EventEmitter.defaultMaxListeners = 25; // Increase the limit

const useExistingNeuroGuard = ({ position_id, onSuccess, run }: { position_id: string, onSuccess: () => void, run: boolean }) => {
    const { address } = useWallet()
    const { data: basket } = useBasket()
    const { neuroState } = useNeuroState()

    //Get cookie for the position_id. If cookie exists, we add the deposit to it.
    const cookie = getCookie("neuroGuard " + position_id)
    //parse the cookie
    const cookiedDepositAmount = num(cookie ?? "0").toNumber()

    console.log('RENDERED EXISTING', neuroState.depositSelectedAsset);

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'existing_neuroGuard_msg_creation',
            address,
            neuroState.depositSelectedAsset,
            basket,
            position_id,
            run
        ],
        queryFn: () => {
            console.log("in query guardian", neuroState.depositSelectedAsset)


            if (!run || !address || !neuroState.depositSelectedAsset || (neuroState.depositSelectedAsset && neuroState.depositSelectedAsset?.sliderValue == 0) || !basket || !position_id || (position_id && position_id === "0")) { console.log("existing neuroGuard early return", address, neuroState, basket, position_id); return { msgs: [] } }
            var msgs = [] as MsgExecuteContractEncodeObject[]

            const newDeposit = num(neuroState.depositSelectedAsset.sliderValue).toNumber()
            const amount = shiftDigits(newDeposit, neuroState.depositSelectedAsset.decimal).toFixed(0)
            console.log("existingNeuro funds", newDeposit, amount, neuroState.depositSelectedAsset)
            const funds = [{ amount, denom: neuroState.depositSelectedAsset.base }]
            console.log(funds)

            //Deposit msg
            let depositMsg = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.cdp,
                    msg: toUtf8(JSON.stringify({
                        deposit: {
                            position_id
                        }
                    })),
                    funds: funds
                })
            } as MsgExecuteContractEncodeObject
            msgs.push(depositMsg)

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
    })

    console.log("neuroGuard msgs:", "enabled", !!address)
    const msgs = queryData?.msgs ?? []

    console.log("neuroGuard msgs:", msgs)

    const onInitialSuccess = () => {
        onSuccess()
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['home_page_existing_neuroGuard', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useExistingNeuroGuard