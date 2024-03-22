import useWallet from '@/hooks/useWallet'
import { getProposal } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'

const useProposalById = (proposalId: number) => {
  const { address } = useWallet()
  return useQuery({
    queryKey: ['proposal', proposalId, address],
    queryFn: async () => {
      return getProposal(proposalId, address)
    },
    enabled: !!proposalId,
  })
}

export default useProposalById
