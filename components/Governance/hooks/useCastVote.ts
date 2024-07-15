import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { getSigningGovernanceClient } from '@/services/governance'

type CastVoteParams = {
  proposalId: number
  vote?: ProposalVoteOption | null
}

const useCastVote = ({ proposalId, vote }: CastVoteParams) => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address || !vote) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningGovernanceClient(signingClient, address)
      return client.castVote({
        proposalId,
        vote,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proposal'] })
      queryClient.invalidateQueries({ queryKey: ['user voting power'] })
      queryClient.invalidateQueries({ queryKey: ['proposals'] })
  
    },
  })
}

export default useCastVote
