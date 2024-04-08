import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
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
  })
}

export default useEndProposal
