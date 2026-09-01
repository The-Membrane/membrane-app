import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { getContractAddress } from '@/config/evm/contracts'
import { getUserPoints, redeemCall, getRedemptionsPaused } from '@/services/chain/points'
import { getPublicClient } from '@/services/chain/client'
import type { EvmCall } from '@/services/chain/types'

const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['evm balances'] })
    //Reset points queries
    // queryClient.invalidateQueries({ queryKey: ['all users points'] })
    // queryClient.invalidateQueries({ queryKey: ['one users points'] })
    // queryClient.invalidateQueries({ queryKey: ['one users level'] })
}

/**
 * Points-claim CTA — EVM. Was Cosmos claimMBRN; the port's equivalent is
 * PointsSystem.redeem(token, points): burns the user's full points balance for MBRN
 * (contract pushes the reward, no approve needed). Skips when redemptions are paused
 * or the balance is zero.
 */
const useClaimPoints = () => {
    const { address, chain } = useWallet()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: ['claim_points', address, chain.id],
        queryFn: async () => {
            if (!address) return

            const pointsAddr = getContractAddress(chain.id, 'pointsSystem')
            const mbrnAddr = getContractAddress(chain.id, 'mbrn')
            if (!pointsAddr || !mbrnAddr) return

            const client = getPublicClient()
            const [points, paused] = await Promise.all([
                getUserPoints(client, address),
                getRedemptionsPaused(client),
            ])
            if (paused || !points || points <= 0n) return

            return [redeemCall(pointsAddr, mbrnAddr, points)]
        },
        enabled: !!address,
    })

    return {
        action:
            useSimulateAndBroadcast({
                msgs,
                queryKey: ['claim_points_msg_sim', (msgs?.toString() ?? "0")],
                onSuccess,
                enabled: !!msgs,
            })
    }
}

export default useClaimPoints
