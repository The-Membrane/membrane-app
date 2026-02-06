import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import contracts from '@/config/contracts.json'
import { EarnMsgComposer } from '@/contracts/codegen/earn/Earn.message-composer'
import { useChainRoute } from '@/hooks/useChainRoute'
import { shiftDigits } from '@/helpers/math'

/**
 * Hook for fulfilling the USDC looping position intent through CDP contract
 * This executes the loopCDP function on the Earn contract
 */
const useFulfillIntent = (positionId?: string, maxMintAmount?: number) => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }

    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'manic_fulfill_intent_msg',
            address,
            positionId,
            maxMintAmount
        ],
        queryFn: () => {
            if (!address || !positionId || !maxMintAmount) {
                return { msgs: undefined }
            }

            const msgs = [] as MsgExecuteContractEncodeObject[]

            // Create message composer for Earn contract
            const messageComposer = new EarnMsgComposer(address, contracts.earn)

            // Convert max mint amount to proper decimals (6 decimals for CDT)
            const maxMintAmountWithDecimals = shiftDigits(maxMintAmount, 6).toFixed(0)

            // Create loopCDP message
            const loopMsg = messageComposer.loopCDP({
                max_mint_amount: maxMintAmountWithDecimals
            })

            msgs.push(loopMsg)

            return { msgs }
        },
        enabled: !!address && !!positionId && !!maxMintAmount,
    })

    const { msgs }: QueryData = useMemo(() => {
        if (!queryData) return { msgs: undefined }
        return queryData
    }, [queryData])

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
        queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['balances'] })
        queryClient.invalidateQueries({ queryKey: ['basket'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['manic_fulfill_intent_sim', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useFulfillIntent

