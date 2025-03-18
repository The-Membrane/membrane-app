import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { num } from '@/helpers/num'
import useNeuroState from "./useNeuroState"

import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'


const useCloseCDP = ({ position, debtAmount, onSuccess, run, debtCloseAmount }: { position: PositionResponse, debtAmount: number, onSuccess: () => void, run: boolean, debtCloseAmount: number }) => {
    const { address } = useWallet()
    // const { neuroState } = useNeuroState()

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'closeCDP_msg_creation',
            address,
            position.position_id,
            position.credit_amount,
            debtCloseAmount,
            run
        ],
        queryFn: () => {

            if (!run || !address || !position || (debtCloseAmount && position.credit_amount != "0" && debtCloseAmount == 0)) { console.log("closeCDP early return", run, address, position, debtCloseAmount, position.credit_amount != "0", position.credit_amount, !run, !address, !position, !debtCloseAmount, (debtCloseAmount && position.credit_amount != "0" && debtCloseAmount == 0)); return { msgs: [] } }
            var msgs = [] as MsgExecuteContractEncodeObject[]


            const percentToClose = num(debtCloseAmount).dividedBy(debtAmount).toFixed(4)
            console.log("percentToClose:", percentToClose, debtAmount, debtCloseAmount)

            //Close Position
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
                                max_spread: "0.05",
                                close_percentage: percentToClose,
                            }
                        })),
                        funds: []
                    })
                } as MsgExecuteContractEncodeObject
                msgs.push(closeMsg)
            } else {
                //Map position collateral to assets
                const collateralAssets = position.collateral_assets.map((asset) => {
                    return asset.asset
                })

                //Withdraw all collateral if position is undebted
                let withdrawMsg = {
                    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                    value: MsgExecuteContract.fromPartial({
                        sender: address,
                        contract: contracts.cdp,
                        msg: toUtf8(JSON.stringify({
                            withdraw: {
                                position_id: position.position_id,
                                assets: collateralAssets
                            }
                        })),
                        funds: []
                    })
                } as MsgExecuteContractEncodeObject
                msgs.push(withdrawMsg)
            }

            console.log("in query guardian msgs:", msgs)

            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    // console.log("closeCDP msgs:", msgs)

    const onInitialSuccess = () => {
        onSuccess()
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['home_page_closeCDP', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useCloseCDP