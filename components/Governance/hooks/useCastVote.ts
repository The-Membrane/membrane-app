import { GovernanceMsgComposer } from '@/contracts/codegen/governance/Governance.message-composer'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import { PointsMsgComposer } from '@/contracts/codegen/points/Points.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'

type CastVoteParams = {
  proposalId: number
  vote?: ProposalVoteOption | null
}

const useCastVote = ({ proposalId, vote }: CastVoteParams) => {
  const { address } = useWallet()
  
  
  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg vote on proposal', address, proposalId, vote],
    queryFn: () => {
      if (!address || !vote) return [] as MsgExecuteContractEncodeObject[]

        var msgs = [] as MsgExecuteContractEncodeObject[]
        const pointsMessageComposer = new PointsMsgComposer(address, contracts.points)
        const govMessageComposer = new GovernanceMsgComposer(address, contracts.governance)
        msgs.push(
          pointsMessageComposer.checkClaims({
            cdpRepayment: undefined,
            spClaims: false,
            lqClaims: false,
            vote: [proposalId],
          })
        )
        msgs.push(
          govMessageComposer.castVote({
            proposalId,
            vote,
          })
        )
        msgs.push(
          pointsMessageComposer.givePoints({
            cdpRepayment: false,
            spClaims: false,
            lqClaims: false,
            vote: [proposalId],
          })
        )
        return msgs
      },
      enabled: !!address,
  })

  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['proposal'] })
    queryClient.invalidateQueries({ queryKey: ['user voting power'] })
    queryClient.invalidateQueries({ queryKey: ['proposals'] })  
    //Reset points queries
    queryClient.invalidateQueries({ queryKey: ['all users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users level'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['vote proposal sim and execute', (msgs?.toString() ?? '0')],
    enabled: true,
    onSuccess,
  }), msgs }

}

export default useCastVote
