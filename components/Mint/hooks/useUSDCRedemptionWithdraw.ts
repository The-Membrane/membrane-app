import { useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import useRedemptionState from './useRedemptionState'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'

import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
//Run down
//This component will be a card that accepts Mars USDC into redemptions. Following the Modal flow.
//FAQ
//- External arbitragers will buy your USDC at a 1% premium & the CDT you earn will repay your debt. This gives you a 1% discount on your debt repayments without having to actively arbitrage.
// The thing is how do I explain the profitability to users? It's only profitable if they sold CDT above the redemption price. So we need a way to find out at what rate they sold their CDT.
// Its probably easy to guess whole numbers so we can give them options starting at $0.98. We'll abstract this on the display though, the deposit and withdraw modals will show greater detail.
// They can only choose one premium though so we can actually display that within the card.
// ___ USDC earning __% in wait for a 2% arbitrage opportunity.

const useUSDCRedemptionWithdraw = ({ onSuccess, run, max }: { onSuccess: () => void, max: number, run: boolean }) => {
    const { redemptionState, setRedemptionState } = useRedemptionState()
    const { mintState } = useMintState()
    const { address } = useWallet()
    const { data: basketPositions } = useUserPositions()

    //Use the current position id or use the basket's next position ID (for new positions)
    const positionId = useMemo(() => {
        return basketPositions?.[0]?.positions?.[mintState.positionNumber - 1]?.position_id || 0
    }, [basketPositions, mintState.positionNumber])

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'productized_redemption_withdraw',
            address,
            positionId,
            redemptionState.withdraw,
            max,
            run
        ],
        queryFn: async () => {
            if (!address || positionId == 0 || redemptionState.withdraw == 0 || !run) return { msgs: [] }
            var msgs = [] as MsgExecuteContractEncodeObject[]

            const messageComposer = new PositionsMsgComposer(address, contracts.cdp)

            //Get the position we're working with
            const position = basketPositions?.[0]?.positions?.find((pos) => pos.position_id === positionId)
            //
            var withdraw_amount = shiftDigits(redemptionState.withdraw, 6).toString()
            //Get the withdraw amount
            if (redemptionState.withdraw === max && position) {
                //Find asset in basketPositions
                const assetFound = position?.collateral_assets.find((a: any) => a.asset.info.native_token.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")
                const amount = assetFound?.asset.amount

                console.log("full withdrawal amount for redemption", amount)
                if (amount) withdraw_amount = amount


                //If full withdrawal we remove redeemability msg
                const set_redemption_msg =
                    messageComposer.editRedeemability({
                        positionIds: [positionId],
                        maxLoanRepayment: "1",
                        redeemable: false,
                        premium: redemptionState?.premium,
                        restrictedCollateralAssets: []
                    })
                msgs.push(set_redemption_msg)
            }


            //Create withdraw msg
            const withdraw_msg = messageComposer.withdraw({
                positionId,
                assets: [
                    {
                        info: {
                            //@ts-ignore
                            native_token: {
                                denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
                            },
                        },
                        amount: withdraw_amount,
                    }
                ]
            })
            msgs.push(withdraw_msg)


            //VT Withdraw Msg
            // const fundsVT = [{ amount: withdraw_amount.toString(), denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized" }]
            // let withdrawMsg = {
            //     typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
            //     value: MsgExecuteContract.fromPartial({
            //         sender: address,
            //         contract: contracts.marsUSDCvault,
            //         msg: toUtf8(JSON.stringify({
            //             exit_vault: {}
            //         })),
            //         funds: fundsVT
            //     })
            // } as MsgExecuteContractEncodeObject
            // msgs.push(withdrawMsg)

            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onFnSuccess = () => {
        onSuccess()
        setRedemptionState({ deposit: 0, premium: 0 })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    }
    console.log("redemption msgs:", msgs)
    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['USDC_redemption_withdraw_sim', (msgs?.toString() ?? "0")],
            onSuccess: onFnSuccess,
            enabled: !!msgs,
        })
    }
}

export default useUSDCRedemptionWithdraw
