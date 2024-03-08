import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { getSigningGovernanceClient } from '@/services/governance'

type CastVoteParams = {
  proposalId: number
}

const useRemoveProposal = ({ proposalId }: CastVoteParams) => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address || !proposalId) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningGovernanceClient(signingClient, address)
      return client.removeCompletedProposal({
        proposalId,
      })
    },
  })
}

export default useRemoveProposal
