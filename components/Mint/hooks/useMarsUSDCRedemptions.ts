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

//Run down
//This component will be a card that accepts Mars USDC into redemptions. Following the Modal flow.
//FAQ
//- External arbitragers will buy your USDC at a 1% premium & the CDT you earn will repay your debt. This gives you a 1% discount on your debt repayments without having to actively arbitrage.
// The thing is how do I explain the profitability to users? It's only profitable if they sold CDT above the redemption price. So we need a way to find out at what rate they sold their CDT.
// Its probably easy to guess whole numbers so we can give them options starting at $0.98. We'll abstract this on the display though, the deposit and withdraw modals will show greater detail.
// They can only choose one premium though so we can actually display that within the card.
// ___ USDC earning __% in wait for a 2% arbitrage opportunity.

const useMarsUSDCRedemptions = () => {
    const { mintState, setMintState } = useMintState()
    const { reset } = useUserPositionState()
    const { summary = [] } = mintState
    const { address } = useWallet()
    const { data: basketPositions, ...basketErrors } = useUserPositions()
    const { data: basket } = useBasket()

    //Use the current position id or use the basket's next position ID (for new positions)
    const positionId = useMemo(() => {
        if (basketPositions !== undefined && (mintState.positionNumber < Math.min(basketPositions[0].positions.length + 1, MAX_CDP_POSITIONS) || (basketPositions[0].positions.length === MAX_CDP_POSITIONS))) {
            return basketPositions?.[0]?.positions?.[mintState.positionNumber - 1]?.position_id
        } else {
            //Use the next position ID
            return basket?.current_position_id ?? ""
        }
    }, [basketPositions, mintState.positionNumber, basket])

    const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
        queryKey: [
            'mint',
            address,
            positionId,
            summary ? JSON.stringify(summary.map(s => String(s.amount))) : '0',
            mintState?.mint,
            mintState?.repay,
        ],
        queryFn: () => {
            if (!address) return
            const depositAndWithdraw = getDepostAndWithdrawMsgs({ summary, address, basketPositions, positionId, hasPosition: basketPositions !== undefined && mintState.positionNumber <= basketPositions.length })
            const mintAndRepay = getMintAndRepayMsgs({
                address,
                positionId,
                mintAmount: mintState?.mint,
                repayAmount: mintState?.repay,
            })
            //if repaying and updating assets, repay first
            if (mintState.repay > 0) {
                return [...mintAndRepay, ...depositAndWithdraw] as MsgExecuteContractEncodeObject[]
            }
            return [...depositAndWithdraw, ...mintAndRepay] as MsgExecuteContractEncodeObject[]
        },
        enabled: !!address && !mintState.overdraft,
    })

    const onSuccess = () => {
        reset()
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        setMintState({ positionNumber: 1, mint: 0, repay: 0, summary: [] })
        //Reset points queries
        queryClient.invalidateQueries({ queryKey: ['all users points'] })
        queryClient.invalidateQueries({ queryKey: ['one users points'] })
        queryClient.invalidateQueries({ queryKey: ['one users level'] })
    }
    // console.log("mint msgs:", msgs)
    return useSimulateAndBroadcast({
        msgs,
        queryKey: ['mint_msg_sim', (msgs?.toString() ?? "0")],
        onSuccess,
        enabled: !!msgs,
    })
}

export default useMarsUSDCRedemptions
