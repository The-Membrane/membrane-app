import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import useUserPositionState from '@/persisted-state/useUserPositionState'
import useRedemptionState from './useRedemptionState'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'

import contracts from '@/config/contracts.json'
//Run down
//This component will be a card that accepts Mars USDC into redemptions. Following the Modal flow.
//FAQ
//- External arbitragers will buy your USDC at a 1% premium & the CDT you earn will repay your debt. This gives you a 1% discount on your debt repayments without having to actively arbitrage.
// The thing is how do I explain the profitability to users? It's only profitable if they sold CDT above the redemption price. So we need a way to find out at what rate they sold their CDT.
// Its probably easy to guess whole numbers so we can give them options starting at $0.98. We'll abstract this on the display though, the deposit and withdraw modals will show greater detail.
// They can only choose one premium though so we can actually display that within the card.
// ___ USDC earning __% in wait for a 2% arbitrage opportunity.

const useMarsUSDCRedemptions = () => {
    const { redemptionState, setRedemptionState } = useRedemptionState()
    const { mintState } = useMintState()
    const { reset } = useUserPositionState()
    const { address } = useWallet()
    const { data: basketPositions } = useUserPositions()
    const { data: basket } = useBasket()

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
            redemptionState.deposit
        ],
        queryFn: async () => {
            if (!address || positionId == 0 || redemptionState.deposit == 0) return { msgs: [] }
            var msgs = [] as MsgExecuteContractEncodeObject[]

            //Get the position we're working with
            const position = basketPositions?.[0]?.positions?.find((pos) => pos.position_id === positionId)
            //Set restricted collateral assets to any asset that isn't the mars USDC asset
            const restrictedCollateralAssets = position?.collateral_assets?.filter((asset) => asset.asset.info.native_token.denom !== "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized").map((asset) => asset.asset.info.native_token.denom as string) || [] as string[]

            const messageComposer = new PositionsMsgComposer(address, contracts.cdp)

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
            //Create deposit msg
            const deposit_msg = messageComposer.deposit({
                positionId
            },
                [
                    {
                        denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized",
                        amount: redemptionState?.deposit.toString(),
                    }
                ]
            )
            msgs.push(deposit_msg)

            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onSuccess = () => {
        reset()
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    }
    console.log("redemption msgs:", msgs)
    return useSimulateAndBroadcast({
        msgs,
        queryKey: ['marsUSDC_redemption_sim', (msgs?.toString() ?? "0")],
        onSuccess,
        enabled: !!msgs,
    })
}

export default useMarsUSDCRedemptions
