import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { PointsMsgComposer } from '@/contracts/codegen/points/Points.message-composer'
import { useChainRoute } from '@/hooks/useChainRoute'

const useClaimPoints = () => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)

    const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
        queryKey: [
            'claim_points',
            address,
        ],
        queryFn: () => {
            if (!address) return

            const messageComposer = new PointsMsgComposer(address, contracts.points)

            return [messageComposer.claimMBRN()] as MsgExecuteContractEncodeObject[]
        },
        enabled: !!address,
    })

    const onSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
        //Reset points queries
        // queryClient.invalidateQueries({ queryKey: ['all users points'] })
        // queryClient.invalidateQueries({ queryKey: ['one users points'] })
        // queryClient.invalidateQueries({ queryKey: ['one users level'] })
    }
    // console.log("mint msgs:", msgs)
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
