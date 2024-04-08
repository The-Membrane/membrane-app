import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { getSigningGovernanceClient } from '@/services/governance'

type Props = {
  proposalId: number
}

const useEndProposal = ({ proposalId }: Props) => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address || !proposalId) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningGovernanceClient(signingClient, address)
      return client.endProposal({ proposalId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proposal'] })
      queryClient.invalidateQueries({ queryKey: ['user voting power'] })
      queryClient.invalidateQueries({ queryKey: ['proposals'] })
    },
  })
}

export default useEndProposal
