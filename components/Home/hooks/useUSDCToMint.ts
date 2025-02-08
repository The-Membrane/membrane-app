import { useBasket } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { swapToCDTMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { denoms } from '@/config/defaults'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'

const useUSDCToMint = ({ onSuccess, run }: { onSuccess: () => void, run: boolean }) => {
    const { quickActionState } = useQuickActionState()

    const { address } = useWallet()
    const { data: basket } = useBasket()

    const positionID = useMemo(() => {
        if (basket) {
            return basket.current_position_id
        }
        return undefined
    }, [basket])

    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'home_page_mint',
            address,
            positionID,
            quickActionState?.usdcMint,
            run
        ],
        queryFn: () => {
            if (!address || !basket || !positionID || quickActionState?.usdcMint.mint === 0 || quickActionState?.usdcMint.deposit === 0 || !run) return { msgs: [] }
            var msgs = [] as MsgExecuteContractEncodeObject[]

            const messageComposer = new PositionsMsgComposer(address, contracts.cdp)
            //1) Deposit USDC 
            const depositFunds = [{ amount: shiftDigits(quickActionState?.usdcMint.deposit, 6).dp(0).toNumber().toString(), denom: denoms.USDC[0] as string }]
            const depositMsg = messageComposer.deposit({ positionOwner: address }, depositFunds)
            msgs.push(depositMsg)

            //2) Mint CDT
            const mintMsg = messageComposer.increaseDebt({
                positionId: positionID,
                amount: shiftDigits(quickActionState?.usdcMint.mint, 6).dp(0).toString(),
            })
            msgs.push(mintMsg)

            return { msgs }

        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onInitialSuccess = () => {
        onSuccess()
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        queryClient.invalidateQueries({ queryKey: ['positions'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['home_page_mint_sim', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useUSDCToMint
