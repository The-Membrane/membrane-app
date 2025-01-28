import { useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import useUserPositionState from '@/persisted-state/useUserPositionState'
import useRedemptionState from './useRedemptionState'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'

import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from 'cosmwasm'
import { useDepositTokenConversionforMarsUSDC } from '@/components/Earn/hooks/useEarnQueries'
//Run down
//This component will be a card that accepts Mars USDC into redemptions. Following the Modal flow.
//FAQ
//- External arbitragers will buy your USDC at a 1% premium & the CDT you earn will repay your debt. This gives you a 1% discount on your debt repayments without having to actively arbitrage.
// The thing is how do I explain the profitability to users? It's only profitable if they sold CDT above the redemption price. So we need a way to find out at what rate they sold their CDT.
// Its probably easy to guess whole numbers so we can give them options starting at $0.98. We'll abstract this on the display though, the deposit and withdraw modals will show greater detail.
// They can only choose one premium though so we can actually display that within the card.
// ___ USDC earning __% in wait for a 2% arbitrage opportunity.

const useMarsUSDCRedemptions = ({ onSuccess, run }: { onSuccess: () => void, run: boolean }) => {
    const { redemptionState, setRedemptionState } = useRedemptionState()
    const { mintState } = useMintState()
    const { reset } = useUserPositionState()
    const { address } = useWallet()
    const { data: basketPositions } = useUserPositions()

    const { data: expectedVaultTokens } = useDepositTokenConversionforMarsUSDC(shiftDigits(redemptionState?.deposit, 6).toString())

    //Use the current position id or use the basket's next position ID (for new positions)
    const positionId = useMemo(() => {
        return basketPositions?.[0]?.positions?.[mintState.positionNumber - 1]?.position_id || 0
    }, [basketPositions, mintState.positionNumber])

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'productized_redemptions',
            address,
            positionId,
            redemptionState.deposit,
            expectedVaultTokens,
            run
        ],
        queryFn: async () => {
            if (!address || positionId == 0 || redemptionState.deposit == 0 || !run) return { msgs: [] }
            var msgs = [] as MsgExecuteContractEncodeObject[]

            //Create deposit into marsUSDC vault msg
            const funds = [{ amount: shiftDigits(redemptionState?.deposit, 6).toString(), denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4" }]
            let withdrawMsg = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.marsUSDCvault,
                    msg: toUtf8(JSON.stringify({
                        enter_vault: {}
                    })),
                    funds: funds
                })
            } as MsgExecuteContractEncodeObject
            msgs.push(withdrawMsg)

            const messageComposer = new PositionsMsgComposer(address, contracts.cdp)
            //Create deposit msg
            const deposit_msg = messageComposer.deposit({
                positionId
            },
                [
                    {
                        denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized",
                        amount: (Number(expectedVaultTokens) - 1).toString() //Subtract 1 to account for rounding errors
                    }
                ]
            )
            msgs.push(deposit_msg)


            //Get the position we're working with
            const position = basketPositions?.[0]?.positions?.find((pos) => pos.position_id === positionId)
            //Set restricted collateral assets to any asset that isn't the mars USDC asset
            //@ts-ignore
            const restrictedCollateralAssets = position?.collateral_assets?.filter((asset) => asset.asset.info.native_token.denom !== "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized").map((asset) => asset.asset.info.native_token.denom as string) || [] as string[]

            //Create redemption msg
            const set_redemption_msg =
                messageComposer.editRedeemability({
                    positionIds: [positionId],
                    maxLoanRepayment: "1",
                    redeemable: true,
                    premium: redemptionState?.premium,
                    restrictedCollateralAssets
                })
            msgs.push(set_redemption_msg)

            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onFnSuccess = () => {
        onSuccess()
        setRedemptionState({ deposit: 0, premium: 0 })
        reset()
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    }
    console.log("redemption msgs:", msgs)
    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['marsUSDC_redemption_sim', (msgs?.toString() ?? "0")],
            onSuccess: onFnSuccess,
            enabled: !!msgs,
        })
    }
}

export default useMarsUSDCRedemptions
